// Expected per-hour rates for every training method, transcribed from the game's action code.
// computeRates adds your skilling bonuses (shop, toolbelt, pets, Mastery Guild ranks) where they're
// modelled; see MODELLED_BONUS_STATS. Everything else is the action's own numbers.
import { GP } from './gamedata.js';

export const HOUR_MS = 3_600_000;

const avg = (min, max) => ((min ?? 0) + (max ?? min ?? 0)) / 2;

// Expected items from one roll of a drop table. Weighted entries pick one item;
// entries with a chance roll independently.
export function expectTable(entries) {
  const out = [];
  const weighted = entries.filter((e) => e.weight != null);
  const totalWeight = weighted.reduce((s, e) => s + e.weight, 0);
  for (const e of entries) {
    const p = e.weight != null ? (totalWeight > 0 ? e.weight / totalWeight : 0) : (e.chance ?? 1);
    if (p > 0) out.push({ item: e.item, chance: p, qty: p * avg(e.min, e.max) });
  }
  return out;
}

// MiningActionComponent: each hit breaks the rock with chance p, otherwise adds p to a
// progress bar that forces a break once it reaches 0.9999. After a break the bar starts again from
// the minimum prospecting (0 unless a bonus raises it).
export function miningExpectedHits(p, start = 0) {
  if (!(p > 0)) return Infinity;
  const forcedAt = miningForcedHits(p, start);
  let expected = 0;
  for (let k = 1; k < forcedAt; k++) expected += k * p * Math.pow(1 - p, k - 1);
  return expected + forcedAt * Math.pow(1 - p, forcedAt - 1);
}

// The hit that is sure to break the rock.
function miningForcedHits(p, start = 0) {
  let forcedAt = 0;
  for (let progress = start; progress < 0.9999; ) {
    forcedAt++;
    progress += p;
  }
  return Math.max(1, forcedAt);
}

// The slowest an action normally goes without XP, to tell one that's slow from one that's stuck: all
// but 1 time in 10,000.
const SLOW_CHANCE = 1e-4;

// Tries until the k-th success at chance p, all but 1 time in 10,000.
export function slowTries(p, k = 1) {
  if (!(p > 0)) return Infinity;
  if (p >= 1) return k;
  const short = new Array(k).fill(0); // chance of exactly j successes so far, while still short of k
  short[0] = 1;
  let n = 0;
  for (let left = 1; left > SLOW_CHANCE && n < 100_000; n++) {
    for (let j = k - 1; j >= 0; j--) short[j] = short[j] * (1 - p) + (j ? short[j - 1] * p : 0);
    left = short.reduce((s, x) => s + x, 0);
  }
  return n;
}

// ThievingActionStats: stealth = floor((level + flat) * (1 + percent)); success = (100 + stealth) / (100 + perception).
export function thievingSuccessChance(gd, method, level, { flatStealth = 0, percentStealth = 0 } = {}) {
  const c = gd.mechanics.thievingSuccessConstant ?? 100;
  const stealth = Math.max(0, Math.floor((Math.floor(level) + flatStealth) * (1 + percentStealth)));
  return Math.min(1, (c + stealth) / (c + method.perception));
}

export function cookingSuccessChance(gd, method, level) {
  const c = gd.mechanics.cookingSuccessConstant ?? 69;
  return Math.min(1, Math.max(0, (c + level) / (c + method.difficulty)));
}

// WoodcuttingActionComponent: each hit does 1 damage, or 2 with the double damage chance, and while the
// tree has more than 1 health left the instant cut chance fells it in one go. Expected hits per log.
export function woodcuttingHits(health, instant = 0, double = 0) {
  const e = [0, 1];
  for (let h = 2; h <= health; h++) e[h] = 1 + (1 - instant) * (double * e[h - 2] + (1 - double) * e[h - 1]);
  return e[Math.max(1, Math.round(health))] ?? 1;
}

// Expected items from one roll of a thieving drop table: Fortune adds a percentage to the quantity,
// rounded down, and doubling can double it (ThievingActionComponent.TryAddItemFromDropTable).
function thievingLoot(entries, fortune, doubling) {
  const totalWeight = entries.filter((e) => e.weight != null).reduce((s, e) => s + e.weight, 0);
  const out = [];
  for (const e of entries) {
    const p = e.weight != null ? (totalWeight > 0 ? e.weight / totalWeight : 0) : (e.chance ?? 1);
    if (!(p > 0)) continue;
    const lo = e.min ?? 1;
    const hi = Math.max(lo, e.max ?? lo);
    let total = 0;
    for (let n = lo; n <= hi; n++) total += Math.floor(n * (1 + fortune / 100));
    out.push({ item: e.item, qty: p * (total / (hi - lo + 1)) * (1 + doubling) });
  }
  return out;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// A hunting catch: its size and weight each roll between 0.5 and 1.3 times the animal's average, plus
// the journal level / 100, and each product's quantity is scaled by their mean before doubling and
// rounding down (HuntingAnimalJournalEntry.GenerateStatEntry, HuntingActionComponent.OnAnimalTrapped).
function huntingCatch(qty, journal, doubling, rare = 1) {
  const N = 24;
  const lo = 0.5 + journal / 100;
  let total = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const n = rare * Math.max(1, qty * (lo + (0.8 * ((i + 0.5) / N + (j + 0.5) / N)) / 2));
      total += (1 - doubling) * Math.max(1, Math.floor(n)) + doubling * Math.max(1, Math.floor(2 * n));
    }
  }
  return total / (N * N);
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function newAcc() {
  return { outputs: new Map(), inputs: new Map(), currencies: new Map(), chances: new Map(), xp: 0, hpLoss: 0 };
}
const bump = (map, key, n) => n && map.set(key, (map.get(key) ?? 0) + n);

// Fills an accumulator with the expected result of ONE reward cycle and returns its duration.
// What a find gives when it happens: Astrology adds 0 to level × its scaling on top of the base,
// Firemaking scales with the burn time in seconds.
export const eventQuantity = (ev, level, ms) => (ev.perSecond ? Math.max(1, Math.floor(ev.qty * (ms / 1000))) : ev.qty + level * (ev.perLevel ?? 0));

// Finds rolled once per action, while their requirements are met. Astrology's chances and doubling
// take bonuses for each event (AstrologyEventStats); Firemaking's don't.
function rollEvents(gd, method, level, acc, options, ms) {
  for (const ev of method.events ?? []) {
    if (ev.requires.length) {
      const req = gd.checkRequirements({ skill: null, level: 0, requires: ev.requires }, gd.player?.levels ?? {});
      if (!req.ok || req.unknown.length) continue;
    }
    const b = options.eventBonus?.[ev.name] ?? {};
    const chance = clamp01(ev.chance * (1 + (b.pct ?? 0)) + (b.flat ?? 0));
    bump(acc.outputs, ev.item, chance * eventQuantity(ev, level, ms) * (1 + (b.doubling ?? 0)));
    acc.chances.set(ev.item, chance);
  }
}

