// Tries so far at a rare item, from the save's statistics.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { triesSoFar } from '../engine/rare-tries.js';
import { computeRates } from '../engine/rates.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));

test('thieving counts successful steals, with the odds per success and the share who would have one', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && x.rare.length && x.damage > 0);
  const item = m.rare[0].item;
  const rates = computeRates(gd, m, m.level, { bonuses: [] });
  const save = { statistics: { ThievingSuccessfulAction: { [m.id]: 600 }, ThievingFailedAction: { [m.id]: 400 } } };
  const t = triesSoFar(gd, save, item, { type: 'method', method: m }, rates);
  assert.equal(t.tries, 600);
  assert.equal(t.attempts, 1000);
  const perSuccess = (rates.outputs.find((o) => o.item === item).perHour / rates.cyclesPerHour) / rates.successChance;
  assert.ok(Math.abs(t.p - perSuccess) < 1e-12);
  assert.ok(Math.abs(t.chance - (1 - (1 - perSuccess) ** 600)) < 1e-12);
  assert.ok(Math.abs(t.hours - 1000 / rates.cyclesPerHour) < 1e-9, 'the time is every try, failures included');
});

test('fights count kills, and a source the save has no count for gives nothing', () => {
  const enemy = gd.enemies[0];
  const t = triesSoFar(gd, { statistics: { CombatEnemyKilled: { [enemy.id]: 28 } } }, 'x', { type: 'enemy', enemy, p: 1 / 28 });
  assert.equal(t.tries, 28);
  assert.ok(t.chance > 0.6 && t.chance < 0.7, 'about 64% after as many kills as the odds');
  assert.equal(triesSoFar(gd, { statistics: {} }, 'x', { type: 'enemy', enemy, p: 1 / 28 }), null, 'never fought it');
  const fishing = gd.methods.find((x) => x.kind === 'fishing');
  assert.equal(triesSoFar(gd, { statistics: {} }, 'x', { type: 'method', method: fishing }, computeRates(gd, fishing, 99, { bonuses: [] })), null);
});

test('every use of an item counts: keys, gear, quests, ranch treats and quest recipes, not just recipes', async () => {
  const { otherUses } = await import('../engine/lookup.js');
  const { bankInsights } = await import('../engine/advisor.js');
  const id = (x) => `MelvorBase:${x}`;
  assert.ok(otherUses(gd, id('ThugChestKey')).some((t) => /Locked Thug Chest/.test(t)), 'the key opens the chest');
  assert.ok(otherUses(gd, id('EnsnaringBoots')).some((t) => /Worn/.test(t)));
  assert.ok(otherUses(gd, id('RabbitMeat')).some((t) => /ranch/.test(t)));
  assert.ok(otherUses(gd, id('ClimbingRope')).some((t) => /quest/.test(t)));
  assert.ok(otherUses(gd, id('MagicCowhide')).some((t) => /Sulfur Protection Gloves/.test(t)), 'a recipe the companion skips still counts');
  const bank = Object.fromEntries(['ThugChestKey', 'EnsnaringBoots', 'RabbitMeat', 'ClimbingRope', 'MagicCowhide', 'Stinger', 'Junk'].map((x) => [id(x), 5]));
  assert.deepEqual(bankInsights(gd, bank, {}).sellable.map((x) => x.item), [id('Junk')], 'only Junk has no use');
});
