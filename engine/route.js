// Your route through the goals worth most to you, step by step: what to gather, make and train, in order,
// each a whole number of actions with its time. Goals are the next unlock in each skill, gear you could
// make that speeds up your fights, and Mastery Guild ranks you'd earn by gathering (route-goals.js); each
// is weighed by what it does for you (a faster best method, a better money maker, a shop item, faster
// fights, a rank bonus) per hour it takes. It plays every step forward on a copy of your levels, XP and
// bank, so a later goal counts what earlier steps leave behind (mining ore for a Smithing goal levels
// Mining too) and no two goals plan on the same stock. Gathering is batched: each item is gathered once,
// in the first goal that needs it, a skill at a time, before that goal trains. The goal you're working on
// in the game stays first until it's done, and an earlier route's choices (`prefer`) keep winning unless
// something is clearly better, so the route doesn't change under you with every autosave. Isomorphic.
import { KEEP, MATERIAL_DEPTH, obtain, planRates, planTraining, producerIndex, SWITCH_HOURS } from './advisor.js';
import { computeRates } from './rates.js';
import { baselineProfit, levelLockedShop, unlockValue } from './route-goals.js';

// The next level that unlocks something in a skill, and what it unlocks.
function nextGoal(gd, skill, level) {
  const unlocks = (gd.methodsBySkill[skill] ?? []).filter((m) => m.level > level && m.level <= gd.levelCap);
  if (!unlocks.length) return null;
  const to = Math.min(...unlocks.map((m) => m.level));
  return { skill, to, unlocks: unlocks.filter((m) => m.level === to) };
}

// Whether a plan uses a method: to train, or to gather or make something for it.
export const planUses = (plan, key) => plan.steps.some((st) => st.method.key === key || st.gather.some((g) => [...g.needs, g].some((n) => n.method?.key === key)));

// Every item each skill's methods use, to tell which plans a change in stock can affect.
function inputsBySkill(gd) {
  const out = new Map();
  for (const m of gd.methods) {
    if (!out.has(m.skill)) out.set(m.skill, new Set());
    for (const i of computeRates(gd, m, m.level).inputs) out.get(m.skill).add(i.item);
  }
  return out;
}

// The skills and items a plan depends on.
function depsOf(skill, plan) {
  const skills = new Set([skill]);
  const items = new Set(plan.uses.map((u) => u.item));
  for (const st of plan.steps) {
    for (const g of st.gather) {
      for (const n of [...g.needs, g]) {
        items.add(n.item);
        if (n.method) skills.add(n.method.skill);
      }
    }
  }
  return { skills, items };
}

// The first thing a plan has you do: a gathering step, else training.
const firstMethod = (plan) => {
  const st = plan.steps[0];
  const g = st?.gather[0];
  return (g ? g.needs[0]?.method ?? g.method : st?.method)?.key ?? null;
};

/**
 * @param current key of the method you're doing in the game: its goal goes first while it's on the way,
 *   and its step first within that goal
 * @param prefer { goals, methods } from an earlier route's `decisions`: kept unless something else is clearly better
 * @param extras goals beyond the next unlocks, from extraGoals() (gear to make, Mastery ranks)
 * @param purchased the shop purchases you've made, for shop items a level would let you buy
 * @param bankItems what's in the bank itself (not worn or in toolbelts), to tell which steps need a new bank slot
 * @param legs how many legs to plan (goals in the same skill one after another make one leg);
 *   hours: stop adding goals after this long
 * @returns { legs: [{ kind: 'unlock'|'gear'|'mastery', id, skill, from, to, unlocks, label, item, reasons, hours, at, steps, doing }],
 *   goals, hours, decisions }; each step:
 *   { kind: 'gather'|'make'|'train'|'task', method, task? (a Mastery task: { skill, id, of, done, perAction, label }), actions, hours, at, item?, qty?, toLevel?, lasts, levelUps: [{ skill, level }],
 *     xpGain, xpAfter, target? } — `target`: how many of `item` you'll have after it; `xpAfter`: its skill's XP after it
 *   `lasts` is how long the stock at that point keeps the step going (Infinity when it uses nothing,
 *   null without a bank).
 */
