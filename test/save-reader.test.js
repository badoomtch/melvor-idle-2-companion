import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brotliCompressSync } from 'node:zlib';
import { defaultXpTable } from '../engine/xp.js';
import { parseSave, SaveFormatError } from '../server/save-reader.js';
import { buildSave, Writer } from './save-writer.js';

const lvl = (level, extra = 0) => ({ xp: defaultXpTable.xpForLevel(level) + extra, level });

test('reads the header exactly as written', () => {
  const ts = Date.UTC(2026, 9, 27, 18, 30, 15, 250);
  const save = parseSave(buildSave({
    uuid: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
    name: 'Ünïcode Hero',
    timestamp: ts,
    activeEntityName: 'Thieving',
    activeActionName: 'Citizen',
    totalLevel: 321,
    gp: 9_876_543_210,
    slayerCoins: 77,
  }));
  assert.equal(save.version, 26);
  assert.equal(save.header.uuid, '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9');
  assert.equal(save.header.characterName, 'Ünïcode Hero');
  assert.equal(save.header.timestamp, ts);
  assert.equal(save.header.timestampKind, 'local');
  assert.equal(save.header.activeEntityName, 'Thieving');
  assert.equal(save.header.activeActionName, 'Citizen');
  assert.equal(save.header.totalLevel, 321);
  assert.equal(save.header.gp, 9_876_543_210);
  assert.equal(save.header.slayerCoins, 77);
  assert.equal(save.header.isDemo, true);
});

test('reads and verifies skill levels against the XP curve', () => {
  const save = parseSave(buildSave({ skills: { Woodcutting: lvl(32, 500), Thieving: lvl(1), Attack: lvl(60, 1e6) } }));
  assert.deepEqual(Object.keys(save.skills).sort(), ['Attack', 'Thieving', 'Woodcutting']);
  assert.equal(save.skills.Woodcutting.level, 32);
  assert.equal(save.skills.Woodcutting.verified, true);
  assert.equal(save.skills.Attack.verified, true, 'level is capped at 60 even with extra XP');
  assert.deepEqual(save.warnings, []);
});

test('flags a level that does not match its XP', () => {
  const save = parseSave(buildSave({ skills: { Mining: { xp: defaultXpTable.xpForLevel(10), level: 40 } } }));
  assert.equal(save.skills.Mining.verified, false);
  assert.match(save.warnings.join(), /Mining/);
});

test('aggregates bank stacks across tabs, and counts empty placeholders as used slots like the game', () => {
  const save = parseSave(buildSave({
    bank: {
      tabs: [
        // Real saves flag full stacks as placeholders when automatic placeholders are on.
        { label: 'Main', stacks: [{ item: 'MelvorBase:OakLog', qty: 120, placeholder: true }, { item: 'MelvorBase:Shrimp', qty: 0, placeholder: true }], tags: [{ isProduct: true, isIngredient: false, id: 'MelvorBase:Logs' }] },
        { label: '', stacks: [{ item: 'MelvorBase:OakLog', qty: 30, locked: true }, { item: 'MelvorBase:CopperOre', qty: 5 }] },
      ],
    },
  }));
  assert.deepEqual(save.bank.items, { 'MelvorBase:OakLog': 150, 'MelvorBase:CopperOre': 5 });
  assert.equal(save.bank.tabs, 2);
  assert.equal(save.bank.stacks, 4, 'the empty Shrimp placeholder still takes a slot');
  assert.deepEqual(save.bank.empty, ['MelvorBase:Shrimp']);
  assert.deepEqual(save.bank.kept, ['MelvorBase:OakLog'], 'stacks that stay as placeholders when they run out');
});

