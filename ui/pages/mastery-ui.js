// Mastery Guild plans shared by What next and the skill pages.
import { masteryPlan, ownedStances } from '/engine/mastery-plan.js';
import { badge, duration, esc, exact, iconImg, pct } from '/ui/format.js';
import { combatRecommendation, combatSetup } from './combat.js';
import { bonusText, enc, memo, methodLink, saveKey, skillName } from './shared.js';
import { STYLES } from '/engine/combat.js';

// A rank pays for itself within this many hours of its skill: worth calling out.
const GOOD_PAYBACK_HOURS = 10;

// What a rank's bonus gives, in words.
export const rankBonusText = (b) => [...b.effects.map(bonusText), ...(b.mods ?? []).map(bonusText)].join(', ') || (b.otherBonuses ?? []).join(', ') || 'no bonus';

// The fights each style's best gear can do, for kill tasks and combat level tasks.
function fightsByStyle(ctx) {
  const { gd } = ctx;
  if (!gd.combat || !ctx.save?.combat || !ctx.bank) return null;
  const out = {};
  for (const style of STYLES) {
    const rec = combatRecommendation(ctx, style);
    if (!rec) continue;
    const weapon = rec.gear.gear.find((id) => gd.items[id]?.equip?.type === 'Weapon');
    out[style] = { fights: rec.fights, ...ownedStances(gd, style, combatSetup(ctx).owned, weapon) };
  }
  return out;
}

// Every skill's open tasks and quickest route to the next rank (once per autosave).
export function masteryPlanFor(ctx) {
  if (!ctx.save?.mastery || ctx.state.levelSource !== 'save') return null;
  return memo('mastery:plan', saveKey(ctx), () => masteryPlan(ctx.gd, ctx.save, ctx.levels, { bank: ctx.stock, fights: fightsByStyle(ctx) }));
}

// The ranks within two days that do something measurable for you, closest first.
export const ranksWorthGetting = (plans) => plans.filter((p) => p.plan && p.value && p.plan.hours <= 48).sort((a, b) => a.plan.hours - b.plan.hours);

// What the next rank's bonus does at your levels: "+4.7% GP/h with Dawnsteel Ore". Nothing for a plain
// XP bonus, which already says it.
export function rankValueText(p) {
  const v = p.value;
  if (!v || (v.by === 'xp' && p.status.nextBonus?.effects?.some((e) => e.stat === 'PercentXPGained' && Math.abs(e.value - v.speedup) < 0.005))) return '';
  return `+${pct(v.speedup, v.speedup < 0.095 ? 1 : 0)} ${v.by === 'xp' ? 'XP' : 'GP'}/h${v.method ? ` with ${v.method.name}` : ''}`;
}

// What the tasks cost beyond training you'd do anyway, and how long the bonus takes to win that back.
export function paybackText(ctx, p) {
  const v = p.value;
  if (!v) return '';
  const skill = skillName(ctx, p.skill);
  if (v.extraHours < 1 / 60) return `Comes with training ${skill}: the tasks are the training`;
  return `${duration(v.extraHours)} more than training ${skill} the usual way · pays for itself after ${duration(v.paybackHours)} of ${skill}`;
}

// One rank: the skill, the rank, its bonus and what that's worth, and the first few tasks.
export function rankRow(ctx, p, { tasks = 2, activity = null } = {}) {
  const on = !!activity?.method && p.plan.tasks.some((t) => t.how?.method?.key === activity.method.key);
  const good = p.value && p.value.paybackHours <= GOOD_PAYBACK_HOURS;
  const bonus = p.status.nextBonus ? rankBonusText(p.status.nextBonus) : '';
  const value = rankValueText(p);
  const payback = paybackText(ctx, p);
  const list = p.plan.tasks.slice(0, tasks).map((t) => esc(t.label)).join(' · ');
  return `<li${on ? ' class="doing on"' : ''}><span>${badge(p.skill, skillName(ctx, p.skill))} <a href="#/skills/${p.skill}">${esc(skillName(ctx, p.skill))}</a> → <strong>${esc(p.status.next.name)}</strong>${good ? ' <span class="pill good">Good value</span>' : ''}${on ? ' <span class="pill good">You\'re doing one of these</span>' : ''}
    ${bonus ? `<span class="sub small accent-text">${esc(bonus)}${value ? ` · ${esc(value)}` : ''}</span>` : ''}${payback ? `<span class="sub muted small">${esc(payback)}</span>` : ''}
    <span class="sub muted small">${exact(p.plan.tasks.length)} task${p.plan.tasks.length === 1 ? '' : 's'}: ${list}${p.plan.tasks.length > tasks ? ' …' : ''}</span></span>
    <span class="num">${duration(p.plan.hours)}</span></li>`;
}

// One task: what to do, with what, how far along and how long it takes.
export function taskLine(ctx, t) {
  const { gd } = ctx;
  const how = t.how?.method
    ? `${methodLink(t.how.method)} <span class="muted small">${esc(skillName(ctx, t.how.method.skill))}</span>`
    : t.how?.enemy
      ? `${iconImg(t.how.enemy.icon, 'icon sm')}<a href="#/lookup/enemy/${enc(t.how.enemy.id)}">${esc(t.how.enemy.name)}</a> <span class="muted small">${esc(t.how.style)}${t.how.weapon ? ` · with your ${esc(gd.itemName(t.how.weapon))}` : ''}</span>`
      : '';
  const progress = t.progress && !t.progress.level && t.progress.done > 0 ? ` <span class="muted small">${exact(Math.floor(t.progress.done))}/${exact(t.progress.of)}</span>` : '';
  const needs = t.needs ? ` <span class="warn-text small">needs ${esc(gd.skillName(t.needs.skill))} ${t.needs.level}</span>` : '';
  return `<li><span>${esc(t.label)}${progress}${needs}${how ? `<span class="sub small">${how}</span>` : ''}</span><span class="num">${t.hours == null ? '<span class="muted">?</span>' : duration(t.hours)}</span></li>`;
}
