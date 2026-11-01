// Rare items: everything you only get by chance, how rare it is and where it comes from, with the
// quickest way you can get one now. An item's rarity is the best chance any source gives per action,
// kill or opening; anything a source gives at least 1 time in 20 (or a shop sells) isn't rare.
// Isomorphic.
import { enemyLoot, itemDetails, triesFor } from './lookup.js';
import { computeRates, expectTable } from './rates.js';

// Rarest first. `from` is the best chance per try that still counts as this band.
export const RARITY = [
  { id: 'legendary', name: 'Legendary', from: 0, label: '1 in 10,000 or rarer' },
  { id: 'veryRare', name: 'Very rare', from: 1 / 10000, label: '1 in 1,000 to 10,000' },
  { id: 'rare', name: 'Rare', from: 1 / 1000, label: '1 in 100 to 1,000' },
  { id: 'uncommon', name: 'Uncommon', from: 1 / 100, label: '1 in 20 to 100' },
];
const COMMON = 1 / 20;
const rarityOf = (p) => [...RARITY].reverse().find((b) => p >= b.from) ?? RARITY[0];

const cache = new WeakMap();

// Every chance-based source of every item, at each source's own unlock level and with no bonuses:
// item -> [{ type: 'method'|'enemy'|'open', method|enemy|from, p }]. Items anything gives reliably are
// left out.
function chanceIndex(gd) {
  if (cache.has(gd)) return cache.get(gd);
  const sources = new Map();
  const common = new Set();
  const add = (item, entry) => {
    if (entry.p >= COMMON) common.add(item);
    else if (entry.p > 0) (sources.get(item) ?? sources.set(item, []).get(item)).push(entry);
  };
  for (const m of gd.methods) {
    let r;
    try {
      r = computeRates(gd, m, m.level, { bonuses: [] });
    } catch {
      continue;
    }
    for (const o of r.outputs) add(o.item, { type: 'method', method: m, p: Math.min(1, o.perHour / r.cyclesPerHour) });
  }
  for (const enemy of gd.enemies) for (const d of enemyLoot(gd, enemy).items) add(d.item, { type: 'enemy', enemy, p: d.chance });
  for (const [id, it] of Object.entries(gd.items)) {
    if (!it.opens) continue;
    for (const a of it.opens.always) add(a.item, { type: 'open', from: id, p: 1 });
    for (const x of expectTable(it.opens.table)) add(x.item, { type: 'open', from: id, p: x.chance });
  }
  for (const s of gd.shop) for (const i of s.provides.items) common.add(i.item);
  for (const id of common) sources.delete(id);
  cache.set(gd, sources);
  return sources;
}

/**
 * @param bestFights Map enemyId -> your best fight against it (bestFightsByEnemy); null skips enemies
 * @param owned { item: qty } everything you own (chests you could open)
 * @param found { localItemId: count } from the save's item statistics, or null
 * @returns rows, rarest first: { item, p, rarity, found, have, sources: [{ ..., now, hours, kills,
 *   chanceFromOwned, needs }], best } — best: the quickest source you can use now, if any
 */
export function rareItems(gd, { levels, bestFights = null, owned = {}, found = null }) {
  const rows = [];
  const ratesNow = new Map();
  const rateOf = (m) => {
    if (!ratesNow.has(m.key)) ratesNow.set(m.key, computeRates(gd, m, gd.levelOf(levels, m.skill)));
    return ratesNow.get(m.key);
  };
  // How fast you can get a chest you don't have: the best of its sources you can use now, per hour.
  const chestRates = new Map();
  const chestRate = (id) => {
    if (chestRates.has(id)) return chestRates.get(id);
    let best = null;
    for (const src of itemDetails(gd, id).sources) {
      let perHour = 0;
      if (src.type === 'method') {
        const req = gd.checkRequirements(src.method, levels);
        if (req.ok && !req.unknown.length) perHour = rateOf(src.method).outputs.find((o) => o.item === id)?.perHour ?? 0;
      } else if (src.type === 'enemy') {
        const fight = bestFights?.get(src.enemy.id);
        if (fight && !fight.result.risky) perHour = src.chance * (fight.result.killsPerHour ?? 0);
      }
      if (perHour > 0 && (!best || perHour > best.perHour)) best = { perHour, source: src };
    }
    chestRates.set(id, best);
    return best;
  };
  for (const [item, list] of chanceIndex(gd)) {
    if (!gd.items[item]) continue;
    const p = Math.max(...list.map((s) => s.p));
    const sources = list.map((s) => {
      if (s.type === 'method') {
        const req = gd.checkRequirements(s.method, levels);
        const levelsShort = req.missing.filter((r) => r.type === 'level');
        if (!req.ok || req.unknown.length) {
          return { ...s, now: false, needs: req.missing.length === levelsShort.length && !req.unknown.length ? levelsShort : null };
        }
        const perHour = rateOf(s.method).outputs.find((o) => o.item === item)?.perHour ?? 0;
        return { ...s, now: perHour > 0, hours: perHour > 0 ? Math.LN2 / perHour : Infinity, equip: req.equip };
      }
      if (s.type === 'enemy') {
        const fight = bestFights?.get(s.enemy.id);
        if (!fight || fight.result.risky || !(fight.result.killsPerHour > 0)) return { ...s, now: false, needs: null, fightable: !!fight };
        const kills = triesFor(s.p, 0.5);
        return { ...s, now: true, kills, hours: kills / fight.result.killsPerHour, style: fight.style ?? null };
      }
      const have = owned[s.from] ?? 0;
      if (have > 0) return { ...s, now: true, have, hours: 0, chanceFromOwned: 1 - Math.pow(1 - s.p, have) };
      // A chest you'd have to get first: the time to get enough of them for an even chance.
      const chest = chestRate(s.from);
      return chest ? { ...s, now: true, have: 0, chest: chest.source, hours: triesFor(s.p, 0.5) / chest.perHour } : { ...s, now: false, have: 0, needs: null };
    });
    sources.sort((a, b) => (b.now - a.now) || (a.hours ?? Infinity) - (b.hours ?? Infinity) || b.p - a.p);
    const best = sources.find((s) => s.now) ?? null;
    rows.push({ item, p, rarity: rarityOf(p), found: found ? (found[item.split(':').pop()] ?? 0) > 0 : null, have: owned[item] ?? 0, sources, best });
  }
  return rows.sort((a, b) => a.p - b.p);
}

// How close an item you can't get yet is: the fewest levels any source needs (Infinity if none is
// just levels away).
export function levelsAway(gd, row, levels) {
  let fewest = Infinity;
  for (const s of row.sources) {
    if (!s.needs?.length) continue;
    fewest = Math.min(fewest, s.needs.reduce((sum, r) => sum + Math.max(0, r.level - gd.levelOf(levels, r.skill)), 0));
  }
  return fewest;
}
