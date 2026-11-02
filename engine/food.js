// The best food for a fight. For every food: how much of it the fight eats (auto-eat only uses the
// healing between its threshold and full, after auto-eat efficiency), and what that costs: the time to
// gather and cook it at your rates and bonuses (burnt food, doubling and preservation included), the
// GP to buy it, or its sell value when it's already in your bank. A food's combat bonus counts while it's
// selected, so each one is fought with its own bonus (more max hit or protection: more XP, less eaten). Isomorphic.
import { obtain } from './advisor.js';
import { fight, withFood } from './combat.js';
import { combatFoodMods, GP, purchaseStatus } from './gamedata.js';

// Times each food over a batch so making the first one (a whole tree for one log) doesn't dominate.
const BATCH = 100;

/**
 * @param player buildPlayer() result for the gear you'd fight with
 * @param enemy buildEnemy() result for what you'd fight
 * @param index producerIndex(gd, levels)
 * @returns rows: { item, heal, healUsed, perHour, owned, lastsHours, make: { hoursEach, perCombatHour, method } | null,
 *   buy: { each, perCombatHour } | null, sellPerCombatHour, bonus: its combat mods, xpPerHour, combatXpPerHour, hpLossPerHour };
 *   empty when the fight doesn't need food
 */
export function foodOptions(gd, { player, enemy, levels, bank = {}, index, purchased = {} }) {
  const buyEach = new Map();
  for (const p of gd.shop) {
    const give = p.provides.items.find((i) => gd.items[i.item]?.heal);
    if (!give || p.costs.items.length || p.costs.currencies.some((c) => c.currency !== GP)) continue;
    if (!purchaseStatus(gd, p, levels, purchased).ok) continue;
    const each = p.costs.currencies.reduce((s, c) => s + c.qty, 0) / give.qty;
    if (!buyEach.has(give.item) || each < buyEach.get(give.item)) buyEach.set(give.item, each);
  }
  const none = new Map();
  const rows = [];
  for (const f of gd.foods) {
    const r = fight(gd, withFood(gd, player, f.item), enemy, { food: f.item });
    if (!(r.foodPerHour > 0)) continue;
    const owned = bank[f.item] ?? 0;
    const made = obtain(index, none, f.item, BATCH);
    const hoursEach = Number.isFinite(made.hours) && made.method ? made.hours / BATCH : null;
    const buy = buyEach.get(f.item) ?? null;
    rows.push({
      item: f.item,
      heal: f.heal,
      // Healing per item eaten; items kept by food preservation still heal.
      healUsed: r.hpLossPerHour / (r.foodEatenPerHour ?? r.foodPerHour),
      perHour: r.foodPerHour,
      owned,
      lastsHours: owned / r.foodPerHour,
      make: hoursEach != null ? { hoursEach, perCombatHour: hoursEach * r.foodPerHour, method: made.method, needs: made.needs } : null,
      buy: buy != null ? { each: buy, perCombatHour: buy * r.foodPerHour } : null,
      sellPerCombatHour: gd.itemValue(f.item) * r.foodPerHour,
      bonus: combatFoodMods(gd, f.item),
      xpPerHour: r.xpPerHour,
      combatXpPerHour: r.combatXpPerHour,
      hpLossPerHour: r.hpLossPerHour,
    });
  }
  return rows;
}
