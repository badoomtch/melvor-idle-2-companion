import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { createRouteWatcher } from '../server/route-watcher.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
let clock = 1_800_000_000_000;
const save = (level, items = {}, xpExtra = {}) => ({
  header: { timestamp: clock, activeEntityName: '', activeActionName: '' },
  skills: Object.fromEntries(gd.skills.map((s) => [s.id, { level, xp: gd.xp.xpForLevel(level) + (xpExtra[s.id] ?? 0) }])),
  bank: { items },
});

function watcher(settings = { enabled: true, planSteps: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-routes-'));
  const sent = [];
  const w = createRouteWatcher({ gd, dir, notify: (title, body) => sent.push({ title, body }), settings: () => settings, now: () => clock });
  return { w, sent, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the companion keeps a plan per save in its own folder, and says when a step is done and what is next', () => {
  const { w, sent, dir, done } = watcher();
  try {
    const bank = { 'MelvorBase:RawShrimp': 500 };
    assert.deepEqual(w.onSave('a', save(20, bank)), [], 'a first plan is made quietly');
    const plan = w.get('a');
    assert.ok(plan.legs.length > 0);
    assert.deepEqual(readdirSync(dir), ['routes.json']);
    // Nothing changed: nothing to say.
    clock += 10_000;
    assert.deepEqual(w.onSave('a', save(20, bank)), []);
    // The first goal's training done (its XP reached): the goal is reached, and the next step is named.
    const leg = plan.legs[0];
    const end = Math.max(...leg.steps.filter((st) => st.kind === 'train').map((st) => st.xpAfter));
    clock += 10_000;
    const events = w.onSave('a', save(20, bank, { [leg.skill]: end - gd.xp.xpForLevel(20) + 1 }));
    assert.equal(events.length, 1);
    assert.match(events[0].title, new RegExp(`${gd.skillName(leg.skill)} ${leg.to} reached`));
    assert.match(events[0].body, /Next: /);
    assert.equal(sent.length, 1);
    // It's kept: the same plan, with those steps done.
    assert.equal(w.get('a').madeAt, plan.madeAt);
    assert.ok(leg.steps.every((st) => w.get('a').done.includes(st.id)));
  } finally {
    done();
  }
});

test('plan notifications only go out when companion notifications are on', () => {
  const { w, sent, done } = watcher({ enabled: false, planSteps: true });
  try {
    w.onSave('a', save(20));
    const leg = w.get('a').legs[0];
    const end = Math.max(...leg.steps.filter((st) => st.kind === 'train').map((st) => st.xpAfter));
    clock += 10_000;
    assert.equal(w.onSave('a', save(20, {}, { [leg.skill]: end })).length, 1, 'the page still hears about it');
    assert.equal(sent.length, 0);
  } finally {
    done();
  }
});

test('a plan that is stuck gets replaced by itself, and asking for a new one works', () => {
  const { w, done } = watcher();
  try {
    // Cooking with raw shrimp in the bank: then the shrimp are gone and nothing in the plan makes more.
    const cook = (items) => ({ ...save(30, items), header: { timestamp: clock, activeEntityName: 'Cooking', activeActionName: 'Shrimp' } });
    w.onSave('a', cook({ 'MelvorBase:RawShrimp': 5000 }));
    const first = w.get('a');
    const step = first.legs[0].steps[0];
    assert.equal(step.method, 'Cooking/Shrimp', 'what you are doing goes first');
    clock += 120_000;
    const events = w.onSave('a', cook({}));
    assert.ok(w.get('a').madeAt > first.madeAt, 'a new plan');
    assert.match(events[0].title, /Out of Raw Shrimp/);
    clock += 1000;
    const again = w.replan('a');
    assert.ok(again && again.madeAt === clock && w.get('a') === again);
    assert.equal(w.replan('nope'), null);
  } finally {
    done();
  }
});
