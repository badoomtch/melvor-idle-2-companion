// A route you follow stays put: it's planned once and saved, and each autosave only moves its progress
// on. Everything is read from your save: a training step is done when your XP gets to where it ends; a
// gathering step when you have what it was meant to leave you with, or when your bank already covers
// everything still to do that uses its item (you did things in another order, already had them, or what
// needed them is done). Training done means the rest of that goal before it is done too. Once done, a
// step stays done, even when a later step uses up what it made. Isomorphic.
import { minEach, obtain, producerIndex } from './advisor.js';
import { computeRates } from './rates.js';

// The route as plain data to keep between autosaves: methods by key.
export function lockRoute(route, { madeAt = Date.now(), speed = null } = {}) {
  return {
    madeAt,
    // Your measured speed at each method when it was planned: times left keep using it.
    speed: speed && Object.keys(speed).length ? { ...speed } : null,
    decisions: route.decisions ?? null,
    legs: route.legs.map((leg, li) => ({
      kind: leg.kind ?? 'unlock',
      id: leg.id ?? `${leg.skill}|${leg.to}`,
      label: leg.label ?? null,
      item: leg.item ?? null,
      reasons: (leg.reasons ?? []).map((r) => (typeof r === 'string' ? r : r.text)),
      skill: leg.skill,
      from: leg.from,
      to: leg.to,
      unlocks: leg.unlocks.map((m) => m.key),
      steps: leg.steps.map((st, si) => ({
        id: `${li}.${si}`,
        kind: st.kind,
        method: st.method.key,
        actions: st.actions,
        hours: st.hours,
        item: st.item ?? null,
        qty: st.qty ?? null,
        target: st.target ?? null,
        xpAfter: st.xpAfter,
        xpGain: st.xpGain,
        toLevel: st.toLevel ?? null,
        limitedBy: st.limitedBy ?? null,
        lasts: Number.isFinite(st.lasts) ? st.lasts : null,
        levelUps: st.levelUps ?? [],
        task: st.task ?? null,
        newItems: st.newItems ?? [],
      })),
    })),
    done: [],
  };
}

/**
 * Where you are on a locked route, from your save.
 * @param current key of the method you're doing in the game
 * @param mastery the save's Mastery Guild task states (save.mastery), for Mastery task steps
 * @param room { items: what's in the bank itself, free: free bank slots, empty: items with an empty placeholder },
 *   to warn when the plan's new items won't fit
 * @returns { legs: [{ skill, from, to, unlocks, hours, at, steps, done }], step (what to do now), finished,
 *   broken (the data changed under it), blocked (the item the step needs that you don't have and nothing
 *   left in the route makes), newlyDone: step ids done since the last check }; each step adds
 *   { method, done, on, left: { actions, qty, hours } } — `left` is what's still to do.
 */
