// Your ranch from the save: the animals in each enclosure, what the whole herd really makes in an hour,
// and what needs looking after. Isomorphic. The formulas are the game's (0.11.4):
//   ActiveRanchingAnimal.UpdateHappiness: happiness = max(0, hunger × 0.3 + (safety >= 0.75 ? 1 : safety)
//     × 0.3 + satisfaction × 0.4 − (sick ? 0.3 : 0) + FlatHappiness).
//   GetProducedResources: nothing while hunger or safety is 0, else each product is (base + flat) ×
//     (1 + percent) × happiness, and a doubling roll (one per animal per product) doubles it.
//   RanchingPassiveComponent.ProductTimerFiredHandler: once an hour the game adds each product up over
//     every animal and rounds the total down, so one chicken's 0.96 raw chicken an hour is 0.
//   GrantRewards: (base + flat) × (1 + percent) × happiness XP per animal each hour, not rounded.
//   UpdateHunger: every food interval (an hour) each animal eats its food unless a preservation roll
//     saves it; with none in the bank its hunger drops 0.1. Treats are eaten once a day.
//   The base variant (a child, until its minutes to grow up run out) has −50% products and XP
//   (RanchingAnimalVariant.SelfBonuses); some grown variants have +100% products.
//   ActiveRanchingEnclosure.AttemptToBreed: once an hour each enclosure goes through the species it
//     takes, in the data's order, and stops at the first with fewer than 2 animals or with as many as the
//     enclosure holds. Otherwise a baby comes with chance 0.01% × (animals of that species at 75%
//     happiness or more) × (their average happiness). It joins the same enclosure only if there's room
//     (AddNewAnimal: fewer animals in all than the limit), free, as a new child like a bought one: full
//     life, and its grown variant is rolled when it grows up, whatever its parents are.

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TREAT_MS = 86_400_000; // RanchingPassiveComponent.BaseTreatCooldown
const OLD_MS = 12 * HOUR_MS; // "close to dying of age" on the page
const BREED_CHANCE = 0.0001; // ActiveRanchingEnclosure._baseBreedChance, per happy animal per hour
const BREED_HAPPINESS = 0.75; // _breedingHappinessRequirement

const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2').trim();

// Player bonuses (shop, toolbelt, pets, Mastery Guild, Astrology) for one species.
function bonusSum(effects, species) {
  const list = effects.filter((e) => e.skill === 'Ranching' && Object.entries(e.scope ?? {}).every(([k, v]) => (k === 'Animal' || k === 'Recipe') && v === species));
  return (...stats) => list.filter((e) => stats.includes(e.stat)).reduce((s, e) => s + e.value, 0);
}

// What a variant changes. The data lists each variant's bonuses (ranchingVariants); without it, only the
// child is known (it's the base variant until its grow-up minutes run out) and every grown variant
// counts as a plain adult.
function variantInfo(gd, species, a) {
  const known = gd.raw?.ranchingVariants?.[a.variant];
  const child = a.variantMinutes > 0;
  const name = known?.name ?? (humanize(a.variant.startsWith(species) ? a.variant.slice(species.length) : a.variant) || 'Adult');
  if (known) return { name, child, product: known.productPercent ?? 0, xp: known.xpPercent ?? 0, known: true };
  return { name: child ? 'Child' : name, child, product: child ? -0.5 : 0, xp: child ? -0.5 : 0, known: false };
}

// P(k doubles out of n), each with chance p.
function binomial(n, p) {
  if (p >= 1) return Array.from({ length: n + 1 }, (_, k) => (k === n ? 1 : 0));
  const out = [Math.pow(1 - p, n)];
  for (let k = 0; k < n; k++) out.push((out[k] * (n - k) * p) / ((k + 1) * (1 - p)));
  return out;
}

/**
 * One hour of one product over the herd: the total is rounded down once. Each contribution is
 * { q, p }: an animal's amount and its chance to double it. Returns the expected amount after rounding,
 * the amount you always get (no doubles), and what it would be without the rounding.
 */
