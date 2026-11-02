// The side menu, the top bar (theme picker, save picker, live pill).
import { currentActivity } from '/engine/advisor.js';
import { bankCapacity } from '/engine/bank-space.js';
import { currentFight } from '/engine/current-fight.js';
import { farmingPlots, plotRanges } from '/engine/farming-plots.js';
import { masteryPlan } from '/engine/mastery-plan.js';
import { rareItemsFrom } from '/engine/rare-items.js';
import { describeStep } from '/engine/route-progress.js';
import { activityKey, currentSupplies, totalXp } from '/engine/supplies.js';
import { ago, badge, duration, esc, exact, iconImg, num } from '/ui/format.js';
import { doing } from './rare.js';
import { routeFor } from './route-ui.js';
import { memo, methodIcon, saveKey, skillName } from './shared.js';

// Page renderers. Each takes the view context built by app.js and returns HTML.

// Side menu: id, label, and the game's own icon for it.
export const TABS = [
  ['overview', 'Overview', 'res://Assets/Icons/Statistics_64.png'],
  ['next', 'What next?', 'res://Assets/Icons/GuideBook.png'],
  ['away', 'Away planner', 'res://Assets/Icons/sleep.png'],
  ['skills', 'Skills', 'res://Assets/Icons/Mastery_Icon_48.png'],
  ['toolbelts', 'Toolbelts', 'res://Assets/Items/RanchersBelt.png'],
  ['mastery', 'Mastery', 'res://Assets/Icons/Milestones.png'],
  ['money', 'Money', 'res://Assets/Currencies/GoldPieces.svg'],
  ['bank', 'Bank', 'res://Assets/Icons/Bank_64.png'],
  ['shop', 'Shop planner', 'res://Assets/Icons/Shop_64.png'],
  ['combat', 'Combat', 'res://Assets/Icons/Combat_64.png'],
  ['slayer', 'Slayer', 'res://Assets/Icons/Slayer.png'],
  ['calculators', 'Calculators', 'res://Assets/Items/SandsofTime.png'],
  ['lookup', 'Lookup', 'res://Assets/Icons/search.png'],
  ['rare', 'Rare items', 'res://Assets/Items/TreasureChest.png'],
  ['goals', 'Goals', 'res://Assets/Icons/CheckeredFlag.png'],
  ['quests', 'Quests', 'res://Assets/Icons/Quests.png'],
  ['history', 'History', 'res://Assets/Icons/history.png'],
  ['completion', 'Completion', 'res://Assets/Icons/Completion_64.png'],
  ['accuracy', 'Accuracy', 'res://Assets/Icons/Accurate.png'],
  ['settings', 'Settings', 'res://Assets/Icons/Settings_64.png'],
];

// ---------- top bar ----------

export const THEMES = [
  { id: 'system', name: 'Match my system', swatch: ['#f4f2ee', '#131519', '#e6b552'] },
  { id: 'light', name: 'Light', swatch: ['#f4f2ee', '#ffffff', '#8f6210'] },
  { id: 'dark', name: 'Dark', swatch: ['#131519', '#1b1e23', '#e6b552'] },
  { id: 'melvor', name: 'Melvor', swatch: ['#0f1626', '#1f2b45', '#f2c14e'] },
  { id: 'forest', name: 'Forest', swatch: ['#0f1913', '#1d2f24', '#93d46e'] },
  { id: 'ember', name: 'Ember', swatch: ['#1a1210', '#2f201c', '#ff8f52'] },
  { id: 'parchment', name: 'Parchment', swatch: ['#ece2cd', '#f8f1e2', '#8a4710'] },
];

const swatch = (t) => `<span class="swatch-dots" aria-hidden="true">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span>`;
const themeLabel = (t) => (t.id === 'system' ? 'System' : t.name);

// Theme menu: the colours and the full name of each theme, so nothing gets cut off like it did in a select.
function themeMenu(state) {
  const current = THEMES.find((t) => t.id === state.theme) ?? THEMES[0];
  const items = THEMES.map((t) => `<button type="button" role="menuitemradio" aria-checked="${t.id === current.id}" data-action="theme" data-value="${t.id}">${swatch(t)}<span>${esc(t.name)}</span></button>`).join('');
  return `<details class="theme-menu" id="theme-menu"><summary title="Theme" aria-label="Theme: ${esc(current.name)}">${swatch(current)}<span class="theme-name">${esc(themeLabel(current))}</span></summary><div class="menu" role="menu">${items}</div></details>`;
}

