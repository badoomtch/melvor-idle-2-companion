// Bank space: how full the bank is, and ways to empty slots without losing anything you'll need.
// The bank holds BaseMaxStacks (100, BankInventoryComponent) plus FlatMaxStacks from shop upgrades.

import { bankInsights } from './advisor.js';
import { computeRates } from './rates.js';

export const BASE_BANK_SLOTS = 100;

export function bankCapacity(gd, save) {
  let bought = 0;
  for (const [id, count] of Object.entries(save?.shopPurchases ?? {})) {
    const p = gd.shopById.get(id);
    for (const e of p?.provides.effects ?? []) if (e.stat === 'FlatMaxStacks') bought += e.value * Math.max(1, count);
  }
  const max = BASE_BANK_SLOTS + bought;
  const used = save?.bank?.stacks ?? Object.keys(save?.bank?.items ?? {}).length;
  return { used, max, free: Math.max(0, max - used) };
}

// What the route needs to know about bank space: what's held, the free slots, and the empty
// placeholders a returning item drops back into without needing a new slot.
export function bankRoom(gd, save) {
  if (!save?.bank?.items) return null;
  return { items: save.bank.items, free: bankCapacity(gd, save).free, empty: save.bank.empty ?? [] };
}

// Ways to free slots, best first:
//  - placeholders: empty slots kept for items you've run out of;
//  - craft: a recipe that uses up whole stacks and makes something you already have a stack of;
//  - sell: items nothing in the game uses (not food, gear or tools);
//  - bury: bones and ashes, for prayer points.
// Each says how many slots it frees and what you get (GP, or prayer points). A stack the game keeps as a
// placeholder when it runs out frees its slot only once that placeholder goes too: those are marked kept.
export function freeSpaceOptions(gd, bank, levels, { empty = [], kept = [] } = {}) {
  if (!bank) return [];
  const insights = bankInsights(gd, bank, levels);
  const options = [];
  if (empty.length) options.push({ kind: 'placeholders', items: empty, slots: empty.length, gp: 0, hours: 0 });
  const keeps = new Set(kept);
  const sellableIds = new Set(insights.sellable.map((x) => x.item));
  // Recipes that empty the same stacks are alternatives: keep the one that pays best.
  const bestCraft = new Map();
  for (const m of gd.methods) {
    if (!m.ingredients?.length || m.kind === 'farming' || m.kind === 'ranching') continue;
    if (!gd.checkRequirements(m, levels).ok) continue;
    const crafts = Math.floor(Math.min(...m.ingredients.map((i) => (bank[i.item] ?? 0) / i.qty)));
    if (crafts < 1) continue;
    // A stack empties only when the crafts use exactly all of it; each new product needs a slot.
    const emptiedIds = m.ingredients.filter((i) => (bank[i.item] ?? 0) === crafts * i.qty).map((i) => i.item);
    const emptied = emptiedIds.length;
    const products = [...(m.products ?? []), ...(m.product ? [m.product] : [])].map((p) => p.item);
    const newStacks = new Set(products.filter((item) => !(bank[item] > 0))).size;
    const slots = emptied - newStacks;
    if (slots < 1) continue;
    const rates = computeRates(gd, m, gd.levelOf(levels, m.skill));
    const gainPerCraft = rates.cyclesPerHour > 0 ? rates.profitPerHour / rates.cyclesPerHour : 0;
    const option = { kind: 'craft', method: m, crafts, slots, gp: crafts * gainPerCraft, hours: rates.cyclesPerHour > 0 ? crafts / rates.cyclesPerHour : 0, emptied: emptiedIds, kept: emptiedIds.some((i) => keeps.has(i)) };
    const key = emptiedIds.sort().join('|');
    if (option.gp >= 0 && (!bestCraft.has(key) || option.gp > bestCraft.get(key).gp)) bestCraft.set(key, option);
  }
  options.push(...bestCraft.values());
  for (const x of insights.sellable) options.push({ kind: 'sell', item: x.item, qty: x.qty, slots: 1, gp: x.total, hours: 0, kept: keeps.has(x.item) });
  for (const [item, qty] of Object.entries(bank)) {
    const points = gd.items[item]?.prayerPoints;
    if (qty > 0 && points && !sellableIds.has(item)) options.push({ kind: 'bury', item, qty, slots: 1, prayerPoints: qty * points, gp: 0, hours: 0, kept: keeps.has(item) });
  }
  // Empty placeholders cost nothing to clear, so they come first; then crafting that pays, then selling
  // (most GP first), then burying.
  const order = { placeholders: -1, craft: 0, sell: 1, bury: 2 };
  return options.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === 'craft' ? b.slots - a.slots || b.gp - a.gp : b.gp - a.gp || (b.prayerPoints ?? 0) - (a.prayerPoints ?? 0)));
}
