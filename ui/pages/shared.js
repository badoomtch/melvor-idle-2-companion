// Pieces shared by every page: links, cards, tables, method rows.
import { describeRequirement, GP } from '/engine/gamedata.js';
import { thievingDrops, triesFor } from '/engine/lookup.js';
import { duration, esc, exact, gp, iconImg, iconUrl, num, pct } from '/ui/format.js';

export const enc = encodeURIComponent;
export const itemLink = (ctx, id) => `<a class="with-icon" href="#/lookup/item/${enc(id)}">${iconImg(ctx.gd.items[id]?.icon, 'icon sm')}${esc(ctx.gd.itemName(id))}</a>`;
// A method's own art, else the icon of what it makes.
function methodIconPath(gd, m) {
  if (iconUrl(m.icon)) return m.icon;
  const product = m.product?.item ?? m.products?.[0]?.item;
  return product ? gd.items[product]?.icon : null;
}
export const methodIcon = (gd, m, cls = 'icon sm') => iconImg(methodIconPath(gd, m), cls);
let currentGd = null; // set by renderView (setCurrentGd) so methodLink can find icons
export function setCurrentGd(gd) {
  currentGd = gd;
}
export const methodLink = (m) => `<a class="with-icon" href="#/lookup/method/${enc(m.key)}">${currentGd ? methodIcon(currentGd, m) : ''}${esc(m.name)}</a>`;
export const skillName = (ctx, s) => ctx.gd.skillName(s);

// One step of a gathering chain: "get 3 Iron Ore (Mining)", or "make 3 Iron Bar with Iron Bar (Smithing)"
// when the recipe isn't simply named after what it makes.
export function gatherStep(ctx, n) {
  const skill = esc(skillName(ctx, n.method.skill));
  const named = n.method.name.toLowerCase() === ctx.gd.itemName(n.item).toLowerCase();
  return `${n.makes ? 'make' : 'get'} ${exact(Math.ceil(n.qty))} ${itemLink(ctx, n.item)}${named ? '' : ` with ${methodLink(n.method)}`} (${skill})`;
}

// Remembers the last few results of slow work (plans, comparisons) until its key changes,
// so a page that re-renders on every autosave doesn't redo it each time.
const memoCache = new Map();
export function memo(name, key, compute) {
  const hit = memoCache.get(name);
  if (hit && hit.key === key) return hit.value;
  const value = compute();
  memoCache.set(name, { key, value });
  return value;
}
// A key that changes with every new autosave (or any change to levels and bonuses).
export const saveKey = (ctx) => `${ctx.save?.id ?? 'manual'}|${ctx.save?.header.timestamp ?? 0}|${ctx.state.useBonuses}|${ctx.state.levelSource}|${Object.values(ctx.levels).join(',')}`;
// A key that changes when your levels, bonuses or (optionally) bank change.
export const levelsKey = (ctx, withBank = false) => `${ctx.save?.id ?? 'manual'}|${ctx.state.useBonuses}|${Object.values(ctx.levels).join(',')}${withBank ? `|${Object.keys(ctx.stock ?? {}).length}` : ''}`;

// How a skilling bonus reads: "+10% XP", "+1 extra items per craft (Arrows)".
const STAT_LABELS = {
  DoublingChance: 'double items', PreservationChance: 'keep materials', SkipStepChance: 'skip a step', PercentXPGained: 'XP',
  PercentIncreaseRockBreakChance: 'rock break chance', DoubleDamageChance: 'double tree damage', FlatMaxInterval: 'max catch time',
  FlatProficiency: 'cooking proficiency', FlatProductQuantity: 'extra items per craft', FlatStealth: 'stealth', PercentStealth: 'stealth',
  PercentStunInterval: 'stun time', PercentInterval: 'action time', PercentMaxHealth: 'tree health', FlatOnHitItemQuantity: 'extra per find',
  FlatTrappingSuccessChance: 'trap success', PercentSurveyInterval: 'survey time',
};
export function bonusText(e) {
  const flatChance = e.stat === 'FlatTrappingSuccessChance';
  const value = /^Flat/.test(e.stat) && !flatChance
    ? `${e.value > 0 ? '+' : ''}${e.stat === 'FlatMaxInterval' ? `${num(e.value / 1000)}s` : num(e.value)}`
    : `${e.value > 0 ? '+' : ''}${pct(e.value, Math.abs(e.value) < 0.1 ? 1 : 0)}`;
  const label = STAT_LABELS[e.stat] ?? e.stat.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(Flat|Percent) /, '').toLowerCase();
  return `${value} ${label}${e.scope ? ` (${Object.values(e.scope).join(', ')})` : ''}`;
}
export const signed = (n) => `<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : ''}">${gp(n, { signed: true })}</span>`;
export const stat = (label, value) => `<div class="card stat"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;
export const card = (title, body, extra = '') => `<section class="card"${extra}>${title ? `<h3>${title}</h3>` : ''}${body}</section>`;
export const pageHead = (title, sub = '', right = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;
export const table = (head, rows, empty = 'Nothing to show.') =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th${h.startsWith('#') ? ' class="num"' : ''}>${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="muted">${esc(empty)}</p>`;

function rateNotes(ctx, r) {
  const notes = [];
  if (r.successChance != null && r.successChance < 1) notes.push(`${pct(r.successChance)} success`);
  if (r.food) notes.push(`eats ${num(r.food.perHour)} ${esc(ctx.gd.itemName(r.food.item))}/h`);
  if (r.note) notes.push(esc(r.note));
  for (const [c, n] of Object.entries(r.currencies)) if (c !== GP && n > 0) notes.push(`+${num(n)} ${esc(ctx.gd.currencyName(c))}/h`);
  return notes.join(' · ');
}

