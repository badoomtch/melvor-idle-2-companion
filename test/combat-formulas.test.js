// The combat model against the game's combat code (CharacterComponent, CharacterStats,
// TargetCharacterStats, the damage formulas, area effects and passives).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEnemy, buildPlayer, fight, hitsToKill, scoreGear } from '../engine/combat.js';
import { dungeonRun } from '../engine/dungeons.js';
import { createGameData } from '../engine/gamedata.js';
import { slayerCoinsPerKill, slayerOverview, slayerXpPerKill } from '../engine/slayer.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'].map((s) => [s, level]));
const enemyOf = (id, patch = {}) => ({ ...gd.enemyById.get(id), passive: undefined, ...patch });
const melee = (opts = {}) => buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(70), ...opts });
// Runs fn with gd's save-derived bonuses swapped in.
function withSave({ mods = null, bonuses = null }, fn) {
  const was = [gd.playerCombatMods, gd.playerBonuses];
  gd.playerCombatMods = mods;
  gd.playerBonuses = bonuses;
  try {
    return fn();
  } finally {
    [gd.playerCombatMods, gd.playerBonuses] = was;
  }
}

test('hits to kill: armour is on until a hit breaks it, and the killing blow is capped at the HP left', () => {
  // 10 HP, hits of 6 or 12: half the time one hit, otherwise a second (1.5), not 10 / 9.
  close(hitsToKill(10, [{ d: 6, p: 0.5 }, { d: 12, p: 0.5 }], [{ d: 6, p: 0.5 }, { d: 12, p: 0.5 }]).hits, 1.5);
  // Hits of 3 that never get through armour of 5: 4 hits for 10 HP.
  close(hitsToKill(10, [{ d: 3, p: 1 }], [{ d: 8, p: 1 }], 5).hits, 4);
  // A 3 against armour 3 breaks it; after that hits do 8: 3 + 8 kills 10 HP in 2.
  close(hitsToKill(10, [{ d: 3, p: 1 }], [{ d: 8, p: 1 }], 3).hits, 2);
  // Long fights: the average with the armour on, then off.
  const r = hitsToKill(100_000, [{ d: 10, p: 1 }], [{ d: 10, p: 1 }]);
  close(r.hits, 10_000, 1e-3);
});

test('enemy armour slows kills until it breaks; your armour from bonuses never breaks', () => {
  const treant = enemyOf('Treant');
  assert.ok(treant.stats.Armour > 0);
  const p = melee();
  const armoured = fight(gd, p, buildEnemy(gd, treant));
  const bare = fight(gd, p, buildEnemy(gd, { ...treant, stats: { ...treant.stats, Armour: 0 } }));
  assert.ok(armoured.killsPerHour < bare.killsPerHour * 0.95, `${armoured.killsPerHour} vs ${bare.killsPerHour}`);
  // XP per kill still pays 4 per point of armour (KilledExperienceStats).
  close(armoured.combatXpPerHour / armoured.killsPerHour - bare.combatXpPerHour / bare.killsPerHour, (4 * treant.stats.Armour * bare.combatXpPerHour) / bare.killsPerHour / ((treant.levels.Hitpoints ?? 1) * 10));

  // Armour 20 from a bonus (Zenith) comes off every hit an enemy lands, however hard it hits.
  const dragon = buildEnemy(gd, enemyOf('RedDragon'));
  const zenith = gd.combat.prayers.find((x) => x.id === 'Zenith');
  const plain = fight(gd, p, dragon);
  const shielded = withSave({ mods: zenith.mods }, () => fight(gd, melee(), dragon));
  assert.equal(withSave({ mods: zenith.mods }, () => melee().armour), 20);
  assert.ok(shielded.biggestHit === plain.biggestHit - 20, `${shielded.biggestHit} vs ${plain.biggestHit}`);
  assert.ok(shielded.damageTakenPerKill / shielded.killSeconds < plain.damageTakenPerKill / plain.killSeconds);
});

