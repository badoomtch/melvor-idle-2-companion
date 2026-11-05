import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bankInsights, bestMoney, currentActivity, obtain, planTraining, producerIndex, rankSkill, simulate, trainNext } from '../engine/advisor.js';
import { buildEnemy, buildPlayer, fight, hitChance, ownedEquipment, recommendStyle, resistance } from '../engine/combat.js';
import { createGameData, playerBonuses } from '../engine/gamedata.js';
import { completionStatus, quickestSource } from '../engine/completion.js';
import { conditionMet, masteryStatus } from '../engine/mastery.js';
import { planAway } from '../engine/planner.js';
import { expectedActions, ratesWithBonuses } from '../engine/shop.js';
import { slayerCoinsPerKill, slayerOverview, slayerXpPerKill, taskLength } from '../engine/slayer.js';
import { dropChance, enemyLoot, itemDetails, methodChance, search, triesFor } from '../engine/lookup.js';
import { computeRates, cookingSuccessChance, expectTable, miningExpectedHits, thievingSuccessChance } from '../engine/rates.js';
import { defaultXpTable } from '../engine/xp.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const method = (key) => gd.methodByKey.get(key) ?? assert.fail(`missing method ${key}`);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);

test('experience curve matches the game', () => {
  assert.equal(defaultXpTable.xpForLevel(1), 0);
  assert.equal(defaultXpTable.xpForLevel(2), 83);
  assert.equal(defaultXpTable.xpForLevel(10), 1154);
  assert.equal(defaultXpTable.xpForLevel(60), 273740);
  assert.equal(defaultXpTable.xpForLevel(99), 13034427);
  assert.equal(defaultXpTable.levelForXp(82), 1);
  assert.equal(defaultXpTable.levelForXp(83), 2);
  assert.equal(defaultXpTable.levelForXp(1e9, 60), 60);
  for (let level = 1; level <= 120; level++) {
    assert.equal(defaultXpTable.levelForXp(defaultXpTable.xpForLevel(level)), level);
    if (level > 1) assert.equal(defaultXpTable.levelForXp(defaultXpTable.xpForLevel(level) - 1), level - 1);
  }
});

test('mining expected hits follows the break-or-progress rule', () => {
  close(miningExpectedHits(0.4), 1.96);
  close(miningExpectedHits(0.5), 1.5);
  assert.equal(miningExpectedHits(1), 1);
  assert.equal(miningExpectedHits(0), Infinity);
});

test('success chances use the game formulas', () => {
  const citizen = method('Thieving/Citizen');
  close(thievingSuccessChance(gd, citizen, 1), 101 / (100 + citizen.perception));
  assert.equal(thievingSuccessChance(gd, citizen, 60), 1);
  const shrimp = method('Cooking/Shrimp');
  close(cookingSuccessChance(gd, shrimp, 1), 70 / (69 + shrimp.difficulty));
});

test('woodcutting needs MaxHealth hits per log', () => {
  const r = computeRates(gd, method('Woodcutting/NormalTree'), 1);
  close(r.xpPerHour, 3600);
  close(r.cyclesPerHour, 1200);
});

test('thieving charges food for damage taken', () => {
  const m = method('Thieving/Citizen');
  const r = computeRates(gd, m, 1);
  const s = thievingSuccessChance(gd, m, 1);
  close(r.msPerCycle, m.interval + (1 - s) * gd.mechanics.thievingStunMs);
  assert.ok(r.food && r.food.value > 0);
  close(r.profitPerHour, r.grossPerHour - r.costPerHour);
  assert.equal(computeRates(gd, m, 60).hpLossPerHour, 0);
});

test('weighted drop tables sum to one roll', () => {
  const t = expectTable([{ item: 'a', min: 1, max: 1, weight: 3 }, { item: 'b', min: 2, max: 4, weight: 1 }]);
  close(t.reduce((s, x) => s + x.chance, 0), 1);
  close(t.find((x) => x.item === 'b').qty, 0.75);
});

test('rankings are sorted and respect level requirements', () => {
  const ranked = rankSkill(gd, 'Woodcutting', { Woodcutting: 15 });
  assert.ok(ranked.available.every((x) => x.method.level <= 15));
  for (let i = 1; i < ranked.available.length; i++) assert.ok(ranked.available[i - 1].rates.xpPerHour >= ranked.available[i].rates.xpPerHour);
  assert.ok(ranked.upcoming.every((x) => x.method.level > 15));

  const money = bestMoney(gd, Object.fromEntries(gd.trainableSkills.map((s) => [s, 30])));
  for (let i = 1; i < money.selfSufficient.length; i++) assert.ok(money.selfSufficient[i - 1].rates.profitPerHour >= money.selfSufficient[i].rates.profitPerHour);
  assert.ok(money.selfSufficient.every((x) => x.rates.inputs.length === 0));
});

test('methods needing gear the save cannot confirm are never ranked as best', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, gd.levelCap]));
  const money = bestMoney(gd, levels, { limit: 1000 });
  const ranked = [...money.selfSufficient, ...money.crafting, ...money.passive];
  assert.ok(ranked.every((x) => !x.conditional && x.unknown.length === 0));
  assert.ok(money.conditional.every((x) => x.unknown.length > 0));
  for (const skill of gd.trainableSkills) {
    const best = rankSkill(gd, skill, levels).best;
    if (best) assert.equal(best.unknown.length, 0, skill);
  }
});

test('train-next finds reachable unlocks', () => {
  const plan = trainNext(gd, Object.fromEntries(gd.trainableSkills.map((s) => [s, 10])));
  assert.ok(plan.quickWins.length > 0);
  for (const row of plan.quickWins) assert.ok(row.next.level > row.level && row.next.hours > 0);
});

