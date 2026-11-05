// Skills that hurt you: heists count once every stage is stolen, and a target whose failures hit harder
// than auto-eat allows for can kill you left running (ThievingActionComponent, FoodComponent.AutoEat).
// Item pages give each source's real chance for you, and order them by what you'd get.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planTraining } from '../engine/advisor.js';
import { createGameData } from '../engine/gamedata.js';
import { idleDanger } from '../engine/idle-danger.js';
import { itemSources } from '../engine/item-sources.js';
import { methodChance } from '../engine/lookup.js';
import { masteryPlan } from '../engine/mastery-plan.js';
import { computeRates } from '../engine/rates.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));
const library = gd.methodByKey.get('Thieving/ForbiddenLibrary');
const FOOD = 'MelvorBase:Glowfin';

// A player with the Fire Wizard outfit and the given Hitpoints level and food.
function withPlayer(hitpoints, { food = FOOD, foodQty = 10_000 } = {}, run) {
  const was = [gd.player, gd.playerBonuses];
  gd.player = {
    toolbelts: {},
    owned: { 'MelvorBase:FireWizardHat': 1, 'MelvorBase:FireWizardRobes': 1, ...(food ? { [food]: foodQty } : {}) },
    levels: { ...at(50), Hitpoints: hitpoints },
    foods: food ? { Thieving: food } : {},
  };
  gd.playerBonuses = [];
  try {
    return run();
  } finally {
    [gd.player, gd.playerBonuses] = was;
  }
}

test('a heist is done once every stage is stolen: the attempts a heist takes are stages / success chance', () => {
  const r = computeRates(gd, library, 50, { bonuses: [] });
  assert.ok(r.successChance < 0.2);
  close(r.completionsPerHour, (r.cyclesPerHour * r.successChance) / library.stages);
  // A plain pickpocket that always works: every attempt counts.
  const citizen = computeRates(gd, gd.methodByKey.get('Thieving/Citizen'), 60, { bonuses: [] });
  close(citizen.completionsPerHour, citizen.cyclesPerHour);
});

test('the guild task to complete 10 heists takes 10 heists, not 10 attempts', () => {
  // Hitpoints 99: auto-eat comes in time, so the task is planned like any other.
  withPlayer(99, {}, () => {
    const save = { skills: {}, mastery: { Thieving: { ThievingTask72: { goalComplete: false, goalProgress: 1, triggerMet: true } } } };
    const task = masteryPlan(gd, save, at(50), { only: 'Thieving' })[0].open.find((t) => t.task.id === 'ThievingTask72');
    const r = computeRates(gd, library, 50);
    assert.equal(task.label, 'Complete 10 Heists in Mage Tower');
    close(task.hours, 9 / r.completionsPerHour);
    assert.ok(task.hours > 1, 'over an hour at about 1 in 9 attempts');
    assert.equal(task.handsOn, undefined);
  });
});

test('a hit bigger than the auto-eat threshold can kill you; the task is left out of the plan and timed by hand', () => {
  withPlayer(51, {}, () => {
    const r = computeRates(gd, library, 50);
    const d = idleDanger(gd, r);
    assert.equal(d.maxHp, 510);
    assert.equal(d.autoEatAt, 128); // 25% of 510 is 127.5, which the game rounds to the even 128
    assert.equal(d.biggestHit, library.damage);
    assert.ok(d.risky && d.hoursToDeath < 0.5, `dies about every ${d.hoursToDeath} h`);
    // 25% of the Hitpoints level × 10 has to reach the biggest hit.
    assert.equal(d.safeLevel, Math.ceil(library.damage / 2.5));
    const save = { skills: {}, mastery: { Thieving: { ThievingTask72: { goalComplete: false, goalProgress: 1, triggerMet: true } } } };
    const plan = masteryPlan(gd, save, at(50), { only: 'Thieving' })[0];
    const task = plan.open.find((t) => t.task.id === 'ThievingTask72');
    assert.equal(task.hours, null);
    assert.equal(task.how.method.key, library.key);
    assert.ok(task.handsOn.risky);
    close(task.handsOnHours, 9 / r.completionsPerHour);
    assert.ok(!plan.plan?.tasks.includes(task));
  });
});