test('special attacks: each hit rolls on its own, MaxHit hits are fixed, and the turn waits for the last hit', () => {
  // Slicing Cuts: two hits of 60%, 250ms apart.
  const mantis = buildEnemy(gd, enemyOf('MangroveMantis'));
  const cuts = mantis.attacks.find((a) => a.hits[0].count === 2);
  assert.equal(mantis.biggestAttack, 1, 'its biggest single hit is a normal one, not 2 x 60%');
  close(mantis.turnExtraMs, cuts.chance * 250);
  const normalOnly = buildEnemy(gd, enemyOf('MangroveMantis', { attacks: [] }));
  const p = buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(10) });
  assert.equal(fight(gd, p, mantis).biggestHit, fight(gd, p, normalOnly).biggestHit);

  // A MaxHit attack always deals its share of max hit: twice a normal hit's average, on no protection.
  const slam = buildEnemy(gd, enemyOf('DrownedCrewman', { attacks: [{ attack: 'WildSlam', chance: 1 }] }));
  const normal = buildEnemy(gd, enemyOf('DrownedCrewman', { attacks: [] }));
  const max = slam.stances[0].maxHit;
  const dps = (e) => { const r = fight(gd, p, e); return r.damageTakenPerKill / r.killSeconds; };
  close(dps(slam) / dps(normal), max / ((1 + max) / 2), 0.02);

  // Chances that add up past 1 are scaled down, with no normal attack left (NormalizeAttackChances).
  const crowded = buildEnemy(gd, enemyOf('DrownedCrewman', { attacks: [{ attack: 'WildSlam', chance: 0.8 }, { attack: 'SlicingCuts', chance: 0.8 }] }));
  assert.equal(crowded.attacks.length, 2);
  close(crowded.attacks[0].chance, 0.5);
});

test('unavoidable attacks always land', () => {
  const beast = enemyOf('StormBeast');
  const special = beast.attacks.find((a) => !gd.combat.attacks[a.attack].avoidable);
  const only = buildEnemy(gd, { ...beast, attacks: [{ ...special, chance: 1 }] });
  const r = fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(99) }), only);
  close(r.enemyHitChance, 1);
});

test('power and protection bonuses for the Normal damage type count, and percent bonuses multiply', () => {
  const piety = gd.combat.prayers.find((x) => x.id === 'Piety');
  assert.ok(piety.mods.some((m) => m.stat === 'FlatPowerRating' && m.value === 420 && m.style === 'Melee'));
  const potion = gd.items['MelvorBase:MeleePotionP2B'].tool;
  assert.ok(potion.mods.some((m) => m.stat === 'FlatProtectionRating' && m.value === 30));
  const base = melee();
  const prayed = withSave({ mods: [...piety.mods, ...potion.mods] }, () => melee());
  // No gear: a power rating of 0 (shown as at least 1).
  assert.equal(base.power, 1);
  assert.equal(prayed.power, 420);
  assert.equal(prayed.protection, base.protection + 30);
  // (rating + flat) x (1 + percent), and stat bonuses rounded (CombatStatStats).
  const pct = withSave({ mods: [{ stat: 'PercentPowerRating', value: 0.15, style: 'Melee' }, { stat: 'FlatPowerRating', value: 100 }, { stat: 'FlatCombatStatValue', value: 13, combatStat: 'StabAttackBonus' }, { stat: 'PercentCombatStatValue', value: 0.08, combatStat: 'StabAttackBonus' }] }, () => melee());
  assert.equal(pct.power, Math.trunc((0 + 100) * 1.15));
  assert.equal(pct.stats.StabAttackBonus, 14);
});

