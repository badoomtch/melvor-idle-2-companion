// The route through your next unlocks: shared by What next and the "Right now" panel. With a save it's
// planned once and kept: each autosave only ticks off what you've done, so it doesn't change under you.
import { currentActivity } from '/engine/advisor.js';
import { bankRoom, freeSpaceOptions } from '/engine/bank-space.js';
import { describeStep, GATHER_VERBS, lockRoute, routeProgress, STEP_VERBS, trainEnd } from '/engine/route-progress.js';
import { planRoute } from '/engine/route.js';
import { shopOffer } from '/engine/shop.js';
import { toolbeltForStep } from '/engine/toolbelt-advice.js';
import { ago, badge, duration, esc, exact, pct } from '/ui/format.js';
import { masteryPlanFor } from './mastery-ui.js';
import { card, huntingTodoNote, itemLink, memo, methodLink, saveKey, skillName } from './shared.js';

// The method you're doing in the game (null when idle, fighting or not reading a save).
export const currentMethodKey = (ctx) => (ctx.save && ctx.state.levelSource === 'save' ? currentActivity(ctx.gd, ctx.save.header, ctx.levels)?.method?.key ?? null : null);

/**
 * Your plan and where you are on it. With a save, the companion keeps the plan (server/route-watcher.js):
 * it's made once, moved on by every autosave, and planned again when it's done or stuck, so it doesn't
 * change under you. Without one (levels entered by hand), it's planned here from your levels.
 */
export function routeFor(ctx) {
  const { gd } = ctx;
  const current = currentMethodKey(ctx);
  const read = (locked) => ({ ...routeProgress(gd, locked, { levels: ctx.levels, xp: ctx.xp, bank: ctx.stock, current, mastery: ctx.save?.mastery ?? null, room: bankRoom(ctx.gd, ctx.save) }), madeAt: locked.madeAt, why: locked.why ?? null, kept: !!locked.kept, speed: locked.speed ?? null });
  const kept = ctx.state.levelSource === 'save' && ctx.save && ctx.state.plan?.id === ctx.save.id ? ctx.state.plan : null;
  if (kept) return read({ ...kept, kept: true });
  return read(memo('route', saveKey(ctx), () => lockRoute(planRoute(gd, { levels: ctx.levels, xp: ctx.xp, bank: ctx.stock, current }))));
}

// One step in words, with what's still to do: training says how many more and to what level; gathering
// says how many more of what you end up with.
export function stepLine(ctx, st) {
  const skill = esc(skillName(ctx, st.method.skill));
  const left = st.done || !st.left ? null : st.left;
  if (st.kind === 'task') {
    const n = left ? left.actions : st.actions;
    const progress = left?.progress != null ? ` (${exact(Math.floor(left.progress))}/${exact(st.task.of)})` : '';
    return `${STEP_VERBS[st.method.kind] ?? 'Do'} ${methodLink(st.method)} × ${exact(n)} <span class="muted">for Mastery: ${esc(st.task.label)}${progress}</span>`;
  }
  if (st.kind === 'train') {
    const n = left ? left.actions : st.actions;
    const end = trainEnd(ctx.gd, st, { item: (id) => itemLink(ctx, id), skill });
    return `${STEP_VERBS[st.method.kind] ?? 'Do'} ${methodLink(st.method)} × ${exact(n)}${left && n < st.actions ? ' more' : ''} <span class="muted">${end}</span>`;
  }
  const qty = Math.ceil(left?.qty ?? st.qty);
  const named = st.method.name.toLowerCase() === ctx.gd.itemName(st.item).toLowerCase();
  return `${GATHER_VERBS[st.method.kind] ?? 'Get'} ${exact(qty)}${left && qty < Math.ceil(st.qty) ? ' more' : ''} ${itemLink(ctx, st.item)} <span class="muted">(${skill}${named ? '' : `, from ${methodLink(st.method)}`})</span>`;
}

// How far along a step is: "143 of 213 done".
function progressNote(st) {
  if (st.done || !st.left || st.kind === 'task') return '';
  if (st.kind === 'train') return st.left.actions < st.actions ? `${exact(st.actions - st.left.actions)} of ${exact(st.actions)} done` : '';
  const total = Math.ceil(st.qty + (st.extra ?? 0));
  const left = Math.ceil(st.left.qty ?? total);
  return left < total ? `${exact(total - left)} of ${exact(total)} done` : '';
}

// Open Mastery Guild tasks that doing this method counts towards.
function masteryTasks(ctx, key) {
  const plans = masteryPlanFor(ctx);
  if (!plans) return [];
  return plans.flatMap((p) => p.open.filter((t) => t.hours != null && t.how?.method?.key === key)).sort((a, b) => a.hours - b.hours).slice(0, 1);
}

