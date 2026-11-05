// Wiki-style lookups: where items come from, what uses them, enemy loot and search. Isomorphic.
import { GP } from './gamedata.js';
import { expectTable } from './rates.js';

const avg = (min, max) => ((min ?? 0) + (max ?? min ?? 0)) / 2;

// Per-kill drop chances and expected value for an enemy.
export function enemyLoot(gd, enemy) {
  const drops = new Map();
  const add = (item, chance, qty) => {
    const d = drops.get(item) ?? { item, chance: 0, qty: 0 };
    d.chance = 1 - (1 - d.chance) * (1 - chance);
    d.qty += qty;
    drops.set(item, d);
  };
  for (const f of enemy.fixed) add(f.item, 1, avg(f.min, f.max));
  for (const t of enemy.tables) for (const x of expectTable(t.entries)) add(x.item, t.chance * x.chance, t.chance * x.qty);
  const items = [...drops.values()].map((d) => ({ ...d, value: d.qty * gd.itemValue(d.item) })).sort((a, b) => b.value - a.value);
  const gp = enemy.currencies.filter((c) => c.currency === GP).reduce((s, c) => s + avg(c.min, c.max), 0);
  const other = enemy.currencies.filter((c) => c.currency !== GP);
  return { gp, other, items, itemValue: items.reduce((s, x) => s + x.value, 0), totalValue: gp + items.reduce((s, x) => s + x.value, 0) };
}

export function rankEnemies(gd) {
  return gd.enemies
    .map((enemy) => ({ enemy, loot: enemyLoot(gd, enemy), areas: enemy.areas.map((id) => gd.areaById.get(id)).filter(Boolean) }))
    .sort((a, b) => b.loot.totalValue - a.loot.totalValue);
}

// The game's combat level (Enemy.CombatLevel): for each style the enemy attacks with, the floor of its
// levels times that style's ratios (melee: 0.325 Attack + 0.325 Strength + 0.25 Defence), highest wins.
// Without combat rules, the highest attack/defence-style level.
export function combatLevel(enemy, gd = null) {
  const styles = new Set((enemy.stances ?? []).map((s) => gd?.combat?.stances[s.stance]?.style).filter(Boolean));
  if (!styles.size) return Math.max(1, ...Object.entries(enemy.levels ?? {}).filter(([k]) => k !== 'Hitpoints').map(([, v]) => v));
  return Math.max(1, ...[...styles].map((style) => Math.floor((gd.combat.styles[style]?.combatLevel ?? []).reduce((s, r) => s + (enemy.levels?.[r.level] ?? 1) * r.ratio, 0))));
}
export const hitpointsLevel = (enemy) => enemy.levels?.Hitpoints ?? 1;

// Chance of at least one success in n tries, and tries needed for a target confidence.
export function dropChance(p, n) {
  return p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.pow(1 - p, n);
}
export function triesFor(p, confidence) {
  return p <= 0 ? Infinity : p >= 1 ? 1 : Math.ceil(Math.log(1 - confidence) / Math.log(1 - p));
}

// Per-attempt drop chances for thieving loot (before the success roll).
export function thievingDrops(method) {
  const out = [];
  const push = (list, gate, source) => {
    for (const x of expectTable(list)) out.push({ item: x.item, chance: gate * x.chance, source });
  };
  push(method.common, method.commonChance, 'common');
  push(method.rare, method.rareChance, 'rare');
  push(method.completion, 1 / method.stages, 'completion');
  return out;
}

/**
 * The chance that one action of a method gives an item, and what one action is: a hit, a log, a catch,
 * a steal attempt... From the method as given: pass computeRates().adjusted for your bonuses.
 * Several rolls for the same item in the same action are combined. 1 means every action gives it.
 * @param success the success chance: thieving loot and cooked food only come on a success
 * @param events chances of finds by item (computeRates().chancePerCycle), in place of their base ones
 * @returns {{ chance: number, per: string } | null} null when the method never gives the item
 */
