// Combat estimates using the game's own formulas: CharacterStats (accuracy, evasion, max hit,
// attack interval), TargetCharacterStats (hit chance, resistance), CharacterComponent.ModifyAttackDamage
// and the StrengthBonus / DamageBonus max-hit formulas. Isomorphic.
//
// Counts your gear, set bonuses, prayers, potions, pets and mastery (and gear that works on the enemy),
// conditional bonuses that hold, area effects, the enemy's passive, ward and armour, special attacks hit
// by hit, auto-eat and the chance of dying.
import { enemyLoot } from './lookup.js';

export const DEFAULT_WEAPON = 'MelvorBase:DefaultWeapon';
export const STYLES = ['Melee', 'Ranged', 'Magic'];
const HOUR_MS = 3_600_000;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const levelSum = (ratios, levels) => ratios.reduce((s, r) => s + (levels[r.level] ?? 1) * r.ratio, 0);
// Accuracy and evasion share one formula: floor((level + 9) * (bonus + 64)).
const rating = (level, bonus) => Math.floor((level + 9) * ((bonus ?? 0) + 64));
// C# Math.Round: halves go to the even neighbour.
const roundEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};
const total = (list) => list.reduce((s, m) => s + m.value, 0);

export function hitChance(accuracy, evasion) {
  const p = accuracy >= evasion ? 1 - evasion / 2 / accuracy : accuracy / 2 / evasion;
  return clamp(p, 0, 1);
}

// Share of damage a defender's protection rating removes: capped at 70% before the combat triangle.
export const resistance = (power, protection, triangle = 0) => clamp(clamp(protection / (power + protection), 0, 0.7) * (1 + triangle), 0, 1);

function maxHitFor(style, stats, levels) {
  const f = style.maxHit;
  const L = levelSum(f.levels, levels);
  if (f.type === 'DamageBonus') return Math.floor((stats[f.maxHitStat] ?? 0) * (1 + (stats[f.damageBonusStat] ?? 0)) * (1 + (L + 1) / 200));
  return Math.floor(22 + L + ((L + 17) * (stats[f.strengthStat] ?? 0)) / 64);
}

// Average landed damage for a roll uniform on [min, max]: x * factor - armour, at least 1.
// Prayer XP for one hit (PrayerExperienceStats): sqrt(3 + 0.2 x damage x total cost of the active
// prayers), averaged over every damage the hit can do (the square root makes the average matter).
function averagePrayerXp(min, max, factor, armour, prayerCost) {
  const step = Math.max(1, Math.floor((max - min + 1) / 400));
  let sum = 0;
  let n = 0;
  for (let x = min; x <= max; x += step) {
    sum += Math.sqrt(3 + 0.2 * Math.max(1, Math.trunc(x * factor - armour)) * prayerCost);
    n++;
  }
  return sum / n;
}

// A roll of 0 does nothing at all (CharacterComponent.PerformAttack only hurts when it's above 0).
function averageDamage(min, max, factor, armour) {
  const step = Math.max(1, Math.floor((max - min + 1) / 400));
  let sum = 0;
  let n = 0;
  for (let x = min; x <= max; x += step) {
    sum += x > 0 ? Math.max(1, Math.trunc(x * factor - armour)) : 0;
    n++;
  }
  return sum / n;
}

// What one of your landed hits does, as { d, p } values: a roll on [min, max], a critical hit with
// chance `crit` (CriticalHitMultiplier, on the roll), then x * factor - armour, at least 1.
function hitSpread(min, max, crit, critMultiplier, factor, armour) {
  const out = new Map();
  const step = Math.max(1, Math.floor((max - min + 1) / 200));
  const n = Math.floor((max - min) / step) + 1;
  const add = (x, p) => {
    const d = Math.max(1, Math.trunc(x * factor - armour));
    out.set(d, (out.get(d) ?? 0) + p);
  };
  for (let x = min; x <= max; x += step) {
    add(x, (1 - crit) / n);
    if (crit > 0) add(Math.trunc(x * critMultiplier), crit / n);
  }
  return [...out].map(([d, p]) => ({ d, p }));
}

const KILL_CELLS = 64;

// Damage values as whole cells of `size` HP, split between the nearest two so the average holds.
// Anything of `n` cells or more kills from anywhere on the grid, so it goes in the last one.
function cellsOf(spread, size, n) {
  const q = new Float64Array(n + 1);
  for (const { d, p } of spread) {
    const c = d / size;
    const lo = Math.floor(c);
    const f = c - lo;
    q[Math.min(lo, n)] += p * (1 - f);
    if (f > 0) q[Math.min(lo + 1, n)] += p * f;
  }
  return q;
}

/**
 * Expected landed hits to kill something with `hp` HP. A hit never takes more than the HP left
 * (CharacterHealth.Damage), so the last one is partly wasted. Hits do `pre` damage (armour on) until
 * one of at least `breakAt` breaks the armour (ArmourBroken), then `post`.
 * The last few hits' worth of HP is worked out exactly on a grid, where the waste matters; before
 * that each hit does its average, the armour still on with chance (1 - chance to break)^hits.
 * @returns { hits, armoured }: landed hits, and the share of them that hit armour
 */
export function hitsToKill(hp, pre, post, breakAt = Infinity) {
  if (!Number.isFinite(breakAt)) post = pre; // armour that can't break is always on
  const twoPhase = pre !== post;
  const big = Math.max(...pre.map((x) => x.d), ...post.map((x) => x.d));
  const h0 = Math.min(hp, 4 * big);
  const n = Math.max(1, Math.min(KILL_CELLS, Math.ceil(h0)));
  const size = h0 / n;
  const qPost = cellsOf(post, size, n);
  const ePost = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    let s = 1;
    for (let k = 1; k < i; k++) s += qPost[k] * ePost[i - k];
    ePost[i] = s / (1 - qPost[0]);
  }
  const breaking = twoPhase ? pre.filter((x) => x.d >= breakAt) : [];
  const ePre = new Float64Array(n + 1);
  if (twoPhase) {
    const qStay = cellsOf(pre.filter((x) => x.d < breakAt), size, n);
    const qBreak = cellsOf(breaking, size, n);
    for (let i = 1; i <= n; i++) {
      let s = 1 + qBreak[0] * ePost[i];
      for (let k = 1; k < i; k++) s += qStay[k] * ePre[i - k] + qBreak[k] * ePost[i - k];
      ePre[i] = s / (1 - qStay[0]);
    }
  }
  const mean = (spread) => spread.reduce((s, x) => s + x.d * x.p, 0);
  const mu2 = mean(post);
  const mu1 = twoPhase ? mean(pre) : mu2;
  const b = breaking.reduce((s, x) => s + x.p, 0);
  const logStay = Math.log1p(-Math.min(b, 1 - 1e-12));
  // Expected damage of the first k hits, with the armour still on for (1 - b)^i of them.
  const dealt = (k) => (b > 0 ? k * mu2 - ((mu2 - mu1) * -Math.expm1(k * logStay)) / b : k * mu1);
  let k = 0;
  if (hp > h0) {
    let lo = 0;
    let hi = (hp - h0) / mu1;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      if (dealt(mid) < hp - h0) lo = mid;
      else hi = mid;
    }
    k = (lo + hi) / 2;
  }
  if (!twoPhase) return { hits: k + ePost[n], armoured: 1 };
  const intact = Math.exp(k * logStay);
  const hits = k + intact * ePre[n] + (1 - intact) * ePost[n];
  return { hits, armoured: b > 0 ? Math.min(1, -Math.expm1(hits * logStay) / b / hits) : 1 };
}