// What a goal is, in its heading: the level an unlock is at, the gear to make, the Mastery rank to earn.
function goalTitle(ctx, leg) {
  const skill = `<a href="#/skills/${leg.skill}">${esc(skillName(ctx, leg.skill))}</a>`;
  if (leg.kind === 'gear') return `Make ${itemLink(ctx, leg.item)}`;
  if (leg.kind === 'mastery') return `${skill} Mastery: ${esc(leg.label)}`;
  return `${skill} ${leg.from} → ${leg.to}`;
}

// What it gets you: what an unlock unlocks, or the levels a piece of gear needs first.
function goalWhat(ctx, leg) {
  if (leg.kind === 'gear') return leg.to > leg.from ? `Gets ${esc(skillName(ctx, leg.skill))} to ${leg.to} first, then makes it. Equip it once it's made.` : "You can make it now. Equip it once it's made.";
  if (leg.kind === 'mastery') return 'Its tasks, done the quickest way: they count whenever you do these actions.';
  return `Unlocks ${unlockText(leg)}`;
}

const unlockText = (leg) => {
  const names = leg.unlocks.map((m) => m.name);
  const shown = names.slice(0, 4).map(esc).join(', ');
  return names.length > 4 ? `<span title="${esc(names.join(', '))}">${shown} and ${names.length - 4} more</span>` : shown;
};

// Done or not, read from your save: nothing to tick.
const tick = (st) => `<span class="route-tick" aria-hidden="true">${st.done ? '✓' : ''}</span>`;

// Toolbelt swaps from your bank that make a step faster, or that it needs.
function stepTools(ctx, st) {
  if (!ctx.save?.bank || ctx.state.levelSource !== 'save' || !ctx.gd.raw.toolbelts) return null;
  return memo(`route:tools:${st.kind}:${st.method.key}:${st.item ?? ''}`, saveKey(ctx), () => toolbeltForStep(ctx.gd, ctx.save, st, { levels: ctx.levels }));
}
const toolsKey = (t) => `${t.needed}|${t.changes.map((c) => `${c.slot.id}=${c.item}`).join('|')}`;

// "Put on Balaclava instead of Fire Wizard Hat (Thieving Helmet): 13% faster, saves 9 min", for `steps`
// steps that take `hours` between them.
function toolsLine(ctx, t, hours, steps = 1) {
  const what = t.changes.map((c) => `${itemLink(ctx, c.item)}${c.replaces ? ` instead of ${itemLink(ctx, c.replaces)}` : ''} <span class="muted">(${esc(c.slot.name)}${c.usedUp ? `, used up as you go, you have ${exact(c.have)}` : ''})</span>`).join(' and ');
  if (t.needed) return `<span class="sub small accent-text">Put on ${what} first: ${steps > 1 ? 'these steps need' : 'this step needs'} ${t.changes.length > 1 ? 'them' : 'it'}</span>`;
  const set = t.changes.find((c) => c.set)?.set;
  const saved = hours * (1 - 1 / (1 + t.gain));
  const saves = saved >= 1 / 60 ? `, saves ${duration(saved)}${steps > 1 ? ` over the next ${steps} steps` : ''}` : '';
  return `<span class="sub small accent-text">Put on ${what}${set ? ` for the ${esc(set)} bonus` : ''}: ${pct(t.gain, t.gain < 0.1 ? 1 : 0)} faster${saves}</span>`;
}

// The toolbelt line for each step of a goal: said once, on the first step it helps, with what it saves
// over every step it helps.
function goalTools(ctx, steps) {
  const groups = new Map();
  for (const st of steps) {
    const t = stepTools(ctx, st);
    if (!t) continue;
    const key = toolsKey(t);
    if (!groups.has(key)) groups.set(key, { t, first: st, hours: 0, steps: 0 });
    const g = groups.get(key);
    g.hours += st.left.hours;
    g.steps++;
  }
  return new Map([...groups.values()].map((g) => [g.first, toolsLine(ctx, g.t, g.hours, g.steps)]));
}

// What the step uses up, so you can tell it from a recipe that looks the same in the game ("Uses 22
// Rabbit Fur, 66 Leather and 66 String").
function usesNote(ctx, st) {
  const list = [...(st.uses ?? [])].map(([item, each]) => [item, Math.ceil(each * (st.left?.actions ?? st.actions) - 1e-9)]).filter(([, n]) => n > 0);
  if (!list.length) return '';
  const parts = list.map(([item, n]) => `${exact(n)} ${itemLink(ctx, item)}`);
  return `<span class="sub muted small">Uses ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}</span>`;
}

