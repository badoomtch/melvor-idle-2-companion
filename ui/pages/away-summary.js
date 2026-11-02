// While you were away: a card at the top of the Overview when you come back to the page after 30 minutes
// or more, with what happened since you last had it open. app.js notices you were away and fetches the
// stored history and rare finds once; levels, XP and gold come from that history (engine/history.js).
import { summary, xpOf } from '/engine/history.js';
import { activityKey } from '/engine/supplies.js';
import { ago, badge, duration, esc, exact, num } from '/ui/format.js';
import { findList } from './rare.js';
import { signed, skillName, stat } from './shared.js';

// The game autosaves every 10 seconds: two minutes without a save means it stopped.
const STALE_MS = 120_000;
// The same action this long without XP is stuck (history points are 5 minutes apart).
const STUCK_MS = 15 * 60_000;
const FIND_ROWS = 5;
const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// Levels gained in each skill between two history points, most first.
function levelsGained(gd, from, to) {
  const out = [];
  for (const [skill, xp] of Object.entries(to.xp ?? {})) {
    const was = gd.xp.levelForXp(from.xp?.[skill] ?? 0, gd.levelCap);
    const now = gd.xp.levelForXp(xp, gd.levelCap);
    if (now > was) out.push({ skill, was, now });
  }
  return out.sort((a, b) => b.now - b.was - (a.now - a.was));
}

// When XP last went up in the history, or null if it never did.
function lastGain(points) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  for (let i = sorted.length - 1; i > 0; i--) if (xpOf(sorted[i]) > xpOf(sorted[i - 1])) return sorted[i].t;
  return null;
}

// Whether the game stopped doing anything, and what to do about it. Read from the save as it is now, so it
// goes once you've sorted it out.
function stopped(ctx, points, since) {
  const h = ctx.save.header;
  const age = Date.now() - h.timestamp;
  const gained = lastGain(points);
  const when = gained && gained > since ? `It last gained XP ${ago(gained)}.` : 'It gained no XP while you were away.';
  if (age > STALE_MS) return `<strong>The game last saved ${esc(ago(h.timestamp))}.</strong>It may have been closed, paused or frozen. Check on it to keep it going.`;
  const activity = activityKey(h);
  if (!activity) return `<strong>Nothing is training.</strong>${when} Pick something to do from <a href="#/next">What next</a>.`;
  if (gained && Date.now() - gained > STUCK_MS) return `<strong>${esc(activity)} isn't gaining XP.</strong>${when} Check the game: a full bank or running out of materials stops it.`;
  return '';
}

export function awaySummary(ctx) {
  const a = ctx.state.awaySummary;
  if (!a?.points || a.id !== ctx.save?.id) return '';
  const { gd } = ctx;
  const sum = summary(a.points, { from: a.from, to: Infinity });
  const levels = sum ? levelsGained(gd, sum.first, sum.last) : [];
  const finds = (a.finds ?? []).filter((f) => f.at > a.from);
  const stats = sum
    ? `<div class="grid stats mini" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">${stat('XP gained', num(sum.xp))}${stat('Levels gained', exact(levels.reduce((s, l) => s + l.now - l.was, 0)))}${stat('Gold', signed(sum.gp))}${stat('Rare finds', exact(finds.length))}</div>`
    : '<p class="muted small">No progress was saved while you were away.</p>';
  const levelLine = levels.length
    ? `<p class="small" style="margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 14px">${levels.map((l) => `<span class="with-icon">${badge(l.skill, skillName(ctx, l.skill))}${esc(skillName(ctx, l.skill))} ${l.was} → <strong>${l.now}</strong></span>`).join('')}</p>`
    : '';
  const more = finds.length > FIND_ROWS ? `<p class="small muted">And ${exact(finds.length - FIND_ROWS)} more on <a href="#/rare">Rare items</a>.</p>` : '';
  const findsBlock = finds.length ? `<h4 class="small" style="margin:12px 0 4px">Rare finds</h4>${findList(ctx, finds.slice(-FIND_ROWS))}${more}` : '';
  const warning = stopped(ctx, a.points, a.from);
  return `<section class="card" style="margin-bottom:12px">
    <h3>While you were away <span class="muted small">· ${esc(duration((a.to - a.from) / 3_600_000))}</span></h3>
    <p class="small muted">Since you last had this page open (${esc(timeFmt.format(a.from))}).</p>
    ${stats}${levelLine}${findsBlock}
    ${warning ? `<div class="verdict warn">${warning}</div>` : ''}
    <p style="margin:12px 0 0"><button class="primary" data-action="awayDismiss">Got it</button></p>
  </section>`;
}