const equipOf = (gd, id) => gd.items[id]?.equip ?? null;
export const styleOfStance = (gd, stance) => gd.combat.stances[stance]?.style ?? null;
export function weaponStyles(gd, weaponId) {
  const type = equipOf(gd, weaponId)?.weapon?.type;
  return [...new Set((gd.combat.weaponTypes[type]?.stances ?? []).map((s) => styleOfStance(gd, s)))];
}

const EVASION = new Set(['PercentEvasionRating', 'FlatEvasionRating']);

/**
 * The player's combat numbers for a set of gear.
 * @param gear item ids being worn (the weapon decides the style; without one the game uses fists)
 * @param stance attack stance id (Stab, Accurate, Offensive, ...)
 * @param spell spell object for magic, or null
 * @param darkness the area's darkness; light from gear cancels it
 * @param area where you fight ({ id, name, category, effect }): its effect counts unless bought off
 */
export function buildPlayer(gd, { gear, stance, spell = null, levels, darkness = 0, area = null, slayerTask = false }) {
  const st = gd.combat.stances[stance];
  const style = gd.combat.styles[st.style];
  const ids = gear.filter((id) => equipOf(gd, id));
  const weaponId = ids.find((id) => equipOf(gd, id).type === 'Weapon') ?? DEFAULT_WEAPON;
  if (!ids.includes(weaponId)) ids.push(weaponId);
  const stats = {};
  let power = 0;
  let protection = 0;
  const mods = [];
  const enemyMods = [];
  // Conditional bonuses (on a Slayer task, in an area, using a style, stance, spell or any prayer).
  const prayers = gd.player?.prayers ?? [];
  const holds = (w) => !w
    || (w.type === 'slayerTask' && slayerTask)
    || (w.type === 'area' && !!area && (!w.area || w.area === area.id) && (!w.category || w.category === area.category))
    || (w.type === 'style' && w.style === st.style)
    || (w.type === 'stance' && w.stance === stance)
    || (w.type === 'prayer' && prayers.length > 0 && (!w.prayer || prayers.includes(w.prayer)))
    || (w.type === 'spell' && spell?.id === w.spell);
  // Gear that works on the enemy goes to enemyMods, for fight(). Evasion for a style counts against
  // enemies attacking with it, whatever you use (EvasionRatingStats).
  const add = (m) => {
    const versus = !m.onEnemy && EVASION.has(m.stat);
    if ((m.style && m.style !== st.style && !versus) || !holds(m.when)) return;
    (m.onEnemy ? enemyMods : mods).push(m);
  };
  for (const id of ids) {
    const eq = equipOf(gd, id);
    for (const [k, v] of Object.entries(eq.stats)) stats[k] = (stats[k] ?? 0) + v;
    power += eq.power;
    protection += eq.protection;
    for (const m of eq.mods ?? []) add(m);
  }
  // Set bonuses for the pieces being worn (EquipmentSetBonus).
  for (const set of gd.combat.sets ?? []) {
    const pieces = set.items.filter((i) => ids.includes(i)).length;
    for (const b of set.bonuses) if (pieces >= b.count) for (const m of b.mods ?? []) add(m);
  }
  // Prayers, combat potions, pets and mastery from the save (gd.playerCombatMods).
  for (const m of gd.playerCombatMods ?? []) add(m);
  // The area's effect (CombatAreasComponent), unless a shop purchase turned it off.
  const areaOff = !!area && (gd.playerBonuses ?? []).some((b) => b.stat === 'DisableAreaEffect' && b.value > 0 && [area.name, area.id].includes(b.scope?.Area));
  if (!areaOff) for (const m of area?.effect ?? []) add(m);
  const mod = (name) => total(mods.filter((m) => m.stat === name && !m.combatStat && !(m.style && EVASION.has(name))));
  for (const m of mods) if (m.stat === 'FlatCombatStatValue' && m.combatStat) stats[m.combatStat] = (stats[m.combatStat] ?? 0) + m.value;
  // Percent bonuses to a stat: (base + flat) x (1 + percent), rounded unless it's a percentage (CombatStatStats).
  const percentStats = new Set(gd.combat.percentStats ?? []);
  const pct = {};
  for (const m of mods) if (m.stat === 'PercentCombatStatValue' && m.combatStat) pct[m.combatStat] = (pct[m.combatStat] ?? 0) + m.value;
  for (const [k, v] of Object.entries(pct)) stats[k] = percentStats.has(k) ? (stats[k] ?? 0) * (1 + v) : roundEven((stats[k] ?? 0) * (1 + v));
  if (style.usesSpells && spell) stats.SpellMaxHit = (stats.SpellMaxHit ?? 0) + spell.maxHit;

  const lv = { ...levels };
  for (const [k, v] of Object.entries(st.levelBonus ?? {})) lv[k] = (lv[k] ?? 1) + v;
  const light = mod('FlatLight');
  const darknessPenalty = clamp(Math.trunc(darkness - light), 0, 20);
  const dark = 1 - 0.05 * darknessPenalty;
  const weapon = equipOf(gd, weaponId).weapon ?? { elements: ['Neutral'], ammo: null };
  const ammoId = weapon.ammo ? ids.find((id) => equipOf(gd, id).ammoType === weapon.ammo) ?? null : null;
  const spellUsed = style.usesSpells ? spell : null;
  // The same kinds of bonus from the save outside gear, potions, pets and mastery: shop upgrades and
  // Astrology nodes (gd.playerBonuses), by stats type so Ranching's food preservation stays out.
  const saved = (stats, stat) => total((gd.playerBonuses ?? []).filter((b) => b.stats === stats && b.stat === stat && !b.scope));
  // Chances to keep supplies: ammo for its type, runes for the spell's element (PlayerComponent, MagicSpellsComponent).
  const keep = (stats, name, match) => clamp(total(mods.filter((m) => m.stat === name && match(m))) + saved(stats, name), 0, 1);

  return {
    style: st.style,
    stance,
    weaponId,
    ammoId,
    needsAmmo: !!weapon.ammo,
    spell: spellUsed,
    element: style.usesSpells && spell ? spell.element : (weapon.elements[0] ?? 'Neutral'),
    levels: lv,
    stats,
    accuracy: Math.max(Math.trunc(Math.floor(rating(levelSum(style.accuracyLevels, lv), stats[st.accuracyStat]) * (1 + mod('PercentAccuracyRating'))) * dark), 1),
    // Added to your hit chance (TargetCharacterStats.FlatHitChance).
    hitChanceBonus: mod('FlatHitChance') + saved('Target', 'FlatHitChance'),
    baseMaxHit: maxHitFor(style, stats, lv),
    percentMaxHit: mod('PercentMaxHit'),
    flatMaxHit: mod('FlatMaxHit'),
    flatMinHit: mod('FlatMinHit'),
    minHitOfMax: mod('MinHitBasedOnMaxHit'),
    interval: Math.max(Math.floor((stats[style.intervalStat] ?? 4000) * (1 + mod('PercentAttackInterval')) + mod('FlatAttackInterval')), 250),
    // (rating + flat) x (1 + percent) (PowerRatingStats, ProtectionRatingStats).
    power: Math.max(Math.trunc((power + mod('FlatPowerRating')) * (1 + mod('PercentPowerRating'))), 1),
    protection: Math.max(Math.trunc((protection + mod('FlatProtectionRating')) * (1 + mod('PercentProtectionRating'))), 0),
    hitpoints: (lv[style.hitpointsLevel] ?? 10) * 10,
    // Your armour comes only from bonuses (no gear has base armour), so it never breaks.
    armour: Math.max(stats[style.armourStat] ?? 0, 0),
    lifesteal: Math.max(stats.Lifesteal ?? 0, 0),
    critChance: clamp(mod('FlatCriticalHitChance'), 0, 1),
    critMultiplier: Math.max(1.5 + mod('FlatCriticalHitMultiplier'), 1),
    damageDealt: mod('PercentDamageDealt'),
    healingPercent: mod('PercentHealing') + saved('CombatFood', 'PercentHealing'),
    spawn: { percent: mod('PercentSpawnInterval') + saved('CombatAction', 'PercentSpawnInterval'), flat: mod('FlatSpawnInterval') + saved('CombatAction', 'FlatSpawnInterval') },
    keep: {
      ammo: keep('AmmoConsumption', 'AmmoPreservationChance', (m) => !m.ammoType || m.ammoType === weapon.ammo),
      runes: keep('MagicSpell', 'RunePreservationChance', (m) => !m.element || m.element === spellUsed?.element),
      prayer: keep('Prayer', 'CostPreservationChance', () => true),
      food: keep('CombatFood', 'FoodPreservationChance', () => true),
    },
    slayerCoins: { percent: mod('PercentRewardCurrency'), flat: mod('FlatRewardCurrency') },
    light,
    darknessPenalty,
    enemyMods,
    evasion(attackerStance) {
      const as = gd.combat.stances[attackerStance];
      const vs = (name) => total(mods.filter((m) => m.stat === name && (!m.style || m.style === as.style)));
      const ev = rating(levelSum(gd.combat.styles[as.style].evasionLevels, lv), stats[as.evasionStat]);
      return Math.max(Math.trunc(Math.floor(ev * (1 + vs('PercentEvasionRating')) + vs('FlatEvasionRating')) * dark), 1);
    },
  };
}

