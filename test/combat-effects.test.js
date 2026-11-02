// Special attacks of your weapon, effects from the enemy's special attacks and combat food bonuses,
// against the game's combat code (CharacterComponent.PerformAttack and turns, CombatEffectsComponent,
// ActiveDamageOverTimeEffect, ActiveStunEffect, ActiveTurnCountingEffect, FoodComponent).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { producerIndex } from '../engine/advisor.js';
import { buildEnemy, buildPlayer, fight, withFood } from '../engine/combat.js';
import { foodOptions } from '../engine/food.js';
import { combatFoodMods, createGameData, playerCombatMods } from '../engine/gamedata.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'].map((s) => [s, level]));
const enemyOf = (id, patch = {}) => ({ ...gd.enemyById.get(id), passive: undefined, ...patch });
const player = (gear, stance, level) => buildPlayer(gd, { gear, stance, levels: at(level) });
// The same fight without the effects attacks apply (what the model counted before).
const noEffects = (x) => ({ ...x, attacks: x.attacks.map((a) => ({ ...a, applies: [] })) });
const normalOnly = (p) => ({ ...p, attacks: [{ ...gd.combat.attacks.Normal, id: 'Normal', chance: 1 }] });
const enemyTurnsPerSec = (r) => r.enemyAttacksPerHour / r.killsPerHour / r.killSeconds;
function withMods(mods, fn) {
  const was = gd.playerCombatMods;
  gd.playerCombatMods = mods;
  try {
    return fn();
  } finally {
    gd.playerCombatMods = was;
  }
}

test('your gear\'s special attacks: picked by chance each turn, the normal attack takes the rest', () => {
  assert.equal(Object.values(gd.items).filter((it) => it.equip?.attacks).length, 77);
  const claws = player(['MelvorBase:GriffinClaws'], 'Stab', 60);
  assert.deepEqual(claws.attacks.map((a) => [a.id, a.chance]), [['Normal', 0.75], ['BleedingStrikes', 0.25]]);
  // A boomerang throws every turn (chance 1): no normal attack.
  assert.deepEqual(player(['MelvorBase:OakBoomerang'], 'Accurate', 40).attacks.map((a) => [a.id, a.chance]), [['Boomerang', 1]]);
  assert.deepEqual(player([], 'Stab', 10).attacks.map((a) => a.id), ['Normal']);
});

test('a boomerang hits for 200% and waits 2.5s for it to come back; ammo goes with every hit', () => {
  const boom = player(['MelvorBase:OakBoomerang'], 'Accurate', 40);
  // A big enemy with no armour: the turn takes interval + 2500ms and does twice the damage.
  const golbin = gd.enemyById.get('Golbin');
  const big = buildEnemy(gd, enemyOf('Golbin', { levels: { ...golbin.levels, Hitpoints: 2000 }, stats: { ...golbin.stats, Armour: 0 } }));
  const thrown = fight(gd, boom, big);
  const plain = fight(gd, normalOnly(boom), big);
  close(thrown.killSeconds / plain.killSeconds, (boom.interval + 2500) / (2 * boom.interval), 0.03);
  // Two hits a turn (the throw and the return), half kept by the boomerang's own preservation.
  close(boom.keep.ammo, 0.5);
  close(thrown.ammoPerHour, thrown.attacksPerHour * 2 * 0.5);
  // A one-hit kill doesn't wait for the boomerang to come back.
  const strong = player(['MelvorBase:OakBoomerang'], 'Accurate', 99);
  const quick = fight(gd, strong, buildEnemy(gd, enemyOf('Golbin')));
  assert.ok(quick.killSeconds < (strong.interval + 2500) / 1000 / quick.hitChance, `${quick.killSeconds}`);
});