function cycle(gd, method, level, acc, options = {}) {
  switch (method.kind) {
    case 'woodcutting': {
      const hits = Math.max(1, method.maxHealth);
      bump(acc.outputs, method.product.item, method.product.qty);
      for (const x of method.perHit) bump(acc.outputs, x.item, x.chance * x.qty * hits);
      for (const x of method.perCut) bump(acc.outputs, x.item, x.chance * x.qty);
      acc.xp += method.xp;
      return { ms: hits * method.interval, per: { hit: hits }, note: `${Number.isInteger(hits) ? hits : hits.toFixed(1)} hits per log` };
    }
    case 'mining': {
      const hits = miningExpectedHits(method.breakChance, method.minProspecting ?? 0);
      // When the rock breaks, a shatter triples the ore and doubles the XP, and a pickaxe's bar chance
      // adds the ore's bar (MiningActionComponent.ActionTimerFiredHandler).
      const shatter = method.shatterChance ?? 0;
      bump(acc.outputs, method.product.item, (method.product.qty + (method.extraOreChance ?? 0)) * (1 + 2 * shatter));
      if (method.bar) bump(acc.outputs, method.bar, method.barChance ?? 0);
      for (const x of method.perHit) bump(acc.outputs, x.item, x.chance * x.qty * hits);
      for (const t of gd.usedTools(method)) bump(acc.inputs, t.item, t.usedPer === 'hit' ? hits : 1);
      acc.xp += method.xp * (1 + shatter);
      const slowHits = method.breakChance > 0 ? Math.min(miningForcedHits(method.breakChance, method.minProspecting ?? 0), slowTries(method.breakChance)) : Infinity;
      return { ms: hits * method.interval, slowMs: slowHits * method.interval, per: { hit: hits }, note: `${hits.toFixed(2)} hits per ore` };
    }
    case 'fishing': {
      for (const x of expectTable(method.products)) bump(acc.outputs, x.item, method.fishChance * x.qty);
      // Junk can be turned straight into gold (JunkToGP) instead of landing in the bank.
      if (method.junk && options.junkToGP > 0) bump(acc.currencies, gd.items[method.junk]?.currency ?? GP, (1 - method.fishChance) * (gd.items[method.junk]?.sell ?? 0) * options.junkToGP);
      else if (method.junk) bump(acc.outputs, method.junk, 1 - method.fishChance);
      // The bait you've selected is used up on every catch while you have some.
      const bait = gd.player?.fishingBait;
      if (bait && (gd.player.owned?.[bait] ?? 0) > 0) bump(acc.inputs, bait, 1);
      // Special items are tried rarest first and the first hit stops the roll; a second roll can follow
      // a hit (FishingActionComponent.RollForSpecialItem).
      let none = 1;
      const specials = [...method.special].sort((a, b) => a.chance - b.chance).map((x) => {
        const p = none * x.chance;
        none *= 1 - x.chance;
        return { ...x, p };
      });
      for (const x of specials) bump(acc.outputs, x.item, x.p * x.qty * (1 + (1 - none) * (method.secondSpecialChance ?? 0)));
      acc.xp += method.xp;
      return { ms: avg(method.minInterval, method.maxInterval), slowMs: method.maxInterval, per: { catch: method.fishChance }, note: `${Math.round(method.fishChance * 100)}% fish, rest junk` };
    }
    case 'thieving': {
      const s = thievingSuccessChance(gd, method, level, options);
      const fortune = (options.fortune ?? 0) + (s < 1 ? options.fortuneUnderSuccess ?? 0 : 0);
      const doubling = options.doubling ?? 0;
      bump(acc.currencies, method.currency.currency, s * method.currencyChance * avg(method.currency.min, method.currency.max));
      for (const x of thievingLoot(method.common, fortune, doubling)) bump(acc.outputs, x.item, s * method.commonChance * x.qty);
      for (const x of thievingLoot(method.rare, fortune, doubling)) bump(acc.outputs, x.item, s * method.rareChance * x.qty);
      for (const x of thievingLoot(method.completion, fortune, doubling)) bump(acc.outputs, x.item, (s / method.stages) * x.qty);
      // A success can also pickpocket every other target of the same type in the area you can do,
      // each rolling its own success: their gold and loot, no XP (ThievingActionComponent.AddPickpocketRewards).
      if (options.sameArea > 0) {
        for (const other of gd.methods.filter((x) => x.kind === 'thieving' && x.key !== method.key && x.category === method.category && x.type === method.type && x.level <= level)) {
          const share = s * options.sameArea * thievingSuccessChance(gd, other, level, options);
          bump(acc.currencies, other.currency.currency, share * other.currencyChance * avg(other.currency.min, other.currency.max));
          for (const x of thievingLoot(other.common, fortune, doubling)) bump(acc.outputs, x.item, share * other.commonChance * x.qty);
          for (const x of thievingLoot(other.rare, fortune, doubling)) bump(acc.outputs, x.item, share * other.rareChance * x.qty);
        }
      }
      acc.xp += (s * method.xp) / method.stages;
      // A failure hits for 1 to the target's damage (ThievingActionComponent.DamagePlayer), unless avoided.
      acc.hpLoss += (1 - s) * (1 - (options.damageAvoidance ?? 0)) * (method.damage > 0 ? (method.damage + 1) / 2 : 0);
      for (const t of gd.usedTools(method)) bump(acc.inputs, t.item, 1); // per attempt, success or not
      const stun = Math.floor((gd.mechanics.thievingStunMs ?? 2000) * (1 + (options.percentStunInterval ?? 0)));
      // A heist only gives XP once all its stages are stolen (ThievingRecipe.Stages); every failure stuns.
      const tries = slowTries(s, method.stages);
      const slowMs = tries * method.interval + (tries - method.stages) * (1 - (options.stunAvoidance ?? 0)) * stun;
      // A target counts as done once all its stages are stolen (ThievingActionComplete), which is what
      // Mastery Guild tasks count: one in stages / success chance attempts.
      const hits = method.damage > 0 ? { per: 1, rolls: [{ w: (1 - s) * (1 - (options.damageAvoidance ?? 0)), min: 1, max: method.damage }] } : null;
      return { ms: method.interval + (1 - s) * (1 - (options.stunAvoidance ?? 0)) * stun, slowMs, successChance: s, completes: s / method.stages, hits };
    }
    case 'artisan':
    case 'cooking': {
      // Cooking proficiency (tools, pets) adds to your level in the success formula.
      const s = method.kind === 'cooking' ? cookingSuccessChance(gd, method, level + (options.proficiency ?? 0)) : 1;
      for (const x of method.ingredients) bump(acc.inputs, x.item, x.qty);
      for (const c of method.currencyCosts) bump(acc.currencies, c.currency, -c.qty);
      for (const x of method.products) bump(acc.outputs, x.item, s * x.chance * x.qty);
      acc.xp += s * method.xp;
      return { ms: method.steps * method.interval, slowMs: slowTries(s) * method.steps * method.interval, per: { step: method.steps }, successChance: method.kind === 'cooking' ? s : undefined, completes: s, note: method.steps > 1 ? `${method.steps} steps per craft` : undefined };
    }
    case 'firemaking': {
      for (const x of method.ingredients) bump(acc.inputs, x.item, x.qty);
      for (const x of method.products) bump(acc.outputs, x.item, x.chance * x.qty);
      if (method.reward) bump(acc.currencies, method.reward.currency, method.reward.qty);
      rollEvents(gd, method, level, acc, options, method.interval);
      acc.xp += method.xp;
      return { ms: method.interval };
    }
    case 'astrology': {
      rollEvents(gd, method, level, acc, options, method.interval);
      acc.xp += method.xp;
      return { ms: method.interval };
    }
    case 'hunting': {
      // ActiveHuntingAnimal: surveys until a track is found (the third always finds one), then the
      // tracking steps, then trap attempts; each failed trap adds the minimum steps again. Every
      // attempt uses up a trap unless preservation saves it, and a better trap's success bonus
      // grows with each miss until the catch.
      const trap = options.trapless ? null : huntingTrap(gd, method, options);
      const p = method.trackChance;
      const q0 = Math.min(1, Math.max(0.01, method.trapChance + (trap?.success ?? 0)));
      let attempts = 0;
      let missAll = 1;
      for (let k = 0; k < 200 && missAll > 1e-9; k++) {
        attempts += missAll;
        missAll *= 1 - Math.min(1, q0 + k * (trap?.failBonus ?? 0));
      }
      const surveys = p + 2 * (1 - p) * p + 3 * (1 - p) ** 2;
      const track = avg(method.trackInterval.min, method.trackInterval.max);
      // A skip chance can take two tracking steps at once; after a miss the trap is re-set straight
      // away with the re-attempt chance, otherwise the minimum steps are tracked again.
      const stepsFor = (n) => expectedActions(n, options.skipTrackingStep ?? 0);
      // An animal not yet discovered in your journal tracks 4 times its most steps (ActiveHuntingAnimal).
      const undiscovered = gd.player?.huntingJournal?.[method.id]?.discovered === false;
      let steps = 0;
      if (undiscovered) steps = stepsFor(method.steps.max * 4);
      else for (let n = method.steps.min; n <= method.steps.max; n++) steps += stepsFor(n) / (method.steps.max - method.steps.min + 1);
      const retrack = (1 - (options.trapReattempt ?? 0)) * stepsFor(method.steps.min);
      const ms = method.surveyInterval * surveys + steps * track + avg(method.trapInterval.min, method.trapInterval.max) * attempts + (attempts - 1) * retrack * track;
      // The slowest a normal catch gets: every survey, the most steps, and as many trap attempts as
      // catch it all but 1 time in 10,000.
      let slowAttempts = 0;
      for (let miss = 1; miss > SLOW_CHANCE && slowAttempts < 200; slowAttempts++) miss *= 1 - Math.min(1, q0 + slowAttempts * (trap?.failBonus ?? 0));
      const slowMs = method.surveyInterval * 3 + (undiscovered ? method.steps.max * 4 : method.steps.max) * track + avg(method.trapInterval.min, method.trapInterval.max) * slowAttempts + (slowAttempts - 1) * retrack * track;
      // XP and products scale with the catch's size and weight, which grow with the journal level.
      const journal = options.journalLevel ?? gd.player?.huntingJournal?.[method.id] ?? 1;
      // A rare species doubles every product and adds its own drops (HuntingActionComponent.OnAnimalTrapped).
      const doubling = options.doubling ?? 0;
      const rare = (method.rareSpecies ?? []).length ? method.rareChance ?? 0 : 0;
      for (const x of method.products) bump(acc.outputs, x.item, x.chance * ((1 - rare) * huntingCatch(x.qty, journal, doubling) + rare * huntingCatch(x.qty, journal, doubling, 2)));
      const weights = (method.rareSpecies ?? []).reduce((s, sp) => s + sp.weight, 0);
      for (const sp of method.rareSpecies ?? []) for (const x of sp.extra) bump(acc.outputs, x.item, rare * (sp.weight / weights) * x.chance * x.qty * (1 + doubling));
      if (trap) bump(acc.inputs, trap.item, attempts * (1 - Math.min(1, trap.preservation + (options.huntingPreservation ?? 0))));
      if (options.huntingBait) bump(acc.inputs, options.huntingBait, attempts);
      // Surveys can turn up a find, at most one per catch: each survey rolls until one does.
      const noFind = (method.survey ?? []).reduce((q, x) => q * (1 - x.chance), 1);
      const chanceSum = (method.survey ?? []).reduce((s, x) => s + x.chance, 0);
      const finds = 1 - noFind ** surveys;
      for (const x of method.survey ?? []) bump(acc.outputs, x.item, finds * (x.chance / chanceSum) * x.qty);
      acc.xp += method.xp * (0.9 + journal / 100);
      // The success chance shows on its own, so the note says how you're hunting.
      const note = [trap ? `${attempts.toFixed(1)} traps tried per catch` : options.trapless ? 'trapless' : null, options.huntingBait ? `with ${gd.itemName(options.huntingBait)}` : null, `journal level ${journal}`, undiscovered ? 'not discovered yet, so 4 times the tracking' : null];
      return { ms, slowMs, successChance: q0, note: note.filter(Boolean).join(' · ') };
    }
    case 'agility': {
      // AgilityActionComponent / ActiveAgilityObstacle: obstacles in order; a failure costs HP and
      // restarts the path unless the repeat chance rolls. Each technique whose level meets an obstacle's
      // difficulty adds its bonus there. Without your technique levels, every obstacle counts as met.
      const known = options.techniques ?? gd.player?.techniques ?? null;
      const techniques = gd.raw.agilityTechniques ?? [];
      const n = method.obstacles.length;
      let reached = 1; // chance a run gets this far without restarting
      let clean = 1; // chance of passing every obstacle so far first time (for the marks)
      let time = 0;
      let obstacles = 0;
      let hp = 0;
      let markShare = 0;
      let rewardQty = 0;
      const steps = method.obstacles.map((o) => {
        const met = known ? techniques.filter((t) => (known[t.id] ?? 1) >= o.difficulty) : [];
        const bonus = (stat) => met.flatMap((t) => t.bonuses).filter((b) => b.stat === stat).reduce((s, b) => s + b.value, 0);
        const level = known && o.technique ? known[o.technique] ?? 1 : null;
        const d = level == null ? 0 : Math.max(0, o.difficulty - level + 1);
        const p = o.trap ? Math.min(0.95, 0.8 + bonus('FlatTrapSuccessChance')) : o.technique ? (d > 0 ? 0.95 ** (d / 2) : 1) : 0.6;
        const repeat = Math.min(0.99, bonus('RepeatFailedObstacleChance'));
        const attempts = 1 / (1 - (1 - p) * repeat);
        return { o, p, attempts, pass: p * attempts, fails: (1 - p) * attempts, ms: Math.floor((o.interval + (options.agilityIntervalFlat ?? 0)) * (1 + (options.agilityIntervalPct ?? 0) + bonus('PercentInterval'))), extraQty: bonus('FlatObstacleRewardQuantity') };
      });
      const finish = steps.reduce((q, s) => q * s.pass, 1);
      const rolls = [];
      for (const s of steps) {
        const visits = reached / finish; // arrivals at this obstacle per completed run
        time += s.ms * s.attempts * visits;
        obstacles += s.attempts * visits;
        // AgilityActionComponent.ModifyObstacleDamage: damage-taken bonuses scale each hit (at least 1).
        if (s.o.damage > 0) {
          const landed = s.fails * visits * (1 - (options.agilityAvoidDamage ?? 0));
          hp += landed * Math.max(1, ((s.o.damage + 1) / 2) * (1 + (options.agilityDamageTaken ?? 0)));
          rolls.push({ w: landed, min: 1, max: s.o.damage, factor: Math.max(0, 1 + (options.agilityDamageTaken ?? 0)) });
        }
        reached *= s.pass;
        clean *= s.p;
        markShare += clean / n;
        rewardQty += s.extraQty / n;
      }
      // Marks wait on a random obstacle of the next run and are lost if you fail before it.
      for (const x of method.products) bump(acc.outputs, x.item, x.chance * (x.qty + rewardQty) * markShare);
      for (const x of method.rewards) bump(acc.outputs, x.item, x.qty);
      for (const c of method.rewardCurrencies) bump(acc.currencies, c.currency, c.qty);
      for (const x of method.entryCost) bump(acc.inputs, x.item, x.qty / finish);
      for (const c of method.entryCurrencies) bump(acc.currencies, c.currency, -c.qty / finish);
      acc.xp += method.xp;
      acc.hpLoss += hp;
      const techniqueNote = method.techniqueXp && method.technique ? `+${method.techniqueXp} ${method.technique} XP per run` : '';
      // XP comes at the end of a run, and a failure starts it again. The time lost to failures comes in
      // a random number of tries, so its slow end is about ln(10,000) times its average.
      const cleanMs = steps.reduce((t, s) => t + s.ms, 0);
      const slowMs = cleanMs + Math.log(1 / SLOW_CHANCE) * Math.max(0, time - cleanMs);
      // Hits per obstacle attempted, for whether auto-eat keeps you alive.
      const hits = rolls.length && obstacles > 0 ? { per: obstacles, rolls: rolls.map((x) => ({ ...x, w: x.w / obstacles })) } : null;
      return { ms: time, slowMs, per: { obstacle: obstacles }, successChance: finish, hits, note: [techniqueNote, known ? '' : 'assumes your techniques are high enough'].filter(Boolean).join(' · ') || undefined };
    }
    case 'ranching': {
      // Per animal per hour (ActiveRanchingAnimal): fed and kept safe, with no treats or pack bonus,
      // happiness is 0.96. A child (the first tenth of its life) makes half; some variants make double.
      const happiness = options.happiness ?? 0.96;
      const child = method.lifespanHours > 0 ? Math.min(1, method.childHours / method.lifespanHours) : 0;
      const xpShare = child * 0.5 + (1 - child);
      const productShare = child * 0.5 + (1 - child) * (1 + method.bonusVariantShare);
      for (const x of method.products) bump(acc.outputs, x.item, x.qty * happiness * productShare);
      for (const x of method.eats) bump(acc.inputs, x.item, x.qty);
      // Buying a new one when it dies of old age, spread over its life.
      if (method.lifespanHours > 0) {
        for (const c of method.cost) bump(acc.currencies, c.currency, -c.qty / method.lifespanHours);
        for (const x of method.costItems) bump(acc.inputs, x.item, x.qty / method.lifespanHours);
      }
      acc.xp += method.xp * happiness * xpShare;
      return { ms: method.interval, note: `per animal${method.perEnclosure ? `, up to ${method.perEnclosure} per enclosure` : ''}`, passive: true };
    }
    case 'farming': {
      // ActiveFarmingPlot: one seed gives the first harvest after the growth time, then one more per
      // regrow; flowers never harvest. FarmingActionStats: pests and disease the plot isn't protected
      // against cut every harvest, and watering (assumed) protects against disease.
      for (const x of method.ingredients) bump(acc.inputs, x.item, x.qty);
      if (method.flower) return { ms: method.interval, note: 'no harvest: it protects the plots around it', passive: true };
      // Compost: the best you have, one per planting (ActiveFarmingPlot.Compost), for its yield or XP bonus.
      const compost = options.compost !== undefined ? options.compost : bestCompost(gd);
      const compostBonus = (stat) => (compost ? gd.items[compost].compost.effects.filter((e) => e.stat === stat).reduce((s, e) => s + e.value, 0) : 0);
      if (compost) bump(acc.inputs, compost, 1);
      const harvests = 1 + Math.max(0, (method.regrows ?? 0) + (options.flatRegrows ?? 0));
      const exposed = Math.max(0, (method.pests ?? 0) - (options.pestProtection ?? 0)) + Math.max(0, (method.disease ?? 0) - (method.watering ?? 0) - (options.diseaseProtection ?? 0));
      const qty = Math.max(1, Math.trunc((method.product.qty + (options.flatProductQuantity ?? 0)) * (1 + (options.percentProductQuantity ?? 0) + compostBonus('PercentProductQuantity')) * (1 - exposed / 100)));
      bump(acc.outputs, method.product.item, qty * harvests);
      acc.xp += method.xp * harvests * (1 + compostBonus('PercentXPGained'));
      const notes = [harvests > 1 ? `${harvests} harvests per seed` : '', exposed > 0 ? `${Math.min(100, Math.round(exposed))}% lost to pests and disease` : '', method.watering ? 'watered' : '', compost ? `with ${gd.itemName(compost)}` : ''];
      return { ms: method.interval + (harvests - 1) * (method.regrowInterval ?? 0), per: { harvest: harvests }, note: ['per plot', ...notes].filter(Boolean).join(' · '), passive: true };
    }
    default:
      throw new Error(`Unknown method kind: ${method.kind}`);
  }
}

