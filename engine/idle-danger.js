// Skills that hurt you (a failed pickpocket, a failed Agility obstacle): whether you can leave them
// running. The game eats the skill's selected food only when a hit leaves you at or under the auto-eat
// threshold (FoodComponent.AutoEat), so a hit bigger than that can kill you from just above it. Dying
// stops the skill and takes a tenth of a random toolbelt slot's stack, or the item in it
// (ThievingActionComponent.HealthSelfCurrentChangedHandler, and Agility's the same).
// Isomorphic.
import { autoEatChain, RISKY_HOURS } from './combat.js';

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
// C#'s Math.Round: halves go to the even number.
const roundEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

const cache = new WeakMap();

/**
 * Whether a method's damage can kill you while you leave it running, with your HP, auto-eat and the food
 * selected for its skill in the game. Null when it can't hurt you or there's no save to say your HP.
 * @param r computeRates() result
 * @returns { maxHp, autoEatAt, biggestHit, food, picked, hoursToDeath, risky, safeLevel }: `food` is the
 *   skill's food when you have some (`picked` even when you don't), `hoursToDeath` the expected time before
 *   a death left running (Infinity: never while the food lasts), `risky` under RISKY_HOURS, `safeLevel` the
 *   Hitpoints level where auto-eat always comes in time.
 */
export function idleDanger(gd, r) {
  if (!r?.hits?.rolls?.length || !(r.hits.perHour > 0)) return null;
  if (cache.has(r)) return cache.get(r);
  const level = gd.player?.levels?.Hitpoints;
  let out = null;
  if (level > 0) {
    const skill = r.method.skill;
    const maxHp = level * 10;
    // Auto-eat bonuses are global or the skill's own.
    const bonus = (stat) => (gd.playerBonuses ?? []).filter((b) => b.stat === stat && (b.skill == null || b.skill === skill)).reduce((s, b) => s + b.value, 0);
    const autoEatAt = roundEven(clamp(0.25 + bonus('FlatAutoEatThreshold'), 0, 1) * maxHp);
    const limit = clamp(1 + bonus('FlatAutoEatLimit'), 0, 1) * maxHp;
    const rolls = r.hits.rolls.map((x) => ({ factor: 1, armour: 0, ...x }));
    const biggestHit = Math.max(...rolls.map((x) => Math.max(1, Math.round(x.max * x.factor))));
    // Auto-eat only uses the food picked for this skill, and only while you have some.
    const picked = gd.player?.foods?.[skill] ?? null;
    const food = picked && (gd.player?.owned?.[picked] ?? 0) > 0 ? picked : null;
    const base = food ? gd.items[food]?.heal ?? 0 : 0;
    const heal = base > 0 ? Math.max(1, Math.trunc(base * Math.max(0.01, 1 + bonus('FlatAutoEatEfficiency')))) : 0;
    let hoursToDeath = Infinity;
    if (heal > 0) {
      // Only a hit bigger than the auto-eat threshold can take you from above it to 0.
      if (biggestHit > autoEatAt) {
        const chain = autoEatChain({ maxHp, threshold: autoEatAt, limit, heal, rolls });
        const perHour = (chain?.deathPerAttack ?? 0) * r.hits.perHour;
        hoursToDeath = perHour > 0 ? 1 / perHour : Infinity;
      }
    } else if (r.hpLossPerHour > 0) {
      hoursToDeath = maxHp / r.hpLossPerHour;
    }
    // The Hitpoints level from which auto-eat comes in time for the biggest hit (null: not before the cap).
    const share = clamp(0.25 + bonus('FlatAutoEatThreshold'), 0, 1);
    let safeLevel = null;
    for (let L = level; L <= (gd.levelCap ?? 99); L++) {
      if (roundEven(share * L * 10) >= biggestHit) {
        safeLevel = L;
        break;
      }
    }
    out = { maxHp, autoEatAt, biggestHit, food, picked, hoursToDeath, risky: hoursToDeath < RISKY_HOURS, safeLevel };
  }
  cache.set(r, out);
  return out;
}