export function requirementText(ctx, list) {
  return list.map((r) => esc(describeRequirement(ctx.gd, r))).join(', ');
}

export function methodDetail(ctx, x) {
  const { gd } = ctx;
  const r = x.rates;
  const m = x.method;
  const li = (rows) => (rows.length ? `<ul>${rows.join('')}</ul>` : '<p class="muted small">None</p>');
  const gains = [
    ...r.outputs.map((o) => `<li>${itemLink(ctx, o.item)} × ${num(o.perHour)}${o.value ? ` <span class="muted">(${gp(o.value)} GP)</span>` : ''}</li>`),
    ...Object.entries(r.currencies).filter(([, n]) => n > 0).map(([c, n]) => `<li>${num(n)} ${esc(gd.currencyName(c))}</li>`),
  ];
  const costs = [
    ...r.inputs.map((i) => `<li>${itemLink(ctx, i.item)} × ${num(i.perHour)} <span class="muted">(${gp(i.value)} GP)</span></li>`),
    ...(r.toolUse ?? []).map((t) => `<li>${itemLink(ctx, t.item)} × ${num(t.perHour)} <span class="muted">(${gp(t.value)} GP, from your toolbelt)</span></li>`),
    ...Object.entries(r.currencies).filter(([, n]) => n < 0).map(([c, n]) => `<li>${num(-n)} ${esc(gd.currencyName(c))}</li>`),
    ...(r.food ? [`<li>${itemLink(ctx, r.food.item)} × ${num(r.food.perHour)} <span class="muted">(${gp(r.food.value)} GP) to heal ${num(r.hpLossPerHour)} HP</span></li>`] : []),
  ];
  let extra = '';
  if (m.kind === 'thieving') {
    const drops = thievingDrops(m).filter((d) => d.chance > 0).sort((a, b) => b.chance - a.chance);
    const s = r.successChance;
    extra = `<div><h4>Loot per attempt</h4>${li(drops.map((d) => `<li>${itemLink(ctx, d.item)} <span class="muted">${pct(d.chance * s, d.chance * s < 0.01 ? 2 : 1)} · ~${exact(triesFor(d.chance * s, 0.5))} tries for 50%</span></li>`))}</div>`;
  }
  const reqs = [...(x.missing ?? []), ...(x.unknown ?? []), ...(x.equip ?? [])];
  return `<div class="detail-body">
    <div><h4>Each action</h4><p>${(r.msPerCycle / 1000).toFixed(r.msPerCycle < 10000 ? 2 : 1)}s${r.note ? ` · ${esc(r.note)}` : ''}</p>
      ${r.successChance != null ? `<p>Success chance ${pct(r.successChance, 1)}</p>` : ''}
      <p class="muted small">${num(r.cyclesPerHour)} per hour</p>
      ${reqs.length ? `<p class="small">Requires: ${requirementText(ctx, reqs)}</p>` : ''}</div>
    <div><h4>Gains per hour</h4>${li(gains)}</div>
    <div><h4>Costs per hour</h4>${li(costs)}</div>
    ${extra}
  </div>`;
}

export function methodRows(ctx, list, { columns = ['skill'], expandable = true, sustain = false, markBest = true } = {}) {
  const bestIndex = list.findIndex((x) => x.ok !== false && !x.unknown?.length);
  return list.flatMap((x, i) => {
    const r = x.rates;
    const m = r.method ?? x.method;
    const open = ctx.state.ui.expanded.has(m.key);
    const locked = x.ok === false;
    const cells = [
      `<td>${expandable ? `<button class="link" data-action="toggle" data-key="${esc(m.key)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${methodIcon(ctx.gd, m)}${esc(m.name)}</button>` : methodLink(m)}<span class="sub">${esc([m.category, m.type].filter(Boolean).join(' · '))}</span></td>`,
      ...(columns.includes('skill') ? [`<td class="nowrap"><a href="#/skills/${m.skill}">${esc(skillName(ctx, m.skill))}</a></td>`] : []),
      `<td class="num">${m.level}</td>`,
      `<td class="num">${num(r.xpPerHour)}</td>`,
      `<td class="num">${signed(r.profitPerHour)}</td>`,
      ...(sustain ? [`<td class="num">${duration(x.sustain)}</td>`] : []),
      `<td class="small">${locked ? `<span class="pill">${x.missing.some((q) => q.type === 'locked') ? 'Not in demo' : `${x.missing.every((q) => q.type === 'level') ? 'Unlocks at' : 'Needs'} ${requirementText(ctx, x.missing)}`}</span>` : `${x.unknown?.length ? `<span class="pill warn">Needs ${requirementText(ctx, x.unknown)}</span> ` : ''}${x.equip?.length ? `<span class="pill accent">${requirementText(ctx, x.equip)}</span> ` : ''}${rateNotes(ctx, r)}`}</td>`,
    ];
    const rows = [`<tr class="${locked ? 'locked' : markBest && i === bestIndex ? 'best' : ''}">${cells.join('')}</tr>`];
    if (open) rows.push(`<tr><td colspan="${cells.length}">${methodDetail(ctx, x.method ? x : { ...x, method: m })}</td></tr>`);
    return rows;
  });
}


export function noSaveCard(ctx) {
  return `<div class="card empty">
    <h2>No save found yet</h2>
    <p>The companion reads your saves from:</p>
    ${(ctx.state.status?.saveDirs ?? []).map((d) => `<p><code>${esc(d)}</code></p>`).join('')}
    <p>Start Melvor Idle 2 and play for a minute. The game saves automatically and this page updates by itself.</p>
    <p>Or <a href="#/settings">enter your levels by hand</a> to use every tool right now.</p>
  </div>`;
}
