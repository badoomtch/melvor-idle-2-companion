import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { producerIndex } from '../engine/advisor.js';
import { buildEnemy, buildPlayer, fight, ownedEquipment, recommendStyle } from '../engine/combat.js';
import { foodOptions } from '../engine/food.js';
import { createGameData } from '../engine/gamedata.js';
import { gearUpgrades } from '../engine/gear-upgrades.js';
import { combatLevel } from '../engine/lookup.js';
import { masteryPlan, planRank } from '../engine/mastery-plan.js';
import { computeRates } from '../engine/rates.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));

test('enemy combat level follows the game: each style the enemy uses, its levels times the style ratios', () => {
  const e = gd.enemyById.get('GrumpyGolem');
  const melee = gd.combat.styles.Melee.combatLevel.reduce((s, r) => s + e.levels[r.level] * r.ratio, 0);
  assert.equal(combatLevel(e, gd), Math.floor(melee));
  assert.equal(combatLevel(e, gd), Math.floor(0.325 * 26 + 0.325 * 33 + 0.25 * 25));
});

test('mastery tasks are timed from their saved progress, and tasks counting the same thing share it', () => {
  const levels = at(1);
  const save = { skills: {}, mastery: { Cooking: { CookingTask7: { goalComplete: false, goalProgress: 200, triggerMet: true }, CookingTask8: { goalComplete: false, goalProgress: 200, triggerMet: true } } } };
  const bank = { 'MelvorBase:RawShrimp': 1e6 };
  const cooking = masteryPlan(gd, save, levels, { bank }).find((p) => p.skill === 'Cooking');
  const r = computeRates(gd, gd.methodByKey.get('Cooking/Shrimp'), 1);
  const perHour = r.cyclesPerHour * (r.successChance ?? 1);
  const small = cooking.open.find((t) => t.task.id === 'CookingTask7');
  const big = cooking.open.find((t) => t.task.id === 'CookingTask8');
  close(small.hours, 50 / perHour);
  close(big.hours, 1800 / perHour);
  assert.equal(small.label, 'Cook 250 Shrimp');
  assert.deepEqual(small.progress, { done: 200, of: 250 });
  assert.equal(small.key, big.key);
  // Without the raw fish, catching it first adds time.
  const fresh = masteryPlan(gd, save, levels, {}).find((p) => p.skill === 'Cooking').open.find((t) => t.task.id === 'CookingTask7');
  close(fresh.hours, small.hours);
  const short = masteryPlan(gd, save, levels, { bank: {} }).find((p) => p.skill === 'Cooking').open.find((t) => t.task.id === 'CookingTask7');
  assert.ok(short.hours > small.hours);
});

test('the route to a rank picks the cheapest hours per point, and counts shared progress once', () => {
  const t = (points, hours, key) => ({ points, hours, key });
  const small = t(1, 1, 'shrimp');
  const big = t(2, 5, 'shrimp');
  const other = t(3, 9, 'logs');
  const slow = t(1, 50, 'ore');
  const untimed = { points: 10, hours: null, key: 'x' };
  // 3 points: the small task (1 h/pt), then the big one costs only its extra 4 h (2 h/pt) — not 5.
  const plan = planRank([slow, other, big, small, untimed], 3);
  assert.deepEqual(plan.tasks, [small, big]);
  assert.equal(plan.hours, 5);
  assert.equal(plan.points, 3);
  // Not enough timed tasks for the rank: no plan.
  assert.equal(planRank([small, untimed], 5), null);
  assert.equal(planRank([small], 0), null);
});

test('food is ranked by skilling time per hour of fighting, and auto-eat only uses healing up to max HP', () => {
  const levels = at(20);
  const p = buildPlayer(gd, { gear: [], stance: 'Stab', levels });
  const e = buildEnemy(gd, gd.enemyById.get('UndeadFarmer'));
  const rows = foodOptions(gd, { player: p, enemy: e, levels, bank: { 'MelvorBase:Shrimp': 50 }, index: producerIndex(gd, levels) });
  assert.ok(rows.length > 0);
  const cap = p.hitpoints - Math.round(0.25 * p.hitpoints);
  for (const r of rows) {
    assert.ok(r.healUsed <= Math.min(r.heal, cap) + 1e-9);
    if (r.make) close(r.make.perCombatHour, r.make.hoursEach * r.perHour);
  }
  const shrimp = rows.find((r) => r.item === 'MelvorBase:Shrimp');
  assert.equal(shrimp.owned, 50);
  close(shrimp.perHour, fight(gd, p, e, { food: 'MelvorBase:Shrimp' }).foodPerHour);
});

test('gear upgrades include better gear you can make from your bank, and gear a few levels away', () => {
  const levels = { ...at(25), Smithing: 15 };
  const bank = { 'MelvorBase:StoneSword': 1, 'MelvorBase:IronBar': 20, 'MelvorBase:Shrimp': 1000 };
  const owned = ownedEquipment(gd, bank, null);
  const rec = recommendStyle(gd, { style: 'Melee', owned, levels, bank, food: 'MelvorBase:Shrimp' });
  assert.ok(rec?.gear?.enemy);
  const up = gearUpgrades(gd, { rec, owned, levels, bank, food: 'MelvorBase:Shrimp', index: producerIndex(gd, levels) });
  const scimitar = up.ready.find((r) => r.item === 'MelvorBase:IronScimitar');
  assert.ok(scimitar, 'an Iron Scimitar you can smith now beats a Stone Sword');
  assert.equal(scimitar.source.type, 'make');
  assert.equal(scimitar.slot, 'Weapon');
  assert.ok(scimitar.gain > 0);
  // Nothing listed is already owned, and "soon" rows say which levels they need.
  assert.ok(![...up.ready, ...up.soon].some((r) => owned.has(r.item)));
  for (const r of up.soon) assert.ok(r.needs.length > 0 && r.needs.every((n) => n.level > (levels[n.skill] ?? 1)));
});