// A step your bank won't cover any more (counting what the steps before it make and use).
function shortNote(ctx, st) {
  if (!st.short) return '';
  const { item, need, have } = st.short;
  // Something you can do now makes up the difference: the step above does it, and the plan stays.
  if (st.short.topUp) return `<span class="sub small muted">Needs ${exact(need)} ${itemLink(ctx, item)} and you'll have ${exact(have)}, so the step before this gets the other ${exact(need - have)}.</span>`;
  const buy = buyNote(ctx, { kind: 'gather', item, qty: need - have });
  return `<span class="sub small warn-text">Needs ${exact(need)} ${itemLink(ctx, item)} and you'll have ${exact(have)}. ${ctx.state.plan ? 'The plan updates with your next autosave.' : 'Get more first, or make a new plan.'}</span>${buy}`;
}

// The shop sells what a step gathers: the other way to get it, often far quicker. Buying ticks the
// step off too, since steps count what's in your bank.
function buyNote(ctx, st) {
  if (st.kind !== 'gather' && st.kind !== 'make') return '';
  const qty = Math.ceil(st.left?.qty ?? st.qty ?? 0);
  if (!(qty > 0)) return '';
  const wallet = ctx.save ? { ...(ctx.save.wallet ?? {}), GoldPieces: ctx.save.wallet?.GoldPieces ?? ctx.save.header?.gp ?? 0 } : null;
  const offer = shopOffer(ctx.gd, st.item, qty, { levels: ctx.levels, purchased: ctx.save?.shopPurchases ?? {}, wallet });
  if (!offer) return '';
  const cost = [...offer.currencies.map((c) => `${exact(c.qty)} ${esc(ctx.gd.currencyName(c.currency))}`), ...offer.items.map((i) => `${exact(i.qty)} ${itemLink(ctx, i.item)}`)].join(' + ');
  const short = offer.currencies.find((c) => c.have != null && c.have < c.qty);
  return `<span class="sub small accent-text">Or buy ${exact(offer.qty)} in the <a href="#/shop">shop</a> for ${cost}${short ? ` (you have ${exact(short.have)} ${esc(ctx.gd.currencyName(short.currency))})` : ''}.</span>`;
}

function stepItem(ctx, leg, st, now, tools = '') {
  const notes = [];
  const progress = progressNote(st);
  if (progress) notes.push(progress);
  if (st.topUp) notes.push('added because you have less than the plan expected');
  if (st.extra > 0) notes.push(`${exact(Math.ceil(st.extra))} more than planned, because you have less than the plan expected`);
  const short = shortNote(ctx, st);
  const side = st.levelUps.filter((u) => st.kind !== 'train' || u.skill !== leg.skill);
  if (side.length) notes.push(`also gets you ${side.map((u) => `${esc(skillName(ctx, u.skill))} ${u.level}`).join(', ')}`);
  const mastery = masteryTasks(ctx, st.method.key).map((t) => `<span class="sub small accent-text">Counts for Mastery: ${esc(t.label)}${t.progress && !t.progress.level ? ` (${exact(Math.floor(t.progress.done))}/${exact(t.progress.of)})` : ''}</span>`);
  const cls = st === now ? (st.on ? ' class="now on"' : ' class="now"') : '';
  return `<li${cls}>${tick(st)}<span class="route-text">${stepLine(ctx, st)}${st === now ? ` <span class="pill ${st.on ? 'good' : 'accent'}">${st.on ? "You're on this" : 'Next'}</span>` : ''}${notes.length ? `<span class="sub muted small">${notes.join(' · ')}</span>` : ''}${short}${buyNote(ctx, st)}${huntingTodoNote(ctx, st.method)}${mastery.join('')}${tools}</span><span class="num">${duration(st.left.hours)}</span></li>`;
}

// The bank won't hold what the plan brings in: how many slots, from when, and the easiest ways to free them.
function spaceNote(ctx, route) {
  const sp = route.space;
  if (!sp) return '';
  const { gd } = ctx;
  const step = route.legs.flatMap((l) => l.steps).find((st) => st.id === sp.at);
  const options = freeSpaceOptions(gd, ctx.bank, ctx.levels, ctx.save?.bank ?? {}).slice(0, 4);
  const ways = options.map((o) => (o.kind === 'placeholders' ? `remove ${exact(o.slots)} empty placeholder${o.slots === 1 ? '' : 's'}`
    : o.kind === 'craft' ? `make ${exact(o.crafts)} ${esc(o.method.name)} (${o.slots} slot${o.slots === 1 ? '' : 's'})` : `${o.kind} your ${esc(gd.itemName(o.item))}`));
  const kept = options.some((o) => o.kept) ? ' Your bank keeps a placeholder when a stack runs out, so remove it afterwards to get the slot back.' : '';
  return `<p class="notice warn"><strong>Make room in your bank: ${exact(sp.short)} more slot${sp.short === 1 ? '' : 's'} needed.</strong> Your plan brings in ${exact(sp.items.length)} kinds of item your bank doesn't hold (${sp.items.slice(0, 4).map((i) => esc(gd.itemName(i))).join(', ')}${sp.items.length > 4 ? ' and more' : ''}) and has ${exact(sp.free)} free${step ? `; it fills up at "${esc(describeStep(gd, step, { left: false }))}"` : ''}. The game stops when it can't take a new item.${ways.length ? ` Easiest: ${ways.join(', ')}.${kept} <a href="#/bank">Bank</a>` : ''}</p>`;
}

