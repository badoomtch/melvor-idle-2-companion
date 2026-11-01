// What a goal in your plan is worth, and goals beyond the next unlock in a skill: gear you could make
// that makes your fights faster, and Mastery Guild ranks you'd earn by gathering. The route weighs each
// goal by what it does for you per hour it takes. Isomorphic.
import { bestSelfSufficientProfitAt, bestXpMethodAt, producerIndex } from './advisor.js';
import { ownedEquipment, pickFood, recommendStyle, savedLoadouts, STYLES } from './combat.js';
import { purchaseStatus } from './gamedata.js';
import { gearUpgrades } from './gear-upgrades.js';
import { masteryPlan } from './mastery-plan.js';
import { computeRates } from './rates.js';

// Every goal is worth this much (something new to do); what it speeds up adds to it: +10% on a rate
// you use counts as much again.
export const BASE_VALUE = 1;
const PER_SPEEDUP = 10;
const pct = (x) => `${Math.round(x * 100)}%`;

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
 *   { kind: 'gear', id, skill, to, item, method, value, reasons } — craft gear that makes your best fight
 *     faster (to: the level to make it at; your level when you can already);
 *   { kind: 'mastery', id, skill, rank, tasks: [{ method, hours, task, of, done, label }], value, reasons }
 *     — Mastery Guild ranks whose quickest tasks are all gathering (nothing used up), worth it at your levels.
 */
export function extraGoals(gd, save, { levels, xp = {}, bank = {}, gear = 3, mastery = 3 } = {}) {
  const out = [];
  const index = producerIndex(gd, levels);
  const trainable = new Set(gd.trainableSkills);
  // Gear: the upgrades the Combat page lists that you'd make, at skilling levels.
  if (gd.combat && save?.combat) {
    const owned = ownedEquipment(gd, bank, save.combat);
    const saved = savedLoadouts(gd, save.combat);
    const food = pickFood(gd, bank, save.combat.food);
    const rows = [];
    for (const style of STYLES) {
      const rec = recommendStyle(gd, { style, owned, levels, bank, food, saved: saved[style] });
      if (!rec) continue;
      const up = gearUpgrades(gd, { rec, owned, levels, bank, food, index, purchased: save.shopPurchases ?? {}, xp });
      for (const r of [...up.ready, ...up.soon]) {
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
  }
  // Mastery: ranks you'd earn by gathering.
  if (save?.mastery) {
    const plans = masteryPlan(gd, save, levels, { bank });
    const picks = [];
    for (const p of plans) {
      if (!p.plan || !p.value || !p.status.next) continue;
      const tasks = [];
      let ok = true;
      for (const t of p.plan.tasks) {
        const m = t.how?.method;
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
