// Dungeons (CombatAreasComponent, Dungeon): each fight in order picks one enemy by weight, with the
// usual spawn wait before it; the rewards come at the end and the dungeon starts again. Dungeon
// enemies drop nothing. Dying resets the run and stops combat, so the chance of dying per run matters
// as much as speed.

import { buildEnemy, buildPlayer, fight } from './combat.js';
import { GP } from './gamedata.js';

const HOUR_MS = 3_600_000;
const avg = (min, max) => ((min ?? 0) + (max ?? min ?? 0)) / 2;

// What an item is worth: a chest at the average value of what's inside (one level deep).
export function itemOrChestValue(gd, item) {
  const opens = gd.items[item]?.opens;
  if (!opens) return gd.itemValue(item);
  const always = opens.always.reduce((s, x) => s + avg(x.min, x.max) * gd.itemValue(x.item), 0);
  const total = opens.table.reduce((s, x) => s + (x.weight ?? 1), 0) || 1;
  const rolled = opens.table.reduce((s, x) => s + ((x.weight ?? 1) / total) * avg(x.min, x.max) * gd.itemValue(x.item), 0);
  return Math.max(gd.itemValue(item), always + rolled);
}

// Average GP value of one run's rewards.
export function rewardValue(gd, rewards) {
  const fixed = rewards.fixed.reduce((s, x) => s + avg(x.min, x.max) * itemOrChestValue(gd, x.item), 0);
  const tables = rewards.tables.reduce((s, t) => {
    const total = t.entries.reduce((w, x) => w + (x.weight ?? 1), 0) || 1;
    return s + t.chance * t.entries.reduce((v, x) => v + ((x.weight ?? 1) / total) * avg(x.min, x.max) * itemOrChestValue(gd, x.item), 0);
  }, 0);
  const gp = rewards.currencies.filter((c) => c.currency === GP).reduce((s, c) => s + avg(c.min, c.max), 0);
  return fixed + tables + gp;
}

/**
 * One gear set run through a dungeon, again and again.
 * @returns null when some fight can't be won, else { runMinutes, runsPerHour, xpPerHour, combatXpPerHour,
 *   rewardsPerRun, gpPerHour, deathChancePerRun, foodPerHour, unknown }
 */
export function dungeonRun(gd, dungeon, { gear, stance, spell = null, levels, food = null }) {
  // The dungeon's area effect counts too (Blood Sanctum's enemies are immune to Ranged and Magic).
  const area = { id: dungeon.id, name: dungeon.name, category: dungeon.category, darkness: dungeon.darkness, effect: dungeon.effect ?? [] };
  let ms = 0;
  let hazard = 0; // expected deaths per run (small, so the chance of dying is 1 - e^-hazard)
  let foodPerRun = 0;
  const xpPerRun = {};
  for (const group of dungeon.fights) {
    const total = group.enemies.reduce((s, x) => s + x.weight, 0) || 1;
    for (const { enemy: id, weight } of group.enemies) {
      const share = (group.count * weight) / total;
      const enemy = gd.enemyById.get(id);
      const p = buildPlayer(gd, { gear, stance, spell, levels, darkness: dungeon.darkness, area, slayerTask: !!gd.player?.slayerTasks?.includes(id), food });
      const r = fight(gd, p, buildEnemy(gd, enemy), { food });
      if (!(r.killsPerHour > 0)) return null;
      const cycleMs = HOUR_MS / r.killsPerHour; // spawn wait + the fight
      ms += share * cycleMs;
      // hoursToDeath counts the spawn waits too, so deaths per kill is one over (it x kills per hour).
      if (Number.isFinite(r.hoursToDeath)) hazard += share / (r.hoursToDeath * r.killsPerHour);
      foodPerRun += share * (r.foodPerHour ?? 0) / r.killsPerHour;
      for (const [skill, v] of Object.entries(r.xpPerHour)) xpPerRun[skill] = (xpPerRun[skill] ?? 0) + (share * v) / r.killsPerHour;
    }
  }
  const runsPerHour = HOUR_MS / ms;
  const xpPerHour = Object.fromEntries(Object.entries(xpPerRun).map(([k, v]) => [k, v * runsPerHour]));
  const rewardsPerRun = rewardValue(gd, dungeon.rewards);
  return {
    runMinutes: ms / 60_000,
    runsPerHour,
    xpPerHour,
    combatXpPerHour: Object.entries(xpPerHour).filter(([k]) => k !== 'Prayer').reduce((s, [, v]) => s + v, 0),
    rewardsPerRun,
    gpPerHour: rewardsPerRun * runsPerHour,
    deathChancePerRun: 1 - Math.exp(-hazard),
    foodPerHour: foodPerRun * runsPerHour,
    unknown: gd.checkRequirements({ skill: null, level: 0, requires: dungeon.requires }, levels).unknown,
  };
}
