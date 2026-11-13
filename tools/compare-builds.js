#!/usr/bin/env node
// What changed between two data builds, for the game's developers: content added and removed,
// and how rates, enemies and shop prices moved. Written to reports/build-diff.md.
//
//   node tools/compare-builds.js <old companion-data.json> [new companion-data.json] [--out file]
//
// Keep a copy of data/companion-data.json before running build-data on a new game build, then
// compare the copy with the new one.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameData } from '../engine/gamedata.js';
import { computeRates } from '../engine/rates.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] : join(ROOT, 'reports', 'build-diff.md'));
const files = args.filter((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));
if (!files.length) {
  console.error('Usage: node tools/compare-builds.js <old companion-data.json> [new companion-data.json] [--out file]');
  process.exit(1);
}
const load = (f) => createGameData(JSON.parse(readFileSync(resolve(f), 'utf8')));
const before = load(files[0]);
const after = load(files[1] ?? join(ROOT, 'data', 'companion-data.json'));

const n = (x) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(x);
const change = (a, b) => (a === 0 ? (b === 0 ? '0%' : 'new') : `${b >= a ? '+' : ''}${n(((b - a) / a) * 100)}%`);
const lines = [`# Build comparison`, '', `Before: ${before.meta.source} (built ${before.meta.generatedAt})  `, `After: ${after.meta.source} (built ${after.meta.generatedAt})`, ''];
const section = (title, rows, columns, intro = '') => {
  lines.push(`## ${title} (${rows.length})`, '');
  if (intro) lines.push(intro, '');
  if (!rows.length) return lines.push('No changes.', '');
  lines.push(`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`);
  for (const r of rows.slice(0, 200)) lines.push(`| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  if (rows.length > 200) lines.push('', `…and ${rows.length - 200} more.`);
  lines.push('');
};

// Added and removed content.
const diffIds = (a, b) => ({ added: [...b.keys()].filter((k) => !a.has(k)), removed: [...a.keys()].filter((k) => !b.has(k)) });
const byKey = (list, key) => new Map(list.map((x) => [x[key], x]));
const content = [
  ['Items', new Map(Object.entries(before.items)), new Map(Object.entries(after.items)), (x) => x.name],
  ['Training methods', byKey(before.methods, 'key'), byKey(after.methods, 'key'), (x) => `${x.name} (${x.skill} ${x.level})`],
  ['Enemies', byKey(before.enemies, 'id'), byKey(after.enemies, 'id'), (x) => x.name],
  ['Shop purchases', byKey(before.shop, 'id'), byKey(after.shop, 'id'), (x) => x.name],
];
const contentRows = [];
for (const [what, a, b, label] of content) {
  const d = diffIds(a, b);
  for (const id of d.added) contentRows.push([what, 'added', label(b.get(id))]);
  for (const id of d.removed) contentRows.push([what, 'removed', label(a.get(id))]);
}
section('Content added or removed', contentRows, ['Kind', 'Change', 'Name']);

// Training rates at the level each method unlocks (base rates, no player bonuses).
const rateRows = [];
for (const m of after.methods) {
  const old = before.methodByKey.get(m.key);
  if (!old) continue;
  const level = Math.max(m.level, old.level);
  const ra = computeRates(before, old, level, { bonuses: [] });
  const rb = computeRates(after, m, level, { bonuses: [] });
  const xpMoved = Math.abs(rb.xpPerHour - ra.xpPerHour) > Math.max(1, ra.xpPerHour * 0.005);
  const gpMoved = Math.abs(rb.profitPerHour - ra.profitPerHour) > Math.max(1, Math.abs(ra.profitPerHour) * 0.01);
  if (!xpMoved && !gpMoved && m.level === old.level) continue;
  rateRows.push([m.skill, m.name, old.level === m.level ? m.level : `${old.level} → ${m.level}`, `${n(ra.xpPerHour)} → ${n(rb.xpPerHour)} (${change(ra.xpPerHour, rb.xpPerHour)})`, `${n(ra.profitPerHour)} → ${n(rb.profitPerHour)}`]);
}
rateRows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
section('Training rates that moved', rateRows, ['Skill', 'Method', 'Level', 'XP/h', 'GP/h'], 'Base rates at the level each method unlocks; XP changes under 0.5% and GP changes under 1% are left out.');

// Enemies: hitpoints, attack interval, defensive ratings, levels.
const enemyRows = [];
const enemyStats = (e) => ({ HP: (e.levels.Hitpoints ?? 1) * 10, 'Attack interval': e.stats.AttackInterval ?? 0, Power: e.power, Protection: e.protection, Armour: e.stats.Armour ?? 0, ...Object.fromEntries(Object.entries(e.levels).map(([k, v]) => [`${k} level`, v])) });
for (const e of after.enemies) {
  const old = before.enemyById.get(e.id);
  if (!old) continue;
  const a = enemyStats(old);
  const b = enemyStats(e);
  const moved = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k] ?? '–'} → ${b[k] ?? '–'}`);
  if (moved.length) enemyRows.push([e.name, moved.join('; ')]);
}
section('Enemies that changed', enemyRows, ['Enemy', 'Changes']);

// Shop: prices and what they give.
const shopRows = [];
const priceOf = (gd, p) => [...p.costs.currencies.map((c) => `${n(c.qty)} ${gd.currencyName(c.currency)}`), ...p.costs.items.map((i) => `${n(i.qty)} ${gd.itemName(i.item)}`)].join(', ') || 'free';
for (const p of after.shop) {
  const old = before.shop.find((x) => x.id === p.id);
  if (!old) continue;
  const a = priceOf(before, old);
  const b = priceOf(after, p);
  if (a !== b) shopRows.push([p.name, a, b]);
}
section('Shop prices that changed', shopRows, ['Purchase', 'Before', 'After']);

// Item sell prices.
const sellRows = [];
for (const [id, it] of Object.entries(after.items)) {
  const old = before.items[id];
  if (old && old.sell !== it.sell) sellRows.push([it.name, n(old.sell), n(it.sell), change(old.sell, it.sell)]);
}
sellRows.sort((a, b) => a[0].localeCompare(b[0]));
section('Sell prices that changed', sellRows, ['Item', 'Before', 'After', 'Change']);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${outPath}`);
console.log(`  ${contentRows.length} content changes, ${rateRows.length} rate changes, ${enemyRows.length} enemy changes, ${shopRows.length} shop price changes, ${sellRows.length} sell price changes`);