export function routeProgress(gd, locked, { levels, xp, bank, current = null, mastery = null, room = null }) {
  const done = new Set(locked.done);
  const newlyDone = [];
  let broken = false;
  const legs = locked.legs.map((leg) => {
    const steps = leg.steps.map((saved) => {
      const method = gd.methodByKey.get(saved.method);
      if (!method) {
        broken = true;
        return null;
      }
      const base = computeRates(gd, method, gd.levelOf(levels, method.skill));
      const f = locked.speed?.[method.key] ?? 1;
      const rates = f === 1 ? base : { ...base, cyclesPerHour: base.cyclesPerHour * f, xpPerHour: base.xpPerHour * f };
      let left;
      if (saved.kind === 'task') {
        // A Mastery task: what its goal still needs, from the save.
        const t = saved.task;
        const s = mastery?.[t.skill]?.[t.id] ?? mastery?.[t.skill]?.[String(t.id).split(':').pop()];
        const progress = s?.goalComplete ? t.of : Math.min(t.of, s?.goalProgress ?? t.done);
        const actions = Math.min(saved.actions, Math.ceil(Math.max(0, t.of - progress) / Math.max(t.perAction, 1e-9) - 1e-9));
        left = { actions, qty: null, hours: actions / rates.cyclesPerHour, progress };
      } else if (saved.kind === 'train' || saved.target == null || !bank) {
        const xpEach = rates.xpPerHour / rates.cyclesPerHour;
        // Only this step's own share: the XP still between you and where it ends, at most what it gives.
        const xpLeft = Math.min(saved.xpGain ?? Infinity, Math.max(0, saved.xpAfter - (xp[method.skill] ?? 0)));
        const actions = xpEach > 0 ? Math.ceil(xpLeft / xpEach - 0.5) : 0;
        left = { actions: Math.max(0, actions), qty: null, hours: Math.max(0, actions) / rates.cyclesPerHour };
      } else {
        const each = (base.outputs.find((o) => o.item === saved.item)?.perHour ?? 0) / base.cyclesPerHour;
        const qty = Math.min(saved.qty ?? Infinity, Math.max(0, saved.target - (bank[saved.item] ?? 0)));
        const actions = each > 0 ? Math.ceil(qty / each - 0.5) : 0;
        left = { actions: Math.max(0, actions), qty, hours: Math.max(0, actions) / rates.cyclesPerHour };
      }
      // Per action: your speed changes how many actions an hour, not what each one uses or makes.
      const uses = new Map(base.inputs.map((i) => [i.item, i.perHour / base.cyclesPerHour]));
      const makes = new Map(base.outputs.map((o) => [o.item, o.perHour / base.cyclesPerHour]));
      return { ...saved, method, left, fromBank: left, uses, makes, levelUps: saved.levelUps };
    });
    return { ...leg, unlocks: leg.unlocks.map((k) => gd.methodByKey.get(k)).filter(Boolean), steps };
  });
  if (broken) return { legs: [], step: null, finished: false, broken: true, blocked: null, newlyDone: [] };
  const mark = (st) => {
    if (done.has(st.id)) return;
    done.add(st.id);
    newlyDone.push(st.id);
  };
  const flat = legs.flatMap((l) => l.steps);
  // Goes over the route until nothing more turns out to be done (one step being done can finish another).
  const pass = () => {
    const before = done.size;
    // Goal by goal. Training is done when your XP gets there, whenever that is. A gathering step's own
    // count only means something once the goals before it are done (they may use up what's in the bank).
    let reached = true;
    for (const leg of legs) {
      leg.reached = reached;
      for (const st of leg.steps) {
        // Not its turn yet: what it'll take, not what your bank says today.
        st.left = !reached && st.kind !== 'train' && st.kind !== 'task' ? { actions: st.actions, qty: st.qty, hours: st.hours } : st.fromBank;
        if (st.left.actions <= 0 && (st.kind === 'train' || st.kind === 'task' || reached)) mark(st);
      }
      // At the level an unlock goal was for: the whole goal is done, however you got there.
      if ((leg.kind ?? 'unlock') === 'unlock' && gd.levelOf(levels, leg.skill) >= leg.to) leg.steps.forEach(mark);
      const lastTrain = leg.steps.findLastIndex((st) => st.kind === 'train' && done.has(st.id));
      for (const st of lastTrain > 0 ? leg.steps.slice(0, lastTrain) : []) mark(st);
      if (!leg.steps.every((st) => done.has(st.id))) reached = false;
    }
    // Enough for what's left: your bank covers everything still to do that uses the item. (The spare a
    // plan gathers is there for bad luck, not something you have to finish.)
    if (bank) {
      for (const st of flat) {
        if (st.kind === 'train' || st.kind === 'task' || !st.item || done.has(st.id)) continue;
        // Only materials: something the goal is for (a piece of gear) is done when you have it.
        if (!flat.some((c) => c !== st && c.uses.has(st.item))) continue;
        const need = flat.reduce((sum, c) => sum + (c === st || done.has(c.id) ? 0 : (c.uses.get(st.item) ?? 0) * c.left.actions), 0);
        if ((bank[st.item] ?? 0) >= need) mark(st);
      }
    }
    return done.size > before;
  };
  for (let i = 0; i < 8 && pass(); i++);
  // What a step needs that you haven't got: a level, or an item (null when you can do it now).
  const missing = (st) => {
    if (!gd.checkRequirements(st.method, levels).ok) return 'level';
    if (!bank) return null;
    return computeRates(gd, st.method, gd.levelOf(levels, st.method.skill)).inputs.find((i) => (bank[i.item] ?? 0) < minEach(st.method, i.item))?.item ?? null;
  };
  for (const leg of legs) for (const st of leg.steps) st.done = done.has(st.id);
  // Every step still to do, in the order you'll do them, against your bank as the steps before it will
  // leave it (what they make added, what they use taken away). A goal stocks up before it trains, as the
  // page lists it, even when the training came first in the plan because you were already doing it; only
  // stocking up that needs what the training makes waits for it. A step that won't have what it needs,
  // because you used it on something else, sold it, or had bad luck, is marked short. When something you
  // can do now makes up the shortfall, the goal's own step for that item does more (one step, not two for
  // the same thing), or a top-up step goes in just before it; either way the plan carries on and the extra
  // drops off once your bank covers it. Only a shortfall nothing can make (`short`) means the plan no
  // longer works.
  let short = null;
  if (bank) {
    const stock = { ...bank };
    let index = null;
    const trains = (st) => st.kind === 'train' || st.kind === 'task';
    for (const leg of legs) {
      const trainMakes = new Set(leg.steps.filter(trains).flatMap((st) => [...st.makes.keys()]));
      const first = leg.steps.filter((st) => !trains(st) && ![...st.uses.keys()].some((i) => trainMakes.has(i)));
      const order = [...first, ...leg.steps.filter((st) => !first.includes(st))];
      const seen = new Set();
      order.forEach((st, k) => {
        if (st.done) return;
        for (const [item, each] of st.uses) {
          const need = each * st.left.actions;
          const have = Math.max(0, stock[item] ?? 0);
          // Less than one action's worth short is rounding, not a problem.
          if (need - have >= each && !st.short) {
            st.short = { item, need: Math.ceil(need), have: Math.floor(have) };
            index ??= producerIndex(gd, levels);
            // Enough for the rest of this goal in one go, not a top-up before every step that runs short:
            // what the steps after it still use, less what they make.
            const ahead = order.slice(k + 1).filter((x) => !x.done).reduce((sum, x) => sum + ((x.uses.get(item) ?? 0) - (x.makes.get(item) ?? 0)) * x.left.actions, 0);
            const qty = st.short.need - st.short.have + Math.max(0, Math.ceil(ahead - 1e-9));
            // The goal's own step for the item, already counted above, makes the extra the same way.
            const own = leg.steps.find((x) => seen.has(x) && !x.done && !x.topUp && x.item === item && x.kind !== 'train' && x.kind !== 'task');
            const top = topUp(gd, index, stock, item, qty, st.id, own?.method.key);
            if (top) {
              st.short.topUp = true;
              const extra = [];
              for (const part of top.steps) {
                // The same thing already lined up in this goal (and counted above): it does more instead.
                const twin = leg.steps.find((x) => seen.has(x) && !x.done && !x.topUp && x.method.key === part.method.key && x.item === part.item);
                if (twin) {
                  twin.left = { actions: twin.left.actions + part.actions, qty: (twin.left.qty ?? 0) + part.qty, hours: twin.left.hours + part.hours };
                  twin.extra = (twin.extra ?? 0) + part.qty;
                } else extra.push(part);
              }
              leg.steps.splice(leg.steps.indexOf(st), 0, ...extra);
              for (const u of top.uses) stock[u.item] = (stock[u.item] ?? 0) - u.qty;
              stock[item] = have + qty;
            } else short ??= { step: st.id, ...st.short };
          }
          stock[item] = (stock[item] ?? 0) - need;
        }
        for (const [item, each] of st.makes) stock[item] = (stock[item] ?? 0) + each * st.left.actions;
        seen.add(st);
      });
    }
  }
  let at = 0;
  let step = null;
  let blocked = null;
  for (const leg of legs) {
    leg.done = leg.steps.every((st) => st.done);
    leg.at = at;
    leg.hours = leg.steps.reduce((s, st) => s + (st.done ? 0 : st.left.hours), 0);
    at += leg.hours;
    // The first goal that isn't done: the step you're on, else the first you can do now. When you can't
    // do any of them (you've run out of something and nothing left in the goal makes it), it's stuck.
    if (!step && !leg.done) {
      const todo = leg.steps.filter((st) => !st.done);
      step = todo.find((st) => st.method.key === current && !missing(st)) ?? todo.find((st) => !missing(st)) ?? null;
      if (!step) {
        step = todo[0];
        blocked = missing(step);
      }
      step.on = step.method.key === current;
    }
  }
  // Bank space: the item types the steps still to do bring in that the bank doesn't hold, against the free
  // slots. Short means the game will stop part-way (it can't take a new item with the bank full).
  let space = null;
  if (room) {
    // An item with an empty placeholder drops back into it without a new slot.
    const empty = new Set(room.empty ?? []);
    const needsSlot = (item) => !(room.items?.[item] > 0) && !empty.has(item);
    const coming = [...new Set(legs.flatMap((l) => l.steps).filter((st) => !st.done).flatMap((st) => st.newItems ?? []))].filter(needsSlot);
    if (coming.length > room.free) {
      const flat = legs.flatMap((l) => l.steps).filter((st) => !st.done);
      let seen = 0;
      const where = flat.find((st) => (seen += (st.newItems ?? []).filter(needsSlot).length) > room.free);
      space = { short: coming.length - room.free, free: room.free, items: coming, at: where?.id ?? null };
    }
  }
  return { legs, step, finished: !step, broken: false, blocked, short, space, newlyDone, hours: at };
}

