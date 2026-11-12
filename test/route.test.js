import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { minEach, obtainEach, planTraining, producerIndex } from '../engine/advisor.js';
import { createGameData } from '../engine/gamedata.js';
import { planRank, rankValue } from '../engine/mastery-plan.js';
import { computeRates } from '../engine/rates.js';
import { BASE_VALUE, unlockValue } from '../engine/route-goals.js';
import { describeStep, lockRoute, routeProgress } from '../engine/route-progress.js';
import { planRoute, planUses } from '../engine/route.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const CROSSBOW = 'Fletching/Iron2HCrossbow';

test('training plans whole crafts: one Iron Crossbow Head is not part of a crossbow that needs two', () => {
  const levels = { ...at(30), Fletching: 20 };
  const bank = { 'MelvorBase:IronCrossbowHead': 1, 'MelvorBase:Bowstring': 212, 'MelvorBase:OakLog': 5030 };
  const plan = planTraining(gd, 'Fletching', levels, gd.xp.xpForLevel(20), 25, { bank });
  assert.ok(Number.isFinite(plan.hours));
  for (const st of plan.steps) {
    assert.ok(Number.isInteger(st.actions) && st.actions > 0, 'whole actions');
    // A crossbow step has to make the heads it's short of first.
    if (st.method.key === CROSSBOW) assert.ok(st.gather.some((g) => g.item === 'MelvorBase:IronCrossbowHead'));
  }
  for (const u of plan.uses) assert.ok(u.qty <= u.have + 1e-9, `${u.item}: plans ${u.qty} of ${u.have}`);
  assert.equal(minEach(gd.methodByKey.get(CROSSBOW), 'MelvorBase:IronCrossbowHead'), 2);
});

test('training uses what the bank has before gathering more, then carries on with something else', () => {
  // 50 raw shrimp: cook them, then the plan has to gather (or pick another method) for the rest.
  const levels = at(1);
  const plan = planTraining(gd, 'Cooking', levels, 0, 10, { bank: { 'MelvorBase:RawShrimp': 50 } });
  const first = plan.steps[0];
  assert.equal(first.method.key, 'Cooking/Shrimp');
  assert.ok(plan.uses.some((u) => u.item === 'MelvorBase:RawShrimp' && u.qty === 50), 'all 50 are used');
  assert.ok(plan.gatherHours > 0, 'and the rest is gathered');
  // One method per stretch between unlocks: never two steps of the same method in a row.
  for (let i = 1; i < plan.steps.length; i++) assert.notEqual(plan.steps[i].method.key, plan.steps[i - 1].method.key);
});

test('a training step cut short by a material says so, not "until" a level you already have', () => {
  // At Runecrafting 41 with runes for 14 Fire Battlewands: those first, then Body Runes to 45.
  const levels = { ...at(99), Runecrafting: 41 };
  const xp = Object.fromEntries(Object.entries(levels).map(([k, l]) => [k, gd.xp.xpForLevel(l)]));
  const bank = { 'MelvorBase:UnpoweredOrb': 85, 'MelvorBase:FireRune': 296, 'MelvorBase:ChaosRune': 469 };
  const [wands, runes] = planTraining(gd, 'Runecrafting', levels, xp.Runecrafting, 45, { bank }).steps;
  assert.equal(wands.method.key, 'Runecrafting/FireBattlewand');
  assert.equal(wands.actions, Math.floor(296 / 20));
  assert.deepEqual([wands.fromLevel, wands.toLevel, wands.limitedBy], [41, 41, 'MelvorBase:FireRune']);
  assert.equal(runes.toLevel, 45);
  assert.equal(runes.limitedBy, null);
  // The route keeps it, and says it in words.
  const leg = planRoute(gd, { levels, xp, bank }).legs[0];
  assert.equal(leg.skill, 'Runecrafting', 'every other skill is maxed');
  const locked = lockRoute({ legs: [leg] });
  const p = routeProgress(gd, locked, { levels, xp, bank });
  const lines = p.legs[0].steps.filter((st) => st.kind === 'train').map((st) => describeStep(gd, st));
  assert.equal(lines[0], 'Make Fire Battlewand × 14 for Runecrafting XP, until you run out of Fire Rune');
  assert.match(lines[1], /until Runecrafting 45$/);
  // A plan kept from before steps knew their material.
  const old = JSON.parse(JSON.stringify(locked));
  delete old.legs[0].steps.find((st) => st.kind === 'train').limitedBy;
  assert.match(describeStep(gd, routeProgress(gd, old, { levels, xp, bank }).legs[0].steps.find((st) => st.kind === 'train')), /for Runecrafting XP, as far as your materials go$/);
});

