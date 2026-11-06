#!/usr/bin/env node
// Builds data/companion-data.json from a Melvor Idle 2 data package.
//
//   node tools/build-data.js [path/to/package.json] [--out file] [--include-locked] [--level-cap N]
//
// Extract a package from an installed game first with tools/extract-game-data.js; with no path this
// builds from what it extracts, data/source/MelvorBase.json.
//
// By default everything gated behind the DemoLocked condition is dropped, along with
// any item that only locked content references, so the companion never shows
// unreleased content. Re-run this whenever the game's data package changes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Values that live in game code rather than the data package. Re-check these when the game updates.
const MECHANICS = {
  levelCap: 60, // demo build: ExperienceComponent new BaseExperience(table, 60); see --level-cap
  thievingStunMs: 2000, // ThievingActionComponent.BaseStunInterval
  xpTable: { scaling: 0.25, exponentScaling: 300, base: Math.pow(2, 1 / 7) }, // StandardExperienceTable.Default
  offlineCapHours: 24, // OfflineProgressComponent.BaseMaxOfflineTime
  cookingSuccessConstant: 69, // CookingActionStats.GetSuccessChance
  thievingSuccessConstant: 100, // ThievingActionStats.GetSuccessChance
};

// Combat timings from code: CombatActionComponent.BaseSpawnInterval.
MECHANICS.enemySpawnMs = 3000;

const COMBAT_SKILLS = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer']);
const LOCK_FIELDS = ['Requirements', 'DisplayRequirements', 'UnlockRequirements', 'AccessRequirements'];

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const includeLocked = args.includes('--include-locked');
const capIndex = args.indexOf('--level-cap');
const optionValues = new Set([outIndex, capIndex].filter((i) => i >= 0).map((i) => i + 1));
const positional = args.filter((a, i) => !a.startsWith('--') && !optionValues.has(i));
const packagePath = resolve(positional[0] ?? resolve(HERE, '../data/source/MelvorBase.json'));
const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] : resolve(HERE, '../data/companion-data.json'));

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const NS = typeof pkg.Namespace === 'string' ? pkg.Namespace : (pkg.Namespace?.Id ?? 'MelvorBase');
const O = pkg.Objects ?? {};
const EC = pkg.EntityConfig ?? {};

// Skill level cap from ExperienceComponent's constructor: 60 in the demo, 120 in the Playtest. Override with --level-cap.
const lockedObjects = JSON.stringify(O).split(':DemoLocked').length - 1;
MECHANICS.levelCap = capIndex >= 0 ? Number(args[capIndex + 1]) : lockedObjects > 50 ? 60 : 120;

const full = (id) => (id == null ? id : String(id).includes(':') ? String(id) : `${NS}:${id}`);
const local = (id) => (id == null ? id : String(id).split(':').pop());
const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();

function isLocked(o) {
  if (includeLocked || !o) return false;
  for (const field of LOCK_FIELDS) {
    if (o[field] && JSON.stringify(o[field]).includes(':DemoLocked')) return true;
  }
  return JSON.stringify(o).includes('DemoPlaceholderItem');
}

// Display names for every object, by full id. Items take priority over everything else.
const names = new Map();
for (const [registry, list] of Object.entries(O)) {
  if (!Array.isArray(list) || registry === 'Item') continue;
  for (const o of list) {
    if (o?.Id && typeof o.DisplayName === 'string' && !names.has(full(o.Id))) names.set(full(o.Id), o.DisplayName);
  }
}
// Item names are { Singular, Plural }; everything else is a plain string.
const singular = (dn, id) => (typeof dn === 'string' ? dn : dn?.Singular ?? humanize(local(id)));
const plural = (dn, id) => (typeof dn === 'string' ? dn : dn?.Plural ?? singular(dn, id));
for (const it of O.Item ?? []) names.set(full(it.Id), singular(it.DisplayName, it.Id));
const nameOf = (id) => (id == null ? null : names.get(full(id)) ?? humanize(local(id)));

const itemIds = new Set((O.Item ?? []).map((it) => full(it.Id)));

function findItemRefs(node, out = []) {
  if (typeof node === 'string') {
    if (itemIds.has(node)) out.push(node);
  } else if (Array.isArray(node)) {
    for (const x of node) findItemRefs(x, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) findItemRefs(v, out);
  }
  return out;
}

// The display name of an object in one registry, for requirement labels.
const displayOf = (registry, id) => {
  const x = (O[registry] ?? []).find((o) => full(o.Id) === full(id));
  return x ? singular(x.DisplayName, x.Id) : humanize(local(id));
};

// Statistic requirements (DictionaryStatisticCondition): the save's count for one object reaches a
// value, e.g. 1,000 of a potion brewed (HerbloreItemGained) or a dungeon finished 10 times.
// Data names the object under one of these keys; the registries give its display name.
const STAT_TARGETS = {
  Item: ['Item'], Enemy: ['Enemy'], Dungeon: ['Dungeon'], Master: ['SlayerMaster'], Course: ['AgilityCourse'], Species: ['HuntingAnimalSpecies'],
  Animal: ['HuntingAnimal', 'RanchingAnimal'], Event: ['AstrologyObservationEvent', 'AstrologyBonusesEvent', 'AstrologyItemEvent', 'AstrologyTableEvent'],
};
const STAT_VERBS = {
  HerbloreItemGained: 'Brew', BankItemFound: 'Find', FiremakingItemSpent: 'Burn', WoodcuttingItemGained: 'Cut', FishingItemGained: 'Catch', MiningItemGained: 'Mine',
  CookingItemGained: 'Cook', SmithingItemGained: 'Smith', CraftingItemGained: 'Craft', FletchingItemGained: 'Fletch', RunecraftingItemGained: 'Craft',
  HuntingAnimalTrapped: 'Trap', HuntingAnimalSpeciesTrapped: 'Trap', CombatEnemyKilled: 'Kill',
};
const reqCount = (n) => n.toLocaleString('en-US');
const reqTimes = (n) => `${reqCount(n)} time${n === 1 ? '' : 's'}`;
const STAT_LABELS = {
  CombatDungeonCompleted: (n, name) => `Finish ${name} ${reqTimes(n)}`,
  AgilityCourseCompleted: (n, name) => `Complete ${name} ${reqTimes(n)}`,
  SlayerMasterTasksCompleted: (n, name) => `Complete ${reqCount(n)} ${name} slayer task${n === 1 ? '' : 's'}`,
  EnemyTasksCompleted: (n, name) => `Complete ${reqCount(n)} ${name} slayer task${n === 1 ? '' : 's'}`,
  AstrologyTimesEventObserved: (n, name) => `Observe ${name} in Astrology${n === 1 ? '' : ` ${reqTimes(n)}`}`,
};
function statReq(data) {
  const key = Object.keys(STAT_TARGETS).find((k) => data[k]);
  if (!data.Statistic || !key) return null;
  const stat = local(data.Statistic);
  const n = data.Value ?? 1;
  const target = STAT_TARGETS[key].map((reg) => (O[reg] ?? []).find((o) => full(o.Id) === full(data[key]))).find(Boolean);
  const one = target ? singular(target.DisplayName, target.Id) : humanize(local(data[key]));
  const many = target ? plural(target.DisplayName, target.Id) : one;
  const label = STAT_LABELS[stat]?.(n, one) ?? (STAT_VERBS[stat] ? `${STAT_VERBS[stat]} ${n === 1 ? one : `${reqCount(n)} ${many}`}` : `${humanize(stat)}: ${reqCount(n)} ${many}`);
  return { type: 'stat', stat, id: local(data[key]), value: n, label };
}

function normReqs(list) {
  const out = [];
  for (const cond of list ?? []) {
    const type = local(cond?.Type);
    const data = cond?.Data ?? {};
    if (type === 'Level') {
      out.push({ type: 'level', skill: local(data.Component?.Entity), level: data.Level ?? 1 });
    } else if (type === 'DemoLocked') {
      out.push({ type: 'locked', label: 'Not available in the demo' });
    } else if (type === 'ShopPurchase') {
      out.push({ type: 'purchase', id: local(data.ShopPurchase), label: `Buy ${nameOf(data.ShopPurchase)}` });
    } else if (type === 'MasteryGuildRank' && data.Rank) {
      const rank = (O.MasteryGuildRank ?? []).find((r) => full(r.Id) === full(data.Rank));
      out.push({ type: 'masteryRank', skill: local(data.Component?.Entity), rank: local(data.Rank), label: `Reach ${rank?.DisplayName ?? humanize(local(data.Rank))} in the Mastery Guild` });
    } else if (type === 'EnemyStatistic' && local(data.Statistic) === 'CombatEnemyKilled' && data.Enemy) {
      out.push({ type: 'kills', enemy: local(data.Enemy), count: data.Value ?? 1, label: `Kill ${data.Value ?? 1} ${displayOf('Enemy', data.Enemy)}` });
    } else if (/Statistic$|^HuntingAnimalSpecies$/.test(type) && statReq(data)) {
      out.push(statReq(data));
    } else if (type === 'AgilityTechniqueLevel' && data.Technique) {
      out.push({ type: 'technique', technique: local(data.Technique), level: data.Level ?? 1, label: `${displayOf('AgilityTechnique', data.Technique)} technique ${data.Level ?? 1}` });
    } else if (type === 'AgilityNumTechniquesLevel') {
      // AgilityNumTechniquesLevelCondition: at least NumTechniques techniques at Level or higher.
      const count = data.NumTechniques ?? 1;
      const level = data.Level ?? 1;
      out.push({ type: 'techniques', count, level, label: `${count} Agility technique${count === 1 ? '' : 's'} at level ${level}` });
    } else if (type === 'QuestComplete' && data.Quest) {
      const quest = (O.Quest ?? []).find((q) => full(q.Id) === full(data.Quest));
      out.push({ type: 'quest', quest: local(data.Quest), label: `Finish the quest ${quest?.DisplayName ?? humanize(local(data.Quest))}` });
    } else if (type === 'QuestStepComplete' && data.Quest) {
      // Step is the step's place in the quest (QuestStepCompleteCondition: ActiveSteps[Step]).
      const quest = (O.Quest ?? []).find((q) => full(q.Id) === full(data.Quest));
      const step = data.Step ?? 0;
      out.push({ type: 'questStep', quest: local(data.Quest), step, label: `Finish step ${step + 1} of the quest ${quest?.DisplayName ?? humanize(local(data.Quest))}` });
    } else if (type === 'AstrologyMajorNodeUnlocked' && data.MajorNode) {
      const node = (O.AstrologyNode ?? []).find((n) => full(n.Id) === full(data.MajorNode));
      const star = (O.AstrologyConstellation ?? []).find((c) => JSON.stringify(c).includes(`"${data.MajorNode}"`));
      out.push({ type: 'astrologyNode', node: local(data.MajorNode), label: `Unlock ${star?.DisplayName ?? 'its'} ${node?.DisplayName ?? 'major node'} in Astrology` });
    } else if (type === 'ToolbeltItemEquipped' && data.Item) {
      // An item in a skill's toolbelt. ConditionGroup joins an IsOr condition with the one before it.
      const tool = { item: full(data.Item), skill: local(data.Component?.Entity) };
      const prev = out.at(-1);
      if (cond.IsOr || data.IsOr) {
        if (prev?.type === 'tool') prev.anyOf.push(tool);
        else out.push({ type: 'tool', anyOf: [tool] });
      } else {
        out.push({ type: 'tool', anyOf: [tool] });
      }
    } else {
      const items = [...new Set(findItemRefs(data))].map(nameOf);
      const what = humanize(type);
      const label = type === 'ToolbeltItemEquipped' && items.length ? `${items.join(', ')} equipped` : items.length ? `${what}: ${items.join(', ')}` : what;
      out.push({ type: 'other', kind: type, label });
    }
  }
  return out;
}

// Splits requirements into the method's own skill level and everything else.
function splitReqs(skill, reqs, fallbackLevel) {
  const own = reqs.filter((r) => r.type === 'level' && r.skill === skill).map((r) => r.level);
  const level = own.length ? Math.max(...own) : (fallbackLevel ?? 1);
  const requires = reqs.filter((r) => !(r.type === 'level' && r.skill === skill));
  return { level, requires };
}

// res:// path of an object's picture; tools/extract-icons.js turns these into bundled files.
const imagePath = (o) => [o?.Icon, o?.Media, o?.Sprite].find((x) => typeof x === 'string' && x.startsWith('res://')) ?? null;
const qty = (x) => x?.Quantity ?? 1;
const itemQty = (list) => (list ?? []).map((x) => ({ item: full(x.Item), qty: qty(x) }));
const chanceItems = (list) => (list ?? []).map((x) => ({ item: full(x.Item), qty: qty(x), chance: x.Chance ?? 1 }));
const currencyQty = (list) => (list ?? []).map((c) => ({ currency: local(c.Currency), qty: qty(c) }));
const table = (list) =>
  (list ?? []).map((x) => ({
    item: full(x.Item),
    min: x.MinQuantity ?? x.Quantity ?? 1,
    max: x.MaxQuantity ?? x.Quantity ?? 1,
    ...(x.Weight != null ? { weight: x.Weight } : {}),
    ...(x.Chance != null ? { chance: x.Chance } : {}),
  }));

