// Combat estimates using the game's own formulas: CharacterStats (accuracy, evasion, max hit,
// attack interval), TargetCharacterStats (hit chance, resistance), CharacterComponent.ModifyAttackDamage
// and the StrengthBonus / DamageBonus max-hit formulas. Isomorphic.
//
// Counts your gear, set bonuses, prayers, potions, pets and mastery (and gear that works on the enemy),
// conditional bonuses that hold, area effects, the enemy's passive, ward and armour, special attacks hit
// by hit, auto-eat and the chance of dying.
import { combatFoodMods } from './gamedata.js';
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

// Share of damage a defender's protection rating removes: (share + flat) x (1 + percent), capped at 70%
// before the combat triangle (ResistanceStats).
export const resistance = (power, protection, triangle = 0, flat = 0, percent = 0) => clamp(clamp((protection / (power + protection) + flat) * (1 + percent), 0, 0.7) * (1 + triangle), 0, 1);

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
    if (x > 0) sum += Math.sqrt(3 + 0.2 * Math.max(1, Math.trunc(x * factor - armour)) * prayerCost);
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
// chance `crit` (CriticalHitMultiplier, on the roll), then x * factor - armour, at least 1. A roll of
// 0 (a small share of a low min hit) does nothing.
function hitSpread(min, max, crit, critMultiplier, factor, armour) {
  const out = new Map();
  const step = Math.max(1, Math.floor((max - min + 1) / 200));
  const n = Math.floor((max - min) / step) + 1;
  const add = (x, p) => {
    const d = x > 0 ? Math.max(1, Math.trunc(x * factor - armour)) : 0;
    out.set(d, (out.get(d) ?? 0) + p);
  };
  for (let x = min; x <= max; x += step) {
    add(x, (1 - crit) / n);
    if (crit > 0) add(Math.trunc(x * critMultiplier), crit / n);
  }
  return [...out].map(([d, p]) => ({ d, p }));
}

const KILL_CELLS = 64;

// Average of fn over a roll uniform on [min, max] (about 32 points of it).
function overRoll(min, max, fn) {
  const step = Math.max(1, Math.ceil((max - min + 1) / 32));
  let sum = 0;
  let n = 0;
  for (let x = min; x <= max; x += step, n++) sum += fn(x);
  return n ? sum / n : 0;
}

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
  // A hit can say for itself whether it breaks the armour (`b`: hit while the armour was lowered).
  const breaks = (x) => x.b ?? x.d >= breakAt;
  const breaking = twoPhase ? pre.filter(breaks) : [];
  const ePre = new Float64Array(n + 1);
  if (twoPhase) {
    const qStay = cellsOf(pre.filter((x) => !breaks(x)), size, n);
    const qBreak = cellsOf(breaking, size, n);
    for (let i = 1; i <= n; i++) {
      let s = 1 + qBreak[0] * ePost[i];
      for (let k = 1; k < i; k++) s += qStay[k] * ePre[i - k] + qBreak[k] * ePost[i - k];
      ePre[i] = s / (1 - qStay[0]);
    }
  }
  if (twoPhase && hp > h0) {
    // A long fight with armour that can break: when it breaks is random, and the hits taken depend
    // on it (the average break doesn't give the average count), so the whole HP goes on the grid,
    // each hit a share of a cell that keeps its average. Also counts the hits that meet armour.
    const N = 2 * KILL_CELLS;
    const cell = hp / N;
    const qP = cellsOf(post, cell, N);
    const qS = cellsOf(pre.filter((x) => !breaks(x)), cell, N);
    const qB = cellsOf(breaking, cell, N);
    const eP = new Float64Array(N + 1);
    const eA = new Float64Array(N + 1);
    const met = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) {
      let s = 1;
      for (let k = 1; k < i; k++) s += qP[k] * eP[i - k];
      eP[i] = s / (1 - qP[0]);
      let t = 1 + qB[0] * eP[i];
      let a = 1;
      for (let k = 1; k < i; k++) {
        t += qS[k] * eA[i - k] + qB[k] * eP[i - k];
        a += qS[k] * met[i - k];
      }
      eA[i] = t / (1 - qS[0]);
      met[i] = a / (1 - qS[0]);
    }
    return { hits: eA[N], armoured: Math.min(1, met[N] / eA[N]) };
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

// Chance the kill comes on each of your turns (index 1, 2, ...) and when, on average, it comes then:
// worked out on a grid of its HP like hitsToKill, hit by hit (each landing or not, the kill on the
// first that takes the last of its HP), a turn being one of your attacks picked by chance. A turn that
// doesn't kill ends at its last hit and the next starts an interval later.
// @param attacks [{ chance, hits: [{ count, interval, land, spread }] }], spread null for a hit that
//   does no damage (a boomerang coming back)
const TURN_CELLS = 32;
function killTurnChances(hp, attacks, interval, maxTurns = 40) {
  const n = Math.max(1, Math.min(TURN_CELLS, Math.ceil(hp)));
  const size = hp / n;
  const seqs = attacks.map((a) => {
    const hits = [];
    let at = 0;
    a.hits.forEach((h, i) => {
      const q = new Float64Array(n + 1);
      if (h.spread) {
        const cells = cellsOf(h.spread, size, n);
        for (let k = 0; k <= n; k++) q[k] = cells[k] * h.land;
      }
      q[0] += h.spread ? 1 - h.land : 1;
      for (let c = 0; c < h.count; c++) {
        if (i > 0 || c > 0) at += h.interval;
        hits.push({ at, q });
      }
    });
    return { chance: a.chance, hits, length: interval + at };
  });
  const chances = [0];
  const times = [0];
  // One hit a turn, whatever the attack: a turn at a time, the kill at the end of its turn.
  if (seqs.every((sq) => sq.hits.length === 1)) {
    const q = new Float64Array(n + 1);
    for (const sq of seqs) for (let d = 0; d <= n; d++) q[d] += sq.chance * sq.hits[0].q[d];
    let live = new Float64Array(n + 1);
    live[n] = 1;
    let rest = 1;
    for (let k = 1; k <= maxTurns && rest > 1e-6; k++) {
      const next = new Float64Array(n + 1);
      let killed = 0;
      for (let c = 1; c <= n; c++) {
        const m = live[c];
        if (!m) continue;
        for (let d = 0; d <= n; d++) if (q[d]) (d >= c ? (killed += m * q[d]) : (next[c - d] += m * q[d]));
      }
      chances.push(killed);
      times.push(k * interval);
      live = next;
      rest -= killed;
    }
    return rest > 1e-6 ? null : { chances, times };
  }
  let alive = new Float64Array(n + 1);
  let elapsed = new Float64Array(n + 1); // chance x time since the fight started, by HP left
  alive[n] = 1;
  let left = 1;
  for (let k = 1; k <= maxTurns && left > 1e-6; k++) {
    const nextAlive = new Float64Array(n + 1);
    const nextElapsed = new Float64Array(n + 1);
    let killed = 0;
    let killedAt = 0;
    for (const sq of seqs) {
      let cur = alive.map((x) => x * sq.chance);
      let curT = elapsed.map((x) => x * sq.chance);
      for (const { at, q } of sq.hits) {
        const nc = new Float64Array(n + 1);
        const nt = new Float64Array(n + 1);
        for (let c = 1; c <= n; c++) {
          const m = cur[c];
          if (!m) continue;
          for (let d = 0; d <= n; d++) {
            if (!q[d]) continue;
            if (d >= c) {
              killed += m * q[d];
              killedAt += (curT[c] + m * (interval + at)) * q[d];
            } else {
              nc[c - d] += m * q[d];
              nt[c - d] += curT[c] * q[d];
            }
          }
        }
        cur = nc;
        curT = nt;
      }
      for (let c = 1; c <= n; c++) {
        nextAlive[c] += cur[c];
        nextElapsed[c] += curT[c] + cur[c] * sq.length;
      }
    }
    chances.push(killed);
    times.push(killed > 0 ? killedAt / killed : 0);
    alive = nextAlive;
    elapsed = nextElapsed;
    left -= killed;
  }
  if (left > 1e-6) return null;
  return { chances, times };
}

/**
 * Turns to kill something that heals itself between your turns but never past full (CharacterHealth.
 * Heal), as a chain over the damage you've done that it hasn't healed back, on a grid of its HP. Each
 * turn it heals `heal` (taking it no further than full: healing then is lost), then your turn does
 * its damage; the kill is when what's left reaches its HP. Solved exactly for the expected turns.
 * @param attacks your attacks as for killTurnChances; `scale` multiplies their damage (to add damage
 *   over time and the like at the same rate)
 * @param heal what it heals a turn, or how that varies from turn to turn: [{ h, p }] (less than 0 when
 *   your damage over time between turns is more)
 */
const HEAL_CELLS = 48;
export function healedTurnsToKill(hp, attacks, heal, scale = 1) {
  const n = Math.max(2, Math.min(HEAL_CELLS, Math.ceil(hp)));
  const size = hp / n;
  // One turn's damage in cells (n or more: a kill from anywhere), every hit convolved.
  const turn = new Float64Array(n + 1);
  for (const a of attacks) {
    let dist = new Float64Array(n + 1);
    dist[0] = 1;
    for (const h of a.hits) {
      if (!h.spread) continue;
      const one = cellsOf(h.spread.map((x) => ({ d: x.d * scale, p: x.p })), size, n).map((x) => x * h.land);
      one[0] += 1 - h.land;
      for (let c = 0; c < h.count; c++) {
        const next = new Float64Array(n + 1);
        for (let i = 0; i <= n; i++) if (dist[i]) for (let j = 0; j <= n; j++) if (one[j]) next[Math.min(n, i + j)] += dist[i] * one[j];
        dist = next;
      }
    }
    for (let i = 0; i <= n; i++) turn[i] += a.chance * dist[i];
  }
  // What it heals a turn, in cells; a fraction of a cell is split between the cells either side.
  const heals = [];
  for (const { h, p } of Array.isArray(heal) ? heal : [{ h: heal, p: 1 }]) {
    const lo = Math.floor(h / size);
    const f = h / size - lo;
    heals.push([lo, p * (1 - f)], [lo + 1, p * f]);
  }
  // (I - P) E = 1 over the states 0 .. n - 1 (damage left unhealed, in cells).
  const A = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n + 1);
    row[i] = 1;
    row[n] = 1;
    for (const [down, w] of heals) {
      if (!(w > 0)) continue;
      const after = Math.max(0, i - down);
      for (let k = 0; after + k < n; k++) row[after + k] -= w * turn[k];
    }
    return row;
  });
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return Infinity;
    for (let r = 0; r < n; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const turns = A[0][n] / A[0][0];
  return turns > 0 && Number.isFinite(turns) ? turns : Infinity;
}

/**
 * Expected time from the start of a fight to the kill when your turns take different times (a
 * special attack's later hits come after a wait): hit by hit, each landing or not, the kill on the
 * first that takes the last of its HP; a turn that doesn't kill ends at its last hit and the next one
 * starts an interval later. Worked out on a grid of its HP from the bottom up: for each HP left, the
 * time from each hit of each attack to the kill, a + b X where X is the time from a new turn. With
 * armour that breaks, twice: once it's broken (`post`), then before (`pre`, each roll marked `b` if it
 * breaks it), where a hit that breaks it carries on from the same place in the first.
 * @param attacks [{ chance, hits: [{ count, interval, land, spread, pre?, post? }] }], spread null for
 *   a hit that does no damage (a boomerang coming back)
 */
function killTime(hp, attacks, interval) {
  const n = Math.max(1, Math.min(KILL_CELLS, Math.ceil(hp)));
  const size = hp / n;
  const cellsWith = (spread, land) => {
    const q = new Float64Array(n + 1);
    if (spread) {
      const cells = cellsOf(spread, size, n);
      for (let k = 0; k <= n; k++) q[k] = cells[k] * land;
    }
    return q;
  };
  const armoured = attacks.some((a) => a.hits.some((h) => h.pre));
  // One layer: for each hit, `q` (stays in this layer) and `to` (moves to `other`, already worked out).
  const layer = (hitOf, other) => {
    const seqs = attacks.map((a) => {
      const hits = [];
      a.hits.forEach((h, i) => {
        const { q, to } = hitOf(h);
        for (let c = 0; c < h.count; c++) hits.push({ wait: i > 0 || c > 0 ? h.interval : 0, q, to });
      });
      return { chance: a.chance, hits, at: hits.map(() => new Float64Array(n + 1)) };
    });
    const X = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      let alpha = 0;
      let beta = 0;
      const forms = seqs.map((sq, si) => {
        const out = [];
        let next = null; // the hit after this one, as a + b X
        for (let j = sq.hits.length - 1; j >= 0; j--) {
          const { q, to } = sq.hits[j];
          const last = j === sq.hits.length - 1;
          const wait = last ? interval : sq.hits[j + 1].wait;
          let a = 0;
          let b = 0;
          for (let k = 0; k < i; k++) {
            if (q[k]) {
              if (k === 0) {
                a += q[0] * (wait + (last ? 0 : next.a));
                b += q[0] * (last ? 1 : next.b);
              } else {
                a += q[k] * (wait + (last ? X[i - k] : sq.at[j + 1][i - k]));
              }
            }
            if (to?.[k]) a += to[k] * (wait + (last ? other.X[i - k] : other.seqs[si].at[j + 1][i - k]));
          }
          next = { a, b };
          out[j] = next;
        }
        alpha += sq.chance * out[0].a;
        beta += sq.chance * out[0].b;
        return out;
      });
      X[i] = beta < 1 - 1e-12 ? alpha / (1 - beta) : Infinity;
      seqs.forEach((sq, si) => forms[si].forEach((f, j) => (sq.at[j][i] = f.a + f.b * X[i])));
    }
    return { X, seqs };
  };
  const missOr = (q, h) => {
    q[0] += h.spread ? 1 - h.land : 1;
    return q;
  };
  const broken = layer((h) => ({ q: missOr(cellsWith(h.post ?? h.spread, h.land), h) }), null);
  if (!armoured) return interval + broken.X[n];
  const before = layer((h) => (h.pre
    ? { q: missOr(cellsWith(h.pre.filter((x) => !x.b), h.land), h), to: cellsWith(h.pre.filter((x) => x.b), h.land) }
    : { q: missOr(cellsWith(h.spread, h.land), h) }), broken);
  return interval + before.X[n];
}

// The same for a long fight: about normal, `mean` turns with variance mean x cv2 (a renewal count).
function normalTurnChances(mean, cv2) {
  const sd = Math.sqrt(Math.max(0.04, mean * cv2));
  const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const out = [0];
  for (let k = 1; k <= Math.ceil(mean + 6 * sd); k++) out.push(k < mean - 6 * sd ? 0 : phi((k + 0.5 - mean) / sd) - phi((k - 0.5 - mean) / sd));
  const total = out.reduce((s, x) => s + x, 0);
  return out.map((x) => x / total);
}
// waits(n, ms): the chance n turns' extra time (the hits after the first of a multi-hit attack, each
// turn's attack picked by chance) comes to at most ms. Exact for the first turns, about normal after.
function enemyWaits(extras) {
  const mean = extras.reduce((s, x) => s + x.chance * x.ms, 0);
  if (!extras.some((x) => x.ms > 0)) return (n, ms) => (ms >= 0 ? 1 : 0);
  const sd = Math.sqrt(Math.max(0, extras.reduce((s, x) => s + x.chance * x.ms * x.ms, 0) - mean * mean));
  // For each n: the possible totals in order, with the chance of each total or less.
  const exact = [{ ms: [0], upTo: [1] }];
  let last = new Map([[0, 1]]);
  const sums = (n) => {
    while (exact.length <= n) {
      const next = new Map();
      for (const [ms, p] of last) for (const x of extras) next.set(ms + x.ms, (next.get(ms + x.ms) ?? 0) + p * x.chance);
      last = next;
      const sorted = [...next].sort((a, b) => a[0] - b[0]);
      let c = 0;
      exact.push({ ms: sorted.map((x) => x[0]), upTo: sorted.map((x) => (c += x[1])) });
    }
    return exact[n];
  };
  return (n, ms) => {
    if (ms < 0) return 0;
    if (n > 12) return 0.5 * (1 + erf((ms - n * mean) / (sd * Math.sqrt(2 * n))));
    const s = sums(n);
    let lo = 0;
    let hi = s.ms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.ms[mid] <= ms) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? s.upTo[lo - 1] : 0;
  };
}

