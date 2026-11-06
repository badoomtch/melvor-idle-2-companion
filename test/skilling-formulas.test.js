// Skilling rates against the game's own formulas (0.11.4): each test is one rule from the game's code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { computeRates, huntingTodo, miningExpectedHits, woodcuttingHits } from '../engine/rates.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const method = (key) => gd.methodByKey.get(key);
const bonus = (m, stat, value, scope) => ({ stat, value, skill: m.skill, ...(scope ? { scope } : {}) });
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const out = (r, item) => r.outputs.find((o) => o.item === item)?.perHour ?? 0;

test('thieving: a failure hits for 1 to the max damage, so the average is (max + 1) / 2', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && x.damage > 10 && x.perception > 50);
  const r = computeRates(gd, m, m.level, { bonuses: [] });
  const s = r.successChance;
  close(r.hpLossPerHour / r.cyclesPerHour, (1 - s) * ((m.damage + 1) / 2));
});

test('thieving: heist bonuses take stages off, and fortune adds to every drop', () => {
  const m = method('Thieving/ForbiddenLibrary');
  const base = computeRates(gd, m, 99, { bonuses: [] });
  const fewer = computeRates(gd, m, 99, { bonuses: [bonus(m, 'FlatStages', -4, { Recipe: m.id })] });
  close(fewer.xpPerHour / base.xpPerHour, m.stages / (m.stages - 4), 1e-9);
  const rich = computeRates(gd, m, 99, { bonuses: [bonus(m, 'FlatFortune', 100)] });
  const item = base.outputs[0].item;
  assert.ok(out(rich, item) > out(base, item) * 1.9, 'Fortune 100 doubles each drop (rounded down)');
});

test('thieving: perception bonuses change the success chance the way the game rounds them', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && x.perception >= 200);
  const r = computeRates(gd, m, m.level, { bonuses: [bonus(m, 'FlatPerception', -35)] });
  close(r.successChance, Math.min(1, (100 + m.level) / (100 + Math.floor(m.perception - 35))));
});

test('woodcutting: tree health rounds up, and instant cuts fell the tree in one hit', () => {
  const m = method('Woodcutting/NormalTree');
  const slimmer = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentMaxHealth', -0.2)] });
  close(slimmer.cyclesPerHour, 3_600_000 / (Math.ceil(m.maxHealth * 0.8) * m.interval));
  assert.equal(woodcuttingHits(14, 0, 0), 14);
  assert.ok(woodcuttingHits(14, 0.06, 0) < 10, 'a 6% instant cut takes Yew from 14 hits to under 10');
  assert.equal(woodcuttingHits(1, 0.5, 0.5), 1, 'the last point of health is always one hit');
});

test('mining: a minimum prospecting head start shortens every rock after the first', () => {
  assert.ok(miningExpectedHits(0.1, 0.3) < miningExpectedHits(0.1, 0));
  const m = gd.methods.find((x) => x.kind === 'mining' && x.breakChance < 0.5);
  const essence = computeRates(gd, m, 99, { bonuses: [bonus(m, 'EssenceItemChance', 0.05)] });
  assert.ok(essence.outputs.some((o) => /Essence/.test(o.item)), 'an essence pickaxe drops essence while you mine');
});

test('fishing: the min and max catch times take their own percentage bonuses', () => {
  const m = gd.methods.find((x) => x.kind === 'fishing' && x.maxInterval > x.minInterval);
  const r = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentMinInterval', -0.1), bonus(m, 'PercentMaxInterval', -0.1)] });
  close(r.cyclesPerHour, 3_600_000 / ((Math.floor(m.minInterval * 0.9) + Math.floor(m.maxInterval * 0.9)) / 2));
});

