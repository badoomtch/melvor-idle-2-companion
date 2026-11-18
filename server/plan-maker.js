// Making a plan from a save: the goals worth going for beyond the next unlocks (gear, toolbelt items,
// combat levels and Mastery ranks: slow, a few seconds), then the route through them, locked as plain data
// to keep. It runs in a worker thread (plan-worker.js) so the companion keeps answering the page and
// sending notifications while it works; tests run it inline.
import { Worker } from 'node:worker_threads';
import { currentActivity } from '../engine/advisor.js';
import { bankCapacity, bankRoom } from '../engine/bank-space.js';
import { playerBonuses, playerState } from '../engine/gamedata.js';
import { extraGoals } from '../engine/route-goals.js';
import { lockRoute } from '../engine/route-progress.js';
import { planRoute } from '../engine/route.js';

// What the planner needs from a save: levels, XP, what you own, and what you're doing. Sets gd.player
// and gd.playerBonuses from it.
export function planInputs(gd, save, { useBonuses = true } = {}) {
  gd.player = playerState(save, gd);
  gd.playerBonuses = useBonuses ? playerBonuses(gd, save) : null;
  const levels = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.level]));
  const xp = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.xp]));
  return { levels, xp, bank: gd.player.owned, mastery: save.mastery ?? null, current: currentActivity(gd, save.header, levels)?.method?.key ?? null,
    bankItems: save.bank?.items ?? {}, room: bankRoom(gd, save) ?? { items: {}, free: bankCapacity(gd, save).free } };
}

/**
 * A plan, locked to keep.
 * @param job { save, why, prefer (an earlier plan's decisions), useBonuses, targets (your goals), speed (your
 *   measured speed per method), madeAt, goalsKey } — plain data, so it can go to a worker
 */
export function makePlan(gd, { save, why = null, prefer = null, useBonuses = true, targets = [], speed = {}, madeAt = Date.now(), goalsKey = '[]' }, plan = planRoute) {
  const input = planInputs(gd, save, { useBonuses });
  let extras = [];
  try {
    extras = extraGoals(gd, save, { ...input, targets });
  } catch (e) {
    console.error(`Could not weigh gear, combat and Mastery goals: ${e.message}`);
  }
  gd.planSpeed = Object.keys(speed ?? {}).length ? speed : null;
  let route;
  try {
    route = plan(gd, { ...input, prefer, extras, purchased: save.shopPurchases ?? {}, targets });
  } finally {
    gd.planSpeed = null;
  }
  return { ...lockRoute(route, { madeAt, speed }), why, goalsKey };
}

/**
 * Makes plans in a worker thread: (job) => Promise of the locked plan. The worker builds its own game data
 * once, from `data`. If it can't start, plans are made inline instead (and the companion pauses while it works).
 */
export function planWorker(data, gd) {
  let worker = null;
  let n = 0;
  const waiting = new Map();
  const inline = (job) => Promise.resolve().then(() => makePlan(gd, job));
  try {
    worker = new Worker(new URL('./plan-worker.js', import.meta.url), { workerData: { data } });
    worker.on('message', ({ n: id, locked, error }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (error) w?.reject(new Error(error));
      else w?.resolve(locked);
    });
    worker.on('error', (e) => {
      console.error(`The plan worker stopped: ${e.message}. Plans are made here instead.`);
      worker = null;
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
    });
    // The worker doesn't keep the companion running by itself (after the listeners: adding one refs it again).
    worker.unref();
  } catch (e) {
    console.error(`Could not start the plan worker: ${e.message}. Plans are made here instead.`);
    worker = null;
  }
  return (job) => {
    if (!worker) return inline(job);
    return new Promise((resolve, reject) => {
      waiting.set(++n, { resolve, reject });
      worker.postMessage({ n, job });
    }).catch((e) => {
      console.error(`A plan in the worker failed: ${e.message}. Making it here instead.`);
      return inline(job);
    });
  };
}
