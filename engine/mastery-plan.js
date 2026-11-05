// Mastery Guild planning: how long each open task would take at your current rates, and the cheapest
// set of tasks to each skill's next rank. Isomorphic.
//
// Every goal progresses all the time (ActiveMasteryGuildTask.OnSaveLoaded activates them), so a task's
// time is what's left of its goal at the best rate you have for it now, plus any level or item
// condition. Goals the companion can't time (damage dealt, evasions, potions brewed...) are left out.
import { hoursToLevel, obtain, producerIndex } from './advisor.js';
import { styleOfStance, weaponStyles } from './combat.js';
import { combatLevel } from './lookup.js';
import { masteryStatus, taskDone } from './mastery.js';
import { idleDanger } from './idle-danger.js';
import { computeRates } from './rates.js';

const localId = (id) => String(id ?? '').split(':').pop();
const usable = (req) => req.ok && req.unknown.length === 0;
export const COMBAT_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'];

// Goal progress per hour on a method: items made when the goal counts output, else finished actions
// (a cook only counts when it isn't burnt, a heist once every stage is stolen; a Hunting cycle already
// ends in a catch).
function progressPerHour(rates, output) {
  if (output) return rates.outputs.find((o) => o.item === rates.method.product?.item || o.item === rates.method.products?.[0]?.item)?.perHour ?? 0;
  return rates.completionsPerHour ?? rates.cyclesPerHour;
}

// The main style an enemy attacks with.
const enemyStyle = (gd, enemy) => styleOfStance(gd, [...(enemy.stances ?? [])].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0]?.stance);

// Every method that gives an item, made or found (Thieving loot, gems from mining), for item goals.
const givers = new WeakMap();
function methodsGiving(gd, item) {
  if (!givers.has(gd)) {
    const map = new Map();
    for (const m of gd.methods) {
      if (m.kind === 'farming') continue;
      for (const o of computeRates(gd, m, m.level).outputs) {
        if (!map.has(o.item)) map.set(o.item, []);
        map.get(o.item).push(m);
      }
    }
    givers.set(gd, map);
  }
  return givers.get(gd).get(item) ?? [];
}

// How much of a combat goal a fight makes per hour: kills, damage dealt, attacks evaded, hits of at least
// some damage, or prayer points spent.
function combatRate(goal, r) {
  switch (goal.measure) {
    case 'damage':
      return r.attacksPerHour * r.hitChance * r.averageHit;
    case 'evade':
      return (r.enemyAttacksPerHour ?? 0) * (1 - r.enemyHitChance);
    case 'bigHit':
      // Hits roll evenly up to your max hit.
      return r.maxHit >= goal.minDamage ? r.attacksPerHour * r.hitChance * ((r.maxHit - goal.minDamage + 1) / r.maxHit) : 0;
    case 'prayer':
      return r.prayerPointsPerHour ?? 0;
    default:
      return r.killsPerHour;
  }
}

// Every stance you could fight with in a style, and a weapon you own for each (the recommended one first),
// for tasks that need a stance: { stances: [..], weapons: { stance: itemId } }.
export function ownedStances(gd, style, owned, recommended) {
  const weapons = {};
  const ids = [recommended, ...owned.keys()].filter(Boolean);
  for (const id of ids) {
    const eq = gd.items[id]?.equip;
    if (eq?.type !== 'Weapon' || !weaponStyles(gd, id).includes(style)) continue;
    for (const st of gd.combat.weaponTypes[eq.weapon?.type]?.stances ?? []) weapons[st] ??= id;
  }
  return { stances: Object.keys(weapons), weapons };
}

