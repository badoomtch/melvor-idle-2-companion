// Item upgrades, the Grain Mill and ranch breeding: the data, the lookup index, completion and gear
// upgrades, the Grain Mill save reader (against fake saves in the game's layout) and the models.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { producerIndex } from '../engine/advisor.js';
import { ownedEquipment, recommendStyle } from '../engine/combat.js';
import { quickestSource } from '../engine/completion.js';
import { createGameData } from '../engine/gamedata.js';
import { gearUpgrades } from '../engine/gear-upgrades.js';
import { grainMillModel, millRecipeRates } from '../engine/grain-mill.js';
import { upgradeNeeds } from '../engine/item-upgrades.js';
import { itemDetails } from '../engine/lookup.js';
import { ranchModel } from '../engine/ranch.js';
import { parseSave, TICK_MS } from '../server/save-reader.js';
import { buildSave } from './save-writer.js';

const raw = JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8'));
const gd = createGameData(raw);
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);
const withPlayer = (player, fn) => {
  gd.player = { toolbelts: {}, owned: {}, ...player };
  try {
    return fn();
  } finally {
    gd.player = null;
  }
};

// ---------- Item upgrades ----------

test('item upgrades are sources and uses, and are the only source of 114 items', () => {
  assert.equal(gd.raw.itemUpgrades.length, 124);
  const only = gd.raw.itemUpgrades.filter((u) => itemDetails(gd, u.item).sources.every((s) => s.type === 'upgrade'));
  assert.equal(only.length, 114);
  // Thieving's locked chests need keys, made from two halves.
  const key = itemDetails(gd, 'MelvorBase:ThugChestKey').sources.find((s) => s.type === 'upgrade');
  assert.deepEqual(key.upgrade.costs.items.map((i) => i.item), ['MelvorBase:ThugChestKeyHalfA', 'MelvorBase:ThugChestKeyHalfB']);
  assert.ok(itemDetails(gd, 'MelvorBase:ThugChestKeyHalfA').uses.some((u) => u.type === 'upgrade' && u.upgrade.item === 'MelvorBase:ThugChestKey' && u.qty === 1));
  // Requirements are the bank button's lock; arrows come 150 at a time.
  assert.deepEqual(gd.raw.itemUpgrades.find((u) => u.id === 'SanguineVortexStaff').requires, [{ type: 'level', skill: 'Magic', level: 92 }]);
  assert.equal(gd.raw.itemUpgrades.find((u) => u.id === 'StingerArrow').qty, 150);
  assert.deepEqual(gd.raw.itemUpgrades.find((u) => u.id === 'MithrilHelmetU').costs.currencies, [{ currency: 'GoldPieces', qty: 5000 }]);
});

test('a method\'s events (Astrology and Firemaking finds) give their items a source', () => {
  const method = { ...gd.methods.find((m) => m.skill === 'Astrology'), key: 'Astrology/TestFinds', events: [{ item: 'MelvorBase:ThugChestKey', chance: 0.01, qty: 1 }] };
  const g = createGameData({ ...raw, methods: [...raw.methods, method] });
  assert.ok(itemDetails(g, 'MelvorBase:ThugChestKey').sources.some((s) => s.type === 'method' && s.method.key === 'Astrology/TestFinds'));
});

