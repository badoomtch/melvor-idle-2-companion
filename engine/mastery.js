// Mastery Guild: each skill's rank from the tasks you've completed, and the bonuses that rank gives.
//
// A task is done when its goal is complete (saved), its condition holds (your level, a saved
// statistic, a pet, Agility technique levels) and its trigger has fired (saved), as in
// ActiveMasteryGuildTask.CheckIfMet, which re-checks the condition live rather than saving it.
// Tasks earn their category's points; a rank needs a share of all the skill's points, and every
// rank you've reached adds its bonus.

const localId = (id) => String(id ?? '').split(':').pop();

// Dictionary statistics are saved as { statId: { objectId: value } } (items, Slayer masters, Agility
// courses, Astrology events, Ranching animals...); ids may or may not carry the namespace.
function statValue(statistics, stat, item) {
  const byItem = statistics?.[stat] ?? statistics?.[localId(stat)];
  if (!byItem || typeof byItem !== 'object') return 0;
  return byItem[item] ?? byItem[localId(item)] ?? Object.entries(byItem).find(([k]) => localId(k) === localId(item))?.[1] ?? 0;
}

// true / false, or null when the companion can't tell from the save (counted as not done).
export function conditionMet(gd, condition, { save, levels }) {
  switch (condition.type) {
    case 'level':
      return gd.levelOf(levels, condition.skill) >= condition.level;
    case 'itemStat':
      return save?.statistics ? statValue(save.statistics, condition.stat, condition.item) >= condition.value : null;
    case 'pet':
      return (save?.pets ?? []).some((p) => localId(p) === localId(condition.pet));
    case 'stat': {
      // DictionaryStatisticCondition. A statistic missing from the save (its list wasn't read) is unknown.
      const byId = save?.statistics?.[condition.stat];
      return byId && typeof byId === 'object' ? statValue(save.statistics, condition.stat, condition.id) >= condition.value : null;
    }
    case 'value': {
      // ValueStatisticCondition. Simple statistics are saved; the Astrology node totals are worked out
      // when the game loads, so they're counted from the nodes in the save.
      const nodes = { AstrologyTotalMajorNodesUnlocked: 'major', AstrologyTotalMinorNodesUnlocked: 'minor' }[condition.stat];
      if (nodes) return save?.astrology ? Object.values(save.astrology).reduce((s, c) => s + c[nodes].length, 0) >= condition.value : null;
      return typeof save?.statistics?.[condition.stat] === 'number' ? save.statistics[condition.stat] >= condition.value : null;
    }
    case 'astrologyNodes': {
      const c = save?.astrology ? save.astrology[condition.constellation] : undefined;
      return save?.astrology ? (c?.[condition.major ? 'major' : 'minor'].length ?? 0) >= condition.count : null;
    }
    case 'journalLevels':
      return save?.huntingJournal ? Object.values(save.huntingJournal).filter((j) => j.level >= condition.level).length >= condition.count : null;
    case 'rareSpecies': {
      const byId = save?.statistics?.HuntingAnimalSpeciesTrapped;
      return byId && typeof byId === 'object' ? Object.values(byId).filter((n) => n >= 1).length >= condition.count : null;
    }
    case 'collectables': {
      const found = save?.statistics?.BankItemFound;
      return found && typeof found === 'object' ? (gd.raw.huntingCollectables ?? []).filter((item) => statValue(save.statistics, 'BankItemFound', item) >= 1).length >= condition.count : null;
    }
    case 'technique':
      return save?.agilityTechniques ? (save.agilityTechniques[condition.technique]?.level ?? 1) >= condition.level : null;
    case 'techniques':
      // AgilityNumTechniquesLevelCondition: at least `count` techniques at `level` or higher.
      return save?.agilityTechniques ? Object.values(save.agilityTechniques).filter((t) => t.level >= condition.level).length >= condition.count : null;
    default:
      return null;
  }
}

export function taskDone(gd, task, saved, ctx) {
  if (task.goal && !saved?.goalComplete) return false;
  if (task.trigger && !saved?.triggerMet) return false;
  if (task.condition && conditionMet(gd, task.condition, ctx) !== true) return false;
  return true;
}

// { [skill]: { points, total, done, tasks, rank, next, pointsToNext, bonuses, nextBonus } }
export function masteryStatus(gd, save, levels) {
  const out = {};
  for (const [skill, def] of Object.entries(gd.raw.mastery ?? {})) {
    const saved = save?.mastery?.[skill] ?? {};
    let points = 0;
    let total = 0;
    let done = 0;
    for (const task of def.tasks) {
      total += task.points;
      if (taskDone(gd, task, saved[task.id] ?? saved[localId(task.id)], { save, levels })) {
        points += task.points;
        done++;
      }
    }
    const needed = (rank) => Math.ceil(total * rank.percent);
    const rankName = (id) => def.ranks.find((r) => r.id === id)?.name ?? id;
    const reached = def.ranks.filter((r) => points >= needed(r));
    const next = def.ranks.find((r) => points < needed(r)) ?? null;
    const reachedIds = new Set(reached.map((r) => r.id));
    out[skill] = {
      points,
      total,
      done,
      tasks: def.tasks.length,
      rank: reached.at(-1) ?? null,
      next,
      pointsToNext: next ? needed(next) - points : 0,
      bonuses: def.bonuses.filter((b) => reachedIds.has(b.rank)).map((b) => ({ ...b, rankName: rankName(b.rank) })),
      nextBonus: next ? def.bonuses.find((b) => b.rank === next.id) ?? null : null,
    };
  }
  return out;
}
