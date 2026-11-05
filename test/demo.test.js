// Demo only: what the Steam demo doesn't have (data/demo-availability.json) is never recommended
// while the setting is on, and nothing changes while it's off.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { rankSkill } from '../engine/advisor.js';
import { fightableEnemies } from '../engine/combat.js';
import { createGameData, demoOnlyFor, purchaseStatus } from '../engine/gamedata.js';
import { cleanSettings } from '../server/alerts.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
const gd = createGameData(read('companion-data.json'));
const list = read('demo-availability.json');
gd.setDemoList(list);
const all = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));
const withDemo = (fn) => {
  gd.demoOnly = true;
  try {
    return fn();
  } finally {
    gd.demoOnly = false;
  }
};

test('the demo list matches the companion data', () => {
  assert.ok(list.source.gameVersion, 'records which demo it came from');
  const known = { methods: new Set(gd.methods.map((m) => m.key)), enemies: new Set(gd.enemies.map((e) => e.id)), areas: new Set(gd.areas.map((a) => a.id)),
    dungeons: new Set(gd.combat.dungeons.map((d) => d.id)), shop: new Set(gd.shop.map((p) => p.id)), mill: new Set(gd.raw.grainMill.recipes.map((r) => r.id)), items: new Set(Object.keys(gd.items)) };
  for (const [kind, ids] of Object.entries(known)) {
    const unknown = list.locked[kind].filter((id) => !ids.has(id));
    assert.deepEqual(unknown, [], `${kind} in the demo list that the companion data doesn't have`);
  }
  // Whole skills: every one of their methods is out.
  assert.deepEqual(list.locked.skills, ['Agility', 'Astrology', 'Herblore']);
  for (const skill of list.locked.skills) assert.ok(gd.methodsBySkill[skill].every((m) => gd.demo.methods.has(m.key)), skill);
  // The demo's trees and bushes, as checked in the game (knsk45/melvor-idle-2-tools, docs/DEMO_OBSERVATION_20261024.md).
  const trees = gd.methodsBySkill.Woodcutting.filter((m) => !gd.demo.methods.has(m.key)).map((m) => m.name).sort();
  assert.deepEqual(trees, ['Ambervine Bush', 'Flax Bush', 'Mahogany Tree', 'Maple Tree', 'Normal Tree', 'Oak Tree', 'Spikemoss Shrub', 'Teak Tree', 'Willow Tree']);
});

test('the setting: automatic follows the save, on and off override it', () => {
  const demoSave = { header: { isDemo: true } };
  const fullSave = { header: { isDemo: false } };
  assert.equal(demoOnlyFor('auto', demoSave), true);
  assert.equal(demoOnlyFor('auto', fullSave), false);
  assert.equal(demoOnlyFor('auto', null), false);
  assert.equal(demoOnlyFor('on', fullSave), true);
  assert.equal(demoOnlyFor('off', demoSave), false);
  assert.equal(cleanSettings({ demoOnly: 'on' }).demoOnly, 'on');
  assert.equal(cleanSettings({ demoOnly: 'maybe' }).demoOnly, 'auto');
});

test('demo only: locked methods are never recommended; off, nothing changes', () => {
  const levels = all(120);
  const off = rankSkill(gd, 'Woodcutting', levels);
  assert.ok(off.available.some((x) => gd.demo.methods.has(x.method.key)), 'with it off, methods outside the demo are recommended');
  const on = withDemo(() => rankSkill(gd, 'Woodcutting', levels));
  assert.ok(on.available.length > 0);
  assert.ok(on.available.every((x) => !gd.demo.methods.has(x.method.key)));
  assert.ok(!on.upcoming.some((x) => gd.demo.methods.has(x.method.key)), "they aren't shown as coming up either");
  const locked = on.all.find((x) => gd.demo.methods.has(x.method.key));
  assert.deepEqual(locked.missing[0], { type: 'locked', label: 'Not available in the demo' });
  // Bone Arrows and Bone Bolts aren't DemoLocked in the package, but the demo has no Slayer Ammo.
  const beast = withDemo(() => rankSkill(gd, 'Beastcrafting', all(50)));
  assert.ok(beast.best && !['BoneArrow', 'BoneBolts'].includes(beast.best.method.id), 'Bone Arrows are not recommended');
  assert.ok(gd.demo.methods.has('Beastcrafting/BoneArrow') && gd.demo.methods.has('Beastcrafting/BoneBolts'));
  // A skill the demo doesn't have recommends nothing.
  assert.equal(withDemo(() => rankSkill(gd, 'Herblore', levels)).best, null);
});

test('demo only: enemies, areas and shop purchases outside the demo are left out', () => {
  const levels = all(120);
  const off = fightableEnemies(gd, levels);
  const on = withDemo(() => fightableEnemies(gd, levels));
  assert.ok(on.length > 0 && on.length < off.length);
  assert.ok(on.every((f) => !gd.demo.enemies.has(f.enemy.id) && !gd.demo.areas.has(f.area.id)));
  const p = gd.shop.find((x) => gd.demo.shop.has(x.id) && !x.requires.length);
  assert.ok(purchaseStatus(gd, p, levels).ok);
  assert.equal(withDemo(() => purchaseStatus(gd, p, levels)).ok, false);
});
