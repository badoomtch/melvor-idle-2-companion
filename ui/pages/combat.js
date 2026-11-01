// Combat: best gear you own per style and where to fight with it.
import { producerIndex } from '/engine/advisor.js';
import { buildEnemy, buildPlayer, castableSpells, fight, fightableEnemies, ownedEquipment, pickFood, recommendStyle, savedLoadouts, STYLES, xpOf } from '/engine/combat.js';
import { dungeonRun } from '/engine/dungeons.js';
import { foodOptions } from '/engine/food.js';
import { gearUpgrades } from '/engine/gear-upgrades.js';
import { combatLevel, hitpointsLevel, rankEnemies, triesFor } from '/engine/lookup.js';
import { badge, duration, esc, exact, gp, iconImg, num, pct } from '/ui/format.js';
import { card, enc, gatherStep, itemLink, memo, methodLink, pageHead, requirementText, saveKey, signed, skillName, stat, table } from './shared.js';

// ---------- Combat ----------

export const STYLE_SKILL = { Melee: 'Attack', Ranged: 'Ranged', Magic: 'Magic' };
const TRAIN_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'];

// Recommendations take tens of milliseconds; keep the last few so typing elsewhere stays instant.
const combatCache = new Map();
function cachedRecommendation(ctx, key, compute) {
  const full = `${ctx.save?.header.timestamp}|${ctx.state.levelSource}|${key}`;
  if (!combatCache.has(full)) {
    combatCache.set(full, compute());
    while (combatCache.size > 8) combatCache.delete(combatCache.keys().next().value);
  }
  return combatCache.get(full);
}

// The save's loadouts, owned gear and food, shared by the combat and away pages.
export function combatSetup(ctx) {
  const { gd, state } = ctx;
  const saved = savedLoadouts(gd, ctx.save.combat);
  return {
    saved,
    currentStyle: Object.entries(saved).find(([, l]) => l.current)?.[0] ?? 'Melee',
    owned: ownedEquipment(gd, ctx.stock, ctx.save.combat),
    food: pickFood(gd, ctx.bank, state.food ?? ctx.save.combat.food),
  };
}

export function combatRecommendation(ctx, style, { skill = null, targetId = null } = {}) {
  const { gd } = ctx;
  const { saved, owned, food } = combatSetup(ctx);
  const target = targetId ? gd.enemyById.get(targetId) : null;
  const targetArea = target && fightableEnemies(gd, ctx.levels).find((x) => x.enemy.id === target.id)?.area;
  return cachedRecommendation(ctx, `${style}|${skill}|${target?.id}|${food}|${JSON.stringify(ctx.levels)}`, () =>
    recommendStyle(gd, { style, owned, levels: ctx.levels, bank: ctx.bank, food, saved: saved[style], skill, target: target && targetArea ? { enemy: target, area: targetArea } : null }));
}

// How long food, ammo and runes keep a fight going.
export function fightHours(ctx, f, food) {
  const r = f.result;
  const last = (item, perHour) => (perHour > 0 ? (ctx.stock?.[item] ?? 0) / perHour : Infinity);
  return Math.min(last(food, r.foodPerHour ?? 0), last(f.player.ammoId, r.ammoPerHour), ...r.runesPerHour.map((x) => last(x.item, x.perHour)));
}