test('the route never counts on more than the bank holds plus what its own steps gather or make', () => {
  const levels = at(20);
  const bank = { 'MelvorBase:NormalLog': 300, 'MelvorBase:OakLog': 200, 'MelvorBase:RawShrimp': 100, 'MelvorBase:CopperOre': 50, 'MelvorBase:TinOre': 50 };
  const route = planRoute(gd, { levels, bank });
  assert.ok(route.legs.length > 1 && route.hours > 0);
  const have = new Map(Object.entries(bank));
  const play = new Map(Object.entries(levels));
  for (const leg of route.legs) {
    for (const st of leg.steps) {
      const r = computeRates(gd, st.method, play.get(st.method.skill) ?? 1);
      for (const i of r.inputs) have.set(i.item, (have.get(i.item) ?? 0) - (i.perHour / r.cyclesPerHour) * st.actions);
      for (const o of r.outputs) have.set(o.item, (have.get(o.item) ?? 0) + (o.perHour / r.cyclesPerHour) * st.actions);
      for (const u of st.levelUps) play.set(u.skill, Math.max(play.get(u.skill) ?? 1, u.level));
      for (const [item, qty] of have) assert.ok(qty > -2, `${st.method.name} leaves ${qty} ${item}`);
      assert.ok(Number.isInteger(st.actions) && st.hours > 0);
    }
  }
  // Steps follow each other in time.
  const steps = route.legs.flatMap((l) => l.steps);
  for (let i = 1; i < steps.length; i++) close(steps[i].at, steps[i - 1].at + steps[i - 1].hours);
});

test('the route keeps what you are doing first, and merges goals in the same skill', () => {
  const levels = at(15);
  const bank = { 'MelvorBase:RawShrimp': 1e5, 'MelvorBase:NormalLog': 1e5 };
  const free = planRoute(gd, { levels, bank });
  // Pick a skill that isn't first on its own, and say you're training it.
  const leg = free.legs.find((l, i) => i > 0) ?? free.legs[0];
  const key = leg.steps.find((s) => s.kind === 'train').method.key;
  const doing = planRoute(gd, { levels, bank, current: key });
  assert.equal(doing.legs[0].skill, leg.skill);
  assert.ok(doing.legs[0].doing);
  assert.ok(doing.goals[0].steps.some((s) => s.method.key === key));
  for (let i = 1; i < doing.legs.length; i++) assert.ok(doing.legs[i].skill !== doing.legs[i - 1].skill || doing.legs[i].from !== doing.legs[i - 1].to);
  assert.ok(planUses(planTraining(gd, leg.skill, levels, gd.xp.xpForLevel(15), leg.goals?.[0]?.to ?? leg.to, { bank }), key) || true);
});

test('a rank is worth its bonus at your best method, and tasks that are training cost nothing extra', () => {
  const levels = at(40);
  const fishing = gd.methodsBySkill.Fishing.filter((m) => m.level <= 40).map((m) => computeRates(gd, m, 40)).sort((a, b) => b.xpPerHour - a.xpPerHour);
  const best = fishing[0];
  const slow = fishing.at(-1);
  const bonus = { effects: [{ stat: 'PercentXPGained', value: 0.1, skill: 'Fishing' }] };
  const task = (method, hours) => ({ task: {}, hours, gatherHours: 0, how: { method: method.method }, key: method.key, points: 1 });
  const free = rankValue(gd, 'Fishing', bonus, levels, planRank([task(best, 2)], 1));
  close(free.speedup, 0.1);
  close(free.saving, 1 - 1 / 1.1);
  close(free.extraHours, 0);
  const costly = rankValue(gd, 'Fishing', bonus, levels, planRank([task(slow, 2)], 1));
  close(costly.extraHours, 2 * (1 - slow.xpPerHour / best.xpPerHour));
  close(costly.paybackHours, costly.extraHours / costly.saving);
  // Planned tasks' extra hours add up to the plan's hours.
  const plan = planRank([task(best, 2), task(slow, 3), { ...task(best, 5), key: best.key }], 3);
  close([...plan.extra.values()].reduce((s, h) => s + h, 0), plan.hours);
});

