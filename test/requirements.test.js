import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData, describeRequirement, playerState } from '../engine/gamedata.js';
import { conditionMet, taskDone } from '../engine/mastery.js';
import { defaultXpTable } from '../engine/xp.js';
import { parseSave } from '../server/save-reader.js';
import { buildSave } from './save-writer.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const method = (key) => gd.methodByKey.get(key) ?? assert.fail(`missing method ${key}`);

test("recipes carry their category's requirements", () => {
  const inCategory = (name) => gd.methods.filter((m) => m.category === name);
  // Astral Jewellery, Ironsteel and Dragonrune gear need an Astrology major node.
  for (const name of ['Astral Jewellery', 'Ironsteel Gear', 'Dragonrune Gear']) {
    const list = inCategory(name);
    assert.ok(list.length >= 10, name);
    for (const m of list) assert.ok(m.requires.some((r) => r.type === 'astrologyNode'), m.key);
  }
  // Every super potion needs Super Potion Research, listed once.
  const supers = gd.methodsBySkill.Herblore.filter((m) => /^Super /.test(m.name));
  assert.ok(supers.length >= 70);
  for (const m of supers) assert.equal(m.requires.filter((r) => r.type === 'purchase' && r.id === 'SuperPotionResearch').length, 1, m.key);
  // Mill Farm crops need the Grain Mill.
  assert.ok(method('Farming/Wheat').requires.some((r) => r.type === 'purchase' && r.id === 'GrainMill'));
  // An ungated category adds nothing.
  assert.ok(gd.methodsBySkill.Herblore.filter((m) => !/^Super /.test(m.name)).every((m) => !m.requires.some((r) => r.type === 'purchase')));
});

// A StatisticsComponent region: simple statistics, then lists of dictionary statistics.
const statistics = (simple, ...lists) => (c) => {
  c.i32(Object.keys(simple).length);
  for (const [id, v] of Object.entries(simple)) c.str(`MelvorBase:${id}`).region((g) => g.f64(v));
  for (const list of lists) {
    c.i32(Object.keys(list).length);
    for (const [id, values] of Object.entries(list)) {
      c.str(`MelvorBase:${id}`).region((g) => {
        g.i32(Object.keys(values).length);
        for (const [key, v] of Object.entries(values)) g.f64(v).str(`MelvorBase:${key}`);
      });
    }
  }
};

test('reads the extra statistics lists that Combat, Slayer and Astrology write after items and currencies', () => {
  const combat = ['MelvorBase:Combat', [['Statistics', statistics(
    { CombatDamageDealt: 5 },
    { CombatItemGained: { Bones: 9 } },
    {},
    { CombatEnemyKilled: { Golbin: 40 } },
    { CombatDungeonCompleted: { HobgolbinCamp: 3 } },
    {},
    {},
    {},
  )]]];
  const slayer = ['MelvorBase:Slayer', [['Statistics', statistics({}, {}, {}, { SlayerMasterTasksCompleted: { Kuren: 6 } }, { EnemyTasksCompleted: { BlueSlime: 7 } })]]];
  const astrology = ['MelvorBase:Astrology', [['Statistics', statistics({}, {}, {}, { AstrologyTimesConstellationStudied: {} }, { AstrologyTimesEventObserved: { HydenObservation1: 2 } })]]];
  const save = parseSave(buildSave({ version: 28, skills: { Attack: { xp: defaultXpTable.xpForLevel(5), level: 5 } }, extraEntities: [combat, slayer, astrology] }));
  assert.deepEqual(save.warnings, []);
  assert.equal(save.statistics.CombatDamageDealt, 5);
  assert.deepEqual(save.statistics.CombatItemGained, { Bones: 9 });
  assert.deepEqual(save.statistics.CombatDungeonCompleted, { HobgolbinCamp: 3 });
  assert.deepEqual(save.statistics.SlayerMasterTasksCompleted, { Kuren: 6 });
  assert.deepEqual(save.statistics.EnemyTasksCompleted, { BlueSlime: 7 });
  assert.deepEqual(save.statistics.AstrologyTimesEventObserved, { HydenObservation1: 2 });
  assert.deepEqual(save.enemiesKilled, { Golbin: 40 });

  // A list cut short is dropped whole rather than read wrong.
  const cut = ['MelvorBase:Agility', [['Statistics', (c) => { statistics({}, {}, {})(c); c.i32(1).str('MelvorBase:AgilityCourseCompleted').region((g) => g.i32(2).f64(4).str('MelvorBase:Climb1')); }]]];
  const broken = parseSave(buildSave({ version: 28, skills: { Attack: { xp: defaultXpTable.xpForLevel(5), level: 5 } }, extraEntities: [cut] }));
  assert.equal(broken.statistics?.AgilityCourseCompleted, undefined);
});