export function hourlyProduct(contribs) {
  const base = contribs.reduce((s, c) => s + c.q, 0);
  const unrounded = contribs.reduce((s, c) => s + c.q * (1 + Math.min(1, c.p)), 0);
  const guaranteed = Math.floor(base + 1e-9);
  const groups = new Map();
  for (const c of contribs) {
    if (!(c.q > 0 && c.p > 0)) continue;
    const key = `${c.q}|${c.p}`;
    const g = groups.get(key) ?? { q: c.q, p: Math.min(1, c.p), n: 0 };
    g.n++;
    groups.set(key, g);
  }
  // The exact spread of doubles, group by group (animals with the same amount and chance share one).
  let dist = new Map([[0, 1]]);
  for (const g of groups.values()) {
    const pk = binomial(g.n, g.p);
    const next = new Map();
    for (const [v, pr] of dist) {
      for (let k = 0; k <= g.n; k++) {
        if (!pk[k]) continue;
        const key = Math.round((v + k * g.q) * 1e9) / 1e9;
        next.set(key, (next.get(key) ?? 0) + pr * pk[k]);
      }
    }
    dist = next;
    if (dist.size > 50_000) return { expected: Math.floor(unrounded), guaranteed, unrounded }; // a huge mixed herd: close enough
  }
  let expected = 0;
  for (const [v, pr] of dist) expected += pr * Math.floor(base + v + 1e-9);
  return { expected, guaranteed, unrounded };
}

/**
 * The herd in the save. options.bonuses defaults to gd.playerBonuses; options.now to the clock.
 * Times (deathAt, adultAt) count from the save's timestamp, like the game's own minute timer.
 */
export function ranchModel(gd, save, options = {}) {
  const ranch = save?.ranching;
  if (!ranch?.land) return null;
  const now = options.now ?? Date.now();
  const savedAt = save.header?.timestamp ?? now;
  const effects = options.bonuses ?? gd.playerBonuses ?? [];
  const blocked = new Set(ranch.blockedTreats ?? []);
  const contribs = new Map(); // item -> [{ q, p }]
  const food = new Map();
  const treats = new Map();
  let xp = 0;
  let animals = 0;
  let variantGuess = false;
  const add = (map, item, n) => map.set(item, (map.get(item) ?? 0) + n);
  const enclosures = [];
  // The food timer is the component's own, so its interval only takes bonuses that name no species.
  const general = bonusSum(effects, null);
  const foodMs = Math.max(1, Math.floor((HOUR_MS + general('FlatFoodConsumptionterval', 'FlatFoodConsumptionInterval')) * (1 + general('PercentFoodConsumptionInterval'))));
  const order = ranch.landOrder?.length ? ranch.landOrder : ranch.land.map((l) => l.id);
  const lands = [...ranch.land].sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));

  for (const land of lands) {
    const e = land.enclosure;
    if (!land.purchased || !e) continue;
    const known = gd.raw?.ranchingEnclosures?.[e.id];
    const out = { land: land.id, landName: humanize(land.id), id: e.id, name: known?.name ?? humanize(e.id), limit: known?.limit ?? null, maintenance: e.maintenance, autoBuy: e.autoBuy ?? [], upgrades: e.upgrades ?? [], animals: [], attention: [] };
    const minuteMs = e.minuteTimerMs ?? MINUTE_MS;
    for (const a of e.animals) {
      const method = gd.methodByKey?.get(`Ranching/${a.species}`) ?? null;
      const sum = bonusSum(effects, a.species);
      const v = variantInfo(gd, a.species, a);
      if (!v.known && !v.child && !/Adult$/.test(a.variant)) variantGuess = true;
      const safety = e.maintenance;
      const happiness = Math.max(0, a.hunger * 0.3 + (safety >= 0.75 ? 1 : safety) * 0.3 + a.satisfaction * 0.4 - (a.sick ? 0.3 : 0) + sum('FlatHappiness'));
      const working = a.hunger > 0 && safety > 0;
      const doubling = Math.min(1, Math.max(0, sum('DoublingChance')));
      const products = !method || !working ? [] : method.products.map((p) => ({ item: p.item, qty: Math.max(0, (p.qty + sum('FlatProductQuantity')) * (1 + sum('PercentProductQuantity') + v.product)) * happiness }));
      for (const p of products) (contribs.get(p.item) ?? contribs.set(p.item, []).get(p.item)).push({ q: p.qty, p: doubling });
      const animalXp = method ? (method.xp + sum('FlatXPGained')) * (1 + sum('PercentXPGained') + v.xp) * happiness : 0;
      xp += animalXp;
      const keep = Math.min(1, Math.max(0, sum('FoodPreservationChance')));
      for (const x of method?.eats ?? []) add(food, x.item, x.qty * (1 - keep) * (HOUR_MS / foodMs));
      for (const t of method?.treats ?? []) if (!blocked.has(localId(t.item))) add(treats, t.item, t.qty * (24 * HOUR_MS / TREAT_MS));
      const lifeMinutes = method?.lifespanHours ? Math.floor((method.lifespanHours * HOUR_MS * (1 + sum('PercentLifespanInterval'))) / MINUTE_MS) : null;
      const untilMs = (minutes) => (minutes > 0 ? minuteMs + (Math.ceil(minutes) - 1) * MINUTE_MS : 0);
      out.animals.push({
        species: a.species,
        method,
        name: method?.name ?? humanize(a.species),
        variant: a.variant,
        variantName: v.name,
        child: v.child,
        sick: a.sick,
        hunger: a.hunger,
        safety,
        satisfaction: a.satisfaction,
        happiness,
        working,
        wantsPets: !!(method?.requiresPets && a.wantsPets),
        deathAt: savedAt + untilMs(a.lifespanMinutes),
        lifeLeft: lifeMinutes ? Math.max(0, Math.min(1, a.lifespanMinutes / lifeMinutes)) : null,
        adultAt: v.child ? savedAt + untilMs(a.variantMinutes) : null,
        products,
        xp: animalXp,
      });
      animals++;
    }
    out.attention = enclosureAttention(gd, out, now);
    out.births = breeding(gd, out, effects);
    enclosures.push(out);
  }

  const bank = save.bank?.items ?? {};
  const products = [...contribs].map(([item, list]) => {
    const h = hourlyProduct(list);
    return { item, perHour: h.expected, guaranteed: h.guaranteed, unrounded: h.unrounded, lost: Math.max(0, h.unrounded - h.expected) };
  }).filter((p) => p.unrounded > 0).sort((a, b) => b.perHour * gd.itemValue(b.item) - a.perHour * gd.itemValue(a.item) || b.perHour - a.perHour);
  const foodList = [...food].map(([item, perHour]) => ({ item, perHour, have: bank[item] ?? 0, hoursLeft: perHour > 0 ? (bank[item] ?? 0) / perHour : Infinity }));
  const productAt = ranch.timers?.product != null ? savedAt + ranch.timers.product : null;
  return {
    enclosures,
    animals,
    hourly: { products, xp, food: foodList, treats: [...treats].map(([item, perDay]) => ({ item, perDay, have: bank[item] ?? 0 })) },
    attention: enclosures.flatMap((e) => e.attention),
    // Every species' breeding, enclosure by enclosure; perHour is the chance of a baby each hour.
    births: enclosures.flatMap((e) => e.births.map((b) => ({ ...b, land: e.land, landName: e.landName, enclosure: e.name }))),
    nextProductsAt: productAt,
    variantGuess,
  };
}

