// Overview: your character, what you are doing right now, supplies and every skill.
import { bankInsights, currentActivity, obtain, producerIndex, rankSkill } from '/engine/advisor.js';
import { shopOffer } from '/engine/shop.js';
import { currentFight } from '/engine/current-fight.js';
import { currentSupplies, stockUp } from '/engine/supplies.js';
import { ago, badge, duration, esc, exact, gp, num, pct } from '/ui/format.js';
import { awaySummary } from './away-summary.js';
import { secs, styleOptions } from './combat.js';
import { card, gatherStep, itemLink, memo, methodLink, noSaveCard, pageHead, saveKey, signed, skillName, stat } from './shared.js';

export const STOCK_HOURS = [1, 2, 4, 8, 12];

// Stock up before you start: what you'd run out of within the time you pick, and the quickest way to
// get enough (making it, materials first, or the shop when it sells it).
function stockUpPart(ctx, list) {
  const { gd, state } = ctx;
  const hours = state.ui.stockHours;
  const pick = `<div class="segmented" role="group" aria-label="Keep going for">${STOCK_HOURS.map((h) => `<button data-action="stockHours" data-value="${h}" aria-pressed="${h === hours}">${h}h</button>`).join('')}</div>`;
  const index = memo('overview:producers', saveKey(ctx), () => producerIndex(gd, ctx.levels));
  const rows = stockUp(list, hours, { index, stock: ctx.stock, obtain });
  const wallet = { ...(ctx.save.wallet ?? {}), GoldPieces: ctx.save.wallet?.GoldPieces ?? ctx.save.header?.gp ?? 0 };
  const line = (r) => {
    const g = r.get;
    const make = g.method ? `${[...g.needs, { item: r.item, qty: g.short, method: g.method, makes: g.makes }].map((n) => gatherStep(ctx, n)).join(', then ')} <span class="muted">(about ${duration(g.hours)})</span>` : '';
    const offer = shopOffer(gd, r.item, r.short, { levels: ctx.levels, purchased: ctx.save.shopPurchases ?? {}, wallet });
    const buy = offer ? `buy ${exact(offer.qty)} in the <a href="#/shop">shop</a> for ${offer.currencies.map((c) => `${exact(c.qty)} ${esc(gd.currencyName(c.currency))}`).join(' + ')}` : '';
    const how = make && buy ? `${make[0].toUpperCase()}${make.slice(1)}, or ${buy}.` : make ? `${make[0].toUpperCase()}${make.slice(1)}.` : buy ? `${buy[0].toUpperCase()}${buy.slice(1)}.` : 'Nothing you can do yet makes it, and the shop doesn\'t sell it.';
    return `<li><span>${itemLink(ctx, r.item)} <span class="muted small">${exact(r.short)} more (${exact(r.have)} of ${exact(r.need)})</span><span class="sub small">${how}</span></span></li>`;
  };
  return `<h4 style="margin-top:12px">Stock up to keep going for ${pick}</h4>${rows.length
    ? `<ul class="list-plain">${rows.map(line).join('')}</ul>`
    : `<p class="small muted">You have enough for ${hours} hour${hours === 1 ? '' : 's'}.</p>`}`;
}

// A fight: what it gives with the gear you have on, the time to your next level, the risk, and whether
// your best gear in any style is clearly better on this enemy (the Combat page has the details).
function fightCard(ctx, f) {
  const { gd } = ctx;
  const r = f.result;
  const level = ctx.levels[f.skill] ?? 1;
  const rate = ctx.measured?.[f.skill] || r.xpPerHour[f.skill] || 0;
  const toNext = rate > 0 && level < gd.levelCap ? gd.xp.levelProgress(ctx.xp[f.skill], gd.levelCap).xpForNext / rate : null;
  const next = toNext != null ? `<p class="small">${esc(skillName(ctx, f.skill))} ${level + 1} in about ${duration(toNext)}${ctx.measured?.[f.skill] ? ' at your measured rate' : ''}.</p>` : '';
  const risk = r.risky ? `<div class="verdict warn"><strong>This fight could kill you.</strong>About every ${duration(r.hoursToDeath)} with this gear and food. <a href="#/combat">See safer gear</a></div>` : '';
  const best = styleOptions(ctx, { target: f.enemy }).filter((x) => x.xp > 0).sort((a, b) => b.xp - a.xp)[0];
  let verdict = '';
  if (best && best.xp > r.combatXpPerHour * 1.05) {
    const what = best.style === f.style ? `Your best ${f.style.toLowerCase()} gear` : `${best.style} with your best gear`;
    verdict = `<div class="verdict warn"><strong>${what} gives ${pct(best.xp / r.combatXpPerHour - 1, 0)} more XP here.</strong>${num(best.xp)} XP/h against your ${num(r.combatXpPerHour)}. <a href="#/combat">See what to change</a></div>`;
  } else if (best) {
    verdict = `<div class="verdict good"><strong>Your best setup for ${esc(f.enemy.name)}.</strong>No style or gear you own does clearly better here.</div>`;
  }
  return card('Right now', `<p><strong>Fighting ${esc(f.enemy.name)}</strong> with ${f.style} · ${num(r.combatXpPerHour)} XP/h · a kill every ${secs(r.killSeconds)} · ${signed(r.profitPerHour)} GP/h</p>${next}${risk}${verdict}${boosts(ctx)}`);
}