// Steps that make up a shortfall of `qty` with what you can do now, deepest materials first (obtain()),
// from `stock` as the plan will have it then, not counting what's left of the item itself (the step
// short of it already counts on that). `way`: the method to make the item itself with (the one the goal
// already uses for it), when you can do it now. Null when nothing you can do makes it.
function topUp(gd, index, stock, item, qty, forStep, way = null) {
  const pool = new Map(Object.entries(stock).map(([k, v]) => [k, Math.max(0, v)]));
  pool.set(item, 0);
  const only = way && (index.get(item) ?? []).filter((p) => p.rates.method.key === way);
  const got = obtain(only?.length ? new Map([...index, [item, only]]) : index, pool, item, qty);
  if (!got.method || !Number.isFinite(got.hours)) return null;
  const parts = [...got.needs, { item, qty: got.short, method: got.method, makes: got.makes, actions: got.actions, hours: got.runHours }];
  if (parts.some((p) => !p.method || !p.actions)) return null;
  const steps = parts.map((p, k) => {
    const left = { actions: p.actions, qty: p.qty, hours: p.hours };
    return { id: `topup:${forStep}:${k}`, kind: p.makes ? 'make' : 'gather', topUp: forStep, method: p.method, item: p.item, qty: p.qty, actions: p.actions, hours: p.hours,
      left, fromBank: left, uses: new Map(), makes: new Map(), levelUps: [], newItems: [], done: false };
  });
  return { steps, uses: got.uses.filter((u) => u.item !== item) };
}