// Abramowitz and Stegun 7.1.26.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

const equipOf = (gd, id) => gd.items[id]?.equip ?? null;
// An imbuement by id (with or without its namespace) or as given.
const imbuementOf = (gd, x) => (typeof x === 'string' ? gd.combat.imbuements?.find((i) => i.id === x.split(':').pop()) ?? null : x ?? null);
export const styleOfStance = (gd, stance) => gd.combat.stances[stance]?.style ?? null;
export function weaponStyles(gd, weaponId) {
  const type = equipOf(gd, weaponId)?.weapon?.type;
  return [...new Set((gd.combat.weaponTypes[type]?.stances ?? []).map((s) => styleOfStance(gd, s)))];
}

// Used when the data has no Normal attack.
const NORMAL_ATTACK = { name: 'Normal Attack', hits: [{ count: 1, interval: 0, normal: 1, maxHit: 0, currentHp: 0 }], avoidable: true, applies: [] };

// Attacks picked at random each turn (NormalizeAttackChances): the normal attack takes what the
// special attacks leave, or their chances are scaled to add up to 1.
function attackChances(gd, list) {
  const listed = list.map((a) => ({ ...gd.combat.attacks[a.attack], id: a.attack, chance: a.chance })).filter((a) => a.hits?.length);
  const specialChance = listed.reduce((s, a) => s + a.chance, 0);
  return specialChance < 1 ? [{ ...(gd.combat.attacks.Normal ?? NORMAL_ATTACK), id: 'Normal', chance: 1 - specialChance }, ...listed] : listed.map((a) => ({ ...a, chance: a.chance / specialChance }));
}
// A multi-hit attack's later hits wait their interval, and its next turn starts after the last one.
const attackExtraMs = (a) => a.hits.reduce((s, h) => s + h.count * h.interval, 0) - a.hits[0].interval;
// A hit with no damage share (a boomerang coming back) only takes time.
const dealsDamage = (h) => h.normal > 0 || h.maxHit > 0 || h.currentHp > 0;

const EVASION = new Set(['PercentEvasionRating', 'FlatEvasionRating']);

/**
 * The player's combat numbers for a set of gear.
 * @param gear item ids being worn (the weapon decides the style; without one the game uses fists)
 * @param stance attack stance id (Stab, Accurate, Offensive, ...)
 * @param spell spell object for magic, or null
 * @param darkness the area's darkness; light from gear cancels it
 * @param area where you fight ({ id, name, category, effect }): its effect counts unless bought off
 */
export function buildPlayer(gd, { gear, stance, spell = null, imbuement = null, levels, darkness = 0, area = null, slayerTask = false, food = undefined }) {
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
  // Prayers, combat potions, pets, mastery and the selected food from the save (gd.playerCombatMods).
  // A food given here replaces the selected one: its bonuses count while it's selected (FoodComponent).
  for (const m of gd.playerCombatMods ?? []) if (food === undefined || !m.food) add(m);
  if (food !== undefined) for (const m of combatFoodMods(gd, food)) add(m);
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
  // The imbuement counts with a spell of a weapon that has its element (MagicSpellsComponent.SetAvailableElements).
  const imb = imbuementOf(gd, imbuement);
  const imbuementUsed = spellUsed && imb && weapon.elements.includes(imb.element) ? imb : null;
  // The same kinds of bonus from the save outside gear, potions, pets and mastery: shop upgrades and
  // Astrology nodes (gd.playerBonuses), by stats type so Ranching's food preservation stays out.
  const saved = (stats, stat) => total((gd.playerBonuses ?? []).filter((b) => b.stats === stats && b.stat === stat && !b.scope));
  // Chances to keep supplies: ammo for its type, runes for the spell's element (PlayerComponent, MagicSpellsComponent).
  const keep = (stats, name, match) => clamp(total(mods.filter((m) => m.stat === name && match(m))) + saved(stats, name), 0, 1);
  const accuracyRating = rating(levelSum(style.accuracyLevels, lv), stats[st.accuracyStat]);
  const accuracyWith = (extra = 0) => Math.max(Math.trunc(Math.floor(accuracyRating * (1 + mod('PercentAccuracyRating') + extra)) * dark), 1);
  const intervalWith = (extra = 0) => Math.max(Math.floor((stats[style.intervalStat] ?? 4000) * (1 + mod('PercentAttackInterval') + extra) + mod('FlatAttackInterval')), 250);

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
    accuracy: accuracyWith(),
    // With an effect's accuracy or attack interval bonus on top (Accurate, Blinded, Haste, Slowed).
    accuracyWith,
    intervalWith,
    // Added to your hit chance (TargetCharacterStats.FlatHitChance).
    hitChanceBonus: mod('FlatHitChance') + saved('Target', 'FlatHitChance'),
    baseMaxHit: maxHitFor(style, stats, lv),
    percentMaxHit: mod('PercentMaxHit'),
    flatMaxHit: mod('FlatMaxHit'),
    flatMinHit: mod('FlatMinHit'),
    minHitOfMax: mod('MinHitBasedOnMaxHit'),
    interval: intervalWith(),
    // Its attacks each turn: the special attacks your gear gives and the normal attack.
    attacks: attackChances(gd, ids.flatMap((id) => equipOf(gd, id).attacks ?? [])).map((a) => (imbuementUsed ? { ...a, applies: [...(a.applies ?? []), ...imbuementUsed.applies] } : a)),
    imbuement: imbuementUsed,
    // (rating + flat) x (1 + percent) (PowerRatingStats, ProtectionRatingStats).
    power: Math.max(Math.trunc((power + mod('FlatPowerRating')) * (1 + mod('PercentPowerRating'))), 1),
    protection: Math.max(Math.trunc((protection + mod('FlatProtectionRating')) * (1 + mod('PercentProtectionRating'))), 0),
    hitpoints: (lv[style.hitpointsLevel] ?? 10) * 10,
    // Your armour comes only from bonuses (no gear has base armour), so it never breaks.
    armour: Math.max(stats[style.armourStat] ?? 0, 0),
    lifesteal: Math.max(stats.Lifesteal ?? 0, 0),
    // Each landed hit takes 2 ward instead of 1 this often (CharacterComponent.PerformAttack).
    doubleWard: clamp(mod('DoubleWardDamageChance'), 0, 1),
    // Part of the damage its attacks do to you goes back to it (ReflectAttackDamage).
    reflect: Math.max(0, mod('PercentAttackReflect')),
    critChance: clamp(mod('FlatCriticalHitChance'), 0, 1),
    critMultiplier: Math.max(1.5 + mod('FlatCriticalHitMultiplier'), 1),
    damageDealt: mod('PercentDamageDealt'),
    healingPercent: mod('PercentHealing') + saved('CombatFood', 'PercentHealing'),
    spawn: { percent: mod('PercentSpawnInterval') + saved('CombatAction', 'PercentSpawnInterval'), flat: mod('FlatSpawnInterval') + saved('CombatAction', 'FlatSpawnInterval') },
    keep: {
      ammo: keep('AmmoConsumption', 'AmmoPreservationChance', (m) => !m.ammoType || m.ammoType === weapon.ammo),
      runes: keep('MagicSpell', 'RunePreservationChance', (m) => !m.element || m.element === spellUsed?.element),
      imbuementRunes: keep('MagicSpell', 'RunePreservationChance', (m) => !m.element || m.element === imbuementUsed?.element),
      prayer: keep('Prayer', 'CostPreservationChance', () => true),
      food: keep('CombatFood', 'FoodPreservationChance', () => true),
    },
    slayerCoins: { percent: mod('PercentRewardCurrency'), flat: mod('FlatRewardCurrency') },
    light,
    darknessPenalty,
    enemyMods,
    // Effect avoidance, effect damage taken and effect lifesteal (CombatEffectStats), for one effect or all of them.
    effectMods: mods.filter((m) => m.stat === 'EffectAvoidanceChance' || m.stat === 'EffectDamageTaken' || m.stat === 'EffectLifesteal'),
    // What it was built from, to build it again with another food (withFood).
    build: { gear, stance, spell, imbuement, levels, darkness, area, slayerTask },
    // Against an attacker's stance, with an effect's evasion bonus on top (Evasive, Staggered).
    evasion(attackerStance, extraPercent = 0, extraFlat = 0) {
      const as = gd.combat.stances[attackerStance];
      const vs = (name) => total(mods.filter((m) => m.stat === name && (!m.style || m.style === as.style)));
      const ev = rating(levelSum(gd.combat.styles[as.style].evasionLevels, lv), stats[as.evasionStat]);
      return Math.max(Math.trunc(Math.floor(ev * (1 + vs('PercentEvasionRating') + extraPercent) + vs('FlatEvasionRating') + extraFlat) * dark), 1);
    },
  };
}


