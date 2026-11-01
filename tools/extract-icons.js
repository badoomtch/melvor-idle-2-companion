#!/usr/bin/env node
// Bundles the game's icons into the companion (ui/icons/) for everything in data/companion-data.json,
// plus data/icons.json mapping each res:// path to its bundled file. Run after build-data.
// Reads the installed game; never changes it.
//
//   node tools/extract-icons.js [path/to/Melvor2.exe or .pck]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGameFile, openGamePack, readImage } from './game-pack.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'ui', 'icons');
const MANIFEST = join(ROOT, 'data', 'icons.json');
const LOGO = 'res://Assets/Logo_V3.svg';

const gameFile = process.argv[2] ?? findGameFile();
if (!gameFile || !existsSync(gameFile)) {
  console.error('Could not find the game. Pass the path to Melvor2.exe (or its .pck file).');
  process.exit(1);
}
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companion-data.json'), 'utf8'));

// What the UI shows a picture for, grouped so the size report is useful.
const groups = {
  skills: data.skills.map((s) => s.icon),
  items: Object.values(data.items).map((i) => i.icon),
  currencies: Object.values(data.currencies).map((c) => c.icon),
  methods: data.methods.map((m) => m.icon),
  enemies: data.enemies.map((e) => e.icon),
  areas: data.areas.map((a) => a.icon),
  shop: data.shop.map((s) => s.icon),
  pets: (data.pets ?? []).map((p) => p.icon),
  combat: [...(data.combat?.spells ?? []).map((s) => s.icon), ...(data.combat?.prayers ?? []).map((p) => p.icon), ...(data.combat?.slayerMasters ?? []).map((m) => m.icon)],
  // The companion's side menu, using the game's own header icons.
  menu: [
    'res://Assets/Icons/Statistics_64.png',
    'res://Assets/Icons/GuideBook.png',
    'res://Assets/Icons/sleep.png',
    'res://Assets/Icons/Mastery_Icon_48.png',
    'res://Assets/Icons/Milestones.png',
    'res://Assets/Icons/Bank_64.png',
    'res://Assets/Icons/Shop_64.png',
    'res://Assets/Icons/Combat_64.png',
    'res://Assets/Icons/Slayer.png',
    'res://Assets/Items/SandsofTime.png',
    'res://Assets/Icons/search.png',
    'res://Assets/Icons/Quests.png',
    'res://Assets/Icons/CheckeredFlag.png',
    'res://Assets/Icons/history.png',
    'res://Assets/Icons/Completion_64.png',
    'res://Assets/Icons/Settings_64.png',
    'res://Assets/Icons/Accurate.png',
  ],
};

const pack = openGamePack(gameFile);
rmSync(ICON_DIR, { recursive: true, force: true });
const manifest = {};
const report = {};
let missing = 0;
for (const [group, paths] of Object.entries(groups)) {
  report[group] = { files: 0, bytes: 0 };
  for (const resPath of new Set(paths.filter(Boolean))) {
    if (manifest[resPath]) continue;
    const img = readImage(pack, resPath);
    if (!img) {
      missing++;
      continue;
    }
    const rel = `icons/${resPath.replace(/^res:\/\/(Assets\/)?/, '').replace(/\.[a-z0-9]+$/i, '')}.${img.ext}`;
    mkdirSync(dirname(join(ROOT, 'ui', rel)), { recursive: true });
    writeFileSync(join(ROOT, 'ui', rel), img.data);
    manifest[resPath] = rel;
    report[group].files++;
    report[group].bytes += img.data.length;
  }
}
const logo = pack.readFile(LOGO);
if (logo) {
  writeFileSync(join(ICON_DIR, 'logo.svg'), logo);
  manifest.logo = 'icons/logo.svg';
}
pack.close();
writeFileSync(MANIFEST, JSON.stringify(manifest));

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
let total = 0;
console.log(`Bundled icons from ${gameFile}`);
for (const [group, r] of Object.entries(report)) {
  total += r.bytes;
  console.log(`  ${group.padEnd(10)} ${String(r.files).padStart(5)} files  ${mb(r.bytes)}`);
}
console.log(`  total      ${String(Object.keys(manifest).length).padStart(5)} files  ${mb(total)}${missing ? `   (${missing} not found in the game)` : ''}`);