// The compost a planting gets: the one you own that adds the most yield (XP compost counts for less).
function bestCompost(gd) {
  const owned = gd.player?.owned;
  if (!owned) return null;
  const worth = (id) => gd.items[id].compost.effects.reduce((s, e) => s + (e.stat === 'PercentProductQuantity' ? e.value : e.stat === 'PercentXPGained' ? e.value / 2 : 0), 0);
  const have = Object.keys(owned).filter((id) => owned[id] > 0 && gd.items[id]?.compost);
  return have.length ? have.reduce((a, b) => (worth(b) > worth(a) ? b : a)) : null;
}

// The trap a hunting method uses: options.trap, else the best of its type you own, else the basic one.
function huntingTrap(gd, method, options) {
  const traps = method.traps ?? [];
  if (!traps.length) return null;
  if (options.trap) return traps.find((t) => t.item === options.trap) ?? traps[0];
  const owned = gd.player?.owned;
  const have = owned ? traps.filter((t) => (owned[t.item] ?? 0) > 0) : [];
  if (!have.length) return traps[0];
  return have.reduce((best, t) => (t.success + t.preservation > best.success + best.preservation ? t : best), have[0]);
}

// ---------- bonuses ----------
// Shop upgrades, tools and potions in your toolbelts, and pets add bonuses to actions. Each is
// { stat, value, skill, scope? } (scope narrows it to a recipe or category). These are the ones the
// companion can turn into rates; the rules come from ArtisanActionComponent and the gathering actions.
export const MODELLED_BONUS_STATS = new Set([
  'DoublingChance', 'PreservationChance', 'SkipStepChance', 'PercentXPGained', 'FlatProficiency', 'FlatProductQuantity', 'PercentProductQuantity',
  'FlatInterval', 'PercentInterval',
  'PercentMaxHealth', 'FlatMaxHealth', 'DoubleDamageChance', 'InstantCutChance', 'FlatOnHitItemQuantity',
  'PercentIncreaseRockBreakChance', 'FlatMinimumProspecting', 'AdditionalProductQuantityChance', 'StoneItemChance', 'EssenceItemChance',
  'FlatMinInterval', 'FlatMaxInterval', 'PercentMinInterval', 'PercentMaxInterval', 'FlatFishChance', 'IncreasedFishChance', 'JunkRerollChance',
  'FlatSpecialProductChance', 'FlatSpecialProductQuantity', 'IncreasedSpecialProductChance', 'SecondSpecialItemChance',
  'FlatStealth', 'PercentStealth', 'FlatPerception', 'PercentPerception', 'PercentStunInterval', 'StunAvoidanceChance', 'DamageAvoidanceChance', 'FlatStages',
  'FlatFortune', 'FlatFortuneUnderSuccess', 'FlatCurrencyReward', 'PercentCurrencyReward', 'PercentCommonLootChance', 'PercentRareLootChance', 'PercentCurrencyLootChance',
  'SameAreaPickpocketChance', 'JunkToGP',
  'FlatDifficulty', 'FlatProductChance', 'IncreasedProductChance',
  'PercentPreparingInterval', 'PercentHeatingInterval', 'PercentStirringInterval', 'PercentBottlingInterval',
  'FlatPreparingInterval', 'FlatHeatingInterval', 'FlatStirringInterval', 'FlatBottlingInterval',
  'FlatPestProtection', 'FlatDiseaseProtection', 'FlatRegrows',
  'PercentDamageTaken', 'AvoidDamageChance',
  'FlatTrappingSuccessChance', 'IncreasedTrappingSuccessChance', 'FlatTrackingSuccessChance', 'IncreasedTrackingSuccessChance', 'PercentSurveyInterval', 'FlatSurveyInterval',
  'PercentTrackingInterval', 'PercentMinTrackingInterval', 'PercentMaxTrackingInterval', 'FlatTrackingInterval', 'FlatMinTrackingInterval', 'FlatMaxTrackingInterval',
  'PercentTrappingInterval', 'PercentMinTrappingInterval', 'PercentMaxTrappingInterval', 'FlatTrappingInterval', 'FlatMinTrappingInterval', 'FlatMaxTrappingInterval',
  'FlatTrackingSteps', 'FlatMinTrackingSteps', 'FlatMaxTrackingSteps', 'SkipTrackingStepChance', 'TrappingReattemptChance', 'FlatRareSpeciesChance', 'IncreasedRareSpeciesChance',
  'PercentEventChance', 'FlatEventChance', 'ItemDoublingChance', 'ShatterChance', 'BarItemChance',
]);

