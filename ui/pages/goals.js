// Goals: target levels with ETAs.
import { hoursToLevel } from '/engine/advisor.js';
import { badge, duration, esc, exact, num } from '/ui/format.js';
import { pageHead, skillName } from './shared.js';

// ---------- Goals ----------

export function goals(ctx) {
  const { gd, state } = ctx;
  const skillOpts = gd.skills.map((s) => `<option value="${s.id}"${s.id === state.ui.goalSkill ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const cards = state.goals.map((g) => {
    const level = ctx.levels[g.skill] ?? 1;
    const xp = ctx.xp[g.skill] ?? gd.xp.xpForLevel(level);
    const targetXp = gd.xp.xpForLevel(g.target);
    const done = level >= g.target;
    const remaining = Math.max(0, targetXp - xp);
    const measured = ctx.measured[g.skill];
    let eta;
    if (done) eta = '<span class="pill live">Done</span>';
    else if (measured) eta = `${duration(remaining / measured)} at your measured ${num(measured)} XP/h`;
    else if (gd.methodsBySkill[g.skill]?.length) eta = `${duration(hoursToLevel(gd, g.skill, ctx.levels, xp, g.target, { bank: ctx.stock }))} with the best methods${ctx.bank ? ' and your bank' : ''}`;
    else eta = 'No time estimate for this skill yet';
    return `<div class="card goal-card"><div class="top"><span>${badge(g.skill, skillName(ctx, g.skill))} <strong>${esc(skillName(ctx, g.skill))}</strong> ${level} → ${g.target}</span><button class="link" data-action="removeGoal" data-id="${esc(g.id)}">Remove</button></div>
      <div class="bar big"><span style="width:${Math.min(100, (xp / targetXp) * 100).toFixed(1)}%"></span></div>
      <p class="small">${done ? '' : `${exact(remaining)} XP left · `}${eta}</p></div>`;
  });
  return `${pageHead('Goals', 'Track the levels you\'re working toward. Times use your real XP rate once the companion has seen a few saves.')}
    <div class="card"><div class="form-row" style="margin:0">
      <label>Skill <select id="goal-skill" data-bind="goalSkill">${skillOpts}</select></label>
      <label>Target level <input id="goal-target" type="number" min="2" max="${gd.levelCap}" value="${state.ui.goalTarget}" data-bind="goalTarget"></label>
      <button class="primary" data-action="addGoal">Add goal</button>
    </div></div>
    <div style="margin-top:12px">${cards.join('') || '<p class="muted">No goals yet.</p>'}</div>`;
}