test('farming: trees regrow from one seed, pests and disease cut the yield, and flowers give no harvest', () => {
  const apple = method('Farming/AppleTree');
  const r = computeRates(gd, apple, 99, { bonuses: [] });
  const harvests = 1 + apple.regrows;
  close(r.cyclesPerHour, 3_600_000 / (apple.interval + apple.regrows * apple.regrowInterval));
  const exposed = apple.pests + Math.max(0, apple.disease - apple.watering);
  close(out(r, apple.product.item) / r.cyclesPerHour, harvests * Math.trunc(apple.product.qty * (1 - exposed / 100)));
  close(r.xpPerHour / r.cyclesPerHour, harvests * apple.xp);
  const scarecrow = computeRates(gd, apple, 99, { bonuses: [bonus(apple, 'FlatPestProtection', 15)] });
  assert.ok(out(scarecrow, apple.product.item) > out(r, apple.product.item), 'pest protection saves part of every harvest');
  const flower = gd.methods.find((x) => x.flower);
  const f = computeRates(gd, flower, 99, { bonuses: [] });
  assert.equal(f.xpPerHour, 0);
  assert.equal(f.outputs.length, 0);
});

test('herblore: each stage of the batch takes its own interval bonus', () => {
  const m = gd.methods.find((x) => x.skill === 'Herblore' && x.batch?.heating > 0);
  const r = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentHeatingInterval', -0.5)] });
  const b = m.batch;
  close(r.cyclesPerHour, 3_600_000 / ((b.preparing + Math.floor(b.heating * 0.5) + b.stirring + b.bottlings * b.bottling) / b.bottlings));
});

test('cooking and firemaking keep their materials with preservation, like crafting', () => {
  for (const kind of ['cooking', 'firemaking']) {
    const m = gd.methods.find((x) => x.kind === kind && x.ingredients.length);
    const base = computeRates(gd, m, 99, { bonuses: [] });
    const kept = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PreservationChance', 0.2)] });
    close(kept.inputs[0].perHour, base.inputs[0].perHour * 0.8);
  }
});

test('crafting adds a flat interval change after the percentage; gathering before it', () => {
  const craft = gd.methods.find((x) => x.kind === 'artisan' && !x.batch && x.interval >= 2000);
  const c = computeRates(gd, craft, 99, { bonuses: [bonus(craft, 'PercentInterval', -0.1), bonus(craft, 'FlatInterval', -100)] });
  close(c.msPerCycle, craft.steps * Math.floor(craft.interval * 0.9 - 100));
  const ore = method('Mining/CopperOre') ?? gd.methods.find((x) => x.kind === 'mining');
  const o = computeRates(gd, ore, 99, { bonuses: [bonus(ore, 'PercentInterval', -0.1), bonus(ore, 'FlatInterval', -100)] });
  close(o.msPerCycle / miningExpectedHits(ore.breakChance), Math.floor((ore.interval - 100) * 0.9));
});

test('hunting: a higher journal level means bigger catches and its own bonuses for that animal', async () => {
  const { playerBonuses, playerState } = await import('../engine/gamedata.js');
  const m = method('Hunting/WildChicken');
  const fresh = computeRates(gd, m, m.level, { bonuses: [], journalLevel: 1 });
  const known = computeRates(gd, m, m.level, { bonuses: [], journalLevel: 25 });
  close(known.xpPerHour / fresh.xpPerHour, (0.9 + 0.25) / (0.9 + 0.01));
  const save = { skills: {}, huntingJournal: { WildChicken: { level: 10, xp: 0 } } };
  gd.player = playerState(save, gd);
  const effects = playerBonuses(gd, save).filter((e) => e.scope?.Recipe === 'WildChicken');
  gd.player = null;
  assert.ok(effects.length > 0, 'journal levels 2 to 10 give Wild Chicken bonuses');
  const faster = computeRates(gd, m, m.level, { bonuses: effects, journalLevel: 10 });
  assert.ok(faster.cyclesPerHour > computeRates(gd, m, m.level, { bonuses: [], journalLevel: 10 }).cyclesPerHour);
  assert.equal(computeRates(gd, method('Hunting/WildCow'), 99, { bonuses: effects, journalLevel: 10 }).bonuses, undefined, 'and only for that animal');
});

