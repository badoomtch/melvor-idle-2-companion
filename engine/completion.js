// Completion log progress and the quickest way to fill each gap. Isomorphic.
import { obtain, producerIndex } from './advisor.js';
import { purchaseStatus } from './gamedata.js';
import { itemDetails, triesFor } from './lookup.js';
import { computeRates } from './rates.js';

const usable = (req) => req.ok && req.unknown.length === 0;

/**
 * The fastest known way to get one of an item with what you can do now.
 * @param bestFights Map enemyId -> fight result (from the combat recommendations); null skips enemies
 * @param purchased shop purchases made so far (save.shopPurchases)
 * @param index producerIndex(gd, levels), built here when missing; with `stock`, a craft's materials
 *   you're short of add the time to gather or make them (`gather`, each with its chain in `needs`)
 */
export function quickestSource(gd, itemId, { levels, bestFights = null, wallet = null, stock = null, purchased = null, index = null }) {
  let best = null;
  const have = stock ? new Map(Object.entries(stock)) : null;
  const consider = (option) => {
    if (!best || option.hours < best.hours) best = option;
  };
  const blockers = [];
  for (const source of itemDetails(gd, itemId).sources) {
    if (source.type === 'method') {
      const m = source.method;
      const req = gd.checkRequirements(m, levels);
      if (!usable(req)) {
        blockers.push({ type: 'method', method: m, missing: req.missing });
        continue;
      }
      const rates = computeRates(gd, m, gd.levelOf(levels, m.skill));
      const perHour = rates.outputs.find((o) => o.item === itemId)?.perHour ?? 0;
      if (!(perHour > 0)) continue;
      // Materials for one, in whole items (one fur makes 25 mitts, but you still need a whole fur):
      // from the bank, else the quickest way to gather or make them.
      const materials = have ? rates.inputs.map((i) => obtain(index ??= producerIndex(gd, levels), have, i.item, Math.ceil(i.perHour / perHour - 1e-9))) : [];
      const gather = materials.filter((x) => x.short > 0).map((x) => ({ ...x, qty: x.short }));
      if (gather.some((x) => !x.method)) {
        blockers.push({ type: 'method', method: m, missing: [], materials: gather.filter((x) => !x.method).map((x) => x.item) });
        continue;
      }
      const gatherHours = gather.reduce((s, x) => s + x.hours, 0);
      consider({ type: 'method', method: m, hours: 1 / perHour + gatherHours, gatherHours, gather, perHour });
    } else if (source.type === 'enemy') {
      const fight = bestFights?.get(source.enemy.id);
      if (!fight || fight.result.risky || !(fight.result.killsPerHour > 0)) {
        blockers.push({ type: 'enemy', enemy: source.enemy });
        continue;
      }
      const kills = triesFor(source.chance, 0.5);
      consider({ type: 'enemy', enemy: source.enemy, chance: source.chance, kills, hours: kills / fight.result.killsPerHour, fight });
    } else if (source.type === 'shop') {
      const p = source.purchase;
      // Mastery Guild ranks, quests, kills and earlier purchases count too; anything the save can't confirm blocks it.
      const blocked = !purchaseStatus(gd, p, levels, purchased ?? {}).ok;
      // Only "now" if you can pay: currencies you hold and items you own (unknown currencies don't count).
      const affordable = !wallet || (p.costs.currencies.every((c) => (wallet[c.currency] ?? 0) >= c.qty) && p.costs.items.every((i) => (stock?.[i.item] ?? 0) >= i.qty));
      if (blocked || !affordable) blockers.push({ type: 'shop', purchase: p, affordable });
      else consider({ type: 'shop', purchase: p, hours: 0 });
    }
  }
  return { best, blockers };
}

/** Progress on each part of the completion log, with the quickest missing items and enemies. */
export function completionStatus(gd, { save, levels, bestFights = null, stock = null }) {
  const wallet = save?.header ? { GoldPieces: save.header.gp ?? 0, SlayerCoins: save.header.slayerCoins ?? 0 } : null;
  const found = save?.itemsFound ?? {};
  const killed = save?.enemiesKilled ?? {};
  const items = gd.raw.completion?.items ?? [];
  const enemies = gd.raw.completion?.enemies ?? [];
  const missingItems = items.filter((id) => !(found[id.split(':').pop()] > 0));
  const missingEnemies = enemies.filter((id) => !(killed[id] > 0)).map((id) => gd.enemyById.get(id)).filter(Boolean);
  const cap = gd.levelCap;
  const bank = stock ?? save?.bank?.items ?? null;
  const index = bank ? producerIndex(gd, levels) : null;
  return {
    items: { total: items.length, done: items.length - missingItems.length, missing: missingItems },
    enemies: { total: enemies.length, done: enemies.length - missingEnemies.length, missing: missingEnemies },
    pets: { total: gd.raw.pets?.length ?? 0, done: save?.pets?.length ?? 0 },
    levels: { total: gd.skills.length * cap, done: gd.skills.reduce((s, sk) => s + Math.min(cap, gd.levelOf(levels, sk.id)), 0) },
    nextItems: missingItems
      .map((id) => ({ item: id, ...quickestSource(gd, id, { levels, bestFights, wallet, stock: bank, purchased: save?.shopPurchases, index }) }))
      .filter((x) => x.best)
      .sort((a, b) => a.best.hours - b.best.hours),
    nextEnemies: missingEnemies
      .map((enemy) => ({ enemy, fight: bestFights?.get(enemy.id) ?? null }))
      .sort((a, b) => (a.fight && !a.fight.result.risky ? a.fight.result.killSeconds : Infinity) - (b.fight && !b.fight.result.risky ? b.fight.result.killSeconds : Infinity)),
  };
}
