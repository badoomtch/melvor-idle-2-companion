// The combat model against a simulation of the game's combat loop (60 ticks a second, ward, passives,
// healing, stuns), for the cases where the model was off: ward, healing enemies and Drain, Fracture,
// Storm Wrapped stuns, Starblight, armour that rarely breaks, effects passives put on you, special
// attacks in short fights, damage over time that starts at its hits, avoidance and ward from effects
// that are up, and healing that comes in lumps. The numbers in quotes are the simulation's, run long
// enough that they're good to a few percent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEnemy, buildPlayer, castableSpells, fight, healedTurnsToKill } from '../engine/combat.js';
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
  // a rare lucky run ("35 kills in 500 hours", a kill every 12 to 17 hours).
  const imp = fight(gd, p, enemy('BloodImp'));
  assert.ok(imp.killsPerHour > 1 / 25 && imp.killsPerHour < 1 / 9);
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
  const r = fight(gd, rune(99), enemy('StarblightMarksman'));
  // As Starblight wears off, Starblighted goes on for 5 turns (ActiveTurnCountingEffect's removal
  // effect): 5% less max hit, 8% less accuracy, and Starblight can't land again meanwhile. Each one
  // covers your next attack, not half of one: "9% of your attacks, and 44% under Starblighted".
  const share = (name) => r.effects.find((x) => x.who === 'player' && x.name === name)?.share ?? 0;
  close(share('Starblight'), 0.092, 0.1);
  close(share('Starblighted'), 0.44, 0.05);
  close(r.killSeconds, 136.6, 0.03);
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
  // "+63%" kills an hour (+89% when Fracture counted for its share of the time, +69% when its lower
  // protection was averaged into every hit before armour came off).
  close(fractured.killsPerHour / plain.killsPerHour - 1, 0.63, 0.05);
});

test('effects its passive puts on you: Burning Flame, Plague Touch, Acid Burns', () => {
  const applies = (id) => gd.enemyById.get(id).passive.applies.map((x) => `${x.kind} ${x.effect} ${x.on}`);
  assert.ok(applies('ShamblingBeastPhase1').includes('stacking AcidBurns enemyHit') && applies('ShamblingBeastPhase1').includes('eot AcidBurn enemyHit'));
  assert.ok(applies('SoulsmithCorruptor').includes('stacking PlagueTouch enemyHit'));
  assert.ok(applies('FlamberianDefector').includes('stacking BurningFlame enemyHit'));
  const p = buildPlayer(gd, { gear: ['MelvorBase:DragonruneGreatsword', 'MelvorBase:DragonPlatebody', 'MelvorBase:DragonPlatelegs', 'MelvorBase:DragonHelmet'], stance: 'Slash', levels: at(99) });
  const stacks = (r, name) => r.effects.find((x) => x.who === 'player' && x.name === name)?.stacks ?? 0;
  // Burning Flame: +10% Burn damage a stack, one a hit, up to 100; Burning Shield's armour counts too.
  const flame = fight(gd, p, enemy('FlamberianDefector'));
  assert.ok(stacks(flame, 'Burning Flame') > 50);
  close(flame.killSeconds, 760, 0.04);
  close(flame.damageTakenPerKill, 218_000, 0.06);
  // Plague Touch: +10% Poison damage a stack, up to 50 ("630,000 a kill").
  const plague = fight(gd, p, enemy('SoulsmithCorruptor'));
  assert.ok(stacks(plague, 'Plague Touch') > 40);
  close(plague.damageTakenPerKill, 630_000, 0.12);
  // Acid Burns: +100% Acid Burn damage and -1.5% protection a stack.
  const shambler = gd.enemyById.get('ShamblingBeastPhase2');
  const acid = fight(gd, p, enemy('ShamblingBeastPhase2'));
  const clean = fight(gd, p, enemy('ShamblingBeastPhase2', { passive: { ...shambler.passive, applies: [] } }));
  assert.ok(stacks(acid, 'Acid Burns') > 30 && acid.damageTakenPerKill > clean.damageTakenPerKill * 1.2);
  // Gas Ball's Explosive goes on you as it dies and comes off as the fight ends, on the same tick.
  assert.equal(gd.enemyById.get('GasBall').passive.applies.length, 0);
});