// Used when the data has no Normal attack.
const NORMAL_ATTACK = { name: 'Normal Attack', hits: [{ count: 1, interval: 0, normal: 1, maxHit: 0, currentHp: 0 }], avoidable: true };

// An enemy's numbers against each attack stance (its own stances are weighted at random each spawn).
export function buildEnemy(gd, enemy) {
  const weights = enemy.stances.reduce((s, x) => s + x.weight, 0) || 1;
  // Its attacks (NormalizeAttackChances): the normal attack takes what the special attacks leave, or
  // their chances are scaled to add up to 1.
  const listed = enemy.attacks.map((a) => ({ ...gd.combat.attacks[a.attack], chance: a.chance })).filter((a) => a.hits?.length);
  const specialChance = listed.reduce((s, a) => s + a.chance, 0);
  const attacks = specialChance < 1 ? [{ ...(gd.combat.attacks.Normal ?? NORMAL_ATTACK), chance: 1 - specialChance }, ...listed] : listed.map((a) => ({ ...a, chance: a.chance / specialChance }));
  // A multi-hit attack's later hits wait their interval, and its next turn starts after the last one.
  const extraMs = (a) => a.hits.reduce((s, h) => s + h.count * h.interval, 0) - a.hits[0].interval;
  return {
    enemy,
    hitpoints: (enemy.levels.Hitpoints ?? 1) * 10,
    interval: Math.max(enemy.stats.AttackInterval ?? 3000, 250),
    armour: Math.max(enemy.stats.Armour ?? 0, 0),
    power: Math.max(enemy.power, 1),
    protection: Math.max(enemy.protection, 0),
    element: enemy.element,
    attacks,
    turnExtraMs: attacks.reduce((s, a) => s + a.chance * extraMs(a), 0),
    // Its biggest single hit, as a share of its normal max hit.
    biggestAttack: Math.max(1, ...attacks.flatMap((a) => a.hits.map((h) => h.normal + h.maxHit))),
    stances: enemy.stances.map(({ stance, weight }) => {
      const st = gd.combat.stances[stance];
      const style = gd.combat.styles[st.style];
      return {
        stance,
        style: st.style,
        weight: weight / weights,
        accuracy: rating(levelSum(style.accuracyLevels, enemy.levels), enemy.stats[st.accuracyStat]),
        maxHit: Math.max(maxHitFor(style, enemy.stats, enemy.levels), 1),
      };
    }),
    evasion(attackerStance) {
      const as = gd.combat.stances[attackerStance];
      return Math.max(rating(levelSum(gd.combat.styles[as.style].evasionLevels, enemy.levels), enemy.stats[as.evasionStat]), 1);
    },
  };
}

const lootCache = new WeakMap();
const lootOf = (gd, enemy) => {
  if (!lootCache.has(enemy)) lootCache.set(enemy, enemyLoot(gd, enemy));
  return lootCache.get(enemy);
};

const triangleFor = (gd, playerStyle, enemyStyle) => gd.combat.triangle.find((t) => t.player === playerStyle && t.enemy === enemyStyle) ?? { maxHit: 0, resistance: 0 };

// A fight is risky when it can kill you within this many hours of leaving it running, food or not.
export const RISKY_HOURS = 8;

// Average stacks over a fight when one is added each time (up to max) and N happen per fight.
function averageStacks(perFight, max) {
  if (!(perFight > 0) || !(max > 0)) return 0;
  const n = Math.max(1, Math.round(perFight));
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.min(k, max);
  return sum / n;
}

// P(one damage roll uniform on [min, max], then x * factor - armour (at least 1), reaches `hp`).
function chanceAtLeast(min, max, factor, armour, hp) {
  if (max < min) return 0;
  const need = Math.ceil((hp + armour) / factor - 1e-9);
  if (need <= min) return Math.max(1, Math.trunc(min * factor - armour)) >= hp ? 1 : 0;
  if (need > max) return 0;
  return (max - need + 1) / (max - min + 1);
}

