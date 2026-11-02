import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareActions, verdict } from '../engine/accuracy.js';
import { createGameData } from '../engine/gamedata.js';
import { computeRates } from '../engine/rates.js';
import { createObservationStore } from '../server/observations.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));

test('compares measured XP per hour with the estimate for the same action', () => {
  const tree = gd.methodByKey.get('Woodcutting/NormalTree');
  const est = computeRates(gd, tree, 10).xpPerHour;
  const actions = {
    'Woodcutting - Normal Tree': { seconds: 3600, xp: { Woodcutting: est * 1.2 }, items: { 'MelvorBase:NormalLog': 900 }, lastSeen: 1 },
    'Mining - Copper Ore': { seconds: 30, xp: { Mining: 100 }, items: {}, lastSeen: 1 },
  };
  const rows = compareActions(gd, actions, { Woodcutting: 10 });
  assert.equal(rows.length, 1, 'actions under two minutes are skipped');
  const r = rows[0];
  assert.equal(r.skill, 'Woodcutting');
  assert.ok(Math.abs(r.ratio - 1.2) < 1e-9);
  assert.equal(verdict(r.ratio), 'off');
  assert.equal(verdict(1.04), 'good');
  assert.equal(verdict(0.9), 'close');
  assert.ok(r.items.some((i) => i.item === 'MelvorBase:NormalLog' && i.measured === 900 && i.estimated > 0));
});

test('the observation store adds up per action and keeps it in its own folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-obs-'));
  try {
    const store = createObservationStore(dir);
    await store.add('save:1', 'Mining - Iron Ore', 10, { Mining: 50 }, { 'MelvorBase:IronOre': 3 });
    await store.add('save:1', 'Mining - Iron Ore', 10, { Mining: 60 }, { 'MelvorBase:IronOre': 2 });
    const a = (await store.get('save:1'))['Mining - Iron Ore'];
    assert.equal(a.seconds, 20);
    assert.equal(a.xp.Mining, 110);
    assert.equal(a.items['MelvorBase:IronOre'], 5);
    await store.flush('save:1');
    const onDisk = JSON.parse(readFileSync(join(dir, 'save_1.actions.json'), 'utf8'));
    assert.equal(onDisk['Mining - Iron Ore'].xp.Mining, 110);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a measurement is compared with what was predicted at the time, and only those move plan speeds', async () => {
  const { compareActions, speedFactors } = await import('../engine/accuracy.js');
  const { createGameData } = await import('../engine/gamedata.js');
  const { readFileSync } = await import('node:fs');
  const g = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
  const levels = Object.fromEntries(g.skills.map((s) => [s.id, 20]));
  // Half an hour of Normal Trees: 1,000 XP, when the companion predicted 1,000 for that stretch.
  const actions = { 'Woodcutting - Normal Tree': { seconds: 1800, xp: { Woodcutting: 1000 }, items: {}, timed: { seconds: 1800, xp: 1000, est: 1000 } } };
  const [row] = compareActions(g, actions, levels);
  assert.equal(row.atTheTime, true);
  assert.equal(row.ratio, 1, 'compared with the prediction of its time, not today’s');
  assert.equal(speedFactors(g, actions, levels)['Woodcutting/NormalTree'], 1);
  // An old record without one: still shown, but it doesn't move plans.
  delete actions['Woodcutting - Normal Tree'].timed;
  assert.equal(compareActions(g, actions, levels)[0].atTheTime, false);
  assert.deepEqual(speedFactors(g, actions, levels), {});
});