// Bonuses that belong to something next to the skill's own action: the Grain Mill, toolbelt items,
// fishing bait, bonfires, the bank. Their stats share names with action stats (PreservationChance).
const NOT_ACTION_STATS = new Set(['GrainMill', 'GrainMillInventory', 'Toolbelt', 'FishingBait', 'FiremakingBonfire', 'BankInventory', 'ItemBurying']);

export function bonusApplies(effect, method) {
  if (effect.skill !== method.skill || !MODELLED_BONUS_STATS.has(effect.stat) || NOT_ACTION_STATS.has(effect.stats)) return false;
  for (const [key, value] of Object.entries(effect.scope ?? {})) {
    // Fishing spots keep their location in `category`. An item scope (extra bird nests per hit) is
    // matched against the method's items when the rates are worked out.
    if (key === 'Item' && effect.stat === 'FlatOnHitItemQuantity') continue;
    // An event scope (Starfall chance) is matched to each event when its finds are worked out.
    if (key === 'Event') continue;
    if (key === 'Category' || key === 'Location' ? value !== method.category : key === 'Subcategory' ? value !== method.subcategory : key === 'Recipe' ? value !== method.id : true) return false;
  }
  return true;
}

// Expected actions to finish something with `health` steps when each action has `chance` to remove
// an extra one (only while more than one is left): skip-step crafting, double-damage woodcutting.
export function expectedActions(health, chance) {
  const e = [0, 1];
  for (let n = 2; n <= health; n++) e[n] = 1 + chance * e[n - 2] + (1 - chance) * e[n - 1];
  return e[Math.max(1, Math.round(health))] ?? 1;
}