test('your special attacks: which one makes the kill, and on which hit, matters in a short fight', () => {
  const kill = (weapon, stance, lv) => fight(gd, buildPlayer(gd, { gear: [`MelvorBase:${weapon}`], stance, levels: at(lv) }), enemy('Golbin', { passive: undefined }));
  // Before: 3.37s, 3.30s and 3.60s; turns counted at their average length.
  close(kill('GriffinClaws', 'Stab', 60).killSeconds, 3.58, 0.02);
  close(kill('BloodReapScythe', 'Stab', 99).killSeconds, 3.69, 0.02);
  const mallet = kill('DarkAbyssMallet', 'Stab', 99);
  close(mallet.killSeconds, 4.04, 0.02);
  // A miss on your 3.6s first turn gives it a second and a third swing at 4.8s and 7.2s: "1.23 a kill".
  close(mallet.enemyAttacksPerHour / mallet.killsPerHour, 1.23, 0.05);
});

test('healing it gets back at full is lost: your hits at what they do, its healing between them', () => {
  // A simple case: 280 HP, it heals h a turn, then your hit of 1 to 50 lands 60% of the time. Played out
  // 20,000 times: "19.4, 50.0 and 98.7 turns" for h = 0, 10 and 13.
  const spread = Array.from({ length: 50 }, (_, i) => ({ d: i + 1, p: 1 / 50 }));
  const attacks = [{ chance: 1, hits: [{ count: 1, interval: 0, land: 0.6, spread }] }];
  close(healedTurnsToKill(280, attacks, 0), 19.4, 0.02);
  close(healedTurnsToKill(280, attacks, 10), 50.0, 0.03);
  close(healedTurnsToKill(280, attacks, 13), 98.7, 0.04);
  const p = buildPlayer(gd, { gear: ['MelvorBase:MagicBow', 'MelvorBase:RuneArrows'], stance: 'Accurate', levels: at(85) });
  // Silt Mosquito heals 84% as fast as you hurt it: "138s" (117s before, 57s without its healing).
  close(fight(gd, p, enemy('SiltMosquito')).killSeconds, 138, 0.06);
  // The same with only 10% lifesteal on its hits: "142s".
  const mosquito = gd.enemyById.get('SiltMosquito');
  close(fight(gd, p, enemy('SiltMosquito', { passive: undefined, attacks: [], stats: { ...mosquito.stats, Lifesteal: 0.1 } })).killSeconds, 142, 0.04);
});

test('damage over time it starts on its turns: the next start is the first turn after a run ends', () => {
  const p = buildPlayer(gd, { gear: ['MelvorBase:MagicBow', 'MelvorBase:RuneArrows'], stance: 'Accurate', levels: at(85) });
  const mosquito = gd.enemyById.get('SiltMosquito');
  const burns = enemy('SiltMosquito', { attacks: [], stats: { ...mosquito.stats, Lifesteal: 0 } });
  const r = fight(gd, p, burns);
  // Silt Burns: 30% of its turns, 2.2s apart, for 4s. The next chance comes 0.4s after a run ends, not a
  // random wait: a run every 9.5s, not 11.3s ("5.0 damage a second, a proc a second").
  close(r.effects.find((x) => x.who === 'player' && x.name === 'Silt Burns').dps, 5.0, 0.06);
  // While it runs you have 8% less accuracy: "58.8s", against 57.1s without it.
  close(r.killSeconds, 58.8, 0.02);
  // Its 2% lifesteal heals at least 1 a proc: "1.88 a second".
  const healing = fight(gd, p, enemy('SiltMosquito', { attacks: [] }));
  close(healing.effects.find((x) => x.who === 'enemy' && x.kind === 'heal').dps, 1.88, 0.03);
});