export function combat(ctx) {
  const { gd, state } = ctx;
  if (!gd.combat) return `${pageHead('Combat')}<p class="notice warn">This data build has no combat rules. Run <code>npm run build-data</code> again.</p>`;
  if (!ctx.save?.combat || !ctx.bank) {
    return `${pageHead('Combat', 'Gear-based recommendations for melee, ranged and magic.')}
      <div class="card empty"><h2>Load a save to see combat advice</h2><p>The companion reads your equipped gear, saved loadouts and bank to work out the best gear you own and what to fight with it.</p></div>
      ${combatLoot(ctx)}`;
  }
  const c = state.ui.combat;
  const { saved, currentStyle, food } = combatSetup(ctx);
  const style = STYLES.includes(c.style) ? c.style : currentStyle;
  const skill = c.skill || null;
  const target = c.target[style] ? gd.enemyById.get(c.target[style]) : null;
  const rec = combatRecommendation(ctx, style, { skill, targetId: target?.id ?? null });

  const styleTabs = `<div class="segmented" role="group" aria-label="Combat style">${STYLES.map((s) => `<button data-action="combatStyle" data-value="${s}" aria-pressed="${s === style}">${badge(STYLE_SKILL[s], s)} ${s}${s === currentStyle ? ' <span class="muted small">(equipped)</span>' : ''}</button>`).join('')}</div>`;
  const ownedFoods = gd.foods.filter((f) => (ctx.bank[f.item] ?? 0) > 0).sort((a, b) => b.heal - a.heal);
  const controls = `<div class="form-row">
      <label>Train <select id="combat-skill" data-bind="combat.skill"><option value="">All combat XP</option>${TRAIN_SKILLS.map((s) => `<option value="${s}"${s === skill ? ' selected' : ''}>${esc(skillName(ctx, s))}</option>`).join('')}</select></label>
      <label>Food <select id="combat-food" data-bind="food">${(ownedFoods.length ? ownedFoods : gd.foods).map((f) => `<option value="${esc(f.item)}"${f.item === food ? ' selected' : ''}>${esc(gd.itemName(f.item))} (heals ${f.heal}${ctx.bank[f.item] ? `, ${exact(ctx.bank[f.item])} owned` : ''})</option>`).join('')}</select></label>
    </div>`;
  const head = pageHead('Combat', 'The best gear you own for each style, and what to fight with it. Uses the game\'s own hit chance, max hit and damage reduction formulas.');
  if (!rec) {
    return `${head}${styleTabs}${controls}<div class="card empty"><h2>No ${esc(style.toLowerCase())} setup you can use yet</h2><p>${style === 'Ranged' ? 'You need a ranged weapon and matching ammo in your bank.' : style === 'Magic' ? 'You need a magic weapon and the runes for a spell it can cast.' : 'You need a melee weapon you have the levels for.'}</p></div>`;
  }
  return `${head}${styleTabs}${controls}
    <div class="grid two" style="align-items:start">${gearCard(ctx, rec, saved[style], { skill, food, targeted: !!target })}</div>
    <div class="grid two" style="align-items:start;margin-top:12px">${upgradesCard(ctx, rec, { skill, food })}${foodCard(ctx, rec, { food })}</div>
    <div style="margin-top:12px">${fightsCard(ctx, rec, { skill, food })}</div>
    <div style="margin-top:12px">${dungeonsCard(ctx, rec, { style, skill, food })}</div>
    <p class="small muted" style="margin-top:10px">Counts your gear, set bonuses, prayers, potions, pets and mastery, bonuses that only work on a Slayer task or in an area, enemy passives and ward, and auto-eat. Not counted yet: area effects, and special attacks beyond their average damage.</p>`;
}

