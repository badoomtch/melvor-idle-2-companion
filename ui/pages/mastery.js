// Mastery Guild: every skill's next rank, what it's worth to you, and the quickest tasks to it.
import { currentActivity } from '/engine/advisor.js';
import { badge, duration, esc, exact } from '/ui/format.js';
import { masteryPlanFor, paybackText, rankBonusText, rankRow, rankValueText, ranksWorthGetting, taskLine } from './mastery-ui.js';
import { card, pageHead, skillName } from './shared.js';

// Why some skills' ranks can't be timed.
const WHY_NOT = {
  Herblore: "Its potion tasks need herbs, which come from Farming; the companion doesn't time crops.",
  Slayer: 'Its tasks count fights on your Slayer task and other things only the game tracks.',
  Astrology: "Its tasks are about unlocking constellation nodes and star events, which the companion doesn't model.",
};

export function masteryPage(ctx) {
  const head = pageHead('Mastery Guild', "Each skill's next rank: what its bonus does at your levels, and the quickest tasks to get there. Tasks count whatever you're doing anyway, so the ones that line up with your training cost little extra.");
  const plans = masteryPlanFor(ctx);
  if (!plans) return `${head}${card('', '<p class="muted">Load a save to see your Mastery Guild ranks. Pick it in Settings, or start the game and play for a moment.</p>')}`;
  const activity = ctx.save ? currentActivity(ctx.gd, ctx.save.header, ctx.levels) : null;
  const worth = ranksWorthGetting(plans);
  const planned = plans.filter((p) => p.plan).sort((a, b) => a.plan.hours - b.plan.hours);
  const unplanned = plans.filter((p) => !p.plan && p.status.next);
  const top = card('Worth getting soon', worth.length
    ? `<p class="small muted">Ranks within two days that make you faster, closest first. "Good value" means the bonus wins back the extra time within 10 hours of that skill.</p><ul class="list-plain">${worth.map((p) => rankRow(ctx, p, { tasks: 3, activity })).join('')}</ul>`
    : '<p class="muted small">No rank within two days does something the companion can put a number on. Every skill is listed below.</p>');
  const skills = planned.map((p) => {
    const value = rankValueText(p);
    const payback = paybackText(ctx, p);
    const bonus = p.status.nextBonus ? rankBonusText(p.status.nextBonus) : 'no bonus';
    return card(`${badge(p.skill, skillName(ctx, p.skill))} <a href="#/skills/${p.skill}">${esc(skillName(ctx, p.skill))}</a> → ${esc(p.status.next.name)} <span class="muted small">· ${duration(p.plan.hours)}</span>`,
      `<p class="small"><span class="accent-text">${esc(bonus)}</span>${value ? ` <span class="muted">· ${esc(value)}</span>` : ''}</p>
      ${payback ? `<p class="small muted">${esc(payback)}</p>` : ''}
      <p class="small muted">${p.status.rank ? `${esc(p.status.rank.name)} now · ` : ''}${exact(p.status.points)} of ${exact(p.status.total)} points, ${exact(p.status.pointsToNext)} to go</p>
      <ol class="list-plain">${p.plan.tasks.map((t) => taskLine(ctx, t)).join('')}</ol>`);
  });
  const notes = unplanned.length
    ? card("Can't plan yet", `<p class="small muted">These skills' next ranks need tasks the companion can't time. Their skill pages list every task.</p><ul class="list-plain">${unplanned.map((p) => `<li><span><a href="#/skills/${p.skill}">${esc(skillName(ctx, p.skill))}</a> → ${esc(p.status.next.name)}<span class="sub muted small">${esc(WHY_NOT[p.skill] ?? "Its tasks count things the companion can't time yet, or need levels you can't train here.")}</span></span></li>`).join('')}</ul>`)
    : '';
  return `${head}${top}<div class="grid two" style="margin-top:12px">${skills.join('')}</div>${notes ? `<div style="margin-top:12px">${notes}</div>` : ''}`;
}
