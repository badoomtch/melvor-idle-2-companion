// Shop planner: what each upgrade does to the actions you actually do, and how fast it pays for itself.
// Bonus rules from ArtisanActionComponent (skip step, preservation, doubling) and the gathering
// actions. Isomorphic.
import { GP, purchaseStatus } from './gamedata.js';
import { bonusApplies, computeRates, expectedActions, MODELLED_BONUS_STATS } from './rates.js';

export { expectedActions };

/** Rates for a method with extra bonuses on top of the player's own. */
export function ratesWithBonuses(gd, method, level, effects) {
  return computeRates(gd, method, level, { bonuses: [...(gd.playerBonuses ?? []), ...effects] });
}

// GP cost of a purchase (items at sell price); other currencies are listed separately.
export function purchaseCost(gd, p) {
  const gpCost = p.costs.currencies.filter((c) => c.currency === GP).reduce((s, c) => s + c.qty, 0) + p.costs.items.reduce((s, i) => s + i.qty * gd.itemValue(i.item), 0);
  return { gp: gpCost, other: p.costs.currencies.filter((c) => c.currency !== GP) };
}

/**
 * Upgrades you can buy now, with their effect on the method you use for each skill they touch.
 * @param trains { skill: method } — what you do in each skill (current action, or the best one)
 * @param purchased { purchaseId: count } from the save
 */
export function planShop(gd, { levels, purchased = {}, trains }) {
  const rows = [];
  for (const p of gd.shop) {
    // Skip what you can't buy yet; keep what the save can't confirm, flagged.
    const status = purchaseStatus(gd, p, levels, purchased);
    if (status.soldOut || status.missing.length) continue;
    const effects = (p.provides.effects ?? []).filter((e) => MODELLED_BONUS_STATS.has(e.stat));
    if (!effects.length) continue;
    const cost = purchaseCost(gd, p);
    for (const skill of new Set(effects.map((e) => e.skill))) {
      const method = trains[skill];
      if (!method || !effects.some((e) => bonusApplies(e, method))) continue;
      const level = gd.levelOf(levels, skill);
      const before = computeRates(gd, method, level);
      const after = ratesWithBonuses(gd, method, level, effects);
      const gainGp = after.profitPerHour - before.profitPerHour;
      const gainXp = before.xpPerHour > 0 ? after.xpPerHour / before.xpPerHour - 1 : 0;
      if (gainGp <= 0.5 && gainXp <= 0.0005) continue;
      rows.push({ purchase: p, skill, method, before, after, gainGp, gainXp, cost, paybackHours: gainGp > 0 && cost.gp > 0 ? cost.gp / gainGp : null, unconfirmed: status.unknown });
    }
  }
  return rows;
}

// Bank space you can buy next, cheapest per slot first.
export function bankSpaceOptions(gd, { levels, purchased = {} }) {
  return gd.shop
    .filter((p) => (p.provides.effects ?? []).some((e) => e.stat === 'FlatMaxStacks'))
    .filter((p) => {
      const status = purchaseStatus(gd, p, levels, purchased);
      return !status.soldOut && !status.missing.length;
    })
    .map((p) => {
      const slots = p.provides.effects.filter((e) => e.stat === 'FlatMaxStacks').reduce((s, e) => s + e.value, 0);
      const cost = purchaseCost(gd, p);
      return { purchase: p, slots, cost, perSlot: slots > 0 ? cost.gp / slots : Infinity };
    })
    .sort((a, b) => a.perSlot - b.perSlot);
}