export function planRoute(gd, { levels, xp = {}, bank = null, current = null, prefer = null, extras = [], purchased = {}, bankItems = null, legs: maxLegs = 5, hours: horizon = 6 }) {
  const keepGoals = new Set(prefer?.goals ?? []);
  const keepMethods = new Set(prefer?.methods ?? []);
  // Without a bank it assumes you have whatever materials it needs.
  const sim = { levels: { ...levels }, xp: { ...xp }, stock: bank ? new Map(Object.entries(bank)) : null };
  for (const s of gd.trainableSkills) sim.xp[s] ??= gd.xp.xpForLevel(gd.levelOf(levels, s));
  const start = { levels: { ...sim.levels }, xp: { ...sim.xp }, stock: sim.stock && new Map(sim.stock), held: new Set(Object.entries(bankItems ?? bank ?? {}).filter(([, q]) => q > 0).map(([k]) => k)) };
  const inputs = inputsBySkill(gd);
  let index = producerIndex(gd, sim.levels);
  // What makes a goal worth more: a better money maker than your best, a shop item, and a faster method
  // you could keep going (its materials you can gather or make, or have half an hour's worth of).
  const worth = { baselineProfit: baselineProfit(gd, levels), shop: levelLockedShop(gd, levels, purchased), supplied: (item, perHour) => index.has(item) || !start.stock || (start.stock.get(item) ?? 0) >= perHour / 2 };
  const plans = new Map();
  const used = new Set();
  const route = [];
  const legs = [];
  let clock = 0;
  let last = current;
  while (clock < horizon && route.length < 40) {
    let best = null;
    // Value per hour, a little less when it means switching; what you're doing goes first, and an
    // earlier plan's goals keep their place unless something else is clearly better.
    const consider = (c) => {
      if (!c || !(c.hours >= 0) || !Number.isFinite(c.hours)) return;
      c.doing = !route.length && !!current && c.uses(current);
      c.score = (c.value / Math.max(c.hours + (c.first === last ? 0 : SWITCH_HOURS), 1 / 120)) * (keepGoals.has(c.id) ? 1 / (KEEP * KEEP) : 1);
      if (!best || (c.doing && !best.doing) || (c.doing === best.doing && c.score > best.score)) best = c;
    };
    for (const skill of gd.trainableSkills) {
      const level = gd.levelOf(sim.levels, skill);
      if (level >= gd.levelCap) continue;
      if (!plans.has(skill)) {
        const goal = nextGoal(gd, skill, level);
        const plan = goal && planTraining(gd, skill, sim.levels, sim.xp[skill], goal.to, { bank: sim.stock, index, current: last, prefer: keepMethods });
        plans.set(skill, goal && !plan.blocked ? { ...goal, ...unlockValue(gd, skill, sim.levels, goal.to, worth), from: level, plan, deps: depsOf(skill, plan) } : null);
      }
      const c = plans.get(skill);
      if (c) consider({ ...c, kind: 'unlock', id: `${skill}|${c.to}`, hours: c.plan.hours, first: firstMethod(c.plan), uses: (key) => planUses(c.plan, key) });
    }
    for (const x of extras) if (!used.has(x.id)) consider(extraCandidate(gd, sim, x, { index, last, prefer: keepMethods }));
    if (!best) break;
    const leg = legs.at(-1);
    const sameLeg = best.kind === 'unlock' && leg?.kind === 'unlock' && leg.skill === best.skill && leg.to === best.from;
    if (!sameLeg && legs.length >= maxLegs) break;
    if (best.kind !== 'unlock') used.add(best.id);
    const before = { ...sim.levels };
    const touched = { xp: new Set(), items: new Set() };
    const steps = play(gd, sim, best, clock, touched, index);
    const hours = steps.reduce((s, st) => s + st.hours, 0);
    const goal = { kind: best.kind, id: best.id, skill: best.skill, from: best.from, to: best.to ?? gd.levelOf(sim.levels, best.skill), unlocks: best.unlocks ?? [], label: best.label ?? null, item: best.item ?? null, reasons: best.reasons ?? [], hours, at: clock, steps, doing: best.doing };
    route.push(goal);
    if (sameLeg) {
      leg.to = goal.to;
      leg.unlocks.push(...goal.unlocks);
      leg.reasons = strongest([...leg.reasons, ...goal.reasons]);
      leg.hours += hours;
      addSteps(leg.steps, steps);
    } else {
      legs.push({ ...goal, unlocks: [...goal.unlocks], reasons: [...goal.reasons], steps: steps.map((st) => ({ ...st, levelUps: [...st.levelUps] })) });
    }
    clock += hours;
    last = steps.at(-1)?.method.key ?? last;
    // Plan again only what the steps just played could have changed.
    const levelled = new Set(Object.keys(sim.levels).filter((s) => sim.levels[s] !== before[s]));
    if (levelled.size) index = producerIndex(gd, sim.levels);
    for (const [skill, c] of plans) {
      const stale = !c || touched.xp.has(skill) || [...c.deps.skills].some((s) => levelled.has(s)) || [...touched.items].some((i) => c.deps.items.has(i) || inputs.get(skill)?.has(i));
      if (stale) plans.delete(skill);
    }
  }
  batch(gd, legs, current);
  settle(gd, legs, start);
  // Folding steps together moved them; start times follow the order they're in now.
  let at = 0;
  for (const leg of legs) {
    leg.at = at;
    for (const st of leg.steps) {
      st.at = at;
      at += st.hours;
    }
  }
  const decisions = {
    goals: route.map((g) => g.id),
    methods: [...new Set(legs.flatMap((l) => l.steps.map((st) => st.method.key)))],
  };
  return { legs, goals: route, hours: at, decisions };
}

