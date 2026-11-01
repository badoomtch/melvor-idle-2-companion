// Toolbelt advice (what to put on from your bank) and the rare items list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGameData } from '../engine/gamedata.js';
import { rareItems } from '../engine/rare-items.js';
import { toolbeltAdvice, toolbeltForStep } from '../engine/toolbelt-advice.js';

const gd = createGameData(JSON.parse(readFileSync(new URL('../data/companion-data.json', import.meta.url), 'utf8')));
const ID = (x) => `MelvorBase:${x}`;
const at = (level) => Object.fromEntries(gd.skills.map((s) => [s.id, level]));

// A save with these toolbelts and bank, and the player state the engine reads from it.
function setup({ toolbelts = {}, bank = {}, ranks = {}, shop = {} }) {
  const owned = { ...bank };
  for (const tools of Object.values(toolbelts)) for (const t of tools) owned[t.item] = (owned[t.item] ?? 0) + t.qty;
  gd.player = { toolbelts, owned, masteryRanks: ranks, prayers: [], quests: null, enemiesKilled: null, slayerTasks: [] };
  return { toolbelts, bank: { items: bank }, shopPurchases: shop };
}

test('an empty slot gets the best item from your bank, with what it is worth', () => {
  const save = setup({ bank: { [ID('FurCamoHat')]: 3, [ID('FurCamoBody')]: 1 } });
  const advice = toolbeltAdvice(gd, save, { levels: at(40) });
  const hunting = advice.skills.find((s) => s.skill === 'Hunting');
  assert.deepEqual(hunting.changes.map((c) => c.item).sort(), [ID('FurCamoBody'), ID('FurCamoHat')]);
  assert.ok(hunting.changes.every((c) => !c.replaces && c.measured));
  assert.ok(hunting.gain.xp.share > 0.02 && hunting.gain.xp.share < 0.05, `two pieces at +1% XP and +1% tracking step skips each (${hunting.gain.xp.share})`);
  gd.player = null;
});

test('one item never goes in two slots, and a slot that is not open waits for later', () => {
  // Both Mining utility slots open (the second needs Veteran Miner), one kind of item for them.
  const save = setup({ bank: { [ID('ThornbackSpikedNails')]: 500 }, ranks: { Mining: ['VeteranMiner'] } });
  const mining = toolbeltAdvice(gd, save, { levels: at(40) }).skills.find((s) => s.skill === 'Mining');
  assert.equal(mining.changes.length, 1, 'only one slot can take it');
  assert.equal(mining.changes[0].measured, true, 'minimum prospecting makes each ore quicker');
  assert.ok(mining.gain, 'with a number on it, even if +0.03 only shortens some rocks');
  assert.equal(mining.changes[0].usedUp, true);

  const closed = setup({ bank: { [ID('FeathersFlaxBasket')]: 2, [ID('WildebeastStake')]: 1 } });
  const advice = toolbeltAdvice(gd, closed, { levels: at(40) });
  const later = advice.later.filter((l) => l.skill === 'Woodcutting');
  assert.equal(later.length, 1);
  assert.equal(later[0].slot.id, 'WoodcuttingUtility2');
  assert.match(later[0].needs, /Veteran Woodcutter/);
  assert.notEqual(later[0].item, advice.skills.find((s) => s.skill === 'Woodcutting').changes[0].item, 'not the item going in the first slot');
  gd.player = null;
});

test("it won't take off a tool that what you're doing needs, and says what a swap would stop", () => {
  const toolbelts = { Thieving: [{ item: ID('FireWizardHat'), qty: 1, slot: 'ThievingHelmet' }, { item: ID('FireWizardRobes'), qty: 1, slot: 'ThievingTorso' }] };
  const save = setup({ toolbelts, bank: { [ID('Balaclava')]: 1 } });
  const busy = toolbeltAdvice(gd, save, { levels: at(60), current: 'Thieving/WizardScholar' });
  assert.equal(busy.skills.find((s) => s.skill === 'Thieving'), undefined, 'the hat stays on while you pickpocket wizards');

  const free = toolbeltAdvice(gd, save, { levels: at(60) }).skills.find((s) => s.skill === 'Thieving');
  assert.equal(free.changes[0].item, ID('Balaclava'), 'otherwise the stealth is worth more');
  assert.equal(free.changes[0].replaces, ID('FireWizardHat'));
  assert.ok(free.gain.lost.some((m) => m.key === 'Thieving/WizardScholar'), 'it says the wizard targets need the hat back');
  gd.player = null;
});