test('training plans only count on materials in the bank', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 1]));
  const raw = method('Cooking/Shrimp').ingredients[0].item;

  const assumed = planTraining(gd, 'Cooking', levels, 0, 5);
  assert.ok(Number.isFinite(assumed.hours) && assumed.gatherHours === 0, 'no bank: materials assumed');

  const empty = planTraining(gd, 'Cooking', levels, 0, 5, { bank: {} });
  assert.ok(empty.gatherHours > 0 && empty.hours > assumed.hours, 'empty bank: gathering time added');
  assert.ok(empty.gather.length > 0 && empty.gather.every((g) => g.method && g.qty > 0));

  const stocked = planTraining(gd, 'Cooking', levels, 0, 5, { bank: { [raw]: 100_000 } });
  assert.equal(stocked.gatherHours, 0);
  assert.ok(stocked.uses.some((u) => u.item === raw && u.qty > 0 && u.have === 100_000));
  assert.equal(stocked.steps[0].method.key, 'Cooking/Shrimp');

  const plan = trainNext(gd, levels, {}, { bank: {} });
  const cooking = plan.rows.find((r) => r.skill === 'Cooking');
  assert.ok(cooking.next.plan.gatherHours > 0, 'what-next times include gathering');
});

test('toolbelt requirements are confirmed from the save, and used-up tools cost materials', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 99]));
  const chest = method('Thieving/LockedThugChest');
  const star = method('Mining/GoldenFallenStar');
  const wizard = method('Thieving/Wizard');
  try {
    gd.player = null;
    assert.equal(gd.checkRequirements(chest, levels).unknown.length, 1, 'no save: unconfirmed');

    // Lockpick equipped: confirmed, and one lockpick goes per attempt.
    gd.player = { toolbelts: { Thieving: [{ item: 'MelvorBase:Lockpick', qty: 15 }] }, owned: { 'MelvorBase:Lockpick': 15 } };
    let req = gd.checkRequirements(chest, levels);
    assert.ok(req.ok && !req.unknown.length && !req.equip.length);
    const r = computeRates(gd, chest, 99);
    close(r.inputs.find((i) => i.item === 'MelvorBase:Lockpick').perHour, r.cyclesPerHour);

    // The key is the alternative that isn't used up.
    gd.player = { toolbelts: { Thieving: [{ item: 'MelvorBase:ThugChestKey', qty: 1 }] }, owned: { 'MelvorBase:ThugChestKey': 1 } };
    assert.ok(gd.checkRequirements(chest, levels).ok);
    assert.equal(computeRates(gd, chest, 99).inputs.length, 0);

    // Owned but not equipped: usable, with an "equip" step. Not owned at all: missing.
    gd.player = { toolbelts: {}, owned: { 'MelvorBase:FireWizardHat': 1, 'MelvorBase:FireWizardRobes': 1 } };
    req = gd.checkRequirements(wizard, levels);
    assert.ok(req.ok && req.equip.length === 2);
    req = gd.checkRequirements(star, levels);
    assert.ok(!req.ok && req.missing.some((q) => q.type === 'tool'));

    // A sightings log goes on every hit, not every ore.
    const sr = computeRates(gd, star, 99);
    close(sr.inputs.find((i) => i.item === 'MelvorBase:GoldenStarfallSightingsLog').perHour, sr.cyclesPerHour * miningExpectedHits(star.breakChance));
  } finally {
    gd.player = null;
  }
});

test('thieving targets inherit their location requirements; quest-only locations are dropped', () => {
  const wizard = method('Thieving/Wizard');
  assert.ok(wizard.requires.some((r) => r.type === 'tool' && r.anyOf.some((t) => t.item === 'MelvorBase:FireWizardHat')));
  assert.ok(!gd.methodByKey.has('Thieving/Archivist'), 'Ivory Athenaeum is a quest location');
  assert.ok(!gd.methods.some((m) => /Quest/i.test(m.category ?? '')), 'no quest objectives');
});

test('combat formulas match the game code', () => {
  // TargetCharacterStats.ComputeHitChance
  close(hitChance(1000, 500), 0.75);
  close(hitChance(500, 1000), 0.25);
  // ResistanceStats.ComputeResistance caps at 70% before the triangle bonus
  close(resistance(100, 100), 0.5);
  close(resistance(1, 10_000), 0.7);
  close(resistance(1, 10_000, 0.15), 0.805);
  // Fists, all levels 1: accuracy floor((1 + 9) * (0 + 64)), max hit floor(22 + 1 + 18 * 0 / 64)
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 1]));
  levels.Hitpoints = 10;
  const p = buildPlayer(gd, { gear: [], stance: 'Stab', levels });
  assert.equal(p.accuracy, 640);
  assert.equal(p.baseMaxHit, 23);
  assert.equal(p.interval, 4000);
  assert.equal(p.hitpoints, 100);
  assert.equal(p.power, 1);
  // Darkness without light cuts accuracy 5% per point, up to 20 points
  assert.equal(buildPlayer(gd, { gear: [], stance: 'Stab', levels, darkness: 10 }).accuracy, 320);
});

test('combat fights and gear recommendations are sane', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 40]));
  const golbin = gd.enemyById.get('Golbin');
  const r = fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels }), buildEnemy(gd, golbin), { food: 'MelvorBase:Shrimp' });
  assert.ok(r.killsPerHour > 0 && r.hitChance > 0 && r.hitChance <= 1);
  close(r.xpPerHour.Attack / r.xpPerHour.Hitpoints, 0.4 / 0.133);
  // A bank of melee gear: the optimiser must wear a weapon it has the levels for and never two-hand with an offhand.
  const bank = Object.fromEntries(Object.entries(gd.items).filter(([, it]) => it.equip && it.equip.requires.every((q) => q.level <= 40)).slice(0, 400).map(([id]) => [id, 1]));
  const owned = ownedEquipment(gd, bank, null);
  const rec = recommendStyle(gd, { style: 'Melee', owned, levels, bank, food: 'MelvorBase:Shrimp' });
  assert.ok(rec && rec.gear.slots.Weapon, 'picks a weapon');
  const weapon = gd.items[rec.gear.slots.Weapon].equip;
  assert.ok(weapon.requires.every((q) => q.type !== 'level' || q.level <= 40));
  if (weapon.alsoOccupies.includes('Offhand')) assert.equal(rec.gear.slots.Offhand, undefined);
  assert.ok(rec.fights.length > 0);
});