test('reads which Agility path is running and which one each course has picked', () => {
  const course = (id, paths, picked) => (c) => c.str(`MelvorBase:${id}`).region((r) => {
    r.i32(paths.length);
    for (const p of paths) r.str(`MelvorBase:${p}`).region((x) => x.i32(0));
    r.bool(true).str(`MelvorBase:${picked}`);
  });
  const action = (c) => {
    c.bool(true).bool(true).str('MelvorBase:ClimbTraining');
    c.bool(true).str('MelvorBase:Climb3').bool(true).str('MelvorBase:Climb3AdvancedPath');
    c.i32(2);
    course('Climb1', ['Climb1SimplePath'], 'Climb1SimplePath')(c);
    course('Climb3', ['Climb3SimplePath', 'Climb3AdvancedPath'], 'Climb3SimplePath')(c);
    c.raw(Buffer.alloc(13)); // the action timer
  };
  const save = parseSave(buildSave({ activeEntityName: 'Agility', activeActionName: 'Climb 3', skills: { Mining: lvl(10) }, extraEntities: [['MelvorBase:Agility', [['Action', action]]]] }));
  assert.equal(save.header.activePath, 'Climb3AdvancedPath', 'running');
  assert.equal(save.header.pickedPath, 'Climb3SimplePath', 'picked in the Select Path box');
  assert.deepEqual(save.warnings, []);
});

test('accepts levels above the demo cap when the XP supports them', () => {
  const save = parseSave(buildSave({ skills: { Mining: lvl(75, 100) } }), { levelCap: 60 });
  assert.equal(save.skills.Mining.level, 75);
  assert.equal(save.skills.Mining.verified, true);
});

test('reads saves whose Brotli stream has no end marker, like the game writes', () => {
  const full = buildSave({ name: 'Unterminated', skills: { Thieving: lvl(12) } });
  const save = parseSave(full.subarray(0, full.length - 2));
  assert.equal(save.header.characterName, 'Unterminated');
  assert.equal(save.skills.Thieving.level, 12);
});

test('handles the older experience layout and pre-tag bank tabs', () => {
  const save = parseSave(buildSave({ version: 12, skills: { Fishing: lvl(15) }, bank: { tabs: [{ stacks: [{ item: 'MelvorBase:Shrimp', qty: 3 }] }] } }));
  assert.equal(save.skills.Fishing.level, 15);
  assert.equal(save.skills.Fishing.verified, true);
  assert.deepEqual(save.bank.items, { 'MelvorBase:Shrimp': 3 });
  assert.equal(save.header.isDemo, false);
});

test('skips entities that do not use the component layout', () => {
  const weird = new Writer().f64(1).str('not components').toBuffer();
  const save = parseSave(buildSave({ skills: { Cooking: lvl(20) }, extraEntities: [['MelvorBase:Combat', weird]] }));
  assert.equal(save.skills.Cooking.level, 20);
});

test('rejects files that are not saves', () => {
  assert.throws(() => parseSave(Buffer.from('hello world')), SaveFormatError);
  assert.throws(() => parseSave(brotliCompressSync(Buffer.from([1, 2]))), SaveFormatError);
});

test('reports a corrupt bank without losing skills', () => {
  const save = parseSave(buildSave({ skills: { Smithing: lvl(5) }, bank: { tabs: [{ stacks: [{ item: 'not an id!', qty: 1 }] }] } }));
  assert.equal(save.skills.Smithing.level, 5);
  assert.ok(save.bank.error);
});

test('header-only mode stops before the body', () => {
  const save = parseSave(buildSave({ name: 'Quick', skills: { Agility: lvl(3) } }), { headerOnly: true });
  assert.equal(save.header.characterName, 'Quick');
  assert.deepEqual(save.skills, {});
});

// EquipmentComponent / ToolbeltComponent / PlayerComponent layouts, as checked against a real save.
const slot = (c, { qty = 1, occupied = false, item = null } = {}) => c.region((g) => {
  g.i32(qty).bool(occupied).bool(!!item);
  if (item) g.str(item);
});
const toolSlot = (c, item) => c.region((g) => {
  g.i32(1).bool(!!item);
  if (item) g.str(item);
});