test('damage over time from bursts of hits: a run starts at the first hit after the last one ends', () => {
  const dragon = buildPlayer(gd, { gear: ['MelvorBase:DragonruneGreatsword', 'MelvorBase:DragonPlatebody', 'MelvorBase:DragonPlatelegs', 'MelvorBase:DragonHelmet'], stance: 'Slash', levels: at(99) });
  const dps = (r, name) => r.effects.find((x) => x.who === 'player' && x.name === name).dps;
  // Blood Fiend's Bleed: a share of the hit that starts it, and the first hit of Blood Volley's burst
  // that sets it off starts it, so its big single hits start more than their share: "12.3 a second".
  close(dps(fight(gd, rune(99), enemy('BloodFiend')), 'Bleed'), 12.3, 0.05);
  // Shambling Whips' four hits: "36.5 a second" of Sting (27.5 when starts came at random).
  const shambler = fight(gd, dragon, enemy('ShamblingBeastPhase1'));
  close(dps(shambler, 'Sting'), 36.5, 0.06);
  // Plague Blast's five: the rest of the burst adds Poison stacks at once: "193 a second".
  close(dps(fight(gd, dragon, enemy('SoulsmithCorruptor')), 'Poison'), 193, 0.06);
  // Flame Barrage: Burn with Burning Flame stacks as the fight has them: "234 a second".
  close(dps(fight(gd, dragon, enemy('FlamberianDefector')), 'Burn'), 234, 0.05);
});

test('effects that are up some of the time: avoidance, armour with evasion, and max ward', () => {
  const dragon = buildPlayer(gd, { gear: ['MelvorBase:DragonruneGreatsword', 'MelvorBase:DragonPlatebody', 'MelvorBase:DragonPlatelegs', 'MelvorBase:DragonHelmet'], stance: 'Slash', levels: at(99) });
  // Shambling Protection: half the evasion and 50 more armour together, so the hits that land while
  // it's up are the ones the armour cuts: "1505s" (1369s when they were averaged apart).
  const shambler = fight(gd, dragon, enemy('ShamblingBeastPhase1'));
  close(shambler.killSeconds, 1505, 0.03);
  close(shambler.damageTakenPerKill, 436_000, 0.06);
  // Its +4 max ward does nothing: it has no ward, and more max doesn't give it any (CharacterHealth).
  const protection = gd.combat.effects.ShamblingProtection;
  const noWard = { ...gd, combat: { ...gd.combat, effects: { ...gd.combat.effects, ShamblingProtection: { ...protection, mods: protection.mods.filter((m) => m.combatStat !== 'MaximumWard') } } } };
  close(fight(noWard, dragon, enemy('ShamblingBeastPhase1')).killSeconds, shambler.killSeconds, 1e-9);
  // Wall of Blood's +10 max ward: while its ward lasts, a hit loses only ward left / the bigger max.
  const walled = enemy('SandSentinel', { passive: undefined, attacks: [{ attack: 'WallofBlood', chance: 0.5 }] });
  const plain = enemy('SandSentinel', { passive: undefined, attacks: [{ attack: 'Normal', chance: 0.5 }] });
  const p = buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels: at(90) });
  assert.ok(fight(gd, p, walled).killSeconds < fight(gd, p, plain).killSeconds);
  // Poison Weak takes 30% off your Poison avoidance while it's up (Writhe, 4 turns).
  const resist = { ...dragon, effectMods: [...(dragon.effectMods ?? []), { stat: 'EffectAvoidanceChance', value: 0.5, effect: 'Poison' }] };
  const twisted = fight(gd, resist, enemy('ShamblingBeastPhase2'));
  const writhe = gd.combat.attacks.Writhe;
  const calm = { ...gd, combat: { ...gd.combat, attacks: { ...gd.combat.attacks, Writhe: { ...writhe, applies: writhe.applies.filter((x) => x.effect !== 'PoisonWeak') } } } };
  const poison = (r) => r.effects.find((x) => x.who === 'player' && x.name === 'Poison').dps;
  assert.ok(poison(twisted) > poison(fight(calm, resist, buildEnemy(calm, gd.enemyById.get('ShamblingBeastPhase2')))) * 1.03);
});

