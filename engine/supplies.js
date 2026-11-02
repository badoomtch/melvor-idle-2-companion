// What you're using up, and how long it lasts. Isomorphic.
//
// Measured: compares consecutive autosaves of the same activity, so it covers everything the game
// actually takes (quiver ammo, food, runes, lockpicks, materials) without modelling the action.
// Estimated: from the current activity's rates, until there's enough play to measure.

import { currentActivity } from './advisor.js';
import { currentFight } from './current-fight.js';

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

/**
 * Stock up before you start: for each supply, how many more you need to keep going for `hours`, and the
 * quickest way to get them with what you can do now (obtain(): gathering or making, materials first).
 * @param supplies currentSupplies() rows; index producerIndex(); stock { item: qty } you own
 * @returns rows still short: { item, need, have, short, get } (get: obtain() result, method null if nothing makes it)
 */
export function stockUp(supplies, hours, { index, stock, obtain }) {
  const pool = new Map(Object.entries(stock ?? {}));
  const out = [];
  for (const s of supplies) {
    const need = Math.ceil(s.perHour * hours);
    const have = Math.max(0, stock?.[s.item] ?? 0);
    if (have >= need) continue;
    // obtain() takes what's in the bank first, then makes the rest, up to five steps deep (ammo is ore,
    // bars, arrowtips, shafts and feathers away).
    out.push({ item: s.item, need, have, short: need - have, get: obtain(index, pool, s.item, need, 5) });
  }
  return out;
}

// Supplies for whatever the save says you're doing right now.
export function currentSupplies(gd, save, levels, stock) {
  const a = currentActivity(gd, save.header, levels);
  const r = a?.rates;
  // Food only when one is selected in that skill's food slot: with none, the game doesn't eat.
  const slot = a?.skill ? save.foods?.[a.skill] : null;
  const heal = slot ? gd.items[slot]?.heal ?? 0 : 0;
  const food = r?.hpLossPerHour > 0 && heal > 0 ? [{ item: slot, perHour: r.hpLossPerHour / heal }] : [];
  // A fight: its food, ammo and runes, worked out with the gear you have on.
  const fighting = currentFight(gd, save, levels);
  const estimate = fighting ? fighting.uses : r ? [...r.inputs.map((i) => ({ item: i.item, perHour: i.perHour })), ...food] : [];
  return supplyStatus({ flows: save.flows, stock, estimate, activity: activityKey(save.header) });
}

// Total XP across skills in a history snapshot.
export const totalXp = (snapshot) => Object.values(snapshot?.xp ?? {}).reduce((s, v) => s + v, 0);