test('special attack effects on the enemy: stuns cost it turns, bleeds kill faster but give no XP', () => {
  const dragon = buildEnemy(gd, enemyOf('RedDragon'));
  // Storm Fang: 3 hits, 30% to stun each, then Staggered (slower, can't be stunned) for 5 turns.
  const fang = player(['MelvorBase:StormFang2HSword'], 'Stab', 99);
  const stunned = fight(gd, fang, dragon);
  const free = fight(gd, noEffects(fang), dragon);
  assert.ok(stunned.enemyStunned > 0.02, `${stunned.enemyStunned}`);
  close(enemyTurnsPerSec(stunned), enemyTurnsPerSec(free) * (1 - stunned.enemyStunned), 1e-6);
  assert.ok(stunned.damageTakenPerKill < free.damageTakenPerKill);

  // Blood Reap: 5 hits, each 50% to bleed (20% of the hit's damage, 10 times).
  const scythe = player(['MelvorBase:BloodReapScythe'], 'Stab', 99);
  const bled = fight(gd, scythe, dragon);
  const dry = fight(gd, noEffects(scythe), dragon);
  assert.ok(bled.dotOnEnemyDps > 0 && bled.killsPerHour > dry.killsPerHour * 1.05, `${bled.killsPerHour} vs ${dry.killsPerHour}`);
  // Only attack damage gives XP (CombatExperienceComponent), so each kill pays less.
  assert.ok(bled.combatXpPerHour / bled.killsPerHour < dry.combatXpPerHour / dry.killsPerHour * 0.95);
  // In a fight over before it procs, a bleed adds next to nothing.
  const claws = player(['MelvorBase:GriffinClaws'], 'Stab', 99);
  const golbin = buildEnemy(gd, enemyOf('Golbin'));
  close(fight(gd, claws, golbin).killsPerHour, fight(gd, noEffects(claws), golbin).killsPerHour, 0.01);
});

test('enemy special attacks: bleed adds damage taken, less your effect avoidance and damage reduction', () => {
  const wolf = buildEnemy(gd, enemyOf('Wolf'));
  // Bare hands can't out-damage a Wolf's lifesteal; a scimitar can.
  const p = player(['MelvorBase:RuneScimitar'], 'Slash', 40);
  const bitten = fight(gd, p, wolf);
  const clean = fight(gd, p, noEffects(wolf));
  assert.ok(bitten.dotDps > 0 && bitten.effects.some((x) => x.who === 'player' && x.name === 'Bleed'));
  close(bitten.damageTakenPerKill / bitten.killSeconds - clean.damageTakenPerKill / clean.killSeconds, bitten.dotDps, 1e-6);
  assert.ok(bitten.hpLossPerHour > clean.hpLossPerHour);
  // CombatEffectStats: avoidance for that effect stops it; effect damage taken -50% about halves it.
  assert.equal(fight(gd, { ...p, effectMods: [{ stat: 'EffectAvoidanceChance', value: 1, effect: 'Bleed' }] }, wolf).dotDps, 0);
  assert.ok(fight(gd, { ...p, effectMods: [{ stat: 'EffectAvoidanceChance', value: 1, effect: 'Poison' }] }, wolf).dotDps === bitten.dotDps, 'avoidance for another effect');
  close(fight(gd, { ...p, effectMods: [{ stat: 'EffectDamageTaken', value: -0.5 }] }, wolf).dotDps, bitten.dotDps / 2, 0.1);
  // Gear bonuses are read from the data (Snakeskin Cape: poison and sting).
  const cape = gd.items['MelvorBase:SnakeskinCape'].equip.mods;
  assert.ok(cape.some((m) => m.stat === 'EffectAvoidanceChance' && m.effect === 'Poison' && m.value === 0.05));
  assert.ok(cape.some((m) => m.stat === 'EffectDamageTaken' && m.effect === 'Sting' && m.value === -0.1));
});

test('enemy stuns cost you turns, then Staggered lowers your evasion; stun avoidance stops them', () => {
  const kraken = buildEnemy(gd, enemyOf('Krakeling'));
  const p = player(['MelvorBase:StormFang2HSword'], 'Stab', 99);
  const slammed = fight(gd, p, kraken);
  const steady = fight(gd, p, noEffects(kraken));
  assert.ok(slammed.stunned > 0.05, `${slammed.stunned}`);
  close(slammed.killSeconds, steady.killSeconds / (1 - slammed.stunned), 0.02);
  assert.ok(slammed.enemyHitChance > steady.enemyHitChance, 'Staggered: -25% evasion');
  const avoided = fight(gd, { ...p, effectMods: [{ stat: 'EffectAvoidanceChance', value: 1, effect: 'Stun' }] }, kraken);
  close(avoided.killSeconds, steady.killSeconds);
  // Sleep is a stun too (then Drowsy).
  const squid = buildEnemy(gd, enemyOf('Glowsquid'));
  assert.ok(fight(gd, player([], 'Stab', 90), squid).effects.some((x) => x.name === 'Sleep' && x.share > 0));
});

