// Reads Melvor Idle 2 save files (save_<uuid>.sav). Read-only: nothing here ever writes a save.
//
// Format (from the game's SaveManager / SaveReader / Game.WriteTo):
//   Brotli( int32 version, SaveHeader, int32 entityCount, { string id, region }..., ...rest )
//   entity region    = int32 componentCount, { string key, region }...
//   region           = int32 byteLength + bytes
//   string           = .NET BinaryWriter string (7-bit encoded length + UTF-8)
// Every value pulled out is sanity-checked so a format change fails loudly instead of
// producing wrong advice.

import { readFileSync } from 'node:fs';
import { brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { defaultXpTable } from '../engine/xp.js';

// SaveVersion enum values used by the fields we read. LatestVerified is the newest version checked
// against a real save. The Steam playtest build 0.11.5 alpha.2 (13 Nov 2026) writes 29: no warnings,
// every region read to its last byte, every bank item known, and the levels worked out from XP add up
// to the header's total level. Its journal and technique formulas also give the levels 0.11.4 saves
// stored.
export const SaveVersion = { Alpha0_4_4: 1, Localization: 9, Alpha0_8_0: 13, Alpha0_8_3: 15, Alpha0_9_0: 16, Alpha0_11_0: 24, Alpha0_11_1: 25, Alpha0_11_1_1: 26, Alpha0_11_5: 29, LatestVerified: 29 };

export class SaveFormatError extends Error {}

// From 0.11.5 a save keeps only XP, not levels (BaseExperience.ReadFrom), so levels come from each
// experience table: skills use the standard one passed to parseSave(), Agility techniques and Hunting
// journal entries have their own (AgilityTechniqueExperienceTable, HuntingAnimalExperienceTable).
const levelFrom = (xpFor) => (xp) => {
  if (!(xp > 0)) return 1;
  let level = 1;
  while (level < 1000 && xpFor(level + 1) <= xp) level++;
  return level;
};
const TECHNIQUE_STEP = 2 ** (1260 / 4095);
export const techniqueLevel = levelFrom((L) => (L < 1 ? 0 : Math.floor((1 / 6) * (L ** 2 - L + 600 * ((2 ** (L / 3.25) - TECHNIQUE_STEP) / (TECHNIQUE_STEP - 1))))));
const JOURNAL_STEP = 2 ** (1 / 7);
export const journalLevel = levelFrom((L) => (L <= 1 ? 0 : Math.floor((1 / 12) * (L ** 2 - L + 100 * ((2 ** (L / 3.5) - JOURNAL_STEP) / (JOURNAL_STEP - 1))))));
// HuntingAnimalJournalEntry: every animal in the journal levels to 25.
const JOURNAL_LEVEL_CAP = 25;

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new SaveFormatError(`Unexpected end of data at byte ${this.pos}`);
  }
  i32() {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  bool() {
    this.need(1);
    return this.buf[this.pos++] !== 0;
  }
  bytes(n) {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  count(max, what) {
    const n = this.i32();
    if (n < 0 || n > max) throw new SaveFormatError(`Implausible ${what} count ${n}`);
    return n;
  }
  str() {
    let len = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 28) throw new SaveFormatError(`Bad string length at byte ${this.pos}`);
      this.need(1);
      const b = this.buf[this.pos++];
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    if (len < 0 || len > 1_000_000) throw new SaveFormatError(`Implausible string length ${len}`);
    return this.bytes(len).toString('utf8');
  }
  region() {
    const len = this.i32();
    if (len < 0) throw new SaveFormatError(`Negative region length at byte ${this.pos - 4}`);
    return new Reader(this.bytes(len));
  }
}

// System.Guid(byte[]) byte order: first three groups are little-endian.
function guidFromBytes(b) {
  const hex = (arr) => [...arr].map((x) => x.toString(16).padStart(2, '0')).join('');
  return [hex([...b.subarray(0, 4)].reverse()), hex([...b.subarray(4, 6)].reverse()), hex([...b.subarray(6, 8)].reverse()), hex(b.subarray(8, 10)), hex(b.subarray(10, 16))].join('-');
}

// System.DateTime.FromBinary. Local times are stored as UTC ticks with the Local flag.
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
function dateFromBinary(v) {
  const raw = BigInt.asUintN(64, v);
  const ticks = raw & 0x3fffffffffffffffn;
  const kind = raw & 0x8000000000000000n ? 'local' : raw & 0x4000000000000000n ? 'utc' : 'unspecified';
  return { ms: Number((ticks - TICKS_AT_UNIX_EPOCH) / 10000n), kind };
}

const localId = (id) => String(id).split(':').pop();

function readHeader(r, version) {
  const uuid = guidFromBytes(r.bytes(16));
  const characterName = r.str();
  const gamemode = r.str();
  const timestamp = dateFromBinary(r.i64());
  const header = { uuid, characterName, gamemode, timestamp: timestamp.ms, timestampKind: timestamp.kind };
  if (version < SaveVersion.Localization) {
    r.str();
  } else {
    header.activeEntityName = r.str();
    header.activeEntityIcon = r.str();
    header.activeActionName = r.str();
    header.activeActionIcon = r.str();
  }
  header.totalLevel = r.i32();
  header.gp = Number(r.i64());
  header.slayerCoins = Number(r.i64());
  header.isDemo = version >= SaveVersion.Alpha0_11_0 ? r.bool() : false;
  return header;
}

function readComponents(region) {
  const r = region;
  const components = new Map();
  const n = r.count(1000, 'component');
  for (let i = 0; i < n; i++) {
    const key = r.str();
    components.set(key, r.region());
  }
  return components;
}