export function methodChance(method, itemId, { success = 1, events = null } = {}) {
  const per = { woodcutting: 'log', mining: 'ore', fishing: 'catch', thieving: 'attempt', hunting: 'catch', agility: 'run',
    firemaking: 'burn', farming: 'harvest', ranching: 'hour', cooking: 'cook', astrology: 'action' }[method.kind] ?? 'craft';
  const gate = method.kind === 'thieving' || method.kind === 'cooking' ? success : 1;
  const rolls = [];
  const roll = (chance, unit = per) => chance > 0 && rolls.push({ chance: Math.min(1, chance), per: unit });
  if (method.product?.item === itemId) roll(1);
  if (method.kind === 'fishing') {
    for (const x of expectTable(method.products ?? [])) if (x.item === itemId) roll((method.fishChance ?? 1) * x.chance);
    if (method.junk === itemId) roll(1 - (method.fishChance ?? 1));
    // Specials are rolled rarest first and the first hit stops the roll (see rates.js).
    let none = 1;
    for (const x of [...(method.special ?? [])].sort((a, b) => a.chance - b.chance)) {
      if (x.item === itemId) roll(none * x.chance);
      none *= 1 - x.chance;
    }
  } else if (method.kind === 'thieving') {
    for (const x of thievingDrops(method)) if (x.item === itemId) roll(gate * x.chance);
  } else {
    for (const x of method.products ?? []) if (x.item === itemId) roll(gate * (x.chance ?? 1));
  }
  for (const x of method.perHit ?? []) if (x.item === itemId) roll(x.chance ?? 1, 'hit');
  for (const x of method.perCut ?? []) if (x.item === itemId) roll(x.chance ?? 1);
  const weights = (method.rareSpecies ?? []).reduce((s, sp) => s + sp.weight, 0);
  for (const sp of method.rareSpecies ?? []) for (const x of sp.extra) if (x.item === itemId && weights > 0) roll((method.rareChance ?? 0) * (sp.weight / weights) * (x.chance ?? 1));
  for (const ev of method.events ?? []) if (ev.item === itemId) roll(events?.[ev.item] ?? ev.chance ?? 1);
  if (!rolls.length) return null;
  // Combine the rolls that share a unit; a per-hit roll and a per-log roll can't be added, so keep the likelier.
  const byUnit = new Map();
  for (const r of rolls) byUnit.set(r.per, byUnit.has(r.per) ? 1 - (1 - byUnit.get(r.per)) * (1 - r.chance) : r.chance);
  const [unit, chance] = [...byUnit].sort((a, b) => b[1] - a[1])[0];
  return { chance, per: unit };
}

const indexCache = new WeakMap();

function buildIndex(gd) {
  const sources = new Map();
  const uses = new Map();
  const push = (map, item, entry) => (map.get(item) ?? map.set(item, []).get(item)).push(entry);
  for (const m of gd.methods) {
    const outputs = [
      ...(m.product ? [m.product.item] : []),
      ...(m.products ?? []).map((x) => x.item),
      ...(m.perHit ?? []).map((x) => x.item),
      ...(m.perCut ?? []).map((x) => x.item),
      ...(m.special ?? []).map((x) => x.item),
      ...(m.common ?? []).map((x) => x.item),
      ...(m.rare ?? []).map((x) => x.item),
      ...(m.completion ?? []).map((x) => x.item),
      ...(m.rareSpecies ?? []).flatMap((s) => s.extra.map((x) => x.item)),
      ...(m.events ?? []).map((x) => x.item),
    ];
    for (const item of new Set(outputs)) push(sources, item, { type: 'method', method: m, ...methodChance(m, item) });
    for (const i of m.ingredients ?? []) push(uses, i.item, { type: 'method', method: m, qty: i.qty });
  }
  // Upgrading in the bank: items (and gold) in, a better item out.
  for (const upgrade of gd.raw?.itemUpgrades ?? []) {
    push(sources, upgrade.item, { type: 'upgrade', upgrade });
    for (const i of upgrade.costs.items) push(uses, i.item, { type: 'upgrade', upgrade, qty: i.qty });
  }
  // The Grain Mill turns crops from its storage into flour, sugar and grain.
  for (const recipe of gd.raw?.grainMill?.recipes ?? []) {
    push(sources, recipe.product.item, { type: 'mill', recipe });
    for (const i of recipe.ingredients) push(uses, i.item, { type: 'mill', recipe, qty: i.qty });
  }
  for (const enemy of gd.enemies) {
    for (const d of enemyLoot(gd, enemy).items) push(sources, d.item, { type: 'enemy', enemy, chance: d.chance, qty: d.qty });
  }
  for (const s of gd.shop) {
    for (const i of s.provides.items) push(sources, i.item, { type: 'shop', purchase: s });
    for (const i of s.costs.items) push(uses, i.item, { type: 'shop', purchase: s, qty: i.qty });
  }
  return { sources, uses };
}

function getIndex(gd) {
  let idx = indexCache.get(gd);
  if (!idx) indexCache.set(gd, (idx = buildIndex(gd)));
  return idx;
}

