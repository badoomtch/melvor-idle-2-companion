// A fight as a method, for plans: train a combat skill, or work on a Mastery Guild kill task, by fighting
// one enemy with one style and stance. It carries the combat engine's numbers from when the plan was made
// (kills an hour, XP an hour for each skill, GP an hour), so the route, its progress and the page treat it
// like any other method: computeRates() gives its rates, and it's registered in gd.methodByKey under its
// key (not in gd.methods: nothing gathers or makes with it). Isomorphic.

/**
 * @param fight { enemy (id), area (id), style, stance, skill (the combat skill the step trains),
 *   killsPerHour, xpPerHour: { skill: XP an hour }, profitPerHour }
 */
export function fightMethod(gd, fight) {
  const key = `Fight/${fight.enemy}/${fight.style}/${fight.stance ?? '-'}/${fight.skill}`;
  const had = gd.methodByKey.get(key);
  if (had?.kind === 'fight' && had.fight.killsPerHour === fight.killsPerHour) return had;
  const enemy = gd.enemies.find((e) => e.id === fight.enemy);
  const m = {
    key,
    id: key,
    kind: 'fight',
    skill: fight.skill,
    name: enemy?.name ?? fight.enemy,
    icon: enemy?.icon ?? null,
    level: 1,
    requires: [],
    enemy: fight.enemy,
    area: fight.area ?? null,
    style: fight.style,
    stance: fight.stance ?? null,
    fight: { killsPerHour: fight.killsPerHour, xpPerHour: { ...fight.xpPerHour }, profitPerHour: fight.profitPerHour ?? 0 },
  };
  gd.methodByKey.set(key, m);
  return m;
}

// What a locked plan keeps of a fight method, to make it again after a restart (fightMethod(gd, data)).
export const fightData = (m) => ({ enemy: m.enemy, area: m.area, style: m.style, stance: m.stance, skill: m.skill, ...m.fight });

// A fight method's rates, in computeRates' shape: one kill per action. The level doesn't change them
// (they're from when the plan was made).
export function fightRates(method) {
  const f = method.fight;
  const perHour = Math.max(f.killsPerHour, 1e-9);
  return {
    key: method.key,
    method,
    adjusted: method,
    level: 1,
    msPerCycle: 3.6e6 / perHour,
    slowMsPerXp: 3.6e6 / perHour,
    cyclesPerHour: perHour,
    completionsPerHour: perHour,
    hits: null,
    xpPerHour: f.xpPerHour[method.skill] ?? 0,
    outputs: [],
    inputs: [],
    currencies: {},
    grossPerHour: Math.max(0, f.profitPerHour),
    costPerHour: Math.max(0, -f.profitPerHour),
    profitPerHour: f.profitPerHour,
    successChance: null,
    hpLossPerHour: 0,
    food: null,
    passive: false,
    note: `${method.style}${method.stance ? `, ${method.stance} stance` : ''}`,
    toolUse: [],
  };
}
