#!/usr/bin/env node
// Writes a realistic demo save to demo-saves/ so the companion can be previewed without the game.
//   node tools/make-demo-save.js          write once
//   node tools/make-demo-save.js --live   keep "playing" (woodcutting) and re-save every 5 seconds
//   add --fast to play at 60x speed so levels visibly change
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameData } from '../engine/gamedata.js';
import { computeRates } from '../engine/rates.js';
import { buildSave } from '../test/save-writer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'demo-saves');
const UUID = 'd3e1c0de-2b7a-4c11-9e55-0f1a2b3c4d5e';
const gd = createGameData(JSON.parse(readFileSync(join(ROOT, 'data', 'companion-data.json'), 'utf8')));

const levels = {
  Attack: 25, Strength: 23, Defence: 20, Hitpoints: 26, Ranged: 12, Magic: 8, Prayer: 9, Slayer: 7,
  Agility: 8, Beastcrafting: 6, Cooking: 26, Crafting: 14, Farming: 13, Firemaking: 19, Fishing: 27,
  Fletching: 21, Herblore: 1, Hunting: 4, Mining: 31, Runecrafting: 9, Smithing: 24, Thieving: 22,
  Woodcutting: 34, Ranching: 3, Astrology: 5,
};
const xp = Object.fromEntries(Object.entries(levels).map(([s, l]) => [s, gd.xp.xpForLevel(l) + Math.floor((gd.xp.xpForLevel(l + 1) - gd.xp.xpForLevel(l)) * 0.4)]));

const idByName = new Map(Object.entries(gd.items).map(([id, it]) => [it.name, id]));
const bank = {};
for (const [name, qty] of Object.entries({
  'Normal Log': 412, 'Oak Log': 960, 'Willow Log': 233, 'Copper Ore': 540, 'Tin Ore': 495, 'Iron Ore': 188,
  'Coal Ore': 96, 'Bronze Bar': 120, 'Iron Bar': 34, 'Raw Shrimp': 310, 'Shrimp': 145, 'Raw Sardine': 88,
  'Sardine': 52, 'Bones': 260, 'Feather': 1500, 'Bronze Sword': 1, 'Iron Helmet': 1, 'Silver Bar': 14,
})) {
  const id = idByName.get(name);
  if (id) bank[id] = qty;
}

const activeMethod = gd.methodsBySkill.Woodcutting.find((m) => m.name === 'Oak Tree');

function write(timestamp) {
  const totalLevel = Object.values(levels).reduce((s, l) => s + l, 0);
  const file = buildSave({
    uuid: UUID,
    name: 'Demo Woodsman',
    gamemode: 'Standard',
    timestamp,
    activeEntityName: 'Woodcutting',
    activeActionName: activeMethod.name,
    totalLevel,
    gp: 48_350 + Math.floor((bank[activeMethod.product.item] ?? 0) / 10),
    slayerCoins: 1200,
    skills: Object.fromEntries(Object.keys(levels).map((s) => [s, { xp: xp[s], level: Math.min(gd.xp.levelForXp(xp[s]), gd.levelCap) }])),
    bank: { tabs: [{ label: 'Main', stacks: Object.entries(bank).map(([item, qty]) => ({ item, qty })) }] },
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, `save_${UUID}.sav`);
  writeFileSync(`${target}.tmp`, file);
  renameSync(`${target}.tmp`, target); // the game also writes a temp file then swaps it in
  return target;
}

const target = write(Date.now());
console.log(`Wrote ${target}`);

if (process.argv.includes('--live')) {
  const SPEEDUP = process.argv.includes('--fast') ? 60 : 1;
  const rates = computeRates(gd, activeMethod, levels.Woodcutting);
  console.log(`Live mode: chopping ${activeMethod.name}${SPEEDUP > 1 ? ` at ${SPEEDUP}x speed` : ''}, saving every 5s. Ctrl+C to stop.`);
  setInterval(() => {
    const hours = (5 / 3600) * SPEEDUP;
    xp.Woodcutting += rates.xpPerHour * hours;
    levels.Woodcutting = Math.min(gd.xp.levelForXp(xp.Woodcutting), gd.levelCap);
    bank[activeMethod.product.item] = (bank[activeMethod.product.item] ?? 0) + Math.round(rates.cyclesPerHour * hours);
    write(Date.now());
    console.log(`  saved: Woodcutting ${levels.Woodcutting}, ${Math.round(xp.Woodcutting).toLocaleString()} XP`);
  }, 5000);
}