test('slayer rewards and task lengths follow SlayerTasksStats', () => {
  assert.equal(slayerXpPerKill(200), 29);
  assert.equal(slayerCoinsPerKill(200), Math.floor(0.1 * Math.pow(200, 1.15)));
  assert.equal(slayerCoinsPerKill(1), 1);
  const kuren = gd.combat.slayerMasters.find((m) => m.id === 'Kuren');
  assert.deepEqual(taskLength(kuren, 10), { min: 15, max: 45 });
  // A master with a known task: the task's numbers come from the best fight for that enemy.
  const golbin = gd.enemyById.get('Golbin');
  const fake = { enemy: golbin, area: gd.areaById.get(golbin.areas[0]), result: { killsPerHour: 100, oneHitRisk: false, combatXpPerHour: 1000 } };
  const bestFights = new Map([[golbin.id, { ...fake, style: 'Melee' }]]);
  const ov = slayerOverview(gd, { levels: { Slayer: 1 }, bestFights, tasks: { Kuren: { task: 'Golbin', length: 20, progress: 5, blocked: [] } }, coins: 0 });
  const k = ov.find((m) => m.master.id === 'Kuren');
  assert.equal(k.task.left, 15);
  close(k.task.hoursLeft, 0.15);
  assert.equal(k.doable, 1, 'only enemies with a safe fight count');
});

test('away planner stops when stock runs out', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 60]));
  const shrimp = method('Cooking/Shrimp');
  const raw = shrimp.ingredients[0].item;
  const rate = computeRates(gd, shrimp, 60).inputs.find((i) => i.item === raw).perHour;
  const rows = planAway(gd, { levels, stock: { [raw]: rate * 2 }, hours: 8, skill: 'Cooking' });
  const row = rows.find((r) => r.method.key === 'Cooking/Shrimp');
  close(row.runs, 2);
  assert.ok(rows.every((r) => r.runs <= 8));
});

test('shop bonuses follow the artisan step, doubling and preservation rules', () => {
  // Skip-step: 2 steps with a 50% chance to skip one finishes in 1.5 actions on average.
  close(expectedActions(2, 0.5), 1.5);
  close(expectedActions(1, 0.9), 1);
  close(expectedActions(5, 0), 5);
  const m = gd.methods.find((x) => x.kind === 'artisan' && x.steps >= 2 && x.ingredients.length && x.products.length);
  const level = 120;
  const base = computeRates(gd, m, level);
  const fx = (stat, value) => [{ stats: 'ArtisanAction', stat, value, skill: m.skill }];
  const doubled = ratesWithBonuses(gd, m, level, fx('DoublingChance', 0.1));
  close(doubled.outputs[0].perHour, base.outputs[0].perHour * 1.1);
  const kept = ratesWithBonuses(gd, m, level, fx('PreservationChance', 0.2));
  close(kept.inputs[0].perHour, base.inputs[0].perHour * 0.8);
  const faster = ratesWithBonuses(gd, m, level, fx('SkipStepChance', 0.2));
  assert.ok(faster.xpPerHour > base.xpPerHour);
  // A bonus for another skill or another category changes nothing.
  assert.equal(ratesWithBonuses(gd, m, level, [{ stat: 'DoublingChance', value: 1, skill: 'NotASkill' }]).profitPerHour, base.profitPerHour);
  assert.equal(ratesWithBonuses(gd, m, level, [{ stat: 'DoublingChance', value: 1, skill: m.skill, scope: { Category: 'Something else' } }]).profitPerHour, base.profitPerHour);
});

test('your bonuses from the save go into the rates', () => {
  const citizen = method('Thieving/Citizen');
  // Stealth: floor((level + flat) * (1 + percent)) against perception.
  close(thievingSuccessChance(gd, citizen, 10, { flatStealth: 15 }), Math.min(1, 125 / (100 + citizen.perception)));
  close(thievingSuccessChance(gd, citizen, 10, { flatStealth: 10, percentStealth: 0.5 }), Math.min(1, 130 / (100 + citizen.perception)));
  const save = {
    shopPurchases: { CopperPickaxeHead: 1 },
    toolbelts: { Thieving: [{ item: 'MelvorBase:Balaclava', qty: 1 }] },
    pets: [],
  };
  try {
    gd.playerBonuses = playerBonuses(gd, save);
    assert.ok(gd.playerBonuses.some((e) => e.source === 'Balaclava' && e.stat === 'FlatStealth'));
    const lowLevel = 1;
    assert.ok(computeRates(gd, citizen, lowLevel).successChance > computeRates(gd, citizen, lowLevel, { bonuses: [] }).successChance, 'stealth helps');
    const ore = gd.methods.find((m) => m.skill === 'Mining' && m.category === 'Ore Vein' && m.breakChance < 1);
    const gem = gd.methods.find((m) => m.skill === 'Mining' && m.category === 'Gem Vein' && m.breakChance < 1);
    assert.ok(computeRates(gd, ore, 99).xpPerHour > computeRates(gd, ore, 99, { bonuses: [] }).xpPerHour, 'the copper pickaxe head speeds up ore');
    close(computeRates(gd, gem, 99).xpPerHour, computeRates(gd, gem, 99, { bonuses: [] }).xpPerHour);
  } finally {
    gd.playerBonuses = null;
  }
  // Cooking proficiency adds to your level in the success formula.
  const shrimp = method('Cooking/Shrimp');
  close(computeRates(gd, shrimp, 1, { bonuses: [{ stat: 'FlatProficiency', value: 20, skill: 'Cooking' }] }).successChance, cookingSuccessChance(gd, shrimp, 21));
});

test('completion counts what the save has found and finds the quickest way to the rest', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 1]));
  const firstItem = gd.raw.completion.items[0];
  const save = { itemsFound: { [firstItem.split(':').pop()]: 5 }, enemiesKilled: { Golbin: 10 }, pets: [] };
  const st = completionStatus(gd, { save, levels });
  assert.equal(st.items.done, 1);
  assert.equal(st.items.total, gd.raw.completion.items.length);
  assert.equal(st.enemies.done, 1);
  assert.ok(st.nextItems.every((x) => x.best.type !== 'enemy'), 'no combat data, so no enemy sources');
  for (let i = 1; i < st.nextItems.length; i++) assert.ok(st.nextItems[i - 1].best.hours <= st.nextItems[i].best.hours);
  // A normal log comes from woodcutting at level 1 within seconds.
  const log = quickestSource(gd, 'MelvorBase:NormalLog', { levels });
  assert.ok(log.best && log.best.hours < 0.01);
});