export function renderSaveBar(ctx) {
  const { state } = ctx;
  const saves = state.status?.saves ?? [];
  const parts = [themeMenu(state)];
  if (saves.length > 1) {
    parts.push(`<select data-bind="saveId" aria-label="Choose save">${saves
      .map((s) => `<option value="${esc(s.id)}"${s.id === state.saveId ? ' selected' : ''}>${esc(s.name || 'Unnamed')} · total ${exact(s.totalLevel)}</option>`)
      .join('')}</select>`);
  }
  parts.push(`<span id="live-pill">${renderLivePill(ctx)}</span>`);
  parts.push('<button class="link pop-out" data-action="popOut" title="A small always-on-top window with what you\'re doing">Pop out</button>');
  return parts.join('');
}

// The game autosaves every 10 seconds; longer silences mean it is paused or closed.
export const AUTOSAVE_MS = 10_000;
const STALE_MS = 120_000;

// What needs you now, for the top bar: out of (or nearly out of) what your action uses, nothing
// training, no XP for 90 seconds, the game no longer saving, a full bank. Each stays while it's true,
// unlike the pop-ups. When the game has stopped saving, that's the only one: the rest would be stale.
export function topAlerts(ctx) {
  const { gd, state, save } = ctx;
  if (!save || state.levelSource !== 'save' || !gd) return [];
  const age = Date.now() - save.header.timestamp;
  if (state.live.connected && age > STALE_MS) {
    return [{ level: 'warn', text: `No autosave for ${duration(age / 3_600_000)}`, title: 'The game may be closed, paused or frozen.' }];
  }
  const out = [];
  const doing = activityKey(save.header);
  if (!doing) out.push({ level: 'warn', text: 'Nothing is training', href: '#/next', title: 'See What next for what to do.' });
  for (const s of currentSupplies(gd, save, ctx.levels, ctx.stock)) {
    const name = gd.itemName(s.item);
    const icon = gd.items[s.item]?.icon;
    if (s.qty <= 0) out.push({ level: 'bad', text: `Out of ${name}`, icon, href: '#/overview', title: `${doing} uses it, and you have none left.` });
    else if (s.hoursLeft * 60 <= state.alerts.minutes) out.push({ level: 'warn', text: `${name}: ${duration(s.hoursLeft)} left`, icon, href: '#/overview', title: `${exact(s.qty)} left at about ${num(s.perHour)} an hour.` });
  }
  // Same action for 90 seconds of autosaves without any XP: stuck (bank full, nothing to burn, ...).
  const recent = (save.history ?? []).slice(-10);
  if (doing && recent.length >= 10 && recent.at(-1).t - recent[0].t >= 85_000 && totalXp(recent[0]) === totalXp(recent.at(-1))) {
    out.push({ level: 'bad', text: 'No XP for 90 seconds', title: `${doing} isn't gaining anything. Is it stuck?` });
  }
  const bank = bankCapacity(gd, save);
  if (bank && bank.free <= 0) out.push({ level: 'warn', text: 'Bank is full', href: '#/bank', title: 'New kinds of item have nowhere to go, so the game stops picking them up.' });
  return out;
}

