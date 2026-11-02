import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityKey, measureFlows, supplyStatus } from '../engine/supplies.js';

const snap = (s, activity, stock) => ({ t: s * 1000, activity, stock });

test('measures use over the latest run of saves of the same activity', () => {
  const snaps = [
    snap(0, 'Woodcutting - Oak Tree', { Arrow: 500, Log: 0 }),
    snap(10, 'Combat - Golbin', { Arrow: 500, Log: 0 }),
    snap(20, 'Combat - Golbin', { Arrow: 490, Log: 0 }),
    snap(30, 'Combat - Golbin', { Arrow: 480, Log: 0 }),
    snap(40, 'Combat - Golbin', { Arrow: 470, Log: 0 }),
  ];
  const f = measureFlows(snaps);
  assert.equal(f.activity, 'Combat - Golbin');
  assert.equal(f.saves, 4);
  assert.equal(f.perHour.Arrow, -30 / (30 / 3600));
  assert.equal(f.drops.Arrow, 3);
  assert.equal(f.perHour.Log, undefined);
});

test('a long gap starts a new measurement', () => {
  const f = measureFlows([snap(0, 'A', { X: 100 }), snap(500, 'A', { X: 50 }), snap(510, 'A', { X: 40 })]);
  assert.equal(f.saves, 2);
  assert.equal(f.perHour.X, -10 / (10 / 3600));
});

test('supply status needs steady use, and estimates until there is a measurement', () => {
  const flows = { activity: 'A', minutes: 2, perHour: { Arrow: -600, Sold: -5000 }, drops: { Arrow: 5, Sold: 1 } };
  const s = supplyStatus({ flows, stock: { Arrow: 100, Sold: 10 }, activity: 'A' });
  assert.deepEqual(s.map((x) => x.item), ['Arrow'], 'a single drop (selling) is not usage');
  assert.equal(s[0].hoursLeft, 100 / 600);
  assert.equal(s[0].measured, true);

  const estimated = supplyStatus({ flows: { ...flows, activity: 'B' }, stock: { Ore: 30 }, estimate: [{ item: 'Ore', perHour: 60 }], activity: 'A' });
  assert.deepEqual(estimated.map((x) => [x.item, x.measured, x.hoursLeft]), [['Ore', false, 0.5]]);
  assert.equal(activityKey({ activeEntityName: 'Mining', activeActionName: 'Iron' }), 'Mining - Iron');
  assert.equal(activityKey({ activeEntityName: '', activeActionName: '' }), '');
});

test('food for skilling damage is the food selected in that skill\'s slot, and none when the slot is empty', async () => {
  const { readFileSync } = await import('node:fs');
  const { createGameData } = await import('../engine/gamedata.js');
  const { currentSupplies } = await import('../engine/supplies.js');
  const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
  // A target you fail sometimes at its own level, so you take damage.
  const target = gd.methods.find((m) => m.kind === 'thieving' && m.damage > 0 && m.perception >= 100 && !m.requires.some((q) => q.type === 'tool'));
  const levels = { Thieving: target.level };
  const save = (foods) => ({ header: { activeEntityName: 'Thieving', activeActionName: target.name }, foods, flows: null });
  const stock = { 'MelvorBase:Glowfin': 7508 };
  const withFood = currentSupplies(gd, save({ Thieving: 'MelvorBase:Glowfin' }), levels, stock);
  assert.deepEqual(withFood.map((s) => s.item), ['MelvorBase:Glowfin']);
  assert.equal(withFood[0].qty, 7508);
  assert.deepEqual(currentSupplies(gd, save({}), levels, stock), [], 'nothing selected: the game eats nothing');
});

test('stock up: how many more of each supply for the time you pick, and the quickest way to get them', async () => {
  const { readFileSync } = await import('node:fs');
  const { createGameData } = await import('../engine/gamedata.js');
  const { stockUp } = await import('../engine/supplies.js');
  const { obtain, producerIndex } = await import('../engine/advisor.js');
  const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
  const levels = Object.fromEntries(gd.skills.map((s) => [s.id, 60]));
  const index = producerIndex(gd, levels);
  const arrows = 'MelvorBase:SteelArrows';
  const rows = stockUp([{ item: arrows, perHour: 1000 }, { item: 'MelvorBase:NormalLog', perHour: 10 }], 2, { index, stock: { [arrows]: 500, 'MelvorBase:NormalLog': 1000 }, obtain });
  assert.equal(rows.length, 1, 'enough logs already');
  assert.equal(rows[0].short, 1500);
  assert.ok(rows[0].get.method?.skill === 'Fletching', 'fletched, from ore and feathers up');
  assert.ok(Number.isFinite(rows[0].get.hours) && rows[0].get.hours > 0);
});
