// Rare items: everything you only get by chance, where it comes from and how long you'd need for an
// even chance of one, split by what you can go for now.
import { STYLES } from '/engine/combat.js';
import { levelsAway, RARITY, rareItems } from '/engine/rare-items.js';
import { bestFightsByEnemy } from '/engine/slayer.js';
import { duration, esc, exact, iconImg, pct } from '/ui/format.js';
import { combatRecommendation } from './combat.js';
import { card, enc, itemLink, memo, methodLink, pageHead, saveKey, skillName } from './shared.js';

const LIST_LIMIT = 60;

const odds = (p) => `1 in ${exact(Math.max(1, Math.round(1 / p)))}`;
const enemyLink = (e) => `<a class="with-icon" href="#/lookup/enemy/${enc(e.id)}">${iconImg(e.icon, 'icon sm')}${esc(e.name)}</a>`;

function rows(ctx) {
  return memo('rare:items', saveKey(ctx), () => {
    const fights = ctx.gd.combat && ctx.save?.combat && ctx.bank ? bestFightsByEnemy(STYLES.map((style) => combatRecommendation(ctx, style))) : null;
    return rareItems(ctx.gd, { levels: ctx.levels, bestFights: fights, owned: ctx.stock ?? {}, found: ctx.save?.itemsFound ?? null });
  });
}

// Where one source is, in words: "Fishing at Calm Shallows", "Thug (Thieving)", "kill Magic Cow".
function sourceText(ctx, s) {
  if (s.type === 'method') return `${methodLink(s.method)} <span class="muted small">${esc(skillName(ctx, s.method.skill))}</span>`;
  if (s.type === 'enemy') return `kill ${enemyLink(s.enemy)}${s.style ? ` <span class="muted small">${esc(s.style)}</span>` : ''}`;
  const chest = `open ${itemLink(ctx, s.from)}`;
  if (s.have) return `${chest} <span class="muted small">you have ${exact(s.have)}</span>`;
  if (s.chest) return `${chest} <span class="muted small">from ${s.chest.type === 'method' ? methodLink(s.chest.method) : enemyLink(s.chest.enemy)}</span>`;
  return chest;
}

const per = (s) => (s.type === 'method' ? 'per action' : s.type === 'enemy' ? 'per kill' : 'per chest');

function itemHead(ctx, r) {
  const status = r.found === true ? ' <span class="pill good">Found</span>' : r.found === false ? ' <span class="pill">Not found yet</span>' : '';
  const have = r.have > 0 ? ` <span class="muted small">you have ${exact(r.have)}</span>` : '';
  return `${itemLink(ctx, r.item)} <span class="pill${r.rarity.id === 'legendary' ? ' accent' : ''}" title="${esc(r.rarity.label)}">${esc(r.rarity.name)}</span>${status}${have}`;
}

// The other places it comes from, briefly.
function others(ctx, r, shown) {
  const rest = r.sources.filter((s) => s !== shown);
  if (!rest.length) return '';
  const list = rest.slice(0, 3).map((s) => `${sourceText(ctx, s)} (${odds(s.p)})`).join(' · ');
  return `<span class="sub muted small">Also: ${list}${rest.length > 3 ? ` and ${rest.length - 3} more` : ''}</span>`;
}

function nowRow(ctx, r) {
  const b = r.best;
  const time = b.hours === 0
    ? `<span class="num">${pct(b.chanceFromOwned, b.chanceFromOwned < 0.1 ? 1 : 0)}<span class="sub muted small">from yours</span></span>`
    : `<span class="num">${duration(b.hours)}<span class="sub muted small">${b.kills ? `${exact(b.kills)} kills` : 'for a 50% chance'}</span></span>`;
  return `<li><span>${itemHead(ctx, r)}<span class="sub small">${sourceText(ctx, b)} · ${odds(b.p)} ${per(b)}${b.equip?.length ? ' <span class="accent-text">(equip the tool it needs first)</span>' : ''}</span>${others(ctx, r, b)}</span>${time}</li>`;
}

function soonRow(ctx, r) {
  const s = r.sources.filter((x) => x.needs?.length).sort((a, b) => levelsAway(ctx.gd, { sources: [a] }, ctx.levels) - levelsAway(ctx.gd, { sources: [b] }, ctx.levels))[0];
  const needs = s.needs.map((n) => `${esc(skillName(ctx, n.skill))} ${n.level} <span class="muted">(you're ${ctx.gd.levelOf(ctx.levels, n.skill)})</span>`).join(', ');
  return `<li><span>${itemHead(ctx, r)}<span class="sub small">${sourceText(ctx, s)} · ${odds(s.p)} ${per(s)}</span><span class="sub small warn-text">Needs ${needs}</span>${others(ctx, r, s)}</span><span class="num">+${exact(r.away)}<span class="sub muted small">levels</span></span></li>`;
}

