#!/usr/bin/env node
// Copies the data package (Data/Packages/*.json) out of an installed copy of Melvor Idle 2, so the
// companion can be built for exactly the version you play. Reads the game files; never changes them.
//
//   node tools/extract-game-data.js [path/to/Melvor2.exe or .pck] [--out data/source] [--list]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGameFile, openGamePack } from './game-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const listOnly = args.includes('--list');
const positional = args.filter((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));
const gameFile = positional[0] ?? findGameFile();
const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : join(HERE, '..', 'data', 'source'));

if (!gameFile || !existsSync(gameFile)) {
  console.error('Could not find the game. Pass the path to Melvor2.exe (or its .pck file).');
  process.exit(1);
}

let pack;
try {
  pack = openGamePack(gameFile);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const packages = [...pack.files.entries()].filter(([path]) => /(^|\/)Data\/Packages\/[^/]+\.json$/i.test(path));
console.log(`${basename(gameFile)}: Godot ${pack.godot}, pack format ${pack.formatVersion}, ${pack.files.size} files`);
if (!packages.length) {
  console.error('No data packages (Data/Packages/*.json) in this pack.');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const [path, f] of packages) {
  const name = basename(path);
  if (listOnly || f.encrypted) {
    console.log(`  ${name}  ${(f.size / 1024).toFixed(0)} KB${f.encrypted ? '  (encrypted, skipped)' : ''}`);
    continue;
  }
  const body = pack.readFile(path);
  JSON.parse(body.toString('utf8')); // make sure we found real JSON
  writeFileSync(join(outDir, name), body);
  console.log(`  ${name}  ${(f.size / 1024).toFixed(0)} KB  ->  ${join(outDir, name)}`);
}
pack.close();