test('completion only suggests buys you can make, and counts gathering the materials for a craft', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 99]));
  // The shop only has what the game's shop lists: the old dragonhide purchases aren't sold.
  assert.ok(!gd.shop.some((p) => p.provides.items.some((i) => i.item === 'MelvorBase:GreenDragonhide')));
  const wallet = { GoldPieces: 1e9 };
  try {
    gd.player = { toolbelts: {}, owned: {}, masteryRanks: { Hunting: [] } };
    assert.notEqual(quickestSource(gd, 'MelvorBase:BasicButterflyKit', { levels, wallet }).best?.type, 'shop', 'needs Skilled Hunter');
    gd.player.masteryRanks.Hunting = ['SkilledHunter'];
    assert.equal(quickestSource(gd, 'MelvorBase:BasicButterflyKit', { levels, wallet }).best?.type, 'shop');
  } finally {
    gd.player = null;
  }
  // No Stone in the bank: mine it first, and the time says so.
  const short = quickestSource(gd, 'MelvorBase:StoneSword', { levels: { ...levels, Smithing: 1 }, stock: {} }).best;
  assert.equal(short.type, 'method');
  assert.equal(short.gather[0].item, 'MelvorBase:Stone');
  assert.ok(short.gatherHours > 0 && short.hours > 1 / short.perHour);
  const stocked = quickestSource(gd, 'MelvorBase:StoneSword', { levels: { ...levels, Smithing: 1 }, stock: { 'MelvorBase:Stone': 10 } }).best;
  assert.equal(stocked.gather.length, 0);
  assert.ok(Math.abs(stocked.hours - 1 / stocked.perHour) < 1e-12);
});

test('hunting and astrology rates follow the action code', () => {
  const astro = method('Astrology/Deedree');
  close(computeRates(gd, astro, 1).xpPerHour, astro.xp * (3_600_000 / astro.interval));
  const m = method('Hunting/WildChicken');
  const r = computeRates(gd, m, 1);
  const p = m.trackChance;
  const q = m.trapChance;
  const track = (m.trackInterval.min + m.trackInterval.max) / 2;
  const expected = m.surveyInterval * (p + 2 * (1 - p) * p + 3 * (1 - p) ** 2) + ((m.steps.min + m.steps.max) / 2) * track + (m.trapInterval.min + m.trapInterval.max) / 2 / q + ((1 - q) / q) * m.steps.min * track;
  close(r.msPerCycle, expected);
  // A level 1 journal: the catch's size and weight average 0.91 of the animal's, and XP scales with them.
  close(r.xpPerHour, m.xp * 0.91 * (3_600_000 / expected));
  assert.ok(gd.raw.unlocks.Herblore.length && gd.raw.unlocks.Agility.length && gd.raw.unlocks.Ranching.length);
  assert.ok(!gd.methods.some((x) => x.skill === 'Hunting' && /Quest/i.test(x.category ?? '')));
});

test('level cap matches the game build', () => {
  assert.equal(gd.levelCap, 120);
  assert.ok(gd.methods.some((m) => m.level > 99), 'Playtest has content past 99');
});

test('simulation levels up and never loses XP', () => {
  const m = method('Thieving/Citizen');
  const sim = simulate(gd, m, { Thieving: 1 }, 0, { hours: 24 });
  assert.ok(sim.endLevel > sim.startLevel);
  close(sim.hours, 24);
  const toTarget = simulate(gd, m, { Thieving: 1 }, 0, { targetLevel: 10 });
  assert.equal(toTarget.endLevel, 10);
  assert.equal(toTarget.reachedTarget, true);
});

test('current activity is matched from the save header', () => {
  const a = currentActivity(gd, { activeEntityName: 'Woodcutting', activeActionName: 'Normal Tree' }, { Woodcutting: 20 });
  assert.equal(a.skill, 'Woodcutting');
  assert.equal(a.method.key, 'Woodcutting/NormalTree');
  assert.ok(a.xpRatio > 0 && a.xpRatio <= 1);
});

test('an Agility course is matched to the path that is running, not the one picked', () => {
  const header = { activeEntityName: 'Agility', activeActionName: 'Climb 3', activePath: 'Climb3AdvancedPath', pickedPath: 'Climb3SimplePath' };
  const a = currentActivity(gd, header, { Agility: 10 });
  assert.equal(a.method.key, 'Agility/Climb3AdvancedPath');
  assert.equal(a.picked.key, 'Agility/Climb3SimplePath', 'the path in the Select Path box, until the course restarts');
  assert.equal(currentActivity(gd, { ...header, pickedPath: 'Climb3AdvancedPath' }, { Agility: 10 }).picked, null);
});

test('bank insights value items and suggest crafts', () => {
  const bank = { 'MelvorBase:NormalLog': 100, 'MelvorBase:Shrimp': 10 };
  const b = bankInsights(gd, bank, { Fletching: 60, Firemaking: 60, Cooking: 60 });
  close(b.total, 100 * gd.itemValue('MelvorBase:NormalLog') + 10 * gd.itemValue('MelvorBase:Shrimp'));
  assert.ok(b.keepers.some((x) => x.item === 'MelvorBase:Shrimp'), 'food is kept, not sold');
  assert.ok(b.processing.every((p) => p.crafts >= 1 && p.totalGain > 0));
});

test('enemy loot chances are probabilities', () => {
  for (const e of gd.enemies) {
    const loot = enemyLoot(gd, e);
    for (const d of loot.items) assert.ok(d.chance > 0 && d.chance <= 1 + 1e-9, `${e.id} ${d.item} ${d.chance}`);
  }
});

test('drop chance helpers', () => {
  close(dropChance(0.5, 2), 0.75);
  assert.equal(triesFor(0.01, 0.5), 69);
  assert.equal(triesFor(1, 0.99), 1);
});

test('search finds items and methods', () => {
  const results = search(gd, 'oak');
  assert.ok(results.some((r) => r.type === 'item' && r.name === 'Oak Log'));
  assert.ok(results.some((r) => r.type === 'method' && r.name === 'Oak Tree'));
});

