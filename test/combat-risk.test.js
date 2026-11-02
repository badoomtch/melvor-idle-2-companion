// Death risk, food, enemy attacks per kill, reflect, stacking effects, imbuements and prayer points,
// against the game's combat code (FoodComponent.AutoEat, CharacterComponent turns and
// ReflectAttackDamage, CombatActionComponent spawning, ActiveStackingEffect, MagicSpellsComponent).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { autoEatChain, buildEnemy, buildPlayer, castableImbuements, castableSpells, fight, resistance } from '../engine/combat.js';
import { createGameData } from '../engine/gamedata.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const at = (level) => Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'].map((s) => [s, level]));
const enemyOf = (id, patch = {}) => ({ ...gd.enemyById.get(id), passive: undefined, ...patch });

// The same chain worked out the long way: every HP from 1 to full, one attack at a time, until it settles.
function bruteForce({ maxHp, threshold, heal, rolls }) {
  const eat = (hp) => {
    const n = Math.max(1, Math.floor((maxHp - hp) / heal));
    return { n, after: Math.min(maxHp, hp + n * heal) };
  };
  let pi = new Float64Array(maxHp + 1);
  pi[maxHp] = 1;
  let out;
  for (let it = 0; it < 4000; it++) {
    const next = new Float64Array(maxHp + 1);
    let deaths = 0;
    let eats = 0;
    let items = 0;
    let healed = 0;
    const land = (from, to, m) => {
      // A killing hit counts as a death; the path goes on as if you ate from 1 HP, as the chain has it.
      if (to <= 0) deaths += m;
      const x = Math.max(1, to);
      if (x <= threshold) {
        const e = eat(x);
        eats += m;
        items += m * e.n;
        healed += m * (e.after - x);
        next[e.after] += m;
      } else next[x] += m;
    };
    for (let h = threshold + 1; h <= maxHp; h++) {
      const m = pi[h];
      if (!m) continue;
      let landed = 0;
      for (const r of rolls) {
        landed += r.w;
        for (let x = r.min; x <= r.max; x++) land(h, h - Math.max(1, Math.trunc(x * r.factor - r.armour)), (m * r.w) / (r.max - r.min + 1));
      }
      next[h] += m * (1 - landed);
    }
    out = { deathPerAttack: deaths, itemsPerEat: items / eats, healedPerItem: healed / items, attacksPerEat: 1 / eats };
    pi = next;
  }
  return { ...out, pi };
}

test('auto-eat: your HP at each attack is a chain, eating as many items as fit; it matches the long way round', () => {
  const rolls = [{ w: 0.6, min: 1, max: 40, factor: 1, armour: 0 }];
  // 30 a bite from 25 HP: two at once (to 85); from under 10, three.
  for (const heal of [30, 90]) {
    const c = autoEatChain({ maxHp: 100, threshold: 25, heal, rolls });
    const b = bruteForce({ maxHp: 100, threshold: 25, heal, rolls });
    close(c.deathPerAttack, b.deathPerAttack, 0.01);
    close(c.itemsPerEat, b.itemsPerEat, 0.01);
    close(c.healedPerItem, b.healedPerItem, 0.01);
    close(c.attacksPerEat, b.attacksPerEat, 0.01);
    for (const hp of [26, 40, 70, 100]) close(c.hpAt(hp), b.pi[hp], 0.02);
  }
  // A 90 heal from 25 or less always fills you up (one item), so less of it is used than it heals.
  const big = autoEatChain({ maxHp: 100, threshold: 25, heal: 90, rolls });
  assert.equal(big.itemsPerEat, 1);
  assert.ok(big.healedPerItem > 75 && big.healedPerItem < 90);
  // Filling up each time keeps you higher, so dying is less likely than eating to 85.
  assert.ok(big.deathPerAttack < autoEatChain({ maxHp: 100, threshold: 25, heal: 30, rolls }).deathPerAttack);
});