// BaseExperience.WriteTo: double xp, [int32 legacy field before Alpha0_11_1], [int32 level before
// Alpha0_11_5]. From 0.11.5 there's no level: `level` is null and the caller works it out from the XP.
function readExperience(region, version) {
  const r = region;
  const expected = version < SaveVersion.Alpha0_11_1 ? 16 : version < SaveVersion.Alpha0_11_5 ? 12 : 8;
  if (r.buf.length !== expected) throw new SaveFormatError(`Experience block is ${r.buf.length} bytes, expected ${expected}`);
  const xp = r.f64();
  if (version < SaveVersion.Alpha0_11_1) r.i32();
  const level = version < SaveVersion.Alpha0_11_5 ? r.i32() : null;
  if (!Number.isFinite(xp) || xp < 0 || (level != null && (level < 1 || level > 1000))) throw new SaveFormatError(`Implausible experience values (xp ${xp}, level ${level})`);
  return { xp, level };
}

// BankInventoryComponent.WriteTo -> tabs of StackableInventory.WriteTo + label + tags.
// The game counts every stack against the bank's slots, empty placeholders included.
function readBank(region, version) {
  const r = region;
  const items = {};
  const empty = []; // empty stacks kept as placeholders: each still takes a slot
  const kept = []; // stacks that will stay as placeholders when they run out
  let stacks = 0;
  r.i32(); // default tab for new items
  const tabs = r.count(500, 'bank tab');
  for (let t = 0; t < tabs; t++) {
    r.i32(); // max stacks
    r.i32(); // min stack quantity
    r.i32(); // max stack quantity
    r.bool(); // allow stack combining
    r.bool(); // allow same-item stacks
    const n = r.count(200_000, 'item stack');
    for (let s = 0; s < n; s++) {
      const qty = r.i32();
      const placeholder = r.bool(); // IsPlaceholder: "keep this slot when it empties", so it is often set on full stacks
      if (version >= SaveVersion.Alpha0_4_4) r.bool(); // locked
      const id = r.str();
      if (!/^[A-Za-z0-9_]+:[A-Za-z0-9_]+$/.test(id) || qty < 0) throw new SaveFormatError(`Implausible bank stack "${id}" x${qty}`);
      stacks++;
      if (qty > 0) {
        items[id] = (items[id] ?? 0) + qty;
        if (placeholder) kept.push(id);
      } else {
        empty.push(id);
      }
    }
    r.str(); // tab label
    if (version >= SaveVersion.Alpha0_8_0) {
      const tags = r.count(10_000, 'bank tag');
      for (let i = 0; i < tags; i++) {
        r.bool();
        r.bool();
        r.str();
      }
    }
  }
  return { items, stacks, tabs, empty, kept };
}

const optionalId = (r) => (r.bool() ? r.str() : null);
const readMap = (r, max, what, value) => {
  const out = {};
  for (let i = 0, n = r.count(max, what); i < n; i++) {
    const key = r.str();
    out[key] = value(r);
  }
  return out;
};
function done(r, what) {
  if (r.pos !== r.buf.length) throw new SaveFormatError(`${what}: ${r.buf.length - r.pos} unread bytes`);
}

// EquipmentComponent / ToolbeltComponent: the active slots, then the slots stored for other loadouts.
// Equipment slot = int32 qty, bool occupied (spill-over from a two-handed weapon), bool has, [id].
// Toolbelt slot  = int32 qty, bool has, [id].
function readSlots(region, { equipment }) {
  const slot = (r) => {
    const g = r.region();
    const s = { qty: g.i32(), occupied: equipment ? g.bool() : false, item: optionalId(g) };
    done(g, 'Equipment slot');
    return s;
  };
  const keep = (slots) => Object.fromEntries(Object.entries(slots).filter(([, s]) => s.item && !s.occupied).map(([k, s]) => [localId(k), { item: s.item, qty: s.qty }]));
  const r = region;
  const active = keep(readMap(r, 100, 'slot', slot));
  const stored = readMap(r, 100, 'loadout', (x) => {
    const g = x.region();
    const m = keep(readMap(g, 100, 'slot', slot));
    done(g, 'Stored loadout');
    return m;
  });
  done(r, 'Equipment');
  return { active, stored: Object.fromEntries(Object.entries(stored).map(([k, v]) => [localId(k), v])) };
}

// PlayerComponent: skips health, ward, the turn timer and the in-progress turn, then reads the
// attack stance chosen for each weapon type and for each stored loadout.
function readStances(region, version) {
  const r = region;
  r.region();
  r.region();
  r.region();
  const turnKind = r.i32();
  r.bool();
  if (turnKind === 1) {
    r.str();
    r.bytes(1 + 4 + 4 + 4 + 16);
  } else if (turnKind === 2) {
    r.str();
    r.i32();
  } else if (turnKind !== 0) {
    throw new SaveFormatError(`Unknown combat turn kind ${turnKind}`);
  }
  r.i32();
  r.i64();
  if (version === 20) r.region();
  if (version >= 21) {
    for (let i = 0, n = r.count(100, 'stance'); i < n; i++) r.str();
    r.bool();
  }
  const byWeaponType = readMap(r, 1000, 'weapon type', (x) => localId(x.str()));
  const byLoadout = readMap(r, 100, 'loadout', (x) => localId(x.str()));
  done(r, 'Player');
  return { byWeaponType: Object.fromEntries(Object.entries(byWeaponType).map(([k, v]) => [localId(k), v])), byLoadout: Object.fromEntries(Object.entries(byLoadout).map(([k, v]) => [localId(k), v])) };
}

