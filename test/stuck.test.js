// The "No XP" warning: waits as long as the action normally goes without XP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { computeRates, slowTries } from '../engine/rates.js';
import { span, STUCK_MIN_MS, stuckFor, stuckText } from '../engine/stuck.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 99]));
const tree = gd.methods.find((m) => m.kind === 'woodcutting');
const animal = gd.methods.find((m) => m.kind === 'hunting' && m.level > 1);
const header = (m) => ({ activeEntityName: gd.skills.find((s) => s.id === m.skill).name, activeActionName: m.name });
const doing = (m) => `${header(m).activeEntityName} - ${m.name}`;
// Autosaves every 10 seconds for `secs`, the XP standing still after the first.
const flat = (activity, secs, from = 0) => Array.from({ length: secs / 10 + 1 }, (_, i) => ({ t: (from + i * 10) * 1000, activity, xp: { A: 100 } }));

test('tries for the k-th success, all but 1 time in 10,000', () => {
  assert.equal(slowTries(1), 1);
  assert.equal(slowTries(1, 25), 25);
  assert.equal(slowTries(0.5), 14); // 0.5^13 is just over 1 in 10,000, 0.5^14 under
  assert.ok(slowTries(0.5, 10) > slowTries(0.5) * 2);
});

test('a hunting catch can go minutes without XP, a log only seconds', () => {
  const hunt = computeRates(gd, animal, 99);
  assert.ok(hunt.slowMsPerXp > STUCK_MIN_MS, `${animal.name}: ${hunt.slowMsPerXp} ms`);
  assert.ok(hunt.slowMsPerXp > 3 * hunt.msPerCycle);
  const log = computeRates(gd, tree, 99);
  assert.equal(log.slowMsPerXp, log.msPerCycle);
  // A heist gives XP only after all its stages.
  const heist = gd.methods.find((m) => m.kind === 'thieving' && m.stages > 1);
  const r = computeRates(gd, heist, 99);
  assert.ok(r.slowMsPerXp > heist.stages * heist.interval);
});

test('woodcutting with no XP for 90 seconds is stuck; hunting is not yet', () => {
  const chop = stuckFor(gd, { header: header(tree), history: flat(doing(tree), 90) }, levels);
  assert.equal(chop.ms, 90_000);
  assert.equal(chop.wait, STUCK_MIN_MS);
  assert.equal(stuckText(chop).title, 'No XP for 90 seconds');
  assert.match(stuckText(chop).body, /isn't gaining anything/);
  assert.equal(stuckFor(gd, { header: header(tree), history: flat(doing(tree), 70) }, levels), null);

  const wait = computeRates(gd, animal, 99).slowMsPerXp;
  assert.equal(stuckFor(gd, { header: header(animal), history: flat(doing(animal), 90) }, levels), null);
  const hunt = stuckFor(gd, { header: header(animal), history: flat(doing(animal), Math.ceil(wait / 10_000) * 10) }, levels);
  assert.ok(hunt);
  assert.match(stuckText(hunt).body, new RegExp(`normally gains XP at least every ${span(wait)}`));
});

test('the wait starts again with a new action, after XP, or after the game was closed', () => {
  const now = doing(tree);
  const switched = [...flat('Fishing - Shrimp', 60), ...flat(now, 50, 70)];
  assert.equal(stuckFor(gd, { header: header(tree), history: switched }, levels), null);
  const gained = flat(now, 120).map((h, i) => (i < 5 ? { ...h, xp: { A: 50 } } : h));
  assert.equal(stuckFor(gd, { header: header(tree), history: gained }, levels), null);
  const closed = [...flat(now, 60), ...flat(now, 50, 300)];
  assert.equal(stuckFor(gd, { header: header(tree), history: closed }, levels), null);
  assert.equal(stuckFor(gd, { header: header(tree), history: [...flat(now, 60), ...flat(now, 40, 70)] }, levels).ms, 110_000);
});
