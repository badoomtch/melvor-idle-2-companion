// Recommendations built on top of the rate calculators. Isomorphic.
import { GP } from './gamedata.js';
import { idleDanger } from './idle-danger.js';
import { computeRates, sustainHours } from './rates.js';
import { rareOdds } from './rare-items.js';

const needsMaterials = (rates) => rates.inputs.length > 0 || (rates.currencies[GP] ?? 0) < 0;
// Levels are met and nothing else (an equipped tool, a quest) is needed that the save can't confirm.
const usable = (req) => req.ok && req.unknown.length === 0;

// Every method for a skill, with rates at the player's level and whether it is usable now.
export function rankSkill(gd, skill, levels, { by = 'xp' } = {}) {
  const level = gd.levelOf(levels, skill);
  const all = (gd.methodsBySkill[skill] ?? []).map((method) => ({
    method,
    rates: computeRates(gd, method, level),
    ...gd.checkRequirements(method, levels),
  }));
  const metric = by === 'profit' ? (x) => x.rates.profitPerHour : (x) => x.rates.xpPerHour;
  const available = all.filter((x) => x.ok).sort((a, b) => metric(b) - metric(a));
  const upcoming = all.filter((x) => !x.ok && x.missing.every((r) => r.type === 'level')).sort((a, b) => a.method.level - b.method.level);
  return { skill, level, all, available, best: available.find((x) => x.unknown.length === 0) ?? null, upcoming };
}

export function bestMoney(gd, levels, { bank = null, limit = 12 } = {}) {
  const rows = [];
  for (const skill of gd.trainableSkills) {
    const level = gd.levelOf(levels, skill);
    for (const method of gd.methodsBySkill[skill]) {
      const req = gd.checkRequirements(method, levels);
      // Only missing a tool you don't own: still worth showing under "If you have the right gear".
      const needsTool = !req.ok && req.missing.every((r) => r.type === 'tool');
      if (!req.ok && !needsTool) continue;
      const rates = computeRates(gd, method, level);
      const blockers = [...req.unknown, ...(needsTool ? req.missing : [])];
      rows.push({ rates, unknown: blockers, equip: req.equip, conditional: blockers.length > 0, sustain: bank ? sustainHours(rates, bank) : null });
    }
  }
  const byProfit = (a, b) => b.rates.profitPerHour - a.rates.profitPerHour;
  const active = rows.filter((r) => !r.rates.passive && !r.conditional);
  return {
    conditional: rows.filter((r) => r.conditional && r.rates.profitPerHour > 0).sort(byProfit).slice(0, limit),
    selfSufficient: active.filter((r) => !needsMaterials(r.rates)).sort(byProfit).slice(0, limit),
    crafting: active.filter((r) => needsMaterials(r.rates) && r.rates.profitPerHour > 0).sort(byProfit).slice(0, limit),
    fromBank: bank ? active.filter((r) => needsMaterials(r.rates) && r.sustain >= 0.25 && r.rates.profitPerHour > 0).sort(byProfit).slice(0, limit) : null,
    passive: rows.filter((r) => r.rates.passive && !r.conditional).sort(byProfit).slice(0, limit),
  };
}

// Best XP/hour method usable at a given level of one skill; with `supplied(item, perHour)`, only methods
// whose every material passes it (you can gather or make it, or have plenty).
export function bestXpMethodAt(gd, skill, levels, level, supplied = null) {
  const lv = { ...levels, [skill]: level };
  let best = null;
  for (const method of gd.methodsBySkill[skill] ?? []) {
    if (!usable(gd.checkRequirements(method, lv))) continue;
    const rates = ratesAt(gd, method, level);
    if (supplied && !rates.inputs.every((i) => supplied(i.item, i.perHour))) continue;
    if (rates.xpPerHour > 0 && (!best || rates.xpPerHour > best.xpPerHour)) best = rates;
  }
  return best;
}

export function bestSelfSufficientProfitAt(gd, skill, levels, level) {
  const lv = { ...levels, [skill]: level };
  let best = null;
  for (const method of gd.methodsBySkill[skill] ?? []) {
    if (!usable(gd.checkRequirements(method, lv))) continue;
    const rates = ratesAt(gd, method, level);
    if (rates.passive || needsMaterials(rates)) continue;
    if (!best || rates.profitPerHour > best.profitPerHour) best = rates;
  }
  return best;
}