// Toolbelt items some actions use up (ToolbeltCapability.ConsumesOn): a lockpick per chest attempt,
// a sightings log per hit on its rock. Marks each tool in a method's requirements with how it's used.
const itemById = new Map((O.Item ?? []).map((it) => [full(it.Id), it]));
function markConsumedTools(requires, kind, r) {
  for (const req of requires) {
    if (req.type !== 'tool') continue;
    for (const tool of req.anyOf) {
      const caps = itemById.get(tool.item)?.Capabilities ?? {};
      const toolbelt = caps[Object.keys(caps).find((k) => local(k) === 'Toolbelt')];
      for (const t of toolbelt?.ConsumesOn ?? []) {
        const d = t.Data ?? {};
        const forThis = (!d.Recipe || local(d.Recipe) === r.Id) && (!d.RecipeType || local(d.RecipeType) === local(r.RecipeType));
        if (!forThis || d.Chance != null) continue;
        if (local(t.Type) === 'ThievingActionPerformed' && kind === 'thieving') tool.usedPer = 'action';
        if (local(t.Type) === 'MiningMineRock' && kind === 'mining') tool.usedPer = 'hit';
      }
    }
  }
  return requires;
}

// A crafting skill stops when the recipe's category requirements aren't met
// (CategorizedCraftingActionComponent.HandleRecipeRequirements), and a locked Farming category can't
// be opened (BaseCategoryButton): Astral Jewellery needs an Astrology node, super potions need Super
// Potion Research, the Mill Farm needs the Grain Mill.
const CATEGORY_REGISTRY_BY_KIND = { artisan: 'RecipeCategory', cooking: 'RecipeCategory', firemaking: 'RecipeCategory', farming: 'FarmingCategory' };
function categoryReqs(kind, r) {
  const c = r.Category ? (O[CATEGORY_REGISTRY_BY_KIND[kind]] ?? []).find((x) => full(x.Id) === full(r.Category)) : null;
  return c ? [...normReqs(c.Requirements), ...normReqs(c.DisplayRequirements)] : [];
}

function base(kind, skill, r, fallbackLevel, extraReqs = []) {
  const seen = new Set();
  const reqs = [...extraReqs, ...normReqs(r.Requirements), ...categoryReqs(kind, r)].filter((q) => {
    const key = JSON.stringify(q);
    return !seen.has(key) && seen.add(key);
  });
  const { level, requires } = splitReqs(skill, reqs, fallbackLevel);
  markConsumedTools(requires, kind, r);
  return {
    key: `${skill}/${r.Id}`,
    kind,
    skill,
    id: r.Id,
    name: r.DisplayName,
    icon: imagePath(r),
    category: r.Category ? nameOf(r.Category) : null,
    level,
    requires,
    xp: r.BaseExperience ?? 0,
  };
}

// Quest objectives (e.g. Canyon Support for Rocky Rumble): only shown while a quest step is active.
const isQuestOnly = (r) => /Quest/i.test(String(r.Category ?? '')) || /QuestStepActive/.test(JSON.stringify([r.Requirements, r.DisplayRequirements]));
const methods = [];
const skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);

for (const r of O.WoodcuttingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({
    ...base('woodcutting', 'Woodcutting', r, r.Level),
    interval: r.BaseInterval,
    maxHealth: r.BaseMaxHealth ?? 1,
    product: { item: full(r.Product?.Item), qty: qty(r.Product) },
    perHit: chanceItems(r.RandomProductsPerHit),
    perCut: chanceItems(r.RandomProductsPerCut),
  });
}

for (const r of O.MiningRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({
    ...base('mining', 'Mining', r),
    interval: r.BaseInterval,
    breakChance: r.BaseProductChance ?? 1,
    product: { item: full(r.Product?.Item), qty: qty(r.Product) },
    perHit: chanceItems(r.RandomProductsPerHit),
    // Some pickaxes can turn a mined ore straight into its bar (MiningActionComponent).
    ...(r.BarItem ? { bar: full(r.BarItem) } : {}),
  });
}

for (const r of O.FishingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({
    ...base('fishing', 'Fishing', r),
    category: r.Location ? nameOf(r.Location) : null,
    minInterval: r.BaseMinInterval,
    maxInterval: r.BaseMaxInterval,
    fishChance: r.FishChance ?? 1,
    junk: r.JunkItem ? full(r.JunkItem) : null,
    products: table(r.RandomProducts),
    special: chanceItems(r.SpecialProducts),
  });
}

// A thieving target sits in a location (its Category) whose own requirements apply too,
// e.g. the Mage Tower needs a Fire Wizard hat and robes in the thieving toolbelt.
const thievingLocations = new Map((O.ThievingLocation ?? []).map((l) => [full(l.Id), l]));
for (const r of O.ThievingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  const location = thievingLocations.get(full(r.Category));
  if (location && (isLocked(location) || isQuestOnly(location))) { skip(isLocked(location) ? 'locked' : 'quest objective'); continue; }
  const c = r.CurrencyReward ?? {};
  methods.push({
    ...base('thieving', 'Thieving', r, undefined, [...normReqs(location?.Requirements), ...normReqs(r.AccessRequirements)]),
    type: humanize(local(r.RecipeType)),
    interval: r.BaseInterval,
    stages: Math.max(1, r.Stages ?? 1),
    damage: r.Damage ?? 0,
    perception: r.Perception ?? 0,
    currencyChance: r.BaseCurrencyLootChance ?? 0,
    currency: { currency: local(c.Currency ?? 'GoldPieces'), min: c.MinQuantity ?? 0, max: c.MaxQuantity ?? 0 },
    commonChance: r.BaseCommonLootChance ?? 0,
    common: table(r.CommonDropTable),
    rareChance: r.BaseRareLootChance ?? 0,
    rare: table(r.RareDropTable),
    completion: table(r.CompletionDropTable),
  });
}

// Artisan recipes are shared by several skills; the level requirement names the skill,
// with the entity config's recipe list as a fallback.
const artisanSkillByRecipe = new Map();
for (const [entity, cfg] of Object.entries(EC)) {
  for (const r of cfg?.Recipes ?? []) if (r?.Id) artisanSkillByRecipe.set(full(r.Id), local(entity));
}
const artisanRecipeIds = new Set((O.ArtisanRecipe ?? []).map((r) => full(r.Id)));
for (const [id, skill] of [...artisanSkillByRecipe]) if (!artisanRecipeIds.has(id)) artisanSkillByRecipe.delete(id);

function artisanSkill(r) {
  const req = normReqs(r.Requirements).find((x) => x.type === 'level');
  return req?.skill ?? artisanSkillByRecipe.get(full(r.Id)) ?? null;
}

for (const r of O.ArtisanRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  const skill = artisanSkill(r);
  if (!skill) { skip('artisan recipe with no skill'); continue; }
  methods.push({
    ...base('artisan', skill, r),
    ...(r.Subcategory ? { subcategory: nameOf(r.Subcategory) } : {}),
    interval: r.BaseInterval,
    steps: Math.max(1, r.Steps ?? 1),
    ingredients: itemQty(r.Ingredients?.Items),
    currencyCosts: currencyQty(r.Ingredients?.Currencies),
    products: chanceItems(r.Products),
  });
}

for (const r of O.CookingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({
    ...base('cooking', 'Cooking', r),
    interval: r.BaseInterval,
    steps: Math.max(1, r.Steps ?? 1),
    difficulty: r.Difficulty ?? 0,
    ingredients: itemQty(r.Ingredients?.Items),
    currencyCosts: currencyQty(r.Ingredients?.Currencies),
    products: chanceItems(r.Products),
  });
}

for (const r of O.FiremakingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({
    ...base('firemaking', 'Firemaking', r),
    interval: r.BaseInterval,
    ingredients: itemQty(r.Ingredients?.Items),
    products: chanceItems(r.Products),
    reward: r.CurrencyReward ? { currency: local(r.CurrencyReward.Currency), qty: qty(r.CurrencyReward) } : null,
  });
}

// Farming (FarmingActionStats, ActiveFarmingPlot): a crop that regrows gives Regrows more harvests,
// each RegrowInterval apart, from one seed. Pests and disease cut the yield by whatever the plot
// isn't protected against (only in categories that attract them); watering adds 15 disease protection.
// Flowers don't harvest: they give the plots around them a bonus instead.
const farmingCategories = new Map((O.FarmingCategory ?? []).map((c) => [full(c.Id), c]));
for (const r of O.FarmingRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  const cat = farmingCategories.get(full(r.Category));
  const watering = (cat?.WateringModifierTemplate ?? []).filter((m) => m.Stat?.Name === 'FlatDiseaseProtection').reduce((s, m) => s + (m.Value ?? 0), 0);
  methods.push({
    ...base('farming', 'Farming', r),
    interval: r.BaseInterval,
    product: { item: full(r.Product?.Item), qty: qty(r.Product) },
    ingredients: itemQty(r.Ingredients?.Items),
    regrows: r.Regrows ?? 0,
    regrowInterval: r.RegrowInterval ?? 0,
    pests: cat?.AttractsPests ? (r.PestValueAdjuster ?? 0) + (cat.PestValueAdjuster ?? 0) : 0,
    disease: cat?.AttractsDisease ? (r.DiseaseValueAdjuster ?? 0) + (cat.DiseaseValueAdjuster ?? 0) : 0,
    watering: cat?.CanWater ? watering : 0,
    ...(r.BonusesWhenGrown ? { flower: true } : {}),
  });
}

// Hunting (ActiveHuntingAnimal): survey until a track is found, follow the tracks, then trap.
// Every trap attempt uses up a trap of the animal's trap type (unless preservation saves it);
// better traps add preservation and success, and their success bonus grows with each miss.
// Quest locations are left out.
const trapsByType = new Map();
for (const it of O.Item ?? []) {
  const caps = it.Capabilities ?? {};
  const key = Object.keys(caps).find((k) => local(k) === 'HuntingTrap');
  if (!key || isLocked(it)) continue;
  const c = caps[key];
  const sum = (list, stat) => (list ?? []).filter((b) => b.Stat?.Name === stat).reduce((s, b) => s + (b.Value ?? 0), 0);
  const list = trapsByType.get(full(c.TrapType)) ?? [];
  list.push({ item: full(it.Id), preservation: sum(c.TrapBonuses, 'PreservationChance'), success: sum(c.TrapBonuses, 'FlatTrappingSuccessChance'), failBonus: sum(c.FailBonuses, 'FlatTrappingSuccessChance') });
  trapsByType.set(full(c.TrapType), list);
}
const huntingLocations = new Map((O.HuntingLocation ?? []).map((l) => [full(l.Id), l]));
const huntingSpecies = new Map((O.HuntingAnimalSpecies ?? []).map((s) => [full(s.Id), s]));
for (const r of O.HuntingAnimal ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  const location = huntingLocations.get(full(r.Location));
  if (isQuestOnly(r) || !location || /^Quest/.test(location.Id)) { skip('quest objective'); continue; }
  methods.push({
    ...base('hunting', 'Hunting', r),
    category: location.DisplayName,
    surveyInterval: location.BaseSurveyInterval ?? 10_000,
    trackChance: r.BaseTrackSuccessChance ?? 1,
    trapChance: r.BaseTrapSuccessChance ?? 1,
    steps: { min: r.BaseMinTrackingSteps ?? 1, max: r.BaseMaxTrackingSteps ?? 1 },
    trackInterval: { min: r.BaseMinTrackInterval ?? 0, max: r.BaseMaxTrackInterval ?? 0 },
    trapInterval: { min: r.BaseMinTrapInterval ?? 0, max: r.BaseMaxTrapInterval ?? 0 },
    products: chanceItems(r.Products),
    trapType: r.TrapType ? nameOf(r.TrapType) : null,
    traps: r.TrapType ? trapsByType.get(full(r.TrapType)) ?? [] : [],
    // A rare species (ActiveHuntingAnimal.RollForRareSpecies) doubles the catch and can add extra drops.
    rareChance: r.BaseRareSpeciesChance ?? 0,
    rareSpecies: (r.RareSpecies ?? []).map((x) => ({ s: huntingSpecies.get(full(x.Species)), weight: x.Weight ?? 1 })).filter((x) => x.s && !isLocked(x.s))
      .map(({ s, weight }) => ({ id: s.Id, name: s.DisplayName, weight, extra: chanceItems(s.ExtraProducts) })),
  });
}

// Astrology: studying a constellation gives XP every interval.
for (const r of O.AstrologyConstellation ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  methods.push({ ...base('astrology', 'Astrology', r), interval: r.BaseInterval ?? 3000 });
}

// The level of `skill` a list of requirements asks for (1 if none).
const levelOf = (reqs, skill) => normReqs(reqs).find((q) => q.type === 'level' && q.skill === skill)?.level ?? 1;

// Herblore (HerbloreActionComponent): a batch is preparing, heating and stirring, then 10 bottlings
// in a row. Ingredients, potions and XP all come with each bottling, so it's modelled per bottling:
// a tenth of the whole batch time.
const HERBLORE_BOTTLINGS = 10;
for (const r of O.HerbloreRecipe ?? []) {
  if (isLocked(r)) { skip('locked'); continue; }
  if (isQuestOnly(r)) { skip('quest objective'); continue; }
  const batchMs = (r.BasePreparingInterval ?? 0) + (r.BaseHeatingInterval ?? 0) + (r.BaseStirringInterval ?? 0) + HERBLORE_BOTTLINGS * (r.BaseBottlingInterval ?? 0);
  methods.push({
    ...base('artisan', 'Herblore', r),
    ...(r.Subcategory ? { subcategory: nameOf(r.Subcategory) } : {}),
    interval: batchMs / HERBLORE_BOTTLINGS,
    steps: 1,
    ingredients: itemQty(r.Ingredients?.Items),
    currencyCosts: currencyQty(r.Ingredients?.Currencies),
    products: chanceItems(r.Products),
    // Each stage has its own interval bonuses (HerbloreActionStats).
    batch: { ms: batchMs, bottlings: HERBLORE_BOTTLINGS, preparing: r.BasePreparingInterval ?? 0, heating: r.BaseHeatingInterval ?? 0, stirring: r.BaseStirringInterval ?? 0, bottling: r.BaseBottlingInterval ?? 0 },
  });
}

