// What a goal in your plan is worth, and goals beyond the next unlock in a skill: gear you could make
// that makes your fights faster, and Mastery Guild ranks you'd earn by gathering. The route weighs each
// goal by what it does for you per hour it takes. Isomorphic.
import { bestSelfSufficientProfitAt, bestXpMethodAt, producerIndex } from './advisor.js';
import { ownedEquipment, pickFood, recommendStyle, savedLoadouts, STYLES, xpOf } from './combat.js';
import { fightMethod } from './fight-method.js';
import { purchaseStatus } from './gamedata.js';
import { gearUpgrades } from './gear-upgrades.js';
import { masteryPlan, ownedStances } from './mastery-plan.js';
import { computeRates } from './rates.js';
import { toolUpgrades } from './toolbelt-advice.js';

// Every goal is worth this much (something new to do); what it speeds up adds to it: +10% on a rate
// you use counts as much again.
export const BASE_VALUE = 1;
const PER_SPEEDUP = 10;
const pct = (x) => `${Math.round(x * 100)}%`;
// Combat skills a plan can train by fighting, and the style that trains each (Defence and Hitpoints: the
// style of the gear they're for).
const COMBAT_TRAIN = new Set(['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints']);
const TRAIN_STYLE = { Attack: 'Melee', Strength: 'Melee', Ranged: 'Ranged', Magic: 'Magic' };

// Why a toolbelt item is worth making, in words: '+5% Hunting GP/h on Swamp Snake', else its best gain.
function toolReason(gd, r) {
  const g = r.gain;
  const skill = gd.skillName(r.skill);
  const one = (x) => `+${x < 0.1 ? (Math.round(x * 1000) / 10).toString() : Math.round(x * 100)}%`;
  if (g.current && Math.max(g.current.xp, g.current.gp) >= 0.002) return `${one(Math.max(g.current.xp, g.current.gp))} ${skill} ${g.current.xp >= g.current.gp ? 'XP' : 'GP'}/h on ${g.current.method.name}`;
  return g.xp?.share >= g.gp?.share ? `${one(g.xp.share)} ${skill} XP/h` : `${one(g.gp.share)} ${skill} GP/h`;
}

/** Shop items you can't buy only because of levels: { purchase, levels: { skill: level } }. */
export function levelLockedShop(gd, levels, purchased = {}) {
  const out = [];
  for (const p of gd.shop) {
    const s = purchaseStatus(gd, p, levels, purchased);
    if (s.ok || s.soldOut || s.unknown.length || !s.missing.length || !s.missing.every((r) => r.type === 'level')) continue;
    out.push({ purchase: p, levels: Object.fromEntries(s.missing.map((r) => [r.skill, r.level])) });
  }
  return out;
}

/**
 * What reaching level `to` in a skill does for you: a faster best method (XP/hour) among those whose
 * materials pass `supplied`, a money maker that beats the best you have (GP/hour), and shop items it lets
 * you buy.
 * @returns { value, reasons: [{ kind: 'xp'|'gp'|'shop', gain, text }] }
 */
export function unlockValue(gd, skill, levels, to, { baselineProfit = 0, shop = [], supplied = null } = {}) {
  const reasons = [];
  let value = BASE_VALUE;
  // Only methods you could keep going: a recipe whose materials you can't get isn't an upgrade.
  const now = bestXpMethodAt(gd, skill, levels, gd.levelOf(levels, skill), supplied);
  const then = bestXpMethodAt(gd, skill, levels, to, supplied);
  if (now && then && then.xpPerHour > now.xpPerHour * 1.01) {
    const gain = then.xpPerHour / now.xpPerHour - 1;
    value += PER_SPEEDUP * Math.min(gain, 0.5);
    reasons.push({ kind: 'xp', gain, text: `+${pct(gain)} ${gd.skillName(skill)} XP/h with ${then.method.name}` });
  }
  const money = bestSelfSufficientProfitAt(gd, skill, levels, to);
  if (money && baselineProfit > 0 && money.profitPerHour > baselineProfit * 1.05) {
    const gain = money.profitPerHour / baselineProfit - 1;
    value += PER_SPEEDUP * Math.min(gain, 0.3);
    reasons.push({ kind: 'gp', gain, text: `${money.method.name}: ${Math.round(money.profitPerHour).toLocaleString('en-US')} GP/h, ${pct(gain)} more than your best money maker` });
  }
  const buys = shop.filter((x) => x.levels[skill] && x.levels[skill] <= to && Object.entries(x.levels).every(([s, l]) => s === skill || gd.levelOf(levels, s) >= l));
  if (buys.length) {
    value += Math.min(2, 0.5 * buys.length);
    reasons.push({ kind: 'shop', gain: buys.length, text: `lets you buy ${buys.slice(0, 2).map((x) => x.purchase.name).join(', ')}${buys.length > 2 ? ` and ${buys.length - 2} more` : ''} in the shop` });
  }
  return { value, reasons };
}