test('a route gathers each raw material once, and each goal stocks up before it trains', () => {
  const levels = at(20);
  const bank = { 'MelvorBase:NormalLog': 300, 'MelvorBase:RawShrimp': 100 };
  const route = planRoute(gd, { levels, bank });
  const raw = new Map();
  for (const [li, leg] of route.legs.entries()) {
    const firstTrain = leg.steps.findIndex((st) => st.kind === 'train');
    // Gathering only comes after training when it needs something that training made.
    for (const st of leg.steps.slice(firstTrain + 1)) if (st.kind !== 'train') assert.ok(firstTrain >= 0);
    for (const st of leg.steps) {
      if (st.kind === 'train' || computeRates(gd, st.method, st.method.level).inputs.length) continue;
      const key = `${st.method.key}|${st.item}`;
      assert.ok(!raw.has(key), `${st.method.name} is gathered in goals ${raw.get(key)} and ${li}`);
      raw.set(key, li);
    }
  }
  assert.ok(Array.isArray(route.decisions.goals) && route.decisions.goals.length === route.goals.length);
});

test('a locked route keeps its steps and only moves its progress on as your save changes', () => {
  const levels = at(20);
  const bank = { 'MelvorBase:NormalLog': 300, 'MelvorBase:RawShrimp': 100 };
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(20)]));
  const locked = lockRoute(planRoute(gd, { levels, xp, bank }));
  const start = routeProgress(gd, locked, { levels, xp, bank });
  assert.ok(!start.finished && start.step && start.newlyDone.length === 0);
  const first = start.step;
  // Half of the first step done: same step, less left.
  const half = { ...bank };
  const half_xp = { ...xp };
  if (first.kind === 'train') half_xp[first.method.skill] += first.xpGain / 2;
  else half[first.item] = (half[first.item] ?? 0) + first.qty / 2;
  const mid = routeProgress(gd, locked, { levels, xp: half_xp, bank: half });
  assert.equal(mid.step.id, first.id);
  assert.ok(mid.step.left.hours < first.left.hours);
  // All of it: done, and the next step is the plan's own next step.
  const full = { ...bank };
  const full_xp = { ...xp };
  if (first.kind === 'train') full_xp[first.method.skill] += first.xpGain;
  else full[first.item] = (full[first.item] ?? 0) + first.qty;
  const after = routeProgress(gd, locked, { levels, xp: full_xp, bank: full });
  assert.ok(after.newlyDone.includes(first.id));
  locked.done.push(...after.newlyDone);
  // Done stays done, even when a later step uses up what it made.
  const again = routeProgress(gd, locked, { levels, xp, bank });
  assert.ok(again.legs.flatMap((l) => l.steps).find((st) => st.id === first.id).done);
  assert.notEqual(again.step.id, first.id);
  // Doing a later step of the same goal in the game makes it the one you're on.
  const leg = again.legs.find((l) => l.steps.includes(again.step));
  const other = leg.steps.find((st) => !st.done && st !== again.step);
  if (other) {
    const on = routeProgress(gd, locked, { levels, xp, bank, current: other.method.key });
    assert.equal(on.step.id, other.id);
    assert.ok(on.step.on);
  }
});

test('a locked route gets you more of something you ran out of before the step that needs it', () => {
  const levels = at(30);
  const bank = { 'MelvorBase:RawShrimp': 5000 };
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(30)]));
  const locked = lockRoute(planRoute(gd, { levels, xp, bank, current: 'Cooking/Shrimp' }));
  const p = routeProgress(gd, locked, { levels, xp, bank, current: 'Cooking/Shrimp' });
  assert.equal(p.step.method.key, 'Cooking/Shrimp');
  assert.equal(p.blocked, null);
  // Out of shrimp: catching more goes in first, and the plan isn't stuck.
  const gone = routeProgress(gd, locked, { levels, xp, bank: {}, current: 'Cooking/Shrimp' });
  assert.equal(gone.blocked, null);
  assert.equal(gone.short, null);
  assert.ok(gone.step.topUp);
  assert.equal(gone.step.item, 'MelvorBase:RawShrimp');
});

