// Telling a stuck action from a slow one. Isomorphic.
//
// Most actions gain XP every few seconds, but some only now and then: a hunting catch, the last stage
// of a heist, the end of an Agility run. The "No XP" warning waits for the longest the action normally
// goes without XP (all but 1 time in 10,000), and at least 90 seconds.

import { activeMethod } from './advisor.js';
import { computeRates } from './rates.js';
import { activityKey, totalXp } from './supplies.js';

export const STUCK_MIN_MS = 90_000;
// Autosaves further apart than this mean the game was closed or paused in between.
const GAP_MS = 60_000;
// The game saves every 10 seconds, so a wait is only ever seen to within a few seconds.
const SLACK_MS = 5_000;

// The longest the action the save is on normally goes without XP.
export function stuckAfterMs(gd, header, levels) {
  const method = activeMethod(gd, header);
  if (!method) return STUCK_MIN_MS;
  const r = computeRates(gd, method, gd.levelOf(levels, method.skill));
  return Math.max(STUCK_MIN_MS, r.slowMsPerXp ?? 0);
}

/**
 * How long the action in the latest autosave has gone without XP, over the unbroken run of autosaves
 * of it, once that's longer than it normally ever is.
 * @param save a parsed save with the server's history ([{ t, activity, xp }], oldest first)
 * @returns { doing, ms, wait } or null
 */
export function stuckFor(gd, save, levels) {
  const doing = activityKey(save?.header);
  const history = save?.history ?? [];
  const last = history.at(-1);
  if (!doing || !last || last.activity !== doing) return null;
  let first = last;
  for (let i = history.length - 2; i >= 0; i--) {
    const h = history[i];
    if (h.activity !== doing || first.t - h.t > GAP_MS || totalXp(h) !== totalXp(last)) break;
    first = h;
  }
  const ms = last.t - first.t;
  if (ms < STUCK_MIN_MS - SLACK_MS) return null;
  const wait = stuckAfterMs(gd, save.header, levels);
  return ms >= wait - SLACK_MS ? { doing, ms, wait } : null;
}

// "90 seconds", "4 min", "3 hours"
export const span = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} seconds` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} hours`);

// The warning's words, the same in the top bar, the pop-up and the desktop notification.
export const stuckText = (s) => ({
  title: `No XP for ${span(s.ms)}`,
  body: s.wait > STUCK_MIN_MS ? `${s.doing} normally gains XP at least every ${span(s.wait)}. Is it stuck?` : `${s.doing} isn't gaining anything. Is it stuck?`,
});
