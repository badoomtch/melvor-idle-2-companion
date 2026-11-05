// The plan on What next, kept by the companion itself (history/routes.json, never near the game's
// files) and checked against every autosave: steps tick off, a new plan is made when one is finished or
// stuck, and a desktop notification says what's done and what's next, page open or not. The page shows
// the plan and can ask for a new one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speedFactors } from '../engine/accuracy.js';
import { bankCapacity, bankRoom } from '../engine/bank-space.js';
import { currentActivity } from '../engine/advisor.js';
import { demoOnlyFor, playerBonuses, playerState } from '../engine/gamedata.js';
import { extraGoals } from '../engine/route-goals.js';
import { describeStep, lockRoute, routeProgress } from '../engine/route-progress.js';
import { planRoute } from '../engine/route.js';

// A plan that's stuck or finished is planned again at most this often, so a plan that can't start
// doesn't send a new notification with every autosave.
const REPLAN_MS = 60_000;
const SHORT_REPLAN_MS = 10 * 60_000;

/**
 * @param actions (id) => what each action has really given you so far (the observation store's record),
 *   so plans use your own speed where it's been measured
 */
export function createRouteWatcher({ gd, dir, notify, settings, actions = () => null, plan = planRoute, now = () => Date.now() }) {
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

  // What the planner needs from a save: levels, XP, what you own, and what you're doing.
  function inputs(save) {
    gd.player = playerState(save, gd);
    gd.playerBonuses = settings().useBonuses === false ? null : playerBonuses(gd, save);
    gd.demoOnly = demoOnlyFor(settings().demoOnly, save);
    const levels = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.level]));
    const xp = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.xp]));
    return { levels, xp, bank: gd.player.owned, mastery: save.mastery ?? null, current: currentActivity(gd, save.header, levels)?.method?.key ?? null,
      bankItems: save.bank?.items ?? {}, room: bankRoom(gd, save) ?? { items: {}, free: bankCapacity(gd, save).free } };
  }

  function make(id, save, why, prefer) {
    const input = inputs(save);
    // Gear to make and Mastery ranks to earn: slow to work out, so only when a plan is made.
    let extras = [];
    try {
      extras = extraGoals(gd, save, input);
    } catch (e) {
      console.error(`Could not weigh gear and Mastery goals: ${e.message}`);
    }
    // Your own speed at what you've done a while.
    const speed = actions(id) ? speedFactors(gd, actions(id), input.levels) : {};
    gd.planSpeed = Object.keys(speed).length ? speed : null;
    let route;
    try {
      route = plan(gd, { ...input, prefer, extras, purchased: save.shopPurchases ?? {} });
    } finally {
      gd.planSpeed = null;
    }
    const locked = { ...lockRoute(route, { madeAt: now(), speed }), why };
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
    // Said once per plan: the bank won't hold what it brings in.
    if (progress.space && !warned.has(progress.madeAt)) {
      warned.add(progress.madeAt);
      out.push({ title: `Bank space: ${progress.space.short} more slot${progress.space.short === 1 ? '' : 's'} needed`, body: 'Your plan brings in new items your bank has no room for. What next says what to clear.' });
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
    if (!locked || progress.broken || (due && (progress.finished || progress.blocked || short))) {
      why = !locked || progress.broken ? null : progress.finished ? { done: true } : progress.blocked ? { ranOut: progress.blocked } : { short: short.item, need: short.need, have: short.have };
      locked = make(id, save, why, locked?.decisions);
      progress = routeProgress(gd, locked, input);
      fresh = true;
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

  /** A new plan now, from the latest autosave of that save. */
  function replan(id) {
    const save = latest.get(id);
    if (!save) return null;
    return make(id, save, null, null);
  }

  return { onSave, replan, get: (id) => routes[id] ?? null };
}