test('a lit bonfire adds XP to every skill, and an Aurora its own bonuses, only while they last', async () => {
  const { playerBonuses } = await import('../engine/gamedata.js');
  const lit = { skills: {}, bonfire: { bonfire: 'Willow', active: true, paused: false, ticksLeft: 1000, maxTicks: 2000 } };
  const xp = playerBonuses(gd, lit).filter((e) => e.stat === 'PercentXPGained' && /Bonfire/.test(e.source));
  assert.equal(new Set(xp.map((e) => e.skill)).size, gd.skills.length, 'one for every skill');
  assert.equal(playerBonuses(gd, { ...lit, bonfire: { ...lit.bonfire, ticksLeft: 0 } }).filter((e) => /Bonfire/.test(e.source ?? '')).length, 0, 'burnt out');
  const aurora = playerBonuses(gd, { skills: {}, auroras: { Woodcutting: { event: 'WoodcuttingAurora', activated: true, charges: 10 } } });
  const m = method('Woodcutting/NormalTree');
  assert.ok(computeRates(gd, m, 99, { bonuses: aurora }).xpPerHour > computeRates(gd, m, 99, { bonuses: [] }).xpPerHour);
});

test('hunting: a rare species doubles the catch and brings its own drops', () => {
  const m = method('Hunting/WildChicken');
  const none = computeRates(gd, { ...m, rareChance: 0 }, 20, { bonuses: [] });
  const all = computeRates(gd, { ...m, rareChance: 1 }, 20, { bonuses: [] });
  const feathers = m.products[0].item;
  assert.ok(out(all, feathers) > out(none, feathers) * 1.9, 'products doubled');
  const egg = m.rareSpecies.find((s) => s.extra.length).extra[0].item;
  assert.equal(out(none, egg), 0);
  assert.ok(out(all, egg) > 0, 'the Golden Egg only comes from the Golden Chicken');
});

test('thieving: the same-area bonus also robs the other targets of that type nearby', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && gd.methods.some((y) => y !== x && y.kind === 'thieving' && y.category === x.category && y.type === x.type && y.level <= x.level));
  const base = computeRates(gd, m, 99, { bonuses: [] });
  const more = computeRates(gd, m, 99, { bonuses: [bonus(m, 'SameAreaPickpocketChance', 0.1)] });
  assert.ok(more.grossPerHour > base.grossPerHour, 'more loot');
  assert.equal(more.xpPerHour, base.xpPerHour, 'but no extra XP');
});

test('hunting: the preferred bait speeds trapping while you have some, and trapless hunting needs no traps', () => {
  const m = method('Hunting/WildChicken');
  const levels = { Hunting: 99, Strength: 99 };
  const run = (owned, lv = levels) => {
    gd.player = { owned, levels: lv, huntingJournal: { WildChicken: { level: 1 } } };
    gd.playerBonuses = [];
    const r = computeRates(gd, m, 99);
    gd.player = null;
    gd.playerBonuses = null;
    return r;
  };
  const snare = m.traps[0].item;
  const plain = run({ [snare]: 100 });
  const baited = run({ [snare]: 100, [m.bait.item]: 100 });
  assert.ok(baited.cyclesPerHour > plain.cyclesPerHour, 'bait cuts the trapping time');
  assert.ok(baited.inputs.some((i) => i.item === m.bait.item), 'one bait per trap attempt');
  assert.ok(!plain.inputs.some((i) => i.item === m.bait.item));
  const trapless = run({});
  assert.ok(trapless.successChance > plain.successChance, 'trapless adds its success bonus');
  assert.ok(!trapless.inputs.some((i) => i.item === snare), 'and uses no snares');
  assert.ok(!run({}, { Hunting: 10, Strength: 1 }).note.includes('trapless'), 'only once its levels are met');
});

