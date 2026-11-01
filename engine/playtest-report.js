// A playtester's stats in one file they can choose to send to the developers: levels, the game's own
// statistics, Mastery Guild progress, and how the companion's estimates compared with what each
// action really gave. No character name or save id; nothing is sent anywhere by the companion.

import { compareActions } from './accuracy.js';
import { masteryStatus } from './mastery.js';

export function playtestReport(gd, save, { levels, observations = {}, appVersion = null, now = Date.now() } = {}) {
  const mastery = Object.fromEntries(Object.entries(masteryStatus(gd, save, levels)).map(([skill, m]) => [skill, { rank: m.rank?.name ?? null, points: m.points, total: m.total, tasksDone: m.done, tasks: m.tasks }]));
  const accuracy = compareActions(gd, observations, levels).map((r) => ({
    action: r.method?.key ?? r.key,
    hours: Number(r.hours.toFixed(3)),
    measuredXpPerHour: Math.round(r.measuredXp),
    estimatedXpPerHour: r.estimatedXp != null ? Math.round(r.estimatedXp) : null,
  }));
  return {
    kind: 'melvor-companion-playtest-report',
    createdAt: new Date(now).toISOString(),
    companion: appVersion,
    gameData: gd.meta?.source ?? null,
    saveVersion: save.version,
    gamemode: save.header?.gamemode ?? null,
    totalLevel: save.header?.totalLevel ?? null,
    gp: save.header?.gp ?? null,
    skills: Object.fromEntries(Object.entries(save.skills ?? {}).map(([id, s]) => [id, { level: s.level, xp: Math.round(s.xp) }])),
    agilityTechniques: save.agilityTechniques ?? null,
    mastery,
    shopPurchases: save.shopPurchases ?? {},
    pets: save.pets ?? [],
    enemiesKilled: save.enemiesKilled ?? {},
    statistics: save.statistics ?? {},
    accuracy,
  };
}