// Agility (AgilityActionComponent): you pick a course and one of its paths, and its obstacles run in
// order. A failed obstacle costs HP and sends you back to the first one (unless a repeat chance rolls).
// XP, rewards and marks come when the whole path is done. One method per path.
const agilityObstacles = new Map((O.AgilityObstacle ?? []).map((o) => [full(o.Id), o]));
const agilityPaths = new Map((O.AgilityCoursePath ?? []).map((p) => [full(p.Id), p]));
const agilityLocations = new Map((O.AgilityLocation ?? []).map((l) => [full(l.Id), l]));
const agilityTechniques = (O.AgilityTechnique ?? []).filter((t) => !isLocked(t)).map((t) => ({
  id: t.Id,
  name: t.DisplayName,
  icon: imagePath(t),
  cap: t.LevelCap ?? 40,
  unlockLevel: levelOf(t.UnlockRequirements, 'Agility'),
  bonuses: (t.DifficultyMetBonuses ?? []).map((b) => ({ stat: b.Stat?.Name, value: b.Value ?? 0 })),
}));
const techniqueIcon = new Map(agilityTechniques.map((t) => [t.id, t.icon]));
for (const c of O.AgilityCourse ?? []) {
  if (isLocked(c)) { skip('locked'); continue; }
  const location = agilityLocations.get(full(c.Location));
  if (isQuestOnly(c) || (location && isQuestOnly(location))) { skip('quest objective'); continue; }
  const paths = (c.Paths ?? []).map((id) => agilityPaths.get(full(id))).filter(Boolean);
  for (const p of paths) {
    const obstacles = (p.Obstacles ?? []).map((id) => agilityObstacles.get(full(id))).filter(Boolean).map((o) => ({
      interval: o.BaseInterval ?? 2000,
      technique: o.Technique ? local(o.Technique) : null,
      difficulty: o.Difficulty ?? 0,
      damage: o.Damage ?? 0,
      trap: !!o.IsTrap,
    }));
    // The technique most of the path's obstacles use gets the full technique XP.
    const counts = {};
    for (const o of obstacles) if (o.technique) counts[o.technique] = (counts[o.technique] ?? 0) + 1;
    const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    methods.push({
      ...base('agility', 'Agility', { ...c, Id: p.Id, DisplayName: paths.length > 1 ? `${c.DisplayName} (${p.DisplayName})` : c.DisplayName, Category: null }, undefined, normReqs(location?.Requirements)),
      icon: (primary && techniqueIcon.get(primary)) ?? imagePath(location),
      category: location?.DisplayName ?? null,
      xp: p.BaseExperience ?? 0,
      obstacles,
      technique: primary,
      techniqueXp: c.GivesTechniqueXP === false ? 0 : p.BaseTechniqueExperience ?? 0,
      products: chanceItems(p.RandomObstacleProducts),
      entryCost: itemQty(c.EntryCost?.Items),
      entryCurrencies: currencyQty(c.EntryCost?.Currencies),
      rewards: itemQty(c.CompletionRewards?.Items),
      rewardCurrencies: currencyQty(c.CompletionRewards?.Currencies),
      timedRewards: (c.TimedCompletionRewards ?? []).length > 0,
    });
  }
}

// Ranching (RanchingPassiveComponent): animals in enclosures work by themselves, whatever else you're
// doing. Every hour each animal eats, makes its products and gives XP, scaled by how happy it is.
// It starts as a child (half products and XP) and may grow into a variant that makes twice as much.
const ranchingVariants = new Map((O.RanchingAnimalVariant ?? []).map((v) => [full(v.Id), v]));
const doublesProducts = (v) => (v?.SelfBonuses ?? []).some((b) => b.Stat?.Name === 'PercentProductQuantity' && b.Value > 0);
for (const a of O.RanchingAnimal ?? []) {
  if (isLocked(a)) { skip('locked'); continue; }
  if (isQuestOnly(a)) { skip('quest objective'); continue; }
  const weights = (a.Variants ?? []).map((v) => ({ weight: v.Weight ?? 0, bonus: doublesProducts(ranchingVariants.get(full(v.Variant))) }));
  const totalWeight = weights.reduce((s, v) => s + v.weight, 0);
  const enclosures = (O.RanchingEnclosure ?? []).filter((e) => !isLocked(e) && (e.Animals ?? []).some((x) => full(x) === full(a.Id)));
  methods.push({
    ...base('ranching', 'Ranching', { ...a, DisplayName: singular(a.DisplayName, a.Id) }),
    interval: 3_600_000,
    products: itemQty(a.Products),
    eats: itemQty(a.Eats),
    treats: (a.Treats ?? []).map((t) => ({ item: full(t.Item), qty: qty(t), satisfaction: t.Satisfaction ?? 0 })),
    lifespanHours: (a.LifespanInterval ?? 0) / 3_600_000,
    childHours: (a.BaseVariantInterval ?? 0) / 3_600_000,
    bonusVariantShare: totalWeight > 0 ? weights.filter((v) => v.bonus).reduce((s, v) => s + v.weight, 0) / totalWeight : 0,
    cost: currencyQty(a.PurchaseCosts?.Currencies),
    costItems: itemQty(a.PurchaseCosts?.Items),
    requiresPets: !!a.RequiresPets,
    perEnclosure: Math.max(0, ...enclosures.map((e) => e.AnimalLimit ?? 0)),
  });
}

// Quests: steps run in order, and so do each step's tasks. A task is done when its goals are met and
// its costs (items to hand in) are paid. Only the quests the Quests config lists exist in a game.
const questConfig = new Set((EC['MelvorBase:Quests']?.Quests ?? []).map((q) => full(q.Id)));
const questIds = (reqs) => (reqs ?? []).filter((r) => local(r.Type) === 'QuestComplete').map((r) => local(r.Data?.Quest));
// Display names for anything a quest goal points at (quest-only recipes aren't in the method list).
const anyName = new Map();
for (const list of Object.values(O)) {
  if (!Array.isArray(list)) continue;
  for (const x of list) if (x?.Id && x.DisplayName && !anyName.has(full(x.Id))) anyName.set(full(x.Id), singular(x.DisplayName, x.Id));
}
const GOAL_VERBS = {
  WoodcuttingCutTree: 'Cut', MiningMineRock: 'Mine', ArtisanCreateRecipe: 'Make', FiremakingBurnRecipe: 'Burn', FarmingPlantRecipe: 'Plant',
  HuntingTrapAnimal: 'Trap', ThievingPickpocketTarget: 'Steal from', ActionGainItem: 'Get', CombatKillEnemy: 'Kill', AstrologyObserveEvent: 'Observe',
  FishingFishRecipe: 'Catch', FarmingHarvestRecipe: 'Harvest', CookRecipe: 'Cook',
  HerbloreBrewPotionGroup: 'Brew', HerbloreBrewPotionCategory: 'Brew', ArtisanCompleteStep: 'Complete', ThievingPickpocketTargetType: 'Pickpocket',
  CombatDamageEnemy: 'Deal', CombatEvadeAttacks: 'Evade', CombatSingleHitDamage: 'Land', SpendPrayerCurrency: 'Spend',
};
function questGoal(g) {
  const d = g.Data ?? {};
  const type = local(g.Type);
  const skill = local(d.Component?.Entity);
  const recipe = d.Recipe ?? d.Animal ?? d.Target;
  const target = d.Item ?? d.Enemy ?? recipe ?? d.Event;
  return {
    id: String(d.Id ?? '0'),
    type,
    max: d.MaxProgress ?? 1,
    label: `${GOAL_VERBS[type] ?? humanize(type)} ${nameOf(d.Item) ?? anyName.get(full(target)) ?? humanize(local(target ?? ''))}`.trim(),
    ...(skill && skill !== 'Combat' ? { skill } : {}),
    ...(recipe && skill ? { method: `${skill}/${local(recipe)}` } : {}),
    ...(d.Item ? { item: full(d.Item) } : {}),
    ...(d.Enemy ? { enemy: local(d.Enemy) } : {}),
  };
}
const quests = (O.Quest ?? []).filter((q) => !isLocked(q)).map((q) => ({
  id: q.Id,
  name: q.DisplayName,
  description: q.Description ?? '',
  category: nameOf(q.Category),
  inGame: questConfig.has(full(q.Id)),
  requires: questIds(q.Requirements),
  shownAfter: questIds(q.DisplayRequirements),
  steps: (q.Steps ?? []).map((st) => ({
    id: String(st.Id),
    description: st.Description ?? '',
    tasks: (st.TasksInOrder ?? []).map((t) => ({
      id: String(t.Id),
      goals: (t.Goals ?? []).map(questGoal),
      costs: itemQty(t.Costs?.Items),
      currencyCosts: currencyQty(t.Costs?.Currencies),
    })),
  })),
  rewards: { items: itemQty(q.Rewards?.Items), currencies: currencyQty([...(q.Rewards?.Currency ?? [])]) },
}));

// Skills the companion doesn't model rates for yet: what unlocks at each level.
const unlocks = {
  Herblore: (O.HerblorePotionGroup ?? []).filter((g) => !isLocked(g)).map((g) => ({ name: g.DisplayName, level: levelOf(g.Requirements, 'Herblore'), icon: imagePath(g) })),
  Agility: (O.AgilityCourse ?? []).filter((c) => !isLocked(c) && !isQuestOnly(c)).map((c) => ({ name: c.DisplayName, level: levelOf(c.Requirements, 'Agility'), icon: imagePath(c) })),
  Ranching: (O.RanchingAnimal ?? []).filter((a) => !isLocked(a)).map((a) => ({ name: singular(a.DisplayName, a.Id), level: levelOf(a.Requirements, 'Ranching'), icon: imagePath(a) })),
};
for (const list of Object.values(unlocks)) list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

// Combat
// Only the "Normal" damage type exists so far; power/protection ratings are kept for it.
const ratingOf = (list) => (list ?? []).filter((r) => local(r.DamageType) === 'Normal').reduce((sum, r) => sum + (r.Value ?? 0), 0);
const levelRatios = (list) => (list ?? []).map((r) => ({ level: local(r.Level), ratio: r.Ratio ?? 1 }));
const enemies = [];
for (const e of O.Enemy ?? []) {
  if (isLocked(e)) { skip('locked'); continue; }
  const levels = Object.fromEntries((e.Levels ?? []).map((l) => [local(l.Key), l.Value]));
  const stats = Object.fromEntries((e.Stats?.Stats ?? []).map((s) => [local(s.Stat), s.Value]));
  const drops = e.Drops ?? {};
  enemies.push({
    id: e.Id,
    name: e.DisplayName,
    icon: imagePath(e),
    levels,
    attackInterval: stats.AttackInterval ?? null,
    stats,
    power: ratingOf(e.Stats?.PowerRatings),
    protection: ratingOf(e.Stats?.ProtectionRatings),
    element: local(e.Element) ?? 'Neutral',
    stances: (e.Stances ?? []).map((x) => ({ stance: local(x.Stance), weight: x.Weight ?? 1 })),
    attacks: (e.Attacks ?? []).map((x) => ({ attack: local(x.Attack), chance: x.Chance ?? 0 })),
    requires: normReqs(e.Requirements),
    currencies: (drops.FixedCurrencies ?? []).map((c) => ({ currency: local(c.Currency), min: c.MinQuantity ?? 0, max: c.MaxQuantity ?? 0 })),
    fixed: table(drops.FixedItems),
    tables: (drops.ItemTables ?? []).map((t) => ({ chance: t.Chance ?? 1, entries: table(t.Table) })),
    areas: [],
  });
}
const enemyById = new Map(enemies.map((e) => [e.id, e]));

const areas = [];
for (const [registry, kind] of [['CombatArea', 'area'], ['Dungeon', 'dungeon']]) {
  for (const a of O[registry] ?? []) {
    if (isLocked(a)) { skip('locked'); continue; }
    const enemyIds = (a.Enemies ?? []).map(local).filter((id) => enemyById.has(id));
    if (!enemyIds.length) continue;
    areas.push({
      id: a.Id,
      name: a.DisplayName,
      icon: imagePath(a),
      kind,
      difficulty: a.Difficulty ? humanize(local(a.Difficulty)) : null,
      category: a.Category ? nameOf(a.Category) : null,
      darkness: a.Darkness ?? 0,
      enemies: enemyIds,
      requires: normReqs(a.UnlockRequirements),
    });
    for (const id of enemyIds) enemyById.get(id).areas.push(a.Id);
  }
}