test('reads equipped gear, stored loadouts, stances, food, spell and toolbelts', () => {
  const combat = ['MelvorBase:Combat', [
    ['Equipment', (c) => {
      c.i32(4);
      c.str('MelvorBase:Weapon'); slot(c, { item: 'MelvorBase:AirStaff' });
      c.str('MelvorBase:Offhand'); slot(c, { qty: -1, occupied: true, item: 'MelvorBase:AirStaff' });
      c.str('MelvorBase:Ammo'); slot(c, { qty: -1 });
      c.str('MelvorBase:Helmet'); slot(c, { item: 'MelvorBase:AdeptWizardHat' });
      c.i32(1);
      c.str('MelvorBase:Loadout2');
      c.region((g) => {
        g.i32(2);
        g.str('MelvorBase:Weapon'); slot(g, { item: 'MelvorBase:WillowBow' });
        g.str('MelvorBase:Ammo'); slot(g, { qty: 95, item: 'MelvorBase:IronArrows' });
      });
    }],
    ['Player', (c) => {
      c.region((g) => g.i32(500)).region((g) => g.i32(0)).region((g) => g.i32(0));
      c.i32(0).bool(false); // idle turn
      c.i32(0).i64(123456n);
      c.i32(1).str('MelvorBase:Stab').bool(false);
      c.i32(2).str('MelvorBase:Staff').str('MelvorBase:Offensive').str('MelvorBase:Bow').str('MelvorBase:Accurate');
      c.i32(1).str('MelvorBase:Loadout2').str('MelvorBase:Accurate');
    }],
    ['Food', (c) => c.bool(true).str('MelvorBase:Mackerel').i32(0).i32(0).bool(false).bool(false).i32(0).i32(0)],
    ['Loadouts', (c) => {
      c.str('MelvorBase:Loadout3');
      c.i32(2);
      c.str('MelvorBase:Loadout2').region((g) => g.str('Ranged').bool(true));
      c.str('MelvorBase:Loadout3').region((g) => g.str('Magic').bool(true));
      c.i32(0);
    }],
    ['MagicSpells', (c) => c.bool(true).str('MelvorBase:AirBolt').bool(false).bool(false)],
  ]];
  const woodcutting = ['MelvorBase:Woodcutting', [
    ['Experience', (c) => c.f64(0).i32(1)],
    ['Toolbelt', (c) => {
      c.i32(2);
      c.str('MelvorBase:WoodcuttingAxe'); toolSlot(c, 'MelvorBase:ReinforcedWoodcuttersAxe');
      c.str('MelvorBase:WoodcuttingGloves'); toolSlot(c, null);
      c.i32(0);
    }],
  ]];
  const save = parseSave(buildSave({ version: 27, extraEntities: [combat, woodcutting] }));
  assert.deepEqual(save.warnings, []);
  assert.deepEqual(save.combat.equipped, { Weapon: { item: 'MelvorBase:AirStaff', qty: 1 }, Helmet: { item: 'MelvorBase:AdeptWizardHat', qty: 1 } }, 'two-handed spill-over and empty slots are skipped');
  assert.deepEqual(save.combat.storedLoadouts.Loadout2.Ammo, { item: 'MelvorBase:IronArrows', qty: 95 });
  assert.equal(save.combat.currentLoadout, 'Loadout3');
  assert.deepEqual(save.combat.loadoutNames, { Loadout2: 'Ranged', Loadout3: 'Magic' });
  assert.deepEqual(save.combat.stances, { byWeaponType: { Staff: 'Offensive', Bow: 'Accurate' }, byLoadout: { Loadout2: 'Accurate' } });
  assert.equal(save.combat.food, 'MelvorBase:Mackerel');
  assert.equal(save.combat.spell, 'MelvorBase:AirBolt');
  assert.deepEqual(save.toolbelts, { Woodcutting: [{ item: 'MelvorBase:ReinforcedWoodcuttersAxe', qty: 1, slot: 'WoodcuttingAxe' }] });
});

test('a combat block it cannot read becomes a warning, not a failure', () => {
  const broken = ['MelvorBase:Combat', [['Equipment', (c) => c.i32(1).str('MelvorBase:Weapon').region((g) => g.i32(1))]]];
  const save = parseSave(buildSave({ version: 27, skills: { Attack: lvl(5) }, extraEntities: [broken] }));
  assert.equal(save.combat, undefined);
  assert.equal(save.skills.Attack.level, 5);
  assert.ok(save.warnings.some((w) => w.startsWith('Combat gear')));
});

test('reads kill counts from the Combat statistics by id', () => {
  const combat = ['MelvorBase:Combat', [
    ['Statistics', (c) => {
      c.i32(1).str('MelvorBase:CombatDamageDealt').region((g) => g.f64(123));
      c.i32(1).str('MelvorBase:CombatEnemyKilled').region((g) => {
        g.i32(2);
        g.f64(467).str('MelvorBase:Golbin');
        g.f64(3).str('MelvorBase:Bee');
      });
      c.i32(0);
    }],
  ]];
  const save = parseSave(buildSave({ version: 27, skills: { Attack: lvl(5) }, extraEntities: [combat] }));
  assert.deepEqual(save.enemiesKilled, { Golbin: 467, Bee: 3 });
  assert.deepEqual(save.warnings, []);
});