const primaryProducts = (method) => new Set([method.product?.item, ...(method.products ?? []).map((p) => p.item)].filter(Boolean));

/**
 * Expected hourly rates for a method at a given level of its skill, with the player's bonuses
 * (gd.playerBonuses, set from the save) unless options.bonuses says otherwise ([] for base rates).
 * Damage taken (thieving) is paid for with food: options.food, else the food selected in that skill's slot in
 * the save, else gd.preferredFood, else the cheapest food per HP.
 */
// Toolbelt items used up as you work (potions, Blackstone): one each time what uses them happens, per
// hit, catch, craft step and so on (ToolbeltCapability.ConsumesOn), less any toolbelt preservation for
// that item (the Burning Embers Gloves keep Blackstone). Tools a method needs are counted with it.
const TOOL_USED_PER = { WoodcuttingDamageTree: 'hit', MiningMineRock: 'hit', FishingFishRecipe: 'catch', ArtisanPerformStep: 'step', AgilityObstacleAttempted: 'obstacle', FarmingRecipeGrown: 'harvest', FarmingRecipeHarvested: 'harvest' };
const NOT_SKILLING = new Set(['CharacterTurnEnded', 'CharacterAttacked', 'CharacterFightStarted', 'EnemySpawned', 'EnemyKilled', 'CompleteDungeon', 'FoodEaten', 'RanchingAnimalFed']);
function toolUse(gd, method, c, acc, effects) {
  const out = [];
  const required = new Set(gd.usedTools(method).map((t) => t.item));
  const s = c.successChance ?? 1;
  // How many times per action one use applies to this method, within its limits.
  const times = (u) => {
    if (NOT_SKILLING.has(u.type) || u.conditions) return 0;
    if ((u.recipe && u.recipe !== method.id) || (u.category && u.category !== method.category) || (u.subcategory && u.subcategory !== method.subcategory) || (u.recipeType && u.recipeType !== method.type)) return 0;
    if (u.minSteps && (method.steps ?? 1) < u.minSteps) return 0;
    if (u.currency && !((acc.currencies.get(u.currency) ?? 0) > 0)) return 0;
    return (c.per?.[TOOL_USED_PER[u.type] ?? 'action'] ?? 1) * (u.success ? s : u.fail ? 1 - s : 1) * (u.chance ?? 1);
  };
  for (const t of gd.player?.toolbelts?.[method.skill] ?? []) {
    const tool = gd.items[t.item]?.tool;
    if (!tool?.usedUp || !Array.isArray(tool.usedOn) || required.has(t.item) || !(t.qty > 0)) continue;
    const n = tool.usedOn.reduce((sum, u) => sum + times(u), 0);
    if (!(n > 0)) continue;
    const keep = effects.filter((e) => e.stats === 'Toolbelt' && e.stat === 'PreservationChance' && e.skill === method.skill && (!e.scope?.Item || e.scope.Item === gd.itemName(t.item))).reduce((sum, e) => sum + e.value, 0);
    out.push({ item: t.item, n: n * (1 - clamp01(keep)) });
  }
  return out;
}

