// Combat: best gear you own per style and where to fight with it.
import { producerIndex } from '/engine/advisor.js';
import { buildEnemy, buildPlayer, castableImbuements, castableSpells, fight, fightableEnemies, ownedEquipment, pickFood, recommendStyle, savedLoadouts, STYLES, xpOf } from '/engine/combat.js';
import { dungeonRun } from '/engine/dungeons.js';
import { foodOptions } from '/engine/food.js';
import { combatFoodMods } from '/engine/gamedata.js';
import { gearUpgrades } from '/engine/gear-upgrades.js';
import { combatLevel, hitpointsLevel, rankEnemies, triesFor } from '/engine/lookup.js';
import { badge, duration, esc, exact, gp, iconImg, num, pct } from '/ui/format.js';
import { upgradeFrom } from './lookup.js';
import { card, enc, gatherStep, itemLink, memo, methodLink, pageHead, requirementText, saveKey, signed, skillName, stat, table } from './shared.js';

// ---------- Combat ----------

// A food's combat bonus in words ("+40 protection").
const BONUS_WORDS = {
  FlatProtectionRating: (v) => `${signedNum(v)} protection`,
  FlatPowerRating: (v) => `${signedNum(v)} power`,
  FlatLight: (v) => `${signedNum(v)} light`,
  PercentMaxHit: (v) => `${signedPct(v)} max hit`,
  MinHitBasedOnMaxHit: (v) => `${signedPct(v)} min hit`,
  PercentAccuracyRating: (v) => `${signedPct(v)} accuracy`,
  PercentEvasionRating: (v) => `${signedPct(v)} evasion`,
  FlatCriticalHitChance: (v) => `${signedPct(v)} crit chance`,
  EffectDamageTaken: (v) => `${signedPct(v)} damage from effects`,
  EffectAvoidanceChance: (v) => `${signedPct(v)} effect avoidance`,
};
const signedNum = (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)}`;
const signedPct = (v) => `${v > 0 ? '+' : '−'}${pct(Math.abs(v), Number.isInteger(Math.round(Math.abs(v) * 1000) / 10) ? 0 : 1)}`;
export const bonusText = (mods) => mods.map((m) => BONUS_WORDS[m.stat]?.(m.value)).filter(Boolean).join(', ');

// A special attack in a line: how often, its hits and what they apply ("25% of turns: 2 hits of 65%, 15% Bleed per hit").
function specialText(gd, a) {
  const damaging = a.hits.filter((h) => h.normal > 0 || h.maxHit > 0);
  const hits = damaging.map((h) => `${h.count > 1 ? `${h.count} hits of ` : ''}${h.maxHit > 0 ? `${pct(h.maxHit)} of max hit` : pct(h.normal)}`).join(', then ');
  const effects = (a.applies ?? []).map((x) => {
    const name = gd.combat.effects?.[x.effect]?.name ?? x.effect;
    const chance = x.chance < 1 ? `${pct(x.chance)} ` : '';
    return x.to === 'self' ? `${chance}${name} on you` : `${chance}${name}${x.when === 'hit' && a.hits.reduce((s, h) => s + h.count, 0) > 1 ? ' per hit' : ''}`;
  });
  // A last hit with no damage is the weapon coming back (a boomerang): the turn waits for it.
  const last = a.hits.at(-1);
  const wait = a.hits.length > 1 && !(last.normal > 0 || last.maxHit > 0) ? `, back after ${(last.interval / 1000).toFixed(1)}s` : '';
  return `${a.chance < 1 ? `${pct(a.chance)} of turns` : 'Every turn'}: ${hits}${wait}${effects.length ? ` · ${effects.join(', ')}` : ''}`;
}

// Effects counted in a fight, in words.
function effectsText(r) {
  const line = (x) => {
    if (x.kind === 'dot' || x.kind === 'reflect' || x.kind === 'heal') return `${esc(x.name)} ${num(x.dps)} HP/s`;
    if (x.kind === 'stun') return `${esc(x.name)} ${pct(x.share, x.share < 0.1 ? 1 : 0)} of turns lost`;
    if (x.kind === 'stacks') return `${esc(x.name)} ${num(x.stacks)} stacks on average`;
    return `${esc(x.name)} up ${pct(x.share, x.share < 0.1 ? 1 : 0)} of the time`;
  };
  const onYou = r.effects.filter((x) => x.who === 'player').map(line);
  const onIt = r.effects.filter((x) => x.who === 'enemy').map(line);
  return [onYou.length ? `On you: ${onYou.join(', ')}.` : '', onIt.length ? `On it: ${onIt.join(', ')}.` : '', r.effectsNotCounted.length ? `<span class="muted">Not counted: ${r.effectsNotCounted.map(esc).join(', ')}.</span>` : ''].filter(Boolean).join(' ');
}

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

// The enemy the save shows you fighting ("Combat - Treant"), when it's one you can fight.
export function fightingNow(ctx) {
  const h = ctx.save?.header;
  if (ctx.state.levelSource !== 'save' || h?.activeEntityName !== 'Combat' || !h.activeActionName) return null;
  const name = String(h.activeActionName).toLowerCase();
  const enemy = ctx.gd.enemies.find((e) => e.name.toLowerCase() === name);
  return enemy && fightableEnemies(ctx.gd, ctx.levels).some((x) => x.enemy.id === enemy.id) ? enemy : null;
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
  // Magic counts the imbuement you have selected (while you have its runes).
  const imbuement = style === 'Magic' ? ctx.save.combat?.imbuement ?? null : null;
  return cachedRecommendation(ctx, `${style}|${skill}|${target?.id}|${food}|${imbuement}|${JSON.stringify(ctx.levels)}`, () =>
    recommendStyle(gd, { style, owned, levels: ctx.levels, bank: ctx.bank, food, saved: saved[style], skill, imbuement, target: target && targetArea ? { enemy: target, area: targetArea } : null }));
}

// How long food, ammo and runes keep a fight going.
export function fightHours(ctx, f, food) {
  const r = f.result;
  const last = (item, perHour) => (perHour > 0 ? (ctx.stock?.[item] ?? 0) / perHour : Infinity);
  return Math.min(last(food, r.foodPerHour ?? 0), last(f.player.ammoId, r.ammoPerHour), ...r.runesPerHour.map((x) => last(x.item, x.perHour)));
}

// The style an enemy attacks with (its most likely stance), for the combat triangle.
function enemyStyle(gd, enemy) {
  const main = [...(enemy.stances ?? [])].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0];
  return main ? gd.combat.stances[main.stance]?.style ?? null : null;
}

// What we recommend: each style with the best gear you own for the same enemy (what you're fighting,
// or the one you picked), which is best and why. With no enemy in mind, each style's best fight.
// Each style with the best gear you own for `target` (or its own best fight): its numbers, or why it
// can't be used. Shared with the Overview's Right now card.
export function styleOptions(ctx, { skill = null, target = null } = {}) {
  return STYLES.map((style) => {
    const rec = combatRecommendation(ctx, style, { skill, targetId: target?.id ?? null });
    const g = rec?.gear;
    const r = g?.result;
    const here = !target || g?.enemy?.id === target.id;
    const why = !g ? 'no setup you can use' : !here ? `can't fight ${target.name} this way` : r.immune ? `${target?.name ?? g.enemy.name} is immune` : r.risky ? 'too risky with this gear' : null;
    return { style, g, r, why, xp: why ? 0 : xpOf(r, skill) };
  });
}

