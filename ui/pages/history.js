// History: progress over hours, days and weeks.
import { buckets, RANGES, skillGains, summary } from '/engine/history.js';
import { columnChart, lineChart } from '/ui/charts.js';
import { badge, duration, esc, exact, gp, num, pct } from '/ui/format.js';
import { card, noSaveCard, pageHead, signed, skillName, stat, table } from './shared.js';

// ---------- History ----------

const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function historyView(ctx) {
  const { gd, state } = ctx;
  const head = pageHead('History', 'Your progress over hours, days and weeks. While the companion runs it stores a point every 5 minutes in its own folder (never the game\'s).');
  if (!ctx.save) return `${head}${noSaveCard(ctx)}`;
  const h = state.history;
  if (!h || h.id !== ctx.save.id) return `${head}<p class="loading">Loading history…</p>`;
  const points = h.points;
  const rangeId = state.ui.historyRange ?? 'week';
  const to = Date.now();
  const first = points[0]?.t ?? to;
  const range = RANGES[rangeId] ?? { label: 'All time', ms: to - first, size: 'day' };
  const from = rangeId === 'all' ? first : to - range.ms;
  const skill = state.ui.historySkill || null;
  const what = skill ? `${skillName(ctx, skill)} XP` : 'XP';

  const ranges = [...Object.entries(RANGES), ['all', { label: 'All time' }]];
  const controls = `<div class="form-row">
      <div class="segmented" role="group" aria-label="Time range">${ranges.map(([id, r]) => `<button data-action="historyRange" data-value="${id}" aria-pressed="${id === rangeId}">${esc(r.label)}</button>`).join('')}</div>
      <label>Skill <select id="history-skill" data-bind="historySkill"><option value="">All skills</option>${gd.skills.map((sk) => `<option value="${sk.id}"${sk.id === skill ? ' selected' : ''}>${esc(sk.name)}</option>`).join('')}</select></label>
    </div>`;
  const sum = summary(points, { from, to, skill });
  if (!sum || points.length < 2) {
    return `${head}${controls}<div class="card empty"><h2>Not enough history yet</h2><p>Keep the companion running while you play. It stores a point every 5 minutes, and this page fills in over the next hour.</p></div>`;
  }

  const bucketList = buckets(points, { size: range.size, from, to, skill });
  const label = (b) => (range.size === 'hour' ? hourFmt.format(b.start) : dayFmt.format(b.start));
  const xpChart = columnChart(bucketList.map((b) => ({ label: label(b), value: b.xp, tip: range.size === 'hour' ? `${hourFmt.format(b.start)}–${hourFmt.format(b.end)}` : dayFmt.format(b.start) })), { title: `${what} per ${range.size}`, format: num });
  const inRange = points.filter((p) => p.t >= from);
  const gold = lineChart(inRange.map((p) => ({ t: p.t, v: p.gp ?? 0 })), { title: 'Gold', format: gp, timeLabel: (t) => dateTimeFmt.format(t) });
  const bank = lineChart(inRange.map((p) => ({ t: p.t, v: p.bank ?? 0 })), { title: 'Bank value', format: gp, timeLabel: (t) => dateTimeFmt.format(t) });

  const gains = skillGains(points, { from, to });
  const totalGain = gains.reduce((s2, g) => s2 + g.xp, 0) || 1;
  const gainRows = gains.map((g) => `<tr><td><span class="with-icon">${badge(g.skill, skillName(ctx, g.skill))}${esc(skillName(ctx, g.skill))}</span></td><td class="num">${exact(g.xp)}</td><td class="num">${pct(g.xp / totalGain)}</td></tr>`);
  const bucketRows = [...bucketList].reverse().filter((b) => b.xp || b.gp != null).map((b) => `<tr><td>${esc(range.size === 'hour' ? `${dayFmt.format(b.start)} ${hourFmt.format(b.start)}` : dayFmt.format(b.start))}</td><td class="num">${exact(b.xp)}</td><td class="num">${b.levels || ''}</td><td class="num">${b.gp != null ? exact(b.gp) : '–'}</td><td class="num">${b.bank != null ? exact(b.bank) : '–'}</td></tr>`);

  return `${head}${controls}
    <div class="grid stats">${stat(`${what} gained`, num(sum.xp))}${stat('Levels gained', exact(sum.levels))}${stat('Gold', signed(sum.gp))}${stat('Bank value', signed(sum.bank))}${stat('Time played', duration(sum.hoursPlayed))}</div>
    <div style="margin-top:12px">${card(`${esc(what)} per ${range.size}`, xpChart)}</div>
    <div style="margin-top:12px">${card('Gold', gold)}</div>
    <div style="margin-top:12px">${card('Bank value (sell prices)', bank)}</div>
    <div class="grid two" style="margin-top:12px;align-items:start">
      ${card('XP by skill', table(['Skill', '#XP', '#Share'], gainRows, 'No XP gained in this range.'))}
      ${card(`Per ${range.size}`, table([range.size === 'hour' ? 'Hour' : 'Day', `#${what}`, '#Levels', '#Gold', '#Bank value'], bucketRows))}
    </div>
    <p class="small muted" style="margin-top:10px">History starts from the first time you ran this version of the companion (${esc(dateTimeFmt.format(first))}). Time played counts the gaps between autosaves shorter than 10 minutes.</p>`;
}