// ---------- Overview ----------

// A lit bonfire and any Aurora running: bonuses that only last a while (they're in every rate meanwhile).
function boosts(ctx) {
  const { gd, save } = ctx;
  const lines = [];
  const b = save.bonfire;
  const fire = b?.active && b.ticksLeft > 0 ? gd.raw.bonfires?.[b.bonfire] : null;
  if (fire) {
    const xp = fire.effects.filter((e) => e.stat === 'PercentXpGained').reduce((s, e) => s + e.value, 0);
    // FillableTimer ticks run at 60 a second; the bonfire waits while you're doing Firemaking.
    lines.push(`${esc(fire.name)}${xp ? `: ${pct(xp)} more XP in every skill` : ''}, ${duration(b.ticksLeft / 60 / 3600)} left${b.paused ? ' (paused while you do Firemaking)' : ''}`);
  }
  for (const [skill, a] of Object.entries(save.auroras ?? {})) {
    const aurora = a.activated && a.charges > 0 ? gd.raw.auroras?.[a.event] : null;
    if (aurora) lines.push(`${esc(aurora.name)}: ${exact(a.charges)} of ${exact(aurora.charges)} charges left in ${esc(skillName(ctx, skill))}`);
  }
  const ev = save.astrologyEvent;
  const astro = ev?.activated && ev.charges > 0 ? gd.raw.astrologyEvents?.[ev.event] : null;
  if (astro) lines.push(`${esc(astro.name)} from Astrology: ${exact(ev.charges)} of ${exact(astro.charges)} charges left`);
  else if (ev && !ev.activated && gd.raw.astrologyEvents?.[ev.event]) lines.push(`${esc(gd.raw.astrologyEvents[ev.event].name)} from Astrology is waiting: switch it on in Astrology to use it`);
  return lines.length ? `<p class="small accent-text">${lines.join('<br>')}</p>` : '';
}

function activityCard(ctx) {
  const f = ctx.state.levelSource === 'save' ? currentFight(ctx.gd, ctx.save, ctx.levels) : null;
  if (f) return fightCard(ctx, f);
  const a = currentActivity(ctx.gd, ctx.save.header, ctx.levels);
  if (!a) return card('Right now', `<p class="muted">Not training anything (or the game was closed between actions).</p>${boosts(ctx)}`);
  if (!a.method) {
    const best = a.bestXp ? `<p class="small">Best XP in ${esc(skillName(ctx, a.skill))}: ${methodLink(a.bestXp.method)} · ${num(a.bestXp.rates.xpPerHour)} XP/h</p>` : '';
    return card('Right now', `<p><strong>${esc(a.label)}</strong></p><p class="muted small">This activity isn't analysed yet.</p>${best}${boosts(ctx)}`);
  }
  const r = a.rates;
  let verdict;
  if (a.xpRatio >= 0.98) {
    verdict = `<div class="verdict good"><strong>Fastest XP available at your level.</strong>Nothing you've unlocked in ${esc(skillName(ctx, a.skill))} trains faster.</div>`;
  } else {
    const b = a.bestXp;
    verdict = `<div class="verdict warn"><strong>${esc(b.method.name)} gives ${pct(1 / a.xpRatio - 1)} more XP.</strong>${num(b.rates.xpPerHour)} XP/h vs your ${num(r.xpPerHour)} XP/h. <a href="#/skills/${a.skill}">Compare all</a></div>`;
  }
  const p = a.bestProfit;
  const money = p && p.method.key !== a.method.key && p.rates.profitPerHour > r.profitPerHour * 1.02
    ? `<p class="small">Best money in ${esc(skillName(ctx, a.skill))}: ${methodLink(p.method)} at ${gp(p.rates.profitPerHour)} GP/h (you: ${gp(r.profitPerHour)}).</p>`
    : '';
  const measured = ctx.measured[a.skill];
  const m = measured
    ? `<p class="small muted">Measured over your last ${duration(ctx.measuredMinutes / 60)} of play: <strong>${num(measured)} XP/h</strong> (${pct(measured / r.xpPerHour)} of the estimate${ctx.gd.playerBonuses ? ' with your bonuses' : ''}; anything not modelled shows up here).</p>`
    : '';
  return card('Right now', `<p><strong>${esc(a.label)}</strong> · ${num(r.xpPerHour)} XP/h · ${signed(r.profitPerHour)} GP/h${r.successChance != null && r.successChance < 1 ? ` · ${pct(r.successChance)} success` : ''}</p>${verdict}${money}${m}${boosts(ctx)}`);
}