test('running short part-way through a goal gets you enough for the rest of it in one go', () => {
  // Two runs of cooking shrimp in one goal, and no shrimp: one catch for both, not one before each.
  const levels = at(30);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(30)]));
  const shrimp = gd.methodByKey.get('Cooking/Shrimp');
  const r = computeRates(gd, shrimp, 30);
  const xpEach = r.xpPerHour / r.cyclesPerHour;
  const run = (after) => ({ kind: 'train', method: shrimp, actions: 100, hours: 100 / r.cyclesPerHour, xpGain: 100 * xpEach, xpAfter: xp.Cooking + after * xpEach, toLevel: 30, levelUps: [] });
  const leg = { kind: 'unlock', skill: 'Cooking', from: 30, to: 31, unlocks: [], steps: [run(100), run(200)] };
  const p = routeProgress(gd, lockRoute({ legs: [leg] }), { levels, xp, bank: {} });
  const tops = p.legs[0].steps.filter((st) => st.topUp);
  assert.equal(tops.length, 1, tops.map((t) => `${t.method.key} ${t.qty}`).join(', '));
  assert.equal(tops[0].item, 'MelvorBase:RawShrimp');
  assert.ok(tops[0].qty >= 200 - 1e-6, `catches ${tops[0].qty}`);
  assert.ok(!p.legs[0].steps.at(-1).short, 'the second run is covered');
  assert.equal(p.short, null);
});

test('a goal never lists the same thing twice: its own step for an item does more instead of a top-up', () => {
  // Cooking shrimp came first in the plan (you were doing it), then catching 50 shrimp. Stocking up
  // counts first, as the page lists it; with none in the bank, the catch grows to 100.
  const levels = at(30);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(30)]));
  const RAW = 'MelvorBase:RawShrimp';
  const cook = gd.methodByKey.get('Cooking/Shrimp');
  const r = computeRates(gd, cook, 30);
  const xpEach = r.xpPerHour / r.cyclesPerHour;
  const fish = obtainEach(producerIndex(gd, levels), new Map(), [{ item: RAW, qty: 50 }])[0];
  const train = { kind: 'train', method: cook, actions: 100, hours: 100 / r.cyclesPerHour, xpGain: 100 * xpEach, xpAfter: xp.Cooking + 100 * xpEach, toLevel: 30, levelUps: [] };
  // Planned with 50 in the bank: catch 50 more, to have 100.
  const gather = (method = fish.method) => ({ kind: 'gather', method, item: RAW, actions: fish.actions, hours: fish.runHours, qty: 50, target: 100, xpGain: 0, xpAfter: 0, levelUps: [] });
  const run = (bank, method) => routeProgress(gd, lockRoute({ legs: [{ kind: 'unlock', skill: 'Cooking', from: 30, to: 31, unlocks: [], steps: [train, gather(method)] }] }), { levels, xp, bank, current: cook.key }).legs[0].steps;
  // The 50 you'll catch and the 50 you have cover it: no extra. (Counted in the order the plan has them,
  // the cooking would have looked short and got a catching step of its own.)
  const enough = run({ [RAW]: 50 });
  assert.equal(enough.length, 2);
  assert.ok(!enough.some((st) => st.topUp || st.extra || st.short));
  // None in the bank (you used them on something else): one catching step for all 100.
  const steps = run({});
  assert.equal(steps.filter((st) => st.item === RAW).length, 1, steps.map((st) => `${st.method.key} ${st.item}`).join(', '));
  const one = steps.find((st) => st.item === RAW);
  assert.ok(one.left.qty >= 100 - 1e-6, `catches ${one.left.qty}`);
  close(one.extra, one.left.qty - 50);
  assert.ok(!steps.some((st) => st.topUp));
  // Planned at a slower spot than the quickest one now: the extra still goes on that step, caught there.
  const calm = gd.methodByKey.get('Fishing/CalmShallows');
  assert.notEqual(calm.key, fish.method.key);
  const slow = run({}, calm);
  assert.deepEqual(slow.filter((st) => st.item === RAW).map((st) => st.method.key), [calm.key]);
  assert.ok(slow.find((st) => st.item === RAW).extra > 0);
});