// Enemy passives (CombatPassive), in the forms the combat model uses: styles it's immune to, healing
// each turn, a ramp that stacks during the fight, damage over time and stuns it puts on you, a raised
// minimum hit and attack reflect. Anything else is listed by name only.
const passiveById = new Map((O.CombatPassive ?? []).map((p) => [full(p.Id), p]));
const effectRegistry = (key) => new Map((O[key] ?? []).map((x) => [full(x.Id), x]));
const dotEffects = effectRegistry('DamageOverTimeEffect');
const stackEffects = effectRegistry('StackingEffect');
const healEffects = effectRegistry('EndOfTurnHealingEffect');
const stunEffects = effectRegistry('StunEffect');
const TRIGGERS = { WhenHit: 'playerHit', WhenAttackEvaded: 'playerMiss', OnHit: 'enemyHit', OnAttack: 'enemyAttack', OnFirstAttack: 'enemyTurn' };
// Other effects a passive puts on you or the enemy itself, by the kind the combat model knows them as.
const PASSIVE_KINDS = { Stacking: 'stacking', TurnCounting: 'turns', EndOfTurnDamage: 'eot', RandomMagnitude: 'turns' };
function passiveOf(ids) {
  const out = { names: [], immuneTo: [], healPerTurn: 0, ramps: [], dots: [], stuns: [], selfStuns: [], minHitOfMax: 0, reflect: 0, effectMods: [], applies: [] };
  // Combat effect stats (CombatEffectStats), for effects on (or, for lifesteal, from) the enemy or you.
  const EFFECT_STATS = { AvoidanceChance: 'EffectAvoidanceChance', PercentDamageTaken: 'EffectDamageTaken', EffectLifesteal: 'EffectLifesteal' };
  for (const id of ids ?? []) {
    const p = passiveById.get(full(id));
    if (!p) continue;
    out.names.push(p.DisplayName);
    for (const m of p.Modifiers?.Component ?? []) {
      if (m.Stat?.Name === 'ImmunityFrom' && m.LocalContext?.CombatStyle) out.immuneTo.push(local(m.LocalContext.CombatStyle));
      if (m.Stat?.Name === 'MinHitBasedOnMaxHit') out.minHitOfMax += m.Value ?? 0;
      // Thorn Body, Thornhide: part of the damage your attacks do comes back to you (ReflectAttackDamage).
      if (m.Stat?.Name === 'PercentAttackReflect') out.reflect += m.Value ?? 0;
      // Crimson Eyes, Acid Shambler, Blood Circulation: effects it avoids, and lifesteal from its own.
      if (local(m.Stat?.StatsType) === 'CombatEffect' && EFFECT_STATS[m.Stat.Name]) {
        out.effectMods.push({ who: local(m.LocalContext?.Component?.Component) === 'Player' ? 'player' : 'enemy', stat: EFFECT_STATS[m.Stat.Name], value: m.Value ?? 0, ...(m.LocalContext?.Effect ? { effect: local(m.LocalContext.Effect) } : {}) });
      }
    }
    for (const c of p.Modifiers?.CombatEffect ?? []) {
      const type = local(c.Modifier?.Effect?.Type);
      const effect = full(c.Modifier?.Effect?.Data?.Effect);
      const toSelf = c.Modifier?.AppliesTo === 'Self';
      const stunTurns = () => c.Modifier.Effect.Data?.Configuration?.Turns ?? stunEffects.get(effect)?.DefaultTurns ?? 1;
      if (local(c.Character?.Component) === 'Player') {
        // Set off on the player's side: Storm Wrapped also stuns the enemy itself when it hits you.
        if (type === 'Stun' && !toSelf && c.Modifier?.Trigger?.Data?.Type === 'WhenHit') out.selfStuns.push({ on: 'enemyHit', chance: c.Chance ?? 1, turns: stunTurns() });
        continue;
      }
      if (local(c.Character?.Component) !== 'Enemy') continue;
      // enemyHit: when the enemy hits you. playerHit / playerMiss: when you hit or miss it. enemyAttack:
      // each hit it tries; enemyTurn: the first of each turn. start: once as the fight starts (Petrify).
      // OnDeath (Gas Ball's Explosive) is left out: it goes on you as it dies and comes off as the fight
      // ends on the same tick (FightEnded), before any turn of yours ends, so it never does anything.
      const trigger = local(c.Modifier?.Trigger?.Type);
      const on = trigger === 'AtStartOfFight' ? 'start' : TRIGGERS[c.Modifier?.Trigger?.Data?.Type];
      if (!on) continue;
      if (type === 'EndOfTurnHealing' && toSelf) {
        const h = healEffects.get(effect);
        if (local(h?.HealingPerTurn?.Formula?.Type) === 'CurrentHitpoints') out.healPerTurn += h.HealingPerTurn.Formula.Data?.Percent ?? 0;
      } else if (type === 'Stacking' && toSelf) {
        const st = stackEffects.get(effect);
        // `effect`: its attacks can put the same stacks on (Grand Boast's Dwarven Pride), one count.
        if (st) out.ramps.push({ name: st.DisplayName, effect: local(effect), on, maxStacks: st.MaxStacks ?? 1, mods: (st.Modifiers ?? []).map((m) => ({ stat: m.Stat?.Name, value: m.Value ?? 0 })) });
      } else if (type === 'DamageOverTime' && !toSelf) {
        const d = dotEffects.get(effect);
        const f = d?.DamagePerProc?.Formula ?? {};
        if (d) out.dots.push({ name: d.DisplayName, effect: local(effect), on, chance: c.Chance ?? 1, formula: local(f.Type), percent: f.Data?.Percent ?? 0, procs: d.ProcCount ?? 1, interval: d.ProcInterval ?? 1000, maxStacks: d.MaxStacks ?? 1 });
      } else if (type === 'Stun' && !toSelf) {
        out.stuns.push({ effect: local(effect), on, chance: c.Chance ?? 1, turns: stunTurns() });
      } else if (PASSIVE_KINDS[type] && !(type === 'Stacking' && toSelf) && !(type === 'EndOfTurnDamage' && toSelf)) {
        // Stacks it puts on you (Acid Burns, Plague Touch, Burning Flame), effects for some turns on you
        // or itself (Corrupting Touch, Spirit's Evasive, Sand Covered's Blind) and damage at the end of
        // each of your turns (Acid Burn, Sandstorm).
        const config = c.Modifier?.Effect?.Data?.Configuration ?? {};
        out.applies.push({ kind: PASSIVE_KINDS[type], effect: local(effect), on, chance: c.Chance ?? 1, to: toSelf ? 'self' : 'target', ...(config.Turns != null ? { turns: config.Turns } : {}), ...(config.StacksToAdd != null ? { stacks: config.StacksToAdd } : {}) });
      }
    }
  }
  return out;
}
for (const e of O.Enemy ?? []) {
  const enemy = enemyById.get(e.Id);
  if (enemy && e.Passives?.length) enemy.passive = passiveOf(e.Passives);
}

// Dungeons: fights in order (each picks one enemy by weight), then the rewards, then it starts again.
// Only those the game lets you pick (the Combat config's area list).
const selectableAreas = new Set((EC['MelvorBase:Combat']?.Areas ?? []).map((a) => full(a.Id)));
const dungeons = (O.Dungeon ?? [])
  .filter((d) => !isLocked(d) && !isQuestOnly(d) && (!selectableAreas.size || selectableAreas.has(full(d.Id))))
  .map((d) => ({
    id: d.Id,
    name: d.DisplayName,
    icon: imagePath(d),
    category: d.Category ? nameOf(d.Category) : null,
    difficulty: d.Difficulty ? humanize(local(d.Difficulty)) : null,
    darkness: d.Darkness ?? 0,
    requires: normReqs(d.UnlockRequirements),
    fights: (d.Enemies ?? [])
      .map((g) => ({ count: g.Count ?? 1, enemies: (g.Enemies ?? []).map((x) => ({ enemy: local(x.Enemy), weight: x.Weight ?? 1 })).filter((x) => enemyById.has(x.enemy)) }))
      .filter((g) => g.enemies.length),
    rewards: {
      fixed: (d.Rewards?.FixedItems ?? []).map((x) => ({ item: full(x.Item), min: x.MinQuantity ?? 1, max: x.MaxQuantity ?? x.MinQuantity ?? 1 })),
      tables: (d.Rewards?.ItemTables ?? []).map((t) => ({ chance: t.Chance ?? 1, entries: table(t.Table) })),
      currencies: (d.Rewards?.FixedCurrencies ?? []).map((c) => ({ currency: local(c.Currency), min: c.MinQuantity ?? 0, max: c.MaxQuantity ?? c.MinQuantity ?? 0 })),
    },
  }))
  .filter((d) => d.fights.length);
for (const d of dungeons) {
  for (const g of d.fights) {
    for (const x of g.enemies) {
      const e = enemyById.get(x.enemy);
      e.dungeons ??= [];
      if (!e.dungeons.includes(d.id)) e.dungeons.push(d.id);
    }
  }
}

// Combat rules: styles, stances, the combat triangle, elements, spells and enemy special attacks.
const bonusList = (bonuses) => [...(bonuses?.Global ?? []), ...(bonuses?.Component ?? [])];
// Bonuses as { stats, stat, value, skill, scope? } — the form the rate calculator applies.
const normEffects = (bonuses) =>
  bonusList(bonuses)
    .filter((m) => (m.Stat?.Name || m.StatGroup) && m.Value != null && !m.Condition && !m.Scaling)
    .map((m) => {
      // Global bonuses name a stat group (GlobalFlatAutoEatThreshold) and apply everywhere.
      if (!m.Stat?.Name) return { stats: 'Global', stat: m.StatGroup.replace(/^Global/, ''), value: m.Value, skill: null };
      const ctx = m.LocalContext ?? {};
      const scope = Object.fromEntries(Object.entries(ctx).filter(([k, v]) => k !== 'Component' && v).map(([k, v]) => [k, k === 'Recipe' ? local(v) : nameOf(v)]));
      return { stats: local(m.Stat.StatsType), stat: m.Stat.Name, value: m.Value, skill: local(ctx.Component?.Entity), ...(Object.keys(scope).length ? { scope } : {}) };
    });

// Thieving heist bonuses (one target) and distractions (every target in a location): they switch on
// by themselves once their requirements are met (ActiveThievingRecipe.OnSaveLoaded, ActiveThievingLocation).
const heistBonusById = new Map((O.ThievingHeistBonus ?? []).map((h) => [full(h.Id), h]));
const distractionById = new Map((O.ThievingDistraction ?? []).map((d) => [full(d.Id), d]));
const thievingBonus = (b, scope) => ({ name: b.DisplayName, requires: normReqs(b.Requirements), effects: normEffects({ Component: b.Bonuses }).map((e) => ({ ...e, skill: 'Thieving', scope })) });
const thievingBonuses = [
  ...methods.filter((m) => m.kind === 'thieving').flatMap((m) => ((O.ThievingRecipe ?? []).find((r) => r.Id === m.id)?.HeistBonuses ?? []).map((id) => heistBonusById.get(full(id))).filter((b) => b && !isLocked(b)).map((b) => thievingBonus(b, { Recipe: m.id }))),
  ...(O.ThievingLocation ?? []).filter((l) => !isLocked(l)).flatMap((l) => (l.AvailableDistractions ?? []).map((id) => distractionById.get(full(id))).filter((d) => d && !isLocked(d)).map((d) => thievingBonus(d, { Category: nameOf(l.Id) }))),
].filter((b) => b.effects.length);

// Astrology: every node you unlock adds its bonuses, and each constellation adds its per-minor-node bonus
// once for every minor node unlocked in it (ActiveAstrologyConstellation.LoadBonuses).
const astrology = { nodes: {}, perMinorNode: {} };
for (const c of O.AstrologyConstellation ?? []) {
  if (isLocked(c)) continue;
  for (const [list, major] of [[c.MinorNodes, false], [c.MajorNodes, true]]) {
    for (const ref of list ?? []) {
      const node = (O.AstrologyNode ?? []).find((n) => full(n.Id) === full(ref.Id ?? ref));
      if (node) astrology.nodes[node.Id] = { name: node.DisplayName, constellation: c.Id, major, effects: normEffects(node.Bonuses) };
    }
  }
  const per = normEffects(c.PerMinorNodeBonuses);
  if (per.length) astrology.perMinorNode[c.Id] = per;
}

// Hunting choices per animal (ActiveHuntingAnimal): its preferred bait (a bonus while you have some, one
// used per trap attempt), trapless hunting where it's allowed (a bonus, no traps used), and what surveys
// can turn up (at most one find per catch, HuntingActionComponent).
for (const m of methods.filter((x) => x.kind === 'hunting')) {
  const r = (O.HuntingAnimal ?? []).find((a) => a.Id === m.id);
  if (!r) continue;
  if (r.PreferredBait && r.BaitModifierTemplate) m.bait = { item: full(r.PreferredBait), effects: normEffects({ Component: r.BaitModifierTemplate }) };
  if (r.EnableTrapless && r.TraplessBonuses) m.trapless = { requires: normReqs(r.TraplessRequirements), effects: normEffects({ Component: r.TraplessBonuses }) };
  m.survey = chanceItems(r.SurveyingProducts);
}

// Finds while you work. Every Astrology study rolls the global sightings and the constellation's own
// events (AstrologyActionStats.GetAllEvents); a find gives its base quantity plus 0 to Astrology level ×
// LevelScalingQuantity (AstrologyActionComponent.GrantRandomItems). Burning logs rolls the Firemaking
// events once their Astrology nodes are unlocked, the quantity scaling with the burn time in seconds
// (FiremakingActionComponent.RollEvent).
const astrologyItemEvents = new Map((O.AstrologyItemEvent ?? []).map((e) => [full(e.Id), e]));
for (const m of methods.filter((x) => x.kind === 'astrology')) {
  const c = (O.AstrologyConstellation ?? []).find((r) => r.Id === m.id);
  const ids = [...(EC[full('Astrology')]?.GlobalEvents ?? []).map((e) => e.Id), ...(c?.Events ?? [])];
  m.events = ids.map((id) => astrologyItemEvents.get(full(id))).filter((e) => e && !isLocked(e))
    .map((e) => ({ name: e.DisplayName?.Singular ?? nameOf(e.Id), item: full(e.Item), chance: e.Chance, qty: e.BaseQuantity, perLevel: (e.LevelScalingQuantity ?? 0) / 2, requires: normReqs(e.Requirements) }));
}
const firemakingEvents = (EC[full('Firemaking')]?.Events ?? []).map((ref) => (O.FiremakingEvent ?? []).find((e) => full(e.Id) === full(ref.Id))).filter((e) => e && !isLocked(e));
for (const m of methods.filter((x) => x.kind === 'firemaking')) {
  const r = (O.FiremakingRecipe ?? []).find((x) => x.Id === m.id);
  m.events = firemakingEvents.filter((e) => !e.Category || full(e.Category) === full(r?.Category))
    .map((e) => ({ name: e.DisplayName, item: full(e.Reward.Item), chance: e.Chance, qty: e.Reward.Quantity, perSecond: true, requires: normReqs(e.Requirements) }));
}