// Damage of one run of a damage-over-time effect (ActiveDamageOverTimeEffect): each proc deals every
// stack's damage at once; triggers while it runs add a stack (up to its max) but don't make it last
// longer. Triggers come `rate` per second.
function dotRunDamage(d, rate, tick) {
  const max = Math.max(1, d.maxStacks ?? 1);
  let sum = 0;
  for (let k = 1; k <= d.procs; k++) {
    const mean = (rate * k * d.interval) / 1000;
    let pmf = Math.exp(-mean);
    let below = 0;
    for (let s = 1; s < max; s++) {
      sum += pmf * tick(s);
      below += pmf;
      pmf *= mean / s;
    }
    sum += Math.max(0, 1 - below) * tick(max);
  }
  return sum;
}

// XP bonuses for one skill (Mastery Guild ranks and the like), as a share (ExperienceStats).
const xpBonus = (gd, skill) => total((gd.playerBonuses ?? []).filter((b) => b.skill === skill && b.stat === 'PercentXPGained' && !b.scope));

/**
 * Expected results of fighting one enemy over and over.
 * Counts the enemy's passive (immunity, ward, healing, stacking ramps, damage over time, stuns), its
 * armour until a hit breaks it, special attacks hit by hit, auto-eat (FoodComponent: eats at 25% HP
 * plus bonuses) and the chance of dying.
 * @param food item id eaten to heal
 */
