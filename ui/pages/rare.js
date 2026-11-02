// Rare items: everything you only get by chance, where it comes from and how long you'd need for an
// even chance of one, split by what you can go for now.
import { STYLES } from '/engine/combat.js';
import { levelsAway, RARITY, rareItems, rareOdds } from '/engine/rare-items.js';
import { triesSoFar } from '/engine/rare-tries.js';
import { computeRates } from '/engine/rates.js';
import { bestFightsByEnemy } from '/engine/slayer.js';
import { ago, duration, esc, exact, iconImg, pct } from '/ui/format.js';
import { combatRecommendation } from './combat.js';
import { currentMethodKey } from './route-ui.js';
import { card, enc, itemLink, memo, methodLink, pageHead, saveKey, skillName } from './shared.js';

// What you're doing in the game, to mark the items it can give: the skilling action, or the enemy you're
// fighting (every enemy in it for an area or dungeon). The save names a fight "Combat - Treant".
export function doing(ctx) {
  const { gd } = ctx;
  const method = currentMethodKey(ctx);
  const enemies = new Set();
  const h = ctx.save?.header;
  if (ctx.state.levelSource === 'save' && h?.activeEntityName === 'Combat' && h.activeActionName) {
    const name = String(h.activeActionName).toLowerCase();
    const enemy = gd.enemies.find((e) => e.name.toLowerCase() === name);
    const area = gd.areas.find((a) => a.name.toLowerCase() === name);
    const dungeon = (gd.raw.combat?.dungeons ?? []).find((d) => d.name.toLowerCase() === name);
    if (enemy) enemies.add(enemy.id);
    for (const id of area?.enemies ?? []) enemies.add(id);
    for (const f of dungeon?.fights ?? []) for (const e of f.enemies) enemies.add(e.enemy);
  }
  if (!method && !enemies.size) return null;
  const label = method ? gd.methodByKey.get(method)?.name : h.activeActionName;
  return { label, fight: !method, on: (s) => (s.type === 'method' && s.method.key === method) || (s.type === 'enemy' && enemies.has(s.enemy.id)) };
}

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

// A tool you own but haven't put on yet: which one, which toolbelt, and how many you have.
function equipNote(ctx, list) {
  return list.map((r) => {
    const t = r.owned[0];
    const have = ctx.stock?.[t.item] ?? 0;
    const used = t.usedPer ? `, one used up per ${t.usedPer}` : '';
    return `<span class="sub small accent-text">First put ${itemLink(ctx, t.item)} in your ${esc(skillName(ctx, t.skill))} toolbelt${have ? ` (you have ${exact(have)}${used})` : ''}.</span>`;
  }).join('');
}

function itemHead(ctx, r) {
  const status = `${r.on ? ` <span class="pill good">You're on this</span>` : ''}${r.found === true ? ' <span class="pill good">Found</span>' : r.found === false ? ' <span class="pill">Not found yet</span>' : ''}`;
  const have = r.have > 0 ? ` <span class="muted small">you have ${exact(r.have)}</span>` : '';
  return `${itemLink(ctx, r.item)} ${rarityPill(r.rarity)}${status}${have}`;
}

const rarityPill = (b) => `<span class="pill${b.id === 'legendary' ? ' accent' : ''}" title="${esc(b.label)}">${esc(b.name)}</span>`;

// Rare finds the companion logged (server/rare-finds.js), newest first: the item, how rare it is, when,
// and what you were doing. Also on the Overview's "While you were away".
export function findList(ctx, finds) {
  const rows = [...finds].sort((a, b) => b.at - a.at).map((f) => {
    const band = rareOdds(ctx.gd, f.item)?.rarity;
    const count = f.count > 1 ? ` <span class="muted small">×${exact(f.count)}</span>` : '';
    return `<li><span>${itemLink(ctx, f.item)}${count}${band ? ` ${rarityPill(band)}` : ''}${f.activity ? `<span class="sub muted small">${esc(f.activity)}</span>` : ''}</span><span class="num small muted">${esc(ago(f.at))}</span></li>`;
  });
  return `<ul class="list-plain">${rows.join('')}</ul>`;
}

// Your last two finds, under the boxes of what you've found so far. Nothing until there's one. (The
// companion keeps only the latest 200, so the log stays small however long you play.)
const RECENT_FINDS = 2;
function recentFinds(ctx) {
  const log = ctx.state.finds;
  if (!log?.list.length || log.id !== ctx.save?.id) return '';
  return card('Recent finds', findList(ctx, log.list.slice(-RECENT_FINDS)), ' style="margin-bottom:12px"');
}