// What uses each item, from everywhere the game data asks for one: recipe ingredients (quest-only and
// locked recipes too), what a recipe, course, area, dungeon or spell needs you to have, quest hand-ins and
// objectives, ranch food, treats and buildings, hunting bait and traps, runes for spells and imbuements,
// upgrade, shop and automation costs, the Grain Mill and the anvil. Where an item comes from (products,
// drops, rewards) doesn't count, and neither do Mastery Guild tasks: they count what you've found, not
// what you keep. { localItemId: [{ how, name }] }, one entry per kind of use and thing.
const USE_KEYS = [
  ['EntryCost', 'entry'], ['RuneCosts', 'runes'], ['AutomationCosts', 'automate'], ['Costs', 'cost'], ['Ingredients', 'make'],
  ['AccessRequirements', 'needed'], ['UnlockRequirements', 'needed'], ['Requirements', 'needed'], ['Goals', 'quest'],
  ['Eats', 'ranchFood'], ['Treats', 'ranchTreat'], ['PreferredBait', 'bait'], ['TrapType', 'trap'], ['StorageItems', 'mill'], ['Collectables', 'anvil'],
];
const NOT_USES = new Set(['Item', 'MasteryGuildTask', 'MasteryGuildBonus', 'Enemy', 'EquipmentSetBonus', 'CombatArea']);
const itemUses = {};
{
  const seen = new Set();
  const add = (item, use, type, obj) => {
    const how = type === 'Quest' ? 'quest' : use;
    const name = type === 'Quest' ? singular(obj.DisplayName, obj.Id) : nameOf(obj.Id) ?? humanize(local(obj.Id));
    const key = `${item}|${how}|${type}|${obj.Id}`;
    if (seen.has(key)) return;
    seen.add(key);
    (itemUses[item] ??= []).push({ how, type, name });
  };
  const walk = (node, keys, type, obj) => {
    if (Array.isArray(node)) return node.forEach((v) => walk(v, keys, type, obj));
    if (node && typeof node === 'object') return Object.entries(node).forEach(([k, v]) => walk(v, [...keys, k], type, obj));
    if (typeof node !== 'string' || !itemIds.has(node)) return;
    const use = USE_KEYS.find(([key]) => keys.includes(key));
    if (use) add(local(node), use[1], type, obj);
  };
  for (const [type, list] of Object.entries(O)) {
    if (!Array.isArray(list) || NOT_USES.has(type)) continue;
    for (const obj of list) if (!isLocked(obj)) walk(obj, [], type, obj);
  }
}

// Collectables from rare species, for the Mastery tasks that count how many you've found.
const huntingCollectables = [...new Set((O.HuntingAnimalSpecies ?? []).filter((s) => !isLocked(s)).flatMap((s) => (s.ExtraProducts ?? []).filter((x) => x.IsCollectable).map((x) => local(x.Item))))];

// Hunting journal: each level an animal's journal reaches adds bonuses for that animal
// (ActiveHuntingAnimal.AddJournalModifiers).
const huntingJournalBonuses = (O.HuntingJournalBonus ?? [])
  .map((b) => ({ level: b.UnlockLevel ?? 1, effects: normEffects({ Component: b.JournalModifierTemplate }) }))
  .filter((b) => b.effects.length)
  .sort((a, b) => a.level - b.level);

// Bonfires (lit in Firemaking, they burn down while you aren't doing Firemaking) and each skill's Aurora
// (a rare event with a number of charges): bonuses that only count while they're on.
const bonfires = Object.fromEntries((O.FiremakingBonfire ?? []).filter((b) => !isLocked(b)).map((b) => [b.Id, { name: b.DisplayName, hours: b.MaxDuration ?? 0, effects: normEffects(b.Bonuses) }]));
// Bonus events Astrology can turn up while you study (AstrologyBonusesEvent): one at a time, until its charges run out.
const astrologyEvents = Object.fromEntries((O.AstrologyBonusesEvent ?? []).filter((e) => !isLocked(e)).map((e) => [e.Id, { name: singular(e.DisplayName, e.Id), charges: e.Charges ?? 0, effects: normEffects(e.Bonuses) }]));
const auroras = Object.fromEntries((O.RareBonusesEvent ?? []).filter((e) => !isLocked(e)).map((e) => [e.Id, { name: singular(e.DisplayName, e.Id), charges: e.Charges ?? 0, effects: normEffects(e.Bonuses) }]));

// Ranching variants' own product and XP bonuses (SelfBonuses), and enclosure names and sizes, for the
// herd the save holds (engine/ranch.js).
const variantBonus = (v, stat) => (v?.SelfBonuses ?? []).filter((b) => b.Stat?.Name === stat).reduce((s, b) => s + (b.Value ?? 0), 0);
const ranchingVariantBonuses = Object.fromEntries((O.RanchingAnimalVariant ?? []).map((v) => [local(v.Id), { name: v.DisplayName, productPercent: variantBonus(v, 'PercentProductQuantity'), xpPercent: variantBonus(v, 'PercentXPGained') }]));
const ranchingEnclosures = Object.fromEntries((O.RanchingEnclosure ?? []).map((e) => [local(e.Id), { name: e.DisplayName, limit: e.AnimalLimit }]));

// Mining's stone and essence drops: every hit can give each one (MiningActionComponent).
const miningConfig = EC['MelvorBase:Mining'] ?? EC.Mining ?? {};
const mining = { stones: (miningConfig.StoneItems ?? []).map((x) => full(x.Id)), essences: (miningConfig.EssenceItems ?? []).map((x) => full(x.Id)) };
// What one hit deals, as shares of the game's damage formulas: a roll between min and max hit
// (NormalDamage), a fixed share of max hit with no roll (MaxHit) and a share of the defender's HP left.
const hitDamage = (hit) => {
  const share = (who, type) => (hit.Damage ?? []).filter((d) => d.Character === who && local(d.Formula?.Type) === type).reduce((sum, d) => sum + (d.Formula?.Data?.Percent ?? 0), 0);
  return { normal: share('Attacker', 'NormalDamage'), maxHit: share('Attacker', 'MaxHit'), currentHp: share('Defender', 'CurrentHitpoints') };
};
// Combat effect stats get their own names (EffectAvoidanceChance, EffectDamageTaken), apart from the
// character stats of the same name; `effect` is the one effect they're for, if any.
const COMBAT_EFFECT_STATS = { AvoidanceChance: 'EffectAvoidanceChance', PercentDamageTaken: 'EffectDamageTaken', EffectLifesteal: 'EffectLifesteal' };
const effectMods = (list) => (list ?? [])
  .filter((m) => m.Stat?.Name && !m.Condition && !m.Scaling)
  .map((m) => ({
    stat: local(m.Stat.StatsType) === 'CombatEffect' ? COMBAT_EFFECT_STATS[m.Stat.Name] ?? m.Stat.Name : m.Stat.Name,
    value: m.Value ?? 0,
    ...(m.LocalContext?.Effect ? { effect: local(m.LocalContext.Effect) } : {}),
    ...(m.LocalContext?.CombatStat ? { combatStat: local(m.LocalContext.CombatStat) } : {}),
  }));
// What an attack does besides damage (AttackEffectChance): an effect on its target or itself, rolled
// before every hit (pre) or on every hit that lands (hit), with the turns or stacks it's set to.
const EFFECT_KINDS = { DamageOverTime: 'dot', Stun: 'stun', TurnCounting: 'turns', Stacking: 'stacking', EndOfTurnDamage: 'eot' };
const attackEffect = (when) => (ef) => {
  const config = ef.Effect?.Data?.Configuration ?? {};
  return {
    kind: EFFECT_KINDS[local(ef.Effect?.Type)] ?? local(ef.Effect?.Type),
    effect: local(ef.Effect?.Data?.Effect ?? ef.Effect?.Type),
    chance: ef.Chance ?? 1,
    to: ef.AppliesTo === 'Self' ? 'self' : 'target',
    when,
    ...(config.Turns != null ? { turns: config.Turns } : {}),
    ...(config.StacksToAdd != null ? { stacks: config.StacksToAdd } : {}),
  };
};
// After a stun ends it applies its removal effect (Staggered after a stun, Drowsy after sleep).
const removalOf = (x) => (x.RemovalEffect?.Data?.Effect ? { after: { effect: local(x.RemovalEffect.Data.Effect), turns: x.RemovalEffect.Data.Configuration?.Turns ?? null } } : {});
const combat = {
  dungeons,
  styles: Object.fromEntries((O.CombatStyle ?? []).map((st) => {
    const f = st.MaxHitFormula ?? {};
    const fd = f.Data ?? {};
    return [st.Id, {
      name: st.DisplayName,
      accuracyLevels: levelRatios(st.AccuracyRatingLevels),
      evasionLevels: levelRatios(st.EvasionLevels),
      maxHit: local(f.Type) === 'DamageBonus'
        ? { type: 'DamageBonus', maxHitStat: local(fd.MaxHitStat), damageBonusStat: local(fd.DamageBonusStat), levels: levelRatios(fd.Levels) }
        : { type: 'StrengthBonus', strengthStat: local(fd.StrengthBonusStat), levels: levelRatios(fd.Levels) },
      intervalStat: local(st.AttackIntervalStat),
      armourStat: local(st.ArmourStat),
      hitpointsLevel: local(st.MaxHitpointsLevel),
      combatLevel: levelRatios(st.CombatLevelRatios),
      usesSpells: !!st.UsesSpells,
    }];
  })),
  stances: Object.fromEntries((O.AttackStance ?? []).map((x) => [x.Id, {
    name: x.DisplayName,
    style: local(x.CombatStyle),
    accuracyStat: local(x.AccuracyStat),
    evasionStat: local(x.EvasionStat),
    xp: (x.ExperienceGain ?? []).map((g) => ({ skill: local(g.Component?.Entity), perDamage: g.ExperiencePerDamage ?? 0 })),
    // Block, Long-Range and Focused add hidden Defence levels.
    levelBonus: Object.fromEntries(bonusList(x.Bonuses).filter((m) => m.Stat?.Name === 'FlatCombatLevel').map((m) => [local(m.LocalContext?.CombatLevel), m.Value])),
  }])),
  triangle: (O.CombatTriangleBonus ?? []).map((t) => {
    const v = (name) => bonusList(t.Bonuses).find((m) => m.Stat?.Name === name)?.Value ?? 0;
    return { player: local(t.PlayerStyle), enemy: local(t.EnemyStyle), maxHit: v('MaxHitCombatTriangle'), resistance: v('ResistanceCombatTriangle') };
  }),
  elements: (O.ElementalBonus ?? []).map((b) => ({
    player: local(b.PlayerElement),
    enemy: local(b.EnemyElement),
    percentMaxHit: bonusList(b.Bonuses).find((m) => m.Stat?.Name === 'PercentMaxHit')?.Value ?? 0,
  })),
  weaponTypes: Object.fromEntries((O.WeaponType ?? []).map((w) => [w.Id, { name: w.DisplayName, stances: (w.Stances ?? []).map(local) }])),
  spells: (O.MagicSpell ?? []).filter((x) => !isLocked(x)).map((x) => ({
    id: x.Id,
    name: x.DisplayName,
    icon: imagePath(x),
    book: local(x.Book),
    element: local(x.Element),
    maxHit: (x.Stats?.Stats ?? []).find((st) => local(st.Stat) === 'SpellMaxHit')?.Value ?? 0,
    runes: itemQty(x.RuneCosts),
    level: normReqs(x.UnlockRequirements).find((r) => r.type === 'level' && r.skill === 'Magic')?.level ?? 1,
    special: !!x.AttackOverride,
  })),
  // Each special attack's hits in order (CharacterComponent.AttackAction): each one rolls and lands on
  // its own, `count` times, the later ones `interval` ms apart; the next turn waits for the last.
  attacks: Object.fromEntries((O.Attack ?? []).map((x) => [x.Id, {
    name: x.DisplayName,
    hits: (x.Hits ?? []).map((h) => ({ count: h.Count ?? 1, interval: h.Interval ?? 0, ...hitDamage(h) })),
    avoidable: x.IsAvoidable !== false,
    effects: [...new Set([...(x.PreHitEffects ?? []), ...(x.OnHitEffects ?? [])].map((ef) => humanize(local(ef.Effect?.Data?.Effect ?? ef.Effect?.Type))))],
    applies: [...(x.PreHitEffects ?? []).map(attackEffect('pre')), ...(x.OnHitEffects ?? []).map(attackEffect('hit'))],
  }])),
  // Effects attacks apply, by id: damage over time (ActiveDamageOverTimeEffect), stuns (lost turns,
  // with modifiers while they last), effects that change stats for some of the target's turns, stacks
  // that build up until the fight ends (ActiveStackingEffect) and damage at the end of each of the
  // target's turns until then (ActiveEndOfTurnDamageEffect, rolled from its source or its target).
  effects: Object.fromEntries([
    ...(O.TurnCountingEffect ?? []).map((x) => [x.Id, { kind: 'turns', name: x.DisplayName, positive: !!x.IsPositive, turns: x.DefaultTurns ?? 1, mods: effectMods(x.Modifiers), ...removalOf(x) }]),
    ...(O.StunEffect ?? []).map((x) => [x.Id, { kind: 'stun', name: x.DisplayName, turns: x.DefaultTurns ?? 1, mods: effectMods(x.Modifiers), ...removalOf(x) }]),
    ...(O.DamageOverTimeEffect ?? []).map((x) => {
      const f = x.DamagePerProc?.Formula ?? {};
      return [x.Id, { kind: 'dot', name: x.DisplayName, formula: local(f.Type), percent: f.Data?.Percent ?? 0, procs: x.ProcCount ?? 1, interval: x.ProcInterval ?? 1000, maxStacks: x.MaxStacks ?? 1, mods: effectMods(x.Modifiers) }];
    }),
    // Random magnitude (Blind, Wind Rider): some turns at a stack count rolled between the two, taken
    // at its average (ActiveRandomMagnitudeEffect).
    ...(O.RandomMagnitudeEffect ?? []).map((x) => {
      const stacks = ((x.DefaultMinStacks ?? 1) + (x.DefaultMaxStacks ?? 1)) / 2;
      return [x.Id, { kind: 'turns', name: x.DisplayName, positive: !!x.IsPositive, turns: x.DefaultTurns ?? 1, mods: effectMods(x.Modifiers).map((m) => ({ ...m, value: m.value * stacks })) }];
    }),
    ...(O.StackingEffect ?? []).map((x) => [x.Id, { kind: 'stacking', name: x.DisplayName, maxStacks: x.MaxStacks ?? 1, stacks: x.DefaultStacksToAdd ?? 1, mods: effectMods(x.Modifiers) }]),
    ...(O.EndOfTurnDamageEffect ?? []).map((x) => {
      const f = x.DamagePerTurn?.Formula ?? {};
      return [x.Id, { kind: 'eot', name: x.DisplayName, of: x.DamagePerTurn?.Character === 'Target' ? 'target' : 'source', formula: local(f.Type), percent: f.Data?.Percent ?? 0, damage: f.Data?.Damage ?? 0, mods: [] }];
    }),
  ]),
  slots: (O.EquipmentSlot ?? []).map((x) => ({ id: x.Id, name: x.DisplayName, fits: local(x.FitsType), requires: normReqs(x.UnlockRequirements) })),
};