const CRAFTING_KINDS = new Set(['artisan', 'cooking', 'firemaking']);

// Each change of what you're doing costs a little in a plan, so it doesn't hop to another method (or off
// to gather something) for a fraction of a level when carrying on is nearly as quick.
export const SWITCH_HOURS = 5 / 60;

// Methods an earlier plan chose (`prefer`) count as this much quicker, so a plan only changes its mind
// when something else is clearly better, not on every small change in your bank.
export const KEEP = 0.85;

// Gathering makes this much more than the average a plan needs, so ordinary bad luck (fewer doubles, more
// burnt) doesn't leave you a few short and send you back for a handful more.
export const MARGIN = 0.05;
const keep = (prefer, key) => (prefer?.has(key) ? KEEP : 1);

// The least of an input one action needs: a recipe's full amount (two crossbow heads, not the 1.4 that
// preservation averages out to), else one.
export const minEach = (method, item) => method.ingredients?.find((i) => i.item === item)?.qty ?? 1;

// Whole actions to make `qty` of something at `perHour`, and how long they take.
export function wholeActions(rates, perHour, qty) {
  const actions = Math.max(1, Math.ceil(qty / (perHour / rates.cyclesPerHour) - 1e-9));
  return { actions, hours: actions / rates.cyclesPerHour };
}

// How much of an input `actions` actions use: the average, but never less than one action's worth.
export const inputFor = (rates, input, actions) => Math.max((input.perHour / rates.cyclesPerHour) * actions, minEach(rates.method, input.item));

// Everything you can gather or make right now, indexed by the item it produces.
export function producerIndex(gd, levels) {
  const index = new Map();
  for (const method of gd.methods) {
    if (method.kind === 'farming' || !usable(gd.checkRequirements(method, levels))) continue;
    const rates = paced(gd, computeRates(gd, method, gd.levelOf(levels, method.skill)));
    for (const o of rates.outputs) {
      if (!(o.perHour > 0) || rates.inputs.some((i) => i.item === o.item)) continue;
      if (!index.has(o.item)) index.set(o.item, []);
      index.get(o.item).push({ rates, perHour: o.perHour });
    }
  }
  return index;
}

// How many steps deep a material chain can go. Hunting's are long: Rabbit Fur needs Snares, which need
// Rope, which needs String, which needs Flax. Too short and the bottom of a chain can only come from
// something that needs nothing (pickpocketing String from a Craftsman, hundreds of attempts for what
// a few crafts make).
export const MATERIAL_DEPTH = 6;

// The quickest way to have `qty` of an item: bank stock first, then gathering or making the rest in
// whole actions (up to `depth` steps deep, e.g. mine ore -> smelt bars -> smith). Reads the stock; doesn't
// change it. `needs` lists what has to be gathered or made before `method` can run, deepest first, each
// with its own { actions, hours }; `actions` and `runHours` are this item's own step.
export function obtain(index, stock, item, qty, depth = MATERIAL_DEPTH, prefer = null) {
  const fromStock = Math.min(Math.max(0, stock.get(item) ?? 0), qty);
  const short = qty - fromStock;
  const uses = fromStock > 0 ? [{ item, qty: fromStock }] : [];
  if (short <= 1e-9) return { item, short: 0, hours: 0, method: null, uses, needs: [] };
  let best = null;
  for (const p of index.get(item) ?? []) {
    if (p.rates.inputs.length && depth <= 1) continue;
    // Spare only in whole items: one piece of gear is one, not two.
    const run = wholeActions(p.rates, p.perHour, short + Math.floor(qty * MARGIN));
    let hours = run.hours;
    const subUses = [];
    const needs = [];
    const subs = obtainEach(index, stock, p.rates.inputs.map((i) => ({ item: i.item, qty: inputFor(p.rates, i, run.actions) })), depth - 1, prefer);
    for (const sub of subs) {
      hours += sub.hours;
      subUses.push(...sub.uses);
      if (sub.short > 0) needs.push(...sub.needs, { item: sub.item, qty: sub.short, method: sub.method, makes: sub.makes, actions: sub.actions, hours: sub.runHours });
    }
    // Crafting skills "make" things; gathering ones "get" them even when they use something up (Hunting's traps).
    const score = hours * keep(prefer, p.rates.method.key);
    if (!best || score < best.score) best = { score, hours, run, made: (run.actions * p.perHour) / p.rates.cyclesPerHour, method: p.rates.method, makes: p.rates.inputs.length > 0 && CRAFTING_KINDS.has(p.rates.method.kind), uses: subUses, needs };
  }
  if (!best) return { item, short, hours: Infinity, method: null, uses, needs: [] };
  return { item, short, hours: best.hours, method: best.method, makes: best.makes, actions: best.run.actions, runHours: best.run.hours, made: best.made, uses: [...uses, ...best.uses], needs: best.needs };
}