test('reads Mastery Guild task states and item statistics from a skill', () => {
  const crafting = ['MelvorBase:Crafting', [
    ['MasteryGuild', (c) => {
      c.bool(false); // no category selected
      c.i32(2);
      c.str('MelvorBase:CraftingTask1').region((g) => g.bool(false).bool(false));
      c.str('MelvorBase:CraftingTask9').region((g) => {
        g.bool(true).str('0').region((goal) => goal.f64(200).bool(true).bool(false));
        g.bool(true);
      });
    }],
    ['Statistics', (c) => {
      c.i32(1).str('MelvorBase:CraftingActions').region((g) => g.f64(12));
      c.i32(1).str('MelvorBase:CraftingItemGained').region((g) => g.i32(1).f64(400).str('MelvorBase:Topaz'));
      c.i32(0);
    }],
  ]];
  const save = parseSave(buildSave({ version: 27, skills: { Attack: lvl(5) }, extraEntities: [crafting] }));
  assert.deepEqual(save.mastery.Crafting, {
    CraftingTask1: { goalComplete: null, triggerMet: false },
    CraftingTask9: { goalComplete: true, goalProgress: 200, triggerMet: true },
  });
  assert.deepEqual(save.statistics, { CraftingActions: 12, CraftingItemGained: { Topaz: 400 } });
  assert.deepEqual(save.warnings, []);
});

test('reads Agility technique levels', () => {
  const agility = ['MelvorBase:Agility', [
    ['Techniques', (c) => {
      c.i32(2);
      c.str('MelvorBase:Climbing').region((g) => g.f64(941).i32(5));
      c.str('MelvorBase:Jumping').region((g) => g.f64(0).i32(1));
    }],
  ]];
  const save = parseSave(buildSave({ version: 27, skills: { Attack: lvl(5) }, extraEntities: [agility] }));
  assert.deepEqual(save.agilityTechniques, { Climbing: { xp: 941, level: 5 }, Jumping: { xp: 0, level: 1 } });
});

test('0.11.5 saves keep only XP: levels come from each experience table, and quest tasks have a new flag', () => {
  // Skills, Agility techniques and journal entries write just their XP (BaseExperience); a quest task
  // writes whether its condition goals are confirmed before its state, and the quest list is followed by
  // the quest page's settings.
  const agility = ['MelvorBase:Agility', [
    ['Techniques', (c) => {
      c.i32(3);
      c.str('MelvorBase:Climbing').region((g) => g.f64(941));
      c.str('MelvorBase:Jumping').region((g) => g.f64(0));
      c.str('MelvorBase:Evading').region((g) => g.f64(1e9));
    }],
  ]];
  const journal = (c) => {
    c.i32(2);
    c.str('MelvorBase:WildChicken').region((e) => e.bool(true).f64(183).bool(false).f64(0).f64(0));
    c.str('MelvorBase:Griffin').region((e) => e.bool(true).f64(1e9).bool(false).f64(0).f64(0));
    c.i32(0).i32(0);
  };
  const task = (c) => c.i32(1).str('Goal1').region((g) => g.f64(3).bool(true).bool(true)).bool(true).bool(true).bool(true).i32(2);
  const quests = (c) => {
    c.i32(1);
    c.str('MelvorBase:MQ10').region((q) => q.i32(1).i32(1).str('Step1').region((s) => s.i32(1).str('Task1').region(task).bool(true).i32(1)));
    c.bool(true).bool(false).bool(false).i32(0); // the quest page's filters, no quest selected, no custom NPCs
  };
  const save = parseSave(buildSave({ version: 29, skills: { Attack: lvl(42, 10), Woodcutting: lvl(120, 5e9) }, extraEntities: [agility, ['MelvorBase:Hunting', [['Journal', journal]]], ['MelvorBase:Quests', [['Quests', quests]]]] }), { levelCap: 120, techniqueCaps: { Evading: 40 } });
  assert.deepEqual(save.warnings, []);
  assert.equal(save.newerThanSupported, false);
  assert.deepEqual([save.skills.Attack.level, save.skills.Woodcutting.level], [42, 120], 'levels from XP, up to the cap');
  assert.ok(save.skills.Attack.verified);
  // The same levels 0.11.4 saves stored (941 XP was technique level 5, 183 journal XP level 6).
  assert.deepEqual(save.agilityTechniques, { Climbing: { xp: 941, level: 5 }, Jumping: { xp: 0, level: 1 }, Evading: { xp: 1e9, level: 40 } });
  assert.deepEqual(save.huntingJournal, { WildChicken: { level: 6, xp: 183 }, Griffin: { level: 25, xp: 1e9 } });
  assert.deepEqual(save.quests.MQ10.steps.Step1.tasks.Task1, { goals: { Goal1: { progress: 3, complete: true, active: true } }, visible: true, costsMet: true, state: 'complete' });
});