// Slayer masters hand out tasks from the enemies in their areas (SlayerTasksStats, ActiveSlayerMaster).
combat.slayerMasters = (O.SlayerMaster ?? []).filter((m) => !isLocked(m)).map((m) => ({
  id: m.Id,
  name: m.DisplayName,
  icon: imagePath(m),
  areas: (m.Areas ?? []).map(local),
  requires: normReqs(m.UnlockRequirements),
  baseTaskLength: m.BaseTaskLength ?? 15,
  rerollCost: { currency: local(m.RerollCost?.Currency), qty: m.RerollCost?.Quantity ?? 0 },
  blockCost: { currency: local(m.BlockCost?.Currency), qty: m.BlockCost?.Quantity ?? 0 },
  rewardCurrency: local(m.RewardCurrency),
}));

// What an item gives when equipped: its stats plus the unconditional bonuses the companion models.
// Everything else (conditional or situational bonuses) is kept as text.
const MODELLED_BONUSES = new Set(['PercentMaxHit', 'FlatMaxHit', 'FlatPowerRating', 'FlatProtectionRating', 'PercentPowerRating', 'PercentProtectionRating', 'PercentAttackInterval', 'FlatAttackInterval', 'PercentAccuracyRating', 'PercentEvasionRating', 'FlatLight', 'MinHitBasedOnMaxHit', 'FlatMinHit', 'FlatCombatStatValue', 'PercentCombatStatValue', 'FlatCriticalHitChance', 'FlatCriticalHitMultiplier', 'PercentDamageDealt', 'PercentAttackReflect', 'DoubleWardDamageChance']);
// Other stats the combat model uses: hit chance and immunity (TargetCharacterStats), food healing,
// time between enemies, the chance to keep ammo, runes, prayer points and food, and Slayer coins.
const MODELLED_OTHER = new Set(['Target.FlatHitChance', 'Target.ImmunityFrom', 'CombatFood.PercentHealing', 'CombatAction.FlatSpawnInterval', 'CombatAction.PercentSpawnInterval',
  'AmmoConsumption.AmmoPreservationChance', 'MagicSpell.RunePreservationChance', 'Prayer.CostPreservationChance', 'CombatFood.FoodPreservationChance',
  'SlayerTasks.PercentRewardCurrency', 'SlayerTasks.FlatRewardCurrency', 'CombatEffect.AvoidanceChance', 'CombatEffect.PercentDamageTaken', 'CombatEffect.EffectLifesteal']);
// Effects for the rate calculator, without the ones the combat model already counts as mods.
const notCombatMod = (e) => e.stats !== 'Character' && !MODELLED_OTHER.has(`${e.stats}.${e.stat}`);
// Combat bonuses the companion models (Character stats with no condition), and the rest as text.
// When a conditional bonus counts (Condition on the bonus), in a form the combat model can check;
// false for conditions it can't.
function conditionOf(c) {
  if (!c) return null;
  const d = c.Data ?? {};
  switch (local(c.Type)) {
    case 'FightingSlayerTask': return { type: 'slayerTask' };
    case 'CombatInArea': return { type: 'area', ...(d.Area ? { area: local(d.Area) } : {}), ...(d.Category ? { category: nameOf(d.Category) } : {}) };
    case 'CharacterUsingCombatStyle': return { type: 'style', style: local(d.Style) };
    case 'CharacterUsingStance': return { type: 'stance', stance: local(d.Stance ?? d.AttackStance) };
    case 'PrayerActive': return { type: 'prayer', ...(d.Prayer ? { prayer: local(d.Prayer) } : {}) };
    case 'UsingSpell': return { type: 'spell', spell: local(d.Spell) };
    default: return false;
  }
}
function characterMods(bonuses) {
  const mods = [];
  const otherBonuses = [];
  for (const m of bonusList(bonuses)) {
    const ctx = m.LocalContext ?? {};
    // Only the Normal damage type exists and every hit uses it, so bonuses for it always count. Rune
    // preservation can be for one element's spells (kept as `element`).
    const runes = m.Stat?.Name === 'RunePreservationChance';
    const type = local(m.Stat?.StatsType);
    // Effect avoidance and effect damage taken can be for one effect (kept as `effect`).
    const forEffect = type === 'CombatEffect';
    const scoped = ['AttackStance', 'CombatLevel'].some((k) => ctx[k]) || (ctx.Effect && !forEffect) || (ctx.Element && !runes) || (ctx.DamageType && local(ctx.DamageType) !== 'Normal');
    const when = conditionOf(m.Condition);
    const modelled = type === 'Character' ? MODELLED_BONUSES.has(m.Stat?.Name) : MODELLED_OTHER.has(`${type}.${m.Stat?.Name}`);
    if (modelled && when !== false && !m.Scaling && !scoped) {
      // Some gear works on the enemy (LocalContext Component Enemy): lower enemy accuracy, less ward.
      mods.push({
        stat: forEffect ? COMBAT_EFFECT_STATS[m.Stat.Name] : m.Stat.Name,
        value: m.Value,
        ...(forEffect && ctx.Effect ? { effect: local(ctx.Effect) } : {}),
        ...(ctx.CombatStyle ? { style: local(ctx.CombatStyle) } : {}),
        ...(ctx.CombatStat ? { combatStat: local(ctx.CombatStat) } : {}),
        ...(ctx.Element && runes ? { element: local(ctx.Element) } : {}),
        ...(ctx.AmmoType ? { ammoType: local(ctx.AmmoType) } : {}),
        ...(local(ctx.Component?.Component) === 'Enemy' ? { onEnemy: true } : {}),
        ...(when ? { when } : {}),
      });
    } else {
      otherBonuses.push(...describeBonuses({ Component: [m] }).map((line) => (m.Condition ? `${line} (in some situations)` : line)));
    }
  }
  return { mods, otherBonuses };
}

// What a toolbelt item does while it's in a toolbelt slot (tools, potions, combat utilities).
function toolOf(it) {
  const caps = it.Capabilities ?? {};
  const tool = caps[Object.keys(caps).find((k) => local(k) === 'Toolbelt')];
  if (!tool) return null;
  const { mods, otherBonuses } = characterMods(tool.Bonuses);
  const effects = normEffects(tool.Bonuses).filter(notCombatMod);
  const requires = normReqs(tool.Requirements);
  return {
    slot: local(tool.FitsInSlot),
    ...(effects.length ? { effects } : {}),
    ...(mods.length ? { mods } : {}),
    ...(otherBonuses.length ? { otherBonuses } : {}),
    ...(requires.length ? { requires } : {}),
    // Potions, lockpicks, butterflies: a stack goes in the slot and gets used up.
    // usedOn: what uses one up (ToolbeltCapability.ConsumesOn), e.g. WoodcuttingDamageTree for every hit,
    // with the trigger's limits: only a recipe, category or thieving type, a success, or a chance.
    ...(tool.ConsumesOn?.length ? { usedUp: true, usedOn: tool.ConsumesOn.map(usedOn) } : {}),
  };
}

function usedOn(c) {
  const d = c.Data ?? {};
  return {
    type: local(c.Type),
    ...(d.Recipe ? { recipe: local(d.Recipe) } : {}),
    ...(d.Category ? { category: nameOf(d.Category) } : {}),
    ...(d.Subcategory ? { subcategory: nameOf(d.Subcategory) } : {}),
    ...(d.RecipeType ? { recipeType: local(d.RecipeType) } : {}),
    ...(d.MinRecipeSteps ? { minSteps: d.MinRecipeSteps } : {}),
    ...(d.SuccessfulActionOnly || d.MustBeSuccessful ? { success: true } : {}),
    ...(d.FailedActionOnly ? { fail: true } : {}),
    ...(d.Chance != null ? { chance: d.Chance } : {}),
    ...(d.Currency ? { currency: local(d.Currency) } : {}),
    ...(d.Conditions ? { conditions: true } : {}),
  };
}

function equipmentOf(it) {
  const caps = it.Capabilities ?? {};
  const cap = (name) => caps[Object.keys(caps).find((k) => local(k) === name)];
  const eq = cap('Equipment');
  if (!eq) return null;
  const w = cap('Weapon');
  const { mods, otherBonuses } = characterMods(eq.Bonuses);
  return {
    type: local(eq.Type),
    alsoOccupies: (eq.OccupiesSlots ?? []).map(local),
    requires: normReqs(eq.Requirements),
    stats: Object.fromEntries((eq.Stats?.Stats ?? []).map((st) => [local(st.Stat), st.Value])),
    power: ratingOf(eq.Stats?.PowerRatings),
    protection: ratingOf(eq.Stats?.ProtectionRatings),
    ...(eq.AmmoType ? { ammoType: local(eq.AmmoType) } : {}),
    ...(eq.CanEquipQuantity ? { stacks: true } : {}),
    ...(mods.length ? { mods } : {}),
    ...(otherBonuses.length ? { otherBonuses } : {}),
    ...(w ? { weapon: { type: local(w.Type), elements: (w.Elements ?? []).map(local), ammo: w.RequiredAmmoType ? local(w.RequiredAmmoType) : null } } : {}),
    // Special attacks it gives while worn, each with its chance per turn (EquipmentComponent.GetAllAttacks).
    ...(eq.Attacks?.length ? { attacks: eq.Attacks.map((x) => ({ attack: local(x.Attack), chance: x.Chance ?? 0 })) } : {}),
  };
}

// Pets: unlocked ones give their bonuses for good (PetsComponent).
const pets = (O.Pet ?? []).filter((x) => !isLocked(x)).map((x) => ({
  id: x.Id,
  name: x.DisplayName,
  icon: imagePath(x),
  skill: local(x.Trigger?.Data?.Component?.Entity) ?? null,
  effects: normEffects(x.Bonuses).filter(notCombatMod),
  ...characterMods(x.Bonuses),
}));

// Prayers: one per slot, active while fighting (PrayerComponent).
// Equipment sets (EquipmentSetBonus): wearing enough pieces of a set turns on each of its bonuses.
// Combat sets count worn gear; skilling sets count pieces in the toolbelts too.
combat.sets = (O.EquipmentSetBonus ?? []).filter((x) => !isLocked(x)).map((x) => ({
  id: x.Id,
  name: x.DisplayName,
  items: (x.Items ?? []).map(full),
  bonuses: (x.Bonuses ?? []).map((b) => ({
    count: b.ItemCount ?? (x.Items ?? []).length,
    ...characterMods(b.Modifiers),
    effects: normEffects(b.Modifiers).filter(notCombatMod),
  })),
}));

// Magic imbuements (MagicSpellsComponent): while you have the runes, each attack turn costs them, and
// the first hit that lands in a turn may put an effect on the target (OnAttack OnFirstHit).
const WHEN = { OnFirstHit: 'firstHit', OnHit: 'hit', OnAttack: 'pre' };
combat.imbuements = (O.Imbuement ?? []).filter((x) => !isLocked(x)).map((x) => ({
  id: x.Id,
  name: x.DisplayName,
  icon: imagePath(x),
  element: local(x.Element),
  runes: itemQty(x.RuneCosts),
  level: levelOf(x.UnlockRequirements, 'Magic'),
  applies: (x.Bonuses?.CombatEffect ?? []).filter((c) => local(c.Character?.Component) === 'Player').map((c) => {
    const config = c.Modifier?.Effect?.Data?.Configuration ?? {};
    return {
      kind: EFFECT_KINDS[local(c.Modifier?.Effect?.Type)] ?? local(c.Modifier?.Effect?.Type),
      effect: local(c.Modifier?.Effect?.Data?.Effect),
      chance: c.Chance ?? 1,
      to: c.Modifier?.AppliesTo === 'Self' ? 'self' : 'target',
      when: WHEN[c.Modifier?.Trigger?.Data?.Type] ?? 'firstHit',
      ...(config.Turns != null ? { turns: config.Turns } : {}),
      ...(config.StacksToAdd != null ? { stacks: config.StacksToAdd } : {}),
    };
  }),
}));