// What's left of `stock` (anything with get()) once `taken` is spoken for.
const remaining = (stock, taken) => ({ get: (k) => Math.max(0, (stock.get(k) ?? 0) - (taken.get(k) ?? 0)) });

// obtain() for each of a recipe's materials in turn ([{ item, qty }]), each from what the ones before it
// left in the bank: Thornback Camo Legs use String, and so do the Nets their spikes are hunted with, so
// the two can't both count on the same String.
export function obtainEach(index, stock, wants, depth = MATERIAL_DEPTH, prefer = null) {
  const taken = new Map();
  return wants.map(({ item, qty }) => {
    const got = obtain(index, taken.size ? remaining(stock, taken) : stock, item, qty, depth, prefer);
    for (const u of got.uses) taken.set(u.item, (taken.get(u.item) ?? 0) + u.qty);
    return got;
  });
}

// Rates for planning, worked out once per method, and per level only for methods that change with level
// (success chances, hits per ore). Starts again whenever your bonuses, tools or food change.
// Your own speed at a method, for plans: `gd.planSpeed` is { methodKey: measured ÷ estimated } (from
// speedFactors() in accuracy.js), set by whoever makes the plan; everything per hour scales with it.
export function paced(gd, rates) {
  const f = gd.planSpeed?.[rates.method.key];
  if (!f || f === 1) return rates;
  const scale = (list) => list.map((x) => ({ ...x, perHour: x.perHour * f, value: x.value * f }));
  return { ...rates, cyclesPerHour: rates.cyclesPerHour * f, xpPerHour: rates.xpPerHour * f, inputs: scale(rates.inputs), outputs: scale(rates.outputs),
    grossPerHour: rates.grossPerHour * f, costPerHour: rates.costPerHour * f, profitPerHour: rates.profitPerHour * f, paced: f };
}

const rateCache = new WeakMap();
const sameRates = (a, b) => a.xpPerHour === b.xpPerHour && a.cyclesPerHour === b.cyclesPerHour
  && [[a.inputs, b.inputs], [a.outputs, b.outputs]].every(([x, y]) => x.length === y.length && x.every((r, i) => r.item === y[i].item && r.perHour === y[i].perHour));
function ratesAt(gd, method, level) {
  let c = rateCache.get(gd);
  if (!c || c.bonuses !== gd.playerBonuses || c.player !== gd.player || c.food !== gd.preferredFood || c.speed !== gd.planSpeed) {
    c = { bonuses: gd.playerBonuses, player: gd.player, food: gd.preferredFood, speed: gd.planSpeed, methods: new Map() };
    rateCache.set(gd, c);
  }
  let m = c.methods.get(method.key);
  if (!m) {
    const low = paced(gd, computeRates(gd, method, method.level));
    m = { low, flat: sameRates(low, paced(gd, computeRates(gd, method, gd.levelCap))), at: new Map() };
    c.methods.set(method.key, m);
  }
  if (m.flat || level <= method.level) return m.low;
  if (!m.at.has(level)) m.at.set(level, paced(gd, computeRates(gd, method, level)));
  return m.at.get(level);
}
// Rates for planning: worked out once per method (and level, where it matters), at your speed.
export const planRates = ratesAt;