// SlayerTasksComponent: each master's current task (ActiveSlayerMaster.WriteTo) and blocked enemies.
function readSlayerTasks(region) {
  const r = region;
  const masters = {};
  for (let i = 0, n = r.count(100, 'slayer master'); i < n; i++) {
    const id = localId(r.str());
    const g = r.region();
    const task = optionalId(g);
    const master = { task: task && localId(task), length: g.i32(), progress: g.i32(), extended: g.bool(), auto: g.bool(), blocked: [] };
    for (let k = 0, m = g.count(100, 'block slot'); k < m; k++) {
      g.str();
      const slot = g.region();
      slot.bool();
      const enemy = optionalId(slot);
      if (enemy) master.blocked.push(localId(enemy));
    }
    done(g, 'Slayer master');
    masters[id] = master;
  }
  return masters;
}

// PetsComponent: each pet's state; the first field is whether you've found it.
function readPets(region) {
  const r = region;
  const found = [];
  for (let i = 0, n = r.count(1000, 'pet'); i < n; i++) {
    const id = localId(r.str());
    if (r.region().bool()) found.push(id);
  }
  return found;
}

// PrayerComponent (Combat): the prayer chosen for each prayer slot.
function readPrayers(region) {
  const r = region;
  const chosen = [];
  for (let i = 0, n = r.count(100, 'prayer slot'); i < n; i++) {
    r.str();
    const slot = r.region();
    const selected = optionalId(slot);
    if (selected) chosen.push(localId(selected));
  }
  return chosen;
}

// MasteryGuildComponent: the selected category, then each task's state (ActiveMasteryGuildTask):
// bool has goal, [goal id, region: double progress, bool complete, bool active], bool trigger met.
function readMasteryGuild(region) {
  const r = region;
  optionalId(r);
  const tasks = {};
  for (let i = 0, n = r.count(10_000, 'mastery task'); i < n; i++) {
    const id = localId(r.str());
    const t = r.region();
    const task = { goalComplete: null, triggerMet: false };
    if (t.bool()) {
      t.str();
      const goal = t.region();
      const progress = goal.f64();
      if (Number.isFinite(progress) && progress >= 0) task.goalProgress = progress;
      task.goalComplete = goal.bool();
    }
    task.triggerMet = t.bool();
    tasks[id] = task;
  }
  return tasks;
}

// QuestsComponent: each quest's state and, nested, each step's, task's and goal's progress:
//   i32 n, per quest: str id, region{ i32 state, i32 n, per step: str id, region{ i32 n, per task: str id,
//   region{ i32 n, per goal: str id, region{ f64 progress, bool complete, bool active }, bool visible,
//   bool costsMet, [bool conditionGoalsConfirmed from 0.11.5], i32 state }, bool visible, i32 state } }.
// From 0.11.5 the list is followed by the quest page's filters, its selected quest and custom NPCs,
// which aren't read.
const QUEST_STATES = ['unstarted', 'inProgress', 'completed', 'claimed'];
const STEP_STATES = ['inactive', 'active', 'complete'];
function readQuests(region, version) {
  const each = (r, what, read) => {
    const out = {};
    for (let i = 0, n = r.count(1000, what); i < n; i++) {
      const id = r.str();
      const g = r.region();
      out[localId(id)] = read(g);
      done(g, what);
    }
    return out;
  };
  const goal = (g) => ({ progress: g.f64(), complete: g.bool(), active: g.bool() });
  const task = (g) => {
    const out = { goals: each(g, 'quest goal', goal), visible: g.bool(), costsMet: g.bool() };
    if (version >= SaveVersion.Alpha0_11_5) g.bool(); // its condition goals confirmed
    out.state = STEP_STATES[g.i32()] ?? 'inactive';
    return out;
  };
  const step = (g) => ({ tasks: each(g, 'quest task', task), visible: g.bool(), state: STEP_STATES[g.i32()] ?? 'inactive' });
  const quest = (g) => ({ state: QUEST_STATES[g.i32()] ?? 'unstarted', steps: each(g, 'quest step', step) });
  return each(region, 'quest', quest);
}

// AgilityActionComponent.WriteTo: [bool, location], [bool, course, [bool, path running]], then each
// course's region (its paths, each in a region, then [bool, the path picked in its Select Path box]).
// Picking a path only changes the box: the course keeps running the path it was started on.
function readAgilityAction(region) {
  const r = region;
  const optional = () => (r.bool() ? localId(r.str()) : null);
  r.bool(); // the base action component's own byte
  optional(); // location
  let course = null;
  let running = null;
  if (r.bool()) {
    course = localId(r.str());
    running = optional();
  }
  const picked = {};
  for (let i = 0, n = r.count(1000, 'agility course'); i < n; i++) {
    const id = localId(r.str());
    const c = r.region();
    for (let p = 0, paths = c.count(100, 'agility path'); p < paths; p++) {
      c.str();
      c.region();
    }
    if (c.pos < c.buf.length && c.bool()) picked[id] = localId(c.str());
  }
  return { course, running, picked };
}

// AstrologyActionComponent.WriteTo: started, the action timer (flag + 3 ints), two display flags, then
// each constellation's id and, in a region, its knowledge and the minor and major nodes unlocked.
function readAstrologyAction(region) {
  const r = region;
  r.bool();
  r.bool();
  r.i32();
  r.i32();
  r.i32();
  r.bool();
  r.bool();
  const out = {};
  for (let i = 0, n = r.count(200, 'constellation'); i < n; i++) {
    const id = localId(r.str());
    const c = r.region();
    const knowledge = c.f64();
    const minor = [];
    for (let j = 0, m = c.count(1000, 'minor node'); j < m; j++) minor.push(localId(c.str()));
    const major = [];
    for (let j = 0, m = c.count(1000, 'major node'); j < m; j++) major.push(localId(c.str()));
    if (!Number.isFinite(knowledge) || knowledge < 0) throw new SaveFormatError(`Implausible knowledge for ${id}`);
    out[id] = { knowledge, minor, major };
  }
  // Then the constellation selected and the one being studied, then the bonus event Astrology turned up
  // (Blue Moon, Blood Moon, Aurora): whether it's been switched on and its charges left (ActiveBonusesEvent).
  let event = null;
  if (r.bool()) r.str();
  if (r.bool()) r.str();
  if (r.bool()) {
    const id = localId(r.str());
    const e = r.region();
    event = { event: id, activated: e.bool(), charges: e.i32() };
  }
  return { constellations: out, event };
}

