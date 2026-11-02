// Item upgrades (the bank's Upgrade button): what one needs from you, and how long until you can do it.
// Isomorphic. In the game (ItemUpgradingComponent) an upgrade takes its costs, items and currency, and
// gives `qty` of the upgraded item at once; its button stays locked until its requirements are met.
import { obtain } from './advisor.js';

/**
 * What `times` upgrades need with what you have.
 * @param stock Map item -> qty you own (the bank); without it, materials are taken as in hand
 * @param wallet { currency: amount }; without it, costs in currency are taken as affordable
 * @param index producerIndex(gd, levels), to gather or make materials you're short of
 * @returns { ok: requirements met, missing, unknown, currency: [{ currency, need, have, short }],
 *   gather: [obtain() results for materials you're short of], cantGather: [items nothing you can do now
 *   makes], hours: time to gather (the upgrade itself is instant), ready: you can upgrade right now }
 */
export function upgradeNeeds(gd, upgrade, { levels, stock = null, wallet = null, index = null, times = 1 } = {}) {
  const req = gd.checkRequirements({ skill: null, level: 0, requires: upgrade.requires }, levels);
  const currency = upgrade.costs.currencies.map((c) => {
    const need = c.qty * times;
    const have = wallet ? (wallet[c.currency] ?? 0) : need;
    return { currency: c.currency, need, have, short: Math.max(0, need - have) };
  });
  const gather = [];
  const cantGather = [];
  if (stock) {
    for (const c of upgrade.costs.items) {
      const got = index ? obtain(index, stock, c.item, c.qty * times) : { item: c.item, short: Math.max(0, c.qty * times - (stock.get(c.item) ?? 0)), hours: Infinity };
      if (!(got.short > 0)) continue;
      if (Number.isFinite(got.hours)) gather.push({ ...got, qty: got.short });
      else cantGather.push(c.item);
    }
  }
  const hours = gather.reduce((s, x) => s + x.hours, 0);
  const ok = req.ok && !req.unknown.length;
  return { ok, missing: req.missing, unknown: req.unknown, currency, gather, cantGather, hours, ready: ok && !gather.length && !cantGather.length && currency.every((c) => !c.short) };
}