// Whole actions of a method from `xp` (at `level`) towards level `until`, at most `limit` of them; rates
// follow your level as it goes up. Returns the actions, hours, XP and what they use.
function runFor(gd, method, level, xp, until, limit = Infinity) {
  // Most methods don't speed up with level: then it's one sum, not a level at a time.
  const a0 = ratesAt(gd, method, level);
  const a1 = until - 1 > level ? ratesAt(gd, method, until - 1) : a0;
  if (a0.xpPerHour === a1.xpPerHour && a0.cyclesPerHour === a1.cyclesPerHour) {
    const xpEach = a0.xpPerHour / a0.cyclesPerHour;
    const actions = Math.min(limit, Math.max(0, Math.ceil((gd.xp.xpForLevel(until) - xp) / xpEach - 1e-9)));
    return { actions, hours: actions / a0.cyclesPerHour, xp: actions * xpEach, need: new Map(a0.inputs.map((i) => [i.item, (i.perHour / a0.cyclesPerHour) * actions])) };
  }
  let actions = 0;
  let hours = 0;
  let gained = 0;
  const need = new Map();
  for (let L = level; L < until && actions < limit; L++) {
    const left = gd.xp.xpForLevel(L + 1) - (xp + gained);
    if (left <= 0) continue;
    const rates = ratesAt(gd, method, L);
    const xpEach = rates.xpPerHour / rates.cyclesPerHour;
    const a = Math.min(limit - actions, Math.ceil(left / xpEach - 1e-9));
    actions += a;
    hours += a / rates.cyclesPerHour;
    gained += a * xpEach;
    for (const i of rates.inputs) need.set(i.item, (need.get(i.item) ?? 0) + (i.perHour / rates.cyclesPerHour) * a);
  }
  return { actions, hours, xp: gained, need };
}

// What to do next on the way from `xp` (at `level`) to level `until`: a method all the way there (with
// time to gather whatever you're short of), or one only as far as your bank stock for it lasts. Picks the
// least time per XP, with a little added for every switch away from `prev` (the method before, or the
// one you're on) and for every gathering step.
function pickMethod(gd, skill, levels, level, xp, until, stock, index, prev, prefer) {
  const lv = { ...levels, [skill]: level };
  let best = null;
  const consider = (c) => {
    c.score = (c.cost / c.xp) * keep(prefer, c.rates.method.key);
    if (c.xp > 0 && Number.isFinite(c.cost) && (!best || c.score < best.score)) best = c;
  };
  // Fastest first, so a good option turns up early and slower methods can be ruled out before working
  // out their materials (which only ever add time).
  // Not what can kill you while it runs (a heist whose failures hit harder than auto-eat allows for).
  const options = [];
  for (const method of gd.methodsBySkill[skill] ?? []) {
    if (method.level > level || !usable(gd.checkRequirements(method, lv))) continue;
    const rates = ratesAt(gd, method, level);
    if (rates.xpPerHour > 0 && !idleDanger(gd, rates)?.risky) options.push({ method, rates });
  }
  options.sort((a, b) => b.rates.xpPerHour - a.rates.xpPerHour);
  for (const { method, rates } of options) {
    const switchIn = method.key === prev ? 0 : 1;
    const full = runFor(gd, method, level, xp, until);
    if (!full.actions) continue;
    if (best && ((full.hours + switchIn * SWITCH_HOURS) / full.xp) * keep(prefer, method.key) >= best.score) continue;
    const materials = stock ? obtainEach(index, stock, rates.inputs.map((i) => ({ item: i.item, qty: Math.max(full.need.get(i.item) ?? 0, minEach(method, i.item)) })), MATERIAL_DEPTH, prefer) : [];
    const gather = materials.reduce((s, m) => s + m.hours, 0);
    const chains = materials.reduce((n, m) => n + (m.short > 0 ? 1 + m.needs.length : 0), 0);
    consider({ rates, ...full, gather, total: full.hours + gather, cost: full.hours + gather + (switchIn + chains) * SWITCH_HOURS, materials });
    if (!chains) continue;
    // Just as far as the bank lasts, then something else (one more switch). `limitedBy` is the material
    // that runs out first: the run can end part-way through a level.
    const fits = rates.inputs.map((i) => ({ item: i.item, n: (stock.get(i.item) ?? 0) >= minEach(method, i.item) ? Math.floor((stock.get(i.item) ?? 0) / (i.perHour / rates.cyclesPerHour) + 1e-9) : 0 }));
    const cap = Math.min(...fits.map((f) => f.n));
    if (cap < 1) continue;
    const part = runFor(gd, method, level, xp, until, cap);
    const fromBank = rates.inputs.map((i) => obtain(index, stock, i.item, Math.min(stock.get(i.item) ?? 0, part.need.get(i.item) ?? 0)));
    const limitedBy = part.actions >= cap ? fits.find((f) => f.n === cap).item : null;
    consider({ rates, ...part, gather: 0, total: part.hours, cost: part.hours + (switchIn + 1) * SWITCH_HOURS, materials: fromBank, partial: true, limitedBy });
  }
  return best;
}