test('death risk and food come from the chain: overheal is wasted, eating that leaves you lower is riskier', () => {
  const p = buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels: at(90) });
  const dragon = buildEnemy(gd, enemyOf('BlackDragon'));
  const eat = (food) => fight(gd, p, dragon, { food: `MelvorBase:${food}` });
  // 900 HP, eating at 225. Shrimp (15) eats up to 45 at once to within 15 of full; a Lobster (281)
  // only two or three, to somewhere from 660 to 790; a Cheeseburger (887) fills you up.
  const [shrimp, lobster, burger] = [eat('Shrimp'), eat('Lobster'), eat('Cheeseburger')];
  assert.ok(lobster.hoursToDeath < shrimp.hoursToDeath && lobster.hoursToDeath < burger.hoursToDeath);
  // What an item heals on average: all of it, unless it would go past full.
  const used = (r) => r.hpLossPerHour / r.foodEatenPerHour;
  close(used(shrimp), 15);
  close(used(lobster), 281);
  assert.ok(used(burger) > 900 - burger.autoEatAt && used(burger) < 887, `${used(burger)}`);
});

test('enemy attacks per kill: both sides start a full turn after it spawns, so a quick kill can beat its first swing', () => {
  // Every hit lands and kills.
  const p = { ...buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar'], stance: 'Slash', levels: at(99) }), hitChanceBonus: 1, minHitOfMax: 0.5 };
  const golbin = gd.enemyById.get('Golbin');
  const tiny = (interval) => buildEnemy(gd, enemyOf('Golbin', { levels: { ...golbin.levels, Hitpoints: 1 }, stats: { ...golbin.stats, Armour: 0, AttackInterval: interval } }));
  // Killed on your first turn, every time.
  const slow = fight(gd, p, tiny(p.interval + 50));
  close(slow.killSeconds, p.interval / 1000);
  assert.equal(slow.enemyAttacksPerHour, 0);
  assert.equal(slow.damageTakenPerKill, 0);
  // On the same tick: it still swings (it ticks after you, before deaths are dealt with).
  const even = fight(gd, p, tiny(p.interval));
  close(even.enemyAttacksPerHour / even.killsPerHour, 1);
  // Its turns before the kill, not the fight's length times its rate.
  const quick = fight(gd, p, tiny(p.interval - 50));
  close(quick.enemyAttacksPerHour / quick.killsPerHour, 1);
  assert.ok(quick.killSeconds * quick.enemyTurnsPerSec < 1.03);
});

test('enemy attacks per kill in a real short fight: a Hobgolbin at 3.1s against 2.6s turns', () => {
  const p = buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar'], stance: 'Slash', levels: at(90) });
  const hob = buildEnemy(gd, enemyOf('Hobgolbin'));
  const r = fight(gd, p, hob);
  assert.equal(hob.interval, 3100);
  assert.equal(p.interval, 2600);
  // Kills on turn 1 (2.6s) come before its first swing at 3.1s; turn 2 (5.2s) after one swing. The
  // simulation of the game's loop gives 0.585 swings a kill; the fight's length times its rate, 1.33.
  const swings = r.enemyAttacksPerHour / r.killsPerHour;
  close(swings, 0.585, 0.03);
  assert.ok(r.killSeconds * r.enemyTurnsPerSec > 1.3);
  // A long fight is close to its length times its rate.
  const dragon = fight(gd, p, buildEnemy(gd, enemyOf('GreenDragon')));
  close(dragon.enemyAttacksPerHour / dragon.killsPerHour, dragon.killSeconds * dragon.enemyTurnsPerSec, 0.04);
});

test('enemy reflect: Thorn Body and Thornhide send part of each hit back, never your last HP point', () => {
  assert.equal(gd.enemyById.get('DancingCactus').passive.reflect, 0.25);
  assert.equal(gd.enemyById.get('BrambleSerpent').passive.reflect, 0.4);
  const p = buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels: at(90) });
  const cactus = gd.enemyById.get('DancingCactus');
  const thorny = fight(gd, p, buildEnemy(gd, { ...cactus, passive: { ...cactus.passive, dots: [], stuns: [], ramps: [] } }));
  const smooth = fight(gd, p, buildEnemy(gd, { ...cactus, passive: undefined }));
  const back = thorny.effects.find((x) => x.who === 'player' && x.kind === 'reflect');
  // The simulation of the game's loop: 266 HP back per kill (of 3,700 taken).
  close(back.dps * thorny.killSeconds, 266, 0.03);
  close(thorny.damageTakenPerKill - smooth.damageTakenPerKill, back.dps * thorny.killSeconds, 1e-6);
  close(thorny.killSeconds, smooth.killSeconds);
  // At least 1 for every hit, however small: a Golbin with 40% reflect, two hits a kill.
  const golbin = gd.enemyById.get('Golbin');
  const tiny = fight(gd, p, buildEnemy(gd, { ...golbin, passive: { ...cactus.passive, names: [], reflect: 0.4 } }));
  assert.ok(tiny.effects.some((x) => x.kind === 'reflect') && tiny.damageTakenPerKill > 1.5);
});

