// Slayer: what each master's tasks are worth with your gear, and whether a task is worth keeping.
// Rewards from SlayerTasksStats (paid per task kill); task rolls from ActiveSlayerMaster. Isomorphic.

// XP goes through your XP bonuses (ExperienceStats); coins are raised by reward bonuses before rounding down.
export const slayerXpPerKill = (hitpoints, xpBonus = 0) => (hitpoints / 8 + 4) * (1 + xpBonus);
export const slayerCoinsPerKill = (hitpoints, percent = 0, flat = 0) => Math.max(1, Math.floor(0.1 * Math.pow(hitpoints, 1.15) * (1 + percent) + flat));
// Task length is rolled evenly between the base length and base + 3 per Slayer level.
export const taskLength = (master, slayerLevel) => ({ min: master.baseTaskLength, max: master.baseTaskLength + 3 * slayerLevel });

const enemyHitpoints = (enemy) => (enemy.levels?.Hitpoints ?? 1) * 10;

// Slayer XP and coin bonuses: from the save (Mastery Guild, shop permits, Astrology) and from the gear,
// pets and potions of the fight's player (buildPlayer's slayerCoins). Every master pays Slayer coins,
// so bonuses for that currency count.
function rewardBonuses(gd, fight) {
  const sum = (stat) => (gd.playerBonuses ?? []).filter((b) => b.skill === 'Slayer' && b.stat === stat && Object.keys(b.scope ?? {}).every((k) => k === 'Currency')).reduce((s, b) => s + b.value, 0);
  const coins = fight?.player?.slayerCoins;
  return { xp: sum('PercentXPGained'), percent: sum('PercentRewardCurrency') + (coins?.percent ?? 0), flat: sum('FlatRewardCurrency') + (coins?.flat ?? 0) };
}

// Per-kill and per-hour value of one enemy as a task.
// bestFights: Map enemyId -> { result, style, area, player }, the fight you'd use for that enemy.
function enemyValue(gd, enemy, bestFights) {
  const hp = enemyHitpoints(enemy);
  const fight = bestFights.get(enemy.id) ?? null;
  const kph = fight?.result.killsPerHour ?? 0;
  const bonus = rewardBonuses(gd, fight);
  const xpPerKill = slayerXpPerKill(hp, bonus.xp);
  const coinsPerKill = slayerCoinsPerKill(hp, bonus.percent, bonus.flat);
  return {
    enemy,
    fight,
    xpPerKill,
    coinsPerKill,
    slayerXpPerHour: xpPerKill * kph,
    coinsPerHour: coinsPerKill * kph,
    reachable: !!fight,
    risky: !!fight?.result.risky,
  };
}

function masterEnemies(gd, master, blocked, bestFights) {
  const ids = [...new Set(master.areas.flatMap((a) => gd.areaById.get(a)?.enemies ?? []))].filter((id) => !blocked.includes(id));
  return ids.map((id) => gd.enemyById.get(id)).filter(Boolean).map((enemy) => enemyValue(gd, enemy, bestFights));
}

/**
 * Every master with the expected value of its tasks, and your current task with advice.
 * Tasks are equally likely to be any unblocked enemy, so a master's rate is total reward over
 * total time across its enemies (enemies you can't fight safely count as rerolls).
 */
export function slayerOverview(gd, { levels, bestFights, tasks = {}, coins = 0 }) {
  const slayerLevel = gd.levelOf(levels, 'Slayer');
  return gd.combat.slayerMasters.map((master) => {
    const req = gd.checkRequirements({ skill: null, level: 0, requires: master.requires }, levels);
    const saved = tasks[master.id] ?? null;
    const enemies = masterEnemies(gd, master, saved?.blocked ?? [], bestFights);
    const doable = enemies.filter((e) => e.reachable && !e.risky && e.fight.result.killsPerHour > 0);
    const hours = doable.reduce((s, e) => s + 1 / e.fight.result.killsPerHour, 0);
    const average = {
      slayerXpPerHour: hours > 0 ? doable.reduce((s, e) => s + e.xpPerKill, 0) / hours : 0,
      coinsPerHour: hours > 0 ? doable.reduce((s, e) => s + e.coinsPerKill, 0) / hours : 0,
      combatXpPerHour: hours > 0 ? doable.reduce((s, e) => s + e.fight.result.combatXpPerHour / e.fight.result.killsPerHour, 0) / hours : 0,
    };
    let task = null;
    if (saved?.task) {
      const enemy = gd.enemyById.get(saved.task);
      const info = enemies.find((x) => x.enemy.id === saved.task) ?? (enemy ? enemyValue(gd, enemy, bestFights) : { enemy: { id: saved.task, name: saved.task }, fight: null, reachable: false, risky: false, slayerXpPerHour: 0 });
      const left = Math.max(0, saved.length - saved.progress);
      const kph = info.fight?.result.killsPerHour ?? 0;
      const slower = !info.risky && info.slayerXpPerHour < average.slayerXpPerHour * 0.6;
      const canReroll = coins >= master.rerollCost.qty;
      task = {
        ...info,
        length: saved.length,
        progress: saved.progress,
        left,
        hoursLeft: kph > 0 ? left / kph : Infinity,
        advice: !info.reachable ? 'unreachable' : info.risky ? (canReroll ? 'reroll-risky' : 'risky') : slower && left > 5 && canReroll ? 'reroll' : 'keep',
      };
    }
    return { master, unlocked: req.ok, missing: req.missing, enemies, doable: doable.length, average, task, length: taskLength(master, slayerLevel) };
  });
}

// The fastest safe fight for each enemy across your best gear for each style.
export function bestFightsByEnemy(recommendations) {
  const best = new Map();
  for (const rec of recommendations) {
    if (!rec) continue;
    for (const f of rec.fights) {
      const current = best.get(f.enemy.id);
      const better = !current || (current.result.risky && !f.result.risky) || (current.result.risky === f.result.risky && f.result.killsPerHour > current.result.killsPerHour);
      if (better) best.set(f.enemy.id, { ...f, style: rec.style });
    }
  }
  return best;
}