test('completion: an upgrade is quickest when you hold its costs; gold, levels and drops you lack block it', () => {
  const levels = at(99);
  const halves = { 'MelvorBase:ThugChestKeyHalfA': 1, 'MelvorBase:ThugChestKeyHalfB': 1 };
  const key = quickestSource(gd, 'MelvorBase:ThugChestKey', { levels, wallet: { GoldPieces: 0 }, stock: halves });
  assert.equal(key.best.type, 'upgrade');
  assert.equal(key.best.hours, 0);
  // Half B only drops, so without it there's nothing to gather.
  const half = quickestSource(gd, 'MelvorBase:ThugChestKey', { levels, wallet: { GoldPieces: 0 }, stock: { 'MelvorBase:ThugChestKeyHalfA': 1 } });
  assert.notEqual(half.best?.type, 'upgrade');
  assert.deepEqual(half.blockers.find((b) => b.type === 'upgrade').materials, ['MelvorBase:ThugChestKeyHalfB']);

  const costs = { 'MelvorBase:MithrilHelmet': 1, 'MelvorBase:GoldBar': 40, 'MelvorBase:SilverBar': 30, 'MelvorBase:MithrilBar': 10 };
  const rich = quickestSource(gd, 'MelvorBase:MithrilHelmetU', { levels, wallet: { GoldPieces: 1e6 }, stock: costs });
  assert.equal(rich.best.type, 'upgrade');
  assert.equal(rich.best.hours, 0);
  const poor = quickestSource(gd, 'MelvorBase:MithrilHelmetU', { levels, wallet: { GoldPieces: 100 }, stock: costs });
  assert.equal(poor.best, null);
  assert.deepEqual(poor.blockers[0].currency, [{ currency: 'GoldPieces', need: 5000, have: 100, short: 4900 }]);
  // No gold bars: smelt them first, and the time says so.
  const smelt = quickestSource(gd, 'MelvorBase:MithrilHelmetU', { levels, wallet: { GoldPieces: 1e6 }, stock: { ...costs, 'MelvorBase:GoldBar': 0 } }).best;
  assert.equal(smelt.type, 'upgrade');
  assert.equal(smelt.gather[0].item, 'MelvorBase:GoldBar');
  assert.ok(smelt.hours > 0 && smelt.hours === smelt.gatherHours);

  const staff = quickestSource(gd, 'MelvorBase:SanguineVortexStaff', { levels: { ...levels, Magic: 50 }, wallet: {}, stock: { 'MelvorBase:SanguisCrystal': 1, 'MelvorBase:BloodSpikesStaff': 1 } });
  assert.equal(staff.best, null);
  assert.deepEqual(staff.blockers.find((b) => b.type === 'upgrade').missing, [{ type: 'level', skill: 'Magic', level: 92 }]);
});

test('upgradeNeeds counts several upgrades at once and what each material takes', () => {
  const stinger = gd.raw.itemUpgrades.find((u) => u.id === 'StingerArrow');
  const stock = new Map([['MelvorBase:SteelArrows', 300], ['MelvorBase:Stinger', 1]]);
  const two = upgradeNeeds(gd, stinger, { levels: at(40), stock, wallet: {}, times: 2 });
  assert.equal(two.ok, true);
  assert.equal(two.ready, false, 'one stinger short, and no way to gather it here');
  assert.deepEqual(two.cantGather, ['MelvorBase:Stinger']);
  assert.equal(upgradeNeeds(gd, stinger, { levels: at(40), stock, wallet: {} }).ready, true);
  assert.equal(upgradeNeeds(gd, stinger, { levels: at(20), stock, wallet: {} }).ok, false, 'needs Ranged 30');
});

test('gear upgrades, with item upgrades on: an upgrade you can do now is a way to better gear', () => {
  const levels = at(45);
  const bank = { 'MelvorBase:YewBow': 1, 'MelvorBase:SteelArrows': 5000, 'MelvorBase:Stinger': 50, 'MelvorBase:Shrimp': 5000 };
  const owned = ownedEquipment(gd, bank, null);
  const rec = recommendStyle(gd, { style: 'Ranged', owned, levels, bank, food: 'MelvorBase:Shrimp' });
  assert.ok(rec?.gear?.enemy);
  const index = producerIndex(gd, levels);
  const run = (gp, itemUpgrades) => gearUpgrades(gd, { rec, owned, levels, bank, food: 'MelvorBase:Shrimp', index, wallet: { GoldPieces: gp }, itemUpgrades });
  assert.ok(![...run(1e6, false).ready, ...run(1e6, false).soon].some((r) => r.source.type === 'upgrade'), 'off by default');
  const on = run(1e6, true);
  const arrows = on.ready.find((r) => r.item === 'MelvorBase:StingerArrow');
  assert.equal(arrows.source.type, 'upgrade');
  assert.equal(arrows.source.times, Math.ceil(arrows.qty / 150), 'an hour of arrows, 150 an upgrade');
  assert.equal(arrows.source.hours, 0, 'steel arrows and stingers are in the bank');
  // Without gold, only upgrades that cost none are left.
  for (const r of run(0, true).ready.filter((x) => x.source.type === 'upgrade')) assert.equal(r.source.upgrade.costs.currencies.length, 0);
});

