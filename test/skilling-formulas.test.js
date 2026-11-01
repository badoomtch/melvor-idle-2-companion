// Skilling rates against the game's own formulas (0.11.4): each test is one rule from the game's code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { computeRates, miningExpectedHits, woodcuttingHits } from '../engine/rates.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const method = (key) => gd.methodByKey.get(key);
const bonus = (m, stat, value, scope) => ({ stat, value, skill: m.skill, ...(scope ? { scope } : {}) });
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const out = (r, item) => r.outputs.find((o) => o.item === item)?.perHour ?? 0;

test('thieving: a failure hits for 1 to the max damage, so the average is (max + 1) / 2', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && x.damage > 10 && x.perception > 50);
  const r = computeRates(gd, m, m.level, { bonuses: [] });
  const s = r.successChance;
  close(r.hpLossPerHour / r.cyclesPerHour, (1 - s) * ((m.damage + 1) / 2));
});

test('thieving: heist bonuses take stages off, and fortune adds to every drop', () => {
  const m = method('Thieving/ForbiddenLibrary');
  const base = computeRates(gd, m, 99, { bonuses: [] });
  const fewer = computeRates(gd, m, 99, { bonuses: [bonus(m, 'FlatStages', -4, { Recipe: m.id })] });
  close(fewer.xpPerHour / base.xpPerHour, m.stages / (m.stages - 4), 1e-9);
  const rich = computeRates(gd, m, 99, { bonuses: [bonus(m, 'FlatFortune', 100)] });
  const item = base.outputs[0].item;
  assert.ok(out(rich, item) > out(base, item) * 1.9, 'Fortune 100 doubles each drop (rounded down)');
});

test('thieving: perception bonuses change the success chance the way the game rounds them', () => {
  const m = gd.methods.find((x) => x.kind === 'thieving' && x.perception >= 200);
  const r = computeRates(gd, m, m.level, { bonuses: [bonus(m, 'FlatPerception', -35)] });
  close(r.successChance, Math.min(1, (100 + m.level) / (100 + Math.floor(m.perception - 35))));
});

test('woodcutting: tree health rounds up, and instant cuts fell the tree in one hit', () => {
  const m = method('Woodcutting/NormalTree');
  const slimmer = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentMaxHealth', -0.2)] });
  close(slimmer.cyclesPerHour, 3_600_000 / (Math.ceil(m.maxHealth * 0.8) * m.interval));
  assert.equal(woodcuttingHits(14, 0, 0), 14);
  assert.ok(woodcuttingHits(14, 0.06, 0) < 10, 'a 6% instant cut takes Yew from 14 hits to under 10');
  assert.equal(woodcuttingHits(1, 0.5, 0.5), 1, 'the last point of health is always one hit');
});

test('mining: a minimum prospecting head start shortens every rock after the first', () => {
  assert.ok(miningExpectedHits(0.1, 0.3) < miningExpectedHits(0.1, 0));
  const m = gd.methods.find((x) => x.kind === 'mining' && x.breakChance < 0.5);
  const essence = computeRates(gd, m, 99, { bonuses: [bonus(m, 'EssenceItemChance', 0.05)] });
  assert.ok(essence.outputs.some((o) => /Essence/.test(o.item)), 'an essence pickaxe drops essence while you mine');
});

test('fishing: the min and max catch times take their own percentage bonuses', () => {
  const m = gd.methods.find((x) => x.kind === 'fishing' && x.maxInterval > x.minInterval);
  const r = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentMinInterval', -0.1), bonus(m, 'PercentMaxInterval', -0.1)] });
  close(r.cyclesPerHour, 3_600_000 / ((Math.floor(m.minInterval * 0.9) + Math.floor(m.maxInterval * 0.9)) / 2));
});