// The next level after `level` where the skill unlocks something new (else `target`).
function nextUnlock(gd, skill, level, target) {
  let next = target;
  for (const m of gd.methodsBySkill[skill] ?? []) if (m.level > level && m.level < next) next = m.level;
  return next;
}

// Adds one material shortfall into a list of them, item by item (the chain under it too).
function addShort(list, m) {
  let g = list.find((x) => x.item === m.item);
  if (!g) list.push((g = { item: m.item, qty: 0, hours: 0, actions: 0, runHours: 0, method: m.method, makes: m.makes, needs: [] }));
  g.qty += m.short;
  g.hours += m.hours;
  g.actions += m.actions ?? 0;
  g.runHours += m.runHours ?? 0;
  for (const n of m.needs) {
    const have = g.needs.find((x) => x.item === n.item);
    if (have) {
      have.qty += n.qty;
      have.actions = (have.actions ?? 0) + (n.actions ?? 0);
      have.hours = (have.hours ?? 0) + (n.hours ?? 0);
    } else g.needs.push({ ...n });
  }
}

// Hours from xpNow to a level: skilling skills follow planTraining (with a bank, materials you're short
// of count); combat skills use the best XP/hour you get fighting (`combatXp`: { skill: xpPerHour }).
export function hoursToLevel(gd, skill, levels, xpNow, target, { bank = null, index = null, combatXp = null } = {}) {
  if (gd.levelOf(levels, skill) >= target) return 0;
  if (target > gd.levelCap) return Infinity;
  if (combatXp && skill in combatXp) return combatXp[skill] > 0 ? Math.max(0, gd.xp.xpForLevel(target) - xpNow) / combatXp[skill] : Infinity;
  const plan = planTraining(gd, skill, levels, xpNow, target, { bank, index });
  return plan.blocked ? Infinity : plan.hours;
}

// How to get from xpNow to targetLevel, in whole actions. Picks one method for each stretch between
// unlocks, as you'd play it, leaning towards the one before (or `current`, what you're doing in the game)
// and towards methods in `prefer` (a Set of keys an earlier plan chose). With a bank (an object or a Map)
// it only counts on materials you own: whatever you're short of adds the time to gather or make it.
// Each step lists the shortfalls to sort out before it (`gather`); the plan also totals them.
export function planTraining(gd, skill, levels, xpNow, targetLevel, { bank = null, index = null, current = null, prefer = null } = {}) {
  const target = Math.min(targetLevel, gd.levelCap);
  const start = bank instanceof Map ? bank : bank ? new Map(Object.entries(bank)) : null;
  const stock = start ? new Map(start) : null;
  const producers = stock ? (index ?? producerIndex(gd, levels)) : null;
  let level = gd.xp.levelForXp(xpNow, gd.levelCap);
  let xp = xpNow;
  const steps = [];
  const uses = new Map();
  const gather = [];
  let trainHours = 0;
  let gatherHours = 0;
  let prev = current;
  while (level < target) {
    const pick = pickMethod(gd, skill, levels, level, xp, nextUnlock(gd, skill, level, target), stock, producers, prev, prefer);
    if (!pick || !Number.isFinite(pick.total)) return { hours: Infinity, trainHours, gatherHours, steps, uses: [], gather: [], blocked: true, endXp: xp };
    trainHours += pick.hours;
    gatherHours += pick.gather;
    let step = steps.at(-1);
    if (step?.method.key !== pick.rates.method.key) {
      step = { method: pick.rates.method, fromLevel: level, toLevel: level, hours: 0, actions: 0, xp: 0, xpPerHour: pick.rates.xpPerHour, gather: [] };
      steps.push(step);
    }
    for (const m of pick.materials) {
      for (const u of m.uses) {
        stock.set(u.item, (stock.get(u.item) ?? 0) - u.qty);
        uses.set(u.item, (uses.get(u.item) ?? 0) + u.qty);
      }
      if (m.short > 0) {
        addShort(step.gather, m);
        addShort(gather, m);
        // Whole actions can make a few more than needed; they're there for the next level.
        if (m.made > m.short) stock.set(m.item, (stock.get(m.item) ?? 0) + m.made - m.short);
      }
    }
    xp += pick.xp;
    level = Math.min(target, gd.xp.levelForXp(xp, gd.levelCap));
    step.toLevel = level;
    // How the step ends: at a level, or where a material in the bank runs out (the last pick says).
    step.limitedBy = pick.limitedBy ?? null;
    step.hours += pick.hours;
    step.actions += pick.actions;
    step.xp += pick.xp;
    prev = pick.rates.method.key;
  }
  const hours = trainHours + gatherHours;
  return {
    hours,
    trainHours,
    gatherHours,
    steps: joinRuns(gd, steps, xpNow, target),
    // Anything past what you had came from a gathering step's leftovers, not the bank.
    uses: [...uses].map(([item, qty]) => ({ item, qty: Math.min(qty, start?.get(item) ?? 0), have: start?.get(item) ?? 0 })).filter((u) => u.qty > 0),
    gather,
    blocked: !Number.isFinite(hours),
    endXp: xp,
  };
}