test('hunting: says what to tick in the game, from what the save shows is set for that animal', () => {
  const butterfly = method('Hunting/GreenButterfly');
  const chicken = method('Hunting/WildChicken');
  const kit = butterfly.traps[0].item;
  const snare = chicken.traps[0].item;
  // Green Butterfly without a trap needs Hunting 30 and two Agility techniques at level 10.
  const todo = (m, owned, animals, techniques = { Climbing: 15, Evading: 19 }) => {
    gd.player = { owned, levels: { Hunting: 34, Strength: 50 }, techniques, huntingAnimals: animals };
    try {
      return { todo: huntingTodo(gd, m), note: computeRates(gd, m, 34).note };
    } finally {
      gd.player = null;
    }
  };
  // No kit: trapless, and the game needs it ticked.
  assert.deepEqual(todo(butterfly, {}, { GreenButterfly: { trap: kit, useBait: false, trapless: false } }).todo, [{ kind: 'trapless' }]);
  assert.deepEqual(todo(butterfly, {}, { GreenButterfly: { trap: kit, useBait: false, trapless: true } }).todo, []);
  // One technique at 10 isn't enough: then it needs a kit, which you don't have.
  const short = todo(butterfly, {}, null, { Climbing: 15, Evading: 9 });
  assert.ok(!short.note.includes('trapless'));
  assert.deepEqual(short.todo, []);
  // Ticked in the game: trapless even with kits in the bank, as the game does.
  assert.ok(todo(butterfly, { [kit]: 5 }, { GreenButterfly: { trap: kit, useBait: false, trapless: true } }).note.includes('trapless'));
  // Bait only counts with "Use Bait?" ticked; a trap has to be selected, and one you have.
  const bait = chicken.bait.item;
  assert.deepEqual(todo(chicken, { [snare]: 10, [bait]: 10 }, { WildChicken: { trap: null, useBait: false, trapless: false } }).todo, [{ kind: 'bait', item: bait }, { kind: 'trap', item: snare }]);
  assert.deepEqual(todo(chicken, { [snare]: 10 }, { WildChicken: { trap: snare, useBait: false, trapless: false } }).todo, []);
  // No save settings: all of it.
  assert.deepEqual(todo(butterfly, {}, null).todo, [{ kind: 'trapless' }]);
});

test('hunting: surveys can turn up one find per catch, and an undiscovered animal takes longer', () => {
  const m = method('Hunting/WildChicken');
  const r = computeRates(gd, m, 99, { bonuses: [] });
  const find = m.survey[0];
  const per = out(r, find.item) / r.cyclesPerHour;
  assert.ok(per > find.chance * find.qty * 0.99 && per <= 1, 'at least one survey per catch, at most one find');
  gd.player = { huntingJournal: { WildChicken: { level: 1, xp: 0, discovered: false } } };
  const hidden = computeRates(gd, m, 99, { bonuses: [] });
  gd.player = null;
  assert.match(hidden.note, /not discovered/);
  assert.ok(hidden.cyclesPerHour < r.cyclesPerHour);
});

test('astrology: every study can sight a Starfall, worth more the higher your level', () => {
  const m = gd.methods.find((x) => x.kind === 'astrology');
  const ev = m.events.find((e) => e.name === 'Starfall');
  const r = computeRates(gd, m, 50, { bonuses: [] });
  close(out(r, ev.item) / r.cyclesPerHour, ev.chance * (ev.qty + 50 * ev.perLevel));
  close(r.chancePerCycle[ev.item], ev.chance);
  const lucky = computeRates(gd, m, 50, { bonuses: [{ stat: 'PercentEventChance', value: 1, skill: 'Astrology', scope: { Event: 'Starfall' } }] });
  close(out(lucky, ev.item), out(r, ev.item) * 2);
  const meteor = m.events.find((e) => e.name === 'Meteor Shower').item;
  close(out(lucky, meteor), out(r, meteor), 1e-9);
});

test('firemaking: Fireflies need their Astrology node, and the find grows with the burn time', () => {
  const m = method('Firemaking/MagicLog');
  const fly = m.events.find((e) => e.name === 'Fireflies');
  assert.equal(out(computeRates(gd, m, 99, { bonuses: [] }), fly.item), 0, 'not counted while the node is unknown');
  gd.player = { astrologyNodes: ['AmeriaMajor4'], levels: {}, owned: {}, toolbelts: {} };
  const r = computeRates(gd, m, 99, { bonuses: [] });
  const doubled = computeRates(gd, m, 99, { bonuses: [{ stat: 'DoublingChance', value: 1, skill: 'Firemaking' }] });
  gd.player = null;
  close(out(r, fly.item) / r.cyclesPerHour, fly.chance * Math.floor(fly.qty * (m.interval / 1000)));
  close(out(doubled, fly.item), out(r, fly.item), 1e-9);
});

