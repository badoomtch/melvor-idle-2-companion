// Calculators: time to level, offline progress, drop chances.
import { planTraining, simulate } from '/engine/advisor.js';
import { GP } from '/engine/gamedata.js';
import { dropChance, triesFor } from '/engine/lookup.js';
import { duration, esc, exact, gp, pct } from '/ui/format.js';
import { planNote } from './next.js';
import { card, itemLink, pageHead, signed, skillName } from './shared.js';

// ---------- Calculators ----------

function methodOptions(ctx, selected, { includeBest = false, levels = ctx.levels } = {}) {
  const { gd } = ctx;
  const groups = gd.trainableSkills.map((s) => {
    const opts = gd.methodsBySkill[s]
      .filter((m) => gd.checkRequirements(m, levels).ok)
      .map((m) => `<option value="${esc(m.key)}"${m.key === selected ? ' selected' : ''}>${esc(m.name)} (${m.level})</option>`)
      .join('');
    return opts ? `<optgroup label="${esc(skillName(ctx, s))}">${opts}</optgroup>` : '';
  });
  return `${includeBest ? `<option value="best"${selected === 'best' ? ' selected' : ''}>Best available at each level</option>` : ''}${groups.join('')}`;
}

function simulationSummary(ctx, sim) {
  const outs = sim.outputs.slice(0, 8).map((o) => `<li>${itemLink(ctx, o.item)} × ${exact(o.qty)}</li>`).join('');
  const ins = sim.inputs.map((o) => `<li>${itemLink(ctx, o.item)} × ${exact(o.qty)}</li>`).join('');
  const gpGained = sim.currencies[GP] ?? 0;
  return `<dl class="kv">
      <dt>XP gained</dt><dd>${exact(sim.xpGained)}</dd>
      <dt>Level</dt><dd>${sim.startLevel} → <strong>${sim.endLevel}</strong></dd>
      <dt>Actions</dt><dd>${exact(sim.cycles)}</dd>
      ${gpGained ? `<dt>Gold</dt><dd>${gp(gpGained)}</dd>` : ''}
      <dt>Profit</dt><dd>${signed(sim.profit)} GP</dd>
      ${sim.food ? `<dt>Food eaten</dt><dd>${exact(sim.food.qty)} ${esc(ctx.gd.itemName(sim.food.item))}</dd>` : ''}
    </dl>
    <div class="detail-body" style="padding-left:0"><div><h4>You'll get</h4>${outs ? `<ul>${outs}</ul>` : '<p class="muted small">Nothing</p>'}</div>${ins ? `<div><h4>You'll use</h4><ul>${ins}</ul></div>` : ''}</div>`;
}

export function calculators(ctx) {
  const { gd, state } = ctx;
  const c = state.ui.calc;
  const skill = gd.trainableSkills.includes(c.skill) ? c.skill : gd.trainableSkills[0];
  const curLevel = ctx.levels[skill] ?? 1;
  const curXp = ctx.xp[skill] ?? gd.xp.xpForLevel(curLevel);
  const target = Math.min(Math.max(c.target ?? curLevel + 1, 1), gd.levelCap);
  const needXp = Math.max(0, gd.xp.xpForLevel(target) - curXp);
  let result;
  if (target <= curLevel) {
    result = '<p class="muted">You\'re already there.</p>';
  } else if (c.methodKey === 'best' || !gd.methodByKey.get(c.methodKey) || gd.methodByKey.get(c.methodKey).skill !== skill) {
    const plan = planTraining(gd, skill, ctx.levels, curXp, target, { bank: ctx.stock });
    result = `<p><strong>${exact(needXp)} XP</strong> to go · about <strong>${duration(plan.hours)}</strong>${plan.gatherHours > 0 ? ` (${duration(plan.trainHours)} training + ${duration(plan.gatherHours)} gathering)` : ''}.</p><p class="plan-lines">${planNote(ctx, plan)}</p>`;
  } else {
    const sim = simulate(gd, gd.methodByKey.get(c.methodKey), ctx.levels, curXp, { targetLevel: target });
    result = `<p><strong>${exact(needXp)} XP</strong> to go · <strong>${duration(sim.hours)}</strong> with ${esc(gd.methodByKey.get(c.methodKey).name)}.</p>${simulationSummary(ctx, sim)}`;
  }
  const skillOpts = gd.trainableSkills.map((s) => `<option value="${s}"${s === skill ? ' selected' : ''}>${esc(skillName(ctx, s))}</option>`).join('');
  const skillMethodOpts = `<option value="best"${c.methodKey === 'best' ? ' selected' : ''}>Best at each level</option>${gd.methodsBySkill[skill].map((m) => `<option value="${esc(m.key)}"${m.key === c.methodKey ? ' selected' : ''}>${esc(m.name)} (${m.level})</option>`).join('')}`;

  const o = state.ui.offline;
  const cap = gd.mechanics.offlineCapHours ?? 24;
  const offMethod = gd.methodByKey.get(o.methodKey);
  const offHours = Math.min(Math.max(o.hours, 0.25), cap);
  const offSim = offMethod ? simulate(gd, offMethod, ctx.levels, ctx.xp[offMethod.skill] ?? gd.xp.xpForLevel(ctx.levels[offMethod.skill] ?? 1), { hours: offHours }) : null;

  const d = state.ui.drop;
  const p = Math.min(Math.max(d.chance, 0), 100) / 100;
  const tries = Math.max(1, Math.floor(d.tries));

  return `${pageHead('Calculators')}
    <div class="grid two">
      ${card('Time to level', `<div class="form-row">
          <label>Skill <select id="calc-skill" data-bind="calc.skill">${skillOpts}</select></label>
          <label>Target level <input id="calc-target" type="number" min="1" max="${gd.levelCap}" value="${target}" data-bind="calc.target"></label>
          <label>Method <select id="calc-method" data-bind="calc.methodKey">${skillMethodOpts}</select></label>
        </div>
        <p class="small muted">Now: level ${curLevel}, ${exact(curXp)} XP.</p>${result}`)}
      ${card('Offline progress', `<div class="form-row">
          <label style="flex:1">Action <select id="offline-method" data-bind="offline.methodKey"><option value="">Choose…</option>${methodOptions(ctx, o.methodKey)}</select></label>
          <label>Hours away <input id="offline-hours" type="number" min="0.25" max="${cap}" step="0.25" value="${offHours}" data-bind="offline.hours"></label>
        </div>
        <p class="small muted">The game counts at most ${cap} hours offline.</p>
        ${offSim ? simulationSummary(ctx, offSim) : '<p class="muted">Pick an action to see what you\'d come back to.</p>'}`)}
      ${card('Drop chance', `<div class="form-row">
          <label>Chance per try (%) <input id="drop-chance" type="number" min="0" max="100" step="any" value="${d.chance}" data-bind="drop.chance"></label>
          <label>Tries <input id="drop-tries" type="number" min="1" step="1" value="${tries}" data-bind="drop.tries"></label>
        </div>
        <p>Chance of at least one: <strong>${pct(dropChance(p, tries), 1)}</strong></p>
        <p class="small muted">Tries for 50%: ${exact(triesFor(p, 0.5))} · 90%: ${exact(triesFor(p, 0.9))} · 99%: ${exact(triesFor(p, 0.99))}</p>`)}
    </div>`;
}