// The fights a combat goal counts, each with how fast it progresses: matching enemy, level, styles and stance.
// With a stance your best weapon doesn't have, the time is your best gear's with that stance on another
// weapon you own (named in `how.weapon`): a little hopeful when that weapon is weaker.
function* goalFights(gd, goal, fights, rate) {
  for (const [style, rec] of Object.entries(fights ?? {})) {
    if (goal.style && goal.style !== style) continue;
    // A stance condition needs a weapon that has that stance.
    if (goal.stance && !rec.stances.includes(goal.stance)) continue;
    for (const f of rec.fights) {
      if (f.result.risky || !(f.result.killsPerHour > 0)) continue;
      if (goal.enemy && f.enemy.id !== goal.enemy) continue;
      const lvl = combatLevel(f.enemy, gd);
      if (goal.minLevel != null && (lvl < goal.minLevel || (goal.maxLevel != null && lvl > goal.maxLevel))) continue;
      if (goal.enemyStyle && enemyStyle(gd, f.enemy) !== goal.enemyStyle) continue;
      const perHour = rate(f.result);
      if (perHour > 0) yield { f, style, perHour, weapon: goal.stance ? rec.weapons?.[goal.stance] ?? null : null };
    }
  }
}

// The quickest way to make `remaining` progress on a goal now: { hours, how } or { hours: null, needs }.
// Methods that can kill you while left running (idleDanger) are left out like risky fights; when only
// those can do it, the quickest comes back as `handsOn`, timed as if you eat by hand.
function timeGoal(gd, goal, remaining, { levels, stock, index, fights }) {
  if (goal.methods || goal.item) {
    const methods = goal.methods ? goal.methods.map((k) => gd.methodByKey.get(k)).filter(Boolean) : methodsGiving(gd, goal.item);
    let best = null;
    let handsOn = null;
    let needs = null;
    for (const m of methods) {
      const req = gd.checkRequirements(m, levels);
      if (!usable(req)) {
        const lv = req.missing.filter((r) => r.type === 'level');
        if (lv.length === req.missing.length && !req.unknown.length && (!needs || lv[0].level - gd.levelOf(levels, lv[0].skill) < needs.level - gd.levelOf(levels, needs.skill))) needs = lv[0];
        continue;
      }
      const rates = computeRates(gd, m, gd.levelOf(levels, m.skill));
      // Items made or found; steps of multi-step crafts; else crafts (or what they make).
      const rate = goal.item ? rates.outputs.find((o) => o.item === goal.item)?.perHour ?? 0 : goal.steps ? rates.cyclesPerHour * (m.steps ?? 1) : progressPerHour(rates, goal.output);
      if (!(rate > 0)) continue;
      const work = remaining / rate;
      // Materials for the whole goal: from the bank, else gathered or made first.
      let gather = 0;
      if (stock) {
        for (const i of rates.inputs) {
          const o = obtain(index(), stock, i.item, i.perHour * work);
          gather += o.hours;
        }
      }
      const hours = work + gather;
      if (!Number.isFinite(hours)) continue;
      const danger = idleDanger(gd, rates);
      if (danger?.risky) {
        if (!handsOn || hours < handsOn.hours) handsOn = { hours, gatherHours: gather, how: { method: m, perHour: rate }, danger };
      } else if (!best || hours < best.hours) {
        best = { hours, gatherHours: gather, how: { method: m, perHour: rate } };
      }
    }
    // An item that drops in fights you can do safely.
    if (goal.item && fights) {
      for (const { f, style, perHour } of goalFights(gd, {}, fights, (r) => (r.loot?.items ?? []).filter((x) => x.item === goal.item).reduce((sum, x) => sum + x.qty, 0) * r.killsPerHour)) {
        const hours = remaining / perHour;
        if (!best || hours < best.hours) best = { hours, how: { enemy: f.enemy, style, xpPerHour: f.result.xpPerHour } };
      }
    }
    return best ?? { hours: null, needs, ...(handsOn ? { handsOn } : {}) };
  }
  if (goal.enemy || goal.minLevel != null || goal.enemyStyle || goal.measure) {
    let best = null;
    for (const { f, style, perHour, weapon } of goalFights(gd, goal, fights, (r) => combatRate(goal, r))) {
      const hours = remaining / perHour;
      if (!best || hours < best.hours) best = { hours, how: { enemy: f.enemy, style, xpPerHour: f.result.xpPerHour, weapon } };
    }
    return best ?? { hours: null };
  }
  return { hours: null };
}