test('crit damage, hit chance bonuses and enemy armour cuts (Penance, Black Opal bolts)', () => {
  const faith = gd.combat.prayers.find((x) => x.id === 'Faith');
  close(withSave({ mods: faith.mods }, () => melee()).critMultiplier, 1.75);
  close(melee().critMultiplier, 1.5);
  const golbin = buildEnemy(gd, enemyOf('Golbin'));
  const revelation = gd.combat.prayers.find((x) => x.id === 'Revelation');
  const weak = buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(1) });
  const blessed = withSave({ mods: revelation.mods }, () => buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(1) }));
  close(fight(gd, blessed, golbin).hitChance, Math.min(1, fight(gd, weak, golbin).hitChance + 0.07));

  const roller = enemyOf('BlackstoneRoller');
  const penance = gd.combat.prayers.find((x) => x.id === 'Penance');
  assert.equal(withSave({ mods: penance.mods }, () => fight(gd, melee(), buildEnemy(gd, roller))).enemyArmour, roller.stats.Armour - 20);
  const bolts = gd.items['MelvorBase:BlackOpalBolts'].equip.mods;
  const strong = { ...melee(), baseMaxHit: 400, power: 2000 };
  const shred = { ...strong, enemyMods: bolts };
  assert.equal(fight(gd, shred, buildEnemy(gd, roller)).enemyArmour, Math.round(roller.stats.Armour * 0.95));
  assert.ok(fight(gd, shred, buildEnemy(gd, roller)).killsPerHour > fight(gd, strong, buildEnemy(gd, roller)).killsPerHour);
});

test('evasion for a style counts against enemies attacking with that style', () => {
  const charm = [{ stat: 'PercentEvasionRating', value: 0.1, style: 'Melee' }];
  const ranged = { gear: ['MelvorBase:OakBow'], stance: 'Accurate', levels: at(50) };
  const p = buildPlayer(gd, ranged);
  const charmed = withSave({ mods: charm }, () => buildPlayer(gd, ranged));
  assert.ok(charmed.evasion('Stab') > p.evasion('Stab'), 'against a melee attacker, while using ranged');
  assert.equal(charmed.evasion('Accurate'), p.evasion('Accurate'));
});

test('area effects: accuracy, enemy evasion and protection, food healing and immunity, unless bought off', () => {
  const levels = at(70);
  const pass = gd.areaById.get('DragonsPass');
  const plain = buildPlayer(gd, { gear: [], stance: 'Stab', levels });
  const there = buildPlayer(gd, { gear: [], stance: 'Stab', levels, area: pass });
  assert.equal(there.accuracy, Math.max(Math.trunc(Math.floor(plain.accuracy / 1) * 0.8), 1));
  const removal = [{ stats: 'CombatAreas', stat: 'DisableAreaEffect', value: 1, scope: { Area: pass.name } }];
  assert.equal(withSave({ bonuses: removal }, () => buildPlayer(gd, { gear: [], stance: 'Stab', levels, area: pass })).accuracy, plain.accuracy);

  const windy = gd.areaById.get('WindyPlains');
  const drifter = buildEnemy(gd, enemyOf(windy.enemies[0]));
  assert.ok(fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels, area: windy }), drifter).hitChance < fight(gd, plain, drifter).hitChance);
  const crater = gd.areaById.get('MoonscarredCrater');
  const mage = buildEnemy(gd, enemyOf(crater.enemies[0]));
  assert.ok(fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels, area: crater }), mage).enemyResistance >= fight(gd, plain, mage).enemyResistance);

  // Desert Plains: food heals 25% less, so more of it is eaten.
  const desert = gd.areaById.get('DesertPlains');
  const scorpion = buildEnemy(gd, enemyOf(desert.enemies[0]));
  const food = 'MelvorBase:Shrimp';
  const away = fight(gd, plain, scorpion, { food });
  const hot = fight(gd, buildPlayer(gd, { gear: [], stance: 'Stab', levels, area: desert }), scorpion, { food });
  assert.ok(away.foodPerHour > 0 && hot.foodPerHour > away.foodPerHour);

  // Blood Sanctum's enemies are immune to Ranged and Magic.
  const sanctum = gd.combat.dungeons.find((d) => d.id === 'BloodSanctum');
  assert.ok(sanctum.effect.some((m) => m.stat === 'ImmunityFrom' && m.style === 'Ranged'));
  assert.equal(dungeonRun(gd, sanctum, { gear: ['MelvorBase:OakBow'], stance: 'Accurate', levels: at(99), food }), null);
  assert.ok(dungeonRun(gd, sanctum, { gear: [], stance: 'Stab', levels: at(99), food })?.runMinutes > 0, 'melee can still run it');
});