// FiremakingBonfireComponent.WriteTo: its duration timer (max ticks, ticks left, paused), then the
// bonfire lit, then whether it's on.
function readBonfire(region) {
  const r = region;
  const maxTicks = r.i32();
  const ticksLeft = r.i32();
  const paused = r.bool();
  const bonfire = r.bool() ? localId(r.str()) : null;
  const active = r.bool();
  return { bonfire, active, paused, ticksLeft, maxTicks };
}

// RareEventsComponent.WriteTo: its timer (flag + 3 ints), then the bonus event in progress, if any:
// whether it's been switched on and its charges left.
function readRareEvent(region) {
  const r = region;
  r.bool();
  r.i32();
  r.i32();
  r.i32();
  if (!r.bool()) return null;
  const event = localId(r.str());
  const e = r.region();
  return { event, activated: e.bool(), charges: e.i32() };
}

// HuntingJournalComponent.WriteTo: each animal's id, then in a region whether it's discovered and its
// journal experience (BaseExperience, as for a skill), then its best catches.
function readHuntingJournal(region, version) {
  const r = region;
  const out = {};
  for (let i = 0, n = r.count(1000, 'journal animal'); i < n; i++) {
    const id = localId(r.str());
    const e = r.region();
    const discovered = e.bool();
    const xp = e.f64();
    if (version < SaveVersion.Alpha0_11_1) e.i32();
    const level = version < SaveVersion.Alpha0_11_5 ? e.i32() : Math.min(journalLevel(xp), JOURNAL_LEVEL_CAP);
    if (!Number.isFinite(xp) || xp < 0 || level < 1 || level > 1000) throw new SaveFormatError(`Implausible journal entry for ${id}`);
    // Every animal starts discovered; an undiscovered one tracks 4 times its most steps (ActiveHuntingAnimal).
    out[id] = discovered ? { level, xp } : { level, xp, discovered: false };
  }
  return out;
}

// HuntingActionComponent.WriteTo: the base action component's byte and the action timer (flag + 3 ints),
// then each animal's id and, in a region, its hunt (ActiveHuntingAnimal.WriteTo): tracks, step, steps
// needed, [bool, the trap selected], species rolled, [bool, the species], state, "Use Bait?", survey
// fails, bait used (0.8.3 on), then trap misses and "Enable Trapless Hunting" (0.9.0 on). Each animal's
// settings: { trap (full item id or null), useBait, trapless }.
function readHuntingAction(region, version) {
  const r = region;
  r.bool();
  r.bool();
  r.i32();
  r.i32();
  r.i32();
  const out = {};
  for (let i = 0, n = r.count(1000, 'hunting animal'); i < n; i++) {
    const id = localId(r.str());
    const a = r.region();
    a.i32();
    a.i32();
    a.i32();
    const trap = a.bool() ? a.str() : null;
    a.bool();
    if (a.bool()) a.str();
    const state = a.i32();
    const useBait = a.bool();
    a.i32();
    if (version >= SaveVersion.Alpha0_8_3) a.bool();
    let trapless = false;
    if (version >= SaveVersion.Alpha0_9_0) {
      a.i32();
      trapless = a.bool();
    }
    if (state < 0 || state > 10 || (trap && !/^[A-Za-z0-9_]+:[A-Za-z0-9_]+$/.test(trap))) throw new SaveFormatError(`Implausible hunt for ${id}`);
    out[id] = { trap, useBait, trapless };
  }
  return out;
}

// AgilityTechniquesComponent: each technique's id, then its experience block (as for a skill).
// From 0.11.5 the level comes from the XP, up to the technique's cap (`caps`: { id: cap } from the
// game data; without it, uncapped).
function readTechniques(region, version, caps = null) {
  const r = region;
  const out = {};
  for (let i = 0, n = r.count(100, 'technique'); i < n; i++) {
    const id = localId(r.str());
    const { xp, level } = readExperience(r.region(), version);
    out[id] = { xp, level: level ?? Math.min(techniqueLevel(xp), caps?.[id] ?? Infinity) };
  }
  return out;
}

// StatisticsComponent: simple statistics (a double each), then lists of DictionaryStatistics (int32
// count, then id + region each; the region is int32 count, then double value + id each). Every entity
// writes its item and currency lists; some add more after them (CombatStatistics.WriteTo: enemies,
// dungeons, combat styles, effects, prayers; Slayer: masters, enemies; Astrology: constellations,
// events; Agility: courses; Ranching, Hunting, Farming, Thieving likewise), so lists are read until the
// region ends. Keyed by statistic, then object: { CombatDungeonCompleted: { ChickenCoop: 2 } }.
function readStatistics(region) {
  const r = region;
  const out = {};
  for (let i = 0, n = r.count(10_000, 'statistic'); i < n; i++) {
    const id = localId(r.str());
    const s = r.region();
    if (s.buf.length === 8) out[id] = s.f64();
  }
  while (r.pos < r.buf.length) {
    for (let i = 0, n = r.count(10_000, 'statistic'); i < n; i++) {
      const id = localId(r.str());
      const s = r.region();
      const values = {};
      for (let k = 0, m = s.count(100_000, 'statistic entry'); k < m; k++) {
        const value = s.f64();
        values[localId(s.str())] = value;
      }
      done(s, id);
      out[id] = values;
    }
  }
  return out;
}

