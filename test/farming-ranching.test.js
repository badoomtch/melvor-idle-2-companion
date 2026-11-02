// Farming plots and the ranch: the save readers (against fake saves in the game's layout), the models
// built on them, and the alerts they drive.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { farmingPlots, plotRanges } from '../engine/farming-plots.js';
import { createGameData } from '../engine/gamedata.js';
import { hourlyProduct, ranchModel } from '../engine/ranch.js';
import { createAlertWatcher } from '../server/alerts.js';
import { parseSave, TICK_MS } from '../server/save-reader.js';
import { buildSave } from './save-writer.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const TICK = 1_000_000; // the timer queues' current tick
const MIN = 60_000;

// QueuedTimer.WriteTo (running): bool auto-restart, int32 state, int32 wait ticks, int64 scheduled, int32 paused.
const queued = (w, ticksLeft, wait = 864_000) => w.bool(false).i32(2).i32(wait).i64(TICK + ticksLeft).i32(0);
// TickTimer.WriteTo: bool auto-restart, int32 state, int32 wait ticks, int32 ticks left.
const tickTimer = (w, ticksLeft, wait = 216_000) => w.bool(true).i32(2).i32(wait).i32(ticksLeft);
const optional = (w, id) => (id ? w.bool(true).str(id) : w.bool(false));

// ActiveFarmingPlot.WriteTo, then the state's own fields.
function writePlot(w, p) {
  w.bool(!!p.watered).bool(false).bool(!!p.autoHarvest).bool(false).bool(false);
  optional(w, p.recipe && `MelvorBase:${p.recipe}`);
  optional(w, null);
  optional(w, p.compost && `MelvorBase:${p.compost}`);
  w.i32(['locked', 'empty', 'growing', 'grown', 'regrowing', 'bonus'].indexOf(p.state));
  if (p.recipe && p.state !== 'locked' && p.state !== 'empty') w.str(`MelvorBase:${p.recipe}`);
  if (['growing', 'regrowing', 'bonus'].includes(p.state)) queued(w, p.ticksLeft);
  if (p.state === 'grown') w.i32(p.qty).str(`MelvorBase:${p.recipe}`);
  if (p.state === 'grown' || p.state === 'regrowing') w.i32(p.regrows ?? 0);
}

const farmingEntity = (plots) => ['MelvorBase:Farming', [['Passive', (w) => {
  w.bool(true).str('MelvorBase:Allotments');
  w.i64(TICK);
  w.i32(plots.length);
  for (const p of plots) w.str(`MelvorBase:${p.id}`).region((g) => writePlot(g, p));
}]]];

// ActiveRanchingAnimal.WriteTo.
function writeAnimal(w, a) {
  w.bool(!!a.sick).f64(a.hunger ?? 1).f64(a.safety ?? 1).f64(a.satisfaction ?? 0.94).bool(!!a.wantsPets).i32(3);
  w.str(`MelvorBase:${a.variant}`);
  w.i32(1).bool(false).str('MelvorBase:Corn');
  w.f64(a.life).f64(a.grow ?? -100).f64(1000);
}

// RanchingPassiveComponent.WriteTo with one land per entry: [] = not bought, else { enclosure, animals }.
const ranchingEntity = (lands) => ['MelvorBase:Ranching', [['Passive', (w) => {
  for (let i = 0; i < 4; i++) tickTimer(w, 36 * 60 * 60); // 36 minutes to the next maintenance, food, products, treats
  for (let i = 0; i < 9; i++) w.bool(true);
  w.i64(TICK);
  w.i32(lands.length);
  lands.forEach((l, i) => {
    w.str(`MelvorBase:Land${i + 1}`).region((g) => {
      g.bool(!!l.enclosure).bool(!!l.enclosure);
      if (!l.enclosure) return;
      g.str(`MelvorBase:${l.enclosure}`).region((e) => {
        queued(e, 1000, 216_000);
        e.f64(l.maintenance ?? 1);
        e.i32(l.animals.length);
        for (const a of l.animals) e.str(`MelvorBase:${a.species}`).region((x) => writeAnimal(x, a));
        e.i32((l.autoBuy ?? []).length);
        for (const s of l.autoBuy ?? []) e.str(`MelvorBase:${s}`);
        queued(e, 30 * 60, 3600); // the minute timer: 30 seconds to its next tick
        e.i32(0);
      });
    });
  });
  w.i32(1).i32(4).str('MelvorBase:ChickenAdult');
  w.i32(1).str('MelvorBase:Mealworm');
  w.i32(0);
}]]];