test('mining: a shatter triples the ore and doubles the XP, and a pickaxe can turn ore into its bar', () => {
  const m = method('Mining/IronOre');
  const base = computeRates(gd, m, 99, { bonuses: [] });
  const shatter = computeRates(gd, m, 99, { bonuses: [bonus(m, 'ShatterChance', 0.03)] });
  close(out(shatter, m.product.item), out(base, m.product.item) * 1.06);
  close(shatter.xpPerHour, base.xpPerHour * 1.03);
  const bars = computeRates(gd, m, 99, { bonuses: [bonus(m, 'BarItemChance', 0.05)] });
  close(out(bars, m.bar) / bars.cyclesPerHour, 0.05);
});

test('mastery: node totals, journal levels, rare species and collectables count from the save', async () => {
  const { conditionMet } = await import('../engine/mastery.js');
  const save = {
    astrology: { Deedree: { knowledge: 0, minor: ['a', 'b', 'c'], major: ['x'] }, Terra: { knowledge: 0, minor: ['d'], major: [] } },
    huntingJournal: { WildChicken: { level: 6 }, WildCow: { level: 9 }, Griffin: { level: 1 } },
    statistics: { HuntingAnimalSpeciesTrapped: { GoldenChicken: 2 }, BankItemFound: { GoldenEggCollectable: 1 } },
  };
  const met = (condition) => conditionMet(gd, condition, { save, levels: {} });
  assert.equal(met({ type: 'value', stat: 'AstrologyTotalMinorNodesUnlocked', value: 4 }), true);
  assert.equal(met({ type: 'value', stat: 'AstrologyTotalMajorNodesUnlocked', value: 2 }), false);
  assert.equal(met({ type: 'astrologyNodes', constellation: 'Deedree', major: false, count: 3 }), true);
  assert.equal(met({ type: 'astrologyNodes', constellation: 'Terra', major: true, count: 1 }), false);
  assert.equal(met({ type: 'journalLevels', level: 5, count: 2 }), true);
  assert.equal(met({ type: 'rareSpecies', count: 1 }), true);
  assert.equal(met({ type: 'collectables', count: 2 }), false);
  assert.equal(conditionMet(gd, { type: 'rareSpecies', count: 1 }, { save: {}, levels: {} }), null, 'unknown without the statistics');
});

test('toolbelt items used up as you work cost what they use, within their limits, less any toolbelt saving', () => {
  const withBelt = (skill, items, effects = []) => {
    gd.player = { toolbelts: { [skill]: items.map((item) => ({ item, qty: 100 })) }, owned: {}, levels: {} };
    gd.playerBonuses = effects;
  };
  const done = () => { gd.player = null; gd.playerBonuses = null; };
  const burn = method('Firemaking/NormalLog');
  const blackstone = 'MelvorBase:Blackstone';
  withBelt('Firemaking', [blackstone]);
  const r = computeRates(gd, burn, 99);
  const used = r.toolUse.find((t) => t.item === blackstone);
  close(used.perHour, r.cyclesPerHour, 1e-9);
  withBelt('Firemaking', [blackstone], [{ stats: 'Toolbelt', stat: 'PreservationChance', value: 0.3, skill: 'Firemaking', scope: { Item: 'Blackstone' } }]);
  const gloves = computeRates(gd, burn, 99);
  close(gloves.toolUse[0].perHour, gloves.cyclesPerHour * 0.7);
  assert.ok(gloves.costPerHour < r.costPerHour + 1e-9, 'the saving lowers the cost');
  // A lockpick is only used on chests.
  const npc = gd.methods.find((m) => m.kind === 'thieving' && m.type === 'NPC' && !m.requires.some((q) => q.type === 'tool'));
  const chest = gd.methods.find((m) => m.kind === 'thieving' && m.type === 'Chest');
  withBelt('Thieving', ['MelvorBase:Lockpick']);
  assert.equal(computeRates(gd, npc, 99).toolUse.length, 0);
  assert.equal(computeRates(gd, chest, 99).toolUse.length + computeRates(gd, chest, 99).inputs.filter((i) => i.item === 'MelvorBase:Lockpick').length, 1, 'once per chest, as a tool it needs or from the toolbelt');
  // Base rates (no bonuses) count no toolbelt.
  assert.equal(computeRates(gd, burn, 99, { bonuses: [] }).toolUse.length, 0);
  done();
});