// One run per method. A plan can leave a method for a short detour (a few of something better while your
// materials last) and come back to it: Mithril 2H Crossbow × 75, Mithril Spear × 30, Mithril 2H Crossbow
// × 32. The second run joins the first, with its materials, and the detour follows it, so it's 107 then 30.
// That's the same actions and XP, and every detour still comes after the level it was picked at. Levels
// follow the new order.
function joinRuns(gd, steps, xpNow, target) {
  const out = [];
  for (const st of steps) {
    const same = out.find((x) => x.method.key === st.method.key);
    if (!same) {
      out.push(st);
      continue;
    }
    same.actions += st.actions;
    same.hours += st.hours;
    same.xp += st.xp;
    same.limitedBy = st.limitedBy ?? null;
    for (const g of st.gather) {
      const have = same.gather.find((x) => x.item === g.item);
      if (!have) {
        same.gather.push(g);
        continue;
      }
      for (const k of ['qty', 'hours', 'actions', 'runHours']) have[k] = (have[k] ?? 0) + (g[k] ?? 0);
      for (const n of g.needs) {
        const sub = have.needs.find((x) => x.item === n.item);
        if (sub) for (const k of ['qty', 'hours', 'actions']) sub[k] = (sub[k] ?? 0) + (n[k] ?? 0);
        else have.needs.push({ ...n });
      }
    }
  }
  if (out.length === steps.length) return steps;
  let xp = xpNow;
  for (const st of out) {
    st.fromLevel = gd.xp.levelForXp(xp, gd.levelCap);
    xp += st.xp;
    st.toLevel = Math.min(target, gd.xp.levelForXp(xp, gd.levelCap));
  }
  return out;
}

export function trainNext(gd, levels, xpBySkill = {}, { bank = null, current = null } = {}) {
  const baseline = Math.max(0, ...gd.trainableSkills.map((s) => bestSelfSufficientProfitAt(gd, s, levels, gd.levelOf(levels, s))?.profitPerHour ?? 0));
  const index = bank ? producerIndex(gd, levels) : null;
  const rows = [];
  for (const skill of gd.trainableSkills) {
    const level = gd.levelOf(levels, skill);
    if (level >= gd.levelCap) continue;
    const xpNow = xpBySkill[skill] ?? gd.xp.xpForLevel(level);
    const bestNow = bestXpMethodAt(gd, skill, levels, level);
    const unlocks = (gd.methodsBySkill[skill] ?? []).filter((m) => m.level > level && m.level <= gd.levelCap);
    const nextLevel = unlocks.length ? Math.min(...unlocks.map((m) => m.level)) : null;
    const row = { skill, level, xpNow, bestNow, next: null, money: null };
    if (nextLevel) {
      const plan = planTraining(gd, skill, levels, xpNow, nextLevel, { bank, index, current });
      row.next ={ level: nextLevel, methods: unlocks.filter((m) => m.level === nextLevel), hours: plan.hours, plan };
    }
    for (let L = level + 1; L <= gd.levelCap; L++) {
      const best = bestSelfSufficientProfitAt(gd, skill, levels, L);
      if (best && best.profitPerHour > baseline * 1.05) {
        const plan = planTraining(gd, skill, levels, xpNow, L, { bank, index });
        row.money = { level: L, rates: best, gain: best.profitPerHour - baseline, hours: plan.hours, plan };
        break;
      }
    }
    rows.push(row);
  }
  const finite = (h) => Number.isFinite(h);
  return {
    baselineProfit: baseline,
    quickWins: rows.filter((r) => r.next && finite(r.next.hours)).sort((a, b) => a.next.hours - b.next.hours),
    blocked: rows.filter((r) => r.next && !finite(r.next.hours)),
    moneyUpgrades: rows.filter((r) => r.money && finite(r.money.hours)).sort((a, b) => a.money.hours - b.money.hours),
    rows,
  };
}