test('farming: trees regrow from one seed, pests and disease cut the yield, and flowers give no harvest', () => {
  const apple = method('Farming/AppleTree');
  const r = computeRates(gd, apple, 99, { bonuses: [] });
  const harvests = 1 + apple.regrows;
  close(r.cyclesPerHour, 3_600_000 / (apple.interval + apple.regrows * apple.regrowInterval));
  const exposed = apple.pests + Math.max(0, apple.disease - apple.watering);
  close(out(r, apple.product.item) / r.cyclesPerHour, harvests * Math.trunc(apple.product.qty * (1 - exposed / 100)));
  close(r.xpPerHour / r.cyclesPerHour, harvests * apple.xp);
  const scarecrow = computeRates(gd, apple, 99, { bonuses: [bonus(apple, 'FlatPestProtection', 15)] });
  assert.ok(out(scarecrow, apple.product.item) > out(r, apple.product.item), 'pest protection saves part of every harvest');
  const flower = gd.methods.find((x) => x.flower);
  const f = computeRates(gd, flower, 99, { bonuses: [] });
  assert.equal(f.xpPerHour, 0);
  assert.equal(f.outputs.length, 0);
});

test('herblore: each stage of the batch takes its own interval bonus', () => {
  const m = gd.methods.find((x) => x.skill === 'Herblore' && x.batch?.heating > 0);
  const r = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PercentHeatingInterval', -0.5)] });
  const b = m.batch;
  close(r.cyclesPerHour, 3_600_000 / ((b.preparing + Math.floor(b.heating * 0.5) + b.stirring + b.bottlings * b.bottling) / b.bottlings));
});

test('cooking and firemaking keep their materials with preservation, like crafting', () => {
  for (const kind of ['cooking', 'firemaking']) {
    const m = gd.methods.find((x) => x.kind === kind && x.ingredients.length);
    const base = computeRates(gd, m, 99, { bonuses: [] });
    const kept = computeRates(gd, m, 99, { bonuses: [bonus(m, 'PreservationChance', 0.2)] });
    close(kept.inputs[0].perHour, base.inputs[0].perHour * 0.8);
  }
});

test('crafting adds a flat interval change after the percentage; gathering before it', () => {
  const craft = gd.methods.find((x) => x.kind === 'artisan' && !x.batch && x.interval >= 2000);
  const c = computeRates(gd, craft, 99, { bonuses: [bonus(craft, 'PercentInterval', -0.1), bonus(craft, 'FlatInterval', -100)] });
  close(c.msPerCycle, craft.steps * Math.floor(craft.interval * 0.9 - 100));
  const ore = method('Mining/CopperOre') ?? gd.methods.find((x) => x.kind === 'mining');
  const o = computeRates(gd, ore, 99, { bonuses: [bonus(ore, 'PercentInterval', -0.1), bonus(ore, 'FlatInterval', -100)] });
  close(o.msPerCycle / miningExpectedHits(ore.breakChance), Math.floor((ore.interval - 100) * 0.9));
});

test('hunting: a higher journal level means bigger catches and its own bonuses for that animal', async () => {
  const { playerBonuses, playerState } = await import('../engine/gamedata.js');
  const m = method('Hunting/WildChicken');
  const fresh = computeRates(gd, m, m.level, { bonuses: [], journalLevel: 1 });
  const known = computeRates(gd, m, m.level, { bonuses: [], journalLevel: 25 });
  close(known.xpPerHour / fresh.xpPerHour, (0.9 + 0.25) / (0.9 + 0.01));
  const save = { skills: {}, huntingJournal: { WildChicken: { level: 10, xp: 0 } } };
  gd.player = playerState(save, gd);
  const effects = playerBonuses(gd, save).filter((e) => e.scope?.Recipe === 'WildChicken');
  gd.player = null;
  assert.ok(effects.length > 0, 'journal levels 2 to 10 give Wild Chicken bonuses');
  const faster = computeRates(gd, m, m.level, { bonuses: effects, journalLevel: 10 });
  assert.ok(faster.cyclesPerHour > computeRates(gd, m, m.level, { bonuses: [], journalLevel: 10 }).cyclesPerHour);
  assert.equal(computeRates(gd, method('Hunting/WildCow'), 99, { bonuses: effects, journalLevel: 10 }).bonuses, undefined, 'and only for that animal');
});
