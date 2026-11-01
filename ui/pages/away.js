// Away planner: what to leave running while you are offline.
import { STYLES } from '/engine/combat.js';
import { planAway } from '/engine/planner.js';
import { badge, duration, esc, iconImg, num } from '/ui/format.js';
import { combatRecommendation, combatSetup, fightHours, STYLE_SKILL } from './combat.js';
import { card, methodLink, pageHead, requirementText, signed, skillName, table } from './shared.js';

// ---------- Away planner ----------

export function away(ctx) {
  const { gd, state } = ctx;
  const a = state.ui.away;
  const cap = gd.mechanics.offlineCapHours ?? 24;
  const hours = Math.min(Math.max(Number(a.hours) || 8, 0.25), cap);
  const byGp = a.goal === 'gp';
  const score = (x) => (byGp ? x.sim.profit : x.sim.xpGained);
  const rows = planAway(gd, { levels: ctx.levels, xp: ctx.xp, stock: ctx.stock, hours, skill: a.skill || null }).sort((x, y) => score(y) - score(x));
  const skillOpts = gd.trainableSkills.map((sk) => `<option value="${sk}"${sk === a.skill ? ' selected' : ''}>${esc(skillName(ctx, sk))}</option>`).join('');
  const controls = `<div class="form-row">
      <label>Hours away <input id="away-hours" type="number" min="0.25" max="${cap}" step="0.5" value="${hours}" data-bind="away.hours"></label>
      <label>Skill <select id="away-skill" data-bind="away.skill"><option value="">Any skill</option>${skillOpts}</select></label>
      <div class="segmented" role="group" aria-label="Goal">${[['xp', 'Most XP'], ['gp', 'Most GP']].map(([v, l]) => `<button data-action="awayGoal" data-value="${v}" aria-pressed="${(a.goal ?? 'xp') === v}">${l}</button>`).join('')}</div>
    </div>`;
  const body = rows.slice(0, 15).map((x) => {
    const notes = [];
    if (x.runs < x.away - 1e-6) notes.push(`<span class="pill warn">Stock runs out after ${duration(x.runs)}</span>`);
    if (x.equip?.length) notes.push(`<span class="pill accent">${requirementText(ctx, x.equip)}</span>`);
    const levels = x.sim.endLevel > x.sim.startLevel ? `${x.sim.startLevel} → <strong>${x.sim.endLevel}</strong>` : `${x.sim.startLevel}`;
    return `<tr><td>${methodLink(x.method)}<span class="sub">${esc(skillName(ctx, x.method.skill))}</span></td><td class="num">${duration(x.runs)}</td><td class="num">${num(x.sim.xpGained)}</td><td class="num">${levels}</td><td class="num">${signed(x.sim.profit)}</td><td class="small">${notes.join(' ')}</td></tr>`;
  });
  const sub = `The best thing to leave running while you're away, simulated with level-ups along the way. It only counts on what you own${ctx.stock ? '' : ' (no save loaded, so materials are assumed)'}. The game counts at most ${cap} hours offline.`;
  return `${pageHead('Away planner', sub)}
    ${controls}
    ${card(`Leave running for ${duration(hours)}`, table(['Action', '#Runs for', '#XP', '#Level', '#Profit', ''], body, 'Nothing you can run right now.'))}
    ${ctx.save?.combat && ctx.bank && gd.combat && !a.skill ? `<div style="margin-top:12px">${awayCombat(ctx, hours, byGp)}</div>` : ''}`;
}

// The best fight per style for the time away, limited by food, ammo and runes.
function awayCombat(ctx, hours, byGp) {
  const { food } = combatSetup(ctx);
  const rows = STYLES.map((style) => {
    const rec = combatRecommendation(ctx, style);
    if (!rec?.fights.length) return null;
    let best = null;
    for (const f of rec.fights) {
      if (f.result.risky || f.unknown.length) continue;
      const runs = Math.min(hours, fightHours(ctx, f, food));
      if (!(runs > 0)) continue;
      const value = (byGp ? f.result.profitPerHour : f.result.combatXpPerHour) * runs;
      if (!best || value > best.value) best = { f, runs, value };
    }
    if (!best) return null;
    const r = best.f.result;
    return `<tr><td>${badge(STYLE_SKILL[style], style)} ${style}</td><td>${iconImg(best.f.enemy.icon, 'icon sm')}${esc(best.f.enemy.name)}<span class="sub">${esc(best.f.area.name)}</span></td><td class="num">${duration(best.runs)}${best.runs < hours - 1e-6 ? '<span class="sub warn-text">supplies run out</span>' : ''}</td><td class="num">${num(r.combatXpPerHour * best.runs)}</td><td class="num">${signed(r.profitPerHour * best.runs)}</td></tr>`;
  }).filter(Boolean);
  return card('Or fight', `${table(['Style', 'Enemy', '#Runs for', '#Combat XP', '#Profit'], rows, 'No fight your supplies can keep going.')}<p class="small muted">With the best gear you own for each style. <a href="#/combat">Combat details</a></p>`);
}
