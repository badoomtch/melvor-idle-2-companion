// Accuracy: the companion's estimates against what each action really gave you.
import { compareActions, MIN_SECONDS, verdict } from '/engine/accuracy.js';
import { ago, badge, duration, esc, num, pct } from '/ui/format.js';
import { card, itemLink, methodLink, noSaveCard, pageHead, skillName, table } from './shared.js';

const PILL = { good: 'live', close: 'warn', off: 'bad', unknown: '' };

// Likely reasons for a gap, so the number is actionable.
function reason(row) {
  if (row.ratio == null) return row.method ? 'No estimate for this action' : 'Not modelled (combat or an unmodelled skill)';
  if (row.ratio > 1.05) return 'You get more than estimated: a bonus the companion doesn\'t count yet';
  if (row.ratio < 0.95) return 'You get less than estimated: stops, running out, failures, or a gap in the model';
  return 'Matches';
}

export function accuracy(ctx) {
  const { gd, state } = ctx;
  const head = pageHead('Accuracy', `How the estimates compare with what each action actually gave you. While the companion runs it adds up the XP and items between autosaves of the same action (actions need ${MIN_SECONDS / 60} minutes of play to show).`);
  if (!ctx.save) return `${head}${noSaveCard(ctx)}`;
  const obs = state.observations;
  if (!obs || obs.id !== ctx.save.id) return `${head}<p class="loading">Loading…</p>`;
  const rows = compareActions(gd, obs.actions, ctx.levels);
  if (!rows.length) return `${head}<div class="card empty"><h2>Nothing measured yet</h2><p>Keep the companion running while you play. After a couple of minutes on an action, it appears here.</p></div>`;
  const counts = { good: 0, close: 0, off: 0 };
  for (const r of rows) if (r.ratio != null) counts[verdict(r.ratio)]++;
  const body = rows.flatMap((r) => {
    const v = verdict(r.ratio);
    const key = `acc:${r.key}`;
    const open = state.ui.expanded.has(key);
    const label = r.method ? methodLink(r.method) : esc(r.key);
    const out = [`<tr>
      <td><button class="link" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button> ${r.skill ? badge(r.skill, skillName(ctx, r.skill)) : ''} ${label}<span class="sub">${esc(r.skill ? skillName(ctx, r.skill) : r.key)} · last ${ago(r.lastSeen)}</span></td>
      <td class="num">${duration(r.hours)}</td>
      <td class="num">${num(r.measuredXp)}</td>
      <td class="num">${r.estimatedXp != null ? num(r.estimatedXp) : '–'}</td>
      <td class="num">${r.ratio != null ? `<span class="pill ${PILL[v]}">${r.ratio >= 1 ? '+' : ''}${pct(r.ratio - 1, 1)}</span>` : '–'}</td>
      <td class="small">${esc(reason(r))}</td></tr>`];
    if (open && r.items.length) {
      const itemRows = r.items.map((i) => `<li>${itemLink(ctx, i.item)} <span class="muted small">measured ${num(i.measured)}/h · estimated ${num(i.estimated)}/h</span></li>`).join('');
      out.push(`<tr><td colspan="6"><div class="detail-body"><div><h4>Items per hour</h4><ul>${itemRows}</ul><p class="small muted">Negative is used up. Measured changes include anything you sold, bought or banked meanwhile.</p></div></div></td></tr>`);
    }
    return out;
  });
  return `${head}
    <div class="grid stats">${['good', 'close', 'off'].map((k) => `<div class="card stat"><div class="label">${k === 'good' ? 'Within 5%' : k === 'close' ? 'Within 15%' : 'Further off'}</div><div class="value">${counts[k]}</div></div>`).join('')}</div>
    ${card('Your actions, biggest difference first', table(['Action', '#Measured for', '#Measured XP/h', '#Estimate', '#Difference', 'Likely why'], body))}
    <p class="small muted" style="margin-top:10px">Estimates are at your current level${gd.playerBonuses ? ' with your bonuses' : ''}; an action measured across several levels can differ a little for that reason alone.</p>`;
}
