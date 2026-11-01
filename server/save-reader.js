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
// against a real save (the Steam playtest build of 30 Oct 2026 writes 28: every region read to its
// last byte, every skill's level matching its XP and every bank item known).
export const SaveVersion = { Alpha0_4_4: 1, Localization: 9, Alpha0_8_0: 13, Alpha0_11_0: 24, Alpha0_11_1: 25, Alpha0_11_1_1: 26, LatestVerified: 28 };

export class SaveFormatError extends Error {}

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

// BaseExperience.WriteTo: double xp, [int32 legacy field before Alpha0_11_1], int32 level.
function readExperience(region, version) {
  const r = region;
  const expected = version < SaveVersion.Alpha0_11_1 ? 16 : 12;
  if (r.buf.length !== expected) throw new SaveFormatError(`Experience block is ${r.buf.length} bytes, expected ${expected}`);
  const xp = r.f64();
  if (version < SaveVersion.Alpha0_11_1) r.i32();
  const level = r.i32();
  if (!Number.isFinite(xp) || xp < 0 || level < 1 || level > 1000) throw new SaveFormatError(`Implausible experience values (xp ${xp}, level ${level})`);
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
//   bool costsMet, i32 state }, bool visible, i32 state } }
const QUEST_STATES = ['unstarted', 'inProgress', 'completed', 'claimed'];
const STEP_STATES = ['inactive', 'active', 'complete'];
function readQuests(region) {
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
  const task = (g) => ({ goals: each(g, 'quest goal', goal), visible: g.bool(), costsMet: g.bool(), state: STEP_STATES[g.i32()] ?? 'inactive' });
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
  return out;
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
    const level = e.i32();
    if (!Number.isFinite(xp) || xp < 0 || level < 1 || level > 1000) throw new SaveFormatError(`Implausible journal entry for ${id}`);
    if (discovered) out[id] = { level, xp };
  }
  return out;
}

// AgilityTechniquesComponent: each technique's id, then its experience block (as for a skill).
function readTechniques(region, version) {
  const r = region;
  const out = {};
  for (let i = 0, n = r.count(100, 'technique'); i < n; i++) {
    const id = localId(r.str());
    const { xp, level } = readExperience(r.region(), version);
    out[id] = { xp, level };
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
  if (components.has('MagicSpells')) combat.spell = optionalId(components.get('MagicSpells'));
  return combat;
}

/**
 * Parses a save buffer (the raw .sav file contents).
 * @param {Buffer} fileBuffer
 * @param {{ levelCap?: number, xpTable?: ReturnType<import('../engine/xp.js').createXpTable>, headerOnly?: boolean }} [options]
 */
export function parseSave(fileBuffer, { levelCap = 60, xpTable = defaultXpTable, headerOnly = false } = {}) {
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
        const { xp, level } = readExperience(exp, version);
        // The cap differs between game builds, so accept the level the XP gives with or without it.
        const uncapped = xpTable.levelForXp(xp);
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
        result.quests = readQuests(components.get('Quests'));
      } catch (e) {
        result.warnings.push(`Quests: ${e.message}`);
      }
    }
    if (id === 'Agility' && components.has('Techniques')) {
      try {
        result.agilityTechniques = readTechniques(components.get('Techniques'), version);
      } catch (e) {
        result.warnings.push(`Agility techniques: ${e.message}`);
      }
    }
    if (id === 'Astrology' && components.has('Action')) {
      try {
        result.astrology = readAstrologyAction(components.get('Action'));
      } catch (e) {
        result.warnings.push(`Astrology nodes: ${e.message}`);
      }
    }
    if (id === 'Hunting' && components.has('Journal')) {
      try {
        result.huntingJournal = readHuntingJournal(components.get('Journal'), version);
      } catch (e) {
        result.warnings.push(`Hunting journal: ${e.message}`);
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