/**
 * Babies in one enclosure (built by ranchModel), one entry per species living there: { species, name,
 * count, eligible (at 75% happiness or more), happiness (their average), perHour (chance of a baby each
 * hour, 0 when it can't happen), everyHours, reason, blockedBy (a species the game checks first and
 * stops at), child: { hours, products } }.
 * reason, when no baby can come: 'small' (the enclosure holds 2, so 2 of a kind already fill it),
 * 'few' (fewer than 2), 'full' (this species alone fills the enclosure), 'skipped' (the game stops at
 * blockedBy, a species it checks first), 'unhappy' (none at 75%), 'room' (it rolls, but the enclosure
 * is full).
 * child: what a newborn makes each hour (half, at its parents' happiness) until it grows up.
 */
function breeding(gd, e, effects) {
  if (!e.limit) return [];
  const order = gd.raw?.ranchingEnclosures?.[e.id]?.animals ?? [...new Set(e.animals.map((a) => a.species))];
  const room = e.animals.length < e.limit;
  const out = [];
  let stop = null;
  for (const species of order) {
    const herd = e.animals.filter((a) => a.species === species);
    const fails = herd.length < 2 || herd.length >= e.limit;
    if (herd.length) {
      const eligible = herd.filter((a) => a.happiness >= BREED_HAPPINESS).length;
      const happiness = herd.reduce((s, a) => s + a.happiness, 0) / herd.length;
      const chance = BREED_CHANCE * eligible * happiness;
      // Its own shortfall first: that's what to fix even when an earlier species stops the check.
      const reason = e.limit <= 2 ? 'small' : herd.length < 2 ? 'few' : fails ? 'full' : stop ? 'skipped' : !(chance > 0) ? 'unhappy' : !room ? 'room' : null;
      const perHour = reason ? 0 : chance;
      out.push({ species, name: herd[0].name, count: herd.length, eligible, happiness, perHour, everyHours: perHour > 0 ? 1 / perHour : Infinity, reason, blockedBy: stop, child: childOutput(gd, herd[0].method, species, happiness, effects) });
    }
    if (!stop && fails) stop = species;
  }
  return out;
}