// The other places it comes from, briefly.
function others(ctx, r, shown) {
  const rest = r.sources.filter((s) => s !== shown);
  if (!rest.length) return '';
  const list = rest.slice(0, 3).map((s) => `${sourceText(ctx, s)} (${odds(s.p)})`).join(' · ');
  return `<span class="sub muted small">Also: ${list}${rest.length > 3 ? ` and ${rest.length - 3} more` : ''}</span>`;
}

const li = (r) => (r.on ? '<li class="on">' : '<li>');

// Found so far, of every rare item and of each rarity: a box each, which is also the filter for the lists.
function statBoxes(all, ui, hasFound) {
  const box = (id, name, list, note) => {
    const found = list.filter((r) => r.found).length;
    const share = list.length ? found / list.length : 0;
    const value = hasFound ? `${exact(found)} <span class="of">of ${exact(list.length)}</span>` : exact(list.length);
    const bar = hasFound ? `<span class="bar" role="progressbar" aria-label="${esc(name)} found" aria-valuenow="${Math.round(share * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(share * 100).toFixed(1)}%"></span></span>` : '';
    const sub = hasFound ? `${exact(list.length - found)} to find · ${note}` : note;
    return `<button class="card stat rare-box" data-action="rareBand" data-value="${id}" aria-pressed="${ui.band === id}"><span class="label">${esc(name)}</span><span class="value">${value}</span>${bar}<span class="small muted">${esc(sub)}</span></button>`;
  };
  return `<div class="grid stats rare-stats" role="group" aria-label="Found so far by rarity: pick one to list only those">${box('all', hasFound ? 'Found so far' : 'Rare items', all, 'every rarity')}${RARITY.map((b) => box(b.id, b.name, all.filter((r) => r.rarity.id === b.id), b.label)).join('')}</div>`;
}

// What you've already put in at this source, from your save's statistics, and how many players would
// have one by now: so a long wait reads as bad luck, not a wrong estimate.
function triesLine(ctx, r, b, rates) {
  if (r.found || !ctx.save || ctx.state.levelSource !== 'save') return '';
  const t = triesSoFar(ctx.gd, ctx.save, r.item, b, rates);
  if (!t) return '';
  const hours = t.hours ?? (b.type === 'enemy' && b.kills && b.hours > 0 ? t.tries / (b.kills / b.hours) : null);
  const tried = `So far: ${exact(t.tries)} ${esc(t.unit)}${t.attempts && t.attempts !== t.tries ? ` (${exact(t.attempts)} tries)` : ''}${hours ? `, about ${duration(hours)}` : ''}.`;
  const luck = t.chance >= 0.5
    ? ` ${pct(t.chance, 0)} of players would have one by now. The odds don't build up: every try is as likely as the first.`
    : ` About ${pct(t.chance, 0)} of players would have one by now.`;
  return `<span class="sub small muted">${tried}${luck}</span>`;
}

// The odds at your level. Thieving loot only rolls on a success, so it's per successful steal there,
// the same the "so far" line counts.
function oddsNow(b, pNow, rates) {
  if (!(pNow > 0)) return `${odds(b.p)} ${per(b)}`;
  const s = rates?.successChance;
  if (b.method?.kind === 'thieving' && s > 0 && s < 1) return `${odds(Math.min(1, pNow / s))} per successful steal at your level (you succeed ${pct(s, 0)} of the time)`;
  return `${odds(pNow)} ${per(b)} at your level`;
}

function nowRow(ctx, r) {
  // The source you're on, when it isn't the quickest: that's the one you're working on.
  const b = r.onSource?.now ? r.onSource : r.best;
  // The odds at your level, the same the time is worked out with (the rarity is from the unlock level).
  const rates = b.type === 'method' ? computeRates(ctx.gd, b.method, ctx.gd.levelOf(ctx.levels, b.method.skill)) : null;
  const pNow = rates?.cyclesPerHour ? rates.chancePerCycle?.[r.item] ?? Math.min(1, (rates.outputs.find((o) => o.item === r.item)?.perHour ?? 0) / rates.cyclesPerHour) : 0;
  const time = b.hours === 0
    ? `<span class="num">${pct(b.chanceFromOwned, b.chanceFromOwned < 0.1 ? 1 : 0)}<span class="sub muted small">from yours</span></span>`
    : `<span class="num">${duration(b.hours)}<span class="sub muted small">${b.kills ? `${exact(b.kills)} kills` : 'for a 50% chance'}</span></span>`;
  return `${li(r)}<span>${itemHead(ctx, r)}<span class="sub small">${sourceText(ctx, b)} · ${oddsNow(b, pNow, rates)}</span>${triesLine(ctx, r, b, rates)}${b.equip?.length ? equipNote(ctx, b.equip) : ''}${others(ctx, r, b)}</span>${time}</li>`;
}