// Prayers cost points each attack turn: yours (ConsumesOn Player) or the enemy's (Enemy).
combat.prayers = (O.Prayer ?? []).filter((x) => !isLocked(x)).map((x) => ({
  id: x.Id,
  name: x.DisplayName,
  icon: imagePath(x),
  slot: local(x.FitsInSlot),
  level: levelOf(x.UnlockRequirements, 'Prayer'),
  cost: x.Cost?.Quantity ?? 0,
  paidOn: local(x.ConsumesOn?.Data?.Character?.Component) === 'Enemy' ? 'enemy' : 'player',
  ...characterMods(x.Bonuses),
}));

// Area effects (CombatAreasComponent): bonuses that hold while you fight there, each times the effect's
// magnitude, unless a shop purchase turns them off (DisableAreaEffect). The modelled ones only.
const areaEffects = new Map([...(O.CombatArea ?? []), ...(O.Dungeon ?? [])].filter((a) => a.Effect).map((a) => {
  const magnitude = a.Effect.Magnitude ?? 1;
  return [a.Id, characterMods({ Component: a.Effect.Modifiers?.Component ?? [] }).mods.map((m) => ({ ...m, value: m.value * magnitude }))];
}));
for (const a of [...areas, ...dungeons]) if (areaEffects.get(a.id)?.length) a.effect = areaEffects.get(a.id);
// Combat stats that are percentages; the others are rounded once bonuses apply (CombatStatStats).
combat.percentStats = (O.CombatStat ?? []).filter((s) => s.IsPercent).map((s) => s.Id);

// Mastery Guild (MasteryGuildComponent): tasks earn their category's points; ranks need a share of all
// points; each rank unlocks a bonus. A task is done when its goal is complete, its condition holds and
// its trigger has fired (ActiveMasteryGuildTask.CheckIfMet).
const masteryCategories = new Map((O.MasteryGuildCategory ?? []).map((c) => [full(c.Id), c]));
const masteryTaskById = new Map((O.MasteryGuildTask ?? []).map((t) => [full(t.Id), t]));
const masteryRankById = new Map((O.MasteryGuildRank ?? []).map((r) => [full(r.Id), r]));
function masteryCondition(c) {
  const type = local(c?.Type);
  const d = c?.Data ?? {};
  if (type === 'Level') return { type: 'level', skill: local(d.Component?.Entity), level: d.Level ?? 1 };
  if (type === 'ItemStatistic') return { type: 'itemStat', stat: local(d.Statistic), item: local(d.Item), value: d.Value ?? 1 };
  if (type === 'PetUnlocked') return { type: 'pet', pet: local(d.Pet) };
  // Other saved statistics: Slayer master tasks, Agility course completions, Astrology events observed,
  // Ranching animal time alive, Hunting species trapped.
  const stat = /Statistic$|^HuntingAnimalSpecies$/.test(type) ? statReq(d) : null;
  if (stat) return { type: 'stat', stat: stat.stat, id: stat.id, value: stat.value };
  if (type === 'ValueStatistic' && d.Statistic) return { type: 'value', stat: local(d.Statistic), value: d.Value ?? 1 };
  if (type === 'AgilityTechniqueLevel' && d.Technique) return { type: 'technique', technique: local(d.Technique), level: d.Level ?? 1 };
  if (type === 'AgilityNumTechniquesLevel') return { type: 'techniques', count: d.NumTechniques ?? 1, level: d.Level ?? 1 };
  // Totals the game works out on load: journal levels, rare species and collectables found
  // (HuntingJournalComponent), and nodes unlocked in one constellation (Major/MinorNodeUnlockCountCondition).
  if (type === 'HuntingMaxLevelAnimals') return { type: 'journalLevels', level: d.Level ?? 1, count: d.Count ?? 1 };
  if (type === 'HuntingUniqueRareSpeciesFound') return { type: 'rareSpecies', count: d.Count ?? 1 };
  if (type === 'HuntingUniqueCollectablesFound') return { type: 'collectables', count: d.Count ?? 1 };
  if (type === 'AstrologyMajorNodeUnlockCount' || type === 'AstrologyMinorNodeUnlockCount') return { type: 'astrologyNodes', major: type.includes('Major'), constellation: local(d.Constellation), count: d.Count ?? 1 };
  return { type: 'other', kind: type };
}
// A task's goal, tied to the methods that progress it where the companion can time them: a recipe,
// tree, rock, fish or animal; a recipe category; gaining an item; or killing one enemy. Anything else
// keeps just its type and target count. Category ids are matched on each skill's own recipe list.
const RECIPE_REGISTRY = { Cooking: 'CookingRecipe', Woodcutting: 'WoodcuttingRecipe', Mining: 'MiningRecipe', Fishing: 'FishingRecipe', Firemaking: 'FiremakingRecipe', Farming: 'FarmingRecipe', Herblore: 'HerbloreRecipe', Thieving: 'ThievingRecipe' };
const rawRecipe = (skill, id) => (O[RECIPE_REGISTRY[skill] ?? 'ArtisanRecipe'] ?? []).find((r) => local(r.Id) === id);
function masteryGoal(g, skill) {
  const type = local(g?.Type);
  const d = g?.Data ?? {};
  const out = { type, max: d.MaxProgress ?? 1 };
  const inSkill = methods.filter((m) => m.skill === skill);
  const matching = (test) => inSkill.filter((m) => test(rawRecipe(skill, m.id) ?? {}, m)).map((m) => m.key);
  if (['WoodcuttingCutTree', 'MiningMineRock', 'FiremakingBurnRecipe', 'FishingFishRecipe', 'FarmingHarvestRecipe', 'CookRecipe', 'ArtisanCreateRecipe'].includes(type)) {
    out.methods = matching((r, m) => (!d.Recipe || m.id === local(d.Recipe)) && (!d.Category || full(r.Category) === full(d.Category)) && (!d.Subcategory || full(r.Subcategory) === full(d.Subcategory)));
    if (d.UseOutputQuantity) out.output = true;
    out.what = d.Recipe ? nameOf(d.Recipe) : nameOf(d.Subcategory ?? d.Category);
  } else if (type === 'HuntingTrapAnimal' && d.Animal && !d.WithoutFail) {
    out.methods = inSkill.filter((m) => m.id === local(d.Animal)).map((m) => m.key);
    if (d.UsingBait) out.bait = true;
    out.what = `${nameOf(d.Animal)}${d.UsingBait ? ' using bait' : ''}`;
  } else if ((type === 'HerbloreBrewPotionGroup' || type === 'HerbloreBrewPotionCategory') && (d.PotionGroup || d.Category)) {
    // Potions brewed (counted as potions made) of a group or category, at a potency.
    out.methods = matching((r) => (!d.PotionGroup || full(r.PotionGroup) === full(d.PotionGroup)) && (!d.Category || full(r.Category) === full(d.Category)) && (!d.Potency || full(r.Potency) === full(d.Potency)));
    out.output = true;
    out.what = `${nameOf(d.PotionGroup ?? d.Category)}${d.Potency ? ` (${nameOf(d.Potency)})` : ''}`;
  } else if (type === 'ArtisanCompleteStep') {
    // Steps of multi-step crafts, not whole crafts.
    out.methods = matching((r, m) => (!d.Recipe || m.id === local(d.Recipe)) && (!d.Category || full(r.Category) === full(d.Category)) && (!d.Subcategory || full(r.Subcategory) === full(d.Subcategory)));
    out.steps = true;
    out.what = `steps of ${nameOf(d.Recipe ?? d.Subcategory ?? d.Category) ?? 'any craft'}`;
  } else if (type === 'ThievingPickpocketTargetType' && d.TargetType) {
    // Counted when a target is done (ThievingActionComplete): a pickpocket, or a heist once every stage
    // is stolen. The game says "Successfully complete 10 Heists" or "Successfully steal from 300 NPCs".
    out.methods = matching((r) => full(r.RecipeType) === full(d.TargetType) && (!d.Location || full(r.Category) === full(d.Location)));
    out.verb = /heist/i.test(local(d.TargetType)) ? 'Complete' : 'Steal from';
    out.what = `${nameOf(d.TargetType)}${d.Location ? ` in ${nameOf(d.Location)}` : ''}`;
  } else if (type === 'ActionGainItem' && d.Item) {
    out.item = full(d.Item);
    out.what = nameOf(d.Item);
  } else if (['CombatKillEnemy', 'CombatDamageEnemy', 'CombatEvadeAttacks', 'CombatSingleHitDamage', 'SpendPrayerCurrency'].includes(type)) {
    // A named enemy, or any enemy within a combat level band and/or using a style; the player may have to
    // fight with a style or stance. Kills, damage dealt, attacks evaded, big hits or prayer points spent.
    // Armour conditions aren't modelled.
    const kill = {};
    for (const c of d.Conditions ?? []) {
      const ct = local(c.Type);
      const cd = c.Data ?? {};
      const who = local(cd.Component?.Component);
      if (ct === 'EnemyCombatLevelCondition') Object.assign(kill, { minLevel: cd.MinCombatLevel ?? 0, maxLevel: cd.MaxCombatLevel ?? Infinity });
      else if (ct === 'CharacterUsingCombatStyle' && local(cd.Component?.Entity) === 'Combat' && who === 'Enemy') kill.enemyStyle = local(cd.Style);
      else if (ct === 'CharacterUsingCombatStyle' && local(cd.Component?.Entity) === 'Combat' && who === 'Player') kill.style = local(cd.Style);
      else if (ct === 'CharacterUsingStance') kill.stance = local(cd.Stance);
      else kill.unknown = true;
    }
    if (!kill.unknown && (d.Enemy || d.Conditions?.length || type !== 'CombatKillEnemy')) {
      if (type !== 'CombatKillEnemy') out.measure = { CombatDamageEnemy: 'damage', CombatEvadeAttacks: 'evade', CombatSingleHitDamage: 'bigHit', SpendPrayerCurrency: 'prayer' }[type];
      if (d.MinDamage) out.minDamage = d.MinDamage;
      if (d.Enemy) out.enemy = local(d.Enemy);
      if (d.PlayerCombatStyle || kill.style) out.style = local(d.PlayerCombatStyle) || kill.style;
      if (kill.minLevel != null) Object.assign(out, { minLevel: kill.minLevel, maxLevel: Number.isFinite(kill.maxLevel) ? kill.maxLevel : null });
      if (kill.enemyStyle) out.enemyStyle = kill.enemyStyle;
      if (kill.stance) out.stance = kill.stance;
      const enemies = d.Enemy ? nameOf(d.Enemy) : [kill.enemyStyle && `${humanize(kill.enemyStyle).toLowerCase()}`, 'enemies', kill.minLevel != null && (Number.isFinite(kill.maxLevel) ? `of combat level ${kill.minLevel}–${kill.maxLevel}` : kill.minLevel > 1 ? `of combat level ${kill.minLevel}+` : '')].filter(Boolean).join(' ');
      out.what = { CombatKillEnemy: enemies, CombatDamageEnemy: `damage to ${enemies}`, CombatEvadeAttacks: `attacks from ${enemies}`, CombatSingleHitDamage: `hits of ${d.MinDamage ?? 1}+ damage on ${enemies}`, SpendPrayerCurrency: `prayer points fighting ${enemies}` }[type];
      if (kill.stance) out.what += ` in ${humanize(kill.stance)} stance`;
    }
  }
  if (out.methods && !out.methods.length) delete out.methods;
  const verb = out.verb ?? GOAL_VERBS[type];
  delete out.verb;
  if (verb && out.what) out.label = `${verb} ${out.max.toLocaleString('en-US')} ${out.what}${out.style ? ` with ${humanize(out.style)}` : ''}`;
  return out;
}
const mastery = {};
for (const [entity, cfg] of Object.entries(EC)) {
  if (!cfg.MasteryGuildTasks?.length) continue;
  const skill = local(entity);
  mastery[skill] = {
    ranks: (cfg.MasteryGuildRanks ?? []).map((x) => masteryRankById.get(full(x.Id))).filter(Boolean).map((r) => ({ id: r.Id, name: r.DisplayName, percent: r.PointPercentRequired ?? 0 })).sort((a, b) => a.percent - b.percent),
    tasks: cfg.MasteryGuildTasks.map((x) => masteryTaskById.get(full(x.Id))).filter((t) => t && !isLocked(t)).map((t) => ({
      id: t.Id,
      points: masteryCategories.get(full(t.Category))?.BasePoints ?? 1,
      ...(t.Goal ? { goal: masteryGoal(t.Goal, skill) } : {}),
      ...(t.ConditionGoal ? { condition: masteryCondition(t.ConditionGoal) } : {}),
      ...(t.TriggerGoal ? { trigger: true } : {}),
    })),
    bonuses: (cfg.MasteryGuildBonuses ?? []).map((x) => (O.MasteryGuildBonus ?? []).find((b) => full(b.Id) === full(x.Id))).filter(Boolean).map((b) => ({
      id: b.Id,
      name: b.DisplayName,
      rank: local((b.Requirements ?? []).find((q) => local(q.Type) === 'MasteryGuildRank')?.Data?.Rank),
      effects: normEffects(b.Rewards?.Bonuses).filter(notCombatMod),
      ...characterMods(b.Rewards?.Bonuses),
    })),
  };
}