const FARM = [
  { id: 'Allotment1', state: 'growing', recipe: 'Garlic', ticksLeft: 60 * 60 * 47, watered: true, compost: 'Fertiliser' },
  { id: 'Allotment2', state: 'grown', recipe: 'Potato', qty: 50 },
  { id: 'Allotment3', state: 'locked' },
  { id: 'Allotment4', state: 'locked' },
  { id: 'Herb1', state: 'empty' },
  { id: 'Tree1', state: 'regrowing', recipe: 'OakTree', ticksLeft: 60 * 60 * 90, regrows: 2, autoHarvest: true },
  { id: 'Flower1', state: 'bonus', recipe: 'Sunflower', ticksLeft: 60 * 60 * 10 },
];
const RANCH = [
  { enclosure: 'ChickenCoopI', autoBuy: [], animals: [{ species: 'Chicken', variant: 'ChickenAdult', life: 40 }, { species: 'Chicken', variant: 'ChickenChild', life: 3000, grow: 120 }] },
  {},
  { enclosure: 'CowSheepEnclosureII', maintenance: 0.6, autoBuy: ['Cow'], animals: [{ species: 'Cow', variant: 'CowAdult', life: 30, hunger: 0.9, satisfaction: 0.44 }] },
];
const save = (extra = {}) => parseSave(buildSave({ version: 28, timestamp: T0, skills: { Mining: { xp: 0, level: 1 } }, extraEntities: [farmingEntity(FARM), ranchingEntity(RANCH)], ...extra }));

test('reads every farming plot: state, crop, time left, regrows and care', () => {
  const s = save();
  assert.deepEqual(s.warnings, []);
  assert.equal(s.farming.category, 'Allotments');
  assert.equal(s.farming.tick, TICK);
  const [garlic, potato, locked, , empty, oak, flower] = s.farming.plots;
  assert.equal(TICK_MS, 1000 / 60);
  assert.deepEqual({ ...garlic, timer: undefined }, { id: 'Allotment1', watered: true, auto: { plant: false, harvest: false, compost: false, water: false }, selected: 'Garlic', selectedCompost: null, compost: 'Fertiliser', state: 'growing', recipe: 'Garlic', timer: undefined });
  assert.equal(Math.round(garlic.timer.msLeft), 47 * MIN, 'scheduled tick minus the queue tick, at 60 ticks a second');
  assert.equal(Math.round(garlic.timer.waitMs), 4 * 60 * MIN);
  assert.deepEqual([potato.state, potato.product, potato.regrowsRemaining], ['grown', { item: 'MelvorBase:Potato', qty: 50 }, 0]);
  assert.equal(locked.state, 'locked');
  assert.equal(empty.state, 'empty');
  assert.deepEqual([oak.state, oak.regrowsRemaining, oak.auto.harvest, Math.round(oak.timer.msLeft)], ['regrowing', 2, true, 90 * MIN]);
  assert.equal(flower.state, 'bonus');
});

