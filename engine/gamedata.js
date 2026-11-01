// Wraps the generated companion data with indexes and small helpers. Isomorphic.
import { masteryStatus } from './mastery.js';
import { createXpTable } from './xp.js';

export const GP = 'GoldPieces';

const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
const localId = (id) => String(id ?? '').split(':').pop();

export function createGameData(raw) {
  const mechanics = raw.meta.mechanics;
  const xp = createXpTable(mechanics.xpTable);
  const methodsBySkill = {};
  for (const m of raw.methods) (methodsBySkill[m.skill] ??= []).push(m);
  for (const list of Object.values(methodsBySkill)) list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  const methodByKey = new Map(raw.methods.map((m) => [m.key, m]));
  const enemyById = new Map(raw.enemies.map((e) => [e.id, e]));
  const areaById = new Map(raw.areas.map((a) => [a.id, a]));
  const shopById = new Map(raw.shop.map((s) => [s.id, s]));
  const skillByName = new Map(raw.skills.flatMap((s) => [[s.id.toLowerCase(), s.id], [String(s.name).toLowerCase(), s.id]]));
  const itemValue = (id) => (raw.items[id]?.currency === GP ? raw.items[id].sell : 0);
  const foods = Object.entries(raw.items)
    .filter(([, it]) => it.heal > 0)
    .map(([item, it]) => ({ item, heal: it.heal, value: itemValue(item), gpPerHp: itemValue(item) / it.heal }))
    .sort((a, b) => a.gpPerHp - b.gpPerHp || b.heal - a.heal);

  const gd = {
    raw,
    meta: raw.meta,
    mechanics,
    levelCap: mechanics.levelCap,
    xp,
    skills: raw.skills,
    items: raw.items,
    methods: raw.methods,
    enemies: raw.enemies,
    areas: raw.areas,
    combat: raw.combat ?? null,
    shop: raw.shop,
    methodsBySkill,
    methodByKey,
    enemyById,
    areaById,
    shopById,
    trainableSkills: raw.skills.map((s) => s.id).filter((id) => methodsBySkill[id]?.length),

    foods,
    defaultFood: foods[0]?.item ?? null,
    // Food eaten to cover damage (thieving). The UI may set this to the player's choice.
    preferredFood: null,

    itemName: (id) => raw.items[id]?.name ?? humanize(localId(id)),
    itemValue,
    isKnownItem: (id) => id in raw.items,
    currencyName: (c) => raw.currencies[c]?.name ?? humanize(c),
    skillName: (id) => raw.skills.find((s) => s.id === id)?.name ?? id,
    skillIdFromName: (name) => skillByName.get(String(name ?? '').toLowerCase()) ?? null,

    levelOf: (levels, skill) => Math.max(1, Math.floor(levels?.[skill] ?? 1)),

    // What the loaded save shows the player has: { toolbelts: { skill: [{ item, qty }] }, owned: { item: qty } }.
    // The UI sets this; without it, tool requirements can't be confirmed.
    player: null,

    // Level requirements are checked, and with a save loaded everything it records: toolbelt items,
    // Mastery Guild ranks, kills, quests and quest steps, shop purchases, statistics (potions brewed,
    // items found, dungeons finished, Slayer tasks) and Agility technique levels. A tool you own but
    // haven't equipped goes in `equip` (doesn't block the method). Anything the save doesn't hold
    // (Astrology nodes) is reported as unknown.
    checkRequirements(method, levels) {
      const missing = [];
      const unknown = [];
      const equip = [];
      if (gd.levelOf(levels, method.skill) < method.level) missing.push({ type: 'level', skill: method.skill, level: method.level });
      for (const r of method.requires ?? []) {
        if (r.type === 'level') {
          if (gd.levelOf(levels, r.skill) < r.level) missing.push(r);
        } else if (r.type === 'locked') {
          missing.push(r);
        } else if (r.type === 'masteryRank' && gd.player?.masteryRanks) {
          if (!gd.player.masteryRanks[r.skill]?.includes(r.rank)) missing.push(r);
        } else if (r.type === 'kills' && gd.player?.enemiesKilled) {
          if ((gd.player.enemiesKilled[r.enemy] ?? 0) < r.count) missing.push(r);
        } else if (r.type === 'quest' && gd.player?.quests) {
          if (gd.player.quests[r.quest] !== 'claimed') missing.push(r);
        } else if (r.type === 'questStep' && gd.player?.questSteps) {
          if (gd.player.questSteps[r.quest]?.[r.step] !== 'complete') missing.push(r);
        } else if (r.type === 'purchase' && gd.player?.shopPurchases) {
          if (!(gd.player.shopPurchases[r.id] > 0)) missing.push(r);
        } else if (r.type === 'technique' && gd.player?.techniques) {
          if ((gd.player.techniques[r.technique] ?? 1) < r.level) missing.push(r);
        } else if (r.type === 'stat' && gd.player?.statistics?.[r.stat]) {
          // A statistic the save holds counts objects it has never recorded as 0.
          if ((gd.player.statistics[r.stat][r.id] ?? 0) < r.value) missing.push(r);
        } else if (r.type === 'astrologyNode' && gd.player?.astrologyNodes) {
          if (!gd.player.astrologyNodes.includes(r.node)) missing.push(r);
        } else if (r.type === 'tool' && gd.player) {
          const equipped = r.anyOf.some((t) => gd.player.toolbelts[t.skill]?.some((x) => x.item === t.item));
          if (equipped) continue;
          const owned = r.anyOf.filter((t) => (gd.player.owned[t.item] ?? 0) > 0);
          if (owned.length) equip.push({ ...r, owned });
          else missing.push(r);
        } else {
          unknown.push(r);
        }
      }
      return { ok: missing.length === 0, missing, unknown, equip };
    },

    // Toolbelt items a method uses up each cycle, given what's equipped: none when an alternative
    // that isn't used up (a chest key) is equipped, otherwise the one that is (a lockpick).
    usedTools(method) {
      const out = [];
      for (const r of method.requires ?? []) {
        if (r.type !== 'tool') continue;
        const equipped = gd.player ? r.anyOf.filter((t) => gd.player.toolbelts[t.skill]?.some((x) => x.item === t.item)) : [];
        if (equipped.some((t) => !t.usedPer)) continue;
        const used = equipped.find((t) => t.usedPer) ?? r.anyOf.find((t) => t.usedPer);
        if (used) out.push(used);
      }
      return out;
    },
  };
  return gd;
}

