// Gear you don't own yet that beats what you have for a fight, and how to get it: make it (with
// materials from your bank, else gathered or made first), buy it, get it as a drop from something
// you can already fight, or upgrade something in the bank (with `itemUpgrades`: you hold the gold, and
// the materials or a way to gather them). Items that need more levels (to make, upgrade or wear) come
// back as "soon", with the time to those levels. Isomorphic.
import { hoursToLevel, obtain } from './advisor.js';
import { buildEnemy, scoreGear, weaponStyles, xpOf } from './combat.js';
import { GP, purchaseStatus } from './gamedata.js';
import { upgradeNeeds } from './item-upgrades.js';
import { itemDetails, triesFor } from './lookup.js';
import { computeRates } from './rates.js';

const MIN_GAIN = 0.01; // ignore anything under 1% more XP...
const MIN_DAMAGE_CUT = 0.1; // ...unless it cuts the damage you take (and so the food you eat) by 10%
// A smaller gain is still worth it when it takes a few minutes to get: 0.2% more XP or 2% less damage
// from something you can make or buy in under 10 minutes (Studded Leather Chaps from 3 Iron Bars).
const QUICK_HOURS = 10 / 60;
const MIN_QUICK_GAIN = 0.002;
const MIN_QUICK_CUT = 0.02;
// The fight's numbers before and after, to say why it's better.
const fightNumbers = (r) => ({ killSeconds: r.killSeconds, hitChance: r.hitChance, maxHit: r.maxHit, enemyHitChance: r.enemyHitChance, foodPerHour: r.foodPerHour ?? 0, damageTakenPerKill: r.damageTakenPerKill ?? 0 });
const MAX_LEVELS_AWAY = 15; // "soon" means within this many levels in every skill it needs

const missingLevels = (gd, requires, levels) => (requires ?? []).filter((r) => r.type === 'level' && gd.levelOf(levels, r.skill) < r.level);

/**
 * @param rec recommendStyle() result: the gear to improve on and the fights it can do
 * @param xp { skill: current XP } for timing levels; combatXp { skill: best XP/h fighting }
 * @param itemUpgrades also count upgrades in the bank (source type 'upgrade': { upgrade, times, hours,
 *   gather }); off until the page shows them
 * @returns { ready: rows you can get now, soon: rows a few levels away }; each row: { item, slot, replaces,
 *   gain, gainShare, source: { type: 'make'|'buy'|'drop'|'upgrade', hours, ... }, needs: [{ skill, level, hours }], levelHours }
 */