test('reads the herd: land, enclosures, animals and their state', () => {
  const r = save().ranching;
  assert.equal(Math.round(r.timers.product), 36 * MIN);
  assert.deepEqual(r.land.map((l) => [l.id, l.purchased, l.enclosure?.id ?? null]), [['Land1', true, 'ChickenCoopI'], ['Land2', false, null], ['Land3', true, 'CowSheepEnclosureII']]);
  const [adult, child] = r.land[0].enclosure.animals;
  assert.deepEqual([adult.species, adult.variant, adult.lifespanMinutes, adult.treats], ['Chicken', 'ChickenAdult', 40, { Corn: false }]);
  assert.equal(child.variantMinutes, 120);
  assert.equal(Math.round(r.land[0].enclosure.minuteTimerMs), 30_000);
  assert.deepEqual([r.land[2].enclosure.maintenance, r.land[2].enclosure.autoBuy], [0.6, ['Cow']]);
  assert.deepEqual(r.variantsSeen, { ChickenAdult: 4 });
  assert.deepEqual(r.blockedTreats, ['Mealworm']);
});

test('a broken farming or ranching region is a warning, not a crash, and the rest still reads', () => {
  const bad = ['MelvorBase:Farming', [['Passive', (w) => w.bool(false).i64(TICK).i32(1).str('MelvorBase:Allotment1').region((g) => g.bool(true).i32(7))]]];
  const s = parseSave(buildSave({ version: 28, skills: { Mining: { xp: 0, level: 1 } }, extraEntities: [bad] }));
  assert.equal(s.farming, undefined);
  assert.match(s.warnings.join(), /Farming plots/);
  assert.equal(s.skills.Mining.level, 1);
});

test('plot times count down from the save time; ready, harvesting itself and next', () => {
  const s = save();
  const at = farmingPlots(gd, s, T0);
  assert.deepEqual(at.plots.map((p) => p.status), ['growing', 'ready', 'locked', 'locked', 'empty', 'growing', 'bonus']);
  assert.equal(at.plots[0].name, 'Allotment 1');
  assert.equal(at.plots[0].category, 'Allotments');
  assert.equal(at.plots[5].category, 'Trees');
  assert.equal(at.next.id, 'Allotment1');
  assert.equal(at.ready.map((p) => p.id).join(), 'Allotment2');
  // 50 minutes after the save the garlic is ready; an hour and a half later the oak harvests itself.
  const later = farmingPlots(gd, s, T0 + 50 * MIN);
  assert.equal(later.plots[0].status, 'ready');
  assert.equal(later.plots[0].msLeft, 0);
  assert.equal(farmingPlots(gd, s, T0 + 91 * MIN).plots[5].status, 'harvesting');
  assert.equal(plotRanges(at.plots.filter((p) => p.state === 'locked')), 'Allotment 3-4');
});

test('ranch output: the game rounds each product total down once an hour', () => {
  // One chicken at 96% happiness makes 0.96 raw chicken: rounded down, nothing.
  assert.deepEqual(hourlyProduct([{ q: 0.96, p: 0 }]), { expected: 0, guaranteed: 0, unrounded: 0.96 });
  assert.equal(hourlyProduct(Array(5).fill({ q: 0.96, p: 0 })).expected, 4);
  // A 50% doubling chance: 0.96 (0) or 1.92 (1), so half a raw chicken an hour on average.
  assert.equal(hourlyProduct([{ q: 0.96, p: 0.5 }]).expected, 0.5);
  // Two animals, different amounts: 0.5 + 0.7 = 1.2, or 1.7 / 1.9 / 2.4 with doubles.
  const two = hourlyProduct([{ q: 0.5, p: 0.5 }, { q: 0.7, p: 0.5 }]);
  assert.ok(Math.abs(two.expected - (0.25 * 1 + 0.25 * 1 + 0.25 * 1 + 0.25 * 2)) < 1e-9);
});

