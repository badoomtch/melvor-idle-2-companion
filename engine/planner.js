// What to leave running while you're away. Isomorphic.
import { simulate } from './advisor.js';
import { computeRates } from './rates.js';

// How long stock keeps an action going: its materials, and the food eaten for damage taken.
export function runHours(rates, stock) {
  let hours = Infinity;
  for (const i of rates.inputs) hours = Math.min(hours, (stock?.[i.item] ?? 0) / i.perHour);
  if (rates.food?.perHour > 0) hours = Math.min(hours, (stock?.[rates.food.item] ?? 0) / rates.food.perHour);
  return hours;
}

/**
 * Every action you could leave running for `hours` (capped at the game's offline limit), simulated
 * with level-ups, stopping early when your stock runs out.
 * @param stock what you own; null assumes unlimited materials
 */
export function planAway(gd, { levels, xp = {}, stock = null, hours, skill = null }) {
  const away = Math.min(hours, gd.mechanics.offlineCapHours ?? 24);
  const rows = [];
  for (const method of gd.methods) {
    if (method.kind === 'farming' || (skill && method.skill !== skill)) continue;
    const req = gd.checkRequirements(method, levels);
    if (!req.ok || req.unknown.length) continue;
    const level = gd.levelOf(levels, method.skill);
    const rates = computeRates(gd, method, level);
    if (!(rates.xpPerHour > 0)) continue;
    const lasts = stock ? runHours(rates, stock) : Infinity;
    const runs = Math.min(away, lasts);
    if (!(runs > 0)) continue;
    const sim = simulate(gd, method, levels, xp[method.skill] ?? gd.xp.xpForLevel(level), { hours: runs });
    rows.push({ method, rates, equip: req.equip, lasts, runs, away, sim });
  }
  return rows;
}
