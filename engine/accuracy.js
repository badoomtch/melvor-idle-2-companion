// Checks the companion's estimates against what each action actually gave you (recorded per action
// from consecutive autosaves by the server). Isomorphic.
import { currentActivity } from './advisor.js';

export const MIN_SECONDS = 120;

/**
 * One row per action you've done for at least two minutes: measured vs estimated XP and items per hour.
 * @param actions { "Skill - Action": { seconds, xp: { skill: gained }, items: { item: change } } }
 */
export function compareActions(gd, actions, levels) {
  const rows = [];
  for (const [key, obs] of Object.entries(actions ?? {})) {
    if (!(obs.seconds >= MIN_SECONDS)) continue;
    const [entity, ...rest] = key.split(' - ');
    const activity = currentActivity(gd, { activeEntityName: entity, activeActionName: rest.join(' - ') }, levels);
    const hours = obs.seconds / 3600;
    const skill = activity?.skill ?? null;
    const measuredXp = skill ? (obs.xp[skill] ?? 0) / hours : Object.values(obs.xp).reduce((s, v) => s + v, 0) / hours;
    const rates = activity?.rates ?? null;
    const estimatedXp = rates?.xpPerHour ?? null;
    const ratio = estimatedXp > 0 ? measuredXp / estimatedXp : null;
    // Items: what the estimate expects made or used, against the measured change.
    const items = [];
    if (rates) {
      for (const o of rates.outputs) items.push({ item: o.item, estimated: o.perHour, measured: (obs.items[o.item] ?? 0) / hours });
      for (const i of rates.inputs) items.push({ item: i.item, estimated: -i.perHour, measured: (obs.items[i.item] ?? 0) / hours });
    }
    rows.push({ key, skill, method: activity?.method ?? null, hours, measuredXp, estimatedXp, ratio, items, lastSeen: obs.lastSeen });
  }
  return rows.sort((a, b) => Math.abs(Math.log(b.ratio ?? 1)) - Math.abs(Math.log(a.ratio ?? 1)));
}

// Your own speed at each action you've done a while, for plans: { methodKey: measured ÷ estimated XP/hour }.
// A short sample only moves it part of the way (a full half hour counts in full), and it's kept within
// half to double, so one odd stretch can't swing a plan.
export function speedFactors(gd, actions, levels) {
  const out = {};
  for (const row of compareActions(gd, actions, levels)) {
    if (!row.method || !(row.ratio > 0)) continue;
    const weight = Math.min(1, row.hours / 0.5);
    out[row.method.key] = Math.min(2, Math.max(0.5, 1 + (row.ratio - 1) * weight));
  }
  return out;
}

// How far off an estimate is, as a word: within 5% is good, within 15% close, beyond that off.
export const verdict = (ratio) => (ratio == null ? 'unknown' : Math.abs(ratio - 1) <= 0.05 ? 'good' : Math.abs(ratio - 1) <= 0.15 ? 'close' : 'off');