// Shop
function describeBonuses(bonuses) {
  const lines = [];
  for (const m of [...(bonuses?.Global ?? []), ...(bonuses?.Component ?? [])]) {
    const stat = m.Stat?.Name ?? m.Stat ?? m.StatGroup ?? m.Name;
    if (!stat || m.Value == null) continue;
    const isPercent = /^Percent/.test(stat);
    const label = humanize(String(stat).replace(/^(Flat|Percent)/, ''));
    const value = isPercent ? `${m.Value > 0 ? '+' : ''}${Math.round(m.Value * 1000) / 10}%` : `${m.Value > 0 ? '+' : ''}${m.Value}`;
    const where = m.LocalContext?.Component?.Entity ? ` (${nameOf(m.LocalContext.Component.Entity)})` : '';
    lines.push(`${label} ${value}${where}`);
  }
  return lines;
}

const subcategoryCategory = new Map((O.ShopSubcategory ?? []).map((s) => [full(s.Id), s.Category]));
// The shop only sells the purchases its entity config lists (ShopComponent uses Config.Purchases);
// the rest are left over in the data. Older packages without the list keep everything.
const shopConfig = Object.entries(EC).find(([k]) => local(k) === 'Shop')?.[1];
const soldInShop = shopConfig?.Purchases ? new Set(shopConfig.Purchases.map((x) => full(x.Id))) : null;
const categoryById = new Map((O.ShopCategory ?? []).map((c) => [full(c.Id), c]));
// A purchase is only buyable when its Requirements and DisplayRequirements are met (ShopComponent.
// ReadyToBuyPurchases), and only shown when its category's are.
function shopRequirements(p) {
  const category = categoryById.get(full(subcategoryCategory.get(full(p.Subcategory)) ?? p.Category));
  const lists = [p.Requirements, p.DisplayRequirements, category?.Requirements, category?.DisplayRequirements];
  const seen = new Set();
  return lists.flatMap((list) => normReqs(list)).filter((r) => {
    const key = JSON.stringify(r);
    return !seen.has(key) && seen.add(key);
  });
}
const shop = [];
for (const p of O.ShopPurchase ?? []) {
  if (isLocked(p)) { skip('locked'); continue; }
  if (soldInShop && !soldInShop.has(full(p.Id))) { skip('not sold in the shop'); continue; }
  shop.push({
    id: p.Id,
    name: p.DisplayName,
    icon: imagePath(p),
    description: typeof p.Description === 'string' ? p.Description : null,
    category: nameOf(subcategoryCategory.get(full(p.Subcategory)) ?? p.Category),
    subcategory: p.Subcategory ? nameOf(p.Subcategory) : null,
    costs: { items: itemQty(p.Costs?.Items), currencies: currencyQty(p.Costs?.Currencies) },
    provides: {
      items: itemQty(p.Provides?.Items),
      currencies: currencyQty(p.Provides?.Currencies),
      bonuses: describeBonuses(p.Provides?.Bonuses),
      // The same bonuses in a form the shop planner can apply to rates.
      effects: normEffects(p.Provides?.Bonuses),
    },
    buyLimit: p.DefaultBuyLimit ?? 0,
    order: shop.length,
    requires: shopRequirements(p),
  });
}

// Skills, in the game's legacy navigation order (combat first).
const skillOrder = (O.LegacySkillNavigationOption ?? O.SkillNavigationOption ?? [])
  .map((o) => local(o.Skill ?? o.Id).replace(/^Legacy/, ''))
  .filter((s, i, a) => s && a.indexOf(s) === i);
// Names and icons come from the navigation entries: a bare id can clash ("Magic" is also a bonfire).
const skillIcons = new Map();
const skillNames = new Map();
for (const o of [...(O.SkillNavigationOption ?? []), ...(O.LegacySkillNavigationOption ?? [])]) {
  const id = local(o.Skill ?? o.Id).replace(/^Legacy/, '');
  if (!skillIcons.has(id) && imagePath(o)) skillIcons.set(id, imagePath(o));
  if (!skillNames.has(id) && typeof o.DisplayName === 'string') skillNames.set(id, o.DisplayName);
}
const skills = skillOrder.map((id) => ({ id, name: skillNames.get(id) ?? nameOf(id), combat: COMBAT_SKILLS.has(id), icon: skillIcons.get(id) ?? `res://Assets/Icons/${id}.png` }));

// Item upgrades (ItemUpgradingComponent.ExecuteUpgrade): pay the costs, get `qty` of the upgraded item.
// The bank's upgrade button stays locked until Requirements are met (SelectItemUpgradeView); every
// root item is one of the costs, so owning the costs is enough to see it.
const itemUpgrades = (O.ItemUpgrade ?? []).filter((u) => !isLocked(u)).map((u) => ({
  id: u.Id,
  item: full(u.UpgradedItem),
  qty: u.QuantityPerUpgrade ?? 1,
  costs: { items: itemQty(u.Costs?.Items), currencies: currencyQty(u.Costs?.Currencies) },
  requires: normReqs([...(u.Requirements ?? []), ...(u.DisplayRequirements ?? [])]),
}));

// The Grain Mill (FarmingGrainMillComponent): while switched on it pays one recipe's ingredients from
// its own storage every 300 s (_baseGrainMillInterval) and puts the product in the bank. Storage holds
// up to 6,000 of each item (GrainMillInventoryComponent.BaseMaxStackQuantity) plus storage upgrades.
const millData = (O.GrainMill ?? [])[0];
const grainMill = millData ? {
  name: millData.DisplayName,
  icon: imagePath(millData),
  requires: normReqs(millData.Requirements),
  storageItems: (millData.StorageItems ?? []).map(full),
  baseIntervalMs: 300_000,
  baseStorage: 6000,
  recipes: (O.GrainMillRecipe ?? []).filter((r) => !isLocked(r)).map((r) => ({
    id: r.Id,
    name: typeof r.DisplayName === 'string' ? r.DisplayName : nameOf(r.Id),
    icon: imagePath(r),
    product: { item: full(r.Product?.Item), qty: qty(r.Product) },
    ingredients: itemQty(r.Ingredients?.Items),
    xp: r.BaseExperience ?? 0,
    requires: normReqs([...(r.Requirements ?? []), ...(r.DisplayRequirements ?? [])]),
  })),
} : null;

// Which animals each enclosure takes, in the game's order: breeding checks them in this order and
// stops at the first that can't breed (ActiveRanchingEnclosure.AttemptToBreed).
for (const e of O.RanchingEnclosure ?? []) if (ranchingEnclosures[local(e.Id)]) ranchingEnclosures[local(e.Id)].animals = (e.Animals ?? []).map(local);

// Only keep items that some included piece of content references.
const CAPABILITY_TAGS = {
  Equipment: 'equipment', Weapon: 'weapon', Toolbelt: 'tool', Food: 'food', Openable: 'openable',
  HuntingTrap: 'trap', FishingBait: 'bait', Bury: 'bury', Compost: 'compost',
};
// Demo builds keep only items that included content references (no spoilers); full builds keep every item.
const filterItems = !includeLocked && lockedObjects > 50;
const referenced = new Set(findItemRefs({ methods, enemies, shop }));
for (const id of findItemRefs({ itemUpgrades, grainMill })) referenced.add(id);
const items = {};
for (const it of O.Item ?? []) {
  const id = full(it.Id);
  if (filterItems && !referenced.has(id)) continue;
  const sell = it.SellsFor ?? {};
  const caps = Array.isArray(it.Capabilities) ? it.Capabilities.map((c) => c?.Type ?? c) : Object.keys(it.Capabilities ?? {});
  const tags = [...new Set(caps.map((c) => CAPABILITY_TAGS[local(c)]).filter(Boolean))];
  const foodKey = !Array.isArray(it.Capabilities) && Object.keys(it.Capabilities ?? {}).find((k) => local(k) === 'Food');
  const heal = foodKey ? it.Capabilities[foodKey]?.BaseHealing : undefined;
  // Burying (bones, ashes) gives prayer points.
  const buryKey = !Array.isArray(it.Capabilities) && Object.keys(it.Capabilities ?? {}).find((k) => local(k) === 'Bury');
  const prayerPoints = buryKey ? it.Capabilities[buryKey]?.CurrencyGain?.Quantity : undefined;
  const name = singular(it.DisplayName, it.Id);
  const pluralName = plural(it.DisplayName, it.Id);
  items[id] = {
    name,
    ...(imagePath(it) ? { icon: imagePath(it) } : {}),
    ...(pluralName !== name ? { plural: pluralName } : {}),
    sell: sell.Quantity ?? 0,
    currency: local(sell.Currency ?? 'GoldPieces'),
    ...(tags.length ? { tags } : {}),
    ...(heal ? { heal } : {}),
    ...(prayerPoints ? { prayerPoints } : {}),
  };
  const equip = equipmentOf(it);
  if (equip) items[id].equip = equip;
  const tool = toolOf(it);
  if (tool) items[id].tool = tool;
  // A food's bonus only counts while it's the food selected in one entity's food slot (Thieving for
  // sushi's stealth, Combat for power or protection), and you have some (FoodComponent.LoadBonuses).
  // Fishing bait: its bonus while it's the bait selected and you have some; one is used per catch
  // (FishingBaitComponent). Compost: a plot's bonus for one planting, one used when applied.
  const capOf = (name) => (!Array.isArray(it.Capabilities) ? it.Capabilities?.[Object.keys(it.Capabilities ?? {}).find((k) => local(k) === name)] : null);
  const baitCap = capOf('FishingBait');
  if (baitCap) items[id].bait = { effects: normEffects(baitCap.Bonuses) };
  const compostCap = capOf('Compost');
  if (compostCap) items[id].compost = { effects: normEffects({ Component: compostCap.CompostModifierTemplate }) };
  const foodBonuses = foodKey ? it.Capabilities[foodKey]?.Bonuses : null;
  if (foodBonuses?.Component?.Entity) {
    const effects = normEffects(foodBonuses.Modifiers);
    if (effects.length) items[id].foodBonus = { entity: local(foodBonuses.Component.Entity), effects };
  }
  // Chests and other openables: what's always inside, and the table one roll picks from.
  const openKey = !Array.isArray(it.Capabilities) && Object.keys(it.Capabilities ?? {}).find((k) => local(k) === 'Openable');
  if (openKey) items[id].opens = { always: table(it.Capabilities[openKey].AlwaysDrops), table: table(it.Capabilities[openKey].DropTable) };
}

// What the completion log counts: its item order, and every enemy not flagged IgnoreCompletion.
const completionConfig = EC[full('CompletionLog')] ?? {};
const completion = {
  items: (completionConfig.ItemCompletionOrder ?? []).map((x) => full(x.Id)).filter((id) => items[id] && !itemById.get(id)?.IgnoreCompletion),
  enemies: (O.Enemy ?? []).filter((e) => !isLocked(e) && !e.IgnoreCompletion).map((e) => e.Id),
};

// Each skill's toolbelt (ToolbeltSlot, listed in the skill's ToolbeltSlots): what fits in each slot
// (a tool's `slot`) and what opens it, like a Mastery Guild rank for the second utility slot.
const slotTypes = new Map((O.ToolbeltSlotType ?? []).map((t) => [full(t.Id), t]));
const toolbeltSlots = new Map((O.ToolbeltSlot ?? []).map((s) => [full(s.Id), s]));
const toolbelts = {};
for (const [entity, cfg] of Object.entries(EC)) {
  const slots = (cfg.ToolbeltSlots ?? []).map((x) => toolbeltSlots.get(full(x.Id))).filter((s) => s && !isLocked(s));
  if (!slots.length) continue;
  toolbelts[local(entity)] = slots.map((s) => ({
    id: local(s.Id),
    name: s.DisplayName,
    fits: local(s.FitsType),
    category: local(slotTypes.get(full(s.FitsType))?.Category) ?? null,
    requires: normReqs(s.UnlockRequirements),
  }));
}

const currencies = Object.fromEntries((O.Currency ?? []).map((c) => [local(c.Id), { name: c.DisplayName, icon: imagePath(c) }]));
if (!currencies.GoldPieces) currencies.GoldPieces = { name: 'GP' };

const bySkill = {};
for (const m of methods) bySkill[m.skill] = (bySkill[m.skill] ?? 0) + 1;

const data = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: basename(packagePath),
    namespace: NS,
    includeLocked,
    mechanics: MECHANICS,
    counts: { items: Object.keys(items).length, methods: methods.length, enemies: enemies.length, areas: areas.length, shop: shop.length, bySkill },
  },
  skills,
  currencies,
  items,
  methods,
  enemies,
  areas,
  combat,
  pets,
  completion,
  unlocks,
  mastery,
  agilityTechniques,
  quests,
  shop,
  toolbelts,
  thievingBonuses,
  huntingJournalBonuses,
  astrology,
  bonfires,
  auroras,
  astrologyEvents,
  huntingCollectables,
  itemUses,
  ranchingVariants: ranchingVariantBonuses,
  ranchingEnclosures,
  mining,
  itemUpgrades,
  grainMill,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data));

const kb = Math.round(Buffer.byteLength(JSON.stringify(data)) / 1024);
console.log(`Built ${outPath} (${kb} KB) from ${basename(packagePath)}${includeLocked ? ' [locked content INCLUDED]' : ''}`);
console.log(`  level cap ${MECHANICS.levelCap}${capIndex >= 0 ? ' (from --level-cap)' : lockedObjects > 50 ? ' (demo build)' : ' (full build)'}`);
console.log(`  methods ${methods.length}  enemies ${enemies.length}  areas ${areas.length}  shop ${shop.length}  items ${Object.keys(items).length}/${itemIds.size}`);
console.log(`  by skill: ${Object.entries(bySkill).map(([s, n]) => `${s} ${n}`).join(', ')}`);
console.log(`  skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