export function gearUpgrades(gd, { rec, owned, levels, bank = {}, food = null, skill = null, index, purchased = {}, wallet = null, xp = {}, combatXp = null, itemUpgrades = false }) {
  const g = rec?.gear;
  if (!g?.enemy) return { ready: [], soon: [] };
  const style = rec.style;
  const enemy = buildEnemy(gd, g.enemy);
  const base = xpOf(g.result, skill);
  if (!(base > 0)) return { ready: [], soon: [] };
  const stock = new Map(Object.entries(bank));
  const slotOpen = (slot) => (slot.requires ?? []).every((r) => r.type === 'level' && gd.levelOf(levels, r.skill) >= r.level);
  const twoHanded = (id) => gd.items[id]?.equip?.alsoOccupies?.includes('Offhand');
  const levelHours = new Map();
  const timeTo = (s, level) => {
    const key = `${s}|${level}`;
    if (!levelHours.has(key)) levelHours.set(key, hoursToLevel(gd, s, levels, xp[s] ?? 0, level, { bank, index, combatXp }));
    return levelHours.get(key);
  };
  const fightsByEnemy = new Map(rec.fights.filter((f) => !f.result.risky && f.result.killsPerHour > 0).map((f) => [f.enemy.id, f]));

  const rows = [];
  for (const [id, item] of Object.entries(gd.items)) {
    const eq = item.equip;
    if (!eq || (owned.get(id) ?? 0) > 0) continue;
    if (eq.type === 'Weapon' && !weaponStyles(gd, id).includes(style)) continue;
    // Too far off to be worth listing.
    const wear = missingLevels(gd, eq.requires, levels);
    if (wear.some((r) => r.level - gd.levelOf(levels, r.skill) > MAX_LEVELS_AWAY)) continue;

    // Its best slot, swapped into the recommended gear (ammo: the best you'd have, with it added).
    let best = null;
    for (const slot of gd.combat.slots.filter((s) => s.fits === eq.type && slotOpen(s))) {
      const trial = { ...g.slots, [slot.id]: id };
      delete trial.Ammo;
      if (twoHanded(id)) delete trial.Offhand;
      if (eq.type === 'Offhand' && twoHanded(trial.Weapon)) continue;
      const r = scoreGear(gd, { style, gear: Object.values(trial), owned: new Map([...owned, [id, 1e6]]), levels, bank, enemy, area: g.area, food, skill });
      if (!r || r.result.risky) continue;
      const gain = xpOf(r.result, skill) - base;
      const damageCut = g.result.hpLossPerHour > 0 ? 1 - r.result.hpLossPerHour / g.result.hpLossPerHour : 0;
      // Less damage only counts when it costs (almost) no XP; slower-but-safer is a trade, not an upgrade.
      const worth = Math.max(gain / base / MIN_GAIN, gain >= -base * 0.005 ? damageCut / MIN_DAMAGE_CUT : 0);
      const small = gain / base >= MIN_QUICK_GAIN || (gain >= -base * 0.005 && damageCut >= MIN_QUICK_CUT);
      if (!best || worth > best.worth) best = { slot: slot.id, gain, damageCut, worth, small, result: r.result };
    }
    if (!best || (best.worth < 1 && !best.small)) continue;

    // How to get it. Ammo is timed for an hour's worth.
    const qty = eq.type === 'Ammo' ? Math.max(1, Math.ceil(best.result.ammoPerHour ?? 1)) : 1;
    const sources = [];
    const needs = [...wear];
    for (const source of itemDetails(gd, id).sources) {
      if (source.type === 'method') {
        const m = source.method;
        const req = gd.checkRequirements(m, levels);
        if (req.unknown.length || req.missing.some((r) => r.type !== 'level')) continue;
        const short = req.missing.filter((r) => r.type === 'level');
        if (short.length) {
          sources.push({ type: 'make', method: m, needs: short });
          continue;
        }
        sources.push({ type: 'make', method: m });
      } else if (source.type === 'shop') {
        const p = source.purchase;
        if (!purchaseStatus(gd, p, levels, purchased).ok || p.costs.items.length || p.costs.currencies.some((c) => c.currency !== GP)) continue;
        const each = p.costs.currencies.reduce((s, c) => s + c.qty, 0) / (p.provides.items.find((i) => i.item === id)?.qty ?? 1);
        sources.push({ type: 'buy', purchase: p, gp: each * qty, hours: 0, afford: !wallet || (wallet[GP] ?? 0) >= each * qty });
      } else if (source.type === 'enemy') {
        const f = fightsByEnemy.get(source.enemy.id);
        if (!f) continue;
        const kills = triesFor(source.chance, 0.5);
        sources.push({ type: 'drop', enemy: source.enemy, chance: source.chance, kills, hours: kills / f.result.killsPerHour });
      } else if (source.type === 'upgrade' && itemUpgrades) {
        // Ammo upgrades make a stack at a time (250 arrows), so only as many as an hour's worth needs.
        const u = source.upgrade;
        const req = gd.checkRequirements({ skill: null, level: 0, requires: u.requires }, levels);
        if (req.unknown.length || req.missing.some((r) => r.type !== 'level')) continue;
        const short = req.missing.filter((r) => r.type === 'level');
        sources.push({ type: 'upgrade', upgrade: u, times: Math.ceil(qty / u.qty), ...(short.length ? { needs: short } : {}) });
      }
    }
    rows.push({ item: id, slot: best.slot, replaces: g.slots[best.slot] ?? null, gain: best.gain, gainShare: best.gain / base, damageCut: best.damageCut, worth: best.worth, qty, sources, wear,
      why: { enemy: g.enemy.name, before: fightNumbers(g.result), after: fightNumbers(best.result) } });
  }
  return finish(gd, rows, { levels, stock, index, timeTo, wallet });
}