export function describeRequirement(gd, r) {
  if (r.type === 'level') return `${gd.skillName(r.skill)} ${r.level}`;
  if (r.type === 'tool') {
    const names = (list) => list.map((t) => gd.itemName(t.item)).join(' or ');
    const where = `${gd.skillName(r.anyOf[0].skill)} toolbelt`;
    return r.owned ? `Equip ${names(r.owned)} in your ${where}` : `${names(r.anyOf)} in your ${where}`;
  }
  return r.label ?? humanize(r.kind ?? r.type);
}

const saveLevels = (save) => Object.fromEntries(Object.entries(save?.skills ?? {}).map(([id, s]) => [id, s.level]));

// Skilling bonuses the save shows you have: shop upgrades you've bought, items in your toolbelts
// (tools, potions, utilities), pets you've found and Mastery Guild ranks. Each keeps a `source` for display.
export function playerBonuses(gd, save) {
  const effects = [];
  if (save?.mastery) {
    for (const m of Object.values(masteryStatus(gd, save, saveLevels(save)))) {
      for (const b of m.bonuses) for (const e of b.effects) effects.push({ ...e, source: `${b.rankName} (Mastery Guild)` });
    }
  }
  for (const [id, count] of Object.entries(save?.shopPurchases ?? {})) {
    const p = gd.shopById.get(id);
    for (const e of p?.provides.effects ?? []) effects.push({ ...e, value: e.value * Math.max(1, count), source: p.name });
  }
  for (const tools of Object.values(save?.toolbelts ?? {})) {
    for (const t of tools) for (const e of gd.items[t.item]?.tool?.effects ?? []) effects.push({ ...e, source: gd.itemName(t.item) });
  }
  for (const id of save?.pets ?? []) {
    const pet = gd.raw.pets?.find((x) => x.id === id);
    for (const e of pet?.effects ?? []) effects.push({ ...e, source: pet.name });
  }
  // Skilling set bonuses: pieces in your toolbelts or worn.
  const worn = new Set([...Object.values(save?.toolbelts ?? {}).flat().map((t) => t.item), ...Object.values(save?.combat?.equipped ?? {}).map((s) => s.item)]);
  for (const set of gd.combat?.sets ?? []) {
    const pieces = set.items.filter((i) => worn.has(i)).length;
    for (const b of set.bonuses) if (pieces >= b.count) for (const e of b.effects ?? []) effects.push({ ...e, source: `${set.name} set` });
  }
  // Thieving heist bonuses and distractions switch on by themselves once the save shows their
  // requirements met (an Agility level, a technique, a shop purchase).
  if (save?.skills) {
    const levels = saveLevels(save);
    for (const b of gd.raw.thievingBonuses ?? []) {
      let met = false;
      try {
        const r = gd.checkRequirements({ skill: null, level: 0, requires: b.requires }, levels);
        met = r.ok && !r.unknown.length && !r.equip.length;
      } catch {
        // no player state to check against
      }
      if (met) for (const e of b.effects) effects.push({ ...e, source: b.name });
    }
  }
  // Astrology: each unlocked node's bonuses, and each constellation's bonus per minor node unlocked.
  for (const [id, c] of Object.entries(save?.astrology ?? {})) {
    for (const node of [...c.minor, ...c.major]) {
      const n = gd.raw.astrology?.nodes?.[node];
      for (const e of n?.effects ?? []) effects.push({ ...e, source: `${n.name} (Astrology)` });
    }
    for (const e of gd.raw.astrology?.perMinorNode?.[id] ?? []) if (c.minor.length) effects.push({ ...e, value: e.value * c.minor.length, source: `${c.minor.length} minor nodes (Astrology)` });
  }
  // Each Hunting animal's journal levels add bonuses for that animal.
  for (const [animal, j] of Object.entries(save?.huntingJournal ?? {})) {
    for (const b of gd.raw.huntingJournalBonuses ?? []) {
      if (b.level > j.level) break;
      for (const e of b.effects) effects.push({ ...e, scope: { Recipe: animal }, source: `${gd.methodByKey.get(`Hunting/${animal}`)?.name ?? animal} journal level ${b.level}` });
    }
  }
  return effects;
}