test('item sources carry the base chance one action gives the item', () => {
  const m = (key) => gd.methods.find((x) => x.name === key);
  // The main product comes every action; bird nests roll on every woodcutting hit.
  assert.deepEqual(methodChance(m('Normal Tree'), 'MelvorBase:NormalLog'), { chance: 1, per: 'log' });
  assert.deepEqual(methodChance(m('Normal Tree'), 'MelvorBase:BirdNest'), { chance: 0.0025, per: 'hit' });
  // Fishing: the catch chance times the fish's share of the table.
  close(methodChance(m('Shallow Pools'), 'MelvorBase:RawShrimp').chance, 0.8);
  // Thieving: the loot table's chance times the item's weight share, per attempt.
  const t = methodChance(m('Citizen'), 'MelvorBase:Bread');
  assert.equal(t.per, 'attempt');
  close(t.chance, 0.15 * 0.3);
  assert.equal(methodChance(m('Normal Tree'), 'MelvorBase:Bread'), null);
  // Every method source in the index has its chance.
  const bread = itemDetails(gd, 'MelvorBase:Bread').sources.filter((s) => s.type === 'method');
  assert.ok(bread.length && bread.every((s) => s.chance > 0 && s.chance <= 1 && s.per));
});

test('no demo-locked content leaks into the companion data', () => {
  const text = JSON.stringify(gd.raw);
  assert.ok(!text.includes('DemoLocked'));
  assert.ok(!text.includes('DemoPlaceholderItem'));
});

test('gathering plans follow the whole chain: mine the ore, smelt the bar, then smith', () => {
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 50]));
  const index = producerIndex(gd, levels);
  const plate = obtain(index, new Map(), 'MelvorBase:IronPlatebody', 5);
  assert.equal(plate.method.skill, 'Smithing');
  assert.deepEqual(plate.needs.map((n) => [n.item, n.method.skill, n.makes]), [
    ['MelvorBase:IronOre', 'Mining', false],
    ['MelvorBase:IronBar', 'Smithing', true],
  ]);
  // Ore already in the bank is used first: only the bars still need making.
  const withOre = obtain(index, new Map([['MelvorBase:IronOre', 1e6]]), 'MelvorBase:IronPlatebody', 5);
  assert.deepEqual(withOre.needs.map((n) => n.item), ['MelvorBase:IronBar']);
  assert.ok(withOre.hours < plate.hours);
});

test('Mastery Guild: a rank needs its share of all points, and every rank reached adds its bonus', () => {
  const fake = {
    levelOf: () => 1,
    raw: { mastery: { Test: {
      ranks: [{ id: 'Initiate', name: 'Initiate', percent: 0 }, { id: 'Apprentice', name: 'Apprentice', percent: 0.5 }],
      tasks: [{ id: 'T1', points: 1, goal: true }, { id: 'T2', points: 3, goal: true, trigger: true }],
      bonuses: [{ id: 'B', rank: 'Apprentice', effects: [{ stat: 'PercentXPGained', value: 0.1, skill: 'Test' }], mods: [] }],
    } } },
  };
  const one = masteryStatus(fake, { mastery: { Test: { T1: { goalComplete: true } } } }, {}).Test;
  assert.equal(one.rank.id, 'Initiate');
  assert.equal(one.pointsToNext, 1); // ceil(4 x 0.5) = 2 points
  assert.deepEqual(one.bonuses, []);
  // A task with a trigger needs it to have fired as well as its goal.
  const noTrigger = masteryStatus(fake, { mastery: { Test: { T2: { goalComplete: true, triggerMet: false } } } }, {}).Test;
  assert.equal(noTrigger.points, 0);
  const two = masteryStatus(fake, { mastery: { Test: { T2: { goalComplete: true, triggerMet: true } } } }, {}).Test;
  assert.equal(two.rank.id, 'Apprentice');
  assert.equal(two.bonuses[0].rankName, 'Apprentice');
});

test('Mastery Guild conditions read levels, item statistics and pets from the save', () => {
  assert.equal(conditionMet(gd, { type: 'level', skill: 'Woodcutting', level: 10 }, { levels: { Woodcutting: 10 } }), true);
  assert.equal(conditionMet(gd, { type: 'level', skill: 'Woodcutting', level: 10 }, { levels: { Woodcutting: 9 } }), false);
  const stat = { type: 'itemStat', stat: 'CraftingItemGained', item: 'Topaz', value: 400 };
  assert.equal(conditionMet(gd, stat, { save: { statistics: { CraftingItemGained: { Topaz: 400 } } } }), true);
  assert.equal(conditionMet(gd, stat, { save: { statistics: { CraftingItemGained: { Topaz: 399 } } } }), false);
  assert.equal(conditionMet(gd, stat, { save: {} }), null); // older save without statistics: unknown
  assert.equal(conditionMet(gd, { type: 'pet', pet: 'Momo' }, { save: { pets: ['Momo'] } }), true);
  // Real data: a save with every Woodcutting task done counts the Woodcutting rank bonuses.
  const def = gd.raw.mastery.Woodcutting;
  const tasks = Object.fromEntries(def.tasks.map((t) => [t.id, { goalComplete: true, triggerMet: true }]));
  const statistics = {};
  for (const t of def.tasks) if (t.condition?.type === 'itemStat') (statistics[t.condition.stat] ??= {})[t.condition.item] = 1e9;
  const skills = Object.fromEntries(gd.skills.map((s) => [s.id, { level: gd.levelCap }]));
  const pets = def.tasks.filter((t) => t.condition?.type === 'pet').map((t) => t.condition.pet);
  const xp = playerBonuses(gd, { mastery: { Woodcutting: tasks }, statistics, skills, pets }).filter((e) => e.skill === 'Woodcutting' && e.stat === 'PercentXPGained');
  assert.ok(xp.length >= 1 && xp.every((e) => e.source.endsWith('(Mastery Guild)')));
});