// Matches the save header's "current activity" to a method and grades it against the best options.
// The method the save says is running, when the companion knows it.
export function activeMethod(gd, header, skill = header?.activeEntityName ? gd.skillIdFromName(header.activeEntityName) : null) {
  if (!skill) return null;
  const actionName = String(header.activeActionName ?? '').toLowerCase();
  // An Agility course with more than one path is named for the course; the save says which path runs.
  const byPath = header.activePath ? gd.methodByKey.get(`${skill}/${header.activePath}`) : null;
  return byPath ?? (gd.methodsBySkill[skill] ?? []).find((m) => m.name.toLowerCase() === actionName) ?? null;
}

export function currentActivity(gd, header, levels) {
  if (!header?.activeEntityName) return null;
  const skill = gd.skillIdFromName(header.activeEntityName);
  if (!skill) return { skill: null, label: [header.activeEntityName, header.activeActionName].filter(Boolean).join(' - ') };
  const method = activeMethod(gd, header, skill);
  // The path picked in the game's Select Path box, when it isn't the one running (it switches on restart).
  const picked = header.pickedPath && header.pickedPath !== header.activePath ? gd.methodByKey.get(`${skill}/${header.pickedPath}`) ?? null : null;
  const ranked = rankSkill(gd, skill, levels);
  const rates = method ? computeRates(gd, method, ranked.level) : null;
  const confirmed = ranked.available.filter((x) => x.unknown.length === 0);
  const bestXp = confirmed[0] ?? null;
  const bestProfit = [...confirmed].sort((a, b) => b.rates.profitPerHour - a.rates.profitPerHour)[0] ?? null;
  return {
    skill,
    label: [header.activeEntityName, header.activeActionName].filter(Boolean).join(' - '),
    method,
    picked,
    rates,
    bestXp,
    bestProfit,
    xpRatio: rates && bestXp?.rates.xpPerHour ? rates.xpPerHour / bestXp.rates.xpPerHour : null,
    profitRatio: rates && bestProfit?.rates.profitPerHour > 0 ? rates.profitPerHour / bestProfit.rates.profitPerHour : null,
  };
}

