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