test('mastery bonuses: tree health, smelting time, elemental rune quantity, hunting', () => {
  const tree = gd.methods.find((m) => m.kind === 'woodcutting' && m.maxHealth === 5);
  const logs = (bonuses) => computeRates(gd, tree, 99, { bonuses }).outputs.find((o) => o.item === tree.product.item).perHour;
  close(logs([{ stat: 'PercentMaxHealth', value: -0.2, skill: 'Woodcutting' }]) / logs([]), 5 / 4);
  const smelt = gd.methods.find((m) => m.skill === 'Smithing' && m.category === 'Smelting');
  const gear = gd.methods.find((m) => m.skill === 'Smithing' && m.category !== 'Smelting');
  const faster = [{ stat: 'PercentInterval', value: -0.2, skill: 'Smithing', scope: { Category: 'Smelting' } }];
  close(computeRates(gd, smelt, 99, { bonuses: faster }).xpPerHour / computeRates(gd, smelt, 99, { bonuses: [] }).xpPerHour, 1 / 0.8);
  close(computeRates(gd, gear, 99, { bonuses: faster }).xpPerHour, computeRates(gd, gear, 99, { bonuses: [] }).xpPerHour);
  const extra = [{ stat: 'FlatProductQuantity', value: 2, skill: 'Runecrafting', scope: { Subcategory: 'Elemental Runes' } }];
  const air = method('Runecrafting/AirRune');
  const mind = method('Runecrafting/MindRune');
  close(computeRates(gd, air, 99, { bonuses: extra }).outputs[0].perHour / computeRates(gd, air, 99, { bonuses: [] }).outputs[0].perHour, 3);
  close(computeRates(gd, mind, 99, { bonuses: extra }).outputs[0].perHour, computeRates(gd, mind, 99, { bonuses: [] }).outputs[0].perHour);
  const hunt = gd.methods.find((m) => m.kind === 'hunting');
  const better = computeRates(gd, hunt, 99, { bonuses: [{ stat: 'FlatTrappingSuccessChance', value: 0.05, skill: 'Hunting' }] });
  assert.ok(better.xpPerHour > computeRates(gd, hunt, 99, { bonuses: [] }).xpPerHour);
});

test('Herblore: a batch is three phases then ten bottlings, and everything comes per bottling', () => {
  const r = computeRates(gd, method('Herblore/WoodcuttingPotionP1A'), 1, { bonuses: [] });
  // 4500 + 15000 + 5500 + 10 x 500 = 30 s per batch -> 1,200 bottlings/h of 15 potions and 3 XP
  close(r.xpPerHour, 3600);
  close(r.outputs.find((o) => o.item === 'MelvorBase:WoodcuttingPotionP1A').perHour, 18000);
  close(r.inputs.find((i) => i.item === 'MelvorBase:EmptyVial').perHour, 1200);
});

test('Agility: failures restart the path, so the chance to finish compounds', () => {
  const climb = method('Agility/Climb1SimplePath'); // difficulty 2 then 3; 2 s then 3 s; 3 XP per run
  const low = computeRates(gd, climb, 1, { bonuses: [], techniques: { Climbing: 1 } });
  const p1 = 0.95 ** 1;
  const p2 = 0.95 ** 1.5;
  const runMs = (2000 * 1 + 3000 * p1) / (p1 * p2);
  close(low.xpPerHour, (3 * 3_600_000) / runMs);
  assert.ok(low.food, 'failed obstacles cost HP, paid for with food');
  const high = computeRates(gd, climb, 1, { bonuses: [], techniques: { Climbing: 40 } });
  close(high.xpPerHour, (3 * 3_600_000) / 5000);
});

test('Ranching: per animal per hour, scaled by happiness and its childhood', () => {
  const chicken = method('Ranching/Chicken');
  const r = computeRates(gd, chicken, 99, { bonuses: [] });
  assert.equal(r.passive, true);
  close(r.xpPerHour, 31 * 0.96 * (0.1 * 0.5 + 0.9));
  close(r.inputs.find((i) => i.item === 'MelvorBase:Grain').perHour, 10);
  close(-r.currencies.GoldPieces, 6000 / 96); // a new chicken every 96 hours
  const eggs = r.outputs.find((o) => o.item === 'MelvorBase:Egg').perHour;
  close(eggs, 2 * 0.96 * (0.05 + 0.9 * (1 + chicken.bonusVariantShare)));
});

test('Prayer XP comes from hits while a prayer is on, and leaves the combat XP total alone', () => {
  const levels = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].map((s) => [s, 40]));
  const enemy = gd.enemies.find((e) => e.id === 'Golbin') ?? gd.enemies[0];
  const p = buildPlayer(gd, { gear: [], stance: 'Stab', levels });
  const plain = fight(gd, p, buildEnemy(gd, enemy), { prayers: [] });
  const praying = fight(gd, p, buildEnemy(gd, enemy), { prayers: ['Guard'] });
  assert.equal(plain.xpPerHour.Prayer, undefined);
  assert.ok(praying.xpPerHour.Prayer > 0);
  close(praying.combatXpPerHour, plain.combatXpPerHour);
  // Guard costs 1 point per enemy attack turn.
  assert.ok(praying.prayerPointsPerHour > 0);
  // Each damaging hit gives at least sqrt(3 + 0.2) XP.
  assert.ok(praying.xpPerHour.Prayer >= praying.attacksPerHour * praying.hitChance * Math.sqrt(3.2) * 0.999);
});

test('set bonuses: enough pieces of a set turn its bonus on', () => {
  const set = gd.combat.sets.find((s) => s.id === 'Dawnsteel');
  const light = set.bonuses.find((b) => b.mods.some((m) => m.stat === 'FlatLight'));
  const levels = { Attack: 50, Strength: 50, Defence: 50, Hitpoints: 50 };
  const wear = (n) => buildPlayer(gd, { gear: set.items.slice(0, n), stance: 'Stab', levels, darkness: 10 });
  // Each piece has some light of its own; the set adds 5 more once enough are worn.
  const own = set.items.slice(0, light.count).reduce((sum, item) => sum + buildPlayer(gd, { gear: [item], stance: 'Stab', levels }).light, 0);
  assert.equal(wear(light.count).light, own + 5);
  assert.ok(wear(light.count - 1).light < own);
  // Skilling sets count pieces in your toolbelts.
  const graceful = gd.combat.sets.find((s) => s.id === 'GracefulSet');
  const toolbelts = { Agility: graceful.items.map((item) => ({ item, qty: 1 })) };
  const fx = playerBonuses(gd, { toolbelts }).filter((e) => e.source === `${graceful.name} set`);
  assert.ok(fx.some((e) => e.skill === 'Agility' && e.stat === 'PercentInterval'));
});