test('your attack reflect counts as damage to the enemy: antler helmets, Wind Barrier Ring, prayer potions, Retribution', () => {
  const mods = (id) => gd.items[id].equip?.mods ?? gd.items[id].tool?.mods;
  assert.deepEqual(mods('MelvorBase:CaribouAntlerHelmet'), [{ stat: 'PercentAttackReflect', value: 0.06 }]);
  assert.deepEqual(mods('MelvorBase:ElkAntlerHelmet'), [{ stat: 'PercentAttackReflect', value: 0.04 }]);
  assert.deepEqual(mods('MelvorBase:WindBarrierRing'), [{ stat: 'PercentAttackReflect', value: 0.03 }]);
  assert.ok(mods('MelvorBase:PrayerPotionP2B').some((m) => m.stat === 'PercentAttackReflect' && m.when?.type === 'prayer'));
  assert.ok(gd.combat.prayers.find((x) => x.id === 'Retribution').mods.some((m) => m.stat === 'PercentAttackReflect' && m.value === 0.01));
  const levels = at(70);
  assert.equal(buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:CaribouAntlerHelmet'], stance: 'Slash', levels }).reflect, 0.06);
  const p = { ...buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels }), reflect: 0.06 };
  const dragon = buildEnemy(gd, enemyOf('GreenDragon'));
  const spiky = fight(gd, p, dragon);
  const plain = fight(gd, { ...p, reflect: 0 }, dragon);
  // The simulation: 91 HP back per kill, kills in 53.5s instead of 60.5s.
  close(spiky.effects.find((x) => x.who === 'enemy' && x.kind === 'reflect').dps * spiky.killSeconds, 91, 0.05);
  close(spiky.killSeconds, 53.5, 0.02);
  // Reflected damage gives no XP, like damage over time.
  assert.ok(spiky.combatXpPerHour / spiky.killsPerHour < plain.combatXpPerHour / plain.killsPerHour);
});

test('stacks that build up until the fight ends, and damage at the end of each of your turns', () => {
  const p = (lv) => buildPlayer(gd, { gear: ['MelvorBase:RuneScimitar', 'MelvorBase:RunePlatebody'], stance: 'Slash', levels: at(lv) });
  const noFx = (e) => ({ ...e, attacks: e.attacks.map((a) => ({ ...a, applies: [] })) });
  const perSec = (r) => r.damageTakenPerKill / r.killSeconds;
  const named = (r, name) => r.effects.find((x) => x.name === name);
  // Against the simulation of the game's loop (damage you take per second of fighting).
  const cases = [
    ['Moongazer', 99, 'Off Balance', 41.4],
    ['SandSentinel', 90, 'Quicksand', 65.7],
    ['SandNomad', 80, 'Ambush', 32.9],
    ['StormBeast', 99, 'Storm Surge', 104.6],
    ['Talm', 99, 'Deep Wound', 322],
  ];
  for (const [id, lv, name, sim] of cases) {
    const e = buildEnemy(gd, enemyOf(id));
    const r = fight(gd, p(lv), e);
    assert.ok(named(r, name), `${id}: ${name} counted`);
    assert.ok(!r.effectsNotCounted.includes(name));
    close(perSec(r), sim, 0.06);
    assert.ok(perSec(r) > perSec(fight(gd, p(lv), noFx(e))));
  }
  // Exsanguinate: -1% resistance a stack, on the share before the 70% cap (ResistanceStats).
  close(resistance(100, 300, 0, 0, -0.12), 0.75 * 0.88);
  // Rain of Blood puts a stack on with every hit (Rassal itself out-heals this player).
  const bloody = fight(gd, p(99), buildEnemy(gd, enemyOf('Moongazer', { attacks: [{ attack: 'RainOfBlood', chance: 0.25 }] })));
  assert.ok(named(bloody, 'Exsanguinate').stacks <= 12 && named(bloody, 'Exsanguinate').stacks > 6);
});