// What the current action uses up and how long your stock lasts.
function suppliesCard(ctx) {
  const { gd, state } = ctx;
  const list = currentSupplies(gd, ctx.save, ctx.levels, ctx.stock);
  const minutes = state.alerts.minutes;
  const flows = ctx.save.flows;
  const basis = list.some((x) => x.measured) ? `Measured over your last ${duration((flows?.minutes ?? 0) / 60)} of this action.` : 'Estimated from the action\'s base rates until a few autosaves come in.';
  const rows = list.slice(0, 6).map((x) => `<li><span>${itemLink(ctx, x.item)} <span class="muted small">${num(x.perHour)}/h · ${exact(x.qty)} left</span></span><span class="num${x.hoursLeft * 60 <= minutes ? ' warn-text' : ''}">${x.qty > 0 ? duration(x.hoursLeft) : 'Out'}</span></li>`);
  return card('Supplies', rows.length ? `<ul class="list-plain">${rows.join('')}</ul><p class="small muted" style="margin-top:8px">${basis} <a href="#/settings">Alerts</a></p>${stockUpPart(ctx, list)}` : '<p class="muted small">Nothing being used up right now.</p>');
}

function skillCard(ctx, s) {
  const { gd } = ctx;
  const level = ctx.levels[s.id] ?? 1;
  const xp = ctx.xp[s.id] ?? gd.xp.xpForLevel(level);
  const prog = gd.xp.levelProgress(xp, gd.levelCap);
  const trainable = gd.methodsBySkill[s.id]?.length > 0;
  let lines = '';
  if (trainable) {
    const ranked = rankSkill(gd, s.id, ctx.levels);
    const best = ranked.best;
    const next = ranked.upcoming[0];
    if (best) lines += `<div class="line">Best: ${esc(best.method.name)} · ${num(best.rates.xpPerHour)} XP/h</div>`;
    lines += next ? `<div class="line">Next: ${esc(next.method.name)} at ${next.method.level}</div>` : '<div class="line">Everything unlocked</div>';
  } else {
    // No rate model: point combat skills at their pages, and show the next unlock for the rest.
    const combatPage = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].includes(s.id) ? 'Combat' : s.id === 'Slayer' ? 'Slayer' : null;
    const nextUnlock = (gd.raw.unlocks?.[s.id] ?? []).find((u) => u.level > level);
    const measured = ctx.measured?.[s.id];
    if (measured) lines += `<div class="line">Measured: ${num(measured)} XP/h</div>`;
    if (s.id === 'Prayer') lines += '<div class="line">Trained by fighting with a prayer on (see Combat)</div>';
    else if (combatPage) lines += `<div class="line">See the ${combatPage} page for what to fight</div>`;
    else if (nextUnlock) lines += `<div class="line">Next: ${esc(nextUnlock.name)} at ${nextUnlock.level}</div>`;
    else if (!measured) lines += '<div class="line">Rates for this skill aren\'t modelled yet</div>';
  }
  const atCap = level >= gd.levelCap;
  const href = trainable ? `#/skills/${s.id}` : ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].includes(s.id) ? '#/combat' : s.id === 'Slayer' ? '#/slayer' : '#/calculators';
  return `<a class="card skill-card" href="${href}">
    <div class="top">${badge(s.id, s.name)}<span class="name">${esc(s.name)}</span><span class="lvl">${level}<span class="muted small"> / ${gd.levelCap}</span></span></div>
    <div class="bar" role="progressbar" aria-label="${esc(s.name)} progress" aria-valuenow="${Math.round(prog.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(prog.progress * 100).toFixed(1)}%"></span></div>
    <div class="line">${atCap ? 'Max level' : `${exact(Math.ceil(prog.xpForNext))} XP to ${level + 1}`}</div>
    ${lines}
  </a>`;
}

export function overview(ctx) {
  const { gd, save, state } = ctx;
  let html = '';
  if (save && state.levelSource === 'save') {
    const h = save.header;
    const bank = ctx.bank ? bankInsights(gd, ctx.bank, ctx.levels) : null;
    html += pageHead(esc(h.characterName || 'Your character'), `${esc(h.gamemode || '')}${h.isDemo ? ' · Demo' : ''} · last saved ${ago(h.timestamp)}`);
    html += awaySummary(ctx);
    html += `<div class="grid stats">${stat('Total level', exact(h.totalLevel))}${stat('Gold', gp(h.gp))}${stat('Slayer coins', exact(h.slayerCoins))}${stat('Bank value', bank ? gp(bank.total) : '–')}</div>`;
    if (save.newerThanSupported) html += '<p class="notice warn">This save is from a newer game version than the companion knows. Numbers may be off until the companion is updated.</p>';
    if (save.warnings.length) html += `<p class="notice warn">${save.warnings.map(esc).join('<br>')}</p>`;
    html += `<div class="grid two" style="margin-top:12px;align-items:start">${activityCard(ctx)}${suppliesCard(ctx)}</div>`;
  } else if (state.levelSource === 'manual') {
    html += pageHead('Overview', 'Using the levels you entered in Settings.');
  } else {
    html += pageHead('Overview') + noSaveCard(ctx);
  }
  html += `<h2>Skills</h2><div class="grid skills">${gd.skills.map((s) => skillCard(ctx, s)).join('')}</div>`;
  return html;
}