export function renderTopAlerts(ctx, list = topAlerts(ctx)) {
  const chip = (a) => {
    const inner = `${a.icon ? iconImg(a.icon, 'icon sm') : ''}<span>${esc(a.text)}</span>`;
    const attrs = `class="top-alert ${a.level}"${a.title ? ` title="${esc(a.title)}"` : ''}`;
    return a.href ? `<a ${attrs} href="${a.href}">${inner}</a>` : `<span ${attrs}>${inner}</span>`;
  };
  return list.map(chip).join('');
}
// Same width every second: a ring fills until the next autosave is due, and the seconds sit in a fixed slot.
export function renderLivePill(ctx) {
  const { state } = ctx;
  if (state.levelSource === 'manual') return '<span class="pill accent">Manual levels</span>';
  if (!ctx.save) return '<a class="pill warn" href="#/settings">No save found</a>';
  if (!state.live.connected) return '<span class="pill bad" title="Start the companion again to reconnect">Companion stopped</span>';
  const age = Math.max(0, Date.now() - ctx.save.header.timestamp);
  if (age > 60_000) return `<span class="pill warn" title="No autosave for a while: the game may be paused or closed. Last saved ${esc(ago(ctx.save.header.timestamp))}.">Game idle</span>`;
  const secs = Math.floor(age / 1000);
  const next = Math.max(0, Math.ceil((AUTOSAVE_MS - age) / 1000));
  const due = Math.min(1, age / AUTOSAVE_MS);
  const title = `Updated ${secs}s ago. The game autosaves every 10 seconds${next > 0 ? `; the next is due in about ${next}s` : ''}.`;
  return `<span class="pill live${state.live.pulse ? ' pulse' : ''}" title="${title}"><svg class="save-ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6"/><circle class="fill" cx="8" cy="8" r="6" pathLength="100" style="stroke-dashoffset:${(100 - due * 100).toFixed(1)};animation-delay:-${Math.round(age)}ms"/></svg>Live<span class="pill-time">${secs}s</span></span>`;
}

// Menu items for what you're doing in the game right now, each with why: a green dot beside them on
// every page, apart from the highlight for the page you're looking at. Only while the game is saving.
function workingOn(ctx) {
  const { gd, state, save } = ctx;
  const out = new Map();
  if (!save || !gd || state.levelSource !== 'save' || Date.now() - save.header.timestamp > STALE_MS) return out;
  const h = save.header;
  const a = currentActivity(gd, h, ctx.levels);
  if (a?.skill) out.set('skills', `You're training ${skillName(ctx, a.skill)}`);
  if (h.activeEntityName === 'Combat' && h.activeActionName) {
    out.set('combat', `You're fighting ${h.activeActionName}`);
    const enemy = gd.enemies.find((e) => e.name.toLowerCase() === String(h.activeActionName).toLowerCase());
    const task = enemy && Object.values(save.slayer ?? {}).find((t) => t?.task === enemy.id && t.progress < t.length);
    if (task) out.set('slayer', `${enemy.name} is your Slayer task: ${exact(task.progress)} of ${exact(task.length)}`);
  }
  const step = routeFor(ctx).step;
  if (step?.on) out.set('next', `You're on your plan: ${describeStep(gd, step)}`);
  const d = doing(ctx);
  if (d) {
    const found = save.itemsFound;
    const missing = rareItemsFrom(gd, d.on).filter((item) => !(found?.[item.split(':').pop()] > 0));
    if (missing.length) out.set('rare', `${d.label} can give ${missing.length === 1 ? 'a rare item' : `${missing.length} rare items`} you haven't found`);
  }
  // An open Mastery Guild task this action counts towards (only that skill's guild, so it stays quick).
  if (a?.method && save.mastery) {
    const plans = memo('menu:mastery', `${saveKey(ctx)}|${a.skill}`, () => masteryPlan(gd, save, ctx.levels, { bank: ctx.stock, only: a.skill }));
    const task = plans.flatMap((p) => p.open.filter((t) => t.hours != null && t.how?.method?.key === a.method.key))[0];
    if (task) out.set('mastery', `${a.method.name} counts for Mastery: ${task.label}`);
  }
  const goal = a?.skill && state.goals.find((g) => g.skill === a.skill && (ctx.levels[g.skill] ?? 1) < g.target);
  if (goal) out.set('goals', `You're training towards ${skillName(ctx, goal.skill)} ${goal.target}`);
  return out;
}

export function renderTabs(route, ctx) {
  const on = ctx ? workingOn(ctx) : new Map();
  const link = ([id, label, icon]) => {
    const why = on.get(id);
    return `<a href="#/${id}"${route.tab === id ? ' aria-current="page"' : ''}${why ? ` class="doing" title="${esc(why)}"` : ''}>${iconImg(icon, 'icon nav-icon')}<span>${esc(label)}</span>${why ? `<span class="doing-dot" role="img" aria-label="${esc(why)}"></span>` : ''}</a>`;
  };
  return `<div class="nav-links">${TABS.map(link).join('')}</div>${ctx ? renderNavNow(ctx) : ''}`;
}