// Plays the final order of steps from the start to set what each one should leave you with, so progress
// can be read off your saves: `target` (how many of the item you'll have after a gathering step) and
// `xpAfter` (the step's skill XP after it), plus `lasts` for the stock at that point and `newItems`
// (what it brings into the bank that isn't there yet: each needs a free slot).
function settle(gd, legs, start) {
  const levels = { ...start.levels };
  const xp = { ...start.xp };
  const stock = start.stock;
  const held = new Set(start.held);
  for (const st of legs.flatMap((l) => l.steps)) {
    const skill = st.method.skill;
    const rates = planRates(gd, st.method, gd.levelOf(levels, skill));
    const each = (perHour) => (perHour / rates.cyclesPerHour) * st.actions;
    if (stock) {
      st.lasts = rates.inputs.length ? Math.min(...rates.inputs.map((i) => (stock.get(i.item) ?? 0) / (i.perHour / rates.cyclesPerHour))) / rates.cyclesPerHour : Infinity;
      for (const i of rates.inputs) {
        stock.set(i.item, Math.max(0, (stock.get(i.item) ?? 0) - each(i.perHour)));
        if (stock.get(i.item) < 0.5) held.delete(i.item);
      }
      st.newItems = [];
      for (const o of rates.outputs) {
        stock.set(o.item, (stock.get(o.item) ?? 0) + each(o.perHour));
        // At least one expected: rare extras (a gem now and then) still take a slot when they come.
        if (!held.has(o.item) && each(o.perHour) >= 0.5) {
          held.add(o.item);
          st.newItems.push(o.item);
        }
      }
      // What it makes, margin included, and what you'll have of it after.
      if (st.item) {
        st.qty = each(rates.outputs.find((o) => o.item === st.item)?.perHour ?? 0);
        st.target = stock.get(st.item) ?? 0;
      }
    }
    const was = gd.levelOf(levels, skill);
    xp[skill] = (xp[skill] ?? 0) + st.xpGain;
    levels[skill] = Math.max(was, Math.min(gd.levelCap, gd.xp.levelForXp(xp[skill], gd.levelCap)));
    st.xpAfter = xp[skill];
    // Levels as the steps now fall, after joining runs and stocking up first.
    st.levelUps = levels[skill] > was ? [{ skill, level: levels[skill] }] : [];
    if (st.kind === 'train') st.toLevel = levels[skill];
  }
}

// What a method uses and makes, by item, for telling which steps have to come before which.
const io = new Map();
function itemsOf(gd, method) {
  if (!io.has(method.key)) {
    const r = computeRates(gd, method, method.level);
    io.set(method.key, { uses: new Set(r.inputs.map((i) => i.item)), makes: new Set(r.outputs.map((o) => o.item)) });
  }
  return io.get(method.key);
}

// Each goal gathers what it needs once per item, and raw materials (ore, logs, fish: nothing used up to
// get them) for the whole route once, in the first goal that needs them. Things made from other things
// stay with their own goal, next to what they're made from. Each goal then stocks up before it trains, a
// skill at a time (all the mining, then all the smelting), starting with the step you're on in the game if
// it's one of them. Training keeps its order, one run per method in a goal: coming back to a method after
// a detour (goals in one skill can do that between them) joins its first run, and the detour follows it.
function batch(gd, legs, current) {
  const first = new Map();
  legs.forEach((leg, li) => {
    const kept = [];
    for (const st of leg.steps) {
      const train = st.kind === 'train';
      const key = train ? `train|${st.method.key}` : `${st.method.key}|${st.item}`;
      const into = first.get(key);
      if (into && (into.leg === li || (!train && itemsOf(gd, st.method).uses.size === 0))) fold(into.step, st);
      else {
        if (key) first.set(key, { step: st, leg: li });
        kept.push(st);
      }
    }
    leg.steps = kept;
  });
  for (const leg of legs) {
    leg.steps = stockUpFirst(gd, leg.steps, current);
    leg.hours = leg.steps.reduce((s, st) => s + st.hours, 0);
  }
}