// Times each source and splits the rows into "get it now" and "a few levels away".
function finish(gd, rows, { levels, stock, index, timeTo, wallet }) {
  const ready = [];
  const soon = [];
  for (const row of rows) {
    let now = null;
    let later = null;
    for (const s of row.sources) {
      if (s.type === 'make' && !s.needs) {
        const t = makeTime(gd, s.method, row.item, row.qty, levels, stock, index);
        if (t && (!now || t.hours < now.hours)) now = { ...s, ...t };
      } else if (s.type === 'upgrade' && !s.needs) {
        // Gold can't be gathered here, so it has to be in the wallet already.
        const t = upgradeNeeds(gd, s.upgrade, { levels, stock, wallet, index, times: s.times });
        if (!t.cantGather.length && t.currency.every((c) => !c.short) && (!now || t.hours < now.hours)) now = { ...s, hours: t.hours, gather: t.gather, currency: t.currency };
      } else if (s.type === 'make' || s.type === 'upgrade') {
        const levelsAway = s.needs.reduce((sum, r) => sum + r.level - gd.levelOf(levels, r.skill), 0);
        if (s.needs.every((r) => r.level - gd.levelOf(levels, r.skill) <= MAX_LEVELS_AWAY) && (!later || levelsAway < later.levelsAway)) later = { ...s, levelsAway };
      } else if ((s.type === 'buy' && s.afford) || s.type === 'drop') {
        if (!now || s.hours < now.hours) now = s;
      }
    }
    // Levels still needed: to wear it, and to make it when that's the only way.
    const needs = [...row.wear, ...(now ? [] : later?.needs ?? [])];
    const bySkill = new Map();
    for (const r of needs) if ((bySkill.get(r.skill) ?? 0) < r.level) bySkill.set(r.skill, r.level);
    const need = [...bySkill].map(([skill, level]) => ({ skill, level, hours: timeTo(skill, level) }));
    const levelHours = need.reduce((s, r) => s + r.hours, 0);
    const source = now ?? later;
    if (!source) continue;
    // A small gain only when it's quick to get now.
    if (row.worth < 1 && !(now && !need.length && now.hours <= QUICK_HOURS)) continue;
    const out = { ...row, source, needs: need, levelHours };
    if (!need.length && now) ready.push(out);
    else if (Number.isFinite(levelHours)) soon.push(out);
  }
  // Most gain for the time it takes (anything under 5 minutes counts as 5), so quick wins come first.
  ready.sort((a, b) => b.worth / ((b.source.hours ?? 0) + 1 / 12) - a.worth / ((a.source.hours ?? 0) + 1 / 12));
  soon.sort((a, b) => a.levelHours - b.levelHours || b.worth - a.worth);
  return { ready, soon };
}

// Time to make qty of an item: the crafting, plus gathering or making any materials you're short of.
function makeTime(gd, method, item, qty, levels, stock, index) {
  const rates = computeRates(gd, method, gd.levelOf(levels, method.skill));
  const perHour = rates.outputs.find((o) => o.item === item)?.perHour ?? 0;
  if (!(perHour > 0)) return null;
  const work = qty / perHour;
  const gather = rates.inputs.map((i) => obtain(index, stock, i.item, i.perHour * work));
  if (gather.some((x) => !Number.isFinite(x.hours))) return null;
  return { hours: work + gather.reduce((s, x) => s + x.hours, 0), gather: gather.filter((x) => x.short > 0).map((x) => ({ ...x, qty: x.short })) };
}