const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const NEEDED_FOR = { ThievingRecipe: 'Needed to steal from', CombatArea: 'Needed to enter', Dungeon: 'Needed to enter', MagicSpell: 'Needed to cast',
  BankNavigationOption: 'Unlocks', CombatNavigationOption: 'Unlocks', SkillNavigationOption: 'Unlocks', LegacySkillNavigationOption: 'Unlocks' };

/**
 * Everything the game does with an item besides the recipes, upgrades, mill and shop costs the index
 * lists: what it is (gear, food, a toolbelt item, something to open) and every other place the game data
 * asks for it (gd.raw.itemUses: keys and tools, quests, the ranch, bait and traps, runes, entry costs).
 * @param covered names of things already listed (recipes), so they don't show twice
 * @returns [string] in plain words
 */
export function otherUses(gd, itemId, covered = new Set()) {
  const it = gd.items[itemId];
  const out = [];
  // What it is: the game's item capabilities, one tag each (equipment, tool, food, openable, trap, bait,
  // bury, compost).
  const tags = new Set(it?.tags ?? []);
  if (it?.equip) out.push(`Worn in the ${humanize(it.equip.type).toLowerCase()} slot`);
  if (it?.tool) out.push(`Goes in a toolbelt (${humanize(it.tool.slot)})${it.tool.usedUp ? ', used up as you go' : ''}`);
  if (it?.heal) out.push(`Food: heals ${it.heal} HP`);
  if (it?.opens || tags.has('openable')) out.push('Open it from your bank');
  if (it?.compost || tags.has('compost')) out.push('Compost for farming');
  if (it?.bait || tags.has('bait')) out.push('Bait for fishing');
  if (it?.prayerPoints || tags.has('bury')) out.push(`Bury it for ${it?.prayerPoints ? `${it.prayerPoints} ` : ''}prayer points`);
  if (tags.has('trap')) {
    const animals = gd.methods.filter((m) => m.kind === 'hunting' && (m.traps ?? []).some((t) => t.item === itemId)).map((m) => m.name);
    out.push(animals.length ? `A trap for hunting ${animals.slice(0, 3).join(', ')}${animals.length > 3 ? ` and ${animals.length - 3} more` : ''}` : 'A trap for hunting');
  }
  for (const u of gd.raw?.itemUses?.[itemId.split(':').pop()] ?? []) {
    if ((u.how === 'make' && covered.has(u.name)) || (u.how === 'cost' && (u.type === 'ItemUpgrade' || u.type === 'ShopPurchase'))) continue;
    const text = {
      make: `Used to make ${u.name}`,
      cost: u.type.startsWith('RanchingEnclosure') ? `Building ${u.name} on your ranch` : `Pays for ${u.name}`,
      needed: `${NEEDED_FOR[u.type] ?? 'Needed for'} ${u.name}`,
      quest: `Needed for the quest ${u.name}`,
      entry: `Entry cost for ${u.name}`,
      runes: `Runes for ${u.name}`,
      automate: `Pays to automate ${u.name}`,
      ranchFood: `Food on your ranch (${u.name})`,
      ranchTreat: `A treat on your ranch (${u.name})`,
      bait: `Preferred bait for hunting ${u.name}`,
      trap: `A trap for hunting ${u.name}`,
      mill: `Goes in the ${u.name}`,
      anvil: `Can be offered at the ${u.name}`,
    }[u.how] ?? `Used for ${u.name}`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

export function itemDetails(gd, itemId) {
  const { sources, uses } = getIndex(gd);
  return {
    item: itemId,
    name: gd.itemName(itemId),
    info: gd.items[itemId] ?? null,
    sources: sources.get(itemId) ?? [],
    uses: uses.get(itemId) ?? [],
  };
}

export function search(gd, query, limit = 40) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const score = (name) => {
    const n = String(name).toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[\s\-']/).some((w) => w.startsWith(q))) return 2;
    return n.includes(q) ? 3 : -1;
  };
  const results = [];
  const consider = (type, id, name, extra) => {
    const s = score(name);
    if (s >= 0) results.push({ type, id, name, score: s, ...extra });
  };
  for (const [id, it] of Object.entries(gd.items)) consider('item', id, it.name);
  for (const m of gd.methods) consider('method', m.key, m.name, { skill: m.skill, level: m.level });
  for (const e of gd.enemies) consider('enemy', e.id, e.name);
  for (const a of gd.areas) consider('area', a.id, a.name);
  for (const s of gd.shop) consider('shop', s.id, s.name);
  results.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return results.slice(0, limit);
}
