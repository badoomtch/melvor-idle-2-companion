// How many tries you've already had at a rare item from one source, read from your save's statistics,
// and how many players would have found it by then. Isomorphic.
//
// Thieving counts successful steals (loot only drops on a success), fights count kills, hunting catches,
// Agility runs, Astrology studies, chests opened. Woodcutting and mining count actions from the logs or
// ore you've gathered of that kind. Fishing has no count per spot, so it has none.

const local = (id) => String(id ?? '').split(':').pop();

/**
 * @param source a rare-items source: { type: 'method'|'enemy'|'open', method|enemy|from, p }
 * @param rates computeRates() for a method source at your level (for its odds and action time), else null
 * @returns null when the save doesn't count it, else { tries, unit, attempts, p, chance, hours }:
 *   chance is the share of players who'd have found one in that many tries
 */
export function triesSoFar(gd, save, item, source, rates = null) {
  const st = save?.statistics;
  if (!st) return null;
  const count = (stat, id) => st[stat]?.[local(id)] ?? 0;
  const done = (tries, unit, p, extra = {}) => (tries >= 1 && p > 0 ? { tries, unit, p, chance: 1 - Math.pow(1 - p, tries), ...extra } : null);
  if (source.type === 'enemy') return done(count('CombatEnemyKilled', source.enemy.id), 'kills', source.p);
  if (source.type === 'open') return done(count('BankItemOpened', source.from), `${gd.itemName(source.from)} opened`, source.p);
  const m = source.method;
  if (!m || !rates?.cyclesPerHour) return null;
  // The odds per action at your level: a find's own chance, else what an action gives of it.
  const perAction = rates.chancePerCycle?.[item] ?? Math.min(1, (rates.outputs.find((o) => o.item === item)?.perHour ?? 0) / rates.cyclesPerHour);
  const hours = (actions) => actions / rates.cyclesPerHour;
  switch (m.kind) {
    case 'thieving': {
      const wins = count('ThievingSuccessfulAction', m.id);
      const attempts = wins + count('ThievingFailedAction', m.id);
      const s = rates.successChance ?? 1;
      return done(wins, 'successful steals', s > 0 ? Math.min(1, perAction / s) : 0, { attempts, hours: hours(attempts) });
    }
    case 'hunting': {
      const n = count('HuntingAnimalTrapped', m.id);
      return done(n, 'catches', perAction, { hours: hours(n) });
    }
    case 'agility': {
      const n = count('AgilityCourseCompleted', m.id);
      return done(n, 'runs', perAction, { hours: hours(n) });
    }
    case 'astrology': {
      const n = count('AstrologyTimesConstellationStudied', m.id);
      return done(n, 'studies', perAction, { hours: hours(n) });
    }
    case 'woodcutting':
    case 'mining': {
      // Actions from what you've gathered of that log or ore, at what an action gives now.
      const each = (rates.outputs.find((o) => o.item === m.product.item)?.perHour ?? 0) / rates.cyclesPerHour;
      const n = each > 0 ? Math.floor(count(`${m.skill}ItemGained`, m.product.item) / each) : 0;
      return done(n, m.kind === 'woodcutting' ? 'logs cut' : 'ores mined', perAction, { hours: hours(n) });
    }
    default:
      return null;
  }
}