// A DictionaryStatistic (int32 count, then double value + id each) stored in a statistics component's
// region under its id, e.g. BankItemFound or CombatEnemyKilled. Found by id so the surrounding
// statistics layout (which differs per entity) doesn't matter.
function readDictionaryStatistic(components, statId) {
  const key = Buffer.from(statId, 'utf8');
  for (const region of components.values()) {
    const at = region.buf.indexOf(key);
    if (at < 1 || region.buf[at - 1] !== key.length) continue;
    const r = new Reader(region.buf.subarray(at + key.length));
    const stat = r.region();
    const values = {};
    for (let i = 0, n = stat.count(100_000, 'statistic entry'); i < n; i++) {
      const value = stat.f64();
      values[localId(stat.str())] = value;
    }
    done(stat, statId);
    return values;
  }
  return null;
}

// ShopComponent: display settings, then how many of each purchase you've bought.
function readShop(region) {
  const r = region;
  r.bool();
  r.bool();
  r.bool();
  r.i32();
  r.i32();
  const purchased = {};
  for (let i = 0, n = r.count(10_000, 'shop purchase'); i < n; i++) {
    const count = r.i32();
    purchased[localId(r.str())] = count;
  }
  return purchased;
}

// Game ticks: Constants.TickInterval = 1000 / Engine.PhysicsTicksPerSecond, which project.godot leaves at
// Godot's default of 60 (a 4-hour crop waits 864,000 ticks).
export const TICK_MS = 1000 / 60;
// SaveVersion values the farming and ranching layouts change at.
const PassiveVersion = { Alpha0_7_4: 11, Alpha0_7_5: 12, Alpha0_8_2: 14, Alpha0_9_5: 20, Alpha0_10_0: 21 };
const TIMER_STATES = ['stopped', 'paused', 'running'];

// TickTimer.WriteTo: bool auto-restart, int32 state, int32 wait ticks, int32 ticks left. Also the layout
// QueuedTimers had before Alpha0_10_0 (QueuedTimer.ReadFromTickTimer).
function readTickTimer(r) {
  r.bool();
  const state = TIMER_STATES[r.i32()];
  const waitTicks = r.i32();
  const ticksLeft = r.i32();
  if (!state || waitTicks < 0) throw new SaveFormatError(`Implausible timer (state ${state}, wait ${waitTicks})`);
  return { state, msLeft: state === 'stopped' ? null : Math.max(0, ticksLeft) * TICK_MS, waitMs: waitTicks * TICK_MS };
}

// QueuedTimer.WriteTo: bool auto-restart, int32 state, int32 wait ticks, int64 scheduled tick, int32 paused
// ticks left. A running timer's time left is its scheduled tick minus its queue's current tick.
function readQueuedTimer(r, version, queueTick) {
  if (version < PassiveVersion.Alpha0_10_0) return readTickTimer(r);
  r.bool();
  const state = TIMER_STATES[r.i32()];
  const waitTicks = r.i32();
  const scheduled = Number(r.i64());
  const paused = r.i32();
  if (!state || waitTicks < 0) throw new SaveFormatError(`Implausible timer (state ${state}, wait ${waitTicks})`);
  const ticksLeft = state === 'running' ? scheduled - queueTick : state === 'paused' ? paused : null;
  return { state, msLeft: ticksLeft == null ? null : Math.max(0, ticksLeft) * TICK_MS, waitMs: waitTicks * TICK_MS };
}

// TimerQueue.WriteTo: the int64 tick it has counted to (absent before Alpha0_10_0).
function readQueueTick(r, version) {
  if (version < PassiveVersion.Alpha0_10_0) return 0;
  const tick = Number(r.i64());
  if (tick < 0) throw new SaveFormatError(`Implausible timer queue tick ${tick}`);
  return tick;
}

// FarmingPassiveComponent.WriteTo: [bool, selected category], the plot timer queue, then each plot's id and
// region. ActiveFarmingPlot.WriteTo: bool watered, auto plant, auto harvest, auto compost, auto water,
// [bool, selected recipe], [bool, selected compost], [bool, compost in the soil], int32 state, then the
// state's own fields (PlotState.DataSerializer): growing and providing a bonus = recipe + timer, grown =
// recipe + int32 qty + item + int32 regrows left, regrowing = recipe + timer + int32 regrows left.
const PLOT_STATES = ['locked', 'empty', 'growing', 'grown', 'regrowing', 'bonus'];
function readFarmingPlots(region, version) {
  const r = region;
  const category = optionalId(r);
  const tick = readQueueTick(r, version);
  const plots = [];
  for (let i = 0, n = r.count(1000, 'farming plot'); i < n; i++) {
    const id = localId(r.str());
    const p = r.region();
    const plot = { id, watered: p.bool(), auto: { plant: p.bool(), harvest: p.bool(), compost: p.bool(), water: p.bool() } };
    const selected = optionalId(p);
    const selectedCompost = optionalId(p);
    const compost = optionalId(p);
    plot.selected = selected && localId(selected);
    plot.selectedCompost = selectedCompost && localId(selectedCompost);
    plot.compost = compost && localId(compost);
    plot.state = PLOT_STATES[p.i32()];
    if (!plot.state) throw new SaveFormatError(`Unknown state for farming plot ${id}`);
    if (plot.state !== 'locked' && plot.state !== 'empty') plot.recipe = localId(p.str());
    if (plot.state === 'growing' || plot.state === 'regrowing' || plot.state === 'bonus') plot.timer = readQueuedTimer(p, version, tick);
    if (plot.state === 'grown') {
      const qty = p.i32();
      plot.product = { item: p.str(), qty };
    }
    if (plot.state === 'grown' || plot.state === 'regrowing') plot.regrowsRemaining = p.i32();
    done(p, `Farming plot ${id}`);
    plots.push(plot);
  }
  done(r, 'Farming plots');
  return { category: category && localId(category), tick, plots };
}