export function fight(gd, p, e, { food = null, prayers = gd.player?.prayers ?? [] } = {}) {
  const passive = e.enemy.passive ?? null;
  // Gear that works on the enemy (lower accuracy, less ward or armour), and the area's effect on it.
  const onEnemy = (stat, combatStat) => total((p.enemyMods ?? []).filter((m) => m.stat === stat && (!combatStat || m.combatStat === combatStat)));
  const ward = Math.max(0, (e.enemy.stats.MaximumWard ?? 0) + onEnemy('FlatCombatStatValue', 'MaximumWard'));
  const immune = !!passive?.immuneTo.includes(p.style) || onEnemy('ImmunityFrom') > 0;
  // Its armour comes off every hit until one gets through it at least its own size; only armour of
  // its own can break (BaseArmour > 0), and it's whole again each spawn (EnemyComponent.Spawn).
  const armour = Math.max(0, roundEven((e.armour + onEnemy('FlatCombatStatValue', 'Armour')) * (1 + onEnemy('PercentCombatStatValue', 'Armour'))));
  const breakAt = e.armour > 0 ? armour : Infinity;
  const enemyPower = Math.max(Math.trunc((e.power + onEnemy('FlatPowerRating')) * (1 + onEnemy('PercentPowerRating'))), 1);
  const enemyProtection = Math.max(Math.trunc((e.protection + onEnemy('FlatProtectionRating')) * (1 + onEnemy('PercentProtectionRating'))), 0);

  // Auto-eat (FoodComponent): at or below 25% HP (plus bonuses) it eats enough to top you up, each
  // item healing its amount (plus healing bonuses) times (1 + auto-eat efficiency). Healing past full is wasted.
  const bonus = (stat) => total((gd.playerBonuses ?? []).filter((b) => b.stat === stat));
  const maxHp = p.hitpoints;
  const threshold = Math.round(clamp(0.25 + bonus('FlatAutoEatThreshold'), 0, 1) * maxHp);
  const midHp = (threshold + maxHp) / 2;
  const spawnMs = Math.max(Math.trunc((gd.mechanics.enemySpawnMs ?? 3000) * (1 + (p.spawn?.percent ?? 0)) + (p.spawn?.flat ?? 0)), 250);

  // One pass of the fight with the enemy's accuracy, evasion and attack speed scaled by `adj`
  // (its stacking passives, averaged over the fight).
  const run = (adj) => {
    const active = prayers.map((id) => gd.combat.prayers?.find((x) => x.id === id)).filter(Boolean);
    const prayerCost = active.reduce((sum, x) => sum + x.cost, 0);
    let prayerXpPerHit = 0;
    const elemBonus = gd.combat.elements.find((x) => x.player === p.element && x.enemy === e.element)?.percentMaxHit ?? 0;
    const enemyEvasion = Math.max(1, Math.trunc(e.evasion(p.stance) * (1 + adj.evasion + onEnemy('PercentEvasionRating'))));
    const playerHit = immune ? 0 : clamp(hitChance(p.accuracy, enemyEvasion) + (p.hitChanceBonus ?? 0), 0, 1);
    const enemyRes = resistance(p.power, enemyProtection);
    const factor = (1 - enemyRes) * (1 + p.damageDealt);
    const eInterval = Math.max(250, Math.floor(e.interval * (1 + adj.interval + onEnemy('PercentAttackInterval'))));
    // Its turn lasts until the last hit of a multi-hit attack (AttackAction's hit timer).
    const eTurnMs = eInterval + (e.turnExtraMs ?? 0);

    let landedPerKill = 0;
    let playerMax = 0;
    let enemyAttempts = 0; // its hits tried per turn (each hit of a special attack rolls on its own)
    let enemyLanded = 0;
    let enemyDamage = 0; // damage per turn
    let enemyMaxHit = 0;
    let biggestHit = 0;
    const damageRolls = []; // per enemy turn, for the chance of dying: { weight, min, max, currentHp, factor, armour }
    for (const es of e.stances) {
      const tri = triangleFor(gd, p.style, es.style);
      const maxHit = Math.max(Math.floor((p.baseMaxHit * (1 + p.percentMaxHit + elemBonus) + p.flatMaxHit) * (1 + tri.maxHit)), 1);
      const minHit = clamp(Math.floor(1 + p.flatMinHit + maxHit * p.minHitOfMax), 1, maxHit);
      const critMultiplier = p.critMultiplier ?? 1.5;
      const post = hitSpread(minHit, maxHit, p.critChance, critMultiplier, factor, 0);
      const pre = armour > 0 ? hitSpread(minHit, maxHit, p.critChance, critMultiplier, factor, armour) : post;
      const kill = hitsToKill(e.hitpoints, pre, post, breakAt);
      landedPerKill += es.weight * kill.hits;
      if (prayerCost > 0) prayerXpPerHit += es.weight * (kill.armoured * averagePrayerXp(minHit, maxHit, factor, armour, prayerCost) + (1 - kill.armoured) * averagePrayerXp(minHit, maxHit, factor, 0, prayerCost));
      playerMax = Math.max(playerMax, maxHit);

      const hit = hitChance(Math.trunc(es.accuracy * (1 + adj.accuracy + onEnemy('PercentAccuracyRating'))), p.evasion(es.stance));
      const playerRes = resistance(enemyPower, p.protection, tri.resistance);
      const eFactor = 1 - playerRes;
      const eMin = clamp(Math.floor(1 + es.maxHit * (passive?.minHitOfMax ?? 0)), 1, es.maxHit);
      enemyMaxHit += es.weight * es.maxHit;
      // Each hit of each attack: a share of a normal roll, a fixed share of max hit (MaxHit formula, no
      // roll) and a share of your HP left. Unavoidable attacks always land.
      for (const a of e.attacks) {
        for (const h of a.hits) {
          const lands = a.avoidable ? hit : 1;
          const fixed = Math.trunc(es.maxHit * h.maxHit);
          const lo = Math.trunc(eMin * h.normal) + fixed;
          const hi = Math.trunc(es.maxHit * h.normal) + fixed;
          const share = es.weight * a.chance * h.count;
          const landed = share * lands;
          const mid = Math.trunc(midHp * h.currentHp);
          enemyAttempts += share;
          enemyLanded += landed;
          enemyDamage += landed * averageDamage(lo + mid, hi + mid, eFactor, p.armour);
          damageRolls.push({ weight: landed, min: lo, max: hi, currentHp: h.currentHp, factor: eFactor, armour: p.armour });
          const top = hi + Math.trunc(maxHp * h.currentHp);
          if (top > 0) biggestHit = Math.max(biggestHit, Math.max(1, Math.trunc(top * eFactor - p.armour)));
        }
      }
    }
    const enemyHitChance = enemyAttempts > 0 ? enemyLanded / enemyAttempts : 0;
    const enemyAvgHit = enemyLanded > 0 ? enemyDamage / enemyLanded : 0;
    // Stuns it puts on itself when it hits you (Storm Wrapped) cost it turns, then Staggered.
    let selfStun = 0;
    for (const s of passive?.selfStuns ?? []) {
      const rate = (enemyLanded / eTurnMs) * s.chance; // per ms
      const cost = s.turns * eInterval;
      selfStun += (cost * rate) / (1 + rate * (s.turns + 5) * eInterval);
    }
    const enemyTurnsPerSec = (1000 / eTurnMs) * (1 - Math.min(0.9, selfStun));
    let enemyDps = enemyDamage * enemyTurnsPerSec;
    const enemyHitsPerSec = enemyLanded * enemyTurnsPerSec;
    const enemyAttemptsPerSec = enemyAttempts * enemyTurnsPerSec;

    // Ward: each of the first `ward` hits you land does less (the first only 1), about (ward + 1) / 2
    // hits' worth in all (CharacterComponent damage formula).
    let attacksPerKill = playerHit > 0 ? landedPerKill / playerHit + (ward > 0 ? (ward + 1) / 2 / playerHit : 0) : Infinity;
    let killMs = attacksPerKill * p.interval;
    // HP taken off per attack, after armour and wasted damage.
    const perAttack = playerHit > 0 ? (e.hitpoints * playerHit) / landedPerKill : 0;
    let healFactor = 1;
    // Healing each of its turns (Slime): slower kills, or none if it out-heals you.
    if (passive?.healPerTurn > 0 && Number.isFinite(killMs)) {
      const h = passive.healPerTurn;
      const perTurn = perAttack * (eTurnMs / p.interval);
      const before = killMs;
      if (perTurn <= h * e.hitpoints) killMs = Infinity;
      else killMs = Math.max(killMs, (-Math.log(1 - (h * e.hitpoints) / perTurn) / h) * eTurnMs);
      attacksPerKill = killMs / p.interval;
      healFactor = killMs / before;
    }
    const playerHitsPerSec = (playerHit * 1000) / p.interval;
    const rateOf = (on) => (on === 'playerHit' ? playerHitsPerSec : on === 'playerMiss' ? ((1 - playerHit) * 1000) / p.interval : on === 'enemyAttack' ? enemyAttemptsPerSec : enemyHitsPerSec);
    // Stuns: you lose the turn you were on and the stunned turns, then are slowed and can't be
    // stunned again for 5 turns (Staggered). One at the start of the fight (Petrify) only delays it.
    let stunShare = 0;
    let startStunMs = 0;
    for (const s of passive?.stuns ?? []) {
      if (s.on === 'start') {
        startStunMs += s.chance * s.turns * p.interval;
        continue;
      }
      const rate = (rateOf(s.on) * s.chance) / 1000; // per ms
      const cost = (s.turns + 1) * p.interval;
      stunShare += (cost * rate) / (1 + rate * (s.turns + 5) * p.interval);
    }
    if (stunShare > 0 && Number.isFinite(killMs)) killMs /= 1 - Math.min(0.9, stunShare);
    if (Number.isFinite(killMs)) killMs += startStunMs;
    // Damage over time it puts on you: each proc through your resistance and armour (at least 1).
    const playerRes = resistance(enemyPower, p.protection);
    for (const d of passive?.dots ?? []) {
      const triggers = (d.on === 'start' ? 1000 / (killMs + spawnMs) : rateOf(d.on)) * d.chance; // per second
      if (!(triggers > 0)) continue;
      const base = d.formula === 'DamageDealt' ? Math.max(1, enemyAvgHit * d.percent) : Math.max(1, Math.trunc(enemyMaxHit * d.percent));
      const tick = (stacks) => Math.max(1, Math.trunc(stacks * base * (1 - playerRes) - p.armour));
      const duration = (d.procs * d.interval) / 1000;
      enemyDps += dotRunDamage(d, triggers, tick) / (duration + 1 / triggers);
    }

    const cycleMs = killMs + spawnMs;
    const killsPerHour = Number.isFinite(cycleMs) ? HOUR_MS / cycleMs : 0;
    const attacksPerHour = killsPerHour * attacksPerKill;
    const fightSecs = Number.isFinite(killMs) ? killMs / 1000 : 0;

    const st = gd.combat.stances[p.stance];
    // XP comes from the damage you deal, its HP plus anything it healed (CombatExperienceComponent), and
    // on the kill for its armour and ward (KilledExperienceStats); XP bonuses raise both.
    const killXp = e.hitpoints * healFactor + 4 * e.armour + 50 * Math.max(0, e.enemy.stats.MaximumWard ?? 0);
    const xpPerHour = Object.fromEntries(st.xp.map((x) => [x.skill, killXp * x.perDamage * (1 + xpBonus(gd, x.skill)) * killsPerHour]));
    const combatXpPerHour = Object.values(xpPerHour).reduce((s, v) => s + v, 0);

    const prayerXpPerHour = attacksPerHour * playerHit * prayerXpPerHit * (1 + xpBonus(gd, 'Prayer'));
    const enemyAttacksPerHour = fightSecs * enemyTurnsPerSec * killsPerHour;
    // Prayer points each turn, yours or its, unless the cost is kept (ActivePrayerSlot).
    const prayerPointsPerHour = active.reduce((sum, x) => sum + x.cost * (x.paidOn === 'enemy' ? enemyAttacksPerHour : attacksPerHour), 0) * (1 - (p.keep?.prayer ?? 0));
    // Prayer XP sits with the other skills' XP, but isn't part of the combat XP total.
    if (prayerXpPerHour > 0) xpPerHour.Prayer = prayerXpPerHour;

    return {
      playerHit, playerAvg: perAttack / Math.max(playerHit, 1e-9), playerMax, enemyRes, eInterval, eTurnMs, enemyDps, enemyHitChance, biggestHit, damageRolls, attacksPerKill, killMs,
      killsPerHour, attacksPerHour, xpPerHour, combatXpPerHour, prayerXpPerHour, prayerPointsPerHour, enemyAttacksPerHour,
      enemyHitsPerKill: fightSecs * enemyHitsPerSec, enemyAttemptsPerKill: fightSecs * enemyAttemptsPerSec,
    };
  };

  // Stacking passives (Hivemind, Rage, ...) build up during each fight: run once, average the stacks
  // that fight would build, then run again with them.
  const base = { accuracy: 0, evasion: 0, interval: 0 };
  let f = run(base);
  if (passive?.ramps.length && f.killsPerHour > 0) {
    const adj = { ...base };
    for (const r of passive.ramps) {
      const perFight = r.on === 'playerHit' ? f.attacksPerKill * f.playerHit
        : r.on === 'playerMiss' ? f.attacksPerKill * (1 - f.playerHit)
          : r.on === 'enemyHit' ? f.enemyHitsPerKill : f.enemyAttemptsPerKill;
      const stacks = averageStacks(perFight, r.maxStacks);
      for (const m of r.mods) {
        if (m.stat === 'PercentAccuracyRating') adj.accuracy += m.value * stacks;
        if (m.stat === 'PercentEvasionRating') adj.evasion += m.value * stacks;
        if (m.stat === 'PercentAttackInterval') adj.interval += m.value * stacks;
      }
    }
    f = run(adj);
  }

  const damageTakenPerKill = Number.isFinite(f.killMs) ? (f.enemyDps * f.killMs) / 1000 : 0;
  const healedPerKill = p.lifesteal * e.hitpoints;
  const hpLossPerHour = Math.max(0, damageTakenPerKill - healedPerKill) * f.killsPerHour;

  const baseHeal = food ? gd.items[food]?.heal ?? 0 : 0;
  const healing = baseHeal > 0 ? Math.max(1, Math.trunc(baseHeal * (1 + (p.healingPercent ?? 0)))) : 0;
  const heal = healing > 0 ? Math.max(1, Math.trunc(healing * Math.max(0.01, 1 + bonus('FlatAutoEatEfficiency')))) : 0;
  const foodEaten = heal > 0 ? hpLossPerHour / Math.max(1, Math.min(heal, maxHp - threshold)) : null;
  // Food you keep when eating (FoodPreservationChance) isn't used up.
  const foodPerHour = foodEaten == null ? null : foodEaten * (1 - (p.keep?.food ?? 0));

  // Dying: with food, only one hit at least your current HP can kill you, and auto-eat keeps your HP
  // between the threshold and full (after every hit, so each hit of a special attack counts on its
  // own), so the risk per attack is the chance of a hit that big at an HP in that range. Without
  // food, you last until the damage adds up to your HP.
  let hoursToDeath = Infinity;
  if (heal > 0) {
    let perTurn = 0;
    const lo = threshold + 1;
    const span = Math.max(1, maxHp - threshold);
    const step = Math.max(1, Math.floor(span / 200));
    let samples = 0;
    for (let hp = lo; hp <= maxHp; hp += step) {
      samples++;
      for (const d of f.damageRolls) {
        const c = Math.trunc(hp * d.currentHp);
        perTurn += d.weight * chanceAtLeast(d.min + c, d.max + c, d.factor, d.armour, hp);
      }
    }
    perTurn /= Math.max(1, samples);
    const perHour = perTurn * f.enemyAttacksPerHour;
    hoursToDeath = perHour > 0 ? 1 / perHour : Infinity;
  } else if (hpLossPerHour > 0) {
    hoursToDeath = maxHp / hpLossPerHour;
  }
  const oneHitRisk = f.biggestHit >= maxHp;

  const loot = lootOf(gd, e.enemy);
  const lootPerHour = loot.totalValue * f.killsPerHour;
  // Ammo goes each attack and runes each turn, unless kept (PlayerComponent, MagicSpellsComponent).
  const ammoPerHour = p.ammoId ? f.attacksPerHour * (1 - (p.keep?.ammo ?? 0)) : 0;
  const runesPerHour = p.spell ? p.spell.runes.map((r) => ({ item: r.item, perHour: r.qty * f.attacksPerHour * (1 - (p.keep?.runes ?? 0)) })) : [];
  const supplyCost = ammoPerHour * gd.itemValue(p.ammoId) + runesPerHour.reduce((s, r) => s + r.perHour * gd.itemValue(r.item), 0) + (foodPerHour ?? 0) * gd.itemValue(food);

  return {
    hitChance: f.playerHit,
    maxHit: f.playerMax,
    // HP taken off per landed hit, after its armour and damage wasted on the killing blow.
    averageHit: f.playerAvg,
    enemyResistance: f.enemyRes,
    enemyArmour: armour,
    killSeconds: f.killMs / 1000,
    killsPerHour: f.killsPerHour,
    attacksPerHour: f.attacksPerHour,
    xpPerHour: f.xpPerHour,
    combatXpPerHour: f.combatXpPerHour,
    prayerXpPerHour: f.prayerXpPerHour,
    prayerPointsPerHour: f.prayerPointsPerHour,
    enemyHitChance: f.enemyHitChance,
    enemyAttacksPerHour: f.enemyAttacksPerHour,
    damageTakenPerKill,
    hpLossPerHour,
    foodPerHour,
    // Food eaten, counting the ones kept (foodPerHour is what gets used up).
    foodEatenPerHour: foodEaten,
    // The worst single hit it can land after your protection and armour.
    biggestHit: f.biggestHit,
    oneHitRisk,
    autoEatAt: threshold,
    // Expected hours of leaving it running before a death (Infinity: it can't kill you while food lasts).
    hoursToDeath,
    risky: oneHitRisk || hoursToDeath < RISKY_HOURS,
    immune,
    ward,
    passive: passive?.names ?? [],
    // Without eating, would you survive one kill?
    needsFood: damageTakenPerKill - healedPerKill >= maxHp * 0.9,
    lootPerHour,
    gpPerHour: loot.gp * f.killsPerHour,
    ammoPerHour,
    runesPerHour,
    supplyCost,
    profitPerHour: lootPerHour - supplyCost,
    loot,
  };
}