// Combat bonuses on top of worn gear: chosen prayers, combat toolbelt items (potions, utilities), pets
// and Mastery Guild ranks.
export function playerCombatMods(gd, save) {
  const mods = [];
  if (save?.mastery) {
    for (const m of Object.values(masteryStatus(gd, save, saveLevels(save)))) {
      for (const b of m.bonuses) for (const x of b.mods ?? []) mods.push({ ...x, source: `${b.rankName} (Mastery Guild)` });
    }
  }
  for (const id of save?.prayers ?? []) {
    const prayer = gd.combat?.prayers?.find((x) => x.id === id);
    for (const m of prayer?.mods ?? []) mods.push({ ...m, source: prayer.name });
  }
  for (const t of save?.toolbelts?.Combat ?? []) for (const m of gd.items[t.item]?.tool?.mods ?? []) mods.push({ ...m, source: gd.itemName(t.item) });
  for (const id of save?.pets ?? []) {
    const pet = gd.raw.pets?.find((x) => x.id === id);
    for (const m of pet?.mods ?? []) mods.push({ ...m, source: pet.name });
  }
  return mods;
}

// What the engine needs to know about the player from a save (gd.player): toolbelts, everything
// owned, Agility technique levels, the prayers switched on, Mastery Guild ranks reached (with gd),
// each quest's state and its steps' states in order, shop purchases and statistics.
export function playerState(save, gd = null) {
  return {
    toolbelts: save?.toolbelts ?? {},
    owned: ownedItems(save),
    techniques: save?.agilityTechniques ? Object.fromEntries(Object.entries(save.agilityTechniques).map(([id, t]) => [id, t.level])) : null,
    // Each Hunting animal's journal level: bigger catches (more XP and products) and the journal bonuses.
    huntingJournal: save?.huntingJournal ? Object.fromEntries(Object.entries(save.huntingJournal).map(([id, j]) => [id, j.level])) : null,
    // The Astrology nodes you've unlocked, minor and major.
    astrologyNodes: save?.astrology ? Object.values(save.astrology).flatMap((c) => [...c.minor, ...c.major]) : null,
    prayers: save?.prayers ?? [],
    masteryRanks: gd && save?.mastery ? Object.fromEntries(Object.entries(masteryStatus(gd, save, saveLevels(save))).map(([skill, m]) => [skill, gd.raw.mastery[skill].ranks.filter((r) => m.points >= Math.ceil(m.total * r.percent)).map((r) => r.id)])) : null,
    quests: save?.quests ? Object.fromEntries(Object.entries(save.quests).map(([id, q]) => [id, q.state])) : null,
    questSteps: save?.quests ? Object.fromEntries(Object.entries(save.quests).map(([id, q]) => [id, Object.values(q.steps ?? {}).map((s) => s.state)])) : null,
    shopPurchases: save?.shopPurchases ?? null,
    statistics: save?.statistics ?? null,
    enemiesKilled: save?.enemiesKilled ?? null,
    // Enemies you're on a Slayer task for right now (on-task gear bonuses count against them).
    slayerTasks: Object.values(save?.slayer ?? {}).filter((t) => t?.task && t.progress < t.length).map((t) => t.task),
  };
}

// Whether you can buy a shop purchase now: { ok, missing, unknown, soldOut }. Requirements the save
// doesn't hold are unknown.
export function purchaseStatus(gd, p, levels, purchased = {}) {
  const soldOut = p.buyLimit > 0 && (purchased[p.id] ?? 0) >= p.buyLimit;
  const req = gd.checkRequirements({ skill: null, level: 0, requires: p.requires.filter((r) => r.type !== 'purchase') }, levels);
  const missing = [...req.missing, ...p.requires.filter((r) => r.type === 'purchase' && !(purchased[r.id] > 0))];
  return { ok: !soldOut && !missing.length && !req.unknown.length, soldOut, missing, unknown: req.unknown };
}

// Everything a save shows the player owns: bank, toolbelts and worn or stored combat gear.
export function ownedItems(save) {
  const owned = { ...(save?.bank?.items ?? {}) };
  const add = (item, qty) => item && (owned[item] = (owned[item] ?? 0) + Math.max(1, qty ?? 1));
  for (const tools of Object.values(save?.toolbelts ?? {})) for (const t of tools) add(t.item, t.qty);
  for (const set of [save?.combat?.equipped, ...Object.values(save?.combat?.storedLoadouts ?? {})]) for (const s of Object.values(set ?? {})) add(s.item, s.qty);
  return owned;
}