// ActiveRanchingAnimal.WriteTo: bool sick, double hunger, safety, satisfaction, bool wants pets, int32 times
// petted, variant id, the treats it was given (bool + item each), then double minutes of life left, minutes
// until it grows up (the base variant) and minutes until it wants petting. Before Alpha0_8_2 the three
// were TickTimers before the variant; the game turns them into minutes the same way.
function readRanchingAnimal(r, version, species) {
  const a = { species, sick: r.bool(), hunger: r.f64(), safety: r.f64(), satisfaction: r.f64(), wantsPets: r.bool(), petCount: r.i32() };
  let old = null;
  if (version < PassiveVersion.Alpha0_8_2) {
    const minutes = (t) => Math.ceil(((t.msLeft ?? 0) / 60_000));
    const [life, pet, variant] = [readTickTimer(r), readTickTimer(r), readTickTimer(r)];
    old = { lifespanMinutes: minutes(life), petMinutes: minutes(pet), variantMinutes: minutes(variant) };
  }
  a.variant = localId(r.str());
  a.treats = {};
  for (let i = 0, n = r.count(100, 'animal treat'); i < n; i++) {
    const given = r.bool();
    a.treats[localId(r.str())] = given;
  }
  if (old) Object.assign(a, old);
  else Object.assign(a, { lifespanMinutes: r.f64(), variantMinutes: r.f64(), petMinutes: r.f64() });
  for (const k of ['hunger', 'safety', 'satisfaction', 'lifespanMinutes', 'variantMinutes', 'petMinutes']) {
    if (!Number.isFinite(a[k])) throw new SaveFormatError(`Implausible ${k} for a ${species}`);
  }
  // ActiveRanchingAnimal.ReadFrom clamps these.
  a.hunger = Math.max(0, a.hunger);
  a.safety = Math.max(0, a.safety);
  return a;
}

// ActiveRanchingEnclosure.WriteTo: breed timer, double maintenance, each animal's species and region, the
// species set to auto-buy, the once-a-minute timer that ages the animals, and the upgrades bought.
function readRanchingEnclosure(r, version, tick) {
  readQueuedTimer(r, version, tick);
  const e = { maintenance: r.f64(), animals: [], autoBuy: [], upgrades: [], minuteTimerMs: null };
  if (!Number.isFinite(e.maintenance)) throw new SaveFormatError('Implausible enclosure maintenance');
  for (let i = 0, n = r.count(10_000, 'ranching animal'); i < n; i++) {
    const species = localId(r.str());
    const g = r.region();
    e.animals.push(readRanchingAnimal(g, version, species));
    done(g, `Ranching animal ${species}`);
  }
  for (let i = 0, n = r.count(1000, 'auto-buy animal'); i < n; i++) e.autoBuy.push(localId(r.str()));
  if (version >= PassiveVersion.Alpha0_8_2) e.minuteTimerMs = readQueuedTimer(r, version, tick).msLeft;
  if (version >= PassiveVersion.Alpha0_9_5) for (let i = 0, n = r.count(1000, 'enclosure upgrade'); i < n; i++) e.upgrades.push(localId(r.str()));
  return e;
}

// RanchingPassiveComponent.WriteTo: the maintenance, food, product and treat timers (TickTimers), nine
// tutorial flags, the land timer queue, each land's id and region (ActiveRanchingLand: bool bought, [bool,
// enclosure id, enclosure region]), how many of each variant you've seen, treats switched off, land order.
function readRanching(region, version) {
  const r = region;
  const timers = { maintenance: readTickTimer(r), food: readTickTimer(r), product: readTickTimer(r), treat: readTickTimer(r) };
  for (let i = 0; i < 9; i++) r.bool();
  const tick = readQueueTick(r, version);
  const land = [];
  for (let i = 0, n = r.count(1000, 'ranching land'); i < n; i++) {
    const id = localId(r.str());
    const g = r.region();
    const l = { id, purchased: g.bool(), enclosure: null };
    if (g.bool()) {
      const enclosure = localId(g.str());
      const e = g.region();
      l.enclosure = { id: enclosure, ...readRanchingEnclosure(e, version, tick) };
      done(e, `Enclosure on ${id}`);
    }
    done(g, `Ranching land ${id}`);
    land.push(l);
  }
  const variantsSeen = {};
  for (let i = 0, n = r.count(10_000, 'animal variant'); i < n; i++) {
    const count = r.i32();
    variantsSeen[localId(r.str())] = count;
  }
  const blockedTreats = [];
  if (version >= PassiveVersion.Alpha0_7_4) for (let i = 0, n = r.count(1000, 'treat'); i < n; i++) blockedTreats.push(localId(r.str()));
  const landOrder = [];
  if (version >= PassiveVersion.Alpha0_7_5) for (let i = 0, n = r.count(1000, 'land order'); i < n; i++) landOrder.push(localId(r.str()));
  done(r, 'Ranching');
  return { timers: Object.fromEntries(Object.entries(timers).map(([k, t]) => [k, t.msLeft])), land, variantsSeen, blockedTreats, landOrder };
}

// The Farming entity's Grain Mill. FarmingGrainMillComponent.WriteTo: bool switched on, its batch timer
// (TickTimer), [bool, selected recipe], [bool, int32 qty, item ready to collect]. GrainMillInventory is the
// mill's storage, a StackableInventory: int32 max stacks, min and max stack quantity, bool stack combining,
// bool same-item stacks, then each stack's int32 qty, bool placeholder, [bool locked], item.
function readGrainMill(mill, inventory, version) {
  const r = mill;
  const active = r.bool();
  const timer = readTickTimer(r);
  const recipe = optionalId(r);
  let ready = null;
  if (r.bool()) {
    const qty = r.i32();
    ready = { item: r.str(), qty };
  }
  done(r, 'Grain Mill');
  const storage = {};
  if (inventory) {
    const s = inventory;
    s.i32();
    s.i32();
    s.i32();
    s.bool();
    s.bool();
    for (let i = 0, n = s.count(1000, 'grain mill stack'); i < n; i++) {
      const qty = s.i32();
      s.bool();
      if (version >= SaveVersion.Alpha0_4_4) s.bool();
      const id = s.str();
      if (qty < 0) throw new SaveFormatError(`Implausible grain mill stack "${id}" x${qty}`);
      storage[id] = (storage[id] ?? 0) + qty;
    }
    done(s, 'Grain Mill storage');
  }
  return { active, timer, recipe: recipe && localId(recipe), ready, storage };
}