/**
 * Open tasks for every skill with how long each would take, and the cheapest set to the next rank.
 * @param fights { [style]: { fights: rankFights() rows, stances: stances the recommended weapon has } }
 * @returns [{ skill, status, open: [{ task, label, hours, how, needs, progress }], plan: { hours, tasks } | null }]
 */
// `only`: plan one skill's guild (the menu asks about the skill you're training).
export function masteryPlan(gd, save, levels, { bank = null, fights = null, index = null, only = null } = {}) {
  const status = masteryStatus(gd, save, levels);
  const stock = bank ? new Map(Object.entries(bank)) : null;
  const getIndex = () => (index ??= producerIndex(gd, levels));
  // Best XP/hour fighting, per combat skill, for level conditions.
  const combatXp = {};
  for (const rec of Object.values(fights ?? {})) {
    for (const f of rec.fights) {
      if (f.result.risky) continue;
      for (const [skill, v] of Object.entries(f.result.xpPerHour)) combatXp[skill] = Math.max(combatXp[skill] ?? 0, v);
    }
  }
  for (const s of COMBAT_SKILLS) combatXp[s] ??= 0;
  // Tasks done by the same activity progress together: catching 150 and 1,000 at the same spot, or
  // gaining Agility Marks and Agility levels on the same obstacle. Levels come from your best XP method.
  const bestKey = new Map();
  const activity = (how) => (how?.method ? `do|${how.method.key}` : how?.enemy ? `fight|${how.enemy.id}|${how.style}` : null);
  const levelActivity = (skill) => {
    if (!bestKey.has(skill)) bestKey.set(skill, bestRates(gd, skill, levels, gd.playerBonuses ?? []).xp?.method.key ?? null);
    return bestKey.get(skill) ? `do|${bestKey.get(skill)}` : `level|${skill}`;
  };
  const levelHours = new Map();
  const climbs = new Map();
  const climbTo = (skill, level) => {
    const key = `${skill}|${level}`;
    if (!climbs.has(key)) climbs.set(key, hoursToLevel(gd, skill, levels, save?.skills?.[skill]?.xp ?? 0, level, { combatXp }));
    return climbs.get(key);
  };
  const toLevel = (skill, level) => {
    const key = `${skill}|${level}`;
    if (!levelHours.has(key)) levelHours.set(key, hoursToLevel(gd, skill, levels, save?.skills?.[skill]?.xp ?? 0, level, { bank, index: stock ? getIndex() : null, combatXp }));
    return levelHours.get(key);
  };

  const out = [];
  for (const [skill, st] of Object.entries(status)) {
    if (only && skill !== only) continue;
    const saved = save?.mastery?.[skill] ?? {};
    const open = [];
    for (const task of gd.raw.mastery[skill].tasks) {
      const s = saved[task.id] ?? saved[localId(task.id)];
      if (taskDone(gd, task, s, { save, levels })) continue;
      const row = { task, points: task.points, hours: 0, parts: [], key: null };
      // The goal: what's left at the best rate you have now.
      if (task.goal && !s?.goalComplete) {
        const progress = Math.min(task.goal.max, s?.goalProgress ?? 0);
        let t = timeGoal(gd, task.goal, task.goal.max - progress, { levels, stock, index: getIndex, fights });
        // Locked behind a skilling level: the time to get there (a long way off, so as if you had the
        // materials), then the task at that level.
        if (t.hours == null && t.needs && gd.trainableSkills.includes(t.needs.skill)) {
          const climb = climbTo(t.needs.skill, t.needs.level);
          const there = Number.isFinite(climb) ? timeGoal(gd, task.goal, task.goal.max - progress, { levels: { ...levels, [t.needs.skill]: t.needs.level }, stock, index: getIndex, fights }) : null;
          if (there?.hours != null) t = { ...there, hours: climb + there.hours, needs: t.needs, climb };
        }
        // Only something that can kill you left running does it: timed as if you eat by hand, kept out of plans.
        if (t.hours == null && t.handsOn) {
          row.handsOn = t.handsOn.danger;
          t = t.handsOn;
        }
        row.label = task.goal.label ?? null;
        row.progress = { done: progress, of: task.goal.max };
        row.how = t.how ?? null;
        row.needs = t.needs ?? null;
        row.gatherHours = t.gatherHours ?? 0;
        row.hours = t.hours == null ? null : row.hours + t.hours;
        // Tasks that count the same thing share progress: "Cook 2,000 Shrimp" finishes "Cook 250 Shrimp".
        row.key = activity(t.how) ?? JSON.stringify({ ...task.goal, max: undefined, label: undefined });
      }
      // A level or item condition.
      const c = task.condition;
      if (row.hours != null && c) {
        if (c.type === 'level') {
          const h = toLevel(c.skill, c.level);
          row.label ??= `Reach ${gd.skillName(c.skill)} level ${c.level}`;
          row.hours = Number.isFinite(h) ? row.hours + h : null;
          row.key ??= levelActivity(c.skill);
          if (!row.progress) row.progress = { done: gd.levelOf(levels, c.skill), of: c.level, level: true };
        } else if (c.type === 'itemStat') {
          const have = save?.statistics?.[c.stat]?.[c.item] ?? save?.statistics?.[c.stat]?.[`MelvorBase:${c.item}`] ?? 0;
          let t = timeGoal(gd, { item: `MelvorBase:${c.item}` }, Math.max(0, c.value - have), { levels, stock, index: getIndex, fights });
          if (t.hours == null && t.handsOn) {
            row.handsOn ??= t.handsOn.danger;
            t = t.handsOn;
          }
          row.label ??= `Get ${c.value.toLocaleString('en-US')} ${gd.itemName(`MelvorBase:${c.item}`)}`;
          row.how ??= t.how ?? null;
          row.needs ??= t.needs ?? null;
          row.hours = t.hours == null ? null : row.hours + t.hours;
          row.key ??= activity(row.how) ?? `item|${c.item}`;
          row.progress ??= { done: Math.min(have, c.value), of: c.value };
        } else {
          row.hours = null;
        }
      }
      if (task.trigger && !s?.triggerMet) row.hours = null;
      if (!row.label) row.hours = null;
      // A task that can kill you left running stays out of the plan; `handsOnHours` is its time eating by hand.
      if (row.handsOn) {
        row.handsOnHours = row.hours;
        row.hours = null;
      }
      open.push(row);
    }
    const plan = planRank(open, st.pointsToNext);
    out.push({ skill, status: st, open, plan, value: plan && st.nextBonus ? rankValue(gd, skill, st.nextBonus, levels, plan, combatXp) : null });
  }
  return out;
}

