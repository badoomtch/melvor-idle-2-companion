// Your plan, kept by the companion itself (history/routes.json, never near the game's files) and checked
// against every autosave: steps tick off, a new plan is made when one is finished or stuck or your goals
// change, and a desktop notification says what's done and what's next, page open or not. The page shows
// the plan and can ask for a new one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speedFactors } from '../engine/accuracy.js';
import { describeStep, routeProgress } from '../engine/route-progress.js';
import { planRoute } from '../engine/route.js';
import { makePlan, planInputs } from './plan-maker.js';

// A plan that's stuck or finished is planned again at most this often, so a plan that can't start
// doesn't send a new notification with every autosave.
const REPLAN_MS = 60_000;
const SHORT_REPLAN_MS = 10 * 60_000;

/**
 * @param actions (id) => what each action has really given you so far (the observation store's record),
 *   so plans use your own speed where it's been measured
 * @param maker (job) => Promise of a locked plan (planWorker(): a worker thread), so the companion keeps
 *   going while a plan is made; without one, plans are made inline with `plan`
 * @param onPlan (id) => called when a plan made in the background is ready, to tell the page
 */
export function createRouteWatcher({ gd, dir, notify, settings, actions = () => null, plan = planRoute, now = () => Date.now(), maker = null, onPlan = () => {} }) {
  const file = join(dir, 'routes.json');
  let routes = {};
  try {
    if (existsSync(file)) routes = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // unreadable: start with no plans
  }
  const write = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(routes));
  };
  const latest = new Map(); // save id -> last parse, to plan again on request
  const warned = new Set(); // plans already warned about bank space (by when they were made)
  const making = new Map(); // save id -> the plan being made in the background (a promise)

  // Your own goals from the Goals page (sent with the alert settings): they go first in a plan, and a
  // plan made before you changed them is made again.
  const targets = () => (settings().goals ?? []).filter((g) => g?.skill && g.target > 0).map(({ skill, target }) => ({ skill, target }));
  const goalsKey = () => JSON.stringify(targets().map((t) => `${t.skill}|${t.target}`).sort());
  const inputs = (save) => planInputs(gd, save, { useBonuses: settings().useBonuses !== false });

  // A new plan: made here and returned, or (with a maker) started in the background and returned as a
  // promise, which says what's new when it's ready. Only one at a time per save.
  function make(id, save, why, prefer) {
    const input = inputs(save);
    // Your own speed at what you've done a while.
    const speed = actions(id) ? speedFactors(gd, actions(id), input.levels) : {};
    const job = { save, why, prefer, useBonuses: settings().useBonuses !== false, targets: targets(), speed, madeAt: now(), goalsKey: goalsKey() };
    if (!maker) return keep(id, makePlan(gd, job, plan));
    if (!making.has(id)) {
      const pending = maker(job)
        .then((locked) => {
          keep(id, locked);
          // What's new, against the latest autosave (it may have moved on while the plan was made).
          const progress = routeProgress(gd, locked, inputs(latest.get(id) ?? save));
          if (progress.newlyDone.length) {
            locked.done.push(...progress.newlyDone);
            write();
          }
          send(events(null, { ...progress, madeAt: locked.madeAt }, why));
          onPlan(id);
          return locked;
        })
        .catch((e) => {
          console.error(`Could not make a plan: ${e.message}`);
          return null;
        })
        .finally(() => making.delete(id));
      making.set(id, pending);
    }
    return making.get(id);
  }

  function keep(id, locked) {
    routes[id] = locked;
    write();
    return locked;
  }

  // What to tell you: a new plan, a goal reached or steps done (`before`: the steps done before this
  // autosave; null for a plan made just now), and what's next.
  function events(before, progress, why) {
    const out = [];
    const flat = progress.legs.flatMap((l) => l.steps);
    const next = progress.step ? `Next: ${describeStep(gd, progress.step)}` : '';
    if (why?.ranOut) out.push({ title: `Out of ${gd.itemName(why.ranOut)}: new plan`, body: next });
    else if (why?.short) out.push({ title: `Not enough ${gd.itemName(why.short)} any more: new plan`, body: next });
    else if (why?.done) out.push({ title: 'Plan finished: here’s the next one', body: next });
    else if (why?.goals) out.push({ title: 'Your goals changed: new plan', body: next });
    // Said once per plan: the bank won't hold what it brings in.
    if (progress.space && !warned.has(progress.madeAt)) {
      warned.add(progress.madeAt);
      out.push({ title: `Bank space: ${progress.space.short} more slot${progress.space.short === 1 ? '' : 's'} needed`, body: 'Your plan brings in new items your bank has no room for. Your plan on Home says what to clear.' });
    }
    if (!before) return out;
    const goals = progress.legs.filter((l) => l.done && l.steps.some((st) => !before.has(st.id)));
    if (goals.length) {
      const g = goals.at(-1);
      const title = g.kind === 'gear' ? `${g.label} made: equip it` : g.kind === 'mastery' ? `${gd.skillName(g.skill)} Mastery: ${g.label}` : `${gd.skillName(g.skill)} ${g.to} reached`;
      const what = g.kind === 'unlock' ? (g.unlocks.length ? `Unlocks ${g.unlocks.map((m) => m.name).slice(0, 3).join(', ')}.` : '') : g.reasons[0] ? `${g.reasons[0]}.` : '';
      out.push({ title, body: [what, next].filter(Boolean).join(' ') });
      return out;
    }
    const steps = flat.filter((st) => st.done && !before.has(st.id));
    if (steps.length === 1) out.push({ title: `Done: ${describeStep(gd, steps[0], { left: false })}`, body: next });
    else if (steps.length > 1) out.push({ title: `${steps.length} plan steps done`, body: next });
    return out;
  }

  // One notification per autosave at most.
  function send(list) {
    const s = settings();
    if (!list.length || !s.enabled || s.planSteps === false) return;
    notify(list[0].title, list.slice(1).reduce((body, e) => `${body} · ${e.title}`, list[0].body ?? ''));
  }

  /** A new parse of a save: move its plan on (or make one) and say what changed. */
  function onSave(id, save) {
    latest.set(id, save);
    const input = inputs(save);
    let locked = routes[id];
    let progress = locked && routeProgress(gd, locked, input);
    let why = null;
    let fresh = false;
    const due = !locked || now() - (locked.madeAt ?? 0) > REPLAN_MS;
    // A shortfall something you can do now makes up gets a top-up step in the same plan (routeProgress).
    // One nothing can make up means a new plan from the bank as it is now, unless this plan was only just
    // made for that same shortage (the planner had no better way, so don't keep churning).
    const short = progress?.short && !(locked?.why?.short === progress.short.item && now() - (locked.madeAt ?? 0) < SHORT_REPLAN_MS) ? progress.short : null;
    // Goals you've added or removed since this plan was made: plan again for them.
    const goalsChanged = !!locked && (locked.goalsKey ?? '[]') !== goalsKey();
    if (!locked || progress.broken || goalsChanged || (due && (progress.finished || progress.blocked || short))) {
      why = !locked || progress.broken ? null : goalsChanged ? { goals: true } : progress.finished ? { done: true } : progress.blocked ? { ranOut: progress.blocked } : { short: short.item, need: short.need, have: short.have };
      const made = make(id, save, why, locked?.decisions);
      if (typeof made?.then === 'function') {
        // Being made in the background: it says what's new when it's ready. Until then the plan you had
        // keeps ticking off, if there is one that still works.
        if (!locked || progress.broken) return [];
        why = null;
      } else {
        locked = made;
        progress = routeProgress(gd, locked, input);
        fresh = true;
      }
    }
    const before = new Set(locked.done);
    if (progress.newlyDone.length) {
      locked.done.push(...progress.newlyDone);
      write();
    }
    const list = events(fresh ? null : before, { ...progress, madeAt: locked.madeAt }, why);
    send(list);
    return list;
  }

  /** A new plan now, from the latest autosave of that save: the plan, or a promise of it with a maker. */
  function replan(id) {
    const save = latest.get(id);
    if (!save) return null;
    return make(id, save, null, null);
  }

  return { onSave, replan, get: (id) => routes[id] ?? null, making: (id) => making.has(id) };
}