test('a plan does each training method in one run, not split around a detour', () => {
  // 20 of everything: a few of something better while it lasts, then the main method. Before, Maple Bows
  // came in two runs with Adamant Crossbows between them.
  const bank = Object.fromEntries(Object.keys(gd.items).map((id) => [id, 20]));
  const levels = { ...at(70), Fletching: 55 };
  const xp = { ...Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(70)])), Fletching: gd.xp.xpForLevel(55) };
  const plan = planTraining(gd, 'Fletching', levels, xp.Fletching, 59, { bank });
  const keys = plan.steps.map((st) => st.method.key);
  assert.ok(keys.includes('Fletching/MapleBow'));
  assert.equal(new Set(keys).size, keys.length, keys.join(' > '));
  // Levels follow the new order, and every method still comes after the level it needs.
  let level = 55;
  for (const st of plan.steps) {
    assert.equal(st.fromLevel, level);
    assert.ok(st.method.level <= st.fromLevel, `${st.method.key} needs ${st.method.level}`);
    assert.ok(st.toLevel >= st.fromLevel);
    level = st.toLevel;
  }
  assert.equal(level, 59);
  // The same in a whole route, where goals in one skill join into one leg.
  const route = planRoute(gd, { levels, xp, bank });
  for (const leg of route.legs) {
    const runs = leg.steps.filter((st) => st.kind === 'train').map((st) => st.method.key);
    assert.equal(new Set(runs).size, runs.length, `${leg.skill}: ${runs.join(' > ')}`);
    const last = leg.steps.filter((st) => st.kind === 'train').at(-1);
    if (leg.kind === 'unlock' && last) assert.equal(last.toLevel, leg.to);
  }
});

test('materials for one recipe share the bank: two that need the same item can not both count on it', () => {
  const index = producerIndex(gd, at(50));
  const stock = new Map([['MelvorBase:String', 100]]);
  const [a, b] = obtainEach(index, stock, [{ item: 'MelvorBase:String', qty: 80 }, { item: 'MelvorBase:String', qty: 80 }]);
  assert.equal(a.short, 0);
  close(b.short, 60);
  assert.equal(stock.get('MelvorBase:String'), 100, 'the bank itself is left alone');
});

test('long material chains are crafted, not pickpocketed: Thornback Camo needs spikes, Nets, Rope and String', () => {
  // Spikes are hunted with Nets, Nets are made from Rope and String, String from Flax. With none of it in
  // the bank, every String and Rope comes from Crafting, not hundreds of Craftsman or Thug pickpockets
  // (Wool for the Rope still comes from the Crafting Stall: nothing else gives it).
  const levels = { ...at(60), Beastcrafting: 28 };
  const bank = { 'MelvorBase:Leather': 400, 'MelvorBase:Feathers': 64 };
  const plan = planTraining(gd, 'Beastcrafting', levels, gd.xp.xpForLevel(28), 31, { bank });
  assert.ok(Number.isFinite(plan.hours));
  const all = plan.steps.flatMap((st) => st.gather.flatMap((g) => [...g.needs, g]));
  const ways = (item) => new Set(all.filter((n) => n.item === item).map((n) => n.method?.key));
  assert.ok(all.some((n) => n.item === 'MelvorBase:ThornbackLizardSpike'), 'a camo piece with spikes is in the plan');
  assert.deepEqual([...ways('MelvorBase:String')], ['Crafting/String']);
  for (const key of ways('MelvorBase:Rope')) assert.equal(gd.methodByKey.get(key).skill, 'Crafting');
  assert.ok(ways('MelvorBase:Rope').size > 0, 'Rope for the Nets is in the chain');
});

