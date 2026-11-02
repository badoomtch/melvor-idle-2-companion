// The compact always-on-top window.
import { currentActivity } from '/engine/advisor.js';
import { currentFight } from '/engine/current-fight.js';
import { describeStep } from '/engine/route-progress.js';
import { currentSupplies } from '/engine/supplies.js';
import { ago, badge, duration, esc, exact, iconImg, num, pct } from '/ui/format.js';
import { routeFor } from './route-ui.js';
import { skillName } from './shared.js';
import { renderLivePill, renderTopAlerts } from './topbar.js';

// ---------- Mini window ----------

// The compact always-on-top view: what you're doing, how it's going, your plan's step, what runs out next.
export function renderMini(ctx) {
  const { gd, state } = ctx;
  if (!ctx.save) return '<p class="muted">No save yet. Start the game and play for a moment.</p>';
  const a = currentActivity(gd, ctx.save.header, ctx.levels);
  const parts = [`<div class="mini-head"><strong>${esc(ctx.save.header.characterName || 'Melvor')}</strong><span id="mini-live">${renderLivePill(ctx)}</span></div>`];
  // The same warnings as the top bar: what needs you now.
  const warnings = renderTopAlerts(ctx);
  if (warnings) parts.push(`<div class="top-alerts mini-alerts">${warnings}</div>`);
  const f = state.levelSource === 'save' ? currentFight(gd, ctx.save, ctx.levels) : null;
  if (f) {
    const level = ctx.levels[f.skill] ?? 1;
    const prog = gd.xp.levelProgress(ctx.xp[f.skill], gd.levelCap);
    const rate = ctx.measured?.[f.skill] || f.result.xpPerHour[f.skill] || 0;
    const toNext = rate > 0 && level < gd.levelCap ? prog.xpForNext / rate : null;
    parts.push(`<div class="mini-activity">${badge(f.skill, skillName(ctx, f.skill))}<div><strong>${esc(f.enemy.name)}</strong>
      <span class="small muted">${esc(skillName(ctx, f.skill))} ${level} · ${esc(f.style)} · ${num(f.result.combatXpPerHour)} XP/h</span></div></div>
      <div class="bar" role="progressbar" aria-label="Progress to the next level" aria-valuenow="${Math.round(prog.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(prog.progress * 100).toFixed(1)}%"></span></div>
      <p class="small muted">${level >= gd.levelCap ? 'Max level' : `${exact(Math.ceil(prog.xpForNext))} XP to ${level + 1}${toNext != null ? ` · ${duration(toNext)}` : ''}`}</p>`);
  } else if (a?.skill) {
    const level = ctx.levels[a.skill];
    const xp = ctx.xp[a.skill];
    const prog = gd.xp.levelProgress(xp, gd.levelCap);
    const measured = ctx.measured?.[a.skill];
    const rate = measured || a.rates?.xpPerHour || 0;
    const toNext = rate > 0 && level < gd.levelCap ? prog.xpForNext / rate : null;
    parts.push(`<div class="mini-activity">${badge(a.skill, skillName(ctx, a.skill))}<div><strong>${esc(a.label)}</strong>
      <span class="small muted">${esc(skillName(ctx, a.skill))} ${level}${rate ? ` · ${num(rate)} XP/h${measured ? '' : ' (est.)'}` : ''}</span></div></div>
      <div class="bar" role="progressbar" aria-label="Progress to the next level" aria-valuenow="${Math.round(prog.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(prog.progress * 100).toFixed(1)}%"></span></div>
      <p class="small muted">${level >= gd.levelCap ? 'Max level' : `${exact(Math.ceil(prog.xpForNext))} XP to ${level + 1}${toNext != null ? ` · ${duration(toNext)}` : ''}`}</p>`);
    if (a.xpRatio != null && a.xpRatio < 0.9 && a.bestXp) parts.push(`<p class="small warn-text">${esc(a.bestXp.method.name)} gives ${pct(1 / a.xpRatio - 1)} more XP</p>`);
  } else {
    parts.push('<p class="muted small">Not training anything right now.</p>');
  }
  const plan = planStep(ctx);
  if (plan) parts.push(plan);
  const supplies = currentSupplies(gd, ctx.save, ctx.levels, ctx.stock).slice(0, 3);
  if (supplies.length) {
    parts.push(`<ul class="list-plain mini-list">${supplies.map((x) => `<li><span>${iconImg(gd.items[x.item]?.icon, 'icon sm')}${esc(gd.itemName(x.item))}</span><span class="num${x.hoursLeft * 60 <= state.alerts.minutes ? ' warn-text' : ''}">${x.qty > 0 ? duration(x.hoursLeft) : 'Out'}</span></li>`).join('')}</ul>`);
  }
  const goal = state.goals.find((g) => (ctx.levels[g.skill] ?? 1) < g.target);
  if (goal) {
    const remaining = Math.max(0, gd.xp.xpForLevel(goal.target) - (ctx.xp[goal.skill] ?? 0));
    const rate = ctx.measured?.[goal.skill];
    parts.push(`<p class="small">Goal: ${esc(skillName(ctx, goal.skill))} ${goal.target} · ${exact(remaining)} XP left${rate ? ` · ${duration(remaining / rate)}` : ''}</p>`);
  }
  if (state.lastAlert && Date.now() - state.lastAlert.at < 30 * 60_000) parts.push(`<p class="small mini-alert"><strong>${esc(state.lastAlert.title)}</strong> ${esc(state.lastAlert.body)} <span class="muted">${ago(state.lastAlert.at)}</span></p>`);
  return parts.join('');
}

// The step your plan is on: how far along, how long it has left, and what comes after it.
function planStep(ctx) {
  const { gd } = ctx;
  const route = routeFor(ctx);
  const st = route.step;
  if (!st) return '';
  const leg = route.legs.find((l) => l.steps.includes(st));
  const total = st.kind === 'train' ? st.actions : Math.ceil(st.qty);
  const left = st.kind === 'train' ? st.left.actions : Math.ceil(st.left.qty ?? total);
  const share = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
  const flat = route.legs.flatMap((l) => l.steps);
  const then = flat.slice(flat.indexOf(st) + 1).find((x) => !x.done);
  return `<div class="mini-plan${st.on ? ' on' : ''}"><span class="small muted">${st.on ? "You're on your plan" : 'Next on your plan'} · ${esc(skillName(ctx, leg.skill))} ${leg.to}</span>
    <strong>${esc(describeStep(gd, st))}</strong>
    <div class="bar" role="progressbar" aria-label="Step progress" aria-valuenow="${Math.round(share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    <p class="small muted">${duration(st.left.hours)} left${then ? ` · then ${esc(describeStep(gd, then, { left: false }))}` : ''}</p></div>`;
}