// Why something is out of reach, grouped.
function laterGroups(ctx, list) {
  const why = (r) => (r.sources.some((s) => s.type === 'enemy') ? 'enemy' : r.sources.some((s) => s.type === 'open') ? 'chest' : 'other');
  const groups = [
    ['enemy', 'Dropped by enemies you can\'t beat safely yet'],
    ['chest', 'Inside chests you have no way to get yet'],
    ['other', 'Need something else first (a quest, a Mastery rank, a tool or a big level jump)'],
  ];
  return groups.map(([id, title]) => {
    const items = list.filter((r) => why(r) === id);
    if (!items.length) return '';
    const line = (r) => {
      const s = r.sources[0];
      return `<li><span>${itemHead(ctx, r)}<span class="sub muted small">${sourceText(ctx, s)} · ${odds(s.p)} ${per(s)}</span></span></li>`;
    };
    return `<h4 class="small" style="margin:12px 0 4px">${esc(title)} <span class="muted">· ${exact(items.length)}</span></h4><ul class="list-plain">${items.slice(0, LIST_LIMIT).map(line).join('')}</ul>`;
  }).join('');
}

export function rarePage(ctx) {
  const { state } = ctx;
  const ui = (state.ui.rare ??= { band: 'all', missing: false });
  const all = rows(ctx);
  const hasFound = all.some((r) => r.found != null);
  const shown = all.filter((r) => (ui.band === 'all' || r.rarity.id === ui.band) && !(ui.missing && r.found));
  // Chests you already have are a roll you can make right now, so they get their own list.
  const inChests = shown.filter((r) => r.best?.type === 'open' && r.best.have > 0).sort((a, b) => b.best.chanceFromOwned - a.best.chanceFromOwned);
  const now = shown.filter((r) => r.best && !inChests.includes(r)).sort((a, b) => a.best.hours - b.best.hours);
  const soon = shown.filter((r) => !r.best).map((r) => ({ ...r, away: levelsAway(ctx.gd, r, ctx.levels) })).filter((r) => Number.isFinite(r.away)).sort((a, b) => a.away - b.away);
  const soonSet = new Set(soon.map((r) => r.item));
  const later = shown.filter((r) => !r.best && !soonSet.has(r.item));

  const count = (band) => all.filter((r) => (band === 'all' || r.rarity.id === band) && !(ui.missing && r.found)).length;
  const bands = `<div class="segmented wrap" role="group" aria-label="Rarity">${[['all', 'All'], ...RARITY.map((b) => [b.id, b.name])].map(([v, l]) => `<button data-action="rareBand" data-value="${v}" aria-pressed="${ui.band === v}" title="${esc(RARITY.find((b) => b.id === v)?.label ?? 'Every rare item')}">${esc(l)} <span class="muted small">${exact(count(v))}</span></button>`).join('')}</div>`;
  const missing = hasFound ? `<label class="small" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-action="rareMissing"${ui.missing ? ' checked' : ''}> Only ones I haven't found</label>` : '';
  const controls = `<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">${bands}${missing}</div>`;

  const head = pageHead('Rare items', 'Everything you only get by chance: how rare it is, where it comes from, and how long you\'d need for an even chance of one at your levels. Rarity is the best odds any source gives.');
  const basis = ctx.save ? '' : '<p class="notice">Load a save to time enemy drops with your gear and to count the chests you already have.</p>';
  const chestCard = inChests.length
    ? card(`Open what you have <span class="muted small">· ${exact(inChests.length)}</span>`, `<p class="small muted">Chests and nests already in your bank that can hold one. The chance is for opening all of them; best odds first.</p><ul class="list-plain">${inChests.map((r) => nowRow(ctx, r)).join('')}</ul>`, ' style="margin-bottom:12px"')
    : '';
  const nowCard = card(`You can go for these now <span class="muted small">· ${exact(now.length)}</span>`, now.length
    ? `<p class="small muted">Quickest first. Times are for a 50% chance of at least one, with your levels and bonuses (and your best gear for enemy drops).</p><ul class="list-plain">${now.slice(0, LIST_LIMIT).map((r) => nowRow(ctx, r)).join('')}</ul>${now.length > LIST_LIMIT ? `<p class="small muted">And ${exact(now.length - LIST_LIMIT)} more slower ones. Pick a rarity above to narrow it down.</p>` : ''}`
    : '<p class="muted small">Nothing here you can go for yet.</p>');
  const soonCard = card(`A few levels away <span class="muted small">· ${exact(soon.length)}</span>`, soon.length
    ? `<p class="small muted">Fewest levels first.</p><ul class="list-plain">${soon.slice(0, LIST_LIMIT).map((r) => soonRow(ctx, r)).join('')}</ul>`
    : '<p class="muted small">Nothing is only levels away.</p>');
  const laterCard = later.length
    ? `<section class="card" style="margin-top:12px"><details class="row-detail"><summary><strong>Out of reach for now</strong> <span class="muted small">· ${exact(later.length)}</span></summary>${laterGroups(ctx, later)}</details></section>`
    : '';
  const summary = `<p class="small muted" style="margin:0 0 10px">${exact(all.length)} rare items in the game${hasFound ? `, ${exact(all.filter((r) => r.found).length)} found so far` : ''}.</p>`;
  return `${head}${basis}${controls}${summary}${chestCard}${nowCard}<div style="margin-top:12px">${soonCard}</div>${laterCard}`;
}
