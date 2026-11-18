// Gear within reach for skills, fights in plans (combat levels and Mastery kill tasks), and your own goals
// going first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { fightMethod } from '../engine/fight-method.js';
import { upgradeSources } from '../engine/gear-upgrades.js';
import { computeRates } from '../engine/rates.js';
import { describeStep, lockRoute, routeProgress } from '../engine/route-progress.js';
import { planRoute } from '../engine/route.js';
import { toolUpgrades } from '../engine/toolbelt-advice.js';
import { bestSustained, producerIndex, rankSkill } from '../engine/advisor.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const ID = (id) => `MelvorBase:${id}`;
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));
const xpAt = (levels) => Object.fromEntries(Object.entries(levels).map(([s, l]) => [s, gd.xp.xpForLevel(l)]));

// A save with this bank and empty toolbelts, and the player state the engine reads from it.
function withSave({ bank = {}, levels = at(40) } = {}, run) {
  const was = [gd.player, gd.playerBonuses];
  gd.player = { toolbelts: {}, owned: { ...bank }, masteryRanks: {}, prayers: [], quests: null, enemiesKilled: null, slayerTasks: [], levels, foods: {} };
  gd.playerBonuses = [];
  try {
    return run({ toolbelts: {}, bank: { items: bank }, shopPurchases: {} }, levels);
  } finally {
    [gd.player, gd.playerBonuses] = was;
  }
}

test('gear within reach: toolbelt items you could get that make a skill better, and how', () => {
  withSave({}, (save, levels) => {
    const up = toolUpgrades(gd, save, { levels, xp: xpAt(levels) });
    const hunting = [...up.ready, ...up.soon].filter((r) => r.skill === 'Hunting');
    assert.ok(hunting.length, 'something for Hunting with empty toolbelts');
    for (const r of [...up.ready, ...up.soon]) {
      assert.ok(r.gain.score >= 0.002, `${r.item} helps (${r.gain.score})`);
      assert.ok(!(save.bank.items[r.item] > 0));
      assert.equal(gd.items[r.item].tool.slot, r.slot.fits);
    }
    for (const r of up.ready) assert.deepEqual(r.needs, [], 'you can get these now');
    for (const r of up.soon) assert.ok(r.needs.every((n) => n.level - levels[n.skill] <= 15), 'a few levels away');
    // What you own isn't suggested again.
    const item = hunting[0].item;
    const owned = withSave({ bank: { [item]: 1 } }, (s, lv) => toolUpgrades(gd, s, { levels: lv, xp: xpAt(lv) }));
    assert.ok(![...owned.ready, ...owned.soon].some((r) => r.item === item));
  });
});

test('a pickpocket that can kill you is not a way to get gear', () => {
  // Commoner Shoes come from the Capital Citizen, whose hits beat auto-eat at Hitpoints 10.
  const shoes = ID('CommonerShoes');
  const pick = (hitpoints) => withSave({ levels: { ...at(99), Hitpoints: hitpoints }, bank: { [ID('Glowfin')]: 10000 } }, (save, levels) => {
    gd.player.foods = { Thieving: ID('Glowfin') };
    return upgradeSources(gd, shoes, 1, { levels }).filter((s) => s.method?.key === 'Thieving/CapitalCitizen');
  });
  assert.equal(pick(10).length, 0);
  assert.equal(pick(99).length, 1, 'safe once auto-eat comes in time');
});

test('a fight in a plan: kills an hour and XP from the combat engine, ticked off by XP, kept across a restart', () => {
  const enemy = gd.enemies[0];
  const fight = { enemy: enemy.id, area: null, style: 'Melee', stance: 'Block', skill: 'Defence', killsPerHour: 100, xpPerHour: { Defence: 2000, Hitpoints: 700 }, profitPerHour: 50 };
  const m = fightMethod(gd, fight);
  const r = computeRates(gd, m, 40);
  assert.equal(r.cyclesPerHour, 100);
  assert.equal(r.xpPerHour, 2000);
  const levels = at(40);
  const xp = xpAt(levels);
  const leg = { kind: 'combat', skill: 'Defence', from: 40, to: 41, unlocks: [], steps: [{ kind: 'train', method: m, actions: 50, hours: 0.5, xpGain: 1000, xpAfter: xp.Defence + 1000, toLevel: 41, levelUps: [] }] };
  const locked = JSON.parse(JSON.stringify(lockRoute({ legs: [leg] })));
  // As after a restart: the method has to be made again from the plan.
  gd.methodByKey.delete(m.key);
  const p = routeProgress(gd, locked, { levels, xp: { ...xp, Defence: xp.Defence + 400 }, bank: {} });
  assert.equal(p.legs[0].steps[0].left.actions, 30, '600 XP left at 20 a kill');
  assert.match(describeStep(gd, p.step), new RegExp(`^Fight ${enemy.name} × 30`));
});

test('your own goals go first, all the way to your target', () => {
  withSave({ levels: at(40) }, (save, levels) => {
    const xp = xpAt(levels);
    const free = planRoute(gd, { levels, xp, bank: {} });
    // A skill the plan wouldn't start with: your goal puts it first, to the level you set.
    const skill = gd.trainableSkills.find((s) => s !== free.legs[0].skill && gd.methodsBySkill[s].some((m) => m.level > 40 && m.level <= 45));
    const route = planRoute(gd, { levels, xp, bank: {}, targets: [{ skill, target: 45 }] });
    assert.equal(route.legs[0].skill, skill);
    assert.equal(route.legs[0].to, 45);
    assert.ok(route.legs[0].yours);
    assert.match(route.legs[0].reasons[0].text, new RegExp(`Your goal: .* 45`));
    // Reached already: no longer first.
    const done = planRoute(gd, { levels: { ...levels, [skill]: 45 }, xp: { ...xp, [skill]: gd.xp.xpForLevel(45) }, bank: {}, targets: [{ skill, target: 45 }] });
    assert.ok(!done.legs.some((l) => l.yours));
  });
});

test("a skill's best is one you can keep doing: not a recipe needing something nothing you can do makes", () => {
  withSave({ levels: at(64) }, (save, levels) => {
    const ranked = rankSkill(gd, 'Smithing', levels);
    assert.equal(ranked.best.method.id, 'StonersPickaxe', 'the raw ranking puts the one-off recipe first');
    const best = bestSustained(gd, ranked, producerIndex(gd, levels), gd.player.owned);
    assert.ok(best && best.method.id !== 'StonersPickaxe', `picked ${best?.method.name}`);
    assert.ok(best.materialHours > 0 && best.xpPerHour < best.rates.xpPerHour, 'its XP counts the time to get the bars');
    // With an hour's worth of damaged pickaxes and everything else in the bank, it is the best again.
    gd.player.owned = { [ID('StonersPickaxeDamaged')]: 1000, [ID('Stone')]: 10_000, [ID('AdamantiteBar')]: 10_000 };
    assert.equal(bestSustained(gd, ranked, producerIndex(gd, levels), gd.player.owned).method.id, 'StonersPickaxe');
  });
});