// How you'd hunt an animal with what you have: its bait while you have some, and trapless when it's
// allowed and either switched on in the game or you have no trap for it. Their bonuses count like any other.
function huntingChoices(gd, method) {
  const owned = gd.player?.owned;
  if (method.kind !== 'hunting' || !owned) return null;
  const bait = method.bait && owned[method.bait.item] > 0 ? method.bait : null;
  const hasTrap = (method.traps ?? []).some((t) => owned[t.item] > 0);
  const allowed = method.trapless && gd.player.levels && gd.checkRequirements({ skill: null, level: 0, requires: method.trapless.requires }, gd.player.levels).ok;
  const trapless = allowed && (!hasTrap || gd.player.huntingAnimals?.[method.id]?.trapless) ? method.trapless : null;
  return { bait: bait?.item ?? null, trapless: !!trapless, effects: [...(bait?.effects ?? []), ...(trapless?.effects ?? [])] };
}

/**
 * What to set on an animal's page in the game for the companion's numbers to hold, from the save's
 * settings for it (ActiveHuntingAnimal): "Enable Trapless Hunting" when they count on hunting without a
 * trap, "Use Bait?" when they count on its bait (the game only uses bait with it ticked), and otherwise a
 * trap you have some of (with none selected the game won't hunt). Anything the save shows is already set
 * is left out; with no save settings, all of it is listed.
 * @returns [{ kind: 'trapless' } | { kind: 'bait', item } | { kind: 'trap', item }]
 */
export function huntingTodo(gd, method) {
  const c = huntingChoices(gd, method);
  if (!c) return [];
  const saved = gd.player.huntingAnimals?.[method.id] ?? null;
  const out = [];
  if (c.trapless && !saved?.trapless) out.push({ kind: 'trapless' });
  if (c.bait && !saved?.useBait) out.push({ kind: 'bait', item: c.bait });
  if (!c.trapless) {
    const trap = huntingTrap(gd, method, {});
    const have = (item) => (gd.player.owned[item] ?? 0) > 0;
    if (trap && have(trap.item) && !(saved?.trap && have(saved.trap))) out.push({ kind: 'trap', item: trap.item });
  }
  return out;
}