// Orders a goal's steps: anything that isn't training as early as what it needs allows, the same skill
// back to back and raw materials before what's made from them, then the training in its own order. A
// step waits for the gathering that makes what it uses, and for training before it that does.
function stockUpFirst(gd, steps, current) {
  const after = steps.map((st, i) => {
    const needs = itemsOf(gd, st.method).uses;
    const deps = new Set();
    steps.forEach((other, j) => {
      if (j === i || (other.kind === 'train' && j > i)) return;
      if ([...itemsOf(gd, other.method).makes].some((item) => needs.has(item))) deps.add(j);
      if (st.kind === 'train' && other.kind === 'train') deps.add(j);
    });
    return deps;
  });
  // How many other gathering steps wait on each one: those go first.
  const feeds = steps.map((st, i) => steps.filter((o, k) => o.kind !== 'train' && after[k].has(i)).length);
  const placed = new Set();
  const order = [];
  while (order.length < steps.length) {
    const ready = steps.map((st, i) => i).filter((i) => !placed.has(i) && [...after[i]].every((j) => placed.has(j)));
    const gathers = ready.filter((i) => steps[i].kind !== 'train');
    const lastSkill = order.length ? steps[order.at(-1)].method.skill : null;
    // What you're on in the game goes first: you have what it needs for now, and the counts catch up.
    const on = steps.findIndex((st) => st.method.key === current);
    const pick = (order.length || on < 0 ? undefined : on)
      ?? gathers.find((i) => steps[i].method.skill === lastSkill)
      ?? [...gathers].sort((a, b) => feeds[b] - feeds[a] || a - b)[0]
      ?? ready[0]
      ?? steps.findIndex((st, i) => !placed.has(i));
    placed.add(pick);
    order.push(pick);
  }
  return order.map((i) => steps[i]);
}

// The strongest reason of each kind, for a goal made of several.
function strongest(reasons) {
  const best = new Map();
  for (const r of reasons) if (!best.has(r.kind) || r.gain > best.get(r.kind).gain) best.set(r.kind, r);
  return [...best.values()];
}

// Folds `st` into `into`: one longer run of the same thing.
function fold(into, st) {
  into.actions += st.actions;
  into.hours += st.hours;
  into.xpGain += st.xpGain;
  if (st.qty != null) into.qty = (into.qty ?? 0) + st.qty;
  if (st.toLevel != null) into.toLevel = st.toLevel;
  if (st.kind === 'train') into.limitedBy = st.limitedBy ?? null;
  for (const up of st.levelUps) {
    const have = into.levelUps.find((u) => u.skill === up.skill);
    if (have) have.level = Math.max(have.level, up.level);
    else into.levelUps.push({ ...up });
  }
}

// Adds a goal's steps to its leg. Training that carries on with the leg's last method joins it, and
// what it needs gathered joins the gathering already lined up before it: mine all the ore once, then
// smith, rather than mine-smith-mine-smith a level at a time.
function addSteps(steps, add) {
  let segment = [];
  for (const st of add) {
    segment.push(st);
    if (st.kind !== 'train') continue;
    const last = steps.at(-1);
    if (last?.kind === 'train' && last.method.key === st.method.key) {
      // The block of steps that feeds the last training run.
      let start = steps.length - 1;
      while (start > 0 && steps[start - 1].kind !== 'train') start--;
      for (const g of segment.slice(0, -1)) {
        const same = steps.slice(start, -1).find((x) => x.kind === g.kind && x.method.key === g.method.key);
        if (same) fold(same, g);
        else steps.splice(steps.length - 1, 0, { ...g, levelUps: [...g.levelUps] });
      }
      fold(last, st);
    } else {
      for (const g of segment) {
        const prev = steps.at(-1);
        if (prev?.kind === g.kind && prev.method.key === g.method.key) fold(prev, g);
        else steps.push({ ...g, levelUps: [...g.levelUps] });
      }
    }
    segment = [];
  }
  for (const g of segment) steps.push({ ...g, levelUps: [...g.levelUps] });
}