test('combat and Slayer XP bonuses, Slayer coin bonuses and spawn time', () => {
  const golbin = buildEnemy(gd, enemyOf('Golbin'));
  const p = melee();
  const base = fight(gd, p, golbin);
  const boosted = withSave({ bonuses: [{ stat: 'PercentXPGained', value: 0.1, skill: 'Attack' }, { stat: 'PercentXPGained', value: 0.1, skill: 'Hitpoints' }] }, () => fight(gd, p, golbin));
  close(boosted.xpPerHour.Attack, base.xpPerHour.Attack * 1.1);
  close(boosted.xpPerHour.Hitpoints, base.xpPerHour.Hitpoints * 1.1);

  assert.equal(slayerXpPerKill(200, 0.1), (200 / 8 + 4) * 1.1);
  assert.equal(slayerCoinsPerKill(200, 0.1), Math.floor(0.1 * Math.pow(200, 1.15) * 1.1));
  const enemy = gd.enemyById.get('Golbin');
  const bestFights = new Map([['Golbin', { enemy, result: { killsPerHour: 100, risky: false, combatXpPerHour: 1000 }, player: { slayerCoins: { percent: 0.05, flat: 0 } } }]]);
  const kuren = (bonuses) => withSave({ bonuses }, () => slayerOverview(gd, { levels: { Slayer: 1 }, bestFights })).find((m) => m.master.id === 'Kuren');
  const golbinRow = (m) => m.enemies.find((x) => x.enemy.id === 'Golbin');
  const plainRow = golbinRow(kuren(null));
  const permitRow = golbinRow(kuren([{ stat: 'PercentXPGained', value: 0.1, skill: 'Slayer' }, { stat: 'PercentRewardCurrency', value: 0.03, skill: 'Slayer' }]));
  close(permitRow.xpPerKill, plainRow.xpPerKill * 1.1);
  assert.equal(permitRow.coinsPerKill, slayerCoinsPerKill(20, 0.08));

  // A Monster Lure and a Gold Jadestone Ring: less time between enemies, at least 250ms.
  const ring = gd.items['MelvorBase:GoldJadestoneRing'].equip.mods;
  const quick = fight(gd, { ...p, spawn: { percent: 0, flat: -300 } }, golbin);
  assert.ok(ring.some((m) => m.stat === 'FlatSpawnInterval' && m.value === -300));
  close(3_600_000 / quick.killsPerHour - 3_600_000 / base.killsPerHour, -300, 1e-3);
  const floor = fight(gd, { ...p, spawn: { percent: -1, flat: 0 } }, golbin);
  close(3_600_000 / floor.killsPerHour - floor.killSeconds * 1000, 250, 1e-3);
});

test('passives: Petrify once at the start, Smoke Body on your misses, Storm Wrapped stuns itself, poison stacks', () => {
  const gargoyle = gd.enemyById.get('StoneGargoyle');
  assert.ok(gargoyle.passive.stuns.some((s) => s.on === 'start' && s.chance === 0.15));
  const p = melee();
  const petrified = fight(gd, p, buildEnemy(gd, gargoyle));
  const free = fight(gd, p, buildEnemy(gd, { ...gargoyle, passive: { ...gargoyle.passive, stuns: [] } }));
  close(petrified.killSeconds - free.killSeconds, (0.15 * p.interval) / 1000, 1e-6);

  assert.ok(gd.enemyById.get('SoulsmithLieutenant').passive.ramps.some((r) => r.name === 'Smoke Body' && r.on === 'playerMiss'));

  const lynx = gd.enemies.find((e) => e.passive?.selfStuns?.length);
  assert.ok(lynx, 'Storm Wrapped stuns the enemy when it hits you');
  const calm = { ...lynx, passive: { ...lynx.passive, selfStuns: [] } };
  const rate = (e) => { const r = fight(gd, p, buildEnemy(gd, e)); return r.enemyAttacksPerHour / r.killsPerHour / r.killSeconds; };
  assert.ok(rate(lynx) < rate(calm));

  // Poison stacks up to 4: hit often, it hurts more than a single stack would.
  const moth = gd.enemies.find((e) => e.passive?.dots?.some((d) => d.name === 'Poison' && d.maxStacks === 4));
  const single = { ...moth, passive: { ...moth.passive, dots: moth.passive.dots.map((d) => ({ ...d, maxStacks: 1 })) } };
  const weak = buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(30) });
  assert.ok(fight(gd, weak, buildEnemy(gd, moth)).damageTakenPerKill > fight(gd, weak, buildEnemy(gd, single)).damageTakenPerKill);
});

