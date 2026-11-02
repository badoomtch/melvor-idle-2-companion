import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { cleanSettings, createAlertWatcher } from '../server/alerts.js';
import { notificationCommand } from '../server/notifier.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const NOW = 1_800_000_000_000;
const save = (levels, extra = {}) => ({
  header: { timestamp: NOW, activeEntityName: '', activeActionName: '', ...extra.header },
  skills: Object.fromEntries(Object.entries(levels).map(([k, level]) => [k, { level, xp: 0 }])),
  bank: { items: {} },
  history: [],
  flows: null,
  ...extra,
});

function watcher(settings = { enabled: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-alerts-'));
  const sent = [];
  const w = createAlertWatcher({ gd, dir, notify: (title, body) => sent.push({ title, body }), now: () => NOW });
  w.setSettings(settings);
  return { w, sent, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('alert settings keep only known fields, within limits', () => {
  const s = cleanSettings({ enabled: true, minutes: 9999, goals: [{ skill: 'Mining', target: 50.4 }, { bad: 1 }], extra: 'x' });
  assert.equal(s.enabled, true);
  assert.equal(s.minutes, 600);
  assert.deepEqual(s.goals, [{ skill: 'Mining', target: 50 }]);
  assert.equal(s.extra, undefined);
});

test('level-ups and goals become one combined notification', () => {
  const { w, sent, done } = watcher({ enabled: true, goals: [{ skill: 'Mining', target: 31 }] });
  assert.deepEqual(w.onSave('a', null, save({ Mining: 30 })), []); // first save: nothing to compare
  w.onSave('a', save({ Mining: 30 }), save({ Mining: 31 }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /2 updates/);
  assert.match(sent[0].body, /Mining level 31.*Goal reached: Mining 31/);
  done();
});

test('alerts stay quiet until switched on, and the setting is kept on disk', () => {
  const { w, sent, dir, done } = watcher({ enabled: false });
  w.onSave('a', save({ Mining: 30 }), save({ Mining: 31 }));
  assert.equal(sent.length, 0);
  w.setSettings({ enabled: true });
  assert.equal(JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8')).enabled, true);
  done();
});

test('the game going quiet is reported once, but not for an old save found at start-up', () => {
  let now = NOW;
  const dir = mkdtempSync(join(tmpdir(), 'mc-alerts-'));
  const sent = [];
  const w = createAlertWatcher({ gd, dir, notify: (title) => sent.push(title), now: () => now });
  w.setSettings({ enabled: true });
  w.onSave('old', null, save({ Mining: 30 }, { header: { timestamp: NOW - 3_600_000 } }));
  now += 200_000;
  w.tick();
  assert.deepEqual(sent, []);
  w.onSave('live', null, save({ Mining: 30 }, { header: { timestamp: now } }));
  now += 130_000;
  w.tick();
  w.tick();
  assert.deepEqual(sent, ['The game stopped saving']);
  rmSync(dir, { recursive: true, force: true });
});

test('notification commands escape what they show', () => {
  const [cmd, args] = notificationCommand(`Bob's <level>`, 'a & b', 'win32');
  assert.equal(cmd, 'powershell.exe');
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Bob&apos;s &lt;level&gt;/);
  assert.match(script, /a &amp; b/);
  const [, mac] = notificationCommand('Say "hi"', 'x', 'darwin');
  assert.equal(mac[1], 'display notification "x" with title "Say \\"hi\\""');
});
