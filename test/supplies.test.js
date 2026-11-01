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