test('requirements the save records are answered from it, with specific labels', () => {
  const save = {
    shopPurchases: { SilverSlayerPermit: 1 },
    statistics: { HerbloreItemGained: { WoodcuttingPotionP1A: 999 }, SlayerMasterTasksCompleted: { Fells: 5 }, BankItemFound: {} },
    agilityTechniques: { Balancing: { xp: 0, level: 25 } },
    quests: { MQ10: { state: 'inProgress', steps: { 0: { state: 'complete' }, 1: { state: 'active' } } } },
  };
  gd.player = playerState(save);
  const check = (requires, levels = { Slayer: 99, Agility: 99, Herblore: 99 }) => gd.checkRequirements({ skill: null, level: 0, requires }, levels);
  try {
    const potion = method('Herblore/WoodcuttingPotionP2A');
    assert.equal(describeRequirement(gd, potion.requires[0]), 'Brew 1,000 Woodcutting Potion P1-A');
    assert.deepEqual(check(potion.requires).missing.map((r) => r.stat), ['HerbloreItemGained'], '999 brewed is one short');
    save.statistics.HerbloreItemGained.WoodcuttingPotionP1A = 1000;
    assert.ok(check(potion.requires).ok);

    const sea = gd.areaById.get('SeaOfSand');
    assert.ok(sea.requires.some((r) => r.label === 'Balancing technique 25'));
    const seaNow = check(sea.requires);
    assert.ok(seaNow.ok && !seaNow.unknown.length, 'permit bought, technique 25');
    gd.player.techniques.Balancing = 24;
    assert.deepEqual(check(sea.requires).missing.map((r) => r.type), ['technique']);

    // Since 0.11.5 Silted Oasis opens once The Path to Melvor is done, not after its first step (the
    // quest's fights moved to an area of their own).
    const oasis = gd.areaById.get('SiltedOasis').requires;
    assert.deepEqual(check(oasis).missing.map((r) => r.type), ['quest'], 'one step done is not enough');
    save.quests.MQ10.state = 'claimed';
    gd.player = playerState(save);
    assert.ok(check(oasis).ok, 'quest finished');
    assert.ok(check(gd.raw.combat.dungeons.find((d) => d.id === 'VenomPit').requires).ok, '5 Fells tasks');
    // An item never found counts as 0; a statistic the save didn't read stays unknown.
    const map = method('Agility/ToragGroundsTrailAdvancedPath').requires.filter((r) => r.stat === 'BankItemFound');
    assert.equal(check(map).missing.length, 1);
    delete gd.player.statistics.BankItemFound;
    assert.equal(check(map).unknown.length, 1);
    // Astrology nodes come from the save's Astrology block; this save has none, so they stay unknown.
    const astral = gd.methods.find((m) => m.category === 'Astral Jewellery');
    assert.ok(check(astral.requires).unknown.some((r) => r.type === 'astrologyNode'));
    gd.player.astrologyNodes = ['HydenMajor2'];
    assert.ok(!check(astral.requires).unknown.length && !check(astral.requires).missing.some((r) => r.type === 'astrologyNode'), 'and are met once the save shows the node');
  } finally {
    gd.player = null;
  }
  // Without a save nothing new is assumed.
  assert.equal(gd.checkRequirements(method('Herblore/WoodcuttingPotionP2A'), { Herblore: 99 }).unknown.length, 1);
});

test('Mastery Guild conditions read Slayer, Agility, Astrology and Ranching statistics and technique levels', () => {
  const ctx = (save) => ({ save, levels: {} });
  const slayer = { type: 'stat', stat: 'SlayerMasterTasksCompleted', id: 'Kuren', value: 20 };
  assert.equal(conditionMet(gd, slayer, ctx({ statistics: { SlayerMasterTasksCompleted: { Kuren: 20 } } })), true);
  assert.equal(conditionMet(gd, slayer, ctx({ statistics: { SlayerMasterTasksCompleted: { Allevia: 30 } } })), false);
  assert.equal(conditionMet(gd, slayer, ctx({ statistics: {} })), null, 'list not in the save');
  assert.equal(conditionMet(gd, { type: 'technique', technique: 'Climbing', level: 15 }, ctx({ agilityTechniques: { Climbing: { level: 15 } } })), true);
  assert.equal(conditionMet(gd, { type: 'technique', technique: 'Climbing', level: 15 }, ctx({})), null);
  const five = { type: 'techniques', count: 5, level: 5 };
  const techs = (levels) => Object.fromEntries(levels.map((level, i) => [`T${i}`, { level }]));
  assert.equal(conditionMet(gd, five, ctx({ agilityTechniques: techs([5, 6, 9, 5, 5]) })), true);
  assert.equal(conditionMet(gd, five, ctx({ agilityTechniques: techs([5, 6, 9, 5, 4]) })), false);
  // Totals the game works out on load (Astrology nodes) aren't saved.
  assert.equal(conditionMet(gd, { type: 'value', stat: 'AstrologyTotalMajorNodesUnlocked', value: 4 }, ctx({ statistics: {} })), null);

  // Real data: every condition type in these skills is now one the companion evaluates.
  for (const skill of ['Agility', 'Ranching', 'Slayer']) {
    const kinds = new Set(gd.raw.mastery[skill].tasks.map((t) => t.condition?.type).filter(Boolean));
    assert.ok(!kinds.has('other'), `${skill}: ${[...kinds]}`);
  }
  const ranching = gd.raw.mastery.Ranching.tasks.find((t) => t.condition?.stat === 'RanchingAnimalTimeSpentAliveStatistic');
  assert.equal(taskDone(gd, ranching, { goalComplete: true, triggerMet: true }, ctx({ statistics: { RanchingAnimalTimeSpentAliveStatistic: { [ranching.condition.id]: ranching.condition.value } } })), true);
});
