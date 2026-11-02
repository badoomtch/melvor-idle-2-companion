// Rare finds: spotting them between autosaves, the log kept per save, and the notification.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { rareOdds } from '../engine/rare-items.js';
import { cleanSettings, createAlertWatcher } from '../server/alerts.js';
import { createFindLog, FIND_LIMIT, rareFinds } from '../server/rare-finds.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const NOW = 1_800_000_000_000;
// A parse of a save: found counts by local item id, as the save reader gives them.
const save = (found, header = {}) => ({
  header: { uuid: 'abc', timestamp: NOW, activeEntityName: 'Thieving', activeActionName: 'Chef', ...header },
  skills: { Thieving: { level: 30, xp: 0 } },
  bank: { items: {} },
  itemsFound: found,
});

test('the rarity data knows how rare an item is and where it comes from', () => {
  const hat = rareOdds(gd, 'MelvorBase:ChefsHat');
  assert.equal(hat.source.type, 'method');
  assert.equal(hat.source.method.name, 'Chef');
  assert.ok(hat.p < 1 / 100, `rarer than 1 in 100 (${hat.p})`);
  assert.equal(rareOdds(gd, 'MelvorBase:NormalLog'), null, 'logs are not rare');
});

test('a rare item found between two autosaves is a find, with what you were doing', () => {
  const before = save({ ChefsHat: 1, NormalLog: 10 });
  const after = save({ ChefsHat: 3, NormalLog: 20 }, { timestamp: NOW + 10_000 });
  assert.deepEqual(rareFinds(gd, before, after), [{ item: 'MelvorBase:ChefsHat', at: NOW + 10_000, count: 2, activity: 'Thieving - Chef' }]);
  // The first one ever counts too.
  assert.equal(rareFinds(gd, save({}), save({ ChefsHat: 1 }, { timestamp: NOW + 1 }))[0].count, 1);
});

test('nothing is a find on the first parse, for another character, or for common and uncommon items', () => {
  const after = save({ ChefsHat: 1 }, { timestamp: NOW + 10_000 });
  assert.deepEqual(rareFinds(gd, null, after), [], 'the first parse after the companion starts');
  assert.deepEqual(rareFinds(gd, save({}, { uuid: 'other' }), after), [], 'a different save in the same file');
  assert.deepEqual(rareFinds(gd, save({ ChefsHat: 1 }), after), [], 'no change');
  assert.deepEqual(rareFinds(gd, save(null), after), [], 'no statistics in the save');
  assert.equal(rareOdds(gd, 'MelvorBase:Geode').rarity.id, 'uncommon');
  assert.deepEqual(rareFinds(gd, save({ Geode: 1 }), save({ Geode: 2 }, { timestamp: NOW + 10_000 })), [], 'uncommon items turn up too often to announce');
});

test('the log is kept per save in the companion folder, latest 200', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-finds-'));
  try {
    const log = createFindLog({ gd, dir });
    assert.deepEqual(log.onSave('a', null, save({ ChefsHat: 1 })), []);
    const found = log.onSave('a', save({ ChefsHat: 1 }), save({ ChefsHat: 2 }, { timestamp: NOW + 10_000 }));
    assert.equal(found.length, 1);
    const many = Array.from({ length: FIND_LIMIT + 5 }, (_, i) => ({ item: 'MelvorBase:ChefsHat', at: NOW + i, count: 1, activity: '' }));
    await log.add('a', many);
    assert.deepEqual(readdirSync(dir), ['a.finds.json']);
    const stored = JSON.parse(readFileSync(join(dir, 'a.finds.json'), 'utf8'));
    assert.equal(stored.length, FIND_LIMIT);
    assert.equal(stored.at(-1).at, NOW + FIND_LIMIT + 4, 'the newest are kept');
    // A new companion reads it back.
    assert.equal((await createFindLog({ gd, dir }).get('a')).length, FIND_LIMIT);
    assert.deepEqual(await log.get('b'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a find is a desktop notification with its odds, unless switched off', () => {
  assert.equal(cleanSettings({}).rareFinds, true);
  assert.equal(cleanSettings({ rareFinds: false }).rareFinds, false);
  const dir = mkdtempSync(join(tmpdir(), 'mc-finds-'));
  const sent = [];
  const w = createAlertWatcher({ gd, dir, notify: (title, body) => sent.push({ title, body }), now: () => NOW });
  try {
    const before = save({ ChefsHat: 1 });
    const after = save({ ChefsHat: 2 }, { timestamp: NOW + 10_000 });
    const finds = rareFinds(gd, before, after);
    w.onSave('a', before, { ...after, finds });
    assert.deepEqual(sent, [], 'alerts are off until switched on');
    w.setSettings({ enabled: true });
    w.onSave('a', before, { ...after, finds });
    const odds = Math.round(1 / rareOdds(gd, 'MelvorBase:ChefsHat').p).toLocaleString();
    assert.deepEqual(sent, [{ title: "Rare find: Chef's Hat", body: `1 in ${odds} per action, from Chef (Thieving)` }]);
    w.setSettings({ enabled: true, rareFinds: false });
    w.onSave('a', before, { ...after, finds });
    assert.equal(sent.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