// ---------- "Now" panel under the side menu ----------

// What's going on in the game at a glance, refreshed with every autosave: the current action and its
// next level, what runs out first, the slayer task, the next goal, and gold.
export function renderNavNow(ctx) {
  const { gd, state, save } = ctx;
  if (!save || state.levelSource !== 'save') return '';
  const rows = [];
  const a = currentActivity(gd, save.header, ctx.levels);
  if (a?.skill) {
    const level = ctx.levels[a.skill];
    const prog = gd.xp.levelProgress(ctx.xp[a.skill], gd.levelCap);
    const measured = ctx.measured?.[a.skill];
    const rate = measured || a.rates?.xpPerHour || 0;
    const toNext = rate > 0 && level < gd.levelCap ? prog.xpForNext / rate : null;
    rows.push(`<a class="now-activity" href="#/skills/${esc(a.skill)}">
      <span class="now-head">${badge(a.skill, skillName(ctx, a.skill))}<span><strong>${esc(a.method?.name ?? a.label)}</strong><span class="now-sub">${esc(skillName(ctx, a.skill))} ${level}</span></span></span>
      <span class="bar" role="progressbar" aria-label="Progress to level ${level + 1}" aria-valuenow="${Math.round(prog.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(prog.progress * 100).toFixed(1)}%"></span></span>
      <span class="now-line"><span>${level >= gd.levelCap ? 'Max level' : `Level ${level + 1}`}</span><span class="num">${level >= gd.levelCap ? '' : toNext != null ? duration(toNext) : '–'}</span></span>
      ${rate ? `<span class="now-line"><span>XP/h${measured ? '' : ' (est.)'}</span><span class="num">${num(rate)}</span></span>` : ''}</a>`);
  } else if (currentFight(gd, save, ctx.levels)) {
    // A fight: the skill its stance trains most, and how long to that skill's next level.
    const f = currentFight(gd, save, ctx.levels);
    const level = ctx.levels[f.skill] ?? 1;
    const prog = gd.xp.levelProgress(ctx.xp[f.skill], gd.levelCap);
    const rate = ctx.measured?.[f.skill] || f.result.xpPerHour[f.skill] || 0;
    const toNext = rate > 0 && level < gd.levelCap ? prog.xpForNext / rate : null;
    rows.push(`<a class="now-activity" href="#/combat">
      <span class="now-head">${badge(f.skill, skillName(ctx, f.skill))}<span><strong>${esc(f.enemy.name)}</strong><span class="now-sub">${esc(skillName(ctx, f.skill))} ${level} · ${esc(f.style)}</span></span></span>
      <span class="bar" role="progressbar" aria-label="Progress to level ${level + 1}" aria-valuenow="${Math.round(prog.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(prog.progress * 100).toFixed(1)}%"></span></span>
      <span class="now-line"><span>${level >= gd.levelCap ? 'Max level' : `Level ${level + 1}`}</span><span class="num">${level >= gd.levelCap ? '' : toNext != null ? duration(toNext) : '–'}</span></span>
      <span class="now-line"><span>XP/h${ctx.measured?.[f.skill] ? '' : ' (est.)'}</span><span class="num">${num(f.result.combatXpPerHour)}</span></span></a>`);
  } else {
    rows.push(`<p class="now-idle">${a?.label ? esc(a.label) : 'Not training anything'}</p>`);
  }
  const supply = currentSupplies(gd, save, ctx.levels, ctx.stock)[0];
  if (supply) {
    const low = supply.hoursLeft * 60 <= state.alerts.minutes;
    rows.push(`<div class="now-line${low ? ' warn-text' : ''}" title="${esc(`${exact(supply.qty)} ${gd.itemName(supply.item)} left`)}"><span class="with-icon">${iconImg(gd.items[supply.item]?.icon, 'icon sm')}${esc(gd.itemName(supply.item))}</span><span class="num">${supply.qty > 0 ? duration(supply.hoursLeft) : 'Out'}</span></div>`);
  }
  // Farming: plots ready to harvest, else when the next one is ready (from the save's own time).
  const farm = farmingPlots(gd, save);
  if (farm?.ready.length) {
    const p = farm.ready[0];
    const crops = [...new Set(farm.ready.map((x) => x.method?.name ?? x.recipe))];
    rows.push(`<a class="now-line good-text" href="#/skills/Farming" title="${esc(`Ready to harvest: ${crops.join(', ')} (${plotRanges(farm.ready)})`)}"><span class="with-icon">${p.method ? methodIcon(gd, p.method) : ''}${esc(crops.length > 1 ? `${farm.ready.length} plots` : farm.ready.length > 1 ? `${crops[0]} × ${farm.ready.length}` : crops[0])}</span><span class="num">Ready</span></a>`);
  } else if (farm?.next) {
    const p = farm.next;
    rows.push(`<a class="now-line" href="#/skills/Farming" title="${esc(`Next harvest: ${p.method?.name ?? p.recipe} on ${p.name}`)}"><span class="with-icon">${p.method ? methodIcon(gd, p.method) : ''}${esc(p.method?.name ?? p.recipe)}</span><span class="num">${duration(Math.max(0, p.readyAt - Date.now()) / 3_600_000)}</span></a>`);
  }
  const task = Object.entries(save.slayer ?? {}).find(([, t]) => t?.task && t.progress < t.length);
  if (task) {
    const [, t] = task;
    rows.push(`<a class="now-line" href="#/slayer"><span class="with-icon">${iconImg('res://Assets/Icons/Slayer.png', 'icon sm')}${esc(gd.enemyById.get(t.task)?.name ?? t.task)}</span><span class="num">${exact(t.progress)}/${exact(t.length)}</span></a>`);
  }
  const goal = state.goals.find((g) => (ctx.levels[g.skill] ?? 1) < g.target);
  if (goal) {
    const remaining = Math.max(0, gd.xp.xpForLevel(goal.target) - (ctx.xp[goal.skill] ?? 0));
    const rate = ctx.measured?.[goal.skill];
    rows.push(`<a class="now-line" href="#/goals"><span class="with-icon">${iconImg('res://Assets/Icons/Quests.png', 'icon sm')}${esc(skillName(ctx, goal.skill))} ${goal.target}</span><span class="num">${rate ? duration(remaining / rate) : `${num(remaining)} XP`}</span></a>`);
  }
  // The step your plan is on, and how long it has left.
  const route = routeFor(ctx);
  const step = route.step;
  if (step) {
    const leg = route.legs.find((l) => l.steps.includes(step));
    const name = step.kind === 'train' ? step.method.name : gd.itemName(step.item);
    const count = step.kind === 'train' ? `${step.method.name} × ${exact(step.left.actions)}` : `${exact(Math.ceil(step.left.qty ?? step.qty))} ${name}`;
    rows.push(`<a class="now-line${step.on ? ' good-text' : ''}" href="#/next" title="${esc(`${step.on ? "You're on" : 'Next in'} your plan: ${count}, for ${skillName(ctx, leg.skill)} ${leg.to}`)}"><span class="with-icon">${iconImg('res://Assets/Icons/GuideBook.png', 'icon sm')}${esc(name)}</span><span class="num">${duration(step.left.hours)}</span></a>`);
  }
  const stats = [
    ['Total level', exact(save.header.totalLevel ?? 0), '#/skills'],
    ['Gold', num(save.header.gp ?? 0), '#/money'],
    ['Slayer coins', num(save.header.slayerCoins ?? 0), '#/slayer'],
    ...(save.bank?.stacks != null ? [['Bank slots', `${exact(save.bank.stacks)}/${exact(bankCapacity(gd, save).max)}`, '#/bank']] : []),
  ];
  rows.push(`<div class="now-stats">${stats.map(([label, value, href]) => `<a href="${href}"><span class="k">${label}</span><span class="v">${value}</span></a>`).join('')}</div>`);
  return `<section class="nav-now" aria-label="Right now"><h2>Right now</h2>${rows.join('')}</section>`;
}