// A newborn: the base variant (half products) until its grow-up minutes, floor((base + flat) × (1 +
// percent)) in whole minutes (RanchingActionStats.BaseVariantInterval, ActiveRanchingAnimal.Init).
function childOutput(gd, method, species, happiness, effects) {
  if (!method) return null;
  const sum = bonusSum(effects, species);
  const ms = Math.floor(((method.childHours ?? 0) * HOUR_MS + sum('FlatBaseVariantInterval')) * (1 + sum('PercentBaseVariantInterval')));
  const half = gd.raw?.ranchingVariants?.[`${species}Child`]?.productPercent ?? -0.5;
  const products = (method.products ?? []).map((p) => ({ item: p.item, perHour: Math.max(0, (p.qty + sum('FlatProductQuantity')) * (1 + sum('PercentProductQuantity') + half)) * happiness }));
  return { hours: Math.floor(ms / MINUTE_MS) / 60, products };
}

const localId = (id) => String(id ?? '').split(':').pop();

// What needs looking after in one enclosure, worst first. kind: hungry, sick, old, repair, pets, empty.
function enclosureAttention(gd, e, now) {
  const items = [];
  const where = `${e.landName} (${e.name})`;
  // "2 animals are hungry (Cow, Sheep)": species names only, since the data has no plurals.
  const count = (list, verb) => `${list.length} ${list.length === 1 ? `animal ${verb[0]}` : `animals ${verb[1]}`}`;
  const which = (list) => `(${[...new Set(list.map((a) => a.name))].join(', ')})`;
  if (!e.animals.length) items.push({ kind: 'empty', severity: 'info', land: e.land, text: `${where} has no animals.` });
  const hungry = e.animals.filter((a) => a.hunger < 1);
  if (hungry.length) {
    const eats = [...new Set(hungry.flatMap((a) => (a.method?.eats ?? []).map((x) => gd.itemName(x.item))))];
    const starving = hungry.some((a) => a.hunger <= 0);
    items.push({ kind: 'hungry', severity: 'bad', land: e.land, count: hungry.length, text: `${where}: ${count(hungry, ['is', 'are'])} hungry ${which(hungry)}.${eats.length ? ` Put ${eats.join(' or ')} in the bank.` : ''}${starving ? ' Starving animals make nothing.' : ''}` });
  }
  const sick = e.animals.filter((a) => a.sick);
  if (sick.length) items.push({ kind: 'sick', severity: 'bad', land: e.land, count: sick.length, text: `${where}: ${count(sick, ['is', 'are'])} sick ${which(sick)}. Cure ${sick.length === 1 ? 'it' : 'them'} in the game.` });
  const old = e.animals.filter((a) => a.deathAt - now <= OLD_MS).sort((a, b) => a.deathAt - b.deathAt);
  if (old.length) {
    const replaced = old.every((a) => e.autoBuy.includes(a.species));
    items.push({ kind: 'old', severity: replaced ? 'info' : 'warn', land: e.land, count: old.length, at: old[0].deathAt, replaced, text: `${where}: ${count(old, ['is', 'are'])} close to dying of old age ${which(old)}.${replaced ? ' Auto-buy will replace them.' : ''}` });
  }
  if (e.animals.length && e.maintenance < 0.75) items.push({ kind: 'repair', severity: e.maintenance < 0.5 ? 'bad' : 'warn', land: e.land, text: `${where} is at ${Math.round(e.maintenance * 100)}% upkeep: repair it to keep the animals safe.` });
  const pets = e.animals.filter((a) => a.wantsPets);
  if (pets.length) items.push({ kind: 'pets', severity: 'info', land: e.land, count: pets.length, text: `${where}: ${count(pets, ['wants', 'want'])} petting ${which(pets)}.` });
  return items;
}