// ---------- Grain Mill ----------

const TICKS = (ms) => Math.round(ms / TICK_MS);
// FarmingGrainMillComponent.WriteTo and GrainMillInventoryComponent.WriteTo (a StackableInventory).
const farmingEntity = ({ active = true, state = 2, ticksLeft = TICKS(60_000), recipe = 'BasicGrain', storage = {} }) => ['MelvorBase:Farming', [
  ['GrainMillInventory', (w) => {
    w.i32(0x7fffffff).i32(0).i32(0x7fffffff).bool(true).bool(false);
    w.i32(Object.keys(storage).length);
    for (const [item, qty] of Object.entries(storage)) w.i32(qty).bool(false).bool(false).str(item);
  }],
  ['GrainMill', (w) => {
    w.bool(active);
    w.bool(false).i32(state).i32(TICKS(300_000)).i32(ticksLeft);
    if (recipe) w.bool(true).str(`MelvorBase:${recipe}`);
    else w.bool(false);
    w.bool(true).i32(0).str('MelvorBase:Grain');
  }],
]];
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const millSave = (mill, extra = {}) => ({
  ...parseSave(buildSave({ version: 28, timestamp: T0, skills: { Mining: { xp: 0, level: 1 } }, extraEntities: [farmingEntity(mill)] })),
  shopPurchases: { GrainMill: 1 },
  bank: { items: { 'MelvorBase:Wheat': 1000 } },
  ...extra,
});

test('reads the Grain Mill: switched on, its timer, the recipe and what\'s in its storage', () => {
  const s = millSave({ storage: { 'MelvorBase:Wheat': 125, 'MelvorBase:Sugarcane': 6000 } });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.grainMill.active, true);
  assert.equal(s.grainMill.recipe, 'BasicGrain');
  assert.equal(s.grainMill.timer.state, 'running');
  close(s.grainMill.timer.msLeft, 60_000, 1e-6);
  close(s.grainMill.timer.waitMs, 300_000, 1e-6);
  assert.deepEqual(s.grainMill.storage, { 'MelvorBase:Wheat': 125, 'MelvorBase:Sugarcane': 6000 });
  assert.deepEqual(s.grainMill.ready, { item: 'MelvorBase:Grain', qty: 0 });
  const off = millSave({ active: false, state: 0, ticksLeft: 0, recipe: null });
  assert.deepEqual(off.warnings, []);
  assert.equal(off.grainMill.recipe, null);
  assert.equal(off.grainMill.timer.state, 'stopped');
});