export function computeRates(gd, method, level = method.level, options = {}) {
  const choices = options.bonuses ? null : huntingChoices(gd, method);
  if (choices) options = { ...options, huntingBait: choices.bait, trapless: choices.trapless };
  const effects = [...(options.bonuses ?? gd.playerBonuses ?? []), ...(choices?.effects ?? [])].filter((e) => bonusApplies(e, method));
  if (!effects.length) return baseRates(gd, method, level, options);
  const sum = (stat) => effects.filter((e) => e.stat === stat).reduce((s, e) => s + e.value, 0);
  const whole = Math.trunc;
  const extra = {};
  let m = method;

  // Action time. Crafting and cooking add the flat change after the percentage, every other skill
  // before it (each skill's *ActionStats.GetInterval), rounded down.
  const fi = sum('FlatInterval');
  const pi = sum('PercentInterval');
  if ((fi || pi) && m.interval && !m.batch && m.kind !== 'agility') {
    const time = (t) => Math.max(1, Math.floor(m.kind === 'artisan' || m.kind === 'cooking' ? t * (1 + pi) + fi : (t + fi) * (1 + pi)));
    m = { ...m, interval: time(m.interval), ...(m.regrowInterval ? { regrowInterval: time(m.regrowInterval) } : {}) };
  }
  if (m.kind === 'agility') Object.assign(extra, { agilityIntervalFlat: fi, agilityIntervalPct: pi, agilityDamageTaken: sum('PercentDamageTaken'), agilityAvoidDamage: sum('AvoidDamageChance') });

  switch (m.kind) {
    case 'woodcutting': {
      // WoodcuttingActionStats: health = ceil((base + flat) × (1 + percent)).
      const health = Math.max(1, Math.ceil((m.maxHealth + sum('FlatMaxHealth')) * (1 + sum('PercentMaxHealth'))));
      const onHit = (item) => effects.filter((e) => e.stat === 'FlatOnHitItemQuantity' && (!e.scope?.Item || e.scope.Item === gd.itemName(item))).reduce((s, e) => s + e.value, 0);
      m = { ...m, maxHealth: woodcuttingHits(health, sum('InstantCutChance'), sum('DoubleDamageChance')), product: { ...m.product, qty: m.product.qty + whole(sum('FlatProductQuantity')) }, perHit: m.perHit.map((x) => ({ ...x, qty: x.qty + onHit(x.item) })) };
      break;
    }
    case 'mining': {
      // MiningActionComponent: stone and essence can drop on every hit, and a break can give one more ore.
      const drops = (items, chance) => (chance > 0 ? items.map((item) => ({ item, chance, qty: 1 })) : []);
      const cfg = gd.raw.mining ?? {};
      m = {
        ...m,
        breakChance: Math.min(1, m.breakChance * (1 + sum('PercentIncreaseRockBreakChance'))),
        minProspecting: sum('FlatMinimumProspecting'),
        extraOreChance: sum('AdditionalProductQuantityChance'),
        shatterChance: clamp01(sum('ShatterChance')),
        barChance: clamp01(sum('BarItemChance')),
        product: { ...m.product, qty: m.product.qty + whole(sum('FlatProductQuantity')) },
        perHit: [...m.perHit, ...drops(cfg.stones ?? [], sum('StoneItemChance')), ...drops(cfg.essences ?? [], sum('EssenceItemChance'))],
      };
      break;
    }
    case 'fishing': {
      // FishingActionStats: the min and max catch time each take their own bonuses; a junk catch can
      // be rerolled into a fish.
      const time = (t, f, p) => Math.floor((t + f) * (1 + p));
      const min = time(m.minInterval, sum('FlatMinInterval'), sum('PercentMinInterval'));
      const max = Math.max(min, time(m.maxInterval, sum('FlatMaxInterval'), sum('PercentMaxInterval')));
      const fish = clamp01((m.fishChance + sum('FlatFishChance')) * (1 + sum('IncreasedFishChance')));
      m = {
        ...m,
        minInterval: min,
        maxInterval: max,
        fishChance: fish + (1 - fish) * sum('JunkRerollChance'),
        special: m.special.map((x) => ({ ...x, chance: clamp01(x.chance + sum('FlatSpecialProductChance') + x.chance * sum('IncreasedSpecialProductChance')), qty: x.qty + whole(sum('FlatSpecialProductQuantity')) })),
        secondSpecialChance: sum('SecondSpecialItemChance'),
      };
      extra.junkToGP = sum('JunkToGP');
      break;
    }
    case 'thieving': {
      // ThievingActionStats: perception, stages, gold and loot chances all take bonuses.
      const reward = (q) => Math.max(0, Math.floor((q + sum('FlatCurrencyReward')) * (1 + sum('PercentCurrencyReward'))));
      m = {
        ...m,
        perception: Math.max(0, Math.floor((m.perception + sum('FlatPerception')) * (1 + sum('PercentPerception')))),
        stages: Math.max(1, m.stages + whole(sum('FlatStages'))),
        currency: { ...m.currency, min: reward(m.currency.min), max: reward(m.currency.max) },
        commonChance: clamp01(m.commonChance * (1 + sum('PercentCommonLootChance'))),
        rareChance: clamp01(m.rareChance * (1 + sum('PercentRareLootChance'))),
        currencyChance: clamp01(m.currencyChance * (1 + sum('PercentCurrencyLootChance'))),
      };
      Object.assign(extra, { flatStealth: sum('FlatStealth'), percentStealth: sum('PercentStealth'), percentStunInterval: sum('PercentStunInterval'), stunAvoidance: sum('StunAvoidanceChance'), damageAvoidance: sum('DamageAvoidanceChance'), sameArea: sum('SameAreaPickpocketChance'), fortune: sum('FlatFortune'), fortuneUnderSuccess: sum('FlatFortuneUnderSuccess'), doubling: sum('DoublingChance') });
      break;
    }
    case 'artisan':
    case 'cooking': {
      // Products: (quantity + flat) × (1 + percent), rounded down, at least 1.
      const fq = sum('FlatProductQuantity');
      const pq = sum('PercentProductQuantity');
      if (fq || pq) m = { ...m, products: m.products.map((p) => ({ ...p, qty: Math.max(1, Math.trunc((p.qty + fq) * (1 + pq))) })) };
      if (m.kind === 'cooking') m = { ...m, difficulty: Math.max(0, m.difficulty + sum('FlatDifficulty')) };
      if (m.kind === 'artisan' && sum('SkipStepChance')) m = { ...m, steps: expectedActions(m.steps, sum('SkipStepChance')) };
      // Herblore: each stage of the batch has its own interval bonuses (HerbloreActionStats).
      if (m.batch) {
        const stage = (name) => Math.floor(m.batch[name] * (1 + sum(`Percent${capital(name)}Interval`)) + sum(`Flat${capital(name)}Interval`));
        m = { ...m, interval: (stage('preparing') + stage('heating') + stage('stirring') + m.batch.bottlings * stage('bottling')) / m.batch.bottlings };
      }
      extra.proficiency = sum('FlatProficiency');
      break;
    }
    case 'astrology': {
      const of = (ev, stat) => effects.filter((e) => e.stat === stat && (!e.scope?.Event || e.scope.Event === ev.name)).reduce((s, e) => s + e.value, 0);
      extra.eventBonus = Object.fromEntries((m.events ?? []).map((ev) => [ev.name, { pct: of(ev, 'PercentEventChance'), flat: of(ev, 'FlatEventChance'), doubling: of(ev, 'ItemDoublingChance') }]));
      break;
    }
    case 'firemaking': {
      const reward = m.reward ? { ...m.reward, qty: Math.max(0, Math.floor((m.reward.qty + sum('FlatCurrencyReward')) * (1 + sum('PercentCurrencyReward')))) } : null;
      m = { ...m, reward, products: m.products.map((p) => ({ ...p, chance: clamp01(p.chance + sum('FlatProductChance') + p.chance * sum('IncreasedProductChance')), qty: p.qty + whole(sum('FlatProductQuantity')) })) };
      break;
    }
    case 'farming':
      Object.assign(extra, { pestProtection: sum('FlatPestProtection'), diseaseProtection: sum('FlatDiseaseProtection'), flatRegrows: sum('FlatRegrows'), flatProductQuantity: sum('FlatProductQuantity'), percentProductQuantity: sum('PercentProductQuantity') });
      break;
    case 'hunting': {
      // HuntingActionStats: tracking and trapping times each take general, min and max bonuses.
      const range = (r, name) => {
        const time = (t, end) => Math.floor((t + sum(`Flat${end}${name}Interval`) + sum(`Flat${name}Interval`)) * (1 + sum(`Percent${end}${name}Interval`) + sum(`Percent${name}Interval`)));
        const min = time(r.min, 'Min');
        return { min, max: Math.max(min, time(r.max, 'Max')) };
      };
      const stepMin = Math.floor(m.steps.min + sum('FlatMinTrackingSteps') + sum('FlatTrackingSteps'));
      const qtyOf = (q) => Math.max(1, Math.trunc((q + sum('FlatProductQuantity')) * (1 + sum('PercentProductQuantity'))));
      m = {
        ...m,
        trackInterval: range(m.trackInterval, 'Tracking'),
        trapInterval: range(m.trapInterval, 'Trapping'),
        steps: { min: Math.max(1, stepMin), max: Math.max(1, stepMin, Math.floor(m.steps.max + sum('FlatMaxTrackingSteps') + sum('FlatTrackingSteps'))) },
        trackChance: clamp01(m.trackChance + sum('FlatTrackingSuccessChance') + m.trackChance * sum('IncreasedTrackingSuccessChance')),
        trapChance: clamp01(m.trapChance + sum('FlatTrappingSuccessChance') + m.trapChance * sum('IncreasedTrappingSuccessChance')),
        surveyInterval: Math.max(1, Math.floor((m.surveyInterval + sum('FlatSurveyInterval')) * (1 + sum('PercentSurveyInterval')))),
        products: m.products.map((x) => ({ ...x, qty: qtyOf(x.qty) })),
        rareChance: clamp01((m.rareChance ?? 0) + sum('FlatRareSpeciesChance') + (m.rareChance ?? 0) * sum('IncreasedRareSpeciesChance')),
      };
      Object.assign(extra, { huntingPreservation: sum('PreservationChance'), skipTrackingStep: sum('SkipTrackingStepChance'), trapReattempt: sum('TrappingReattemptChance'), doubling: sum('DoublingChance') });
      break;
    }
  }
  const r = baseRates(gd, m, level, { ...options, ...extra });
  // Doubling: gathering doubles everything it gives, firemaking its drops and its gold, crafting and
  // farming the product. Thieving and hunting roll it per drop (thievingLoot, huntingCatch).
  const doubling = m.kind === 'thieving' || m.kind === 'hunting' ? 0 : sum('DoublingChance');
  const keep = ['artisan', 'cooking', 'firemaking', 'farming'].includes(m.kind) ? sum('PreservationChance') : 0;
  const xp = sum('PercentXPGained');
  // `method` stays the method you passed, not the adjusted copy, so rates can be worked out from it again.
  if (!doubling && !keep && !xp) return { ...r, method, bonuses: effects };
  const everything = ['woodcutting', 'mining', 'fishing', 'firemaking'].includes(m.kind);
  const primary = primaryProducts(method);
  // Finds aren't doubled (RollEvent adds them straight to the bank).
  const found = new Set((method.events ?? []).map((e) => e.item));
  const outputs = r.outputs.map((o) => ((everything && !found.has(o.item)) || primary.has(o.item) ? { ...o, perHour: o.perHour * (1 + doubling), value: o.value * (1 + doubling) } : o));
  const inputs = r.inputs.map((i) => ({ ...i, perHour: i.perHour * (1 - keep), value: i.value * (1 - keep) }));
  const currencies = m.kind === 'firemaking' && doubling ? Object.fromEntries(Object.entries(r.currencies).map(([c, n]) => [c, n > 0 ? n * (1 + doubling) : n])) : r.currencies;
  const gpCurrency = currencies[GP] ?? 0;
  const grossPerHour = outputs.reduce((s, o) => s + o.value, 0) + Math.max(0, gpCurrency);
  const costPerHour = inputs.reduce((s, i) => s + i.value, 0) + Math.max(0, -gpCurrency) * (1 - keep) + (r.food?.value ?? 0) + r.toolUse.reduce((s, t) => s + t.value, 0);
  return { ...r, method, outputs, inputs, currencies, xpPerHour: r.xpPerHour * (1 + xp), grossPerHour, costPerHour, profitPerHour: grossPerHour - costPerHour, bonuses: effects };
}