// An enemy's numbers against each attack stance (its own stances are weighted at random each spawn).
export function buildEnemy(gd, enemy) {
  const weights = enemy.stances.reduce((s, x) => s + x.weight, 0) || 1;
  const attacks = attackChances(gd, enemy.attacks);
  return {
    enemy,
    hitpoints: (enemy.levels.Hitpoints ?? 1) * 10,
    interval: Math.max(enemy.stats.AttackInterval ?? 3000, 250),
    // It heals this share of the damage it does you (Wolves, Vampires: CharacterComponent.Lifesteal).
    lifesteal: Math.max(0, enemy.stats.Lifesteal ?? 0),
    armour: Math.max(enemy.stats.Armour ?? 0, 0),
    power: Math.max(enemy.power, 1),
    protection: Math.max(enemy.protection, 0),
    element: enemy.element,
    attacks,
    turnExtraMs: attacks.reduce((s, a) => s + a.chance * attackExtraMs(a), 0),
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

// P(one damage roll uniform on [min, max], then x * factor - armour (at least 1), reaches `hp`).
function chanceAtLeast(min, max, factor, armour, hp) {
  if (max < min) return 0;
  const need = Math.ceil((hp + armour) / factor - 1e-9);
  if (need <= min) return Math.max(1, Math.trunc(min * factor - armour)) >= hp ? 1 : 0;
  if (need > max) return 0;
  return (max - need + 1) / (max - min + 1);
}

// What a roll uniform on [min, max] does after x * factor - armour (at least 1, a roll of 0 nothing),
// as { d, p } values with p adding up to `w`, at most about `points` of them.
function rollSpread(min, max, factor, armour, w, points) {
  const out = new Map();
  const step = Math.max(1, Math.ceil((max - min + 1) / points));
  const n = Math.floor((max - min) / step) + 1;
  for (let x = min; x <= max; x += step) {
    const d = x > 0 ? Math.max(1, Math.trunc(x * factor - armour)) : 0;
    out.set(d, (out.get(d) ?? 0) + w / n);
  }
  return [...out].map(([d, p]) => ({ d, p }));
}

/**
 * Auto-eat (FoodComponent.AutoEat) as a Markov chain over your HP at each attack the enemy makes. Any
 * damage that leaves you alive at or under the threshold eats n = max(1, floor((limit - HP) / heal))
 * items at once (no further than full), then hits take you down again, and one at least your HP kills.
 * From where eating leaves you, the attacks you take at each HP on the way down follow the renewal
 * function of the damage per attack; where you end up below the threshold sets where the next eat
 * leaves you, so that goes round until it settles.
 * @param rolls per attack it makes: { w (chance it lands as this roll), min, max, currentHp, factor, armour }
 * @param drain other damage per attack (damage over time, reflect), less lifesteal; it can't kill you
 * @returns { deathPerAttack, attacksPerEat, itemsPerEat, healedPerItem, hpAt(hp) } or null
 */
export function autoEatChain({ maxHp, threshold, limit = maxHp, heal, rolls, drain = 0, midHp = (threshold + maxHp) / 2 }) {
  const span = maxHp - threshold;
  if (!(heal > 0) || span < 1) return null;
  // HP lost per attack: a landed roll (its HP share taken at the middle of the range) plus the drain,
  // split between the whole numbers either side.
  const b = Math.max(0, drain);
  const bLo = Math.floor(b);
  const bF = b - bLo;
  const at = (r, hp) => Math.trunc(hp * (r.currentHp ?? 0));
  const steps = new Map();
  const add = (d, p) => {
    if (p > 0) steps.set(d, (steps.get(d) ?? 0) + p);
  };
  let landed = 0;
  for (const r of rolls) {
    landed += r.w;
    for (const x of rollSpread(r.min + at(r, midHp), r.max + at(r, midHp), r.factor, r.armour, r.w, 64)) {
      add(x.d + bLo, x.p * (1 - bF));
      add(x.d + bLo + 1, x.p * bF);
    }
  }
  const miss = Math.max(0, 1 - landed);
  add(bLo, miss * (1 - bF));
  add(bLo + 1, miss * bF);
  const stay = steps.get(0) ?? 0;
  if (stay >= 1 - 1e-12) return null;
  const moves = [...steps].filter(([d]) => d > 0).sort((x, y) => x[0] - y[0]);
  const M = moves.length;
  const D = Int32Array.from(moves, (x) => x[0]);
  const Q = Float64Array.from(moves, (x) => x[1]);
  const big = D[M - 1];
  // u[k]: attacks taken, on average, at k HP below where you started.
  const u = new Float64Array(span);
  const ucum = new Float64Array(span);
  u[0] = 1 / (1 - stay);
  ucum[0] = u[0];
  for (let k = 1; k < span; k++) {
    let sum = 0;
    for (let i = 0; i < M && D[i] <= k; i++) sum += Q[i] * u[k - D[i]];
    u[k] = sum / (1 - stay);
    ucum[k] = ucum[k - 1] + u[k];
  }
  // Rolls that can kill: those reaching HP above the threshold.
  const kill = rolls.map((r) => ({ ...r, top: Math.max(1, Math.trunc((r.max + at(r, maxHp)) * r.factor - r.armour)) })).filter((r) => r.top > threshold);
  const dyingAt = (hp) => kill.reduce((sum, r) => sum + r.w * chanceAtLeast(r.min + at(r, hp), r.max + at(r, hp), r.factor, r.armour, hp), 0);
  const top = Math.min(maxHp, threshold + Math.max(big, ...kill.map((r) => r.top)));
  const W = top - threshold;
  // Where eating from `hp` leaves you.
  const itemsAt = (hp) => Math.max(1, Math.floor((limit - hp) / heal));
  const afterAt = (hp) => clamp(Math.min(maxHp, hp + itemsAt(hp) * heal), threshold + 1, maxHp);
  // Start points after eating (by HP), and the attacks you take near the bottom from them.
  let start = new Float64Array(maxHp + 1);
  start[afterAt(threshold)] = 1;
  const v = new Float64Array(W + 1);
  const below = new Float64Array(threshold + 1);
  let out = null;
  for (let round = 0; round < 30; round++) {
    v.fill(0);
    let attacks = 0;
    for (let h0 = threshold + 1; h0 <= maxHp; h0++) {
      const m = start[h0];
      if (!(m > 0)) continue;
      attacks += m * ucum[h0 - threshold - 1];
      for (let h = Math.min(h0, top); h > threshold; h--) v[h - threshold] += m * u[h0 - h];
    }
    // Where the attack that takes you to the threshold or under leaves you.
    below.fill(0);
    for (let j = 1; j <= W; j++) {
      const m = v[j];
      if (!(m > 0)) continue;
      for (let i = M - 1; i >= 0 && D[i] >= j; i--) below[Math.max(1, j - D[i] + threshold)] += m * Q[i];
    }
    let eats = 0;
    let items = 0;
    let healed = 0;
    const next = new Float64Array(maxHp + 1);
    for (let hp = 1; hp <= threshold; hp++) {
      const m = below[hp];
      if (!(m > 0)) continue;
      const n = itemsAt(hp);
      const after = afterAt(hp);
      eats += m;
      items += m * n;
      healed += m * (after - hp);
      next[after] += m;
    }
    let change = 0;
    for (let hp = threshold + 1; hp <= maxHp; hp++) {
      next[hp] /= eats;
      change += Math.abs(next[hp] - start[hp]);
      // Halfway to the new start points after a few rounds, so an exact cycle can't go round for ever.
      if (round >= 3) next[hp] = (next[hp] + start[hp]) / 2;
    }
    out = { attacksPerEat: attacks, itemsPerEat: items / eats, healedPerItem: healed / items, rounds: round + 1 };
    start = next;
    if (change < 1e-4) break;
  }
  // Deaths are rare, so they don't change the path down.
  let deaths = 0;
  for (let j = 1; j <= W; j++) if (v[j] > 0) deaths += v[j] * dyingAt(threshold + j);
  out.deathPerAttack = deaths / out.attacksPerEat;
  // Share of the attacks you take at an HP.
  out.hpAt = (hp) => {
    if (hp <= threshold || hp > maxHp) return 0;
    let sum = 0;
    for (let h0 = hp; h0 <= maxHp; h0++) sum += start[h0] * u[h0 - hp];
    return sum / out.attacksPerEat;
  };
  return out;
}

// Damage of one run of a damage-over-time effect (ActiveDamageOverTimeEffect): each proc deals every
// stack's damage at once; triggers while it runs add a stack (up to its max) but don't make it last
// longer. Triggers come `rate` per second, and `burst` more at the start (the rest of the burst of
// hits that started it).
function dotRunDamage(d, rate, tick, burst = 0) {
  const max = Math.max(1, d.maxStacks ?? 1);
  let sum = 0;
  for (let k = 1; k <= d.procs; k++) {
    const mean = burst + (rate * k * d.interval) / 1000;
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

// How often an effect lands, per second: from an attack (`x`, effectTriggers) a run starts on a turn
// with at least one application and every application adds a stack (a burst of hits lands together,
// so it starts fewer runs); `perSec` is then that side's turns per second, otherwise triggers per second.
const triggerRates = (perSec, x) => ({ stackRate: perSec * (x ? x.perTurn : 1), startRate: perSec * (x ? x.anyPerTurn : 1) });

// Stuns in `span` ms that start at random, `rate` per ms, each keeping the next off for `lockout`: the
// k-th lands by the end if k random waits fit in what the k - 1 lockouts before it leave. Over many,
// one each lockout and wait.
function stunsIn(span, rate, lockout) {
  if (!(span > 0) || !(rate > 0)) return 0;
  if (span * rate > 50 * (1 + rate * lockout)) return (span * rate + rate * lockout) / (1 + rate * lockout);
  let total = 0;
  for (let k = 1; k < 500; k++) {
    const x = (span - (k - 1) * lockout) * rate;
    if (!(x > 0)) break;
    let term = Math.exp(-x);
    let sum = term;
    for (let i = 1; i < k; i++) {
      term *= x / i;
      sum += term;
    }
    total += 1 - sum;
    if (1 - sum < 1e-9) break;
  }
  return total;
}

// Seconds from one run of a damage-over-time effect starting to the next, when starts come at random:
// the run, then the wait for the next start.
const dotCycleSec = (d, startRate) => (d.procs * d.interval) / 1000 + 1 / startRate;

/**
 * The same when starts come at one side's hits: a run put on at a hit lasts its procs, and the next
 * starts at the first hit after it ends that sets it off (Silt Burns runs 4s; with turns 2.2s apart, the
 * next chance is 0.4s after it ends, not a random wait; Shambling Whips' four hits come in a burst).
 * Turn by turn after the hit that started it, each an attack picked by chance with its hits at their
 * times, until every way is past the end of the run; from a turn's start after that, the wait is the
 * same each time.
 * @param turns [{ chance, hits: [{ at, c }], length }]: `at` ms after the turn's first hit, `c` the
 *   chance that hit starts a run, `length` from the first hit to the next turn's
 * @returns { sec, starts, burst }: seconds a cycle, the share of runs each of the turns starts, and
 *   how many more times the rest of the turn that starts one sets it off, on average
 */
function dotCycleAtHits(d, turns) {
  const runMs = d.procs * d.interval;
  // From a turn's first hit, with the run over: time to the next start.
  let ahead = 0;
  let none = 0;
  for (const t of turns) {
    let left = 1;
    for (const h of t.hits) {
      ahead += t.chance * left * h.c * h.at;
      left *= 1 - h.c;
    }
    ahead += t.chance * left * t.length;
    none += t.chance * left;
  }
  if (!(none < 1 - 1e-9)) return { sec: Infinity, starts: turns.map(() => 0), burst: 0 };
  const fresh = ahead / (1 - none);
  let starts = 0;
  let waits = 0;
  let bursts = 0;
  const by = turns.map(() => 0);
  turns.forEach((t0, i) => {
    let before = 1;
    t0.hits.forEach((h0, k) => {
      const w = t0.chance * before * h0.c; // the first start in a turn
      before *= 1 - h0.c;
      if (!(w > 0)) return;
      // The rest of its turn, then turn by turn; `alive`: no start yet since the run ended.
      let wait = 0;
      let alive = 1;
      for (const h of t0.hits.slice(k + 1)) {
        const at = h.at - h0.at;
        if (at < runMs - 1e-9) continue;
        wait += alive * h.c * (at - runMs);
        alive *= 1 - h.c;
      }
      let next = new Map([[t0.length - h0.at, alive]]);
      for (let guard = 0; next.size && guard < 200; guard++) {
        const now = next;
        next = new Map();
        for (const [at, mass] of now) {
          if (at >= runMs - 1e-9) {
            wait += mass * (at - runMs + fresh);
            continue;
          }
          for (const t of turns) {
            let m = mass * t.chance;
            for (const h of t.hits) {
              const when = at + h.at;
              if (when < runMs - 1e-9) continue;
              wait += m * h.c * (when - runMs);
              m *= 1 - h.c;
            }
            const key = Math.round(at + t.length);
            next.set(key, (next.get(key) ?? 0) + m);
          }
        }
      }
      starts += w;
      waits += w * wait;
      by[i] += w;
      bursts += w * t0.hits.slice(k + 1).reduce((t, h) => t + h.c, 0);
    });
  });
  return { sec: starts > 0 ? (runMs + waits / starts) / 1000 : Infinity, starts: by.map((x) => (starts > 0 ? x / starts : 0)), burst: starts > 0 ? bursts / starts : 0 };
}

// Damage per second of a damage-over-time effect: runs one after another, `cycleSec` apart.
function dotDps(d, tick, stackRate, cycleSec, burst = 0) {
  if (!(stackRate > 0) || !(cycleSec > 0) || !Number.isFinite(cycleSec)) return 0;
  return dotRunDamage(d, stackRate, tick, burst) / cycleSec;
}

// XP bonuses for one skill (Mastery Guild ranks and the like), as a share (ExperienceStats).
const xpBonus = (gd, skill) => total((gd.playerBonuses ?? []).filter((b) => b.skill === skill && b.stat === 'PercentXPGained' && !b.scope));

// Every mix of effects being up or not, each up its own share of the time (independently): the average
// of fn over them, given the effects that are up. Hit chance isn't linear in evasion (Vanished adds
// 69,420), so effects on accuracy and evasion are mixed this way; the rest are averaged.
const MAX_STATES = 8;
function overStates(states, fn) {
  const list = states.length > MAX_STATES ? [...states].sort((a, b) => b.uptime - a.uptime).slice(0, MAX_STATES) : states;
  let sum = 0;
  for (let mask = 0; mask < 1 << list.length; mask++) {
    let w = 1;
    const up = [];
    for (let i = 0; i < list.length; i++) {
      if (mask & (1 << i)) {
        w *= list[i].uptime;
        up.push(list[i]);
      } else {
        w *= 1 - list[i].uptime;
      }
    }
    if (w > 0) sum += w * fn(up);
  }
  return sum;
}
// The same mixes as a list: { w, up } for each, the weights adding up to 1.
function stateMix(states) {
  const list = states.length > MAX_STATES ? [...states].sort((a, b) => b.uptime - a.uptime).slice(0, MAX_STATES) : states;
  const out = [];
  for (let mask = 0; mask < 1 << list.length; mask++) {
    let w = 1;
    const up = [];
    for (let i = 0; i < list.length; i++) {
      if (mask & (1 << i)) {
        w *= list[i].uptime;
        up.push(list[i]);
      } else {
        w *= 1 - list[i].uptime;
      }
    }
    if (w > 0) out.push({ w, up });
  }
  return out;
}
const modSum = (states, stat) => states.reduce((s, x) => s + x.mods.reduce((t, m) => t + (m.stat === stat ? m.value : 0), 0), 0);
// Stats of the side an effect is on that matter when the other side hits it.
const DEFENCE_STATS = new Set(['PercentEvasionRating', 'FlatEvasionRating', 'FlatProtectionRating', 'PercentProtectionRating', 'PercentDamageTaken', 'PercentDamageTakenFromAttacks', 'FlatCombatStatValue', 'PercentResistance', 'PercentAttackReflect']);
// Share of the time an effect is up when it lasts `ms` and lands `rate` times per ms while it's down
// (one that's up isn't refreshed: ConfiguredTurnCountingEffect.ReapplyEffect).
const uptimeOf = (rate, ms) => (rate > 0 && ms > 0 ? (rate * ms) / (1 + rate * ms) : 0);
// The stats effects that last some turns change, as far as the model goes.
const STATE_STATS = new Set(['PercentAccuracyRating', 'PercentEvasionRating', 'FlatEvasionRating', 'PercentAttackInterval', 'FlatPowerRating', 'FlatProtectionRating', 'PercentMaxHit', 'PercentDamageTaken', 'PercentAttackReflect', 'PercentResistance', 'PercentDamageTakenFromAttacks', 'FlatCombatStatValue', 'PercentProtectionRating', 'MinHitBasedOnMaxHit']);

// How often a side's attacks apply each of their effects, per turn (CharacterComponent.PerformAttack):
// pre-hit effects roll before every hit, on-hit ones on every hit that lands, first-hit ones once. `perTurn` counts every
// application (damage over time stacks), `anyPerTurn` the chance of at least one (an effect that's up
// isn't refreshed).
function effectTriggers(attacks, landChance) {
  const out = [];
  for (const a of attacks) {
    for (const x of a.applies ?? []) {
      // Imbuements: rolled once a turn, on the first hit that lands (OnAttack OnFirstHit).
      if (x.when === 'firstHit') {
        const none = a.hits.reduce((t, h) => t * (1 - landChance(a)) ** h.count, 1);
        const any = a.chance * x.chance * (1 - none);
        if (any > 0) out.push({ ...x, attack: a, perTurn: any, anyPerTurn: any });
        continue;
      }
      let expected = 0;
      let none = 1;
      for (const h of a.hits) {
        const p = x.chance * (x.when === 'pre' ? 1 : landChance(a));
        expected += h.count * p;
        none *= (1 - p) ** h.count;
      }
      if (expected > 0) out.push({ ...x, attack: a, perTurn: a.chance * expected, anyPerTurn: a.chance * (1 - none) });
    }
  }
  return out;
}

/**
 * Expected results of fighting one enemy over and over.
 * Counts both sides' special attacks hit by hit and the effects they apply (damage over time, stuns
 * and sleep, and effects that change stats for some turns, weighted by how often they're up), the
 * enemy's passive (immunity, ward, healing, stacking ramps, damage over time, stuns), its armour
 * until a hit breaks it, auto-eat (FoodComponent: eats at 25% HP plus bonuses) and the chance of dying.
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
  // Effect avoidance and effect damage taken (CombatEffectStats), for one effect: yours from your
  // bonuses, the enemy's from gear that works on it.
  const fxOf = (list) => (stat, effect) => total((list ?? []).filter((m) => m.stat === stat && (!m.effect || m.effect === effect)));
  // Its passive can add some (Blood Circulation: avoids Bleed; Crimson Eyes: heals from its Bleed).
  const passiveFx = (who) => (passive?.effectMods ?? []).filter((m) => m.who === who);
  const playerFx = fxOf([...(p.effectMods ?? []), ...passiveFx('player')]);
  const enemyFx = fxOf([...(p.enemyMods ?? []).filter((m) => m.stat === 'EffectAvoidanceChance' || m.stat === 'EffectDamageTaken' || m.stat === 'EffectLifesteal'), ...passiveFx('enemy')]);
  // Avoidance from effects up some of the time (Poison Weak: 30% less against Poison), each pass's own.
  let avoidStates = [];
  const avoids = (fx, effect) => {
    const base = clamp(fx('EffectAvoidanceChance', effect), 0, 1);
    const who = fx === playerFx ? 'player' : 'enemy';
    return avoidStates.filter((st) => st.who === who).reduce((a, st) => a + st.uptime * st.mods.reduce((t, m) => t + (m.stat === 'EffectAvoidanceChance' && m.effect === effect ? clamp(base + m.value, 0, 1) - base : 0), 0), base);
  };
  const effectDef = (id) => gd.combat.effects?.[id] ?? null;
  const pAttacks = p.attacks?.length ? p.attacks : [{ ...NORMAL_ATTACK, chance: 1 }];

  // Auto-eat (FoodComponent): at or below 25% HP (plus bonuses) it eats enough to top you up, each
  // item healing its amount (plus healing bonuses) times (1 + auto-eat efficiency). Healing past full is wasted.
  const bonus = (stat) => total((gd.playerBonuses ?? []).filter((b) => b.stat === stat));
  const maxHp = p.hitpoints;
  const threshold = roundEven(clamp(0.25 + bonus('FlatAutoEatThreshold'), 0, 1) * maxHp);
  const limit = clamp(1 + bonus('FlatAutoEatLimit'), 0, 1) * maxHp;
  const midHp = (threshold + maxHp) / 2;
  const spawnMs = Math.max(Math.trunc((gd.mechanics.enemySpawnMs ?? 3000) * (1 + (p.spawn?.percent ?? 0)) + (p.spawn?.flat ?? 0)), 250);

  // Turns lost to a stun or sleep (StunnedAction): the rest of the turn it lands in and its own turns,
  // then the removal effect (Staggered, Drowsy) slows the next turns and may stop another landing.
  const stunCost = (id, turns, interval) => {
    const d = effectDef(id);
    const n = turns ?? d?.turns ?? 1;
    const after = d?.after ? effectDef(d.after.effect) : null;
    const afterTurns = after ? d.after.turns ?? after.turns : 0;
    const slow = after ? modSum([after], 'PercentAttackInterval') : 0;
    const blocks = !!after?.mods.some((m) => m.stat === 'EffectAvoidanceChance' && m.value >= 1 && (!m.effect || m.effect === id));
    const afterMs = afterTurns * (1 + slow) * interval;
    return {
      name: d?.name ?? id,
      lost: (n + 0.5) * interval + afterTurns * slow * interval,
      stunnedMs: n * interval,
      lockout: (n + 0.5) * interval + (blocks ? afterMs : 0),
      // While stunned it takes more damage; after it, the removal effect's other stats (its slowdown is in `lost`).
      mods: (d?.mods ?? []).filter((m) => STATE_STATS.has(m.stat)),
      after: after && { name: after.name, ms: afterMs, mods: after.mods.filter((m) => STATE_STATS.has(m.stat) && m.stat !== 'PercentAttackInterval') },
    };
  };

  // One pass of the fight. `adj`: effects up some of the time and stacks averaged over a fight
  // (`states`, from the pass before), the share of time you aren't stunned and its healing.
  const run = (adj) => {
    const states = adj.states ?? [];
    avoidStates = states;
    const of = (who) => states.filter((s) => s.who === who);
    const lin = (who, stat) => of(who).reduce((sum, s) => sum + s.uptime * modSum([s], stat), 0);
    const touching = (who, stats) => of(who).filter((s) => s.mods.some((m) => stats.includes(m.stat)));
    const side = (up, who) => up.filter((s) => s.who === who);
    const ACCURACY = ['PercentAccuracyRating'];
    const EVASION_STATS = ['PercentEvasionRating', 'FlatEvasionRating'];

    const active = prayers.map((id) => gd.combat.prayers?.find((x) => x.id === id)).filter(Boolean);
    const prayerCost = active.reduce((sum, x) => sum + x.cost, 0);
    const elemBonus = gd.combat.elements.find((x) => x.player === p.element && x.enemy === e.element)?.percentMaxHit ?? 0;
    // Your hit chance against its evasion, with whatever's up on either side.
    const hitStates = [...touching('player', ACCURACY), ...touching('enemy', EVASION_STATS)];
    const hitWith = (up) => {
      const its = side(up, 'enemy');
      const evasion = Math.max(1, Math.trunc(e.evasion(p.stance) * (1 + onEnemy('PercentEvasionRating') + modSum(its, 'PercentEvasionRating')) + modSum(its, 'FlatEvasionRating')));
      const extra = modSum(side(up, 'player'), 'PercentAccuracyRating');
      const accuracy = extra && p.accuracyWith ? p.accuracyWith(extra) : p.accuracy;
      return clamp(hitChance(accuracy, evasion) + (p.hitChanceBonus ?? 0), 0, 1);
    };
    const playerHit = immune ? 0 : overStates(hitStates, hitWith);
    // Effect damage taken from stacks that are up (Deep Wound: more from Bleed).
    const stateFx = (who, effect, noStacks = false) => of(who).filter((st) => !(noStacks && st.stacking)).reduce((sum, st) => sum + st.uptime * st.mods.reduce((t, m) => t + (m.stat === 'EffectDamageTaken' && (!m.effect || m.effect === effect) ? m.value : 0), 0), 0);
    // What's up on it some of the time that changes what your hits do (Fracture and Shatter: less
    // protection and armour; Drenched: more damage from attacks; Burning Shield: more armour), mixed
    // rather than averaged: resistance can't go below 0 and armour comes off every hit, so a hit while
    // it's up and one while it's down aren't the average of the two. With each mix: your damage
    // factor, its armour, and what that does to a roll.
    const DEFENCE = ['FlatProtectionRating', 'PercentProtectionRating', 'PercentResistance', 'PercentDamageTaken', 'PercentDamageTakenFromAttacks'];
    const armourOf = (states) => states.reduce((t, st) => t + st.mods.reduce((u, m) => u + (m.stat === 'FlatCombatStatValue' && m.combatStat === 'Armour' ? m.value : 0), 0), 0);
    const itsDefence = of('enemy').filter((st) => st.mods.some((m) => DEFENCE.includes(m.stat) || (m.stat === 'FlatCombatStatValue' && m.combatStat === 'Armour')));
    // Some change your hit chance too (Shambling Protection: half the evasion and 50 more armour), so
    // more of your hits land while they're up: each mix counts by the hits that land in it.
    const mixed = [...touching('player', ['FlatPowerRating']), ...itsDefence];
    const others = hitStates.filter((st) => !mixed.includes(st));
    const byHits = mixed.some((st) => hitStates.includes(st)) && !immune;
    const mixes = stateMix(mixed).map(({ w, up }) => ({ up, w: byHits ? w * overStates(others, (rest) => hitWith([...up, ...rest])) : w }));
    const hitWeight = mixes.reduce((t, x) => t + x.w, 0) || 1;
    const defences = mixes.map(({ w: raw, up }) => {
      const w = raw / hitWeight;
      const its = side(up, 'enemy');
      const res = resistance(p.power + modSum(side(up, 'player'), 'FlatPowerRating'), enemyProtection * (1 + modSum(its, 'PercentProtectionRating')) + modSum(its, 'FlatProtectionRating'), 0, 0, modSum(its, 'PercentResistance'));
      const takes = Math.max(0, 1 + modSum(its, 'PercentDamageTaken'));
      // Drenched, Flooded: more damage from attacks only.
      return { w, res, takes, factor: (1 - res) * (1 + p.damageDealt) * Math.max(0, takes + modSum(its, 'PercentDamageTakenFromAttacks')), armour: Math.max(0, armour + armourOf(its)) };
    });
    const averageOf = (key) => defences.reduce((t, d) => t + d.w * d[key], 0);
    const enemyRes = averageOf('res');
    const enemyTakes = averageOf('takes');
    const factor = averageOf('factor');
    const armourNow = averageOf('armour');
    // A landed hit over the mixes: with armour on (`b`: whether it breaks it, a hit at least the armour
    // at the time; only its own armour can break) or broken.
    const mixedSpread = (lo, hi, critMultiplier, armourOn) => defences.flatMap((d) => hitSpread(lo, hi, p.critChance, critMultiplier, d.factor, armourOn ? d.armour : 0)
      .map((x) => ({ d: x.d, p: x.p * d.w, ...(armourOn ? { b: e.armour > 0 && x.d >= d.armour } : {}) })));
    const anyArmour = defences.some((d) => d.armour > 0);
    const eInterval = Math.max(250, Math.floor(e.interval * (1 + onEnemy('PercentAttackInterval') + lin('enemy', 'PercentAttackInterval'))));
    // Its turn lasts until the last hit of a multi-hit attack (AttackAction's hit timer).
    const eTurnMs = eInterval + (e.turnExtraMs ?? 0);

    // Your turn: an attack picked by chance, each of its hits rolling to land on its own, and the turn
    // lasts until its last hit. A boomerang's return does no damage but takes time.
    const extraInterval = lin('player', 'PercentAttackInterval');
    const pInterval = extraInterval && p.intervalWith ? p.intervalWith(extraInterval) : p.interval;
    const pTurnMs = pInterval + pAttacks.reduce((s, a) => s + a.chance * attackExtraMs(a), 0);
    // One side's turns for dotCycleAtHits: each attack with its hits' times and `c(a, k)`, the chance
    // hit k of it starts a run.
    const turnsOf = (attacks, interval, c) => attacks.map((a) => {
      const hits = [];
      let at = 0;
      a.hits.forEach((h, i) => {
        for (let n = 0; n < h.count; n++) {
          if (i > 0 || n > 0) at += h.interval;
          hits.push({ at, c: c(a, hits.length) });
        }
      });
      return { chance: a.chance, hits, length: at + interval };
    });
    // The chance an effect of an attack goes on at its hit k, landing `land` of the time.
    const atHit = (x, land, k) => (x.when === 'pre' ? x.chance : x.when === 'firstHit' ? x.chance * land * (1 - land) ** k : x.chance * land);
    const lands = (a) => (immune ? 0 : a.avoidable ? playerHit : 1);
    let pAttempts = 0;
    let pLanded = 0;
    let pDamaging = 0; // landed hits that can do damage, per turn
    for (const a of pAttacks) {
      for (const h of a.hits) {
        pAttempts += a.chance * h.count;
        pLanded += a.chance * h.count * lands(a);
        if (dealsDamage(h)) pDamaging += a.chance * h.count * lands(a);
      }
    }
    // Where in its turn the killing hit lands: the time after it (a boomerang coming back) isn't
    // spent, as the next enemy comes after the respawn wait. Likelier on the bigger hits.
    let shiftW = 0;
    let shiftMs = 0;
    for (const a of pAttacks) {
      const damaging = [];
      let t = 0;
      a.hits.forEach((h, i) => {
        for (let c = 0; c < h.count; c++) {
          if (i > 0 || c > 0) t += h.interval;
          if (dealsDamage(h)) damaging.push({ t, w: h.normal / 2 + h.maxHit });
        }
      });
      const turn = pInterval + attackExtraMs(a);
      damaging.forEach((x, k) => {
        const w = a.chance * lands(a) * x.w;
        shiftW += w;
        shiftMs += w * (pInterval + x.t - ((k + 1) / damaging.length) * turn);
      });
    }
    const killShiftMs = shiftW > 0 ? shiftMs / shiftW : 0;

    const playerTakes = lin('player', 'PercentDamageTaken');
    // Your protection with what's on you (Acid Burns takes 1.5% of it a stack).
    const yourProtection = Math.max(0, p.protection * (1 + lin('player', 'PercentProtectionRating')) + lin('player', 'FlatProtectionRating'));
    // Attack reflect (ReflectAttackDamage): the HP a landed attack took, times the reflect, through the
    // attacker's resistance and armour, at least 1 but never its last HP point (so it can't kill).
    const itsReflect = (passive?.reflect ?? 0) + lin('enemy', 'PercentAttackReflect');
    const yourReflect = (p.reflect ?? 0) + lin('player', 'PercentAttackReflect');
    let reflectPerHit = 0; // on you, per landed damaging hit of yours
    let reflectPerItsHit = 0; // on it, per landed hit of its (weighted by landed)
    let landedPerKill = 0; // landed damaging hits
    let armoured = 0;
    let playerMax = 0;
    let prayerXpPerTurn = 0;
    const hitAvg = new Map(); // attack -> HP one of its landed damaging hits takes off (for Bleed)
    let enemyAttempts = 0; // its hits tried per turn (each hit of a special attack rolls on its own)
    let enemyLanded = 0;
    let enemyDamage = 0; // damage per turn
    let enemyMaxHit = 0;
    let biggestHit = 0;
    const byAttack = new Map(e.attacks.map((a) => [a, { tries: 0, landed: 0, damage: 0 }]));
    const damageRolls = []; // per enemy turn, for the chance of dying: { weight, min, max, currentHp, factor, armour }
    const shapes = []; // per enemy stance: your attacks' hits, for when the kill comes
    const timings = []; // per enemy stance: every hit of each of your attacks, for killTime
    for (const es of e.stances) {
      const tri = triangleFor(gd, p.style, es.style);
      // Max hit with what's up on you some of the time, mixed rather than averaged: Starblight takes
      // 999% off, so your hits do 1 while it's up, not 37% less all the time.
      const maxHitOf = (pct) => Math.max(Math.floor((p.baseMaxHit * (1 + p.percentMaxHit + elemBonus + pct) + p.flatMaxHit) * (1 + tri.maxHit)), 1);
      const maxHits = stateMix(touching('player', ['PercentMaxHit'])).map(({ w, up }) => {
        const max = maxHitOf(modSum(side(up, 'player'), 'PercentMaxHit'));
        return { w, max, min: clamp(Math.floor(1 + p.flatMinHit + max * (p.minHitOfMax + lin('player', 'MinHitBasedOnMaxHit'))), 1, max) };
      });
      const usual = maxHits.reduce((a, b) => (b.w > a.w ? b : a));
      const maxHit = usual.max;
      const critMultiplier = p.critMultiplier ?? 1.5;
      // Each kind of hit that can do damage, weighted by how often it lands each turn.
      const kinds = [];
      for (const a of pAttacks) {
        for (const h of a.hits) {
          const w = pDamaging > 0 && dealsDamage(h) ? (a.chance * h.count * lands(a)) / pDamaging : 0;
          if (!(w > 0)) continue;
          const range = (m) => {
            const fixed = Math.trunc(m.max * h.maxHit);
            return { lo: Math.trunc(m.min * h.normal) + fixed, hi: Math.trunc(m.max * h.normal) + fixed };
          };
          const { lo, hi } = range(usual);
          const spread = (armourOn) => maxHits.flatMap((m) => {
            const r = range(m);
            return mixedSpread(r.lo, r.hi, critMultiplier, armourOn).map((x) => ({ ...x, p: x.p * m.w }));
          });
          const post = spread(false);
          kinds.push({ a, h, w, lo, hi, post, pre: anyArmour ? spread(true) : post });
        }
      }
      const mix = (key) => kinds.flatMap((k) => k[key].map((x) => ({ ...x, p: x.p * k.w })));
      const kill = kinds.length ? hitsToKill(e.hitpoints, mix('pre'), mix('post'), breakAt) : { hits: Infinity, armoured: 1 };
      landedPerKill += es.weight * kill.hits;
      armoured += es.weight * kill.armoured;
      const mean = (spread) => spread.reduce((s, x) => s + x.d * x.p, 0);
      for (const k of kinds) {
        const avg = hitAvg.get(k.a) ?? { sum: 0, w: 0 };
        avg.sum += es.weight * k.w * (kill.armoured * mean(k.pre) + (1 - kill.armoured) * mean(k.post));
        avg.w += es.weight * k.w;
        hitAvg.set(k.a, avg);
        if (prayerCost > 0) prayerXpPerTurn += es.weight * k.w * pDamaging * (kill.armoured * averagePrayerXp(k.lo, k.hi, factor, armourNow, prayerCost) + (1 - kill.armoured) * averagePrayerXp(k.lo, k.hi, factor, 0, prayerCost));
      }
      playerMax = Math.max(playerMax, maxHit);
      // Each attack's hits, for when the kill comes (killTurnChances): armour on for its share of them.
      const byKind = new Map();
      for (const k of kinds) {
        const spread = kill.armoured >= 1 ? k.pre : [...k.pre.map((x) => ({ d: x.d, p: x.p * kill.armoured })), ...k.post.map((x) => ({ d: x.d, p: x.p * (1 - kill.armoured) }))];
        const list = byKind.get(k.a) ?? [];
        list.push({ count: k.h.count, land: lands(k.a), spread });
        byKind.set(k.a, list);
      }
      shapes.push({ weight: es.weight, attacks: [...byKind].map(([a, hits]) => ({ chance: a.chance, hits })) });
      // Every hit in order with its wait, for killTime.
      const spreadOf = new Map();
      for (const k of kinds) spreadOf.set(k.h, kill.armoured >= 1 ? k.pre : [...k.pre.map((x) => ({ d: x.d, p: x.p * kill.armoured })), ...k.post.map((x) => ({ d: x.d, p: x.p * (1 - kill.armoured) }))]);
      // Armour of its own breaks on a big enough hit: killTime follows it hit by hit.
      const preOf = new Map(e.armour > 0 && anyArmour ? kinds.map((k) => [k.h, k.pre]) : []);
      timings.push({ weight: es.weight, attacks: pAttacks.map((a) => ({ chance: a.chance, hits: a.hits.map((h) => ({ count: h.count, interval: h.interval, land: lands(a), spread: spreadOf.get(h) ?? null, ...(preOf.has(h) ? { pre: preOf.get(h), post: kinds.find((k) => k.h === h).post } : {}) })) })) });

      // Its hit chance against your evasion, with whatever's up on either side.
      const hit = overStates([...touching('enemy', ACCURACY), ...touching('player', EVASION_STATS)], (up) => {
        const mine = side(up, 'player');
        const accuracy = Math.trunc(es.accuracy * (1 + onEnemy('PercentAccuracyRating') + modSum(side(up, 'enemy'), 'PercentAccuracyRating')));
        return hitChance(accuracy, p.evasion(es.stance, modSum(mine, 'PercentEvasionRating'), modSum(mine, 'FlatEvasionRating')));
      });
      const playerRes = resistance(enemyPower + lin('enemy', 'FlatPowerRating'), yourProtection, tri.resistance, 0, lin('player', 'PercentResistance'));
      const eFactor = (1 - playerRes) * Math.max(0, 1 + playerTakes + lin('player', 'PercentDamageTakenFromAttacks'));
      const esMax = Math.max(1, Math.floor(es.maxHit * (1 + lin('enemy', 'PercentMaxHit'))));
      // Its min hit goes up with stacks of Dwarven Pride.
      const eMin = clamp(Math.floor(1 + esMax * ((passive?.minHitOfMax ?? 0) + lin('enemy', 'MinHitBasedOnMaxHit'))), 1, esMax);
      enemyMaxHit += es.weight * esMax;
      if (itsReflect > 0) {
        // The killing hit only takes the HP that's left, so hits are scaled to its HP over the hits it takes.
        for (const k of kinds) {
          const spread = [...k.pre.map((x) => ({ d: x.d, p: x.p * kill.armoured })), ...k.post.map((x) => ({ d: x.d, p: x.p * (1 - kill.armoured) }))];
          const avg = spread.reduce((t, x) => t + x.d * x.p, 0);
          const c = avg > 0 ? Math.min(1, e.hitpoints / kill.hits / avg) : 1;
          const back = spread.reduce((t, x) => t + (x.d > 0 ? x.p * Math.max(1, Math.trunc(Math.trunc(x.d * c * itsReflect) * eFactor - p.armour)) : 0), 0);
          reflectPerHit += es.weight * k.w * back;
        }
      }
      // Each hit of each attack: a share of a normal roll, a fixed share of max hit (MaxHit formula, no
      // roll) and a share of your HP left. Unavoidable attacks always land.
      for (const a of e.attacks) {
        const tally = byAttack.get(a);
        for (const h of a.hits) {
          const landShare = a.avoidable ? hit : 1;
          const fixed = Math.trunc(esMax * h.maxHit);
          const lo = Math.trunc(eMin * h.normal) + fixed;
          const hi = Math.trunc(esMax * h.normal) + fixed;
          const share = es.weight * a.chance * h.count;
          const landed = share * landShare;
          const mid = Math.trunc(midHp * h.currentHp);
          const damage = landed * averageDamage(lo + mid, hi + mid, eFactor, p.armour);
          enemyAttempts += share;
          enemyLanded += landed;
          enemyDamage += damage;
          tally.tries += share;
          tally.landed += landed;
          tally.damage += damage;
          damageRolls.push({ weight: landed, min: lo, max: hi, currentHp: h.currentHp, factor: eFactor, armour: p.armour });
          if (yourReflect > 0 && landed > 0) {
            const back = (x) => (x > 0 ? Math.max(1, Math.trunc(Math.trunc(Math.max(1, Math.trunc(x * eFactor - p.armour)) * yourReflect) * (1 + p.damageDealt) * enemyTakes * (1 - enemyRes) - armourNow * kill.armoured)) : 0);
            reflectPerItsHit += landed * overRoll(lo + mid, hi + mid, back);
          }
          const top = hi + Math.trunc(maxHp * h.currentHp);
          if (top > 0) biggestHit = Math.max(biggestHit, Math.max(1, Math.trunc(top * eFactor - p.armour)));
        }
      }
    }
    const enemyHitChance = enemyAttempts > 0 ? enemyLanded / enemyAttempts : 0;
    const enemyAvgHit = enemyLanded > 0 ? enemyDamage / enemyLanded : 0;

    // Ward (CharacterComponent.ModifyAttackDamage, PerformAttack): while it has any, a landed hit does
    // x (1 - ward left / its max) before armour, then takes 1 ward (2 with double ward damage), so the
    // first does next to nothing and about half of the W / (1 + chance) hits that take it is lost.
    // Until it's gone nothing of yours that hurts it lands and effect damage does nothing
    // (CombatEffectsComponent.ApplyEffect, ActiveCombatEffect.Damage).
    const wardHits = ward > 0 ? ward / (1 + (p.doubleWard ?? 0)) : 0;
    const wardMs = wardHits > 0 && pDamaging > 0 ? (wardHits / pDamaging) * pTurnMs : 0;
    // Wall of Blood raises its max ward but not what it has, so while it's up a hit loses only ward
    // left / the bigger max. It's up from its first use on, which can come partway through the ward.
    const wardKept = of('enemy').reduce((f, st) => {
      const extra = st.mods.reduce((t, m) => t + (m.stat === 'FlatCombatStatValue' && m.combatStat === 'MaximumWard' ? m.value : 0), 0);
      if (!(extra > 0) || !(ward > 0)) return f;
      const warm = st.perMs > 0 ? wardMs / (wardMs + 1 / st.perMs) : 1;
      return f - st.uptime * warm * (1 - ward / (ward + extra));
    }, 1);
    const wardLost = wardHits > 0 ? ((wardHits + 1) / 2) * wardKept : 0;
    const wardShare = wardHits > 0 ? Math.min(1, wardHits / (landedPerKill + wardLost)) : 0;

    // Effects each side's attacks apply to the other or itself; none land on an enemy you can't hurt
    // (CombatEffectsComponent.ApplyEffect).
    const pTriggers = effectTriggers(pAttacks, lands).filter((x) => x.to === 'self' || !immune);
    const eTriggers = effectTriggers(e.attacks, (a) => (byAttack.get(a).tries > 0 ? byAttack.get(a).landed / byAttack.get(a).tries : 0));
    const notes = [];
    const nextStates = [];
    const unmodelled = new Set();
    // A stun on `who` at `rate` per ms: the share of its time lost, and its effects for the next pass.
    // In a fight of `ms`: none comes before the first hit that can set one off (`first` ms in), what
    // keeps another from landing (Staggered) goes as the fight ends, and your kill ends the fight
    // partway through some of its stuns (yours it waits out). Each stun takes `len` of the fight.
    const stunShare = (who, rate, lockout, first, len, ms) => {
      if (!(ms > 0) || !Number.isFinite(ms)) return (rate * len) / (1 + rate * lockout);
      const span = Math.max(0, ms - first);
      const cut = who === 'enemy' ? clamp(1 - len / (2 * Math.max(span, 1)), 0, 1) : 1;
      return (stunsIn(span, rate, lockout) * len * cut) / ms;
    };
    const stunOn = (who, id, turns, rate, interval, first) => {
      if (!(rate > 0)) return 0;
      const c = stunCost(id, turns, interval);
      // For the turns lost, the pass before's fight; for what's up meanwhile, this one's (`uptimeAt`).
      const at = (len) => (ms) => stunShare(who, rate, c.lockout, first, len, ms);
      if (c.mods.length) nextStates.push({ who, name: c.name, mods: c.mods, uptime: 0, uptimeAt: at(c.stunnedMs) });
      if (c.after?.mods.length) nextStates.push({ who, name: c.after.name, mods: c.after.mods, uptime: 0, uptimeAt: at(c.after.ms) });
      const lost = stunShare(who, rate, c.lockout, first, c.lost, adj.killMs);
      notes.push({ who, kind: 'stun', name: c.name, share: lost });
      return lost;
    };
    const pTurnsPerMs = 1 / pTurnMs; // while you are not stunned
    // Turns it loses: stuns it puts on itself (Storm Wrapped, when it hits you) and stuns from your attacks.
    // A stun from any source ends the turn and Staggered blocks the next, so a burst of hits stuns at
    // most once a turn, and stuns of the same kind from different sources are one process (their
    // chances add up, then the time locked out is counted once).
    const itsLand = (a) => (byAttack.get(a)?.tries > 0 ? byAttack.get(a).landed / byAttack.get(a).tries : 0);
    const oncePerTurn = (attacks, land, chance) => attacks.reduce((t, a) => t + a.chance * (1 - a.hits.reduce((u, h) => u * (1 - chance * land(a)) ** h.count, 1)), 0);
    const stunsOn = (who, list, interval) => {
      const groups = new Map();
      for (const x of list) {
        if (!(x.rate > 0)) continue;
        const g = groups.get(x.id) ?? { rate: 0, turns: 0, first: Infinity };
        g.rate += x.rate;
        g.turns = Math.max(g.turns, x.turns ?? effectDef(x.id)?.turns ?? 1);
        g.first = Math.min(g.first, x.first);
        groups.set(x.id, g);
      }
      let lost = 0;
      for (const [id, g] of groups) lost += stunOn(who, id, g.turns, g.rate, interval, g.first);
      return lost;
    };
    const enemyStun = stunsOn('enemy', [
      ...(passive?.selfStuns ?? []).map((st) => ({ id: st.effect ?? 'Stun', turns: st.turns, first: eInterval, rate: oncePerTurn(e.attacks, itsLand, st.chance) / eTurnMs })),
      ...eTriggers.filter((x) => x.kind === 'stun' && x.to === 'self').map((x) => ({ id: x.effect, turns: x.turns, first: eInterval, rate: x.anyPerTurn / eTurnMs })),
      ...pTriggers.filter((x) => x.kind === 'stun' && x.to === 'target').map((x) => ({ id: x.effect, turns: x.turns, first: pInterval, rate: pTurnsPerMs * (adj.playerActive ?? 1) * x.anyPerTurn * (1 - avoids(enemyFx, x.effect)) * (1 - wardShare) })),
    ], eInterval);
    const enemyTurnsPerSec = (1000 / eTurnMs) * (1 - Math.min(0.9, enemyStun));
    let enemyDps = enemyDamage * enemyTurnsPerSec;
    const enemyHitsPerSec = enemyLanded * enemyTurnsPerSec;
    const enemyAttemptsPerSec = enemyAttempts * enemyTurnsPerSec;

    const turnsToKill = pDamaging > 0 ? (landedPerKill + wardLost) / pDamaging : Infinity;
    let killMs = Number.isFinite(turnsToKill) ? Math.max(pInterval, turnsToKill * pTurnMs + killShiftMs) : Infinity;
    // Your turns take different times (a special attack's later hits wait), so in a short fight which
    // attack makes the kill and on which hit matters: hit by hit (killTime). Ward's lost hits on top.
    const variable = pAttacks.some((a) => a.hits.length > 1 || a.hits.some((h) => h.count > 1));
    if (variable && Number.isFinite(killMs) && turnsToKill <= 30 && timings.length) {
      const exact = timings.reduce((t, x) => t + x.weight * killTime(e.hitpoints, x.attacks, pInterval), 0);
      if (Number.isFinite(exact)) killMs = Math.max(pInterval, exact + (pDamaging > 0 ? (wardLost / pDamaging) * pTurnMs : 0));
    }
    const playerTurnsPerSec = 1000 * pTurnsPerMs;
    const rateOf = (on) => (on === 'playerHit' ? pLanded * playerTurnsPerSec : on === 'playerMiss' ? (pAttempts - pLanded) * playerTurnsPerSec : on === 'enemyAttack' ? enemyAttemptsPerSec : enemyHitsPerSec);
    // Stuns on you: from its passive (one at the start of the fight, Petrify, only delays it) and its
    // attacks, less your avoidance; you're slowed and can't be stunned again while Staggered.
    let startStunMs = 0;
    const stunsOnYou = [];
    // Its passive's stuns, at most once a turn of whoever sets them off.
    const turnRate = (on, chance) => (on === 'playerHit' || on === 'playerMiss'
      ? (oncePerTurn(pAttacks, on === 'playerHit' ? lands : (a) => 1 - lands(a), chance) * playerTurnsPerSec) / 1000
      : (oncePerTurn(e.attacks, on === 'enemyHit' ? itsLand : () => 1, chance) * enemyTurnsPerSec) / 1000);
    for (const st of passive?.stuns ?? []) {
      const avoid = avoids(playerFx, st.effect ?? 'Stun');
      if (st.on === 'start') {
        startStunMs += st.chance * (1 - avoid) * st.turns * pInterval;
        continue;
      }
      stunsOnYou.push({ id: st.effect ?? 'Stun', turns: st.turns, first: st.on === 'playerHit' || st.on === 'playerMiss' ? pInterval : eInterval, rate: turnRate(st.on, st.chance) * (1 - avoid) });
    }
    for (const x of eTriggers) if (x.kind === 'stun' && x.to === 'target') stunsOnYou.push({ id: x.effect, turns: x.turns, first: eInterval, rate: ((enemyTurnsPerSec * x.anyPerTurn) / 1000) * (1 - avoids(playerFx, x.effect)) });
    for (const x of pTriggers) if (x.kind === 'stun' && x.to === 'self') stunsOnYou.push({ id: x.effect, turns: x.turns, first: pInterval, rate: pTurnsPerMs * x.anyPerTurn });
    const playerStun = stunsOn('player', stunsOnYou, pInterval);
    const playerActive = 1 - Math.min(0.9, playerStun);
    if (Number.isFinite(killMs)) killMs /= playerActive;

    // Damage over time your attacks put on it: faster kills, but only attack damage gives XP
    // (CombatExperienceComponent). Each proc goes through its resistance and armour (ModifyEffectDamage).
    // It can't start before your first hit and procs a while after, and it ends with the enemy
    // (cleared when it dies), so in a short fight it does little.
    let dotOnEnemyDps = 0;
    const dotsOnEnemy = [];
    for (const x of pTriggers) {
      const d = x.kind === 'dot' && x.to === 'target' ? effectDef(x.effect) : null;
      if (!d) continue;
      const notAvoided = 1 - avoids(enemyFx, x.effect);
      const avg = hitAvg.get(x.attack);
      const base = d.formula === 'DamageDealt' ? Math.max(1, (avg?.w > 0 ? avg.sum / avg.w : 0) * d.percent) : d.formula === 'MaxHit' ? Math.max(1, Math.trunc(playerMax * d.percent)) : 0;
      if (!(notAvoided > 0) || !(base > 0)) continue;
      const takes = Math.max(0, enemyTakes + enemyFx('EffectDamageTaken', x.effect) + stateFx('enemy', x.effect));
      const tick = (stacks) => Math.max(1, Math.trunc(stacks * base * (1 + p.damageDealt) * takes * (1 - enemyRes) - armourNow * armoured));
      const { stackRate } = triggerRates(playerTurnsPerSec * playerActive * notAvoided, x);
      // Runs start at your hits; while you're stunned they don't.
      const cycle = dotCycleAtHits(d, turnsOf(pAttacks, pInterval, (a, k) => (a === x.attack ? atHit(x, lands(a), k) * notAvoided : 0)));
      const cycleSec = cycle.sec / playerActive;
      const dps = dotDps(d, tick, stackRate, cycleSec, cycle.burst);
      // While it runs it can change its stats too (Suffocate: less accuracy).
      const dotMods = (d.mods ?? []).filter((m) => STATE_STATS.has(m.stat));
      if (dotMods.length && Number.isFinite(cycleSec)) nextStates.push({ who: 'enemy', name: d.name, mods: dotMods, uptime: (d.procs * d.interval) / 1000 / cycleSec });
      dotOnEnemyDps += dps;
      // Effect lifesteal: you heal a share of what it deals (ActiveCombatEffect.Damage).
      // None is running as a fight starts (it's cleared when it dies), so it's behind the average: by
      // about half a run when starts are rare (Griffin Claws' Bleed), less when they come back to back.
      // The first proc comes an interval after the start.
      const runMs = d.procs * d.interval;
      const waitMs = Math.max(0, cycleSec * 1000 - runMs);
      dotsOnEnemy.push({ dps, delayMs: pInterval + d.interval + wardMs + (runMs / 2) * (waitMs / (waitMs + runMs)), lifesteal: Math.max(0, playerFx('EffectLifesteal', x.effect)), procsPerSec: d.procs / cycleSec, fixed: d.formula !== 'DamageDealt' });
      notes.push({ who: 'enemy', kind: 'dot', name: d.name, dps });
    }
    // Your reflect: from its first hit on, damage that gives no XP either.
    const reflectOnEnemyDps = enemyTurnsPerSec * reflectPerItsHit;
    if (reflectOnEnemyDps > 0) {
      dotsOnEnemy.push({ dps: reflectOnEnemyDps, delayMs: eInterval });
      notes.push({ who: 'enemy', kind: 'reflect', name: 'Reflect', dps: reflectOnEnemyDps });
    }
    // How long it's done damage by `ms` into the fight.
    const dotTime = (ms, x) => Math.max(0, ms - x.delayMs);
    let dotFactor = 1;
    let dotDamage = 0;
    let effectHealPerKill = 0;
    if (dotsOnEnemy.length && Number.isFinite(killMs)) {
      // Hits take its HP off at HP / killMs; the damage over time adds dps once its delay is past.
      const before = killMs;
      const dealt = (ms) => dotsOnEnemy.reduce((s, x) => s + (x.dps * dotTime(ms, x)) / 1000, 0);
      let lo = 0;
      let hi = before;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if ((mid / before) * e.hitpoints + dealt(mid) < e.hitpoints) lo = mid;
        else hi = mid;
      }
      killMs = hi;
      dotFactor = killMs / before;
      dotDamage = dealt(killMs);
    }
    const dotShare = Math.min(0.9, dotDamage / e.hitpoints);

    let healFactor = 1;
    // Healing at the end of each of its turns (Slime): a share of the HP it has left, but never past
    // full (CharacterHealth.Heal), so early on it only undoes what you've done. Turn by turn: slower
    // kills, or none if it out-heals you.
    let slimeHealed = 0;
    if (passive?.healPerTurn > 0 && Number.isFinite(killMs)) {
      const h = passive.healPerTurn;
      const perTurn = (e.hitpoints / killMs) * eTurnMs;
      const before = killMs;
      let done = 0; // damage it hasn't healed back
      let turns = 0;
      for (; turns < 20_000; turns++) {
        if (done + perTurn >= e.hitpoints) break;
        done += perTurn;
        const healed = Math.min(Math.trunc(h * (e.hitpoints - done)), done);
        done -= healed;
        slimeHealed += healed;
      }
      killMs = turns >= 20_000 ? Infinity : Math.max(before, (turns + (e.hitpoints - done) / perTurn) * eTurnMs);
      if (!Number.isFinite(killMs)) slimeHealed = 0;
      healFactor = killMs / before;
    }
    // Its healing from what it does to you (lifesteal, Drain, effect lifesteal), at the rate the pass
    // before found. It undoes damage you've done, but never past full, so it's lost while you haven't
    // hurt it: a chain over the damage it hasn't healed back, your turns doing what they do at the rate
    // you take its HP off (damage over time included), its healing in between (healedTurnsToKill).
    let itsHealed = 0;
    const itsHeal = (adj.itsHealPerSec ?? 0) / 1000;
    if (itsHeal > 0 && Number.isFinite(killMs)) {
      const before = killMs;
      const rate = e.hitpoints / killMs;
      // What its hits heal comes in lumps, one a landed hit, bigger while Drain is up and with bigger
      // hits: in each of your turns, its turns in it (the whole numbers either side of the average),
      // each an attack picked by chance with its hits landing or not. What its effects heal comes evenly.
      let heal = itsHeal * pTurnMs;
      const lumps = adj.itsHealHits;
      if (lumps?.perTurn > 0 && lumps.kinds.length) {
        // A tenth of a point is close enough to tell lumps apart.
        const merge = (list) => {
          const out = new Map();
          for (const x of list) if (x.p > 0) out.set(Math.round(x.h * 10) / 10, (out.get(Math.round(x.h * 10) / 10) ?? 0) + x.p);
          return [...out].map(([h, p]) => ({ h, p }));
        };
        const add = (a, b) => merge(a.flatMap((x) => b.map((y) => ({ h: x.h + y.h, p: x.p * y.p }))));
        let itsTurn = [];
        for (const a of lumps.attacks) {
          // What a hit deals is rolled anywhere up to about twice its average: two points with that spread.
          const one = [{ h: 0, p: 1 - a.land }, ...lumps.kinds.flatMap((k) => [1 - 1 / Math.sqrt(3), 1 + 1 / Math.sqrt(3)].map((f) => ({ h: k.steal * a.dealt * f, p: (a.land * k.share) / 2 })))];
          let all = [{ h: 0, p: 1 }];
          for (let c = 0; c < a.hits; c++) all = add(all, one);
          itsTurn.push(...all.map((x) => ({ h: x.h, p: x.p * a.chance })));
        }
        itsTurn = merge(itsTurn);
        const mean = itsTurn.reduce((t, x) => t + x.h * x.p, 0);
        if (mean > 0) {
          itsTurn = itsTurn.map((x) => ({ h: (x.h * lumps.perTurn) / mean, p: x.p }));
          const m = pTurnMs / eTurnMs;
          const even = Math.max(0, heal - lumps.perTurn * m);
          heal = [];
          let dist = [{ h: even, p: 1 }];
          for (let count = 0; count <= Math.floor(m) + 1; count++) {
            const w = count === Math.floor(m) ? 1 - (m % 1) : count === Math.floor(m) + 1 ? m % 1 : 0;
            if (w > 0) heal.push(...dist.map((x) => ({ h: x.h, p: x.p * w })));
            dist = add(dist, itsTurn);
          }
        }
      }
      // Your hits at what they do (only the last is cut short by the HP left); your damage over time
      // comes a little at a time between them, like its healing the other way, so it keeps it off full.
      // Against the same chain without healing, so the grid's own error cancels out.
      let healed = 0;
      let plain = 0;
      for (const x of timings) {
        // (At its steady rate: this is the long fight, where its wait for the first start counts less.)
        const dot = (dotsOnEnemy.reduce((t, y) => t + y.dps, 0) * pTurnMs) / 1000;
        const less = (list) => (Array.isArray(list) ? list : [{ h: list, p: 1 }]).map((y) => ({ h: y.h - dot, p: y.p }));
        healed += x.weight * healedTurnsToKill(e.hitpoints, x.attacks, less(heal));
        plain += x.weight * healedTurnsToKill(e.hitpoints, x.attacks, less(0));
      }
      killMs = Number.isFinite(healed) && plain > 0 ? Math.max(before, (before * healed) / plain) : Infinity;
      if (killMs > 1000 * before) killMs = Infinity;
      if (Number.isFinite(killMs)) itsHealed = Math.max(0, rate * killMs - e.hitpoints);
      healFactor *= killMs / before;
    }
    if (Number.isFinite(killMs)) killMs += startStunMs;
    // Your effect lifesteal on your damage over time, over the whole fight.
    // Each proc heals at least 1 and a whole number (a proc from your max hit is the same each time;
    // one from the damage you dealt varies, and the rounding down and the at-least-1 about even out).
    if (Number.isFinite(killMs)) {
      for (const x of dotsOnEnemy) {
        if (!(x.lifesteal > 0) || !(x.procsPerSec > 0)) continue;
        const avg = x.dps / x.procsPerSec;
        effectHealPerKill += ((x.procsPerSec * dotTime(killMs, x)) / 1000) * Math.max(1, x.fixed ? Math.trunc(x.lifesteal * avg) : x.lifesteal * avg);
      }
    }
    const attacksPerKill = turnsToKill * dotFactor * healFactor;

    // Its attacks before the kill. Both sides start a full turn after it spawns (CombatActionComponent
    // StartFighting), so a quick kill can come before it swings at all; one on the tick it dies still
    // goes ahead (it ticks after you, before deaths are dealt with: CombatEntity.Tick). Your kill comes
    // on a whole turn K, at K x your turn plus where in it the killing hit lands; how likely each K is
    // comes from your hits (killTurnChances, about normal in a long fight), stretched by whatever else
    // slows or speeds the kill (ward, stuns, damage over time, healing).
    let enemyTurnsPerKill = Number.isFinite(killMs) ? (killMs / 1000) * enemyTurnsPerSec : 0;
    let enemyAttemptsPerKill = enemyTurnsPerKill * enemyAttempts;
    // A long fight is many of its turns either way, so its average rate is close enough there.
    if (Number.isFinite(killMs) && shapes.length && enemyTurnsPerKill <= 40) {
      const chances = [0];
      const timeMass = [0];
      let allExact = true;
      const plainMs = (k) => Math.max(pInterval, k * pTurnMs + killShiftMs);
      for (const sh of shapes) {
        // Your damage a turn, mean and spread, for the shape of a longer fight.
        let m = 0;
        let sq = 0;
        for (const a of sh.attacks) {
          let am = 0;
          let av = 0;
          for (const h of a.hits) {
            const d1 = h.spread.reduce((t, x) => t + x.d * x.p, 0);
            const d2 = h.spread.reduce((t, x) => t + x.d * x.d * x.p, 0);
            am += h.count * h.land * d1;
            av += h.count * (h.land * d2 - (h.land * d1) ** 2);
          }
          m += a.chance * am;
          sq += a.chance * (av + am * am);
        }
        const exact = turnsToKill <= 12 ? killTurnChances(e.hitpoints, timings[shapes.indexOf(sh)].attacks, pInterval) : null;
        if (!exact) allExact = false;
        const list = exact?.chances ?? normalTurnChances(turnsToKill, (sq - m * m) / Math.max(1e-9, m * m));
        list.forEach((x, k) => {
          chances[k] = (chances[k] ?? 0) + sh.weight * x;
          timeMass[k] = (timeMass[k] ?? 0) + sh.weight * x * (exact ? exact.times[k] : plainMs(k));
        });
      }
      const atTurn = chances.map((x, k) => (x > 0 ? timeMass[k] / x : plainMs(k)));
      const meanMs = chances.reduce((t, x, k) => t + x * atTurn[k], 0);
      // Stretched by what else slows or speeds the kill; turns that take different times are already
      // in the exact chances, but only at their average in the long-fight shape.
      const stretched = ward > 0 || dotFactor !== 1 || healFactor !== 1 || playerActive < 1 || startStunMs > 0 || (variable && !allExact);
      const scale = stretched && meanMs > 0 ? killMs / meanMs : 1;
      // Its turn n starts at n x its interval plus the time its multi-hit attacks before took (`waits`).
      const tie = 1000 / 120;
      const offsets = e.attacks.map((a) => {
        const list = [];
        let t = 0;
        a.hits.forEach((h, i) => {
          for (let c = 0; c < h.count; c++) {
            if (i > 0 || c > 0) t += h.interval;
            list.push(t);
          }
        });
        return { chance: a.chance, list };
      });
      const waits = enemyWaits(e.attacks.map((a) => ({ chance: a.chance, ms: attackExtraMs(a) })));
      const going = 1 - Math.min(0.9, enemyStun);
      enemyTurnsPerKill = 0;
      enemyAttemptsPerKill = 0;
      chances.forEach((x, k) => {
        if (!(x > 0)) return;
        const t = atTurn[k] * scale + tie;
        for (let n = 1; n * eInterval <= t; n++) {
          // Nothing of yours can stun it before your first hit.
          const g = n * eInterval < pInterval ? 1 : going;
          enemyTurnsPerKill += x * g * waits(n - 1, t - n * eInterval);
          for (const o of offsets) for (const at of o.list) enemyAttemptsPerKill += x * g * o.chance * waits(n - 1, t - n * eInterval - at);
        }
      });
    }
    // Its attacks per kill against the same time at its average rate: damage over time its hits put on
    // you is cut the same way.
    const attackShare = killMs > 0 && Number.isFinite(killMs) && enemyTurnsPerSec > 0 ? enemyTurnsPerKill / ((killMs / 1000) * enemyTurnsPerSec) : 1;

    // Its passive's other effects (Acid Burns, Plague Touch, Corrupting Touch, Spirit's Evasive...), as
    // chances each of its turns, from what sets them off: its hits, the hits it tries, the first of
    // each turn, your hits or misses on it (those come with your turns, so they're timed by yours),
    // or once a fight.
    const yourShare = eTurnMs / pTurnMs; // your turns in one of its
    const passiveTriggers = (passive?.applies ?? []).map((x) => {
      const yours = x.on === 'playerHit' || x.on === 'playerMiss';
      const land = x.on === 'playerHit' ? lands : (a) => 1 - lands(a);
      let perTurn = 0;
      let any = 0;
      if (x.on === 'enemyHit') [perTurn, any] = [x.chance * enemyLanded, oncePerTurn(e.attacks, itsLand, x.chance)];
      else if (x.on === 'enemyAttack') [perTurn, any] = [x.chance * enemyAttempts, oncePerTurn(e.attacks, () => 1, x.chance)];
      else if (x.on === 'enemyTurn') [perTurn, any] = [x.chance, x.chance];
      else if (yours) [perTurn, any] = [x.chance * (x.on === 'playerHit' ? pLanded : pAttempts - pLanded) * yourShare, oncePerTurn(pAttacks, land, x.chance) * yourShare];
      else [perTurn, any] = [x.chance / Math.max(1, enemyTurnsPerKill), x.chance / Math.max(1, enemyTurnsPerKill)];
      // Set off by your hit on you, it lasts its turns of yours in full (your turn ends after it).
      return { ...x, attack: null, perTurn, anyPerTurn: any, ...(yours ? (x.to === 'self' ? { timedBy: 'player' } : { fullTurns: true }) : {}) };
    }).filter((x) => x.perTurn > 0);
    const itsTriggers = [...eTriggers, ...passiveTriggers];
    // Stacks that build up until the fight ends (ActiveStackingEffect: Off Balance, Quicksand,
    // Exsanguinate, Deep Wound, Burning Flame): the average over a fight of the applications it has,
    // for the next pass, and for this one's damage over time on you (its fight so far was shorter).
    const yourTurnsPerKill = Number.isFinite(killMs) ? attacksPerKill : 0;
    // Applications a fight of each, by side and effect. Its passive's stacks on itself (Hivemind, Smoke
    // Body, Dwarven Pride: from your hits or misses or its own) are the same effect as any its attacks
    // put on (Grand Boast's Dwarven Pride): one count, one max.
    const counts = new Map();
    const count = (who, effect, d, n) => {
      const key = `${who}|${effect}`;
      const c = counts.get(key) ?? { who, d, n: 0 };
      c.n += n;
      counts.set(key, c);
    };
    if (Number.isFinite(killMs)) {
      for (const r of passive?.ramps ?? []) {
        const n = r.on === 'playerHit' ? pLanded * yourTurnsPerKill : r.on === 'playerMiss' ? (pAttempts - pLanded) * yourTurnsPerKill
          : r.on === 'enemyHit' ? enemyAttemptsPerKill * enemyHitChance : enemyAttemptsPerKill;
        count('enemy', r.effect ?? r.name, effectDef(r.effect) ?? { name: r.name, maxStacks: r.maxStacks, mods: r.mods }, n);
      }
      for (const [list, by] of [[pTriggers, 'player'], [itsTriggers, 'enemy']]) {
        for (const x of list) {
          const d = x.kind === 'stacking' ? effectDef(x.effect) : null;
          if (!d) continue;
          const who = x.to === 'self' ? by : by === 'player' ? 'enemy' : 'player';
          const applied = x.perTurn * (by === 'player' ? yourTurnsPerKill : enemyTurnsPerKill) * (1 - avoids(who === 'player' ? playerFx : enemyFx, x.effect)) * (who === 'enemy' && by === 'player' ? 1 - wardShare : 1);
          count(who, x.effect, d, applied * (x.stacks ?? d.stacks ?? 1));
        }
      }
    }
    const stacked = [];
    for (const { who, d, n } of counts.values()) {
      // Applications spread over the fight: n of them average n / 2 stacks, less once they hit the max.
      const stacks = n <= d.maxStacks ? n / 2 : d.maxStacks - (d.maxStacks * d.maxStacks) / (2 * n);
      const mods = d.mods.filter((m) => STATE_STATS.has(m.stat) || m.stat === 'EffectDamageTaken').map((m) => ({ ...m, value: m.value * stacks }));
      if (!(stacks > 0) || !mods.length) {
        unmodelled.add(d.name);
        continue;
      }
      stacked.push({ who, name: d.name, mods, uptime: 1, stacks, stacking: true });
    }
    // Effect damage taken now: stacks as this pass has them.
    const stateFxNow = (who, effect) => stateFx(who, effect, true) + stacked.filter((st) => st.who === who).reduce((t, st) => t + st.mods.reduce((u, m) => u + (m.stat === 'EffectDamageTaken' && (!m.effect || m.effect === effect) ? m.value : 0), 0), 0);

    // Damage over time on you: from its passive and its attacks, each proc through your resistance and
    // armour (at least 1), less your avoidance and effect damage reduction.
    const playerRes = resistance(enemyPower + lin('enemy', 'FlatPowerRating'), yourProtection, 0, 0, lin('player', 'PercentResistance'));
    // The same effect from its passive and an attack is one effect on you (it isn't refreshed while up),
    // so their triggers add up and their damage is averaged. `every`: the turns its starts come on.
    const onYou = new Map();
    // `side`: whose hits start it, and `c(a, k)` the chance hit k of attack a does; null when it starts
    // once a fight.
    const addDot = (d, id, perSec, base, x, fromItsAttacks, side, c) => {
      const g = onYou.get(id) ?? { d, stackRate: 0, startRate: 0, damage: 0, fromAttacks: 0, side, cs: [] };
      const { stackRate, startRate } = triggerRates(perSec, x);
      g.stackRate += stackRate;
      g.startRate += startRate;
      g.damage += stackRate * base;
      if (fromItsAttacks) g.fromAttacks += stackRate;
      if (g.side !== side) g.side = null;
      g.cs.push(c);
      onYou.set(id, g);
    };
    for (const d of passive?.dots ?? []) {
      const triggers = (d.on === 'start' ? 1000 / (killMs + spawnMs) : rateOf(d.on)) * d.chance * (1 - avoids(playerFx, d.effect ?? d.name)); // per second
      const base = d.formula === 'DamageDealt' ? Math.max(1, enemyAvgHit * d.percent) : Math.max(1, Math.trunc(enemyMaxHit * d.percent));
      // What it does to your stats while it runs is on the effect itself (Silt Burns).
      const def = { ...d, mods: (d.effect && effectDef(d.effect)?.mods) || d.mods || [] };
      const notAvoided = 1 - avoids(playerFx, d.effect ?? d.name);
      const yours = d.on === 'playerHit' || d.on === 'playerMiss';
      const side = d.on === 'start' ? null : yours ? 'player' : 'enemy';
      const c = (a, k) => d.chance * notAvoided * (d.on === 'enemyHit' ? itsLand(a) : d.on === 'playerHit' ? lands(a) : d.on === 'playerMiss' ? 1 - lands(a) : 1);
      if (triggers > 0) addDot(def, d.effect ?? d.name, triggers, base, null, d.on === 'enemyHit' || d.on === 'enemyAttack', side, c);
    }
    for (const x of eTriggers) {
      const d = x.kind === 'dot' && x.to === 'target' ? effectDef(x.effect) : null;
      if (!d) continue;
      const lands = 1 - avoids(playerFx, x.effect);
      const tally = byAttack.get(x.attack);
      const base = d.formula === 'DamageDealt' ? Math.max(1, (tally.landed > 0 ? tally.damage / tally.landed : 0) * d.percent) : d.formula === 'MaxHit' ? Math.max(1, Math.trunc(enemyMaxHit * d.percent)) : 0;
      if (lands > 0 && base > 0) addDot(d, x.effect, enemyTurnsPerSec * lands, base, x, true, 'enemy', (a, k) => (a === x.attack ? atHit(x, itsLand(a), k) * lands : 0));
    }
    let dotOnYouDps = 0;
    let dotOnYouPerKill = 0;
    let itsEffectHealPerSec = 0;
    const dotTicks = []; // { perSec, avg, steal }: its procs on you, for lifesteal (at least 1 a proc)
    for (const [id, g] of onYou) {
      // (Rounded off so 3 from a sum of rates comes back as 3, not 2.999..., before the game's rounding down.)
      let base = Math.round((g.damage / g.stackRate) * 1e6) / 1e6;
      const takes = Math.max(0, 1 + playerTakes + playerFx('EffectDamageTaken', id) + stateFxNow('player', id));
      const tick = (stacks) => Math.max(1, Math.trunc(stacks * base * takes * (1 - playerRes) - p.armour));
      // Started at hits (its, or yours), it runs on the turns of that side; once a fight, at random.
      const either = (a, k) => 1 - g.cs.reduce((t, c) => t * (1 - c(a, k)), 1);
      const cycle = g.side === 'enemy' ? dotCycleAtHits(g.d, turnsOf(e.attacks, eInterval, either)) : g.side === 'player' ? dotCycleAtHits(g.d, turnsOf(pAttacks, pInterval, either)) : null;
      const cycleSec = cycle ? cycle.sec / (g.side === 'enemy' ? 1 - Math.min(0.9, enemyStun) : playerActive) : g.startRate > 0 ? dotCycleSec(g.d, g.startRate) : Infinity;
      // From the damage of the hit that starts it (Bleed): the first hit of a burst that sets it off
      // starts it and the rest can't, so a single big hit starts more than its share.
      if (g.d.formula === 'DamageDealt' && g.side === 'enemy' && cycle) {
        const dealt = e.attacks.reduce((t, a, i) => t + cycle.starts[i] * (byAttack.get(a)?.landed > 0 ? byAttack.get(a).damage / byAttack.get(a).landed : 0), 0);
        if (dealt > 0) base = Math.max(1, dealt * g.d.percent);
      }
      const dps = dotDps(g.d, tick, g.stackRate, cycleSec, cycle?.burst ?? 0);
      dotOnYouDps += dps;
      const fromAttacks = g.fromAttacks / g.stackRate;
      if (Number.isFinite(killMs)) dotOnYouPerKill += (dps * (fromAttacks * attackShare + 1 - fromAttacks) * killMs) / 1000;
      // Procs a second: runs one after another, each waiting for the next start (dotDps).
      const perSec = Number.isFinite(cycleSec) && cycleSec > 0 ? g.d.procs / cycleSec : 0;
      if (perSec > 0) dotTicks.push({ perSec, avg: dps / perSec, fixed: g.d.formula !== 'DamageDealt', steal: Math.max(0, enemyFx('EffectLifesteal', id)) });
      // While it runs it can change your stats too (Silt Burns: less accuracy and evasion).
      const dotMods = (g.d.mods ?? []).filter((m) => STATE_STATS.has(m.stat));
      if (dotMods.length && perSec > 0) nextStates.push({ who: 'player', name: g.d.name, mods: dotMods, uptime: (perSec * g.d.interval) / 1000 });
      notes.push({ who: 'player', kind: 'dot', name: g.d.name, dps });
    }
    enemyDps += dotOnYouDps;
    // Its reflect, on each of your landed hits.
    const reflectOnYouPerKill = Number.isFinite(killMs) ? reflectPerHit * attacksPerKill * pDamaging : 0;
    if (reflectOnYouPerKill > 0) notes.push({ who: 'player', kind: 'reflect', name: 'Reflect', dps: reflectOnYouPerKill / (killMs / 1000) });

    // Effects that change stats for some of the target's turns: on yourself for the turns after the
    // one it's applied in; on the other side, the rest of its current turn counts as one.
    const lasting = new Map();
    const addLasting = (x, by, perMs) => {
      const d = x.kind === 'turns' ? effectDef(x.effect) : null;
      // Effect damage taken and avoidance count too (Pestilent: +500% from Poison for a turn).
      const counted = (m) => STATE_STATS.has(m.stat) || m.stat === 'EffectDamageTaken' || m.stat === 'EffectAvoidanceChance';
      if (x.kind !== 'turns' || !d?.mods.some(counted)) {
        if (!['dot', 'stun', 'stacking', 'eot'].includes(x.kind)) unmodelled.add(d?.name ?? x.effect);
        return;
      }
      const who = x.to === 'self' ? by : by === 'player' ? 'enemy' : 'player';
      const turns = x.turns ?? d.turns;
      // On itself it also lasts the rest of the attack it's put on in (Dive's second hit, 1.8s later).
      const ms = (x.to === 'self' || x.fullTurns ? turns : Math.max(0.5, turns - 0.5)) * (who === 'player' ? pTurnMs : eTurnMs) + (x.to === 'self' && x.attack ? attackExtraMs(x.attack) : 0);
      const rate = perMs * x.anyPerTurn * (1 - avoids(who === 'player' ? playerFx : enemyFx, x.effect));
      const key = `${who}|${x.effect}`;
      // On itself when you hit it (Spirit's Evasive): what it changes matters at your next hits, as if you'd put it on.
      const s = lasting.get(key) ?? { who, by: x.timedBy ?? by, onOther: x.to !== 'self' || !!x.timedBy, turns, name: d.name, mods: d.mods.filter(counted), rate: 0, ms: 0 };
      // What goes on as it wears off (Starblight, then Starblighted for 5 turns): its turns, its mods,
      // and whether it keeps the first from landing again meanwhile.
      const after = d.after ? effectDef(d.after.effect) : null;
      if (after) {
        const blocks = after.mods.some((m) => m.stat === 'EffectAvoidanceChance' && m.effect === x.effect && m.value >= 1);
        s.after = { name: after.name, turns: d.after.turns ?? after.turns, blocks, mods: after.mods.filter((m) => counted(m) && !(m.stat === 'EffectAvoidanceChance' && m.effect === x.effect)) };
      }
      s.rate += rate;
      s.ms = Math.max(s.ms, ms);
      s.turns = Math.max(s.turns, turns);
      lasting.set(key, s);
    };
    for (const x of pTriggers) addLasting(x, 'player', playerActive * pTurnsPerMs * (x.to === 'target' ? 1 - wardShare : 1));
    for (const x of itsTriggers) addLasting(x, 'enemy', enemyTurnsPerSec / 1000);
    for (const s of lasting.values()) {
      // Put on the other side, it wears off at the end of one of that side's turns, at no particular
      // point in the turns of whoever puts it on: the next chance comes half a turn later on average,
      // not a whole one.
      const every = s.by === 'player' ? pTurnMs : eTurnMs;
      const uptime = s.onOther && s.rate > 0 ? clamp(s.ms / (s.ms + Math.max(0, 1 / s.rate - every / 2)), 0, 1) : uptimeOf(s.rate, s.ms);
      if (!(uptime > 0)) continue;
      // Put on the other side by your hit (or its), what lowers its defence only matters at your next
      // hits, which come a whole turn later: the share of them it's up for, not of the time. It's gone
      // at the end of its turn after next (the rest of this one counts), so each one covers the hits
      // of yours that come before then (Fracture: often none when your turns are the longer).
      const defence = s.onOther ? s.mods.filter((m) => DEFENCE_STATS.has(m.stat)) : [];
      if (defence.length) {
        const mine = s.by === 'player' ? pTurnMs : eTurnMs;
        const theirs = s.by === 'player' ? eTurnMs : pTurnMs;
        let covered = 0;
        for (let j = 1; j * mine < s.turns * theirs; j++) covered += clamp(s.turns - (j * mine) / theirs, 0, 1);
        const q = s.rate * mine;
        // The first hit of a fight is never covered (none can be up yet).
        const turnsPerKill = s.by === 'player' ? attacksPerKill : enemyTurnsPerKill;
        const warm = Number.isFinite(turnsPerKill) && turnsPerKill > 1 ? 1 - 1 / turnsPerKill : 1;
        nextStates.push({ who: s.who, name: s.name, mods: defence, uptime: ((q * covered) / (1 + q * covered)) * warm });
      }
      // What changes the other side's own attacks (your accuracy and max hit, when it's on you) matters
      // at those: put on before one of them (`before`: the chance it is, between two), it covers that one and
      // the next `turns - 1`, and isn't put on again until it's gone, or until what follows it is gone
      // too. A fight starts with none up, which costs about half a run.
      const own = s.onOther ? s.mods.filter((m) => !defence.includes(m) && m.stat !== 'EffectDamageTaken') : [];
      const targetMs = s.who === 'player' ? pTurnMs : eTurnMs;
      const before = 1 - (1 - Math.min(1, s.rate * every)) ** (targetMs / every);
      const blocked = s.after?.blocks ? s.after.turns : 0;
      const runs = 1 + before * (s.turns + blocked - 1);
      const targetTurns = s.who === 'player' ? attacksPerKill : enemyTurnsPerKill;
      const start = Number.isFinite(targetTurns) && targetTurns > 0 ? Math.max(0, 1 - (s.turns + blocked + 1) / (2 * targetTurns)) : 1;
      const ownShare = ((before * s.turns) / runs) * start;
      if (own.length) nextStates.push({ who: s.who, name: s.name, mods: own, uptime: ownShare });
      if (s.after?.mods.length) {
        const afterShare = (s.after.blocks ? (before * s.after.turns) / runs : (before * s.after.turns) / (1 + before * (s.after.turns - 1))) * start;
        nextStates.push({ who: s.who, name: s.after.name, mods: s.after.mods, uptime: afterShare });
        notes.push({ who: s.who, kind: 'turns', name: s.after.name, share: afterShare });
      }
      const rest = s.mods.filter((m) => !defence.includes(m) && !own.includes(m));
      if (rest.length) nextStates.push({ who: s.who, name: s.name, mods: rest, uptime, perMs: s.rate });
      notes.push({ who: s.who, kind: 'turns', name: s.name, share: own.length ? ownShare : uptime });
    }

    for (const st of stacked) {
      nextStates.push(st);
      notes.push({ who: st.who, kind: 'stacks', name: st.name, stacks: st.stacks });
    }
    // Damage at the end of each of your turns once it's on you, until the fight ends (Ambush, Storm
    // Surge: ActiveEndOfTurnDamageEffect, not refreshed while it's on), through your resistance and armour.
    let eotOnYouPerKill = 0;
    for (const x of itsTriggers) {
      const d = x.kind === 'eot' ? effectDef(x.effect) : null;
      if (!d || x.to !== 'target' || !Number.isFinite(killMs)) {
        if (x.kind === 'eot' && !d) unmodelled.add(x.effect);
        continue;
      }
      const q = x.anyPerTurn * (1 - avoids(playerFx, x.effect));
      const from = d.of === 'target' ? { min: 1, max: playerMax } : { min: Math.round(enemyMaxHit * ((passive?.minHitOfMax ?? 0) + lin('enemy', 'MinHitBasedOnMaxHit'))) || 1, max: enemyMaxHit };
      const roll = d.formula === 'Fixed' ? { min: d.damage, max: d.damage } : d.formula === 'MaxHit' ? { min: Math.trunc(from.max * d.percent), max: Math.trunc(from.max * d.percent) } : { min: Math.trunc(from.min * d.percent), max: Math.trunc(from.max * d.percent) };
      const takes = Math.max(0, 1 + playerTakes + playerFx('EffectDamageTaken', x.effect) + stateFxNow('player', x.effect));
      const tick = overRoll(roll.min, roll.max, (r) => Math.max(1, Math.trunc(r * takes * (1 - playerRes) - p.armour)));
      // Your turns left after its turn n puts it on (its turns come further apart while it's stunned;
      // once on, it goes off at the end of every turn of yours, stunned or not).
      const stretch = 1 / (1 - Math.min(0.9, enemyStun));
      let ticks = 0;
      let none = 1;
      for (let n = 1; n * eInterval <= killMs && n < 2000; n++) {
        ticks += none * q * Math.max(0, (killMs - (n * eInterval + (n - 1) * (eTurnMs - eInterval)) * stretch) / pTurnMs);
        none *= 1 - q;
      }
      const perKill = ticks * tick;
      eotOnYouPerKill += perKill;
      notes.push({ who: 'player', kind: 'dot', name: d.name, dps: perKill / (killMs / 1000) });
    }
    for (const x of pTriggers) if (x.kind === 'eot') unmodelled.add(effectDef(x.effect)?.name ?? x.effect);

    // What it heals itself, per second of fighting, for the next pass. Lifesteal (CharacterComponent.
    // Lifesteal) heals a share of all the damage it does you, at least 1 each time; Drain adds to it for
    // the hit it's put on before and its next turns (the turn it's applied in isn't counted down:
    // ActiveTurnCountingEffect). Effect lifesteal comes on top, on its effects' damage.
    const drains = eTriggers.filter((x) => x.kind === 'turns' && x.to === 'self').map((x) => {
      const d = effectDef(x.effect);
      const v = (d?.mods ?? []).reduce((t, m) => t + (m.stat === 'FlatCombatStatValue' && m.combatStat === 'Lifesteal' ? m.value : 0), 0);
      const q = x.anyPerTurn * (1 - avoids(enemyFx, x.effect));
      const n = x.turns ?? d?.turns ?? 1;
      return { name: d?.name ?? x.effect, v, share: x.when === 'pre' ? (q * (1 + n)) / (1 + q * n) : (q * n) / (1 + q * n) };
    }).filter((x) => x.v > 0);
    const baseSteal = e.lifesteal ?? 0;
    const drainShare = Math.min(1, drains.reduce((t, x) => t + x.share, 0));
    const stealPerTurn = (steal) => (steal > 0 ? damageRolls.reduce((t, r) => {
      const mid = Math.trunc(midHp * r.currentHp);
      return t + r.weight * overRoll(r.min + mid, r.max + mid, (x) => (x > 0 ? Math.max(1, Math.trunc(Math.max(1, Math.trunc(x * r.factor - r.armour)) * steal)) : 0));
    }, 0) : 0);
    const meanSteal = baseSteal + drains.reduce((t, x) => t + x.share * x.v, 0);
    const otherDamagePerSec = Number.isFinite(killMs) && killMs > 0 ? ((eotOnYouPerKill + reflectOnYouPerKill) * 1000) / killMs : 0;
    // Effect lifesteal (Bloodlands, Crimson Eyes) on its effects' damage, at least 1 a proc too.
    // Lifesteal on each proc is at least 1, while it has any (always, or while Drain is up), and a whole
    // number. A proc from its max hit is the same each time, so that of its average is right; one from
    // the damage it dealt (Bleed) varies a lot, and what rounding down loses the at-least-1 about gives back.
    const steals = (steal, t) => Math.max(1, t.fixed ? Math.trunc(steal * t.avg) : steal * t.avg);
    const stealOn = (t) => (1 - drainShare) * (baseSteal > 0 ? steals(baseSteal, t) : 0) + drains.reduce((u, x) => u + x.share * steals(baseSteal + x.v, t), 0);
    for (const t of dotTicks) itsEffectHealPerSec += t.perSec * (stealOn(t) + (t.steal > 0 ? steals(t.steal, t) : 0));
    const itsHealPerSec = enemyTurnsPerSec * ((1 - drainShare) * stealPerTurn(baseSteal) + drains.reduce((t, x) => t + x.share * stealPerTurn(baseSteal + x.v), 0))
      + meanSteal * otherDamagePerSec + itsEffectHealPerSec;
    // Its hits' healing by kind (with Drain up or not), for the next pass's lumps.
    // Its hits' healing, for the next pass's lumps: each attack's hits, each landing or not and healing
    // its kind's share of what it deals (with Drain up or not), scaled to the healing a turn.
    const itsHealHits = {
      perTurn: (1 - drainShare) * stealPerTurn(baseSteal) + drains.reduce((t, x) => t + x.share * stealPerTurn(baseSteal + x.v), 0),
      kinds: [{ share: 1 - drainShare, steal: baseSteal }, ...drains.map((x) => ({ share: x.share, steal: baseSteal + x.v }))].filter((k) => k.share > 0 && k.steal > 0),
      attacks: e.attacks.map((a) => ({ chance: a.chance, hits: a.hits.reduce((t, h) => t + h.count, 0), land: itsLand(a), dealt: byAttack.get(a)?.landed > 0 ? byAttack.get(a).damage / byAttack.get(a).landed : 0 })),
    };
    if (itsHealPerSec > 0) notes.push({ who: 'enemy', kind: 'heal', name: 'Heals', dps: itsHealPerSec });

    for (const st of nextStates) if (st.uptimeAt) st.uptime = st.uptimeAt(killMs);
    const cycleMs = killMs + spawnMs;
    const killsPerHour = Number.isFinite(cycleMs) ? HOUR_MS / cycleMs : 0;
    const attacksPerHour = killsPerHour * attacksPerKill;

    const st = gd.combat.stances[p.stance];
    // XP comes from the damage your attacks deal, its HP plus anything it healed less what damage over
    // time took (CombatExperienceComponent), and on the kill for its armour and ward
    // (KilledExperienceStats); XP bonuses raise both.
    // Its HP plus what it healed, less what damage over time and reflect took (they go on longer when it heals).
    const attackDamage = Math.max(0.1 * e.hitpoints, e.hitpoints + slimeHealed + itsHealed - dotDamage * healFactor);
    const killXp = attackDamage + 4 * e.armour + 50 * Math.max(0, e.enemy.stats.MaximumWard ?? 0);
    const xpPerHour = Object.fromEntries(st.xp.map((x) => [x.skill, killXp * x.perDamage * (1 + xpBonus(gd, x.skill)) * killsPerHour]));
    const combatXpPerHour = Object.values(xpPerHour).reduce((s, v) => s + v, 0);

    const prayerXpPerHour = attacksPerHour * prayerXpPerTurn * (1 + xpBonus(gd, 'Prayer'));
    const enemyAttacksPerHour = enemyTurnsPerKill * killsPerHour;
    // Prayer points each turn, yours or its, unless the cost is kept (ActivePrayerSlot).
    const prayerPointsPerHour = active.reduce((sum, x) => sum + x.cost * (x.paidOn === 'enemy' ? enemyAttacksPerHour : attacksPerHour), 0) * (1 - (p.keep?.prayer ?? 0));
    // Prayer XP sits with the other skills' XP, but isn't part of the combat XP total.
    if (prayerXpPerHour > 0) xpPerHour.Prayer = prayerXpPerHour;

    return {
      playerHit, playerAvg: landedPerKill > 0 ? (e.hitpoints * (1 - dotShare)) / landedPerKill : 0, playerMax, enemyRes, eInterval, eTurnMs, enemyDps, enemyHitChance, biggestHit, damageRolls, attacksPerKill, killMs,
      killsPerHour, attacksPerHour, xpPerHour, combatXpPerHour, prayerXpPerHour, prayerPointsPerHour, enemyAttacksPerHour,
      enemyHitsPerKill: enemyAttemptsPerKill * enemyHitChance, enemyAttemptsPerKill, enemyTurnsPerSec,
      enemyAttemptsPerTurn: enemyAttempts, effectHealPerKill, itsHealPerSec, itsHealHits, itsHealedPerKill: slimeHealed + itsHealed,
      damageTakenPerKill: (enemyAttempts > 0 ? (enemyAttemptsPerKill * enemyDamage) / enemyAttempts : 0) + dotOnYouPerKill + reflectOnYouPerKill + eotOnYouPerKill,
      enemyAttackDamagePerHour: (enemyAttempts > 0 ? (enemyAttemptsPerKill * enemyDamage) / enemyAttempts : 0) * killsPerHour,
      landedPerKill: attacksPerKill * pLanded, missedPerKill: attacksPerKill * (pAttempts - pLanded), hitsPerTurn: pAttempts,
      playerStun, enemyStun, playerActive, dotOnEnemyDps, dotOnYouDps, nextStates, notes, unmodelled,
    };
  };

  // Stacking passives (Hivemind, Rage, ...) build up during each fight, and effects come and go: run
  // once, average the stacks that fight would build and take how often each effect is up, then run again.
  let f = run({});
  if (f.killsPerHour > 0 && (passive?.ramps.length || f.nextStates.length || f.playerStun > 0 || f.itsHealPerSec > 0)) {
    f = run({ states: f.nextStates, playerActive: f.playerActive, itsHealPerSec: f.itsHealPerSec, itsHealHits: f.itsHealHits, killMs: f.killMs });
  }

  const damageTakenPerKill = Number.isFinite(f.killMs) ? f.damageTakenPerKill : 0;
  const healedPerKill = p.lifesteal * e.hitpoints + (f.effectHealPerKill ?? 0);
  const hpLossPerHour = Math.max(0, damageTakenPerKill - healedPerKill) * f.killsPerHour;

  const baseHeal = food ? gd.items[food]?.heal ?? 0 : 0;
  // Healing (CombatFoodStats): base x (1 + healing bonuses), then x auto-eat efficiency, each at least 1.
  const healing = baseHeal > 0 ? Math.max(1, Math.trunc(baseHeal * (1 + (p.healingPercent ?? 0)))) : 0;
  const heal = healing > 0 ? Math.max(1, Math.trunc(healing * Math.max(0.01, 1 + bonus('FlatAutoEatEfficiency')))) : 0;
  // Your HP at each attack it makes, with auto-eat filling you up (autoEatChain): the chance of dying,
  // and how much each item eaten heals (all of it, unless it would go past full).
  const attemptsPerHour = f.enemyAttacksPerHour * f.enemyAttemptsPerTurn;
  const drain = attemptsPerHour > 0 ? Math.max(0, hpLossPerHour - f.enemyAttackDamagePerHour) / attemptsPerHour : 0;
  // Only needed when a hit can kill you or an item can heal past full; otherwise each heals in full.
  const chain = heal > 0 && f.enemyAttemptsPerTurn > 0 && (f.biggestHit > threshold || heal > limit - threshold)
    ? autoEatChain({ maxHp, threshold, limit, heal, drain, midHp, rolls: f.damageRolls.map((d) => ({ ...d, w: d.weight / f.enemyAttemptsPerTurn })) })
    : null;
  const healedPerItem = chain?.healedPerItem ?? heal;
  const foodEaten = heal > 0 ? hpLossPerHour / Math.max(1, healedPerItem) : null;
  // Food you keep when eating (FoodPreservationChance) isn't used up.
  const foodPerHour = foodEaten == null ? null : foodEaten * (1 - (p.keep?.food ?? 0));

  // Dying: with food, only a hit at least your HP at the time can kill you (each hit of a special
  // attack on its own). Without food, you last until the damage adds up to your HP.
  let hoursToDeath = Infinity;
  if (chain) {
    const perHour = chain.deathPerAttack * attemptsPerHour;
    hoursToDeath = perHour > 0 ? 1 / perHour : Infinity;
  } else if (heal <= 0 && hpLossPerHour > 0) {
    hoursToDeath = maxHp / hpLossPerHour;
  }
  const oneHitRisk = f.biggestHit >= maxHp;

  const loot = lootOf(gd, e.enemy);
  const lootPerHour = loot.totalValue * f.killsPerHour;
  // Ammo goes with every hit, a special attack's too, and runes each turn, unless kept (PlayerComponent.OnAttack, MagicSpellsComponent).
  const ammoPerHour = p.ammoId ? f.attacksPerHour * f.hitsPerTurn * (1 - (p.keep?.ammo ?? 0)) : 0;
  const runesPerHour = p.spell ? p.spell.runes.map((r) => ({ item: r.item, perHour: r.qty * f.attacksPerHour * (1 - (p.keep?.runes ?? 0)) })) : [];
  // The imbuement's runes go every turn too (PlayerComponent.OnAttackTurnStarted), unless kept.
  for (const r of p.imbuement?.runes ?? []) {
    const perHour = r.qty * f.attacksPerHour * (1 - (p.keep?.imbuementRunes ?? 0));
    const same = runesPerHour.find((x) => x.item === r.item);
    if (same) same.perHour += perHour;
    else runesPerHour.push({ item: r.item, perHour });
  }
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
    // Its turns per second while it's fighting (enemyAttacksPerHour counts only those before your kills).
    enemyTurnsPerSec: f.enemyTurnsPerSec,
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
    // Effects counted: { who: 'player' | 'enemy' (who it's on), kind: 'dot' | 'stun' | 'turns', name,
    // dps (damage over time) or share (of the time lost to a stun, or up) }; and the ones that aren't.
    effects: f.notes,
    effectsNotCounted: [...f.unmodelled],
    // Share of your time lost to stuns, and its.
    stunned: f.playerStun,
    enemyStunned: f.enemyStun,
    // Damage over time per second: on you (in hpLossPerHour), and yours on it.
    dotDps: f.dotOnYouDps,
    dotOnEnemyDps: f.dotOnEnemyDps,
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

// The same player with another food selected: its bonuses instead of the selected food's.
export const withFood = (gd, p, food) => (p.build ? buildPlayer(gd, { ...p.build, food }) : p);

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

// Imbuements this weapon can use at your Magic level that you have the runes for, in the game's order.
export function castableImbuements(gd, weaponId, levels, bank) {
  const elements = equipOf(gd, weaponId)?.weapon?.elements ?? [];
  return (gd.combat.imbuements ?? [])
    .filter((x) => x.level <= gd.levelOf(levels, 'Magic') && elements.includes(x.element))
    .filter((x) => !bank || x.runes.every((r) => (bank[r.item] ?? 0) >= r.qty));
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
function completeKit(gd, { style, gear, owned, levels, bank, imbuement = null }) {
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
    // The imbuement you have selected, while this weapon can use it and you have the runes.
    const imb = imbuementOf(gd, imbuement);
    kit.imbuement = imb && castableImbuements(gd, weaponId, levels, bank).some((x) => x.id === imb.id) ? imb : null;
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
      const p = buildPlayer(gd, { gear, stance, spell: kit.spell, imbuement: kit.imbuement, levels, darkness: area?.darkness ?? 0, area, slayerTask: onTask(gd, enemy.enemy.id), food });
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
export function scoreGear(gd, { style, gear, owned, levels, bank, enemy, area = null, food = null, skill = null, imbuement = null }) {
  if (isTwoHanded(gd, gear) && gear.some((id) => equipOf(gd, id)?.type === 'Offhand')) return null;
  const kit = completeKit(gd, { style, gear, owned, levels, bank, imbuement });
  return kit && evaluateKit(gd, kit, levels, enemy, area, food, skill);
}

/**
 * Best gear you own for one style against one enemy: tries each owned item slot by slot and keeps
 * whatever gives the most combat XP per hour without letting the enemy one-hit you.
 */
export function optimiseGear(gd, { style, owned, levels, bank, enemy, area = null, food = null, start = [], skill = null, imbuement = null }) {
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
    const kit = completeKit(gd, { style, gear, owned, levels, bank, imbuement });
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
  return { style, slots: slotsOut, gear: best.kit.gear, stance: best.stance, spell: best.kit.spell, imbuement: best.kit.imbuement ?? null, player: best.player, result: best.result, enemy, area };
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
export function rankFights(gd, { style, gear, stance, spell, imbuement = null, levels, food }) {
  return fightableEnemies(gd, levels)
    .map(({ enemy, area, unknown }) => {
      const p = buildPlayer(gd, { gear, stance, spell, imbuement, levels, darkness: area.darkness, area, slayerTask: onTask(gd, enemy.id), food });
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
export function recommendStyle(gd, { style, owned, levels, bank, food, saved = null, target = null, skill = null, imbuement = null }) {
  const rank = (g) => rankFights(gd, { style, gear: g.gear, stance: g.stance, spell: g.spell, imbuement: g.imbuement, levels, food });
  const bestSafe = (g) => {
    const ranked = rank(g).filter(safe).sort((a, b) => xpOf(b.result, skill) - xpOf(a.result, skill));
    return ranked[0] ? { enemy: ranked[0].enemy, area: ranked[0].area } : null;
  };
  let start = saved?.gear ?? [];
  let pick = target;
  if (!pick) {
    // A practice target that takes a while to kill, so the first pass values damage over respawn time.
    const dummy = { ...gd.enemies[0], levels: { ...gd.enemies[0].levels, Hitpoints: 10_000 } };
    const seed = optimiseGear(gd, { style, owned, levels, bank, enemy: dummy, food, start, skill, imbuement });
    if (!seed) return null;
    pick = bestSafe(seed);
    if (!pick) return { style, gear: { ...seed, enemy: null, area: null }, fights: rank(seed) };
    start = seed.gear;
  }
  let opt = null;
  for (let round = 0; round < 3; round++) {
    opt = optimiseGear(gd, { style, owned, levels, bank, enemy: pick.enemy, area: pick.area, food, start, skill, imbuement });
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