test('the Grain Mill model: output an hour, how long the storage lasts, how full it is', () => {
  const s = millSave({ storage: { 'MelvorBase:Wheat': 125, 'MelvorBase:Sugarcane': 6000 } });
  const m = grainMillModel(gd, s, { bonuses: [], now: T0 });
  assert.equal(m.running, true);
  assert.equal(m.recipe.id, 'BasicGrain');
  assert.equal(m.rates.intervalMs, 300_000);
  assert.equal(m.rates.perHour, 240, '20 grain every 5 minutes');
  assert.deepEqual(m.rates.inputsPerHour, [{ item: 'MelvorBase:Wheat', perHour: 120 }]);
  // 125 wheat pays for 12 batches: the next in a minute, then 11 more 5 minutes apart.
  assert.equal(m.batches, 12);
  close(m.hoursLeft, (60_000 + 11 * 300_000) / 3_600_000, 1e-6);
  const wheat = m.storage.find((x) => x.item === 'MelvorBase:Wheat');
  assert.deepEqual([wheat.capacity, wheat.used, wheat.bank], [6000, true, 1000]);
  assert.equal(m.storage.find((x) => x.item === 'MelvorBase:Sugarcane').share, 1);
  // Topped up from the bank: 1,125 wheat is 112 batches.
  assert.equal(m.topUp.batches, 112);
});

test('the Grain Mill says why it stopped, and takes its shop upgrades', () => {
  const reason = (mill, extra) => grainMillModel(gd, millSave(mill, extra), { bonuses: [] }).reason;
  assert.equal(reason({ active: false, state: 0, storage: { 'MelvorBase:Wheat': 2 } }), 'empty');
  assert.equal(reason({ active: false, state: 0, storage: { 'MelvorBase:Wheat': 50 } }), 'off');
  assert.equal(reason({ active: false, state: 0, recipe: null }), 'none');
  assert.equal(reason({ active: false, state: 0 }, { shopPurchases: {} }), 'locked');
  // Production Upgrade I (+25% product) and Storage Upgrade I (+18,000 a crop), from the shop's own data.
  const shop = (id) => gd.shopById.get(id).provides.effects;
  const bonuses = [...shop('GrainMillProductionUpgradeI'), ...shop('GrainMillStorageUpgradeI')];
  const m = grainMillModel(gd, millSave({ storage: { 'MelvorBase:Wheat': 100 } }), { bonuses });
  assert.equal(m.rates.product.qty, 25);
  assert.equal(m.capacity, 24_000);
  // Farming's own crops don't take the mill's bonuses.
  assert.equal(millRecipeRates(gd, gd.raw.grainMill.recipes.find((r) => r.id === 'FineGrain'), []).product.qty, 240);
});

test('the Grain Mill covers the ranch\'s grain, and its products have it as a source', () => {
  const ranch = { hourly: { food: [{ item: 'MelvorBase:Grain', perHour: 30 }, { item: 'MelvorBase:Mealworm', perHour: 5 }] } };
  const m = grainMillModel(gd, millSave({ storage: { 'MelvorBase:Wheat': 100 } }), { bonuses: [], ranch });
  assert.deepEqual(m.feeds, [{ item: 'MelvorBase:Grain', eats: 30, makes: 240, covers: 8 }]);
  const grain = itemDetails(gd, 'MelvorBase:Grain');
  assert.deepEqual(grain.sources.filter((s) => s.type === 'mill').map((s) => s.recipe.id), ['BasicGrain', 'QualityGrain', 'HighQualityGrain', 'FineGrain']);
  assert.ok(itemDetails(gd, 'MelvorBase:Wheat').uses.some((u) => u.type === 'mill' && u.recipe.id === 'Flour' && u.qty === 10));
  // Completion: a batch of flour once you own the mill, after any wheat you're short of.
  const levels = { ...at(1), Farming: 10 };
  const flour = (purchases, stock) => withPlayer({ shopPurchases: purchases }, () => quickestSource(gd, 'MelvorBase:Flour', { levels, stock }));
  const milled = flour({ GrainMill: 1 }, { 'MelvorBase:Wheat': 10 }).best;
  assert.equal(milled.type, 'mill');
  close(milled.hours, 300 / 3600);
  assert.ok(flour({}, { 'MelvorBase:Wheat': 10 }).blockers.some((b) => b.type === 'mill' && b.missing.some((r) => r.type === 'purchase')));
});

// ---------- Ranch breeding ----------