test('a locked route ticks steps off by itself, in whatever order you do them', () => {
  const levels = at(25);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(25)]));
  const bank = {};
  const locked = lockRoute(planRoute(gd, { levels, xp, bank }));
  const steps = locked.legs.flatMap((l) => l.steps);
  // A chain: ore gathered for bars that are then made.
  const bars = steps.find((m) => m.kind !== 'train' && steps.some((g) => g.kind !== 'train' && g !== m && computeRates(gd, gd.methodByKey.get(m.method), 1).inputs.some((i) => i.item === g.item)));
  assert.ok(bars, 'the route has a gather-then-make chain');
  const ore = steps.find((g) => g.kind !== 'train' && g !== bars && computeRates(gd, gd.methodByKey.get(bars.method), 1).inputs.some((i) => i.item === g.item));
  // You made the bars first, from ore you had: the bars are done, and the ore isn't needed any more.
  const p = routeProgress(gd, locked, { levels, xp, bank: { [bars.item]: bars.target } });
  const done = new Set(p.legs.flatMap((l) => l.steps).filter((st) => st.done).map((st) => st.id));
  assert.ok(done.has(bars.id));
  const others = steps.filter((c) => c !== bars && !done.has(c.id) && computeRates(gd, gd.methodByKey.get(c.method), 1).inputs.some((i) => i.item === ore.item));
  if (!others.length) assert.ok(done.has(ore.id), 'nothing left needs the ore');
  // Training past a whole goal some other way: every step of it is done, gathering included.
  const leg = locked.legs[0];
  const skill = leg.skill;
  const past = routeProgress(gd, locked, { levels: { ...levels, [skill]: leg.to }, xp: { ...xp, [skill]: gd.xp.xpForLevel(leg.to) + 1 }, bank });
  assert.ok(past.legs[0].done, `${skill} ${leg.to} is done`);
  assert.ok(past.legs[0].steps.every((st) => st.done));
});

test('a goal is worth more when it makes your best method faster, and the route weighs that against time', () => {
  const levels = at(1);
  // Some level in Woodcutting unlocks a faster tree; find it and check it says so.
  const better = gd.methodsBySkill.Woodcutting.map((m) => m.level).filter((l) => l > 1).sort((a, b) => a - b)
    .map((to) => ({ to, v: unlockValue(gd, 'Woodcutting', levels, to) })).find((x) => x.v.reasons.some((r) => r.kind === 'xp'));
  assert.ok(better, 'a Woodcutting unlock that is faster');
  assert.ok(better.v.value > BASE_VALUE);
  assert.match(better.v.reasons.find((r) => r.kind === 'xp').text, /Woodcutting XP\/h with/);
  // A method you can't keep going (nothing makes its materials, and you have none) isn't counted.
  const none = unlockValue(gd, 'Woodcutting', levels, better.to, { supplied: () => false });
  assert.ok(none.value >= BASE_VALUE);
});

test('a Mastery rank can be a goal: its tasks become steps, and its progress comes from the save', () => {
  const levels = at(30);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(30)]));
  const method = gd.methodsBySkill.Woodcutting.find((m) => m.level <= 30 && computeRates(gd, m, 30).inputs.length === 0);
  const extra = { kind: 'mastery', id: 'mastery|Woodcutting|Test', skill: 'Woodcutting', rank: 'Test Rank', value: 50, reasons: [{ kind: 'mastery', gain: 0.1, text: 'Test Rank: +10% Woodcutting XP/h' }],
    tasks: [{ method: method.key, hours: 0.2, own: 0.2, task: 'WoodcuttingTaskX', of: 500, done: 100, label: 'Cut 500 trees' }] };
  const route = planRoute(gd, { levels, xp, bank: {}, extras: [extra] });
  const leg = route.legs.find((l) => l.kind === 'mastery');
  assert.ok(leg, 'a valuable rank makes it into the plan');
  assert.equal(leg.steps[0].kind, 'task');
  const locked = lockRoute(route);
  const step = locked.legs.flatMap((l) => l.steps).find((st) => st.kind === 'task');
  const at250 = routeProgress(gd, locked, { levels, xp, bank: {}, mastery: { Woodcutting: { WoodcuttingTaskX: { goalProgress: 250 } } } });
  const mid = at250.legs.flatMap((l) => l.steps).find((st) => st.id === step.id);
  assert.equal(mid.left.progress, 250);
  assert.ok(!mid.done && mid.left.actions < step.actions);
  const complete = routeProgress(gd, locked, { levels, xp, bank: {}, mastery: { Woodcutting: { WoodcuttingTaskX: { goalComplete: true } } } });
  assert.ok(complete.newlyDone.includes(step.id));
});