function soonRow(ctx, r) {
  const s = r.sources.filter((x) => x.needs?.length).sort((a, b) => levelsAway(ctx.gd, { sources: [a] }, ctx.levels) - levelsAway(ctx.gd, { sources: [b] }, ctx.levels))[0];
  const needs = s.needs.map((n) => `${esc(skillName(ctx, n.skill))} ${n.level} <span class="muted">(you're ${ctx.gd.levelOf(ctx.levels, n.skill)})</span>`).join(', ');
  return `${li(r)}<span>${itemHead(ctx, r)}<span class="sub small">${sourceText(ctx, s)} · ${odds(s.p)} ${per(s)}</span><span class="sub small warn-text">Needs ${needs}</span>${others(ctx, r, s)}</span><span class="num">+${exact(r.away)}<span class="sub muted small">levels</span></span></li>`;
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
      return `${li(r)}<span>${itemHead(ctx, r)}<span class="sub muted small">${sourceText(ctx, s)} · ${odds(s.p)} ${per(s)}</span></span></li>`;
    };
    return `<h4 class="small" style="margin:12px 0 4px">${esc(title)} <span class="muted">· ${exact(items.length)}</span></h4><ul class="list-plain">${items.slice(0, LIST_LIMIT).map(line).join('')}</ul>`;
  }).join('');
}

export function rarePage(ctx) {
  const { state } = ctx;
  const ui = (state.ui.rare ??= { band: 'all', missing: false });
  // Items what you're doing in the game can give are marked and go first.
  const d = doing(ctx);
  const all = rows(ctx).map((r) => {
    const s = d && r.sources.find(d.on);
    return s ? { ...r, on: true, onSource: s } : r;
  });
  const hasFound = all.some((r) => r.found != null);
  const shown = all.filter((r) => (ui.band === 'all' || r.rarity.id === ui.band) && !(ui.missing && r.found));
  // What you're doing gets its own box; the rest go in the lists below it.
  const onItems = shown.filter((r) => r.on && (r.onSource.now || r.best));
  const rest = shown.filter((r) => !onItems.includes(r));
  // Chests you already have are a roll you can make right now, so they get their own list.
  const inChests = rest.filter((r) => r.best?.type === 'open' && r.best.have > 0).sort((a, b) => b.best.chanceFromOwned - a.best.chanceFromOwned);
  const now = rest.filter((r) => r.best && !inChests.includes(r)).sort((a, b) => a.best.hours - b.best.hours);
  const soon = rest.filter((r) => !r.best).map((r) => ({ ...r, away: levelsAway(ctx.gd, r, ctx.levels) })).filter((r) => Number.isFinite(r.away)).sort((a, b) => a.away - b.away);
  const soonSet = new Set(soon.map((r) => r.item));
  const later = rest.filter((r) => !r.best && !soonSet.has(r.item));

  const band = RARITY.find((b) => b.id === ui.band);
  const missing = hasFound ? `<label class="small" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-action="rareMissing"${ui.missing ? ' checked' : ''}> Only ones I haven't found</label>` : '';
  const showing = `<span class="small muted">Listing ${exact(shown.length)}${band ? ` ${esc(band.name.toLowerCase())}` : ''} item${shown.length === 1 ? '' : 's'}. Pick a box above to list one rarity.</span>`;
  const controls = `${statBoxes(all, ui, hasFound)}${recentFinds(ctx)}<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">${missing}${showing}</div>`;

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
  // The rare items what you're doing in the game can give, in a box of their own at the top.
  const doingCard = onItems.length
    ? card(`${d.fight ? "What you're fighting" : "What you're doing"} now: ${esc(d.label)} <span class="muted small">· ${exact(onItems.length)}</span>`, `<p class="small muted">Rare items it can give, with your odds and the time for an even chance of each.</p><ul class="list-plain">${onItems.map((r) => nowRow(ctx, { ...r, on: false })).join('')}</ul>`, ' style="margin-bottom:12px"')
    : '';
  return `${head}${basis}${controls}${doingCard}${chestCard}${nowCard}<div style="margin-top:12px">${soonCard}</div>${laterCard}`;
}