test('a skilling set is tried as a whole, since one piece alone does little', () => {
  const light = gd.combat.sets.find((s) => s.name === 'Light Set');
  const bank = Object.fromEntries(light.items.slice(0, 3).map((id) => [id, 1]));
  const agility = toolbeltAdvice(gd, setup({ bank }), { levels: at(40) }).skills.find((s) => s.skill === 'Agility');
  assert.equal(agility.changes.length, 3);
  assert.ok(agility.changes.every((c) => c.set === 'Light Set'));
  assert.ok(agility.gain.xp.share > 0, 'faster laps');
  gd.player = null;
});

test('a plan step says which toolbelt swap from your bank makes it quicker', () => {
  const toolbelts = { Thieving: [{ item: ID('FireWizardHat'), qty: 1, slot: 'ThievingHelmet' }] };
  const save = setup({ toolbelts, bank: { [ID('Balaclava')]: 1 } });
  const thug = { kind: 'train', method: gd.methodByKey.get('Thieving/Thug') };
  const swap = toolbeltForStep(gd, save, thug, { levels: at(30) });
  assert.deepEqual(swap.changes.map((c) => [c.item, c.replaces]), [[ID('Balaclava'), ID('FireWizardHat')]]);
  assert.ok(swap.gain > 0.05 && !swap.needed, `stealth makes pickpocketing quicker (${swap.gain})`);
  // Something that can't help this step says nothing.
  assert.equal(toolbeltForStep(gd, save, { kind: 'train', method: gd.methodByKey.get('Mining/CopperOre') ?? gd.methodsBySkill.Mining[0] }, { levels: at(30) }), null);
  gd.player = null;
});

test('a step that needs tools in your bank says to put them all on first', () => {
  const wizard = { kind: 'train', method: gd.methodByKey.get('Thieving/WizardScholar') };
  const both = setup({ bank: { [ID('FireWizardHat')]: 1, [ID('FireWizardRobes')]: 1 } });
  const on = toolbeltForStep(gd, both, wizard, { levels: at(60) });
  assert.equal(on.needed, true);
  assert.deepEqual(on.changes.map((c) => c.item).sort(), [ID('FireWizardHat'), ID('FireWizardRobes')]);
  // With only the hat it can't be done at all, so there's nothing to put on for it.
  assert.equal(toolbeltForStep(gd, setup({ bank: { [ID('FireWizardHat')]: 1 } }), wizard, { levels: at(60) }), null);
  gd.player = null;
});

test('rare items: chance-only drops with their rarity, timed by what you can do now', () => {
  const rows = rareItems(gd, { levels: at(40), owned: {}, found: { Balaclava: 1 } });
  const byItem = new Map(rows.map((r) => [r.item, r]));
  assert.ok(!byItem.has(ID('OakLog')) && !byItem.has(ID('IronBar')), 'things made or gathered every time are not rare');
  assert.ok(gd.shop.every((p) => p.provides.items.every((i) => !byItem.has(i.item))), 'nothing the shop sells is rare');
  const bal = byItem.get(ID('Balaclava'));
  assert.equal(bal.rarity.id, 'rare');
  assert.equal(bal.found, true);
  assert.equal(bal.best.method.key, 'Thieving/Thug');
  assert.ok(bal.best.hours > 0 && bal.best.hours < 5, `a few hours of pickpocketing at most (${bal.best.hours})`);
  // Enemy drops need a fight to time them; without one they can't be gone for yet.
  assert.ok(rows.every((r) => r.best?.type !== 'enemy'));
  // Rarest first.
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].p <= r.p));
});

test('rare items from chests you have: your chance from opening them all', () => {
  const rows = rareItems(gd, { levels: at(40), owned: { [ID('Geode')]: 50 } });
  const pick = rows.find((r) => r.item === ID('InfernalPickaxeDamaged'));
  assert.equal(pick.best.type, 'open');
  assert.equal(pick.best.hours, 0);
  const expected = 1 - Math.pow(1 - pick.best.p, 50);
  assert.ok(Math.abs(pick.best.chanceFromOwned - expected) < 1e-9);
});