// A gear or Mastery goal as a candidate, from where the simulation is now: its plan and how long it takes.
function extraCandidate(gd, sim, x, { index, last, prefer }) {
  const level = gd.levelOf(sim.levels, x.skill);
  if (x.kind === 'gear') {
    const plan = level < x.to ? planTraining(gd, x.skill, sim.levels, sim.xp[x.skill], x.to, { bank: sim.stock, index, current: last, prefer }) : null;
    if (plan?.blocked) return null;
    const make = sim.stock ? obtain(index, sim.stock, x.item, 1, MATERIAL_DEPTH, prefer) : null;
    if (make && !Number.isFinite(make.hours)) return null;
    const chain = make ? [...make.needs, make] : [];
    return { ...x, from: level, plan, label: gd.itemName(x.item), hours: (plan?.hours ?? 0) + (make?.hours ?? 0),
      first: plan ? firstMethod(plan) : chain[0]?.method?.key ?? x.method,
      uses: (key) => (plan && planUses(plan, key)) || chain.some((n) => n.method?.key === key) || key === x.method };
  }
  if (x.kind === 'mastery') {
    if (x.tasks.some((t) => !gd.methodByKey.get(t.method))) return null;
    return { ...x, from: level, to: level, label: x.rank, hours: x.tasks.reduce((s, t) => s + t.hours, 0), first: x.tasks[0]?.method, uses: (key) => x.tasks.some((t) => t.method === key) };
  }
  return null;
}

// Plays one goal's plan on the simulated levels, XP and bank, step by step.
function play(gd, sim, goal, clock, touched, index) {
  const steps = [];
  let at = clock;
  const run = (kind, method, actions, extra = {}) => {
    const level = gd.levelOf(sim.levels, method.skill);
    const rates = planRates(gd, method, level);
    const each = (perHour) => perHour / rates.cyclesPerHour;
    const hours = actions / rates.cyclesPerHour;
    const stock = sim.stock;
    const lasts = !stock ? null : rates.inputs.length ? Math.min(...rates.inputs.map((i) => (stock.get(i.item) ?? 0) / each(i.perHour))) / rates.cyclesPerHour : Infinity;
    for (const i of stock ? rates.inputs : []) {
      stock.set(i.item, Math.max(0, (stock.get(i.item) ?? 0) - each(i.perHour) * actions));
      touched.items.add(i.item);
    }
    for (const o of stock ? rates.outputs : []) {
      stock.set(o.item, (stock.get(o.item) ?? 0) + each(o.perHour) * actions);
      touched.items.add(o.item);
    }
    const xpGain = extra.xp ?? each(rates.xpPerHour) * actions;
    const levelUps = gain(gd, sim, method.skill, xpGain, touched);
    const step = { kind, method, actions, hours: extra.hours ?? hours, at, lasts, levelUps, ...extra, xpGain };
    delete step.xp;
    steps.push(step);
    at += step.hours;
  };
  for (const st of goal.plan?.steps ?? []) {
    for (const g of st.gather) {
      for (const n of [...g.needs, g]) {
        if (n.method && n.actions) run(n.makes ? 'make' : 'gather', n.method, n.actions, { item: n.item, qty: n.qty });
      }
    }
    run('train', st.method, st.actions, { xp: st.xp, hours: st.hours, toLevel: st.toLevel, limitedBy: st.limitedBy ?? null });
  }
  if (goal.kind === 'gear') {
    // Then make it: from the bank, gathering anything it's short of first.
    const make = sim.stock ? obtain(index, sim.stock, goal.item, 1) : { item: goal.item, short: 1, method: gd.methodByKey.get(goal.method), makes: true, actions: 1, needs: [] };
    for (const n of [...make.needs, { ...make, qty: make.short }]) {
      if (n.method && n.actions) run(n.makes ? 'make' : 'gather', n.method, n.actions, { item: n.item, qty: n.qty });
    }
  }
  if (goal.kind === 'mastery') {
    for (const t of goal.tasks) {
      if (!(t.hours > 0)) continue;
      const method = gd.methodByKey.get(t.method);
      const rates = planRates(gd, method, gd.levelOf(sim.levels, method.skill));
      const actions = Math.max(1, Math.ceil(t.hours * rates.cyclesPerHour));
      // Goal progress per action, from how long the whole task takes on its own.
      const perAction = (t.of - t.done) / Math.max(1, (t.own ?? t.hours) * rates.cyclesPerHour);
      run('task', method, actions, { task: { skill: goal.skill, id: t.task, of: t.of, done: t.done, perAction, label: t.label } });
    }
  }
  return steps;
}

// Adds XP to a skill on the simulated levels; returns any levels gained.
function gain(gd, sim, skill, xp, touched) {
  if (!(xp > 0)) return [];
  touched.xp.add(skill);
  sim.xp[skill] = (sim.xp[skill] ?? 0) + xp;
  const was = gd.levelOf(sim.levels, skill);
  const now = Math.min(gd.levelCap, gd.xp.levelForXp(sim.xp[skill], gd.levelCap));
  if (now <= was) return [];
  sim.levels[skill] = now;
  return [{ skill, level: now }];
}
