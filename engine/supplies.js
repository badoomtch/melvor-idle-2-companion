// What you're using up, and how long it lasts. Isomorphic.
//
// Measured: compares consecutive autosaves of the same activity, so it covers everything the game
// actually takes (quiver ammo, food, runes, lockpicks, materials) without modelling the action.
// Estimated: from the current activity's rates, until there's enough play to measure.

import { currentActivity } from './advisor.js';

const HOUR_MS = 3_600_000;

export const activityKey = (header) => [header?.activeEntityName, header?.activeActionName].filter(Boolean).join(' - ');

/**
 * Change per hour of every item over the latest unbroken run of saves of the same activity.
 * @param snapshots [{ t, activity, stock: { item: qty } }] oldest first
 */
export function measureFlows(snapshots, { gapMs = 120_000, windowMs = 600_000 } = {}) {
  const last = snapshots.at(-1);
  if (!last) return null;
  let i = snapshots.length - 1;
  while (i > 0) {
    const prev = snapshots[i - 1];
    if (snapshots[i].t - prev.t > gapMs || last.t - prev.t > windowMs || prev.activity !== last.activity) break;
    i--;
  }
  const hours = (last.t - snapshots[i].t) / HOUR_MS;
  const perHour = {};
  // How many save-to-save steps each item went down in: one drop is a sale or a bank move, not usage.
  const drops = {};
  if (hours > 0) {
    const first = snapshots[i].stock;
    for (const id of new Set([...Object.keys(first), ...Object.keys(last.stock)])) {
      const change = (last.stock[id] ?? 0) - (first[id] ?? 0);
      if (change) perHour[id] = change / hours;
    }
    for (let k = i + 1; k < snapshots.length; k++) {
      for (const [id, qty] of Object.entries(snapshots[k - 1].stock)) if ((snapshots[k].stock[id] ?? 0) < qty) drops[id] = (drops[id] ?? 0) + 1;
    }
  }
  return { activity: last.activity, minutes: hours * 60, saves: snapshots.length - i, perHour, drops };
}

/**
 * Supplies the current activity uses, soonest to run out first.
 * @param estimate [{ item, perHour }] from the activity's rates (used until there's a measurement)
 */
export function supplyStatus({ flows, stock, estimate = [], activity = '' }) {
  const used = new Map();
  const measuring = flows && flows.activity === activity && flows.minutes >= 1;
  if (measuring) {
    const expected = new Set(estimate.map((e) => e.item));
    for (const [item, perHour] of Object.entries(flows.perHour)) {
      if (perHour >= 0) continue;
      // Steady use over several saves, or something this activity is known to use.
      if ((flows.drops[item] ?? 0) >= 2 || expected.has(item)) used.set(item, { item, perHour: -perHour, measured: true });
    }
  }
  for (const e of estimate) if (!used.has(e.item) && e.perHour > 0) used.set(e.item, { item: e.item, perHour: e.perHour, measured: false });
  return [...used.values()]
    .map((s) => ({ ...s, qty: stock?.[s.item] ?? 0, hoursLeft: (stock?.[s.item] ?? 0) / s.perHour }))
    .sort((a, b) => a.hoursLeft - b.hoursLeft);
}

// Supplies for whatever the save says you're doing right now.
export function currentSupplies(gd, save, levels, stock) {
  const r = currentActivity(gd, save.header, levels)?.rates;
  const estimate = r ? [...r.inputs.map((i) => ({ item: i.item, perHour: i.perHour })), ...(r.food ? [{ item: r.food.item, perHour: r.food.perHour }] : [])] : [];
  return supplyStatus({ flows: save.flows, stock, estimate, activity: activityKey(save.header) });
}

// Total XP across skills in a history snapshot.
export const totalXp = (snapshot) => Object.values(snapshot?.xp ?? {}).reduce((s, v) => s + v, 0);