// ---------- gear you own ----------

// Every equippable item in the bank or worn in any loadout, with how many you have.
export function ownedEquipment(gd, bank, combatSave) {
  const owned = new Map();
  const add = (id, qty) => equipOf(gd, id) && owned.set(id, (owned.get(id) ?? 0) + Math.max(1, qty));
  for (const [id, qty] of Object.entries(bank ?? {})) add(id, qty);
  for (const set of [combatSave?.equipped, ...Object.values(combatSave?.storedLoadouts ?? {})]) for (const s of Object.values(set ?? {})) add(s.item, s.qty);
  return owned;
}

const meetsLevels = (gd, requires, levels) => (requires ?? []).every((r) => r.type !== 'level' || gd.levelOf(levels, r.skill) >= r.level);

// The player's saved loadouts, grouped by the style their weapon fights with.
export function savedLoadouts(gd, combatSave) {
  if (!combatSave) return {};
  const sets = { [combatSave.currentLoadout ?? 'current']: combatSave.equipped, ...combatSave.storedLoadouts };
  const out = {};
  for (const [id, slots] of Object.entries(sets)) {
    const gear = Object.values(slots ?? {}).map((s) => s.item);
    const weapon = gear.find((g) => equipOf(gd, g)?.type === 'Weapon') ?? DEFAULT_WEAPON;
    const weaponType = equipOf(gd, weapon)?.weapon?.type;
    const stance = combatSave.stances?.byLoadout?.[id] ?? combatSave.stances?.byWeaponType?.[weaponType] ?? gd.combat.weaponTypes[weaponType]?.stances[0];
    const style = styleOfStance(gd, stance);
    if (!style) continue;
    const entry = { id, name: combatSave.loadoutNames?.[id] ?? id, gear, stance, current: id === combatSave.currentLoadout };
    if (!out[style] || entry.current) out[style] = entry;
  }
  return out;
}

