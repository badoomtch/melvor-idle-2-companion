#!/usr/bin/env node
// Which parts of the companion's data the Steam demo doesn't have, for the "Demo only" setting.
// Written to data/demo-availability.json.
//
//   node tools/build-demo-list.js <path to a melvor-idle-2-tools checkout> [--out file]
//
// The source is knsk45/melvor-idle-2-tools (MIT), which reads the demo's own data package
// (Data/Packages/MelvorDemo.json) and keeps each definition's DemoLocked condition. Something is
// out of the demo when:
//   - its skill is DemoLocked (Agility, Herblore and Astrology in v0.11.2-alpha.4), or
//   - the definition is DemoLocked, or the demo package doesn't have it at all, or
//   - the skill's checked rate table (src/data/skills/<skill>.json) leaves it out or marks it
//     locked. The package alone misses some: Bone Arrows and Bone Bolts aren't DemoLocked, but
//     their Slayer Ammo category isn't in the demo's Beastcrafting;
//   - Grain Mill recipes the same way as skill recipes;
//   - a shop purchase: it gives or costs an item the demo doesn't have, or needs a locked skill.
// Quest-only definitions (shown only during a quest step) count as in the demo. Not being locked
// doesn't prove something is reachable in the demo; it's only not marked as locked.
//
// Re-run it against a new checkout whenever the demo or data/companion-data.json changes.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] : join(ROOT, 'data', 'demo-availability.json'));
const srcDir = args.find((a, i) => !a.startsWith('--') && (outIndex < 0 || i !== outIndex + 1));
if (!srcDir) {
  console.error('Usage: node tools/build-demo-list.js <path to a melvor-idle-2-tools checkout> [--out file]');
  process.exit(1);
}

const read = (rel) => JSON.parse(readFileSync(join(srcDir, rel), 'utf8'));
const local = (id) => String(id ?? '').split(':').pop();
const isDemoLocked = (reqs) => JSON.stringify(reqs ?? []).includes(':DemoLocked"');

const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companion-data.json'), 'utf8'));
const recipes = read('data/catalog/recipes.json');
const items = read('data/catalog/items.json');
const monsters = read('src/data/monsters.json');
const skillIndex = read('src/data/skills/index.json');

// Skills locked as a whole.
const lockedSkills = new Set(skillIndex.skills.filter((s) => s.demoLocked).map((s) => local(s.gameId)));

// Recipes from the demo package's registries, by kind: id -> locked?
const KIND_TABLES = {
  artisan: 'ArtisanRecipe', cooking: 'CookingRecipe', woodcutting: 'WoodcuttingRecipe', mining: 'MiningRecipe', fishing: 'FishingRecipe',
  firemaking: 'FiremakingRecipe', farming: 'FarmingRecipe', thieving: 'ThievingRecipe',
};
const recipeLock = new Map();
for (const [kind, table] of Object.entries(KIND_TABLES)) {
  const rows = recipes.tables[table];
  recipeLock.set(kind, new Map((Array.isArray(rows) ? rows : rows.records).map((r) => [r.Id, r.availabilityClassification === 'demo-locked'])));
}
// Herblore recipes are artisan methods in the companion; their skill is locked anyway.
for (const r of recipes.tables.HerbloreRecipe) recipeLock.get('artisan').set(r.Id, r.availabilityClassification === 'demo-locked' || recipeLock.get('artisan').get(r.Id) === true);
// Hunting, Ranching and Astrology come as tables with their own availability.
for (const kind of ['hunting', 'ranching', 'astrology']) recipeLock.set(kind, new Map(read(`src/data/skills/${kind}.json`).rows.map((r) => [r.id, r.availability !== 'demo'])));

// Each skill's checked rate table, where there is one: recipe id -> in the demo?
const skillTables = new Map();
for (const s of skillIndex.skills) {
  try {
    const rows = read(`src/data/skills/${s.id}.json`).rows;
    if (Array.isArray(rows)) skillTables.set(local(s.gameId), new Map(rows.map((r) => [r.id, r.availability === 'demo'])));
  } catch {
    // no table for this skill
  }
}

const methods = data.methods.filter((m) => {
  if (lockedSkills.has(m.skill)) return true;
  const checked = skillTables.get(m.skill);
  if (checked && checked.get(m.id) !== true) return true;
  const table = recipeLock.get(m.kind);
  if (!table) return true; // a kind the demo package has no definitions for (Agility, whose skill is locked)
  return table.get(m.id) ?? true;
});

const demoItems = new Set(items.records.map((r) => r.id));
const lockedItems = Object.keys(data.items).filter((id) => !demoItems.has(id));
const lockedItemSet = new Set(lockedItems);

const enemyLock = new Map(monsters.rows.map((r) => [local(r.id), r.availability === 'locked']));
const enemies = data.enemies.filter((e) => enemyLock.get(e.id) ?? true);
const areaLock = new Map(monsters.areas.map((a) => [local(a.id), isDemoLocked(a.requirements)]));
const areas = data.areas.filter((a) => areaLock.get(a.id) ?? true);
const dungeons = (data.combat?.dungeons ?? []).filter((d) => areaLock.get(d.id) ?? true);

const millRows = recipes.tables.GrainMillRecipe;
const millLock = new Map((Array.isArray(millRows) ? millRows : millRows.records).map((r) => [r.Id, r.availabilityClassification === 'demo-locked']));
const mill = (data.grainMill?.recipes ?? []).filter((r) => millLock.get(r.id) ?? true);

const shop = data.shop.filter((p) =>
  [...p.provides.items, ...p.costs.items].some((i) => lockedItemSet.has(i.item)) || p.requires.some((r) => r.type === 'level' && lockedSkills.has(r.skill)));

let commit = null;
try {
  commit = execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // not a git checkout
}

const out = {
  source: {
    repository: 'https://github.com/knsk45/melvor-idle-2-tools',
    license: 'MIT',
    commit,
    gameVersion: monsters.gameVersion,
    steamBuildId: monsters.steamBuildId,
    packageSha256: monsters.packageSha256,
    checkedAt: monsters.checkedAt,
  },
  // Built against this companion data; methods are keys, the rest are ids.
  builtFor: data.meta.generatedAt,
  locked: {
    skills: [...lockedSkills].sort(),
    methods: methods.map((m) => m.key),
    enemies: enemies.map((e) => e.id),
    areas: areas.map((a) => a.id),
    dungeons: dungeons.map((d) => d.id),
    shop: shop.map((p) => p.id),
    mill: mill.map((r) => r.id),
    items: lockedItems,
  },
};
writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);

const share = (n, of) => `${n} of ${of}`;
console.log(`Wrote ${outPath}`);
console.log(`  demo ${out.source.gameVersion} (Steam build ${out.source.steamBuildId}), from ${out.source.repository}${commit ? ` @ ${commit.slice(0, 7)}` : ''}`);
console.log(`  locked skills: ${out.locked.skills.join(', ') || 'none'}`);
console.log(`  locked: methods ${share(methods.length, data.methods.length)}, enemies ${share(enemies.length, data.enemies.length)}, areas ${share(areas.length, data.areas.length)}, dungeons ${share(dungeons.length, data.combat?.dungeons?.length ?? 0)}, shop ${share(shop.length, data.shop.length)}, mill ${share(mill.length, data.grainMill?.recipes?.length ?? 0)}, items ${share(lockedItems.length, Object.keys(data.items).length)}`);
