// Where to get an item, for you: each source's chance per action and how many an hour it gives at your
// levels, with your bonuses and success chance, best first. Isomorphic.
import { idleDanger } from './idle-danger.js';
import { itemDetails, methodChance } from './lookup.js';
import { computeRates } from './rates.js';

/**
 * Every source of an item, in the order worth trying:
 *   0. sure ways: the shop, an upgrade in the bank, the Grain Mill;
 *   1. what you can do now and leave running, most an hour first;
 *   2. what you can do now but can kill you while it runs (idleDanger, or a risky fight), most an hour first;
 *   3. the rest (not unlocked, or fights the companion can't rate), likeliest per action first.
 * Chances per action come from your own rates: a pickpocket's loot only on a success, with your loot bonuses.
 * @param fights { [style]: { fights: rankFights() rows } } to rate enemies, or null
 * @returns itemDetails() sources, each with { chance, per, perHour (null when you can't do it now), doable,
 *   risky, missing (requirements not met), rates (a method's) }
 */
export function itemSources(gd, itemId, levels, { fights = null } = {}) {
  // The most kills an hour you can get against each enemy, a fight you can leave running first.
  const kills = new Map();
  for (const rec of Object.values(fights ?? {})) {
    for (const f of rec.fights ?? []) {
      const perHour = f.result?.killsPerHour;
      if (!(perHour > 0)) continue;
      const risky = !!f.result.risky;
      const had = kills.get(f.enemy.id);
      if (!had || (had.risky && !risky) || (had.risky === risky && perHour > had.perHour)) kills.set(f.enemy.id, { perHour, risky });
    }
  }
  const out = itemDetails(gd, itemId).sources.map((s) => {
    if (s.type === 'method') {
      const m = s.method;
      const req = gd.checkRequirements(m, levels);
      const r = computeRates(gd, m, Math.max(gd.levelOf(levels, m.skill), m.level));
      const odds = methodChance(r.adjusted ?? m, itemId, { success: r.successChance ?? 1, events: r.chancePerCycle }) ?? { chance: s.chance, per: s.per };
      const doable = req.ok;
      return {
        ...s,
        ...odds,
        perHour: doable ? r.outputs.find((o) => o.item === itemId)?.perHour ?? 0 : null,
        doable,
        risky: doable && !!idleDanger(gd, r)?.risky,
        missing: req.missing,
        rates: r,
      };
    }
    if (s.type === 'enemy') {
      const k = kills.get(s.enemy.id);
      return { ...s, per: 'kill', perHour: k ? k.perHour * (s.qty ?? s.chance) : null, doable: !!k, risky: !!k?.risky };
    }
    return { ...s, sure: true };
  });
  const group = (s) => (s.sure ? 0 : s.doable && !s.risky ? 1 : s.doable ? 2 : 3);
  const score = (s) => (group(s) === 1 || group(s) === 2 ? s.perHour ?? 0 : s.chance ?? 0);
  // A stable sort: ties (to rounding) keep the game data's order.
  const better = (a, b) => {
    const d = score(b) - score(a);
    return Math.abs(d) <= 1e-9 * Math.max(score(a), score(b)) ? 0 : d;
  };
  return out.sort((a, b) => group(a) - group(b) || better(a, b));
}
