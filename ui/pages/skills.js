// Skills: every training method for one skill.
import { rankSkill } from '/engine/advisor.js';
import { masteryStatus } from '/engine/mastery.js';
import { badge, duration, esc, exact } from '/ui/format.js';
import { masteryPlanFor, rankBonusText, taskLine } from './mastery-ui.js';
import { card, methodRows, pageHead, skillName, table } from './shared.js';

// The skill's Mastery Guild rank from the save: points, the next rank and what it adds.
function masteryCard(ctx, skill) {
  if (!ctx.save?.mastery || ctx.state.levelSource !== 'save') return '';
  const m = masteryStatus(ctx.gd, ctx.save, ctx.levels)[skill];
  if (!m) return '';
  const effects = rankBonusText;
  const nextAt = m.next ? m.points + m.pointsToNext : m.total;
  const share = nextAt > 0 ? Math.min(1, m.points / nextAt) : 1;
  const have = m.bonuses.filter((b) => b.effects.length || b.mods?.length);
  // The cheapest tasks to the next rank, at your current rates.
  const plan = masteryPlanFor(ctx)?.find((p) => p.skill === skill);
  const route = !m.next ? ''
    : plan?.plan
      ? `<h4 style="margin-top:10px">Quickest way to ${esc(m.next.name)}: about ${duration(plan.plan.hours)}</h4><ul class="list-plain">${plan.plan.tasks.map((t) => taskLine(ctx, t)).join('')}</ul><p class="small muted">${exact(plan.plan.tasks.length)} tasks worth ${exact(plan.plan.points)} points, cheapest first. Tasks that count the same thing share progress, so the bigger one only adds its extra.</p>`
      : `<p class="small muted" style="margin-top:8px">The companion can't time enough of this skill's tasks to plan the next rank${plan ? ` (${exact(plan.open.filter((t) => t.hours != null).length)} of ${exact(plan.open.length)} open tasks timed)` : ''}.</p>`;
  return card(`Mastery Guild: ${esc(m.rank?.name ?? 'no rank yet')}`, `
    <div class="bar" role="progressbar" aria-label="Points towards the next rank" aria-valuenow="${Math.round(share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    <p class="small">${exact(m.points)} of ${exact(m.total)} points from ${exact(m.done)} of ${exact(m.tasks)} tasks.${m.next ? ` <strong>${esc(m.next.name)}</strong> at ${exact(nextAt)} points (${exact(m.pointsToNext)} to go)${m.nextBonus ? `: ${esc(effects(m.nextBonus))}` : ''}.` : ' Top rank.'}</p>
    ${have.length ? `<p class="small muted">Counted in the rates below: ${have.map((b) => `${esc(b.rankName)} (${esc(effects(b))})`).join('; ')}.</p>` : ''}${route}`, ' style="margin-bottom:12px"');
}

// ---------- Skills ----------

export function skills(ctx, [skillArg]) {
  const { gd, state } = ctx;
  const skill = gd.trainableSkills.includes(skillArg) ? skillArg : state.ui.lastSkill && gd.trainableSkills.includes(state.ui.lastSkill) ? state.ui.lastSkill : gd.trainableSkills[0];
  state.ui.lastSkill = skill;
  const override = state.ui.skillOverride[skill];
  const level = override ?? ctx.levels[skill] ?? 1;
  const levels = { ...ctx.levels, [skill]: level };
  const ranked = rankSkill(gd, skill, levels, { by: state.ui.sort === 'profit' ? 'profit' : 'xp' });
  const sort = state.ui.sort;
  const all = [...ranked.available, ...ranked.all.filter((x) => !x.ok).sort((a, b) => a.method.level - b.method.level)];
  if (sort === 'level') all.sort((a, b) => a.method.level - b.method.level || a.method.name.localeCompare(b.method.name));
  const chips = gd.trainableSkills
    .map((s) => `<a class="chip" href="#/skills/${s}"${s === skill ? ' aria-current="page"' : ''}>${badge(s, skillName(ctx, s))}${esc(skillName(ctx, s))} <span class="muted">${ctx.levels[s] ?? 1}</span></a>`)
    .join('');
  const controls = `<div class="form-row">
      <label>Level to plan for <input id="skill-level" type="number" min="1" max="${gd.levelCap}" value="${level}" data-bind="skillLevel" data-skill="${skill}"></label>
      ${override != null ? `<button data-action="resetSkillLevel" data-skill="${skill}">Back to my level (${ctx.levels[skill] ?? 1})</button>` : ''}
      <div class="segmented" role="group" aria-label="Sort by">
        ${[['xp', 'XP/h'], ['profit', 'GP/h'], ['level', 'Level']].map(([v, l]) => `<button data-action="sort" data-value="${v}" aria-pressed="${sort === v}">${l}</button>`).join('')}
      </div>
    </div>`;
  return `${pageHead(`${badge(skill, skillName(ctx, skill))} ${esc(skillName(ctx, skill))}`, `${ranked.available.length} of ${ranked.all.length} methods unlocked at level ${level}. Click a method for the full breakdown.`)}
    <div class="chips">${chips}</div>
    ${masteryCard(ctx, skill)}
    ${controls}
    ${table(['Method', '#Lvl', '#XP / h', '#GP / h', 'Notes'], methodRows(ctx, all, { columns: [], markBest: sort !== 'level' }))}
    <p class="small muted" style="margin-top:10px">GP/h is profit: what you gain minus what you use up (materials and food), at sell prices. ${ctx.gd.playerBonuses ? 'Includes your shop upgrades, toolbelt items, pets and Mastery Guild rank.' : 'Base rates (bonuses switched off in Settings).'}</p>`;
}
