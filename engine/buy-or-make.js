// Buy or make: for each thing the shop sells, whether buying it beats making it yourself.
// Making costs the time it takes from scratch (gathering every material on the way, as the
// training plans do), valued at the GP/h you'd otherwise earn. Buying costs its price, with any
// items it takes counted at their sell value.

import { obtain, producerIndex } from './advisor.js';
import { GP, purchaseStatus } from './gamedata.js';
import { purchaseCost } from './shop.js';

const BATCH = 100; // priced over a batch, so one-off overheads don't dominate

// Only what you can buy right now; anything the save can't confirm (a Mastery Guild rank without a
// save, a dungeon record) counts as not yet.
const shopAvailable = (gd, p, levels, purchased) => purchaseStatus(gd, p, levels, purchased).ok;

/**
 * @param timeValue GP an hour of your time is worth (e.g. your best money method)
 * @returns rows { purchase, item, buyEach, makeHoursEach, method, chain, breakEven, verdict }
 */
export function buyOrMake(gd, levels, { timeValue, purchased = {}, index = producerIndex(gd, levels) } = {}) {
  const rows = [];
  for (const p of gd.shop) {
    if (p.provides.items?.length !== 1 || !shopAvailable(gd, p, levels, purchased)) continue;
    const cost = purchaseCost(gd, p);
    if (cost.other.length) continue; // paid in another currency (slayer coins, tokens): not comparable in GP
    const { item, qty } = p.provides.items[0];
    const make = obtain(index, new Map(), item, BATCH * qty);
    if (!make.method || !Number.isFinite(make.hours)) continue;
    const buyEach = cost.gp / qty;
    const makeHoursEach = make.hours / (BATCH * qty);
    // The GP/h at which both cost the same: worth more than that, buy; less, make.
    const breakEven = makeHoursEach > 0 ? buyEach / makeHoursEach : Infinity;
    rows.push({
      purchase: p,
      item,
      buyEach,
      makeHoursEach,
      method: make.method,
      chain: [...make.needs.map((n) => n.method), make.method],
      breakEven,
      verdict: timeValue > breakEven ? 'buy' : 'make',
      saving: Math.abs(timeValue * makeHoursEach - buyEach),
    });
  }
  return rows.sort((a, b) => b.saving - a.saving);
}

// For one item: the shop's offer and the quickest way to make it, if there are both.
export function buyOrMakeItem(gd, levels, item, options) {
  return buyOrMake(gd, levels, options).find((r) => r.item === item) ?? null;
}

export { GP };