// Spells this weapon can cast that you have the runes for, best first.
export function castableSpells(gd, weaponId, levels, bank) {
  const elements = equipOf(gd, weaponId)?.weapon?.elements ?? [];
  return gd.combat.spells
    .filter((s) => !s.special && s.level <= gd.levelOf(levels, 'Magic') && elements.includes(s.element))
    .filter((s) => !bank || s.runes.every((r) => (bank[r.item] ?? 0) >= r.qty))
    .sort((a, b) => b.maxHit - a.maxHit);
}

// Candidate items for each slot, for one combat style.
function candidates(gd, style, owned, levels) {
  const bySlot = {};
  for (const slot of gd.combat.slots) {
    if (slot.fits === 'Ammo' || !meetsLevels(gd, slot.requires, levels) || slot.requires.some((r) => r.type !== 'level')) continue;
    bySlot[slot.id] = [...owned.keys()].filter((id) => {
      const eq = equipOf(gd, id);
      if (eq.type !== slot.fits || !meetsLevels(gd, eq.requires, levels)) return false;
      return eq.type !== 'Weapon' || weaponStyles(gd, id).includes(style);
    });
  }
  return bySlot;
}

// Ammo `b` is as good as `a` on every number (stats, power; a lower interval) and `a` has no bonuses.
function ammoBeats(gd, b, a) {
  const A = equipOf(gd, a);
  const B = equipOf(gd, b);
  if (A.mods?.length) return false;
  for (const k of new Set([...Object.keys(A.stats), ...Object.keys(B.stats)])) {
    const x = A.stats[k] ?? 0;
    const y = B.stats[k] ?? 0;
    if (k === 'AttackInterval' ? y > x : y < x) return false;
  }
  return B.power >= A.power && B.protection >= A.protection;
}

// Fills in what a weapon needs to fight: the best stance for the style, ammo and a spell.
function completeKit(gd, { style, gear, owned, levels, bank }) {
  const weaponId = gear.find((id) => equipOf(gd, id)?.type === 'Weapon') ?? DEFAULT_WEAPON;
  const weapon = equipOf(gd, weaponId)?.weapon;
  const stances = (gd.combat.weaponTypes[weapon?.type]?.stances ?? []).filter((s) => styleOfStance(gd, s) === style);
  if (!stances.length) return null;
  const kit = { gear: gear.filter((id) => equipOf(gd, id)?.type !== 'Ammo'), stances, spell: null, ammo: null };
  if (weapon?.ammo) {
    const ammo = [...owned.keys()]
      .filter((id) => equipOf(gd, id).ammoType === weapon.ammo && meetsLevels(gd, equipOf(gd, id).requires, levels))
      .sort((a, b) => (equipOf(gd, b).stats.RangedStrengthBonus ?? 0) - (equipOf(gd, a).stats.RangedStrengthBonus ?? 0));
    if (!ammo.length) return null;
    // Ammo brings power, accuracy, speed and bonuses as well as strength, so every one that isn't
    // beaten on all of them is tried in the fight (the four strongest).
    const options = [];
    for (const a of ammo) if (!options.some((b) => ammoBeats(gd, b, a))) options.push(a);
    kit.ammoOptions = options.slice(0, 4);
    kit.ammo = kit.ammoOptions[0];
    kit.gear.push(kit.ammo);
  }
  if (gd.combat.styles[style].usesSpells) {
    kit.spell = castableSpells(gd, weaponId, levels, bank)[0] ?? null;
    if (!kit.spell) return null;
  }
  return kit;
}

// XP per hour in one skill, or all combat XP when no skill is given.
export const xpOf = (result, skill) => (skill ? result.xpPerHour[skill] ?? 0 : result.combatXpPerHour);

// Best stance for a kit against one enemy.
const onTask = (gd, enemyId) => !!gd.player?.slayerTasks?.includes(enemyId);

// Each ammo option and stance; the kit comes back with the ammo that won.
function evaluateKit(gd, kit, levels, enemy, area, food, skill) {
  let best = null;
  for (const ammo of kit.ammoOptions ?? [kit.ammo]) {
    const gear = ammo === kit.ammo ? kit.gear : [...kit.gear.filter((id) => id !== kit.ammo), ammo];
    for (const stance of kit.stances) {
      const p = buildPlayer(gd, { gear, stance, spell: kit.spell, levels, darkness: area?.darkness ?? 0, area, slayerTask: onTask(gd, enemy.enemy.id) });
      const r = fight(gd, p, enemy, { food });
      const score = r.risky ? xpOf(r, skill) * 0.01 : xpOf(r, skill);
      if (!best || score > best.score * 1.001 || (score >= best.score * 0.999 && r.hpLossPerHour < best.result.hpLossPerHour)) best = { score, stance, player: p, result: r, kit: { ...kit, gear, ammo } };
    }
  }
  return best;
}

const isTwoHanded = (gd, gear) => gear.some((id) => equipOf(gd, id)?.alsoOccupies?.includes('Offhand'));

// Scores any gear list for a style against a built enemy, the way optimiseGear does: its best stance,
// plus the best ammo in `owned` and spell you have runes for. Null when it can't fight.
export function scoreGear(gd, { style, gear, owned, levels, bank, enemy, area = null, food = null, skill = null }) {
  if (isTwoHanded(gd, gear) && gear.some((id) => equipOf(gd, id)?.type === 'Offhand')) return null;
  const kit = completeKit(gd, { style, gear, owned, levels, bank });
  return kit && evaluateKit(gd, kit, levels, enemy, area, food, skill);
}