const animal = (species, extra = {}) => ({ species, variant: `${species}Adult`, sick: false, hunger: 1, safety: 1, satisfaction: 1, wantsPets: false, lifespanMinutes: 3000, variantMinutes: -1, petMinutes: 100, treats: {}, ...extra });
const ranchSave = (enclosures) => ({
  header: { timestamp: T0 },
  bank: { items: {} },
  ranching: { timers: {}, landOrder: [], land: enclosures.map(([id, animals], i) => ({ id: `Land${i + 1}`, purchased: true, enclosure: { id, maintenance: 1, animals, autoBuy: [], upgrades: [], minuteTimerMs: 30_000 } })) },
});
const births = (enclosures) => ranchModel(gd, ranchSave(enclosures), { bonuses: [], now: T0 }).births;

test('breeding: 0.01% an hour for each happy animal, times their average happiness, while there\'s room', () => {
  const [three] = births([['ChickenCoopIII', [animal('Chicken'), animal('Chicken'), animal('Chicken')]]]);
  assert.deepEqual([three.count, three.eligible, three.reason], [3, 3, null]);
  close(three.perHour, 0.0003);
  close(three.everyHours, 1 / 0.0003);
  // A hungry chicken is at 70% happiness: it doesn't count, but it lowers the average.
  const [hungry] = births([['ChickenCoopIII', [animal('Chicken'), animal('Chicken'), animal('Chicken', { hunger: 0 })]]]);
  assert.equal(hungry.eligible, 2);
  close(hungry.happiness, 2.7 / 3);
  close(hungry.perHour, 0.0001 * 2 * 0.9);
  // A newborn makes half until it grows up (9.6 hours for a chicken).
  assert.equal(three.child.hours, 9.6);
  assert.deepEqual(three.child.products.map((p) => [p.item, p.perHour]), gd.methodByKey.get('Ranching/Chicken').products.map((p) => [p.item, p.qty / 2]));
});

test('breeding: two of a kind, room for one more, and species are checked in the game\'s order', () => {
  const reasons = (enclosures) => births(enclosures).map((b) => [b.species, b.reason, b.blockedBy]);
  // A coop for 2 is full as soon as there are 2.
  assert.deepEqual(reasons([['ChickenCoopI', [animal('Chicken'), animal('Chicken')]]]), [['Chicken', 'small', null]]);
  assert.deepEqual(reasons([['ChickenCoopIII', [animal('Chicken')]]]), [['Chicken', 'few', null]]);
  assert.deepEqual(reasons([['ChickenCoopIII', Array.from({ length: 4 }, () => animal('Chicken'))]]), [['Chicken', 'full', null]]);
  assert.deepEqual(reasons([['ChickenCoopIII', [animal('Chicken', { hunger: 0 }), animal('Chicken', { hunger: 0 })]]]), [['Chicken', 'unhappy', null]]);
  // The pasture checks sheep before cows and stops at the first that can't breed.
  assert.deepEqual(gd.raw.ranchingEnclosures.CowSheepEnclosureIV.animals, ['Sheep', 'Cow']);
  assert.deepEqual(reasons([['CowSheepEnclosureIV', [animal('Cow'), animal('Cow')]]]), [['Cow', 'skipped', 'Sheep']]);
  const both = births([['CowSheepEnclosureIV', [animal('Cow'), animal('Cow'), animal('Sheep'), animal('Sheep')]]]);
  assert.deepEqual(both.map((b) => [b.species, b.reason]), [['Sheep', null], ['Cow', null]]);
  for (const b of both) close(b.perHour, 0.0002);
  // Five of five: each still rolls, but a baby has nowhere to go.
  assert.deepEqual(reasons([['CowSheepEnclosureIV', [animal('Cow'), animal('Cow'), animal('Cow'), animal('Sheep'), animal('Sheep')]]]), [['Sheep', 'room', null], ['Cow', 'room', null]]);
});