test('effect lifesteal heals you a share of your bleed damage', () => {
  assert.deepEqual(gd.items['MelvorBase:BloodSappingDagger'].equip.mods.filter((m) => m.stat === 'EffectLifesteal'), [{ stat: 'EffectLifesteal', value: 0.05, effect: 'Bleed' }]);
  const claws = buildPlayer(gd, { gear: ['MelvorBase:GriffinClaws'], stance: 'Stab', levels: at(70) });
  const wolf = buildEnemy(gd, enemyOf('DireWolf'));
  const dry = fight(gd, claws, wolf);
  const sapping = fight(gd, { ...claws, effectMods: [...claws.effectMods, { stat: 'EffectLifesteal', value: 0.05, effect: 'Bleed' }] }, wolf);
  const bleed = dry.effects.find((x) => x.who === 'enemy' && x.name === 'Bleed');
  assert.ok(bleed && sapping.hpLossPerHour < dry.hpLossPerHour);
  // 5% of each Bleed proc, but at least 1 a proc (ActiveCombatEffect.Damage), and procs are small:
  // about one a proc, "7.4 to 8.1 a kill" in the simulation of the game's loop.
  close((dry.hpLossPerHour - sapping.hpLossPerHour) / sapping.killsPerHour, 7.7, 0.15);
});

test('magic imbuements: once a turn on the first hit that lands, their runes every turn', () => {
  assert.equal(gd.combat.imbuements.length, 32);
  const burn = gd.combat.imbuements.find((x) => x.id === 'BurnIV');
  assert.deepEqual(burn.applies, [{ kind: 'dot', effect: 'Burn', chance: 0.15, to: 'target', when: 'firstHit', stacks: 1 }]);
  const levels = at(99);
  const spell = castableSpells(gd, 'MelvorBase:FireStaff', levels, null)[0];
  const kit = { gear: ['MelvorBase:FireStaff', 'MelvorBase:AdeptWizardRobes'], stance: 'Offensive', spell, levels };
  const plain = buildPlayer(gd, kit);
  const imbued = buildPlayer(gd, { ...kit, imbuement: 'MelvorBase:BurnIV' });
  assert.equal(imbued.imbuement.id, 'BurnIV');
  assert.ok(imbued.attacks.every((a) => a.applies.some((x) => x.effect === 'Burn' && x.when === 'firstHit')));
  // Not with a staff of another element.
  assert.equal(buildPlayer(gd, { ...kit, gear: ['MelvorBase:AirStaff'], spell: castableSpells(gd, 'MelvorBase:AirStaff', levels, null)[0], imbuement: burn }).imbuement, null);
  // The simulation of the game's loop: 10% more kills an hour on a Green Dragon (no XP for the burn).
  const dragon = buildEnemy(gd, enemyOf('GreenDragon'));
  const a = fight(gd, plain, dragon);
  const b = fight(gd, imbued, dragon);
  close(b.killsPerHour / a.killsPerHour - 1, 0.1, 0.04);
  assert.ok(b.effects.some((x) => x.who === 'enemy' && x.name === 'Burn'));
  // Its runes each turn, with the spell's.
  const runes = (r, id) => r.runesPerHour.find((x) => x.item === id)?.perHour ?? 0;
  close(runes(b, 'MelvorBase:SoulRune'), 2 * b.attacksPerHour);
  close(runes(b, 'MelvorBase:FireRune') - b.attacksPerHour * spell.runes.find((r) => r.item === 'MelvorBase:FireRune').qty, b.attacksPerHour);
  // Which you can use: Magic level, the staff's element and runes in the bank.
  const bank = { 'MelvorBase:FireRune': 10, 'MelvorBase:BodyRune': 10 };
  assert.deepEqual(castableImbuements(gd, 'MelvorBase:FireStaff', at(60), bank).map((x) => x.id), ['BurnI', 'BurnII']);
});