test('reads each Hunting animal journal level', () => {
  const entry = (discovered, xp, level) => (c) => c.bool(discovered).f64(xp).i32(level).bool(false).f64(0).f64(0);
  const journal = (c) => {
    c.i32(2);
    c.str('MelvorBase:WildChicken').region(entry(true, 183, 6));
    c.str('MelvorBase:Griffin').region(entry(false, 0, 1));
    c.i32(0).i32(0);
  };
  const save = parseSave(buildSave({ skills: { Mining: lvl(10) }, extraEntities: [['MelvorBase:Hunting', [['Journal', journal]]]] }));
  assert.deepEqual(save.huntingJournal, { WildChicken: { level: 6, xp: 183 }, Griffin: { level: 1, xp: 0, discovered: false } }, 'undiscovered animals are marked');
  assert.deepEqual(save.warnings, []);
});

test('reads each Hunting animal\'s trap, "Use Bait?" and "Enable Trapless Hunting"', () => {
  // ActiveHuntingAnimal.WriteTo: tracks, step, steps, [trap], species set, [species], state, use bait,
  // survey fails, bait used, trap misses, trapless.
  const hunt = ({ trap = null, useBait = false, trapless = false }) => (c) => {
    c.i32(3).i32(1).i32(4).bool(!!trap);
    if (trap) c.str(trap);
    c.bool(true).bool(true).str('MelvorBase:GoldenChicken').i32(2).bool(useBait).i32(0).bool(false).i32(1).bool(trapless);
  };
  const action = (c) => {
    c.bool(false).bool(false).i32(0).i32(0).i32(0);
    c.i32(2);
    c.str('MelvorBase:WildChicken').region(hunt({ trap: 'MelvorBase:BasicSnare', useBait: true }));
    c.str('MelvorBase:GreenButterfly').region(hunt({ trapless: true }));
    c.bool(true).bool(false).bool(false).bool(false).bool(true);
  };
  const save = parseSave(buildSave({ skills: { Mining: lvl(10) }, extraEntities: [['MelvorBase:Hunting', [['Action', action]]]] }));
  assert.deepEqual(save.huntingAnimals, {
    WildChicken: { trap: 'MelvorBase:BasicSnare', useBait: true, trapless: false },
    GreenButterfly: { trap: null, useBait: false, trapless: true },
  });
  assert.deepEqual(save.warnings, []);
});

test('reads the bonfire and each skill Aurora', () => {
  const bonfire = (c) => c.i32(1_728_000).i32(216_000).bool(false).bool(true).str('MelvorBase:Willow').bool(true);
  const aurora = (c) => c.bool(true).i32(0).i32(3600).i32(1200).bool(true).str('MelvorBase:WoodcuttingAurora').region((e) => e.bool(true).i32(42));
  const quiet = (c) => c.bool(true).i32(0).i32(3600).i32(1200).bool(false);
  const save = parseSave(buildSave({
    skills: { Mining: lvl(10) },
    extraEntities: [['MelvorBase:Firemaking', [['Bonfire', bonfire]]], ['MelvorBase:Woodcutting', [['RareEvents', aurora]]], ['MelvorBase:Fishing', [['RareEvents', quiet]]]],
  }));
  assert.deepEqual(save.bonfire, { bonfire: 'Willow', active: true, paused: false, ticksLeft: 216_000, maxTicks: 1_728_000 });
  assert.deepEqual(save.auroras, { Woodcutting: { event: 'WoodcuttingAurora', activated: true, charges: 42 } });
  assert.deepEqual(save.warnings, []);
});