test('healing in lumps, and effects on you counted by the attacks they cover', () => {
  // Debilitating Curse's Blinded covers your next 2 attacks, each time it lands: "23% of them".
  const vampire = gd.enemyById.get('ElderVampire');
  const cursed = fight(gd, rune(99), enemy('ElderVampire', { stats: { ...vampire.stats, Lifesteal: 0 } }));
  close(cursed.effects.find((x) => x.who === 'player' && x.name === 'Blinded').share, 0.233, 0.04);
  // Its 12% lifesteal, 22% with Drain up, comes a hit at a time, each a share of what that hit dealt.
  // With Drain and no Curse: "1724s" (eight runs of 60 hours, 1583 to 1879). The model is about 9%
  // quicker: heals that come in streaks while Drain is up, and you weaker after a Curse, aren't in it.
  const curse = gd.combat.attacks.DebilitatingCurse;
  const uncursed = { ...gd, combat: { ...gd.combat, attacks: { ...gd.combat.attacks, DebilitatingCurse: { ...curse, applies: [] } } } };
  close(fight(uncursed, rune(99), buildEnemy(uncursed, vampire)).killSeconds, 1724, 0.12);
  // All of it: "2878s" (eight runs of 150 hours, 2541 to 3095).
  close(fight(gd, rune(99), enemy('ElderVampire')).killSeconds, 2878, 0.14);
  // Savage Dire Wolf against lv70 mithril: "1532s" (1755s when every hit healed the same).
  const m70 = buildPlayer(gd, { gear: ['MelvorBase:MithrilScimitar', 'MelvorBase:MithrilPlatebody'], stance: 'Slash', levels: at(70) });
  close(fight(gd, m70, enemy('SavageDireWolf')).killSeconds, 1532, 0.08);
  // Your Bleed from Griffin Claws comes a little at a time between your hits, keeping it off full HP,
  // so less of its healing is lost to being full: "73s" (68s when it was counted with your hits).
  close(fight(gd, buildPlayer(gd, { gear: ['MelvorBase:GriffinClaws'], stance: 'Stab', levels: at(99) }), enemy('SiltMosquito')).killSeconds, 73, 0.05);
  // Silt Mosquito against Fire Wave heals faster than you hurt it: "407s" (455s when it came evenly).
  close(fight(gd, mage(), enemy('SiltMosquito')).killSeconds, 407, 0.05);
});

test('stacks its passive and its attacks both put on it are one count (Dwarven Pride), and stuns in short fights', () => {
  // King Oyadazminis: Dwarven Pride on each of your hits and from Grand Boast, up to 40 in all, each 1%
  // less evasion and 1% of its max hit on its min hit: "1467s" (452s when they were counted apart).
  const king = fight(gd, rune(99), enemy('KingOyadazminis'));
  close(king.killSeconds, 1467, 0.04);
  close(king.damageTakenPerKill, 120_000, 0.06);
  assert.ok(king.effects.find((x) => x.name === 'Dwarven Pride').stacks <= 40);
  // Crushing Blade's stun ends with the fight, and none comes before your first hit: in a fight of
  // four of its turns it loses "0.2 of them, not 0.4" ("4.25 turns a kill").
  const dragon = buildPlayer(gd, { gear: ['MelvorBase:DragonruneGreatsword', 'MelvorBase:DragonPlatebody', 'MelvorBase:DragonPlatelegs', 'MelvorBase:DragonHelmet'], stance: 'Slash', levels: at(99) });
  const moth = fight(gd, dragon, enemy('ToxicMoth', { passive: undefined, attacks: [] }));
  close(moth.enemyAttacksPerHour / moth.killsPerHour, 4.25, 0.03);
  close(moth.killSeconds, 13.92, 0.02);
});

test('armour that breaks, hit by hit, when your turns vary; stuns on you in short fights', () => {
  const dragon = buildPlayer(gd, { gear: ['MelvorBase:DragonruneGreatsword', 'MelvorBase:DragonPlatebody', 'MelvorBase:DragonPlatelegs', 'MelvorBase:DragonHelmet'], stance: 'Slash', levels: at(99) });
  // Blackstone Golem's 100 armour comes off on the first hit at least that big; Crushing Blade's three
  // hits come 0.3s apart: "50.9s" (40.1s when broken and whole were averaged into every hit).
  close(fight(gd, dragon, enemy('BlackstoneGolem')).killSeconds, 50.9, 0.04);
  // Twisted Entanglement stuns you; Staggered keeps the next off for 5 turns, but goes as the fight
  // ends, so a fight of 37s has more stuns than a long one would: "37.7s" (34.3s before).
  close(fight(gd, dragon, enemy('TaintedTreant', { passive: undefined })).killSeconds, 37.7, 0.05);
});