// The best a skill's methods do at your level, with a set of bonuses: XP/hour and profit/hour.
function bestRates(gd, skill, levels, bonuses) {
  const level = gd.levelOf(levels, skill);
  let xp = null;
  let money = null;
  for (const m of gd.methodsBySkill[skill] ?? []) {
    if (!usable(gd.checkRequirements(m, levels))) continue;
    // Only what you can leave running (your own bonuses say whether it can kill you).
    if (idleDanger(gd, computeRates(gd, m, level))?.risky) continue;
    const r = computeRates(gd, m, level, { bonuses });
    if (r.xpPerHour > 0 && (!xp || r.xpPerHour > xp.xpPerHour)) xp = r;
    if (!r.passive && (!money || r.profitPerHour > money.profitPerHour)) money = r;
  }
  return { xp, money };
}

/**
 * What a rank's bonus is worth to you. `speedup` is how much more XP (or profit) an hour your best method
 * in the skill makes with it; `saving` the share of time that saves from then on. `extraHours` is what
 * the rank's tasks cost beyond training you'd do anyway (doing the skill's own actions at close to your
 * best XP rate is mostly training), and `paybackHours` how much of that skill it takes to win it back.
 * Null when the bonus is something the companion can't put a number on.
 */
export function rankValue(gd, skill, bonus, levels, plan, combatXp = {}) {
  const base = gd.playerBonuses ?? [];
  const now = bestRates(gd, skill, levels, base);
  const after = bestRates(gd, skill, levels, [...base, ...(bonus.effects ?? [])]);
  // Skills without methods to rate (combat): an XP bonus is worth what it adds to the ones you have.
  const xpBonus = (list) => list.filter((e) => e.stat === 'PercentXPGained' && e.skill === skill && !e.scope).reduce((s, e) => s + e.value, 0);
  const xpGain = now.xp && after.xp ? after.xp.xpPerHour / now.xp.xpPerHour - 1 : now.xp ? 0 : xpBonus(bonus.effects ?? []) / (1 + xpBonus(base));
  const moneyGain = now.money?.profitPerHour > 0 && after.money ? after.money.profitPerHour / now.money.profitPerHour - 1 : 0;
  const speedup = Math.max(xpGain, moneyGain);
  if (!(speedup > 1e-6)) return null;
  const saving = 1 - 1 / (1 + speedup);
  let extraHours = 0;
  for (const t of plan.tasks) {
    const cost = plan.extra?.get(t) ?? t.hours;
    let training = 0;
    if (t.how?.method?.skill === skill && now.xp) {
      const r = computeRates(gd, t.how.method, gd.levelOf(levels, skill));
      training = Math.min(1, r.xpPerHour / now.xp.xpPerHour) * Math.max(0, t.hours - (t.gatherHours ?? 0));
    } else if (t.how?.enemy && combatXp[skill] > 0) {
      // A kill task trains the skill as well as that fight does next to your best one.
      training = Math.min(1, (t.how.xpPerHour?.[skill] ?? 0) / combatXp[skill]) * t.hours;
    } else if (t.task.condition?.type === 'level' && t.task.condition.skill === skill && !t.task.goal) {
      training = t.hours;
    }
    extraHours += cost * (t.hours > 0 ? 1 - Math.min(1, training / t.hours) : 0);
  }
  return { xpGain, moneyGain, speedup, saving, by: speedup === xpGain ? 'xp' : 'money', method: (speedup === xpGain ? after.xp : after.money)?.method ?? null, extraHours, paybackHours: extraHours / saving };
}

// The cheapest set of timed tasks worth `needed` points. Tasks that count the same thing only cost
// the extra beyond the one already picked; picks the lowest extra hours per point each time.
export function planRank(open, needed) {
  if (!(needed > 0)) return null;
  const timed = open.filter((t) => t.hours != null);
  const pickedHours = new Map();
  const picked = [];
  const extra = new Map();
  let points = 0;
  let hours = 0;
  while (points < needed) {
    let best = null;
    for (const t of timed) {
      if (picked.includes(t)) continue;
      const extra = Math.max(0, t.hours - (pickedHours.get(t.key) ?? 0));
      const score = extra / t.points;
      if (!best || score < best.score) best = { t, extra, score };
    }
    if (!best) return null;
    picked.push(best.t);
    extra.set(best.t, best.extra);
    points += best.t.points;
    hours += best.extra;
    if (best.t.key) pickedHours.set(best.t.key, Math.max(pickedHours.get(best.t.key) ?? 0, best.t.hours));
  }
  // `extra`: what each task adds on top of the ones before it (its own time, less any shared progress).
  return { hours, points, tasks: picked.sort((a, b) => a.hours - b.hours), extra };
}