// Rates from the action's own numbers, no bonuses.
function baseRates(gd, method, level, options) {
  const acc = newAcc();
  const c = cycle(gd, method, Math.max(level, method.level), acc, options);
  const perHour = HOUR_MS / c.ms;
  const toList = (map) => [...map].map(([item, n]) => ({ item, perHour: n * perHour, value: n * perHour * gd.itemValue(item) }));
  const outputs = toList(acc.outputs).sort((a, b) => b.value - a.value);
  const inputs = toList(acc.inputs);
  const currencies = Object.fromEntries([...acc.currencies].map(([cur, n]) => [cur, n * perHour]));
  const gpCurrency = currencies[GP] ?? 0;
  const outputValue = outputs.reduce((s, o) => s + o.value, 0) + Math.max(0, gpCurrency);
  const hpLossPerHour = acc.hpLoss * perHour;
  // The food selected for this skill in the game, else your pick in the companion, else the cheapest per HP.
  const foodItem = options.food ?? gd.player?.foods?.[method.skill] ?? gd.preferredFood ?? gd.defaultFood;
  const heal = gd.items[foodItem]?.heal ?? 0;
  const foodPerHour = hpLossPerHour > 0 && heal > 0 ? hpLossPerHour / heal : 0;
  const food = hpLossPerHour > 0 ? { item: foodItem, perHour: foodPerHour, value: foodPerHour * gd.itemValue(foodItem) } : null;
  // With your own setup (not base rates), what your toolbelt uses up costs too.
  const tools = options.bonuses ? [] : toolUse(gd, method, c, acc, gd.playerBonuses ?? []).map((t) => ({ item: t.item, perHour: t.n * perHour, value: t.n * perHour * gd.itemValue(t.item) }));
  const inputValue = inputs.reduce((s, i) => s + i.value, 0) + Math.max(0, -gpCurrency) + (food?.value ?? 0) + tools.reduce((s, t) => s + t.value, 0);
  return {
    key: method.key,
    method,
    // The method with the bonuses in it (loot and catch chances, stages): `method` goes back to the one
    // you passed once computeRates is done with it.
    adjusted: method,
    level: Math.max(level, method.level),
    msPerCycle: c.ms,
    // The longest it normally goes between XP gains (all but 1 time in 10,000), for the "No XP" warning.
    slowMsPerXp: c.passive ? null : c.slowMs ?? c.ms,
    cyclesPerHour: perHour,
    // Finished actions an hour: a cook that isn't burnt, a pickpocket or heist with every stage stolen.
    completionsPerHour: (c.completes ?? 1) * perHour,
    // What can hurt you, per hour: { perHour (chances to be hit), rolls: [{ w, min, max, factor }] } (idleDanger).
    hits: c.hits ? { perHour: c.hits.per * perHour, rolls: c.hits.rolls } : null,
    xpPerHour: acc.xp * perHour,
    outputs,
    inputs,
    currencies,
    grossPerHour: outputValue,
    costPerHour: inputValue,
    profitPerHour: outputValue - inputValue,
    successChance: c.successChance,
    hpLossPerHour,
    food,
    passive: !!c.passive,
    note: c.note,
    toolUse: tools,
    // The chance per action of each find, for how long a first one takes.
    ...(acc.chances.size ? { chancePerCycle: Object.fromEntries(acc.chances) } : {}),
  };
}

// How long current bank stock keeps a method running, in hours (Infinity when it needs nothing).
export function sustainHours(rates, bank) {
  if (!rates.inputs.length) return Infinity;
  let hours = Infinity;
  for (const i of rates.inputs) hours = Math.min(hours, (bank?.[i.item] ?? 0) / i.perHour);
  return hours;
}