// Runs a method for some hours (or until a target level), levelling up along the way.
export function simulate(gd, method, levels, xpNow, { hours = Infinity, targetLevel = Infinity } = {}) {
  const cap = gd.levelCap;
  const startLevel = gd.xp.levelForXp(xpNow, cap);
  const stopLevel = Math.min(targetLevel, cap);
  let level = Math.max(startLevel, method.level);
  let xp = Math.max(xpNow, gd.xp.xpForLevel(level));
  let remaining = hours;
  let elapsed = 0;
  const outputs = new Map();
  const inputs = new Map();
  const currencies = new Map();
  let profit = 0;
  let hpLoss = 0;
  let foodEaten = 0;
  let cycles = 0;
  for (let guard = 0; guard < 500 && remaining > 1e-9; guard++) {
    if (level >= stopLevel && Number.isFinite(targetLevel)) break;
    const r = computeRates(gd, method, level);
    const toNext = level < cap && r.xpPerHour > 0 ? (gd.xp.xpForLevel(level + 1) - xp) / r.xpPerHour : Infinity;
    const h = Math.min(remaining, toNext);
    if (!Number.isFinite(h)) break;
    for (const o of r.outputs) outputs.set(o.item, (outputs.get(o.item) ?? 0) + o.perHour * h);
    for (const i of r.inputs) inputs.set(i.item, (inputs.get(i.item) ?? 0) + i.perHour * h);
    for (const [c, n] of Object.entries(r.currencies)) currencies.set(c, (currencies.get(c) ?? 0) + n * h);
    profit += r.profitPerHour * h;
    hpLoss += r.hpLossPerHour * h;
    foodEaten += (r.food?.perHour ?? 0) * h;
    cycles += r.cyclesPerHour * h;
    xp += r.xpPerHour * h;
    elapsed += h;
    remaining -= h;
    if (h === toNext) {
      level++;
      xp = gd.xp.xpForLevel(level);
    }
  }
  const list = (m) => [...m].map(([item, qty]) => ({ item, qty })).sort((a, b) => b.qty * gd.itemValue(b.item) - a.qty * gd.itemValue(a.item));
  return {
    hours: elapsed,
    xpGained: xp - xpNow,
    startLevel,
    endLevel: gd.xp.levelForXp(xp, cap),
    endXp: xp,
    cycles,
    outputs: list(outputs),
    inputs: list(inputs),
    currencies: Object.fromEntries(currencies),
    profit,
    hpLoss,
    food: foodEaten > 0 ? { item: gd.preferredFood ?? gd.defaultFood, qty: foodEaten } : null,
    reachedTarget: Number.isFinite(targetLevel) ? gd.xp.levelForXp(xp, cap) >= stopLevel : null,
  };
}

// Bank valuation and selling / processing suggestions.
export function bankInsights(gd, bank, levels) {
  // Anything the game asks for anywhere: recipes, shop and upgrade costs, quests, keys and tools, the
  // ranch, bait, runes (gd.raw.itemUses covers all of those, quest-only recipes included).
  const used = new Set();
  for (const m of gd.methods) for (const i of m.ingredients ?? []) used.add(i.item);
  for (const s of gd.shop) for (const i of s.costs.items) used.add(i.item);
  for (const u of gd.raw?.itemUpgrades ?? []) for (const i of u.costs.items) used.add(i.item);
  for (const id of Object.keys(gd.raw?.itemUses ?? {})) used.add(`MelvorBase:${id}`);

  const items = Object.entries(bank ?? {})
    .filter(([, qty]) => qty > 0)
    .map(([item, qty]) => {
      const tags = gd.items[item]?.tags ?? [];
      return { item, qty, unit: gd.itemValue(item), total: qty * gd.itemValue(item), known: gd.isKnownItem(item), tags, usedInRecipes: used.has(item) };
    })
    .sort((a, b) => b.total - a.total);
  const total = items.reduce((s, x) => s + x.total, 0);

  // Nothing uses these, they aren't food, gear, tools or something to open, and they aren't a rare find
  // (hard to get back if you change your mind).
  const what = (id) => gd.items[id] ?? {};
  const rare = (id) => rareOdds(gd, id)?.rarity && rareOdds(gd, id).rarity.id !== 'uncommon';
  const sellable = items.filter((x) => x.known && x.total > 0 && !x.usedInRecipes && x.tags.length === 0
    && !what(x.item).equip && !what(x.item).tool && !what(x.item).heal && !what(x.item).opens && !what(x.item).compost && !what(x.item).bait && !rare(x.item));
  const keepers = items.filter((x) => x.tags.length > 0);

  // Recipes you can make right now from bank stock that are worth more than their materials.
  const processing = [];
  for (const m of gd.methods) {
    if (!m.ingredients?.length || m.kind === 'farming') continue;
    if (!usable(gd.checkRequirements(m, levels))) continue;
    const crafts = Math.floor(Math.min(...m.ingredients.map((i) => (bank?.[i.item] ?? 0) / i.qty)));
    if (crafts < 1) continue;
    const rates = computeRates(gd, m, gd.levelOf(levels, m.skill));
    const gainPerCraft = rates.profitPerHour / rates.cyclesPerHour;
    if (gainPerCraft <= 0) continue;
    processing.push({ method: m, rates, crafts, gainPerCraft, totalGain: crafts * gainPerCraft, hours: crafts / rates.cyclesPerHour });
  }
  processing.sort((a, b) => b.totalGain - a.totalGain);
  return { items, total, sellable, keepers, processing, unknown: items.filter((x) => !x.known) };
}