test('bank space: capacity from upgrades, and crafts that empty whole stacks', async () => {
  const { bankCapacity, freeSpaceOptions, BASE_BANK_SLOTS } = await import('../engine/bank-space.js');
  const upgrade = gd.shop.find((p) => (p.provides.effects ?? []).some((e) => e.stat === 'FlatMaxStacks'));
  const slots = upgrade.provides.effects.filter((e) => e.stat === 'FlatMaxStacks').reduce((s, e) => s + e.value, 0);
  assert.deepEqual(bankCapacity(gd, { shopPurchases: { [upgrade.id]: 1 }, bank: { stacks: 7 } }), { used: 7, max: BASE_BANK_SLOTS + slots, free: BASE_BANK_SLOTS + slots - 7 });
  // A two-ingredient smelt whose bar you already hold: both ore stacks go, nothing new appears.
  const smelt = gd.methods.find((m) => m.skill === 'Smithing' && m.category === 'Smelting' && m.ingredients.length === 2);
  const n = 12;
  const bank = Object.fromEntries([...smelt.ingredients.map((i) => [i.item, i.qty * n]), [smelt.products[0].item, 1]]);
  const levels = { Smithing: gd.levelCap };
  const craft = freeSpaceOptions(gd, bank, levels).find((o) => o.kind === 'craft' && o.method.key === smelt.key);
  assert.equal(craft?.crafts, n);
  assert.equal(craft?.slots, 2);
  // Without the bar in the bank, the bars need a slot of their own.
  const fresh = Object.fromEntries(smelt.ingredients.map((i) => [i.item, i.qty * n]));
  assert.equal(freeSpaceOptions(gd, fresh, levels).find((o) => o.method?.key === smelt.key)?.slots, 1);
  // Empty placeholders are free to clear, so they come first; a stack kept as a placeholder is marked.
  const withPlaceholders = freeSpaceOptions(gd, bank, levels, { empty: ['MelvorBase:Shrimp', 'MelvorBase:OakLog'], kept: [smelt.ingredients[0].item] });
  assert.deepEqual(withPlaceholders[0], { kind: 'placeholders', items: ['MelvorBase:Shrimp', 'MelvorBase:OakLog'], slots: 2, gp: 0, hours: 0 });
  assert.equal(withPlaceholders.find((o) => o.method?.key === smelt.key).kept, true, 'the slot comes back only once its placeholder goes');
  assert.equal(craft.kept, false);
});

test('buy or make: buying wins when your time is worth more than the break-even', async () => {
  const { buyOrMake } = await import('../engine/buy-or-make.js');
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, gd.levelCap]));
  const rich = buyOrMake(gd, levels, { timeValue: 1e9 });
  const poor = buyOrMake(gd, levels, { timeValue: 0 });
  assert.ok(rich.length > 0);
  assert.ok(rich.every((r) => r.verdict === 'buy'));
  assert.ok(poor.every((r) => r.verdict === 'make'));
  for (const r of rich) close(r.breakEven, r.buyEach / r.makeHoursEach);
});

test('playtest report: stats without the character name', async () => {
  const { playtestReport } = await import('../engine/playtest-report.js');
  const save = { version: 27, header: { characterName: 'Secret Name', uuid: 'abc', totalLevel: 100, gp: 5 }, skills: { Woodcutting: { level: 10, xp: 1200.4 } }, statistics: { WoodcuttingActions: 3 } };
  const report = playtestReport(gd, save, { levels: { Woodcutting: 10 }, observations: {} });
  const text = JSON.stringify(report);
  assert.ok(!text.includes('Secret Name') && !text.includes('"abc"'));
  assert.deepEqual(report.skills.Woodcutting, { level: 10, xp: 1200 });
  assert.equal(report.statistics.WoodcuttingActions, 3);
  assert.equal(report.mastery.Woodcutting.rank, gd.raw.mastery.Woodcutting.ranks[0].name);
});

test('quests: current step progress, what can start, and quests that can never appear', async () => {
  const { questStatus } = await import('../engine/quests.js');
  const q1 = gd.raw.quests.find((q) => q.id === 'MQ1');
  const stepIndex = q1.steps.findIndex((st) => st.tasks.some((t) => t.goals.length));
  const step = q1.steps[stepIndex];
  const taskIndex = step.tasks.findIndex((t) => t.goals.length);
  const task = step.tasks[taskIndex];
  const goal = task.goals[0];
  const earlier = Object.fromEntries(q1.steps.slice(0, stepIndex).map((st) => [st.id, { state: 'complete', tasks: {} }]));
  const save = { quests: {
    MQ1: { state: 'inProgress', steps: { ...earlier, [step.id]: { state: 'active', tasks: { [task.id]: { state: 'active', costsMet: false, goals: { [goal.id]: { progress: 1, complete: false } } } } } } },
  } };
  const all = questStatus(gd, save, { stock: {} });
  const mq1 = all.find((s) => s.quest.id === 'MQ1');
  assert.equal(mq1.stepIndex, stepIndex);
  assert.equal(mq1.tasks[taskIndex].goals[0].progress, 1);
  assert.equal(all.find((s) => s.quest.id === 'MQ2').canStart, false); // needs MQ1 claimed
  // With MQ1-MQ8 claimed: MQ9 waits on MQ11, which needs MQ10, which needs MQ9.
  const claimed = Object.fromEntries(['MQ1', 'MQ2', 'MQ3', 'MQ4', 'MQ5', 'MQ6', 'MQ7', 'MQ8'].map((id) => [id, { state: 'claimed', steps: {} }]));
  const later = questStatus(gd, { quests: claimed });
  const mq9 = later.find((s) => s.quest.id === 'MQ9');
  if (mq9.quest.shownAfter.includes('MQ11')) assert.equal(mq9.unreachable, true);
  assert.equal(later.find((s) => s.quest.id === 'MQ1').state, 'claimed');
});