function adviceCard(ctx, { currentStyle, skill, target }) {
  const { gd } = ctx;
  const rows = styleOptions(ctx, { skill, target });
  const usable = rows.filter((x) => x.xp > 0).sort((a, b) => b.xp - a.xp);
  if (!usable.length) return '';
  const best = usable[0];
  const mine = rows.find((x) => x.style === currentStyle);
  const unit = `${skill ? `${esc(skillName(ctx, skill))} ` : ''}XP/h`;
  const on = (x) => (target ? esc(target.name) : esc(x.g.enemy.name));
  let verdict;
  if (best.style === currentStyle || (mine?.xp > 0 && best.xp < mine.xp * 1.05)) {
    const keep = mine?.xp > 0 ? mine : best;
    verdict = `<div class="verdict good"><strong>${target ? `Keep using ${keep.style} on ${on(keep)}.` : `${keep.style} is your best style: ${on(keep)}.`}</strong>${num(keep.xp)} ${unit} with the best ${keep.style.toLowerCase()} gear you own${usable.length > 1 ? `, the most of any style${best !== keep ? ' (within 5%)' : ''}` : ''}.</div>`;
  } else {
    const gain = mine?.xp > 0 ? ` ${pct(best.xp / mine.xp - 1, 0)} more XP.` : '';
    verdict = `<div class="verdict warn"><strong>Switch to ${best.style}${target ? ` for ${on(best)}` : `: ${on(best)}`}.${gain}</strong>${num(best.xp)} ${unit} with the best ${best.style.toLowerCase()} gear you own${mine?.xp > 0 ? `, against ${num(mine.xp)} with ${mine.style}${target ? '' : ` on ${on(mine)}`}` : mine?.why ? `. ${mine.style}: ${esc(mine.why)}` : ''}.
      <span class="sub"><button class="link" data-action="combatStyle" data-value="${best.style}">See the ${best.style.toLowerCase()} gear</button></span></div>`;
  }
  // Why, in the fight's numbers: against the style you use now (or the next best).
  const other = best.style !== currentStyle && mine?.xp > 0 ? mine : usable[1];
  const reasons = [];
  if (other && target) {
    const a = other.r;
    const b = best.r;
    if (b.hitChance > a.hitChance + 0.03) reasons.push(`you'd hit ${pct(b.hitChance)} of the time instead of ${pct(a.hitChance)}`);
    if (b.killSeconds < a.killSeconds * 0.95) reasons.push(`kill it in ${secs(b.killSeconds)} instead of ${secs(a.killSeconds)}`);
    if (a.hpLossPerHour > 0 && b.hpLossPerHour < a.hpLossPerHour * 0.9) reasons.push(`take ${pct(1 - b.hpLossPerHour / a.hpLossPerHour, 0)} less damage`);
  }
  // The catch, if there is one: more damage taken means more food.
  const a0 = other?.r;
  const downside = target && a0 && best.r.foodPerHour > (a0.foodPerHour ?? 0) * 1.1 && best.r.foodPerHour - (a0.foodPerHour ?? 0) >= 1
    ? `It takes more food: ${num(best.r.foodPerHour)} an hour instead of ${num(a0.foodPerHour ?? 0)}. ` : '';
  const es = target ? enemyStyle(gd, target) : null;
  const edge = es && gd.combat.triangle.find((t) => t.player === best.style && t.enemy === es && t.maxHit > 0);
  const triangle = edge ? `${best.style} has the edge on ${es.toLowerCase()} attackers like ${esc(target.name)}: ${pct(edge.maxHit, 0)} more max hit and ${pct(edge.resistance, 0)} more damage reduction.` : '';
  const whyLine = reasons.length || triangle || downside ? `<p class="small" style="margin-top:8px">${reasons.length ? `Against ${esc(other.style)}: ${esc(reasons.join(', '))}. ` : ''}${downside}${triangle}</p>` : '';
  // The best fight anywhere, when it's clearly more than this one.
  const anywhere = target ? STYLES.map((style) => combatRecommendation(ctx, style, { skill })).filter((rec) => rec?.gear?.result && !rec.gear.result.risky).map((rec) => ({ style: rec.style, enemy: rec.gear.enemy, xp: xpOf(rec.gear.result, skill) })).sort((a, b) => b.xp - a.xp)[0] : null;
  const elsewhere = anywhere && anywhere.enemy.id !== target.id && anywhere.xp > best.xp * 1.1
    ? `<p class="small accent-text" style="margin-top:8px">For more XP anywhere: ${esc(anywhere.enemy.name)} with ${anywhere.style}, ${num(anywhere.xp)} ${unit}. <button class="link" data-action="combatTarget" data-style="${anywhere.style}" data-enemy="${esc(anywhere.enemy.id)}">Show it</button></p>`
    : '';
  const body = rows.map((x) => `<tr${x === best ? ' class="best"' : ''}>
      <td>${x.style}${x.style === currentStyle ? ' <span class="muted small">(equipped)</span>' : ''}${x === best ? ' <span class="pill good">Best</span>' : ''}${!target && x.g ? `<span class="sub muted small">on ${esc(x.g.enemy.name)}</span>` : ''}</td>
      ${x.why ? `<td colspan="4" class="muted small">${esc(x.why[0].toUpperCase() + x.why.slice(1))}</td>` : `<td class="num">${num(x.xp)}</td><td class="num">${secs(x.r.killSeconds)}</td><td class="num">${pct(x.r.hitChance)}</td><td class="num">${num(x.r.foodPerHour ?? 0)}</td>`}</tr>`);
  return card(`What we recommend${target ? ` against ${esc(target.name)}` : ''}`, `${verdict}${whyLine}${elsewhere}
    ${table(['Style', `#${unit}`, '#Kill', '#You hit', '#Food/h'], body)}
    <p class="small muted" style="margin-top:6px">Each style with the best gear you own ${target ? `for ${esc(target.name)}` : 'for its best fight'}, from your bank and loadouts.</p>`, ' style="margin-bottom:12px"');
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
  // The enemy your save shows you fighting, unless you've picked another or asked for the best fight.
  const fighting = fightingNow(ctx);
  const chosen = c.target[style];
  const target = chosen === undefined ? fighting : chosen ? gd.enemyById.get(chosen) : null;
  const rec = combatRecommendation(ctx, style, { skill, targetId: target?.id ?? null });

  const styleTabs = `<div class="segmented" role="group" aria-label="Combat style">${STYLES.map((s) => `<button data-action="combatStyle" data-value="${s}" aria-pressed="${s === style}">${badge(STYLE_SKILL[s], s)} ${s}${s === currentStyle ? ' <span class="muted small">(equipped)</span>' : ''}</button>`).join('')}</div>`;
  const ownedFoods = gd.foods.filter((f) => (ctx.bank[f.item] ?? 0) > 0).sort((a, b) => b.heal - a.heal);
  const controls = `<div class="form-row">
      <label>Train <select id="combat-skill" data-bind="combat.skill"><option value="">All combat XP</option>${TRAIN_SKILLS.map((s) => `<option value="${s}"${s === skill ? ' selected' : ''}>${esc(skillName(ctx, s))}</option>`).join('')}</select></label>
      <label>Food <select id="combat-food" data-bind="food">${(ownedFoods.length ? ownedFoods : gd.foods).map((f) => `<option value="${esc(f.item)}"${f.item === food ? ' selected' : ''}>${esc(gd.itemName(f.item))} (heals ${f.heal}${bonusText(combatFoodMods(gd, f.item)) ? `, ${esc(bonusText(combatFoodMods(gd, f.item)))}` : ''}${ctx.bank[f.item] ? `, ${exact(ctx.bank[f.item])} owned` : ''})</option>`).join('')}</select></label>
    </div>`;
  const head = pageHead('Combat', 'The best gear you own for each style, and what to fight with it. Uses the game\'s own hit chance, max hit and damage reduction formulas.');
  if (!rec) {
    return `${head}${styleTabs}${controls}<div class="card empty"><h2>No ${esc(style.toLowerCase())} setup you can use yet</h2><p>${style === 'Ranged' ? 'You need a ranged weapon and matching ammo in your bank.' : style === 'Magic' ? 'You need a magic weapon and the runes for a spell it can cast.' : 'You need a melee weapon you have the levels for.'}</p></div>`;
  }
  return `${head}${styleTabs}${controls}
    ${adviceCard(ctx, { currentStyle, skill, target })}
    <div class="grid two" style="align-items:start">${gearCard(ctx, rec, saved[style], { skill, food, targeted: !!target, fighting })}</div>
    <div class="grid two" style="align-items:start;margin-top:12px">${upgradesCard(ctx, rec, { skill, food })}${foodCard(ctx, rec, { food, skill })}</div>
    <div style="margin-top:12px">${fightsCard(ctx, rec, { skill, food })}</div>
    <div style="margin-top:12px">${dungeonsCard(ctx, rec, { style, skill, food })}</div>
    <p class="small muted" style="margin-top:10px">Counts your gear, set bonuses, prayers, potions, pets and mastery, your food's bonus, bonuses that only work on a Slayer task or in an area, area effects, enemy passives and ward, both sides' special attacks hit by hit and what they apply (bleed, poison and burn, stuns and sleep, buffs like Haste or Vanished, for the share of the time they're up), stacks that build up over a fight (Off Balance, Quicksand, Exsanguinate, Deep Wound), damage at the end of your turns (Ambush, Storm Surge), attack reflect both ways, your magic imbuement, enemies healing from what they do to you (lifesteal, Drain, effect lifesteal) and your effect lifesteal, and auto-eat with your HP at each of its attacks. Stacks and effects enemy passives put on you count too (Plague Touch, Acid Burns, Burning Flame), and so does what an effect leaves behind as it wears off (Starblighted after Starblight).</p>`;
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

function gearCard(ctx, rec, saved, { skill, food, targeted, fighting }) {
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
  const vs = rec.fights.find((f) => f.enemy.id === g.enemy.id);
  // Your loadout against the same enemy, and with one piece changed: why each swap is worth it.
  const weaponOf = (gear) => gear.find((id) => gd.items[id]?.equip?.type === 'Weapon');
  const fightWith = (gear, stance) => {
    const spell = rec.style === 'Magic' ? castableSpells(gd, weaponOf(gear), ctx.levels, ctx.bank)[0] ?? null : null;
    return fight(gd, buildPlayer(gd, { gear, stance, spell, imbuement: g.imbuement, levels: ctx.levels, darkness: vs.area.darkness, area: vs.area, food }), buildEnemy(gd, vs.enemy), { food });
  };
  const mine = saved && vs ? fightWith(saved.gear, saved.stance) : null;
  const whySwap = (slot, id, was) => {
    const a = gd.items[id]?.equip ?? {};
    const b = gd.items[was]?.equip ?? {};
    const parts = [];
    if ((a.power ?? 0) !== (b.power ?? 0)) parts.push(`power ${exact(b.power ?? 0)} to ${exact(a.power ?? 0)}`);
    if ((a.protection ?? 0) !== (b.protection ?? 0)) parts.push(`protection ${exact(b.protection ?? 0)} to ${exact(a.protection ?? 0)}`);
    // A weapon's speed, and the attack and strength bonuses for this style.
    const sa = a.stats ?? {};
    const sb = b.stats ?? {};
    if (sa.AttackInterval && sb.AttackInterval && sa.AttackInterval !== sb.AttackInterval) parts.push(`attacks every ${(sb.AttackInterval / 1000).toFixed(1)}s to ${(sa.AttackInterval / 1000).toFixed(1)}s`);
    const attackKeys = { Melee: ['Stab', 'Slash', 'Crush', 'Block'], Ranged: ['Accurate', 'Powerful', 'LongRange'], Magic: ['Offensive', 'Defensive'] }[rec.style] ?? [];
    const bestAttack = (st) => Math.max(0, ...attackKeys.map((k) => st[`${k}AttackBonus`] ?? 0));
    if (bestAttack(sa) !== bestAttack(sb)) parts.push(`${rec.style.toLowerCase()} attack bonus ${exact(bestAttack(sb))} to ${exact(bestAttack(sa))}`);
    const strengthKey = { Melee: 'MeleeStrengthBonus', Ranged: 'RangedStrengthBonus', Magic: 'MagicDamageBonus' }[rec.style];
    if ((sa[strengthKey] ?? 0) !== (sb[strengthKey] ?? 0)) parts.push(`${rec.style === 'Magic' ? 'magic damage' : 'strength'} bonus ${exact(sb[strengthKey] ?? 0)} to ${exact(sa[strengthKey] ?? 0)}`);
    const extra = bonusText(a.mods ?? []);
    if (extra) parts.push(extra);
    let effect = '';
    if (mine) {
      const two = a.alsoOccupies?.includes('Offhand');
      const gear = [...saved.gear.filter((x) => x !== was && !(two && gd.items[x]?.equip?.type === 'Offhand')), id];
      const r = fightWith(gear, slot === 'Weapon' ? g.stance : saved.stance);
      const before = xpOf(mine, skill);
      const d = before > 0 ? xpOf(r, skill) / before - 1 : 0;
      const cut = mine.hpLossPerHour > 0 ? 1 - r.hpLossPerHour / mine.hpLossPerHour : 0;
      const xp = d >= 0.005 ? `${pct(d, 1)} more XP an hour` : d <= -0.005 ? `${pct(-d, 1)} less XP an hour (it pays off with the other swaps)` : 'about the same XP';
      effect = ` Swapped on its own against ${vs.enemy.name}: ${xp}${cut >= 0.02 ? `, ${pct(cut, 0)} less damage taken` : cut <= -0.02 ? `, ${pct(-cut, 0)} more damage taken` : ''}.`;
    }
    return `${gd.itemName(id)} instead of ${was ? gd.itemName(was) : 'nothing'}${parts.length ? `: ${parts.join(', ')}` : ''}.${effect}`;
  };
  const rows = slots.map((s) => {
    const id = g.slots[s];
    const was = savedBySlot[s];
    const changed = saved && id !== was;
    const qty = s === 'Ammo' && id ? ` <span class="muted small">× ${exact(ctx.bank[id] ?? 0)} in bank</span>` : '';
    const why = changed && id ? `<span class="why-tip" tabindex="0" role="button" aria-label="Why swap" data-tip="${esc(whySwap(s, id, was))}">?</span>` : '';
    return `<li><span class="muted small slot-name">${esc(gd.combat.slots.find((x) => x.id === s)?.name ?? s)}</span><span>${id ? itemLink(ctx, id) : '<span class="muted">Nothing</span>'}${qty}${changed ? ` <span class="pill accent">swap</span>${why}<span class="sub muted small">You use: ${was ? esc(gd.itemName(was)) : 'nothing'}</span>` : ''}</span></li>`;
  });
  const st = gd.combat.stances[g.stance];
  const xpTo = st.xp.map((x) => esc(skillName(ctx, x.skill))).join(', ');
  let compare = '';
  if (saved && vs) {
    const a = xpOf(mine, skill);
    const b = xpOf(vs.result, skill);
    const swaps = rows.filter((r) => r.includes('pill accent')).length;
    const unit = `${skill ? esc(skillName(ctx, skill)) + ' ' : ''}XP/h on ${esc(vs.enemy.name)}`;
    if (a > 0 && b > a * 1.01) compare = `<div class="verdict warn"><strong>${pct(b / a - 1)} more XP than your ${esc(saved.name)} loadout</strong>${num(b)} vs ${num(a)} ${unit}.</div>`;
    else if (swaps) compare = `<div class="verdict good"><strong>Your ${esc(saved.name)} loadout is within 1% of the best.</strong>The swaps below are small gains or take less damage. ${num(a)} ${unit}.</div>`;
    else compare = `<div class="verdict good"><strong>Your ${esc(saved.name)} loadout is already the best you own.</strong>${num(a)} ${unit}.</div>`;
  }
  const notCounted = [...new Set(Object.values(g.slots).flatMap((id) => gd.items[id]?.equip?.otherBonuses ?? []))];
  // Special attacks the gear gives (picked by chance each turn, counted in every number here).
  const specials = (p.attacks ?? []).filter((a) => a.id !== 'Normal');
  const specialLines = specials.map((a) => `<p class="small" style="margin-top:4px">Special: <strong>${esc(a.name)}</strong> <span class="muted">${esc(specialText(gd, a))}</span></p>`).join('');
  const foodBonus = bonusText(combatFoodMods(gd, food));
  const onIt = targeted && fighting?.id === g.enemy?.id;
  const back = fighting && !onIt ? ` · <button class="link" data-action="combatTarget" data-style="${rec.style}" data-enemy="${esc(fighting.id)}">Use what you're fighting (${esc(fighting.name)})</button>` : '';
  const target = g.enemy
    ? `<p class="small muted">${onIt ? "Optimised for what you're fighting:" : targeted ? 'Optimised for' : 'Optimised for your best fight:'} <strong>${esc(g.enemy.name)}</strong>${g.area ? ` in ${esc(g.area.name)}` : ''}${targeted ? ` · <button class="link" data-action="combatTarget" data-style="${rec.style}" data-enemy="">Use the best fight instead</button>` : ''}${back}</p>`
    : '';
  return card(`Best ${esc(rec.style.toLowerCase())} gear you own`, `${target}<ul class="list-plain gear-list">${rows.join('')}</ul>`)
    + card('With this gear', `${compare}
    <p class="small" style="margin-top:8px">Stance: <strong>${esc(st.name)}</strong> <span class="muted">(XP to ${xpTo})</span>${g.spell ? ` · Spell: ${iconImg(g.spell.icon, 'icon sm')}<strong>${esc(g.spell.name)}</strong> <span class="muted">(max hit ${g.spell.maxHit})</span>` : ''}</p>
    ${imbuementText(ctx, rec, vs, { skill, food })}
    ${specialLines}
    ${foodBonus ? `<p class="small" style="margin-top:4px">Food: ${itemLink(ctx, food)} <span class="muted">${esc(foodBonus)} while it's selected (counted)</span></p>` : ''}
    <div class="grid stats mini" style="margin-top:8px">${stat('Max hit', num(vs?.result.maxHit ?? p.baseMaxHit))}${stat('Accuracy', exact(p.accuracy))}${stat('Attack every', `${(p.interval / 1000).toFixed(2)}s`)}${stat('Power', exact(p.power))}${stat('Protection', exact(p.protection))}${stat('Hitpoints', exact(p.hitpoints))}</div>
    ${vs ? `<h4 style="margin-top:12px">Supplies on ${esc(vs.enemy.name)}</h4>${supplies(ctx, vs, food)}` : ''}
    ${notCounted.length ? `<p class="small muted" style="margin-top:8px">Also on this gear (not counted): ${notCounted.map(esc).join('; ')}</p>` : ''}`);
}

// The imbuement you have selected (counted while you have its runes), and whether another you can use
// would give more XP on this fight. Their damage over time gives no XP, so none can be best.
function imbuementText(ctx, rec, vs, { skill, food }) {
  const { gd } = ctx;
  const g = rec.gear;
  if (rec.style !== 'Magic' || !g.spell || !vs) return '';
  const weapon = g.gear.find((id) => gd.items[id]?.equip?.type === 'Weapon');
  const options = castableImbuements(gd, weapon, ctx.levels, ctx.bank);
  const picked = ctx.save.combat?.imbuement ? gd.combat.imbuements?.find((x) => x.id === String(ctx.save.combat.imbuement).split(':').pop()) : null;
  const xp = (imbuement) => xpOf(fight(gd, buildPlayer(gd, { gear: g.gear, stance: g.stance, spell: g.spell, imbuement, levels: ctx.levels, darkness: vs.area.darkness, area: vs.area, food }), buildEnemy(gd, vs.enemy), { food }), skill);
  const mine = xpOf(vs.result, skill);
  let best = { imb: g.imbuement, v: mine };
  for (const imb of [null, ...options]) {
    if (imb?.id === g.imbuement?.id) continue;
    const v = xp(imb);
    if (v > best.v * 1.001) best = { imb, v };
  }
  const what = (imb) => imb.applies.map((x) => `${pct(x.chance)} of turns: ${gd.combat.effects?.[x.effect]?.name ?? x.effect}`).join(', ');
  const name = (imb) => `${iconImg(imb.icon, 'icon sm')}<strong>${esc(imb.name)}</strong>`;
  const head = g.imbuement
    ? `Imbuement: ${name(g.imbuement)} <span class="muted">(${esc(what(g.imbuement))}, counted)</span>`
    : picked
      ? `Imbuement: <strong>${esc(picked.name)}</strong> <span class="muted">(not counted: this staff can't use it, or you're out of its runes)</span>`
      : 'Imbuement: none selected';
  const unit = `${skill ? esc(skillName(ctx, skill)) + ' ' : ''}XP/h on ${esc(vs.enemy.name)}`;
  let verdict = '';
  if (mine > 0 && best.v > mine * 1.01) verdict = `${best.imb ? `${name(best.imb)} <span class="muted">(${esc(what(best.imb))})</span>` : 'No imbuement'} would give ${pct(best.v / mine - 1)} more ${unit}.`;
  else if (options.length) verdict = `${g.imbuement ? 'The best' : 'None is better'} of the ${options.length} you can use here.`;
  return `<p class="small" style="margin-top:4px">${head}${verdict ? ` · ${verdict}` : ''}</p>`;
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
  const then = first.map((c) => `<span class="sub small warn-text">First ${c}</span>`).join('');
  if (s.type === 'upgrade') return `Upgrade from ${upgradeFrom(ctx, s.upgrade)} <span class="muted small">in the bank${s.times > 1 ? `, ${exact(s.times)} times` : ''}</span>${then}`;
  return `${verbFor(s.method)} ${methodLink(s.method)} <span class="muted small">${esc(skillName(ctx, s.method.skill))}</span>${then}`;
}

const gainText = (row) => [row.gainShare >= 0.002 ? `+${pct(row.gainShare, row.gainShare < 0.01 ? 1 : 0)} XP` : '', row.damageCut >= 0.02 ? `${pct(row.damageCut, 0)} less damage` : ''].filter(Boolean).join(' · ');

// Why an upgrade is better, in the fight's own numbers: kill time, hit chance and max hit, how often it
// hits you and the food that saves.
export const secs = (s) => (s >= 90 ? duration(s / 3600) : `${s.toFixed(s < 10 ? 1 : 0)}s`);
function whyText(row) {
  const { enemy, before: a, after: b } = row.why ?? {};
  if (!a || !b) return '';
  const parts = [];
  // Only changes big enough to notice: 2% on kill time and food, 2 points on hit chances.
  if (b.killSeconds < a.killSeconds * 0.98) parts.push(`kills ${enemy} in ${secs(b.killSeconds)} instead of ${secs(a.killSeconds)}`);
  if (b.hitChance > a.hitChance + 0.02) parts.push(`you hit ${pct(b.hitChance)} of the time instead of ${pct(a.hitChance)}`);
  if (b.maxHit > a.maxHit) parts.push(`max hit ${exact(a.maxHit)} → ${exact(b.maxHit)}`);
  if (b.enemyHitChance < a.enemyHitChance - 0.02) parts.push(`it hits you ${pct(b.enemyHitChance)} of the time instead of ${pct(a.enemyHitChance)}`);
  if (b.foodPerHour < a.foodPerHour * 0.98 && a.foodPerHour - b.foodPerHour >= 1) parts.push(`${num(a.foodPerHour - b.foodPerHour)} less food an hour`);
  // Defence that doesn't change how often it hits you still cuts how hard.
  if (!parts.length && b.damageTakenPerKill < a.damageTakenPerKill * 0.98) parts.push(`you take ${pct(1 - b.damageTakenPerKill / a.damageTakenPerKill, 0)} less damage per kill`);
  if (!parts.length) return '';
  const text = parts.join(', ');
  return `<span class="sub small">${esc(text[0].toUpperCase() + text.slice(1))}.</span>`;
}

// Gear you don't own that beats this set: what you can get now, and what's a few levels away.
function upgradesCard(ctx, rec, { skill, food }) {
  const { gd } = ctx;
  if (!rec.gear?.enemy) return '';
  const up = memo(`combat:upgrades|${rec.style}|${skill}|${food}|${rec.gear.enemy.id}`, saveKey(ctx), () =>
    gearUpgrades(gd, { rec, owned: combatSetup(ctx).owned, levels: ctx.levels, bank: ctx.stock ?? {}, food, skill, index: producers(ctx), purchased: ctx.save.shopPurchases ?? {}, wallet: { GoldPieces: ctx.save.header.gp ?? 0 }, xp: ctx.xp ?? {}, combatXp: combatXpRates(ctx), itemUpgrades: true }));
  const line = (row, extra = '') => `<li><span>${itemLink(ctx, row.item)} <span class="pill good">${esc(gainText(row))}</span>${extra}
      ${whyText(row)}<span class="sub small">${upgradeSource(ctx, row)}</span><span class="sub muted small">${esc(gd.combat.slots.find((s) => s.id === row.slot)?.name ?? row.slot)}: replaces ${row.replaces ? esc(gd.itemName(row.replaces)) : 'nothing'}</span></span>`;
  const ready = up.ready.slice(0, 8).map((row) => `${line(row)}<span class="num">${row.source.hours > 1 / 60 ? duration(row.source.hours) : 'Now'}</span></li>`);
  const soon = up.soon.slice(0, 6).map((row) => {
    const needs = row.needs.map((n) => `${esc(gd.skillName(n.skill))} ${n.level} <span class="muted">(you're ${gd.levelOf(ctx.levels, n.skill)})</span>`).join(', ');
    return `${line(row, `<span class="sub small accent-text">Needs ${needs}</span>`)}<span class="num">${Number.isFinite(row.levelHours) ? duration(row.levelHours) : '?'}</span></li>`;
  });
  const body = `${ready.length ? `<h4>You can get now</h4><ul class="list-plain">${ready.join('')}</ul>` : '<p class="small muted">Nothing you can make, buy or get from a fight right now beats this gear.</p>'}
    ${soon.length ? `<h4 style="margin-top:12px">A few levels away</h4><ul class="list-plain">${soon.join('')}</ul>` : ''}
    <p class="small muted" style="margin-top:8px">Against ${esc(rec.gear.enemy.name)}, swapping one piece into the gear above. Quickest wins first: a small gain is listed when it takes a few minutes to get. Counts items you could make (gathering what you're short of first), buy, or get as a drop from something you can already fight; times for levels use your best methods. Lists items up to 15 levels away.</p>`;
  return card('Upgrades within reach', body);
}

// The food that costs least to keep this fight going: eaten per hour (auto-eat only uses healing up to
// your max HP) times the time to gather and cook one, or the GP to buy it.
function foodCard(ctx, rec, { food, skill }) {
  const { gd } = ctx;
  const vs = rec.gear?.enemy && rec.fights.find((f) => f.enemy.id === rec.gear.enemy.id);
  if (!vs) return '';
  const rows = memo(`combat:food|${rec.style}|${vs.enemy.id}|${rec.gear.gear.join(',')}|${rec.gear.stance}`, saveKey(ctx), () =>
    foodOptions(gd, { player: vs.player, enemy: buildEnemy(gd, vs.enemy), levels: ctx.levels, bank: ctx.stock ?? {}, index: producers(ctx), purchased: ctx.save.shopPurchases ?? {} }));
  if (!rows.length) return card('Food', `<p class="muted small">You don't take damage against ${esc(vs.enemy.name)} with this gear, so no food is needed.</p>`);
  const cost = (r) => r.make?.perCombatHour ?? Infinity;
  const ranked = rows.filter((r) => r.make).sort((a, b) => cost(a) - cost(b));
  const best = ranked[0];
  const mine = rows.find((r) => r.item === food);
  // Each food is fought with its own bonus: against a food with none, how much more XP it gives and
  // how much less damage you take.
  const xp = (r) => xpOf(r, skill);
  const plain = rows.filter((r) => !r.bonus.length);
  const plainXp = plain.length ? Math.max(...plain.map(xp)) : Math.min(...rows.map(xp));
  const plainLoss = plain.length ? Math.min(...plain.map((r) => r.hpLossPerHour)) : Math.max(...rows.map((r) => r.hpLossPerHour));
  const xpGain = (r) => (plainXp > 0 ? xp(r) / plainXp - 1 : 0);
  const gains = (r) => [xpGain(r) >= 0.005 ? `+${pct(xpGain(r), 1)} XP` : '', plainLoss > 0 && r.hpLossPerHour <= plainLoss * 0.95 ? `${pct(1 - r.hpLossPerHour / plainLoss, 0)} less damage` : ''].filter(Boolean).join(' · ');
  const usable = rows.filter((r) => r.make || r.owned);
  const mostXp = usable.length ? usable.reduce((a, b) => (xp(b) > xp(a) ? b : a)) : null;
  const top = ranked.slice(0, 6);
  const shown = [...top, ...[mine, mostXp].filter((r, i, all) => r && !top.includes(r) && all.indexOf(r) === i)];
  const skills = (r) => [...new Set([...(r.make.needs ?? []).map((n) => skillName(ctx, n.method.skill)), skillName(ctx, r.make.method.skill)])].join(' and ');
  const heals = (r) => (r.healUsed < r.heal - 0.5 ? `heals ${exact(Math.round(r.healUsed))} of ${exact(r.heal)}` : `heals ${exact(r.heal)}`);
  const body = shown.map((r) => `<li${r.item === food ? ' class="doing on"' : ''}><span>${itemLink(ctx, r.item)}${r.item === food ? ' <span class="pill accent">eating</span>' : ''}${gains(r) ? ` <span class="pill good">${esc(gains(r))}</span>` : ''}
      <span class="sub muted small">${r.make ? `${esc(skills(r))} · ${shortTime(r.make.hoursEach)} each` : r.buy ? `Buy for ${gp(r.buy.each)} GP each` : 'Nothing you can do yet makes it'} · ${heals(r)} · ${num(r.perHour)} eaten/h</span>
      ${r.bonus.length ? `<span class="sub small">While selected: ${esc(bonusText(r.bonus))}</span>` : ''}
      ${r.owned ? `<span class="sub muted small">You have ${exact(r.owned)}, enough for ${duration(r.lastsHours)}</span>` : ''}</span>
      <span class="num">${r.make ? duration(r.make.perCombatHour) : '–'}</span></li>`);
  const xpNote = mostXp && mostXp !== best && xpGain(mostXp) >= 0.01 && xp(mostXp) > xp(best ?? mostXp) * 1.01
    ? ` For XP, ${esc(gd.itemName(mostXp.item))} (${esc(bonusText(mostXp.bonus))}) gives ${pct(xp(mostXp) / xp(best ?? mostXp) - 1, 1)} more${mostXp.make ? `, at ${duration(mostXp.make.perCombatHour)} an hour` : ''}.`
    : '';
  const head = best
    ? `<div class="verdict good"><strong>Cheapest to keep up: ${esc(gd.itemName(best.item))}</strong>About ${duration(best.make.perCombatHour)} of ${esc(skills(best))} for every hour against ${esc(vs.enemy.name)}.${mine && mine !== best && mine.make ? ` Your ${esc(gd.itemName(mine.item))} takes ${duration(mine.make.perCombatHour)}.` : ''}${xpNote}</div>`
    : '';
  return card(`Best food against ${esc(vs.enemy.name)}`, `${head}
    <p class="small muted" style="margin-top:8px">Time on the right: gathering and cooking for each hour of fighting.</p>
    <ul class="list-plain">${body.join('')}</ul>
    <p class="small muted" style="margin-top:8px">Healing counts your auto-eat efficiency; auto-eat only uses healing up to your max HP, so big foods help less when it's low. A food's bonus counts while it's selected, so each is compared with its own. Times are from scratch at your levels and bonuses (burnt food, doubling and preservation included).</p>`);
}

// Seconds when it's under a minute ("12s"), otherwise the usual duration.
const shortTime = (hours) => (hours * 3600 < 60 ? `${Math.max(1, Math.round(hours * 3600))}s` : duration(hours));

// How long the prayer points in your wallet last at a fight's usage (", your 1,200 prayer points last 3h").
function prayerLasts(ctx, r) {
  const have = ctx.save.wallet?.PrayerPoints;
  if (have == null) return '';
  return have > 0 ? `; your ${exact(have)} prayer points last ${duration(have / r.prayerPointsPerHour)}` : '; you have no prayer points';
}

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
          ${r.effects.length || r.effectsNotCounted.length ? `<p class="small">Effects: ${effectsText(r)}</p>` : ''}
          ${r.prayerPointsPerHour > 0 ? `<p class="small">Your prayers use ${num(r.prayerPointsPerHour)} prayer points/h${prayerLasts(ctx, r)}.</p>` : ''}
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