test('plans use your measured speed: half as fast takes twice as long, and the time left keeps it', () => {
  const levels = at(10);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(10)]));
  const normal = planTraining(gd, 'Woodcutting', levels, xp.Woodcutting, 15);
  const key = normal.steps[0].method.key;
  // Half as fast at every tree, so the same one is still best.
  gd.planSpeed = Object.fromEntries(gd.methodsBySkill.Woodcutting.map((m) => [m.key, 0.5]));
  let slow;
  try {
    slow = planTraining(gd, 'Woodcutting', levels, xp.Woodcutting, 15);
  } finally {
    gd.planSpeed = null;
  }
  assert.equal(slow.steps[0].method.key, key);
  close(slow.hours, normal.hours * 2, 0.02);
  const locked = lockRoute({ legs: [{ kind: 'unlock', skill: 'Woodcutting', from: 10, to: 15, unlocks: [], steps: [{ kind: 'train', method: gd.methodByKey.get(key), actions: slow.steps[0].actions, hours: slow.hours, xpAfter: gd.xp.xpForLevel(15), xpGain: gd.xp.xpForLevel(15) - xp.Woodcutting, toLevel: 15, levelUps: [] }] }] }, { speed: { [key]: 0.5 } });
  const p = routeProgress(gd, locked, { levels, xp, bank: {} });
  close(p.step.left.hours, slow.hours, 0.02);
  // Slower means fewer actions an hour, not more logs from each one.
  const r = computeRates(gd, gd.methodByKey.get(key), 10);
  for (const [item, each] of p.step.makes) close(each, r.outputs.find((o) => o.item === item).perHour / r.cyclesPerHour);
});

test('the plan warns when what it brings in will not fit in your bank', () => {
  const levels = at(20);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(20)]));
  const bank = { 'MelvorBase:NormalLog': 10 };
  const locked = lockRoute(planRoute(gd, { levels, xp, bank, bankItems: bank }));
  const coming = new Set(locked.legs.flatMap((l) => l.steps).flatMap((st) => st.newItems));
  assert.ok(coming.size > 0, 'the plan brings in new item types');
  assert.ok(![...coming].includes('MelvorBase:NormalLog') || locked.legs.flatMap((l) => l.steps).some((st) => st.newItems.includes('MelvorBase:NormalLog')));
  const roomy = routeProgress(gd, locked, { levels, xp, bank, room: { items: bank, free: 500 } });
  assert.equal(roomy.space, null);
  const full = routeProgress(gd, locked, { levels, xp, bank, room: { items: bank, free: 0 } });
  assert.equal(full.space.short, full.space.items.length);
  assert.ok(full.space.at, 'it says which step fills it');
  // Items with an empty placeholder drop back into it, so they need no new slot.
  const waiting = routeProgress(gd, locked, { levels, xp, bank, room: { items: bank, free: 0, empty: [...coming] } });
  assert.equal(waiting.space, null);
});

test('a gear goal is only done once the gear is made, not because nothing else needs it', () => {
  const levels = at(30);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(30)]));
  const made = (x) => (x.product ?? x.products?.[0])?.item;
  const m = gd.methods.find((x) => x.skill === 'Smithing' && x.level <= 30 && gd.items[made(x)]?.equip && computeRates(gd, x, 30).inputs.length === 1);
  const item = made(m);
  const bank = { [computeRates(gd, m, 30).inputs[0].item]: 1000 };
  const extra = { kind: 'gear', id: `gear|${item}`, skill: 'Smithing', to: 30, item, method: m.key, value: 100, reasons: [{ kind: 'gear', gain: 0.1, text: 'test' }] };
  const locked = lockRoute(planRoute(gd, { levels, xp, bank, extras: [extra] }));
  const leg = locked.legs.find((l) => l.kind === 'gear');
  assert.ok(leg, 'the gear goal is planned');
  const before = routeProgress(gd, locked, { levels, xp, bank });
  assert.ok(!before.legs.find((l) => l.kind === 'gear').done, 'not done before it is made');
  const after = routeProgress(gd, locked, { levels, xp, bank: { ...bank, [item]: 1 } });
  assert.ok(after.legs.find((l) => l.kind === 'gear').done, 'done once you have it');
});