test('enemy self-buffs count for the share of the time they are up: Vanished, Guarded, Haste', () => {
  const p = player([], 'Stab', 85);
  // Sand Ambush: Vanished (+69,420 evasion) for 2 of its turns, on 20% of its turns.
  const nomad = buildEnemy(gd, enemyOf('SandNomad'));
  const hidden = fight(gd, p, nomad);
  const seen = fight(gd, p, noEffects(nomad));
  const up = hidden.effects.find((x) => x.name === 'Vanished').share;
  close(up, (0.2 * 2) / (1 + 0.2 * 2), 1e-6);
  assert.ok(hidden.hitChance < seen.hitChance * (1 - up) + 0.05 && hidden.hitChance > seen.hitChance * (1 - up));
  // Guarded: +120 protection some of the time.
  const strong = withMods([{ stat: 'FlatPowerRating', value: 3000 }], () => player([], 'Stab', 85));
  const guardian = buildEnemy(gd, enemyOf('PhantasmGuardian'));
  assert.ok(fight(gd, strong, guardian).enemyResistance > fight(gd, strong, noEffects(guardian)).enemyResistance);
  // Haste: -15% attack interval for 2 turns.
  const drake = buildEnemy(gd, enemyOf('SandDrake'));
  assert.ok(enemyTurnsPerSec(fight(gd, p, drake)) > enemyTurnsPerSec(fight(gd, p, noEffects(drake))));
});

test('the selected combat food\'s bonus counts while you have some, and each food is compared with its own', () => {
  assert.deepEqual(combatFoodMods(gd, 'MelvorBase:OrangeCake').map((m) => [m.stat, m.value]), [['FlatProtectionRating', 40]]);
  assert.deepEqual(combatFoodMods(gd, 'MelvorBase:MangoPancake').map((m) => [m.stat, m.value]), [['EffectDamageTaken', -0.2]]);
  assert.deepEqual(combatFoodMods(gd, 'MelvorBase:Shrimp'), []);
  const save = { bank: { items: { 'MelvorBase:OrangeCake': 5 } }, combat: { food: 'MelvorBase:OrangeCake' } };
  assert.equal(playerCombatMods(gd, save).filter((m) => m.food).length, 1);
  assert.equal(playerCombatMods(gd, { ...save, bank: { items: {} } }).filter((m) => m.food).length, 0, 'none left: no bonus');
  assert.equal(playerCombatMods(gd, { ...save, foods: { Combat: 'MelvorBase:MangoPancake' }, bank: { items: { 'MelvorBase:MangoPancake': 1 } } })[0].stat, 'EffectDamageTaken');

  const mods = playerCombatMods(gd, save);
  const caked = withMods(mods, () => player([], 'Stab', 40));
  const bare = player([], 'Stab', 40);
  assert.equal(caked.protection, bare.protection + 40);
  // Building with another food swaps the selected one's bonus for that food's.
  assert.equal(withMods(mods, () => withFood(gd, caked, 'MelvorBase:Shrimp')).protection, bare.protection);
  assert.equal(withFood(gd, bare, 'MelvorBase:TunaSandwich').percentMaxHit, bare.percentMaxHit + 0.03);

  // Protection from a cake means less damage, so fewer eaten; a sandwich's max hit means more XP.
  const hob = buildEnemy(gd, enemyOf('Hobgolbin'));
  const weak = player([], 'Stab', 15);
  const rows = foodOptions(gd, { player: weak, enemy: hob, levels: at(15), index: producerIndex(gd, at(15)) });
  const row = (id) => rows.find((r) => r.item === id);
  assert.ok(row('MelvorBase:OrangeCake').hpLossPerHour < row('MelvorBase:Shrimp').hpLossPerHour);
  assert.ok(row('MelvorBase:TunaSandwich').combatXpPerHour > row('MelvorBase:Shrimp').combatXpPerHour);
  assert.deepEqual(row('MelvorBase:Lasagna').bonus.map((m) => m.stat), ['PercentEvasionRating', 'FlatProtectionRating']);
});