export function routeCard(ctx) {
  const route = routeFor(ctx);
  const locked = route.kept;
  const intro = `<p class="small muted">Your next unlocks, gear worth making and Mastery ranks, in the order that pays off most. ${locked ? 'Steps tick off from your saves as you play, and you get a new plan when this one is done or you run out of something it needs.' : ctx.save ? 'Restart the companion to keep this plan between autosaves and tick steps off as you go.' : 'No save loaded, so it assumes you have the materials.'}</p>`;
  const replan = locked ? `<span class="route-made muted small">Planned ${esc(ago(route.madeAt))} · <button class="link" data-action="replan">Make a new plan</button></span>` : '';
  const title = `Your plan <span class="muted small">· ${route.legs.filter((l) => !l.done).length} goals, ${duration(route.hours)} left</span>`;
  if (!route.legs.length || route.finished) return card(title, `${intro}<p class="muted">Nothing left to unlock that the companion can plan.</p>${replan}`);
  const why = route.why?.ranOut
    ? `<p class="notice">New plan: you ran out of ${esc(ctx.gd.itemName(route.why.ranOut))} and nothing in the old one made more.</p>`
    : route.why?.short
      ? `<p class="notice">New plan: the old one needed ${exact(route.why.need)} ${esc(ctx.gd.itemName(route.why.short))} and you had ${exact(route.why.have)}, so this one starts from your bank as it is now.</p>`
      : route.why?.done ? '<p class="notice">New plan: you finished the last one.</p>' : '';
  const now = route.step;
  // Only what's left: finished goals and steps drop off.
  const open = route.legs.filter((l) => !l.done);
  const goalOf = open.findIndex((l) => l.steps.includes(now));
  const nowTools = stepTools(ctx, now);
  const head = `<div class="route-now${now.on ? ' on' : ''}"><span><span class="route-label">${now.on ? "You're on it" : 'Do this now'}</span><strong>${stepLine(ctx, now)}</strong>
    <span class="sub muted small">For goal ${goalOf + 1}: ${goalTitle(ctx, open[goalOf])}${progressNote(now) ? ` · ${progressNote(now)}` : ''}</span>${usesNote(ctx, now)}${shortNote(ctx, now)}${buyNote(ctx, now)}${huntingTodoNote(ctx, now.method)}${nowTools ? toolsLine(ctx, nowTools, now.left.hours) : ''}</span><span class="num">${duration(now.left.hours)}</span></div>`;
  const goals = open.map((leg, i) => {
    const left = leg.steps.filter((st) => !st.done);
    const gathers = left.filter((st) => st.kind === 'gather' || st.kind === 'make');
    const trains = left.filter((st) => st.kind === 'train' || st.kind === 'task');
    const doneCount = leg.steps.length - left.length;
    const tools = goalTools(ctx, [...gathers, ...trains]);
    const item = (st) => stepItem(ctx, leg, st, now, tools.get(st));
    const list = gathers.length
      ? `<li class="route-sub">${leg.kind === 'gear' && !trains.length ? 'Make it' : 'Stock up'}</li>${gathers.map(item).join('')}${trains.length ? `<li class="route-sub">Then train</li>${trains.map(item).join('')}` : ''}`
      : trains.map(item).join('');
    return `<li class="route-goal${i === goalOf ? ' current' : ''}">
      <div class="route-goal-head"><span class="route-num" aria-label="Goal ${i + 1}">${i + 1}</span>
        <span class="route-goal-title">${badge(leg.skill, skillName(ctx, leg.skill))} <strong>${goalTitle(ctx, leg)}</strong>
          <span class="sub small">${goalWhat(ctx, leg)}</span>${leg.reasons?.length ? `<span class="sub small accent-text">Why: ${leg.reasons.map(esc).join(' · ')}</span>` : ''}</span>
        <span class="num">${duration(leg.hours)}<span class="sub muted small">${exact(doneCount)} of ${exact(leg.steps.length)} steps done</span></span></div>
      <ul class="route-steps">${list}</ul></li>`;
  });
  return card(title, `${intro}${replan}${why}${spaceNote(ctx, route)}${head}<ol class="route">${goals.join('')}</ol>`);
}