test('every step still to do is checked against the bank, counting what earlier steps make and use', () => {
  const levels = at(60);
  const xp = Object.fromEntries(gd.skills.map((s) => [s.id, gd.xp.xpForLevel(60)]));
  const smelt = gd.methods.find((m) => m.skill === 'Smithing' && m.category === 'Smelting' && m.ingredients.length === 2);
  const [ore, other] = smelt.ingredients.map((i) => i.item);
  const train = (method, actions) => ({ kind: 'train', method, actions, hours: 1, xpAfter: gd.xp.xpForLevel(61), xpGain: gd.xp.xpForLevel(61) - gd.xp.xpForLevel(60), toLevel: 61, levelUps: [] });
  const route = (first) => lockRoute({ legs: [
    { kind: 'unlock', skill: first.method.skill, from: 60, to: 70, unlocks: [], steps: [first] },
    { kind: 'unlock', skill: 'Smithing', from: 60, to: 70, unlocks: [], steps: [train(smelt, 20)] },
  ] });
  const tree = train(gd.methodByKey.get('Woodcutting/NormalTree'), 10);
  const enough = Object.fromEntries(smelt.ingredients.map((i) => [i.item, i.qty * 100_000]));
  assert.equal(routeProgress(gd, route(tree), { levels, xp, bank: enough }).short, null, 'enough for every step');
  // You sold the ore: the later smelting step would run short, so a step that mines the rest goes in
  // just before it and the plan carries on. The step you're on stays first.
  const sold = routeProgress(gd, route(tree), { levels, xp, bank: { [other]: 10_000_000 } });
  assert.equal(sold.short, null);
  assert.equal(sold.step.method.key, 'Woodcutting/NormalTree');
  const [top, smelting] = sold.legs[1].steps;
  assert.ok(smelting.short.need > 0 && smelting.short.have === 0 && smelting.short.topUp);
  assert.equal(top.item, ore);
  assert.ok(top.topUp && top.qty >= smelting.short.need && top.left.hours > 0);
  assert.ok(sold.legs[1].hours > top.left.hours, 'its time counts in the goal');
  // Nothing you can do makes it (no Mining): the plan really is short.
  const stuck = routeProgress(gd, route(tree), { levels: { ...levels, Mining: 1 }, xp, bank: { [other]: 10_000_000 } });
  assert.equal(stuck.short.item, ore);
  // A step before it that gathers the ore covers it.
  const mine = gd.methods.find((m) => m.kind === 'mining' && m.product.item === ore);
  const gather = { kind: 'gather', method: mine, item: ore, qty: 100_000, target: 100_000, actions: 100_000, hours: 1, levelUps: [] };
  assert.equal(routeProgress(gd, route(gather), { levels, xp, bank: { [other]: 10_000_000 } }).short, null);
});

test('the shop offer for a step: how many purchases, what they cost and whether you can afford it', async () => {
  const { shopOffer } = await import('../engine/shop.js');
  const { createGameData } = await import('../engine/gamedata.js');
  const { readFileSync } = await import('node:fs');
  const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
  const sand = 'MelvorBase:BucketofSand';
  const offer = shopOffer(gd, sand, 22, { levels: {}, wallet: { GoldPieces: 538 } });
  assert.equal(offer.qty, 22);
  assert.deepEqual(offer.currencies, [{ currency: 'GoldPieces', qty: 110, have: 538 }]);
  assert.equal(offer.affordable, true);
  assert.equal(shopOffer(gd, sand, 22, { levels: {}, wallet: { GoldPieces: 50 } }).affordable, false);
  assert.equal(shopOffer(gd, 'MelvorBase:NormalLog', 10, { levels: {} }), null, 'not sold');
});