test('the herd model: happiness, children, products after rounding, food and what needs attention', () => {
  const r = ranchModel(gd, save(), { now: T0, bonuses: [] });
  assert.equal(r.animals, 3);
  const [adult, child] = r.enclosures[0].animals;
  // fed (0.3) + safe (0.3) + satisfaction 0.94 × 0.4
  assert.ok(Math.abs(adult.happiness - 0.976) < 1e-9);
  assert.equal(child.child, true);
  const chicken = gd.methodByKey.get('Ranching/Chicken');
  const egg = chicken.products.find((p) => p.item === 'MelvorBase:Egg').qty;
  assert.ok(Math.abs(child.products.find((p) => p.item === 'MelvorBase:Egg').qty - egg * 0.5 * 0.976) < 1e-9, 'children make half');
  assert.ok(Math.abs(child.xp - chicken.xp * 0.5 * 0.976) < 1e-9);
  // Unsafe below 75% upkeep: the cow's safety counts as 0.6, and its satisfaction is low.
  const cow = r.enclosures[1].animals[0];
  assert.ok(Math.abs(cow.happiness - (0.9 * 0.3 + 0.6 * 0.3 + 0.44 * 0.4)) < 1e-9);
  const rawChicken = r.hourly.products.find((p) => p.item === 'MelvorBase:RawChicken');
  assert.equal(rawChicken.perHour, Math.floor(1 * 0.976 + 0.5 * 0.976));
  assert.ok(r.hourly.food.some((f) => f.item === 'MelvorBase:Grain' && f.perHour === 20));
  // The adult chicken dies in 30 s + 39 min; the cow is replaced by auto-buy.
  assert.equal(adult.deathAt, T0 + 30_000 + 39 * MIN);
  const kinds = r.attention.map((a) => `${a.land}:${a.kind}`);
  assert.deepEqual(kinds, ['Land1:old', 'Land3:hungry', 'Land3:old', 'Land3:repair']);
  assert.equal(r.attention.find((a) => a.land === 'Land3' && a.kind === 'old').replaced, true);
  assert.equal(Math.round(r.nextProductsAt - T0), 36 * MIN);
});

test('harvest alerts: once per harvest, between autosaves too, and never for what was ready at start-up', () => {
  let now = T0;
  const dir = mkdtempSync(join(tmpdir(), 'mc-farm-'));
  const sent = [];
  const w = createAlertWatcher({ gd, dir, notify: (title, body) => sent.push(`${title} | ${body}`), now: () => now });
  w.setSettings({ enabled: true, stopped: false });
  const first = save();
  w.onSave('a', null, first); // the potato was already grown: not news
  w.onSave('a', first, first);
  assert.deepEqual(sent.filter((x) => /harvest/.test(x)), []);
  now = T0 + 48 * MIN; // the garlic is ready with no new autosave (the game is closed)
  w.tick();
  w.tick();
  assert.deepEqual(sent.filter((x) => /harvest/.test(x)), ['Garlic is ready to harvest | Allotment 1']);
  now = T0 + 95 * MIN; // the oak harvests itself: no alert
  w.tick();
  assert.equal(sent.filter((x) => /harvest/.test(x)).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('ranch alerts: hungry and dying of age without auto-buy, each once until it clears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ranch-'));
  const sent = [];
  const w = createAlertWatcher({ gd, dir, notify: (title, body) => sent.push(`${title} | ${body}`), now: () => T0 });
  w.setSettings({ enabled: true, stopped: false, harvests: false });
  const calm = parseSave(buildSave({ version: 28, timestamp: T0, extraEntities: [ranchingEntity([{ enclosure: 'ChickenCoopI', animals: [{ species: 'Chicken', variant: 'ChickenAdult', life: 3000 }] }])] }));
  const s = save();
  w.onSave('a', null, calm);
  w.onSave('a', calm, s);
  w.onSave('a', s, s);
  assert.equal(sent.length, 1, 'combined into one notification');
  assert.equal(sent[0], '2 updates from Melvor | Dying of old age within the hour · An animal is hungry');
  rmSync(dir, { recursive: true, force: true });
});