test('a healing enemy pays XP for the damage that undid its healing', () => {
  const slime = gd.enemies.find((e) => e.passive?.healPerTurn > 0 && !e.passive.immuneTo.length);
  const p = buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(60) });
  const healing = fight(gd, p, buildEnemy(gd, slime));
  const still = fight(gd, p, buildEnemy(gd, { ...slime, passive: { ...slime.passive, healPerTurn: 0 } }));
  assert.ok(healing.killsPerHour > 0 && healing.combatXpPerHour / healing.killsPerHour > still.combatXpPerHour / still.killsPerHour);
});

test('supplies: kept ammo, runes, prayer points and food are not used up', () => {
  // Shop and Astrology bonuses come from the save's bonuses, by stats type (not Ranching's food preservation).
  const astro = [{ stats: 'CombatAction', stat: 'FlatSpawnInterval', value: -250 }, { stats: 'CombatFood', stat: 'FoodPreservationChance', value: 0.01 }, { stats: 'RanchingAction', stat: 'FoodPreservationChance', value: 0.05 }];
  const starred = withSave({ bonuses: astro }, () => melee());
  assert.equal(starred.spawn.flat, -250);
  close(starred.keep.food, 0.01);
  const golbin = buildEnemy(gd, enemyOf('Golbin'));
  const bow = buildPlayer(gd, { gear: ['MelvorBase:OakBow', 'MelvorBase:IronArrows'], stance: 'Accurate', levels: at(40) });
  assert.ok(bow.ammoId);
  {
    const keep = fight(gd, { ...bow, keep: { ...bow.keep, ammo: 0.25 } }, golbin);
    close(keep.ammoPerHour, fight(gd, bow, golbin).ammoPerHour * 0.75);
  }
  const p = melee();
  const praying = (keep) => fight(gd, { ...p, keep: { ...p.keep, prayer: keep } }, golbin, { prayers: ['Guard'] }).prayerPointsPerHour;
  close(praying(0.08), praying(0) * 0.92);
  const brute = buildEnemy(gd, enemyOf('Hobgolbin'));
  const weak = buildPlayer(gd, { gear: [], stance: 'Stab', levels: at(15) });
  const eat = (keep) => fight(gd, { ...weak, keep: { ...weak.keep, food: keep } }, brute, { food: 'MelvorBase:Shrimp' });
  assert.ok(eat(0).foodPerHour > 0);
  {
    close(eat(0.1).foodPerHour, eat(0).foodPerHour * 0.9);
    close(eat(0.1).foodEatenPerHour, eat(0).foodPerHour);
  }
});

test('ammo is picked by the fight, not by strength alone', () => {
  const crossbow = Object.entries(gd.items).find(([, it]) => it.equip?.weapon?.ammo === 'Bolts')?.[0];
  const levels = at(99);
  const roller = buildEnemy(gd, enemyOf('SandWurm'));
  const owned = new Map([[crossbow, 1], ['MelvorBase:DiamondBolts', 100], ['MelvorBase:BlackOpalBolts', 100], ['MelvorBase:TopazBolts', 100]]);
  const r = scoreGear(gd, { style: 'Ranged', gear: [crossbow], owned, levels, enemy: roller });
  // Topaz is beaten on every number by Diamond, so it isn't tried; the others are.
  assert.deepEqual([...r.kit.ammoOptions].sort(), ['MelvorBase:BlackOpalBolts', 'MelvorBase:DiamondBolts']);
  const xp = (ammo) => Math.max(...r.kit.stances.map((stance) => fight(gd, buildPlayer(gd, { gear: [crossbow, ammo], stance, levels }), roller).combatXpPerHour));
  const better = xp('MelvorBase:BlackOpalBolts') > xp('MelvorBase:DiamondBolts') * 1.001 ? 'MelvorBase:BlackOpalBolts' : 'MelvorBase:DiamondBolts';
  assert.equal(r.kit.ammo, better);
  assert.ok(r.kit.gear.includes(better));
});
