// Follows a plan the way a player would: does what "Do this now" says, a minute at a time, and reads the
// progress back after every minute like an autosave. The plan must never send you somewhere else before
// the step you're on is done (the complaint that started all this), and must keep moving.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { computeRates } from '../engine/rates.js';
import { lockRoute, routeProgress } from '../engine/route-progress.js';
import { planRoute } from '../engine/route.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));

function follow({ level, bank, minutes, order = 'plan' }) {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, level]));
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(level)]));
  bank = { ...bank };
  let current = null;
  let locked = null;
  let lastStep = null;
  const log = { plans: 0, early: [], changes: 0, stuck: 0 };
  for (let t = 0; t < minutes; t++) {
    let p = locked && routeProgress(gd, locked, { levels, xp, bank, current });
    if (!locked || p.finished || p.blocked) {
      locked = lockRoute(planRoute(gd, { levels, xp, bank, current, prefer: locked?.decisions }));
      log.plans++;
      lastStep = null;
      p = routeProgress(gd, locked, { levels, xp, bank, current });
    }
    locked.done.push(...p.newlyDone);
    let st = p.step;
    if (!st) break;
    if (order === 'reverse') {
      const leg = p.legs.find((l) => l.steps.includes(st));
      const can = (x) => gd.checkRequirements(x.method, levels).ok && computeRates(gd, x.method, levels[x.method.skill]).inputs.every((i) => (bank[i.item] ?? 0) >= 1);
      st = [...leg.steps].reverse().find((x) => !x.done && can(x)) ?? st;
    }
    // A new instruction while the last one isn't done: the plan changed its mind under you.
    if (lastStep && st.id !== lastStep && order === 'plan') {
      log.changes++;
      const was = p.legs.flatMap((l) => l.steps).find((x) => x.id === lastStep);
      if (was && !was.done) log.early.push(`${t}m: ${was.method.name} -> ${st.method.name}`);
    }
    lastStep = st.id;
    // A minute of it.
    const r = computeRates(gd, st.method, levels[st.method.skill] ?? 1);
    const each = (perHour) => perHour / r.cyclesPerHour;
    const n = Math.min(r.cyclesPerHour / 60, ...r.inputs.map((i) => ((bank[i.item] ?? 0) >= 1 ? (bank[i.item] ?? 0) / each(i.perHour) : 0)));
    current = n > 0 ? st.method.key : null;
    if (!(n > 0)) log.stuck++;
    for (const i of r.inputs) bank[i.item] = Math.max(0, (bank[i.item] ?? 0) - each(i.perHour) * n);
    for (const o of r.outputs) bank[o.item] = (bank[o.item] ?? 0) + each(o.perHour) * n;
    const s = st.method.skill;
    xp[s] += each(r.xpPerHour) * n;
    levels[s] = Math.max(levels[s], gd.xp.levelForXp(xp[s], gd.levelCap));
  }
  return { ...log, levels };
}

// Empty banks, so goals gather before they train and several steps are open at once: a plan that
// hops between them would show.
for (const start of [25, 35]) {
  test(`following the plan from level ${start}, the step never changes until it is done, and the plan keeps going`, () => {
    const run = follow({ level: start, bank: {}, minutes: 180 });
    assert.deepEqual(run.early, [], 'no step was dropped before it was done');
    assert.ok(run.changes >= 5, `the plan moved on (${run.changes} steps)`);
    assert.ok(run.plans <= 2, `it kept its plan (${run.plans} plans in 3 hours)`);
    assert.ok(run.stuck <= 3, `"Do this now" was something you could do (${run.stuck} minutes not)`);
    const gained = Object.values(run.levels).reduce((s, l) => s + l - start, 0);
    assert.ok(gained >= 5, `levels went up (${gained})`);
  });
}

test('doing the steps in a different order still gets ticked off with nothing to click', () => {
  const run = follow({ level: 25, bank: { 'MelvorBase:NormalLog': 300, 'MelvorBase:OakLog': 300 }, minutes: 150, order: 'reverse' });
  const gained = Object.values(run.levels).reduce((s, l) => s + l - 25, 0);
  assert.ok(gained >= 5, `progress was made (${gained} levels)`);
  assert.ok(run.plans <= 8, `it re-planned only when something ran out (${run.plans} plans)`);
});