test('hunting uses up a trap per attempt; better traps save some and improve after each miss', () => {
  const lizard = gd.methods.find((m) => m.kind === 'hunting' && m.traps.length === 3 && m.trapChance < 0.6);
  const [basic, , fortified] = lizard.traps;
  const saved = gd.player;
  try {
    gd.player = { owned: {}, toolbelts: {} };
    const r = computeRates(gd, lizard, 99, { bonuses: [] });
    const q = lizard.trapChance;
    const catchesPerHour = r.cyclesPerHour;
    close(r.inputs.find((i) => i.item === basic.item).perHour, catchesPerHour / q); // 1/q attempts per catch, none saved
    gd.player = { owned: { [fortified.item]: 100 }, toolbelts: {} };
    const f = computeRates(gd, lizard, 99, { bonuses: [] });
    const used = f.inputs.find((i) => i.item === fortified.item).perHour / f.cyclesPerHour;
    // Fewer attempts (higher, growing success) and 40% of traps kept.
    assert.ok(used < (1 / q) * (1 - fortified.preservation));
    assert.ok(f.xpPerHour > r.xpPerHour);
  } finally {
    gd.player = saved;
  }
});

test('shop purchases behind a Mastery Guild rank are only buyable once it is reached', async () => {
  const { purchaseStatus, playerState } = await import('../engine/gamedata.js');
  const p = gd.shop.find((x) => x.requires.some((r) => r.type === 'masteryRank'));
  const req = p.requires.find((r) => r.type === 'masteryRank');
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, gd.levelCap]));
  const saved = gd.player;
  try {
    gd.player = null; // no save: can't tell, so not offered
    assert.equal(purchaseStatus(gd, p, levels).ok, false);
    gd.player = playerState({ mastery: { [req.skill]: {} }, skills: {} }, gd); // rank 0 only
    const before = purchaseStatus(gd, p, levels);
    assert.equal(before.ok, false);
    assert.equal(before.missing[0].rank, req.rank);
    gd.player = { ...gd.player, masteryRanks: { [req.skill]: [req.rank] } };
    assert.deepEqual(purchaseStatus(gd, p, levels).missing.filter((r) => r.type === 'masteryRank'), []);
  } finally {
    gd.player = saved;
  }
});

test('combat realism: immunity, ward, kill XP, healing enemies, death risk, enemy-side and on-task gear', async () => {
  const strong = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].map((s) => [s, 99]));
  const player = (opts = {}) => buildPlayer(gd, { gear: [], stance: 'Stab', levels: strong, ...opts });
  const strip = (enemy, patch) => ({ ...enemy, ...patch, stats: { ...enemy.stats, ...(patch.stats ?? {}) } });

  // Immune to your style: no kills.
  const immune = gd.enemies.find((e) => e.passive?.immuneTo.includes('Melee'));
  assert.equal(fight(gd, player(), buildEnemy(gd, immune)).killsPerHour, 0);

  // Ward: more hits per kill, and more XP per kill (50 x ward, KilledExperienceStats).
  const warded = gd.enemies.find((e) => (e.stats.MaximumWard ?? 0) > 0 && !e.passive?.immuneTo.length && !e.passive?.healPerTurn);
  const plain = strip(warded, { stats: { MaximumWard: 0 }, passive: undefined });
  const withWard = fight(gd, player(), buildEnemy(gd, { ...warded, passive: undefined }));
  const noWard = fight(gd, player(), buildEnemy(gd, plain));
  assert.ok(withWard.killSeconds > noWard.killSeconds);
  const perKill = (r) => r.combatXpPerHour / r.killsPerHour;
  close(perKill(withWard) - perKill(noWard), 50 * warded.stats.MaximumWard * (perKill(noWard) / ((plain.levels.Hitpoints ?? 1) * 10 + 4 * Math.max(0, plain.stats.Armour ?? 0))), 1e-6);

  // A slime heals each turn: slower than the same enemy without it.
  const slime = gd.enemies.find((e) => e.passive?.healPerTurn > 0);
  const healing = fight(gd, player(), buildEnemy(gd, slime));
  const still = fight(gd, player(), buildEnemy(gd, { ...slime, passive: { ...slime.passive, healPerTurn: 0 } }));
  assert.ok(healing.killSeconds >= still.killSeconds);

  // Death risk: food keeps you safe from something that can't hit past the auto-eat threshold.
  const weak = buildEnemy(gd, gd.enemies.find((e) => e.id === 'Golbin') ?? gd.enemies[0]);
  const safe = fight(gd, player(), weak, { food: gd.foods[0].item });
  assert.equal(safe.hoursToDeath, Infinity);
  assert.equal(safe.risky, false);
  const brute = gd.enemies.map((e) => ({ e, r: fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels: { Hitpoints: 10 } }), buildEnemy(gd, e), { food: gd.foods[0].item }) })).find((x) => !x.r.oneHitRisk && Number.isFinite(x.r.hoursToDeath) && x.r.killsPerHour > 0);
  if (brute) assert.ok(brute.r.hoursToDeath > 0);

  // Gear that works on the enemy isn't added to your own stats.
  const onEnemy = Object.entries(gd.items).find(([, it]) => it.equip?.mods?.some((m) => m.onEnemy && m.stat === 'PercentAccuracyRating'));
  if (onEnemy) {
    const [id] = onEnemy;
    const p = player({ gear: [id] });
    assert.ok(p.enemyMods.some((m) => m.stat === 'PercentAccuracyRating'));
  }

  // On-task gear: Dragonhide protection only counts on a Slayer task.
  const hide = Object.entries(gd.items).find(([, it]) => it.equip?.mods?.some((m) => m.when?.type === 'slayerTask' && m.stat === 'FlatProtectionRating'));
  const [hideId] = hide;
  assert.ok(player({ gear: [hideId], slayerTask: true }).protection > player({ gear: [hideId] }).protection);
});

test('dungeon runs: time for every fight, rewards at the end, chests at their contents', async () => {
  const { dungeonRun, rewardValue } = await import('../engine/dungeons.js');
  const d = gd.combat.dungeons.find((x) => x.id === 'HobgolbinCamp') ?? gd.combat.dungeons[0];
  const levels = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints'].map((s) => [s, 99]));
  const run = dungeonRun(gd, d, { gear: [], stance: 'Stab', levels, food: gd.foods[0].item });
  assert.ok(run && run.runsPerHour > 0);
  const fights = d.fights.reduce((s, f) => s + f.count, 0);
  assert.ok(run.runMinutes * 60 >= fights * (gd.mechanics.enemySpawnMs ?? 3000) / 1000); // at least the spawn waits
  assert.ok(rewardValue(gd, d.rewards) > 0);
  close(run.gpPerHour, run.rewardsPerRun * run.runsPerHour);
});