// CurrencyWalletComponent.WriteTo (Bank entity): each currency's amount, then its id. Prayer points
// live here.
function readWallet(region) {
  const r = region;
  const out = {};
  const n = r.count(100, 'currency');
  for (let i = 0; i < n; i++) {
    const qty = Number(r.i64());
    out[localId(r.str())] = qty;
  }
  done(r, 'currencies');
  return out;
}

// Gear, stances, food, spell and loadouts from the Combat entity; skill toolbelts from every entity.
function readCombat(components, version) {
  const combat = {};
  const equipment = readSlots(components.get('Equipment'), { equipment: true });
  combat.equipped = equipment.active;
  combat.storedLoadouts = equipment.stored;
  if (components.has('Loadouts')) {
    const r = components.get('Loadouts');
    combat.currentLoadout = localId(r.str());
    combat.loadoutNames = Object.fromEntries(Object.entries(readMap(r, 100, 'loadout', (x) => {
      const g = x.region();
      const name = g.str();
      g.bool();
      return name;
    })).map(([k, v]) => [localId(k), v]));
  }
  if (components.has('Player')) combat.stances = readStances(components.get('Player'), version);
  if (components.has('Food')) combat.food = optionalId(components.get('Food'));
  // MagicSpellsComponent.WriteTo: the selected spell, then the selected imbuement.
  if (components.has('MagicSpells')) {
    const r = components.get('MagicSpells');
    combat.spell = optionalId(r);
    combat.imbuement = optionalId(r);
  }
  return combat;
}

/**
 * Parses a save buffer (the raw .sav file contents).
 * @param {Buffer} fileBuffer
 * @param {{ levelCap?: number, xpTable?: ReturnType<import('../engine/xp.js').createXpTable>, techniqueCaps?: Record<string, number>, headerOnly?: boolean }} [options]
 *   techniqueCaps: each Agility technique's level cap ({ Climbing: 40 }), for saves that keep only XP
 */
