// The Grain Mill from the save: what it's making, how much an hour, how long its storage lasts and how
// full it is. Isomorphic. The rules are the game's (0.11.4, FarmingGrainMillComponent and GrainMillStats):
//   While switched on, every interval it takes one batch of the selected recipe's ingredients from its
//   own storage (not the bank) and puts the product in the bank. When the storage can't pay for the next
//   batch it switches itself off.
//   Interval: floor((300 s + flat) × (1 + percent)). Product: max(1, trunc((qty + flat) × (1 + percent))).
//   Each ingredient: max(1, trunc(qty × (1 + percent cost))). The mill has doubling and preservation
//   stats, but the timer never rolls them, so they're left out.
//   Storage: up to 6,000 of each crop, plus storage upgrades (GrainMillInventory FlatMaxStackQuantity).

const HOUR_MS = 3_600_000;

// The mill's own bonuses (shop upgrades), plus the global action-time ones its interval takes.
function bonusSum(effects, recipeId) {
  return (stats, stat) => effects
    .filter((e) => e.stats === stats && e.stat === stat && Object.entries(e.scope ?? {}).every(([k, v]) => k === 'Recipe' && v === recipeId))
    .reduce((s, e) => s + e.value, 0);
}

/** One recipe's batch and hourly rates with your bonuses (default gd.playerBonuses). */
export function millRecipeRates(gd, recipe, bonuses = gd.playerBonuses ?? []) {
  const mill = gd.raw.grainMill;
  const sum = bonusSum(bonuses, recipe.id);
  const flat = sum('GrainMill', 'FlatInterval') + sum('Global', 'FlatActionInterval');
  const pct = sum('GrainMill', 'PercentInterval') + sum('Global', 'PercentActionInterval');
  const intervalMs = Math.max(1, Math.floor((mill.baseIntervalMs + flat) * (1 + pct)));
  const batchesPerHour = HOUR_MS / intervalMs;
  const product = { item: recipe.product.item, qty: Math.max(1, Math.trunc((recipe.product.qty + sum('GrainMill', 'FlatProductQuantity')) * (1 + sum('GrainMill', 'PercentProductQuantity')))) };
  const cost = sum('GrainMill', 'PercentIngredientCost');
  const ingredients = recipe.ingredients.map((i) => ({ item: i.item, qty: Math.max(1, Math.trunc(i.qty * (1 + cost))) }));
  return {
    recipe,
    intervalMs,
    batchesPerHour,
    product,
    ingredients,
    perHour: product.qty * batchesPerHour,
    inputsPerHour: ingredients.map((i) => ({ item: i.item, perHour: i.qty * batchesPerHour })),
  };
}

// Batches a store of crops pays for.
const batchesFrom = (rates, has) => Math.min(...rates.ingredients.map((i) => Math.floor((has(i.item) ?? 0) / i.qty)));

/**
 * The mill in the save, or null without one. options.bonuses defaults to gd.playerBonuses; options.ranch
 * (ranchModel) adds how much of the ranch's food the mill covers.
 * reason (when it isn't running): 'locked' (not bought), 'none' (no recipe picked), 'empty' (storage
 * can't pay for a batch), 'off' (switched off with enough in storage).
 */
export function grainMillModel(gd, save, options = {}) {
  const mill = gd.raw?.grainMill;
  const s = save?.grainMill;
  if (!mill || !s) return null;
  const bonuses = options.bonuses ?? gd.playerBonuses ?? [];
  const savedAt = save.header?.timestamp ?? Date.now();
  const bank = save.bank?.items ?? {};
  const owned = (mill.requires ?? []).filter((r) => r.type === 'purchase').every((r) => (save.shopPurchases?.[r.id] ?? 0) > 0);
  const capacity = Math.max(1, mill.baseStorage + bonusSum(bonuses, null)('GrainMillInventory', 'FlatMaxStackQuantity'));
  const recipe = mill.recipes.find((r) => r.id === s.recipe) ?? null;
  const rates = recipe ? millRecipeRates(gd, recipe, bonuses) : null;
  const uses = new Set(rates?.ingredients.map((i) => i.item) ?? []);
  const storage = mill.storageItems.map((item) => ({ item, qty: s.storage[item] ?? 0, capacity, share: Math.min(1, (s.storage[item] ?? 0) / capacity), bank: bank[item] ?? 0, used: uses.has(item) }));
  const running = s.active && s.timer?.state === 'running';
  const batches = rates ? batchesFrom(rates, (item) => s.storage[item]) : 0;
  // A batch is paid for when the timer fires, so the storage lasts until the last batch it can pay for.
  const nextAt = running ? savedAt + (s.timer.msLeft ?? 0) : null;
  const stopsAt = running ? nextAt + Math.max(0, batches - 1) * rates.intervalMs : null;
  // Topped up from the bank (each crop up to the storage limit): how many batches that would be.
  const filled = rates ? batchesFrom(rates, (item) => Math.min(capacity, (s.storage[item] ?? 0) + (bank[item] ?? 0))) : 0;
  const reason = running ? null : !owned ? 'locked' : !recipe ? 'none' : batches < 1 ? 'empty' : 'off';
  // Ranch food the mill makes: how much of the herd's need it covers while it runs.
  const feeds = rates ? (options.ranch?.hourly?.food ?? []).filter((f) => f.item === rates.product.item && f.perHour > 0).map((f) => ({ item: f.item, eats: f.perHour, makes: rates.perHour, covers: rates.perHour / f.perHour })) : [];
  return {
    name: mill.name,
    owned,
    recipe,
    rates,
    running,
    reason,
    batches,
    nextAt,
    stopsAt,
    hoursLeft: running ? Math.max(0, stopsAt - (options.now ?? Date.now())) / HOUR_MS : 0,
    capacity,
    storage,
    topUp: rates ? { batches: filled, hours: (filled * rates.intervalMs) / HOUR_MS } : null,
    feeds,
  };
}