// Dungeons you can enter, run with this gear: how long a run takes, the chance of dying in one
// (which loses the run), and what the rewards are worth.
function dungeonsCard(ctx, rec, { style, skill, food }) {
  const { gd } = ctx;
  const g = rec.gear;
  if (!g || !gd.combat.dungeons?.length) return '';
  const rows = cachedRecommendation(ctx, `dungeons|${style}|${food}|${g.gear.join(',')}|${g.stance}|${JSON.stringify(ctx.levels)}`, () =>
    gd.combat.dungeons
      .map((d) => {
        const req = gd.checkRequirements({ skill: null, level: 0, requires: d.requires }, ctx.levels);
        if (!req.ok) return null;
        const run = dungeonRun(gd, d, { gear: g.gear, stance: g.stance, spell: g.spell, levels: ctx.levels, food });
        return run && { dungeon: d, run };
      })
      .filter(Boolean)
      .sort((a, b) => (a.run.deathChancePerRun > 0.05) - (b.run.deathChancePerRun > 0.05) || b.run.gpPerHour - a.run.gpPerHour));
  // A run you'd die in more often than not isn't worth a row.
  const doable = rows.filter((x) => x.run.deathChancePerRun <= 0.5);
  const tooHard = rows.filter((x) => x.run.deathChancePerRun > 0.5).map((x) => esc(x.dungeon.name));
  const hardNote = tooHard.length ? `<p class="small muted" style="margin-top:8px">Too dangerous with this gear: ${tooHard.join(', ')}.</p>` : '';
  if (!doable.length) return card('Dungeons', `<p class="muted small">No dungeon you can enter can be finished safely with this gear yet.</p>${hardNote}`);
  const xp = (r) => (skill ? r.xpPerHour[skill] ?? 0 : r.combatXpPerHour);
  const body = doable.map(({ dungeon: d, run: r }) => {
    const risk = r.deathChancePerRun;
    const riskText = risk < 0.0005 ? '<span class="pill good">Safe</span>' : `<span class="pill ${risk > 0.05 ? 'bad' : 'warn'}">${pct(risk, risk < 0.01 ? 2 : 1)} a run</span>`;
    return `<tr>
      <td>${iconImg(d.icon, 'icon md')} ${esc(d.name)}<span class="sub">${esc([d.difficulty, `${d.fights.reduce((s, f) => s + f.count, 0)} fights`].filter(Boolean).join(' · '))}${r.unknown.length ? ` · <span class="warn-text">${esc(requirementText(ctx, r.unknown))}</span>` : ''}</span></td>
      <td class="num">${duration(r.runMinutes / 60)}</td>
      <td>${riskText}</td>
      <td class="num">${num(xp(r))}</td>
      <td class="num">${gp(r.rewardsPerRun)}</td>
      <td class="num">${gp(r.gpPerHour)}</td></tr>`;
  });
  return card('Dungeons', `<p class="small muted">With the gear above. Dungeon enemies drop nothing; the rewards (chests valued at their average contents) come at the end of each run, and dying loses the run.</p>
    ${table(['Dungeon', '#Run', 'Death risk', `#${skill ? skillName(ctx, skill) + ' ' : ''}XP/h`, '#Rewards/run', '#GP/h'], body)}${hardNote}`);
}

const slotOrder = (gd) => gd.combat.slots.map((s) => s.id);

function gearCard(ctx, rec, saved, { skill, food, targeted }) {
  const { gd } = ctx;
  const g = rec.gear;
  const p = g.player;
  const savedBySlot = {};
  for (const id of saved?.gear ?? []) {
    const type = gd.items[id]?.equip?.type;
    const slot = gd.combat.slots.find((s) => s.fits === type && !savedBySlot[s.id])?.id;
    if (slot) savedBySlot[slot] = id;
  }
  const slots = slotOrder(gd).filter((s) => g.slots[s] || savedBySlot[s]);
  const rows = slots.map((s) => {
    const id = g.slots[s];
    const was = savedBySlot[s];
    const changed = saved && id !== was;
    const qty = s === 'Ammo' && id ? ` <span class="muted small">× ${exact(ctx.bank[id] ?? 0)} in bank</span>` : '';
    return `<li><span class="muted small slot-name">${esc(gd.combat.slots.find((x) => x.id === s)?.name ?? s)}</span><span>${id ? itemLink(ctx, id) : '<span class="muted">Nothing</span>'}${qty}${changed ? ` <span class="pill accent">swap</span><span class="sub muted small">You use: ${was ? esc(gd.itemName(was)) : 'nothing'}</span>` : ''}</span></li>`;
  });
  const st = gd.combat.stances[g.stance];
  const xpTo = st.xp.map((x) => esc(skillName(ctx, x.skill))).join(', ');
  const vs = rec.fights.find((f) => f.enemy.id === g.enemy.id);
  let compare = '';
  if (saved && vs) {
    const spell = rec.style === 'Magic' ? castableSpells(gd, saved.gear.find((id) => gd.items[id]?.equip?.type === 'Weapon'), ctx.levels, ctx.bank)[0] ?? null : null;
    const mine = fight(gd, buildPlayer(gd, { gear: saved.gear, stance: saved.stance, spell, levels: ctx.levels, darkness: vs.area.darkness }), buildEnemy(gd, vs.enemy), { food });
    const a = xpOf(mine, skill);
    const b = xpOf(vs.result, skill);
    const swaps = rows.filter((r) => r.includes('pill accent')).length;
    const unit = `${skill ? esc(skillName(ctx, skill)) + ' ' : ''}XP/h on ${esc(vs.enemy.name)}`;
    if (a > 0 && b > a * 1.01) compare = `<div class="verdict warn"><strong>${pct(b / a - 1)} more XP than your ${esc(saved.name)} loadout</strong>${num(b)} vs ${num(a)} ${unit}.</div>`;
    else if (swaps) compare = `<div class="verdict good"><strong>Your ${esc(saved.name)} loadout is within 1% of the best.</strong>The swaps below are small gains or take less damage. ${num(a)} ${unit}.</div>`;
    else compare = `<div class="verdict good"><strong>Your ${esc(saved.name)} loadout is already the best you own.</strong>${num(a)} ${unit}.</div>`;
  }
  const notCounted = [...new Set(Object.values(g.slots).flatMap((id) => gd.items[id]?.equip?.otherBonuses ?? []))];
  const target = g.enemy
    ? `<p class="small muted">${targeted ? 'Optimised for' : 'Optimised for your best fight:'} <strong>${esc(g.enemy.name)}</strong>${g.area ? ` in ${esc(g.area.name)}` : ''}${targeted ? ` · <button class="link" data-action="combatTarget" data-style="${rec.style}" data-enemy="">Use the best fight instead</button>` : ''}</p>`
    : '';
  return card(`Best ${esc(rec.style.toLowerCase())} gear you own`, `${target}<ul class="list-plain gear-list">${rows.join('')}</ul>`)
    + card('With this gear', `${compare}
    <p class="small" style="margin-top:8px">Stance: <strong>${esc(st.name)}</strong> <span class="muted">(XP to ${xpTo})</span>${g.spell ? ` · Spell: ${iconImg(g.spell.icon, 'icon sm')}<strong>${esc(g.spell.name)}</strong> <span class="muted">(max hit ${g.spell.maxHit})</span>` : ''}</p>
    <div class="grid stats mini" style="margin-top:8px">${stat('Max hit', num(vs?.result.maxHit ?? p.baseMaxHit))}${stat('Accuracy', exact(p.accuracy))}${stat('Attack every', `${(p.interval / 1000).toFixed(2)}s`)}${stat('Power', exact(p.power))}${stat('Protection', exact(p.protection))}${stat('Hitpoints', exact(p.hitpoints))}</div>
    ${vs ? `<h4 style="margin-top:12px">Supplies on ${esc(vs.enemy.name)}</h4>${supplies(ctx, vs, food)}` : ''}
    ${notCounted.length ? `<p class="small muted" style="margin-top:8px">Also on this gear (not counted): ${notCounted.map(esc).join('; ')}</p>` : ''}`);
}

// What you can gather or make at your levels, by item (for timing materials). Once per autosave.
const producers = (ctx) => memo('combat:producers', saveKey(ctx), () => producerIndex(ctx.gd, ctx.levels));

// Best XP/hour fighting in each combat skill, across every style's best gear: for timing combat levels.
function combatXpRates(ctx) {
  const out = {};
  for (const style of STYLES) {
    for (const f of combatRecommendation(ctx, style)?.fights ?? []) {
      if (f.result.risky) continue;
      for (const [s, v] of Object.entries(f.result.xpPerHour)) out[s] = Math.max(out[s] ?? 0, v);
    }
  }
  for (const s of TRAIN_SKILLS) out[s] ??= 0;
  return out;
}

// "Make with" for crafting skills, "Steal from" for Thieving, "Get from" for gathering.
const MAKE_KINDS = new Set(['artisan', 'cooking', 'firemaking']);
const verbFor = (m) => (MAKE_KINDS.has(m.kind) ? 'Make with' : m.kind === 'thieving' ? 'Steal from' : 'Get from');

// How to get an upgrade: make it (and gather anything you're short of first), buy it, or the drop.
function upgradeSource(ctx, row) {
  const s = row.source;
  if (s.type === 'buy') return `Buy for ${gp(s.gp)} GP`;
  if (s.type === 'drop') return `Drops from ${iconImg(s.enemy.icon, 'icon sm')}<a href="#/lookup/enemy/${enc(s.enemy.id)}">${esc(s.enemy.name)}</a> <span class="muted small">${pct(s.chance, s.chance < 0.01 ? 2 : 1)} · ~${exact(s.kills)} kills for 50%</span>`;
  const first = (s.gather ?? []).map((g) => [...g.needs, g].map((n) => gatherStep(ctx, n)).join(' → '));
  return `${verbFor(s.method)} ${methodLink(s.method)} <span class="muted small">${esc(skillName(ctx, s.method.skill))}</span>${first.map((c) => `<span class="sub small warn-text">First ${c}</span>`).join('')}`;
}

const gainText = (row) => [row.gainShare >= 0.005 ? `+${pct(row.gainShare)} XP` : '', row.damageCut >= 0.05 ? `${pct(row.damageCut, 0)} less damage` : ''].filter(Boolean).join(' · ');

// Gear you don't own that beats this set: what you can get now, and what's a few levels away.
function upgradesCard(ctx, rec, { skill, food }) {
  const { gd } = ctx;
  if (!rec.gear?.enemy) return '';
  const up = memo(`combat:upgrades|${rec.style}|${skill}|${food}|${rec.gear.enemy.id}`, saveKey(ctx), () =>
    gearUpgrades(gd, { rec, owned: combatSetup(ctx).owned, levels: ctx.levels, bank: ctx.stock ?? {}, food, skill, index: producers(ctx), purchased: ctx.save.shopPurchases ?? {}, wallet: { GoldPieces: ctx.save.header.gp ?? 0 }, xp: ctx.xp ?? {}, combatXp: combatXpRates(ctx) }));
  const line = (row, extra = '') => `<li><span>${itemLink(ctx, row.item)} <span class="pill good">${esc(gainText(row))}</span>${extra}
      <span class="sub small">${upgradeSource(ctx, row)}</span><span class="sub muted small">${esc(gd.combat.slots.find((s) => s.id === row.slot)?.name ?? row.slot)}: replaces ${row.replaces ? esc(gd.itemName(row.replaces)) : 'nothing'}</span></span>`;
  const ready = up.ready.slice(0, 6).map((row) => `${line(row)}<span class="num">${row.source.hours > 1 / 60 ? duration(row.source.hours) : 'Now'}</span></li>`);
  const soon = up.soon.slice(0, 6).map((row) => {
    const needs = row.needs.map((n) => `${esc(gd.skillName(n.skill))} ${n.level} <span class="muted">(you're ${gd.levelOf(ctx.levels, n.skill)})</span>`).join(', ');
    return `${line(row, `<span class="sub small accent-text">Needs ${needs}</span>`)}<span class="num">${Number.isFinite(row.levelHours) ? duration(row.levelHours) : '?'}</span></li>`;
  });
  const body = `${ready.length ? `<h4>You can get now</h4><ul class="list-plain">${ready.join('')}</ul>` : '<p class="small muted">Nothing you can make, buy or get from a fight right now beats this gear.</p>'}
    ${soon.length ? `<h4 style="margin-top:12px">A few levels away</h4><ul class="list-plain">${soon.join('')}</ul>` : ''}
    <p class="small muted" style="margin-top:8px">Against ${esc(rec.gear.enemy.name)}, swapping one piece into the gear above. Counts items you could make (gathering what you're short of first), buy, or get as a drop from something you can already fight; times for levels use your best methods. Lists items up to 15 levels away.</p>`;
  return card('Upgrades within reach', body);
}

// The food that costs least to keep this fight going: eaten per hour (auto-eat only uses healing up to
// your max HP) times the time to gather and cook one, or the GP to buy it.
function foodCard(ctx, rec, { food }) {
  const { gd } = ctx;
  const vs = rec.gear?.enemy && rec.fights.find((f) => f.enemy.id === rec.gear.enemy.id);
  if (!vs) return '';
  const rows = memo(`combat:food|${rec.style}|${vs.enemy.id}|${rec.gear.gear.join(',')}`, saveKey(ctx), () =>
    foodOptions(gd, { player: vs.player, enemy: buildEnemy(gd, vs.enemy), levels: ctx.levels, bank: ctx.stock ?? {}, index: producers(ctx), purchased: ctx.save.shopPurchases ?? {} }));
  if (!rows.length) return card('Food', `<p class="muted small">You don't take damage against ${esc(vs.enemy.name)} with this gear, so no food is needed.</p>`);
  const cost = (r) => r.make?.perCombatHour ?? Infinity;
  const ranked = rows.filter((r) => r.make).sort((a, b) => cost(a) - cost(b));
  const best = ranked[0];
  const mine = rows.find((r) => r.item === food);
  const shown = [...ranked.slice(0, 6), ...(mine && !ranked.slice(0, 6).includes(mine) ? [mine] : [])];
  const skills = (r) => [...new Set([...(r.make.needs ?? []).map((n) => skillName(ctx, n.method.skill)), skillName(ctx, r.make.method.skill)])].join(' and ');
  const heals = (r) => (r.healUsed < r.heal - 0.5 ? `heals ${exact(Math.round(r.healUsed))} of ${exact(r.heal)}` : `heals ${exact(r.heal)}`);
  const body = shown.map((r) => `<li${r.item === food ? ' class="doing on"' : ''}><span>${itemLink(ctx, r.item)}${r.item === food ? ' <span class="pill accent">eating</span>' : ''}
      <span class="sub muted small">${r.make ? `${esc(skills(r))} · ${shortTime(r.make.hoursEach)} each` : r.buy ? `Buy for ${gp(r.buy.each)} GP each` : 'Nothing you can do yet makes it'} · ${heals(r)} · ${num(r.perHour)} eaten/h</span>
      ${r.owned ? `<span class="sub muted small">You have ${exact(r.owned)}, enough for ${duration(r.lastsHours)}</span>` : ''}</span>
      <span class="num">${r.make ? duration(r.make.perCombatHour) : '–'}</span></li>`);
  const head = best
    ? `<div class="verdict good"><strong>Cheapest to keep up: ${esc(gd.itemName(best.item))}</strong>About ${duration(best.make.perCombatHour)} of ${esc(skills(best))} for every hour against ${esc(vs.enemy.name)}.${mine && mine !== best && mine.make ? ` Your ${esc(gd.itemName(mine.item))} takes ${duration(mine.make.perCombatHour)}.` : ''}</div>`
    : '';
  return card(`Best food against ${esc(vs.enemy.name)}`, `${head}
    <p class="small muted" style="margin-top:8px">Time on the right: gathering and cooking for each hour of fighting.</p>
    <ul class="list-plain">${body.join('')}</ul>
    <p class="small muted" style="margin-top:8px">Healing counts your auto-eat efficiency; auto-eat only uses healing up to your max HP, so big foods help less when it's low. Times are from scratch at your levels and bonuses (burnt food, doubling and preservation included).</p>`);
}

// Seconds when it's under a minute ("12s"), otherwise the usual duration.
const shortTime = (hours) => (hours * 3600 < 60 ? `${Math.max(1, Math.round(hours * 3600))}s` : duration(hours));

// How long bank stock lasts at a fight's usage.
function supplies(ctx, f, food) {
  const { gd } = ctx;
  const r = f.result;
  const lines = [];
  if (r.foodPerHour > 0) lines.push(`${itemLink(ctx, food)} ${num(r.foodPerHour)}/h · lasts ${duration((ctx.bank[food] ?? 0) / r.foodPerHour)}`);
  if (r.ammoPerHour > 0) lines.push(`${itemLink(ctx, f.player.ammoId)} ${num(r.ammoPerHour)}/h · lasts ${duration((ctx.bank[f.player.ammoId] ?? 0) / r.ammoPerHour)}`);
  for (const rune of r.runesPerHour) lines.push(`${itemLink(ctx, rune.item)} ${num(rune.perHour)}/h · lasts ${duration((ctx.bank[rune.item] ?? 0) / rune.perHour)}`);
  return lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p class="muted small">Nothing used up.</p>';
}

function fightsCard(ctx, rec, { skill, food }) {
  const { gd, state } = ctx;
  const c = state.ui.combat;
  const xp = (f) => xpOf(f.result, skill);
  const foodHours = (f) => (f.result.foodPerHour > 0 ? (ctx.bank[food] ?? 0) / f.result.foodPerHour : Infinity);
  let list = rec.fights.filter((f) => xp(f) > 0);
  const risky = list.filter((f) => f.result.risky || f.unknown.length);
  if (!c.showRisky) list = list.filter((f) => !f.result.risky && !f.unknown.length);
  if (c.sort === 'profit') list.sort((a, b) => b.result.profitPerHour - a.result.profitPerHour);
  else if (c.sort === 'afk') list = list.filter((f) => foodHours(f) >= 12).sort((a, b) => xp(b) - xp(a));
  else list.sort((a, b) => xp(b) - xp(a));
  const shown = c.showAll ? list : list.slice(0, 12);
  const rows = shown.flatMap((f) => {
    const r = f.result;
    const key = `fight:${rec.style}:${f.enemy.id}`;
    const open = state.ui.expanded.has(key);
    const notes = [];
    if (r.oneHitRisk) notes.push(`<span class="pill bad">Can hit you for ${exact(r.biggestHit)}</span>`);
    else if (r.risky) notes.push(`<span class="pill bad" title="Auto-eat keeps you above ${exact(r.autoEatAt)} HP, but it can hit for ${exact(r.biggestHit)}">Could kill you: about every ${duration(r.hoursToDeath)}</span>`);
    if (r.passive.length) notes.push(`<span class="pill" title="Counted in these numbers">${esc(r.passive.join(', '))}</span>`);
    if (r.ward > 0) notes.push(`<span class="pill" title="Your first ${exact(r.ward)} hits on it are weakened">Ward ${exact(r.ward)}</span>`);
    if (f.unknown.length) notes.push(`<span class="pill warn">Needs ${requirementText(ctx, f.unknown)}</span>`);
    if (f.player.darknessPenalty > 0) notes.push(`<span class="pill warn" title="Gear with light cancels darkness">Too dark: −${f.player.darknessPenalty * 5}% accuracy</span>`);
    if (!r.risky && foodHours(f) < 4) notes.push(`<span class="pill warn">Food runs out in ${duration(foodHours(f))}</span>`);
    else if (!r.risky && r.needsFood) notes.push('<span class="pill">Needs food each kill</span>');
    const out = [`<tr>
      <td><button class="link" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${iconImg(f.enemy.icon, 'icon md')}${esc(f.enemy.name)}</button><span class="sub">${esc(f.area.name)}</span></td>
      <td class="num">${pct(r.hitChance)}</td>
      <td class="num">${r.killSeconds < 60 ? `${r.killSeconds.toFixed(1)}s` : duration(r.killSeconds / 3600)}</td>
      <td class="num">${num(xp(f))}</td>
      <td class="num">${signed(r.profitPerHour)}</td>
      <td class="num">${r.foodPerHour > 0.05 ? num(r.foodPerHour) : '–'}</td>
      <td class="small">${notes.join(' ')}</td></tr>`];
    if (open) {
      const xpLines = Object.entries(r.xpPerHour).map(([s, v]) => `<li>${esc(skillName(ctx, s))} ${num(v)}/h</li>`).join('');
      const loot = r.loot.items.slice(0, 5).map((d) => `<li>${itemLink(ctx, d.item)} <span class="muted">${pct(d.chance, d.chance < 0.01 ? 2 : 1)}</span></li>`).join('');
      out.push(`<tr><td colspan="7"><div class="detail-body">
        <div><h4>The fight</h4><p class="small">You hit ${pct(r.hitChance)} for up to ${exact(r.maxHit)} (it resists ${pct(r.enemyResistance)}). ${num(r.killsPerHour)} kills/h.</p>
          <p class="small">It hits you ${pct(r.enemyHitChance)} of the time, up to ${exact(r.biggestHit)} of your ${exact(f.player.hitpoints)} HP · ${num(r.hpLossPerHour)} HP lost/h.</p>
          ${r.prayerPointsPerHour > 0 ? `<p class="small">Your prayers use ${num(r.prayerPointsPerHour)} prayer points/h.</p>` : ''}
          <p class="small">${Number.isFinite(r.hoursToDeath) ? `Auto-eat tops you up at ${exact(r.autoEatAt)} HP, but a big hit can still kill you: about once every <strong>${duration(r.hoursToDeath)}</strong> left running. Dying loses a random piece of worn gear.` : `Safe while your food lasts: nothing it does can take you from ${exact(r.autoEatAt + 1)} HP (where auto-eat tops you up) to 0.`}</p>
          <p><button data-action="combatTarget" data-style="${rec.style}" data-enemy="${esc(f.enemy.id)}">Optimise gear for this enemy</button></p></div>
        <div><h4>XP per hour</h4><ul>${xpLines}</ul></div>
        <div><h4>Uses</h4>${supplies(ctx, f, food)}</div>
        <div><h4>Loot (${gp(r.loot.totalValue)} GP/kill)</h4><ul>${loot || '<li class="muted">Nothing</li>'}</ul><p class="small"><a href="#/lookup/enemy/${enc(f.enemy.id)}">All drops</a></p></div>
      </div></td></tr>`);
    }
    return out;
  });
  const sorts = [['xp', 'Most XP'], ['profit', 'Most profit'], ['afk', 'AFK (food lasts 12h+)']];
  const toolbar = `<div class="form-row" style="margin-top:0">
      <div class="segmented" role="group" aria-label="Sort fights">${sorts.map(([v, l]) => `<button data-action="combatSort" data-value="${v}" aria-pressed="${(c.sort ?? 'xp') === v}">${l}</button>`).join('')}</div>
      ${risky.length ? `<label class="small inline-check"><input type="checkbox" data-action="combatRisky"${c.showRisky ? ' checked' : ''}> Show ${risky.length} risky or locked</label>` : ''}
    </div>`;
  const more = list.length > shown.length ? `<p class="small"><button class="link" data-action="combatShowAll">Show all ${list.length} →</button></p>` : '';
  return card('Where to fight with it', `${toolbar}${table(['Enemy', '#Hit', '#Kill', `#${skill ? skillName(ctx, skill) + ' ' : ''}XP/h`, '#Profit/h', '#Food/h', ''], rows, c.sort === 'afk' ? 'Nothing you can fight for 12 hours on the food you have.' : 'Nothing you can fight safely with this gear yet.')}${more}
    <p class="small muted">Profit is loot at sell price minus the food, ammo and runes used.</p>`);
}

// Expected loot of every enemy, for reference.
function combatLoot(ctx) {
  const { gd, state } = ctx;
  const ranked = rankEnemies(gd);
  const rows = ranked.flatMap(({ enemy, loot, areas }) => {
    const key = `enemy:${enemy.id}`;
    const open = state.ui.expanded.has(key);
    const top = loot.items[0];
    const out = [`<tr>
      <td><button class="link" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${iconImg(enemy.icon, 'icon md')}${esc(enemy.name)}</button><span class="sub">${areas.map((a) => esc(a.name)).join(', ')}</span></td>
      <td class="num">${combatLevel(enemy, gd)}</td>
      <td class="num">${hitpointsLevel(enemy)}</td>
      <td class="num">${gp(loot.gp)}</td>
      <td class="num">${gp(loot.totalValue)}</td>
      <td class="small">${top ? `${itemLink(ctx, top.item)} <span class="muted">${pct(top.chance, top.chance < 0.1 ? 1 : 0)}</span>` : '–'}</td></tr>`];
    if (open) {
      const drops = loot.items.map((d) => `<li>${itemLink(ctx, d.item)} <span class="muted">${pct(d.chance, d.chance < 0.01 ? 2 : 1)} per kill · ~${exact(triesFor(d.chance, 0.5))} kills for 50%, ${exact(triesFor(d.chance, 0.9))} for 90%</span></li>`);
      out.push(`<tr><td colspan="6"><div class="detail-body"><div><h4>Combat levels</h4><p class="small">${Object.entries(enemy.levels).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p></div><div style="grid-column: span 2"><h4>Drops</h4><ul>${drops.join('')}</ul></div></div></td></tr>`);
    }
    return out;
  });
  return `<h2>Loot per kill</h2>${table(['Enemy', '#Level', '#Hitpoints', '#GP / kill', '#Loot / kill', 'Best drop'], rows)}`;
}
