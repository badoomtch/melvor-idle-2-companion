// The combat model against a simulation of the game's combat loop (60 ticks a second, ward, passives,
// healing, stuns), for the cases where the model was off: ward, healing enemies and Drain, Fracture,
// Storm Wrapped stuns, Starblight and armour that rarely breaks. The numbers in quotes are the
// simulation's, run long enough that they're good to a few percent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEnemy, buildPlayer, castableSpells, fight } from '../engine/combat.js';
import { createGameData } from '../engine/gamedata.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps * Math.abs(b), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'].map((s) => [s, level]));
const enemy = (id, patch = {}) => buildEnemy(gd, { ...gd.enemyById.get(id), ...patch });
const rune = (lv) => buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody', 'MelvorBase:RunePlatelegs', 'MelvorBase:RuneHelmet'], stance: 'Slash', levels: at(lv) });
const mage = () => buildPlayer(gd, { gear: ['MelvorBase:FireBattlestaff', 'MelvorBase:AdeptWizardRobes'], stance: 'Offensive', spell: gd.combat.spells.find((x) => x.id === 'FireWave'), levels: at(99) });

test('ward: the first hits do less until it is gone (Sand Sentinel and Moongazer have 15)', () => {
  const p = buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels: at(90) });
  const plain = { passive: undefined, attacks: [] };
  // The simulation without ward gave 231s and 412s: about half of the first 15 hits is lost.
  close(fight(gd, p, enemy('SandSentinel', plain)).killSeconds, 344.6, 0.03);
  close(fight(gd, p, enemy('Moongazer', plain)).killSeconds, 529.3, 0.04);
  // Double ward damage takes it off twice as fast.
  const sentinel = enemy('SandSentinel', plain);
  assert.ok(fight(gd, { ...p, doubleWard: 1 }, sentinel).killSeconds < fight(gd, p, sentinel).killSeconds - 5);
  assert.ok(gd.items['MelvorBase:GoldBlackOpalAmulet'].equip.mods.some((m) => m.stat === 'DoubleWardDamageChance' && m.value === 0.05));
  // Nothing you put on it lands until the ward is gone (CombatEffectsComponent.ApplyEffect).
  const fang = buildPlayer(gd, { gear: ['MelvorBase:StormFang2HSword'], stance: 'Stab', levels: at(99) });
  const unwarded = enemy('SandSentinel', { ...plain, stats: { ...gd.enemyById.get('SandSentinel').stats, MaximumWard: 0 } });
  assert.ok(fight(gd, fang, sentinel).enemyStunned < fight(gd, fang, unwarded).enemyStunned * 0.9);
});

test('armour that rarely breaks: when it breaks varies, and the average break gives too few hits', () => {
  // Fire Wave on a Nightwing (40 armour): 47.9 landed hits a kill, 348s.
  close(fight(gd, mage(), enemy('Nightwing', { passive: undefined, attacks: [] })).killSeconds, 348, 0.02);
});

test('enemies that heal from what they do to you: lifesteal, Drain and effect lifesteal', () => {
  assert.equal(enemy('Wolf').lifesteal, 0.1);
  assert.ok(gd.enemyById.get('Rassal').passive.effectMods.some((m) => m.who === 'enemy' && m.stat === 'EffectLifesteal' && m.effect === 'Bleed' && m.value === 0.01));
  assert.ok(gd.areaById.get('Bloodlands').effect.some((m) => m.stat === 'EffectLifesteal' && m.effect === 'Bleed' && m.onEnemy && m.value === 0.1));
  // A Vampire heals 10% of what it does to you, 20% while Drain is up: "3.1 HP/s", a 245s kill.
  const p = rune(99);
  const vampire = fight(gd, p, enemy('Vampire'));
  const heals = (r) => r.effects.find((x) => x.who === 'enemy' && x.kind === 'heal')?.dps ?? 0;
  close(heals(vampire), 3.1, 0.1);
  close(vampire.killSeconds, 245, 0.07);
  // Vampire Bite puts Drain on before its hit and it lasts two more turns: half its hits, at 25% a turn.
  const bitten = enemy('Vampire');
  const noDrain = fight(gd, p, { ...bitten, attacks: bitten.attacks.map((a) => ({ ...a, applies: [] })) });
  close(heals(vampire) / heals(noDrain), 1.5, 0.08);
  // Out-healing you: a Blood Imp (10% lifesteal, and its Bleed heals it in Bloodlands) dies only on
  // a rare lucky run ("no kills in 80 hours").
  assert.ok(fight(gd, p, enemy('BloodImp')).killsPerHour < 0.05);
  // Healing you undo is damage your attacks deal, so it pays XP (CombatExperienceComponent).
  const wolf = gd.enemyById.get('Wolf');
  const stealing = fight(gd, p, enemy('Wolf'));
  const honest = fight(gd, p, enemy('Wolf', { stats: { ...wolf.stats, Lifesteal: 0 } }));
  assert.ok(stealing.combatXpPerHour / stealing.killsPerHour > honest.combatXpPerHour / honest.killsPerHour);
  // A Slime's healing never takes it past full, so early on it only undoes what you've done: "8.6s".
  close(fight(gd, p, enemy('RainbowSlime')).killSeconds, 8.6, 0.06);
});

test('stuns from different sources are one: Storm Wrapped and Storm Dragon Breath', () => {
  const p = rune(99);
  close(fight(gd, p, enemy('StormDragon')).killSeconds, 652, 0.05);
  close(fight(gd, p, enemy('StormElemental')).killSeconds, 586, 0.05);
});

test('effects with a big change are mixed, not averaged: Starblight takes 999% of your max hit for a turn', () => {
  close(fight(gd, rune(99), enemy('StarblightMarksman')).killSeconds, 126, 0.06);
});

test('a self-buff lasts the rest of the attack it is put on in: Vanished during Dive', () => {
  close(fight(gd, mage(), enemy('SeaPelican')).killSeconds, 64.1, 0.07);
});

test('Fracture against heavy armour: it covers only the hits that come before it wears off', () => {
  const levels = at(99);
  const staff = 'MelvorBase:EarthStaff';
  const kit = { gear: [staff, 'MelvorBase:AdeptWizardRobes'], stance: 'Offensive', spell: castableSpells(gd, staff, levels, null)[0], levels };
  const roller = enemy('BlackstoneRoller', { passive: undefined });
  const plain = fight(gd, buildPlayer(gd, kit), roller);
  const fractured = fight(gd, buildPlayer(gd, { ...kit, imbuement: 'FractureIV' }), roller);
  // "+64%" kills an hour (it was +89% when Fracture counted for its share of the time).
  close(fractured.killsPerHour / plain.killsPerHour - 1, 0.64, 0.12);
});