/**
 * Best gear you own for one style against one enemy: tries each owned item slot by slot and keeps
 * whatever gives the most combat XP per hour without letting the enemy one-hit you.
 */
export function optimiseGear(gd, { style, owned, levels, bank, enemy, area = null, food = null, start = [], skill = null }) {
  const e = buildEnemy(gd, enemy);
  const bySlot = candidates(gd, style, owned, levels);
  const slots = Object.keys(bySlot).sort((a, b) => (a === 'Weapon' ? -1 : b === 'Weapon' ? 1 : 0));
  const current = {};
  for (const id of start) {
    const slot = slots.find((s) => bySlot[s].includes(id) && !current[s]);
    if (slot) current[slot] = id;
  }
  const evaluate = (assign) => {
    const gear = Object.values(assign).filter(Boolean);
    if (isTwoHanded(gd, gear) && assign.Offhand) return null;
    const kit = completeKit(gd, { style, gear, owned, levels, bank });
    return kit && evaluateKit(gd, kit, levels, e, area, food, skill);
  };
  // Without a usable weapon for this style there's nothing to optimise.
  if (!current.Weapon) {
    let bestWeapon = null;
    for (const w of bySlot.Weapon ?? []) {
      const r = evaluate({ ...current, Weapon: w, Offhand: equipOf(gd, w).alsoOccupies?.includes('Offhand') ? undefined : current.Offhand });
      if (r && (!bestWeapon || r.score > bestWeapon.score)) bestWeapon = { ...r, weapon: w };
    }
    if (!bestWeapon) return null;
    current.Weapon = bestWeapon.weapon;
  }
  let best = evaluate(current);
  if (!best) {
    delete current.Offhand;
    best = evaluate(current);
    if (!best) return null;
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const slot of slots) {
      const taken = new Set(Object.entries(current).filter(([s]) => s !== slot).map(([, id]) => id));
      for (const id of [undefined, ...bySlot[slot]]) {
        if (id === current[slot] || (id && taken.has(id) && (owned.get(id) ?? 0) < 2)) continue;
        const trial = { ...current, [slot]: id };
        if (slot === 'Weapon' && id && equipOf(gd, id).alsoOccupies?.includes('Offhand')) delete trial.Offhand;
        const r = evaluate(trial);
        if (r && (r.score > best.score * 1.001 || (r.score >= best.score * 0.999 && r.result.hpLossPerHour < best.result.hpLossPerHour * 0.98))) {
          best = r;
          for (const k of Object.keys(current)) delete current[k];
          Object.assign(current, trial);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const slotsOut = Object.fromEntries(Object.entries(current).filter(([, id]) => id));
  if (best.kit.ammo) slotsOut.Ammo = best.kit.ammo;
  return { style, slots: slotsOut, gear: best.kit.gear, stance: best.stance, spell: best.kit.spell, player: best.player, result: best.result, enemy, area };
}

// ---------- where to fight ----------

// Enemies you can reach, with the area to fight them in. Quest-only areas are left out; areas behind
// something the save can't confirm (a shop purchase, an agility obstacle) are flagged.
export function fightableEnemies(gd, levels) {
  const out = [];
  for (const enemy of gd.enemies) {
    const options = enemy.areas.map((id) => gd.areaById.get(id)).filter((a) => a && a.kind === 'area' && !/Quest/i.test(a.category ?? ''));
    let best = null;
    for (const area of options) {
      const req = gd.checkRequirements({ skill: null, level: 0, requires: area.requires }, levels);
      if (!req.ok) continue;
      const candidate = { enemy, area, unknown: req.unknown };
      if (!best || candidate.unknown.length < best.unknown.length || (candidate.unknown.length === best.unknown.length && area.darkness < best.area.darkness)) best = candidate;
    }
    if (best && !enemy.requires.some((r) => r.kind === 'QuestStepActive')) out.push(best);
  }
  return out;
}

/** Ranks every reachable enemy for a gear set. */
export function rankFights(gd, { style, gear, stance, spell, levels, food }) {
  return fightableEnemies(gd, levels)
    .map(({ enemy, area, unknown }) => {
      const p = buildPlayer(gd, { gear, stance, spell, levels, darkness: area.darkness, area, slayerTask: onTask(gd, enemy.id) });
      return { enemy, area, unknown, player: p, result: fight(gd, p, buildEnemy(gd, enemy), { food }) };
    })
    .filter((x) => x.result.killsPerHour > 0);
}

const safe = (x) => !x.result.risky && x.unknown.length === 0;

/**
 * The full recommendation for one style: best owned gear, then the best enemies to use it on.
 * Picks a target with a first pass of gear, optimises against it, and repeats until the best fight
 * for the gear is the one it was optimised for (or a target was given).
 */
export function recommendStyle(gd, { style, owned, levels, bank, food, saved = null, target = null, skill = null }) {
  const rank = (g) => rankFights(gd, { style, gear: g.gear, stance: g.stance, spell: g.spell, levels, food });
  const bestSafe = (g) => {
    const ranked = rank(g).filter(safe).sort((a, b) => xpOf(b.result, skill) - xpOf(a.result, skill));
    return ranked[0] ? { enemy: ranked[0].enemy, area: ranked[0].area } : null;
  };
  let start = saved?.gear ?? [];
  let pick = target;
  if (!pick) {
    // A practice target that takes a while to kill, so the first pass values damage over respawn time.
    const dummy = { ...gd.enemies[0], levels: { ...gd.enemies[0].levels, Hitpoints: 10_000 } };
    const seed = optimiseGear(gd, { style, owned, levels, bank, enemy: dummy, food, start, skill });
    if (!seed) return null;
    pick = bestSafe(seed);
    if (!pick) return { style, gear: { ...seed, enemy: null, area: null }, fights: rank(seed) };
    start = seed.gear;
  }
  let opt = null;
  for (let round = 0; round < 3; round++) {
    opt = optimiseGear(gd, { style, owned, levels, bank, enemy: pick.enemy, area: pick.area, food, start, skill });
    if (!opt) return null;
    if (target) break;
    const next = bestSafe(opt);
    if (!next || next.enemy.id === pick.enemy.id) break;
    pick = next;
    start = opt.gear;
  }
  return { style, gear: opt, fights: rank(opt) };
}

// Food you own, best healing first (the save's chosen food first if you still have it).
export function pickFood(gd, bank, preferred) {
  if (preferred && (bank?.[preferred] ?? 0) > 0 && gd.items[preferred]?.heal) return preferred;
  const owned = gd.foods.filter((f) => (bank?.[f.item] ?? 0) > 0).sort((a, b) => b.heal - a.heal);
  return owned[0]?.item ?? gd.preferredFood ?? gd.defaultFood;
}