export function parseSave(fileBuffer, { levelCap = 60, xpTable = defaultXpTable, techniqueCaps = null, headerOnly = false } = {}) {
  // The game's saves end without Brotli's end-of-stream marker (its .NET reader just reads until
  // the data runs out), so decode in flush mode instead of requiring a finished stream.
  let data;
  try {
    data = brotliDecompressSync(fileBuffer, { finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH });
  } catch {
    data = null;
  }
  if (!data?.length) throw new SaveFormatError('Not a Melvor Idle 2 save (could not decompress)');
  const r = new Reader(data);
  const version = r.i32();
  if (version < 0 || version > 1000) throw new SaveFormatError(`Unknown save version ${version}`);
  const header = readHeader(r, version);
  const result = { version, newerThanSupported: version > SaveVersion.LatestVerified, header, skills: {}, bank: null, warnings: [] };
  if (headerOnly) return result;

  const entities = new Map();
  const n = r.count(10_000, 'entity');
  for (let i = 0; i < n; i++) {
    const id = r.str();
    entities.set(localId(id), r.region());
  }

  for (const [id, region] of entities) {
    let components;
    try {
      components = readComponents(region);
    } catch {
      continue; // entity with a custom layout; nothing we need lives there
    }
    const exp = components.get('Experience');
    if (exp) {
      try {
        const { xp, level: saved } = readExperience(exp, version);
        // The cap differs between game builds, so accept the level the XP gives with or without it. From
        // 0.11.5 there's no saved level: it's the XP's, up to the cap.
        const uncapped = xpTable.levelForXp(xp);
        const level = saved ?? Math.min(uncapped, levelCap);
        const verified = level === uncapped || level === Math.min(uncapped, levelCap);
        result.skills[id] = { xp, level, verified };
        if (!verified) result.warnings.push(`${id}: saved level ${level} does not match ${Math.round(xp)} XP (expected ${uncapped})`);
      } catch (e) {
        result.warnings.push(`${id}: ${e.message}`);
      }
    }
    if (components.has('Toolbelt')) {
      try {
        const tools = Object.entries(readSlots(components.get('Toolbelt'), { equipment: false }).active).map(([slot, t]) => ({ ...t, slot }));
        if (tools.length) (result.toolbelts ??= {})[id] = tools;
      } catch (e) {
        result.warnings.push(`${id} toolbelt: ${e.message}`);
      }
    }
    // Every entity with a food slot has its own selected food (FoodComponent.WriteTo starts with it);
    // read from a fresh copy so the Combat reader below still starts at the beginning.
    if (components.has('Food')) {
      try {
        const food = optionalId(new Reader(components.get('Food').buf));
        if (food) (result.foods ??= {})[id] = food;
      } catch (e) {
        result.warnings.push(`${id} food: ${e.message}`);
      }
    }
    if (components.has('Pets')) {
      try {
        result.pets = [...(result.pets ?? []), ...readPets(components.get('Pets'))];
      } catch (e) {
        result.warnings.push(`${id} pets: ${e.message}`);
      }
    }
    if (id === 'Combat' && components.has('Prayer')) {
      try {
        result.prayers = readPrayers(components.get('Prayer'));
      } catch (e) {
        result.warnings.push(`Prayers: ${e.message}`);
      }
    }
    if (id === 'Quests' && components.has('Quests')) {
      try {
        result.quests = readQuests(components.get('Quests'), version);
      } catch (e) {
        result.warnings.push(`Quests: ${e.message}`);
      }
    }
    if (id === 'Agility' && components.has('Techniques')) {
      try {
        result.agilityTechniques = readTechniques(components.get('Techniques'), version, techniqueCaps);
      } catch (e) {
        result.warnings.push(`Agility techniques: ${e.message}`);
      }
    }
    if (id === 'Astrology' && components.has('Action')) {
      try {
        const astrology = readAstrologyAction(components.get('Action'));
        result.astrology = astrology.constellations;
        if (astrology.event) result.astrologyEvent = astrology.event;
      } catch (e) {
        result.warnings.push(`Astrology nodes: ${e.message}`);
      }
    }
    // FishingBaitComponent.WriteTo: the bait selected, if any.
    if (id === 'Fishing' && components.has('BaitComponent')) {
      try {
        result.fishingBait = optionalId(components.get('BaitComponent'));
      } catch (e) {
        result.warnings.push(`Fishing bait: ${e.message}`);
      }
    }
    if (id === 'Firemaking' && components.has('Bonfire')) {
      try {
        result.bonfire = readBonfire(components.get('Bonfire'));
      } catch (e) {
        result.warnings.push(`Bonfire: ${e.message}`);
      }
    }
    if (components.has('RareEvents')) {
      try {
        const aurora = readRareEvent(components.get('RareEvents'));
        if (aurora) (result.auroras ??= {})[id] = aurora;
      } catch (e) {
        result.warnings.push(`${id} rare events: ${e.message}`);
      }
    }
    if (id === 'Hunting' && components.has('Journal')) {
      try {
        result.huntingJournal = readHuntingJournal(components.get('Journal'), version);
      } catch (e) {
        result.warnings.push(`Hunting journal: ${e.message}`);
      }
    }
    // Each animal's own settings: the trap selected, "Use Bait?" and "Enable Trapless Hunting".
    if (id === 'Hunting' && components.has('Action')) {
      try {
        result.huntingAnimals = readHuntingAction(components.get('Action'), version);
      } catch (e) {
        result.warnings.push(`Hunting animals: ${e.message}`);
      }
    }
    // The header names the course ("Climb 3"); which of its paths is running is only in here.
    if (id === 'Agility' && components.has('Action')) {
      try {
        const agility = readAgilityAction(components.get('Action'));
        if (agility.running) {
          result.header.activePath = agility.running;
          result.header.pickedPath = agility.picked[agility.course] ?? null;
        }
      } catch (e) {
        result.warnings.push(`Agility course: ${e.message}`);
      }
    }
    if (components.has('MasteryGuild')) {
      try {
        (result.mastery ??= {})[id] = readMasteryGuild(components.get('MasteryGuild'));
      } catch (e) {
        result.warnings.push(`${id} mastery: ${e.message}`);
      }
    }
    if (components.has('Statistics')) {
      try {
        Object.assign((result.statistics ??= {}), readStatistics(components.get('Statistics')));
      } catch {
        // an entity with its own statistics layout; nothing the companion needs from it
      }
    }
    if (id === 'Bank' || id === 'Combat') {
      const statId = id === 'Bank' ? 'MelvorBase:BankItemFound' : 'MelvorBase:CombatEnemyKilled';
      try {
        const values = readDictionaryStatistic(components, statId);
        if (values) result[id === 'Bank' ? 'itemsFound' : 'enemiesKilled'] = values;
      } catch (e) {
        result.warnings.push(`${id} statistics: ${e.message}`);
      }
    }
    if (id === 'Shop' && components.has('Shop')) {
      try {
        result.shopPurchases = readShop(components.get('Shop'));
      } catch (e) {
        result.warnings.push(`Shop purchases: ${e.message}`);
      }
    }
    if (id === 'Farming' && components.has('Passive')) {
      try {
        result.farming = readFarmingPlots(components.get('Passive'), version);
      } catch (e) {
        result.warnings.push(`Farming plots: ${e.message}`);
      }
    }
    if (id === 'Farming' && components.has('GrainMill')) {
      try {
        result.grainMill = readGrainMill(components.get('GrainMill'), components.get('GrainMillInventory') ?? null, version);
      } catch (e) {
        result.warnings.push(`Grain Mill: ${e.message}`);
      }
    }
    if (id === 'Ranching' && components.has('Passive')) {
      try {
        result.ranching = readRanching(components.get('Passive'), version);
      } catch (e) {
        result.warnings.push(`Ranching: ${e.message}`);
      }
    }
    if (id === 'Slayer' && components.has('Tasks')) {
      try {
        result.slayer = readSlayerTasks(components.get('Tasks'));
      } catch (e) {
        result.warnings.push(`Slayer tasks: ${e.message}`);
      }
    }
    if (id === 'Combat' && components.has('Equipment')) {
      try {
        result.combat = readCombat(components, version);
      } catch (e) {
        result.warnings.push(`Combat gear: ${e.message}`);
      }
    }
    if (id === 'Bank' && components.has('Wallet')) {
      try {
        result.wallet = readWallet(components.get('Wallet'));
      } catch (e) {
        result.warnings.push(`Wallet: ${e.message}`);
      }
    }
    if (id === 'Bank' && components.has('Inventory')) {
      try {
        result.bank = readBank(components.get('Inventory'), version);
      } catch (e) {
        result.bank = { error: e.message };
        result.warnings.push(`Bank: ${e.message}`);
      }
    }
  }
  if (!Object.keys(result.skills).length) result.warnings.push('No skill data found in this save.');
  return result;
}

export function readSaveFile(path, options) {
  return parseSave(readFileSync(path), options);
}