// What you do in each kind of skill, to start a step with: "Mine 37 Iron Ore", "Make Oak Boomerang × 931".
export const STEP_VERBS = { woodcutting: 'Cut', mining: 'Mine', fishing: 'Catch', cooking: 'Cook', firemaking: 'Burn', artisan: 'Make', thieving: 'Steal from', agility: 'Do', astrology: 'Study', hunting: 'Hunt', farming: 'Grow', ranching: 'Raise' };
export const GATHER_VERBS = { woodcutting: 'Cut', mining: 'Mine', fishing: 'Catch', cooking: 'Cook', artisan: 'Make', hunting: 'Hunt', farming: 'Grow' };

// Where a training step stops. Most get you to a level ("until Runecrafting 45"); one the plan cut short
// where a material in your bank runs out, then moves on to something else, gains no level, so it says
// what it's for and what runs out. `item` and `skill` render the names (plain text, or a link and escaped
// HTML). Old plans didn't keep the material: they say it's as far as your materials go.
export function trainEnd(gd, st, { item = (id) => gd.itemName(id), skill = gd.skillName(st.method.skill) } = {}) {
  if (st.levelUps?.length || st.toLevel == null) return `until ${skill} ${st.toLevel}`;
  return `for ${skill} XP, ${st.limitedBy ? `until you run out of ${item(st.limitedBy)}` : 'as far as your materials go'}`;
}

// A step in plain words, with what's still to do when `left` says so: for notifications and titles.
export function describeStep(gd, st, { left = true } = {}) {
  const todo = left && !st.done && st.left ? st.left : null;
  const n = (x) => Math.ceil(x).toLocaleString('en-US');
  if (st.kind === 'task') return `${st.task.label}${todo?.progress != null ? ` (${n(todo.progress)}/${n(st.task.of)})` : ''}`;
  if (st.kind === 'train') return `${STEP_VERBS[st.method.kind] ?? 'Do'} ${st.method.name} × ${n(todo ? todo.actions : st.actions)} ${trainEnd(gd, st)}`;
  return `${GATHER_VERBS[st.method.kind] ?? 'Get'} ${n(todo?.qty ?? st.qty)} ${gd.itemName(st.item)}`;
}