test('a small hit never kills you while auto-eat has food, and with no food anything that hurts does', () => {
  withPlayer(51, {}, () => {
    const citizen = idleDanger(gd, computeRates(gd, gd.methodByKey.get('Thieving/Citizen'), 1));
    assert.equal(citizen.hoursToDeath, Infinity);
    assert.equal(citizen.risky, false);
    // Something that never hurts you has nothing to say.
    assert.equal(idleDanger(gd, computeRates(gd, gd.methodByKey.get('Woodcutting/NormalTree'), 1)), null);
  });
  withPlayer(51, { food: null }, () => {
    const r = computeRates(gd, gd.methodByKey.get('Thieving/Citizen'), 1);
    const d = idleDanger(gd, r);
    assert.equal(d.food, null);
    close(d.hoursToDeath, 510 / r.hpLossPerHour);
  });
  // Out of the picked food: the same as none.
  withPlayer(51, { foodQty: 0 }, () => {
    const d = idleDanger(gd, computeRates(gd, gd.methodByKey.get('Thieving/Citizen'), 1));
    assert.equal(d.food, null);
    assert.equal(d.picked, FOOD);
  });
});

test('item sources: thieving loot only comes on a success, so its chance per attempt includes yours', () => {
  withPlayer(51, {}, () => {
    const circlet = itemSources(gd, 'MelvorBase:CursedCirclet', at(50)).find((s) => s.method?.key === library.key);
    const r = computeRates(gd, library, 50);
    const base = methodChance(library, 'MelvorBase:CursedCirclet');
    close(circlet.chance, base.chance * r.successChance);
    assert.equal(circlet.per, 'attempt');
    close(circlet.perHour, r.outputs.find((o) => o.item === 'MelvorBase:CursedCirclet').perHour);
    assert.ok(circlet.risky);
  });
});

test('item sources: sure ways first, then what you can do now by how many an hour, risky ones after, then the rest', () => {
  withPlayer(51, {}, () => {
    const list = itemSources(gd, 'MelvorBase:BirdNest', at(50));
    const groups = list.map((s) => (s.sure ? 0 : s.doable && !s.risky ? 1 : s.doable ? 2 : 3));
    assert.deepEqual(groups, [...groups].sort((a, b) => a - b));
    // Any tree you can cut gives more nests an hour than the Bandit Woodcutter, which can also kill you.
    const tree = list.findIndex((s) => s.method?.kind === 'woodcutting' && s.doable);
    const bandit = list.findIndex((s) => s.method?.key === 'Thieving/BanditWoodcutter');
    assert.ok(tree >= 0 && bandit > tree);
    assert.ok(list[bandit].risky && list[tree].perHour > list[bandit].perHour);
    // What you can't do yet has no amount an hour and says what it needs.
    const locked = list.find((s) => s.type === 'method' && !s.doable);
    assert.equal(locked.perHour, null);
    assert.ok(locked.missing.length);
    for (const s of list.filter((x) => x.doable)) assert.ok(s.perHour > 0);
  });
});

test('item sources: enemies are rated from the fights you can do', () => {
  const golbin = itemSources(gd, 'MelvorBase:Shrimp', at(1)).find((s) => s.type === 'enemy').enemy;
  const fights = { Melee: { fights: [{ enemy: golbin, result: { killsPerHour: 100, risky: false } }] } };
  const s = itemSources(gd, 'MelvorBase:Shrimp', at(1), { fights }).find((x) => x.enemy?.id === golbin.id);
  assert.ok(s.doable && !s.risky);
  close(s.perHour, 100 * s.qty);
  const none = itemSources(gd, 'MelvorBase:Shrimp', at(1)).find((x) => x.enemy?.id === golbin.id);
  assert.equal(none.perHour, null);
});

test('training plans skip targets that can kill you while they run', () => {
  // At Thieving 70 the Stone Mason gives the most XP; it hits for up to 186, more than auto-eat's 25 HP
  // at Hitpoints 10 but not its 248 at Hitpoints 99.
  const mason = gd.methodByKey.get('Thieving/StoneMason');
  const steps = (hp) => withPlayer(hp, {}, () => planTraining(gd, 'Thieving', at(70), gd.xp.xpForLevel(70), 71).steps.map((s) => s.method.key));
  assert.deepEqual(steps(99), [mason.key]);
  withPlayer(10, {}, () => assert.ok(idleDanger(gd, computeRates(gd, mason, 70)).risky));
  const low = steps(10);
  assert.ok(low.length && !low.includes(mason.key), `picked ${low}`);
});