/** Your best money maker that needs no materials right now, GP/hour: what a better one is measured against. */
export const baselineProfit = (gd, levels) => Math.max(0, ...gd.trainableSkills.map((s) => bestSelfSufficientProfitAt(gd, s, levels, gd.levelOf(levels, s))?.profitPerHour ?? 0));

/**
 * Goals beyond the next unlock in each skill, from a save (slow: worked out when a plan is made):
 *   { kind: 'gear', id, skill, to, item, method, value, reasons, toolbelt? } — craft gear that makes your best
 *     fight faster, or a toolbelt item that makes a skill better (toolbelt: that skill) (to: the level to make it
 *     at; your level when you can already);
 *   { kind: 'combat', id, skill, to, item, itemSource: 'own'|'buy'|'make', method?, gp?, fight, value, reasons }
 *     — a combat level that lets you wear something better, trained by fighting (fight: fightMethod() data);
 *   { kind: 'mastery', id, skill, rank, tasks: [{ method, hours, task, of, done, label }], value, reasons }
 *     — Mastery Guild ranks whose quickest tasks are all gathering (nothing used up) or fights, worth it at your levels.
 */
export function extraGoals(gd, save, { levels, xp = {}, bank = {}, gear = 3, mastery = 3, combat = 3, targets = [] } = {}) {
  const out = [];
  const index = producerIndex(gd, levels);
  const trainable = new Set(gd.trainableSkills);
  // Each style's fights (for combat levels and Mastery kill tasks), gear you'd make that makes your best
  // fight faster, and combat levels that let you wear something better.
  let fights = null;
  if (gd.combat && save?.combat) {
    const owned = ownedEquipment(gd, bank, save.combat);
    const saved = savedLoadouts(gd, save.combat);
    const food = pickFood(gd, bank, save.combat.food);
    const recs = {};
    for (const style of STYLES) {
      const rec = recommendStyle(gd, { style, owned, levels, bank, food, saved: saved[style] });
      if (rec?.gear?.enemy) recs[style] = rec;
    }
    // Your best XP an hour fighting in each combat skill (fights that can't kill you), to time levels.
    const combatXp = {};
    for (const rec of Object.values(recs)) {
      for (const f of rec.fights) {
        if (f.result.risky) continue;
        for (const [s, v] of Object.entries(f.result.xpPerHour)) combatXp[s] = Math.max(combatXp[s] ?? 0, v);
      }
    }
    fights = Object.fromEntries(Object.entries(recs).map(([style, rec]) => [style, { fights: rec.fights, ...ownedStances(gd, style, owned, rec.gear.gear.find((id) => gd.items[id]?.equip?.type === 'Weapon')) }]));
    const rows = [];
    const levelRows = [];
    for (const [style, rec] of Object.entries(recs)) {
      const up = gearUpgrades(gd, { rec, owned, levels, bank, food, index, purchased: save.shopPurchases ?? {}, xp, combatXp, includeOwned: true });
      for (const r of [...up.ready, ...up.soon]) {
        // One combat level away from wearing it (you own it, can buy it, or can make it now): a combat goal.
        if (r.needs.length === 1 && COMBAT_TRAIN.has(r.needs[0].skill) && ['own', 'buy', 'make'].includes(r.source.type) && !r.source.needs) {
          levelRows.push({ style, r, skill: r.needs[0].skill, to: r.needs[0].level });
          continue;
        }
        if (r.source.type !== 'make' || !r.needs.every((n) => trainable.has(n.skill))) continue;
        const skill = r.source.method.skill;
        const to = Math.max(gd.levelOf(levels, skill), ...r.needs.filter((n) => n.skill === skill).map((n) => n.level));
        if (r.needs.some((n) => n.skill !== skill)) continue;
        rows.push({ style, r, skill, to });
      }
    }
    rows.sort((a, b) => b.r.gainShare - a.r.gainShare);
    const seen = new Set();
    for (const { style, r, skill, to } of rows) {
      if (seen.has(r.item) || out.filter((g) => g.kind === 'gear').length >= gear) continue;
      seen.add(r.item);
      const gain = Math.max(r.gainShare, 0);
      out.push({ kind: 'gear', id: `gear|${r.item}`, skill, to, item: r.item, method: r.source.method.key, value: BASE_VALUE + PER_SPEEDUP * Math.min(gain, 0.3) + (r.damageCut > 0.1 ? 0.5 : 0),
        reasons: [{ kind: 'gear', gain, text: gain > 0.005 ? `+${pct(gain)} ${style} XP/h in your best fight` : `${pct(r.damageCut)} less damage taken in your best fight` }] });
    }
    // Your own goals in combat skills (the Goals page): train each to its target with the fight that gives
    // it the most XP, whatever it lets you wear.
    for (const t of targets) {
      if (!COMBAT_TRAIN.has(t.skill) || gd.levelOf(levels, t.skill) >= t.target || out.some((g) => g.id === `goal|${t.skill}|${t.target}`)) continue;
      let fight = null;
      for (const via of TRAIN_STYLE[t.skill] ? [TRAIN_STYLE[t.skill]] : Object.keys(recs)) {
        const rec = recommendStyle(gd, { style: via, owned, levels, bank, food, saved: saved[via], skill: t.skill });
        const g = rec?.gear;
        if (g?.enemy && !g.result.risky && xpOf(g.result, t.skill) > (fight ? xpOf(fight.g.result, t.skill) : 0)) fight = { g, via };
      }
      if (!fight) continue;
      const { g, via } = fight;
      out.push({ kind: 'combat', id: `goal|${t.skill}|${t.target}`, skill: t.skill, to: t.target, item: null, itemSource: null, yours: true, value: BASE_VALUE,
        fight: { enemy: g.enemy.id, area: g.area?.id ?? g.area ?? null, style: via, stance: g.stance ?? null, skill: t.skill, killsPerHour: g.result.killsPerHour, xpPerHour: g.result.xpPerHour, profitPerHour: g.result.profitPerHour ?? 0 },
        reasons: [{ kind: 'goal', gain: 1, text: `Your goal: ${gd.skillName(t.skill)} ${t.target}` }] });
    }
    // Combat levels: the best gear each one lets you wear, trained by the fight that gives that skill the
    // most XP (its own gear and stance: Block for Defence), one goal per skill.
    levelRows.sort((a, b) => b.r.worth - a.r.worth);
    const trainers = new Map();
    for (const { style, r, skill, to } of levelRows) {
      if (out.filter((g) => g.kind === 'combat').length >= combat || out.some((g) => g.kind === 'combat' && g.skill === skill)) continue;
      const via = TRAIN_STYLE[skill] ?? style;
      if (!trainers.has(`${via}|${skill}`)) trainers.set(`${via}|${skill}`, recommendStyle(gd, { style: via, owned, levels, bank, food, saved: saved[via], skill }));
      const g = trainers.get(`${via}|${skill}`)?.gear;
      if (!g?.enemy || g.result.risky || !(xpOf(g.result, skill) > 0)) continue;
      const gain = Math.max(r.gainShare, 0);
      const what = gain > 0.005 ? `+${pct(gain)} ${style} XP/h in your best fight` : `${pct(r.damageCut)} less damage taken in your best fight`;
      out.push({ kind: 'combat', id: `combat|${skill}|${to}`, skill, to, item: r.item, itemSource: r.source.type, method: r.source.type === 'make' ? r.source.method.key : null, gp: r.source.gp ?? null,
        fight: { enemy: g.enemy.id, area: g.area?.id ?? g.area ?? null, style: via, stance: g.stance ?? null, skill, killsPerHour: g.result.killsPerHour, xpPerHour: g.result.xpPerHour, profitPerHour: g.result.profitPerHour ?? 0 },
        value: BASE_VALUE + PER_SPEEDUP * Math.min(gain, 0.3) + (r.damageCut > 0.1 ? 0.5 : 0),
        reasons: [{ kind: 'gear', gain, text: what }] });
    }
  }
  // Toolbelt items you'd make that make a skill better (the "Worth getting" list): the best few, made in
  // one skill, at that skill's levels. Not what gets used up (potions): that's supplies, not a goal.
  if (save?.bank) {
    const up = toolUpgrades(gd, save, { levels, xp, index });
    const rows = [];
    for (const r of [...up.ready, ...up.soon]) {
      if (r.usedUp || r.worth < 1 || r.source.type !== 'make' || !r.needs.every((n) => trainable.has(n.skill))) continue;
      const skill = r.source.method.skill;
      if (r.needs.some((n) => n.skill !== skill)) continue;
      rows.push({ r, skill, to: Math.max(gd.levelOf(levels, skill), ...r.needs.map((n) => n.level)) });
    }
    rows.sort((a, b) => b.r.gain.score - a.r.gain.score);
    for (const { r, skill, to } of rows.slice(0, gear)) {
      if (out.some((g) => g.id === `gear|${r.item}`)) continue;
      const gain = r.gain.score;
      out.push({ kind: 'gear', id: `gear|${r.item}`, skill, to, item: r.item, method: r.source.method.key, toolbelt: r.skill, value: BASE_VALUE + PER_SPEEDUP * Math.min(gain, 0.3),
        reasons: [{ kind: 'gear', gain, text: toolReason(gd, r) }] });
    }
  }
  // Mastery: ranks you'd earn by gathering.
  if (save?.mastery) {
    const plans = masteryPlan(gd, save, levels, { bank, fights });
    const picks = [];
    for (const p of plans) {
      if (!p.plan || !p.value || !p.status.next) continue;
      const tasks = [];
      let ok = true;
      for (const t of p.plan.tasks) {
        // A kill task: the fight it's quickest with, as a method.
        const f = !t.how?.method && t.how?.enemy && fights?.[t.how.style]?.fights.find((x) => x.enemy.id === t.how.enemy.id && !x.result.risky);
        const m = t.how?.method ?? (f ? fightMethod(gd, { enemy: f.enemy.id, area: f.area?.id ?? f.area ?? null, style: t.how.style, stance: t.task.goal?.stance ?? null, skill: p.skill, killsPerHour: f.result.killsPerHour, xpPerHour: f.result.xpPerHour, profitPerHour: f.result.profitPerHour ?? 0 }) : null);
        if (!m || !t.task.goal || t.task.condition || computeRates(gd, m, m.level).inputs.length) {
          ok = false;
          break;
        }
        tasks.push({ method: m.key, hours: p.plan.extra?.get(t) ?? t.hours, own: t.hours, task: t.task.id, of: t.progress?.of ?? t.task.goal.max, done: t.progress?.done ?? 0, label: t.label });
      }
      if (!ok || !tasks.length) continue;
      picks.push({ kind: 'mastery', id: `mastery|${p.skill}|${p.status.next.id}`, skill: p.skill, rank: p.status.next.name, tasks, value: BASE_VALUE + PER_SPEEDUP * Math.min(p.value.speedup, 0.3),
        reasons: [{ kind: 'mastery', gain: p.value.speedup, text: `${p.status.next.name}: +${pct(p.value.speedup)} ${gd.skillName(p.skill)} ${p.value.by === 'xp' ? 'XP' : 'GP'}/h` }], hours: p.plan.hours });
    }
    out.push(...picks.sort((a, b) => b.value / b.hours - a.value / a.hours).slice(0, mastery));
  }
  return out;
}
