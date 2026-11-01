#!/usr/bin/env node
// Balance and data report for the game's developers: outliers and suspicious content in a data
// build, written to reports/data-report.md. Run it after build-data on each new data package.
//
//   node tools/data-report.js [--out reports/data-report.md]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameData, describeRequirement } from '../engine/gamedata.js';
import { buildEnemy } from '../engine/combat.js';
import { itemDetails } from '../engine/lookup.js';
import { computeRates } from '../engine/rates.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] : join(ROOT, 'reports', 'data-report.md'));

const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'companion-data.json'), 'utf8'));
let icons = {};
try {
  icons = JSON.parse(readFileSync(join(ROOT, 'data', 'icons.json'), 'utf8'));
} catch {
  // no icon bundle yet
}
const gd = createGameData(raw);
const cap = gd.levelCap;
const n = (x) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(x);
const sections = [];
const section = (title, intro, rows, columns) => sections.push({ title, intro, rows, columns });

// 1. Economy outliers: methods far above the others in their skill at the level they unlock.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const outliers = [];
for (const skill of gd.trainableSkills) {
  const list = gd.methodsBySkill[skill].filter((m) => m.kind !== 'farming');
  const rated = list.map((m) => ({ m, r: computeRates(gd, m, m.level, { bonuses: [] }) }));
  for (const { m, r } of rated) {
    const near = rated.filter((x) => x.m !== m && Math.abs(x.m.level - m.level) <= 10);
    if (near.length < 3) continue;
    const gpMed = median(near.map((x) => x.r.profitPerHour).filter((v) => v > 0));
    const xpMed = median(near.map((x) => x.r.xpPerHour).filter((v) => v > 0));
    const gpTimes = gpMed > 0 ? r.profitPerHour / gpMed : 0;
    const xpTimes = xpMed > 0 ? r.xpPerHour / xpMed : 0;
    if (gpTimes >= 5 || xpTimes >= 3) {
      const needs = m.requires.filter((q) => q.type !== 'level').map((q) => describeRequirement(gd, q)).join('; ');
      // Inputs that sell for nothing make any product look like pure profit.
      const madeFrom = (m.ingredients ?? []).map((i) => `${i.qty}× ${gd.itemName(i.item)}${gd.itemValue(i.item) ? '' : ' (worth 0)'}`).join(', ');
      outliers.push([`${skill}: ${m.name}`, m.level, n(r.profitPerHour), gpTimes >= 5 ? `${gpTimes.toFixed(1)}×` : '', n(r.xpPerHour), xpTimes >= 3 ? `${xpTimes.toFixed(1)}×` : '', madeFrom, needs || '']);
    }
  }
}
outliers.sort((a, b) => parseFloat(b[3] || b[5]) - parseFloat(a[3] || a[5]));
section('Economy outliers', `Base GP/h or XP/h (no bonuses) at the method's own unlock level, compared with the median of methods in the same skill within 10 levels. Flagged at 5× GP or 3× XP.`, outliers, ['Method', 'Level', 'GP/h', 'vs nearby', 'XP/h', 'vs nearby', 'Made from', 'Also needs']);

// 2. Unreachable content: level requirements above the cap.
const unreachable = [];
const checkReqs = (what, reqs) => {
  for (const r of reqs ?? []) if (r.type === 'level' && r.level > cap) unreachable.push([what, `${gd.skillName(r.skill)} ${r.level}`]);
};
for (const m of gd.methods) {
  if (m.level > cap) unreachable.push([`${m.skill}: ${m.name}`, `${gd.skillName(m.skill)} ${m.level}`]);
  checkReqs(`${m.skill}: ${m.name}`, m.requires);
}
for (const [id, it] of Object.entries(gd.items)) checkReqs(`Item: ${it.name}`, it.equip?.requires);
for (const p of gd.shop) checkReqs(`Shop: ${p.name}`, p.requires);
for (const a of gd.areas) checkReqs(`Area: ${a.name}`, a.requires);
for (const s of gd.combat?.slots ?? []) checkReqs(`Equipment slot: ${s.name}`, s.requires);
for (const m of gd.combat?.slayerMasters ?? []) checkReqs(`Slayer master: ${m.name}`, m.requires);
section('Above the level cap', `Requirements higher than the level cap (${cap}): nobody can reach these in this build.`, unreachable, ['Content', 'Requires']);

// 3. Items with no source, and 4. items with no use and no value.
// With the full data package (data/source) every object is searched: an item counts as obtainable
// if anything gives it (products, drops, rewards, chests...), not just what the companion models.
let packageSources = null;
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'data', 'source', raw.meta.source), 'utf8'));
  const INPUT_KEYS = /^(Ingredients|Costs|Eats|Treats|RuneCosts|Requirements|DisplayRequirements|UnlockRequirements|AccessRequirements|SecondaryRequirements|ConsumesOn|PreferredBait|ShortcutCosts|PurchaseCosts|Items?CompletionOrder|Bonuses|LocalContext|Condition|Conditions)$/;
  packageSources = new Set();
  const walk = (node, inputSide) => {
    if (typeof node === 'string') {
      if (!inputSide && /^[A-Za-z]+:[A-Za-z0-9_]+$/.test(node)) packageSources.add(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) walk(v, inputSide || INPUT_KEYS.test(k));
  };
  for (const [type, list] of Object.entries(pkg.Objects ?? {})) if (type !== 'Item') walk(list, false);
} catch {
  // only the companion's own sources are known
}
const hasSource = (id) => itemDetails(gd, id).sources.length > 0 || !!packageSources?.has(id);
const noSource = [];
const dead = [];
for (const [id, it] of Object.entries(gd.items)) {
  const d = itemDetails(gd, id);
  const isTool = !!it.tool;
  if (!hasSource(id)) noSource.push([it.name, (it.tags ?? []).join(', ') || (isTool ? 'tool' : ''), n(it.sell)]);
  if (!d.uses.length && !(it.sell > 0) && !(it.tags ?? []).length && !isTool && !it.heal) dead.push([it.name, d.sources.length ? `${d.sources.length} sources` : 'no source']);
}
section('Items with no known source', packageSources ? 'Nothing in the data package gives these: no product, drop, reward, chest or shop listing mentions them. Likely unobtainable, or given by code rather than data.' : 'Not made by any training method, not dropped by any enemy and not sold in the shop (run with data/source present for a full search).', noSource, ['Item', 'Type', 'Sells for']);
section('Items with no use and no value', 'Sell for nothing, aren\'t gear, food or tools, and nothing uses them.', dead, ['Item', 'Sources']);

// 5. Missing icons.
const missingIcons = [];
const iconFor = (what, path) => path && !icons[path] && missingIcons.push([what, path]);
for (const m of gd.methods) iconFor(`${m.skill}: ${m.name}`, m.icon);
for (const e of gd.enemies) iconFor(`Enemy: ${e.name}`, e.icon);
for (const p of gd.shop) iconFor(`Shop: ${p.name}`, p.icon);
for (const [id, it] of Object.entries(gd.items)) iconFor(`Item: ${it.name}`, it.icon);
section('Missing artwork', 'Picture paths the data points at that the game files don\'t contain (they show as blank or placeholder art).', missingIcons.slice(0, 200), ['Content', 'Path']);

// 6. Combat: enemies that appear in no area, and the hardest-hitting enemy per area.
const orphans = gd.enemies.filter((e) => !e.areas.length).map((e) => [e.name, Object.entries(e.levels).map(([k, v]) => `${k} ${v}`).join(', ')]);
section('Enemies in no combat area', 'Not placed in any combat area (dungeon, boss or quest enemies, or leftovers).', orphans, ['Enemy', 'Levels']);
const spikes = [];
for (const a of gd.areas) {
  const hits = a.enemies.map((id) => gd.enemyById.get(id)).filter(Boolean).map((e) => {
    const b = buildEnemy(gd, e);
    return { e, max: Math.max(...b.stances.map((s) => s.maxHit)) * b.biggestAttack, hp: b.hitpoints };
  });
  if (hits.length < 2) continue;
  const med = median(hits.map((h) => h.max));
  for (const h of hits) if (med > 0 && h.max >= med * 2.5) spikes.push([a.name, h.e.name, n(h.max), n(med)]);
}
section('Damage spikes within an area', 'Enemies whose biggest possible hit (before the player\'s protection) is 2.5× or more the area\'s median: a sudden difficulty jump for players clearing the area.', spikes, ['Area', 'Enemy', 'Max hit', 'Area median']);

// 7. Shop: purchases that need a purchase that doesn't exist, or cost items nobody can get.
const shopIssues = [];
for (const p of gd.shop) {
  for (const r of p.requires) if (r.type === 'purchase' && !gd.shopById.has(r.id)) shopIssues.push([p.name, `Requires missing purchase ${r.id}`]);
  for (const c of p.costs.items) if (!hasSource(c.item)) shopIssues.push([p.name, `Costs ${gd.itemName(c.item)}, which has no known source`]);
}
section('Shop problems', 'Purchases with missing prerequisites, or that cost items with no known source.', shopIssues, ['Purchase', 'Problem']);

// 8. Dry spells: long level ranges in a skill with nothing new to unlock.
const gaps = [];
for (const skill of gd.trainableSkills) {
  const levels = [...new Set(gd.methodsBySkill[skill].map((m) => m.level))].filter((l) => l <= cap).sort((a, b) => a - b);
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] >= 15) gaps.push([skill, `${levels[i - 1]} → ${levels[i]}`, levels[i] - levels[i - 1]]);
  const last = levels.at(-1);
  if (last != null && cap - last >= 15) gaps.push([skill, `${last} → ${cap} (cap)`, cap - last]);
}
gaps.sort((a, b) => b[2] - a[2]);
section('Unlock droughts', 'Level ranges of 15+ with no new training method (players may feel stuck or bored there).', gaps, ['Skill', 'Levels', 'Gap']);

// 9. Drop tables with odd numbers.
const drops = [];
for (const e of gd.enemies) {
  for (const t of e.tables) {
    if (t.chance > 1 || t.chance <= 0) drops.push([e.name, `Table chance ${t.chance}`]);
    for (const x of t.entries) if (x.weight === 0 || (x.chance != null && (x.chance > 1 || x.chance <= 0)) || x.min > x.max) drops.push([e.name, `${gd.itemName(x.item)}: weight ${x.weight ?? '-'}, chance ${x.chance ?? '-'}, ${x.min}–${x.max}`]);
  }
}
section('Odd drop table entries', 'Zero weights, chances outside 0–1, or a minimum above the maximum.', drops, ['Enemy', 'Entry']);

// Write the report.
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const lines = [
  '# Melvor Idle 2 data report',
  '',
  `Built from \`${raw.meta.source}\` (data generated ${raw.meta.generatedAt}). Level cap ${cap}. ${gd.methods.length} training methods, ${gd.enemies.length} enemies, ${Object.keys(gd.items).length} items, ${gd.shop.length} shop purchases.`,
  '',
  '| Check | Found |',
  '| --- | ---: |',
  ...sections.map((s) => `| [${s.title}](#${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}) | ${s.rows.length} |`),
  '',
];
for (const s of sections) {
  lines.push(`## ${s.title}`, '', s.intro, '');
  if (!s.rows.length) {
    lines.push('Nothing found.', '');
    continue;
  }
  lines.push(`| ${s.columns.join(' | ')} |`, `| ${s.columns.map(() => '---').join(' | ')} |`);
  for (const row of s.rows) lines.push(`| ${row.map(esc).join(' | ')} |`);
  lines.push('');
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${outPath}`);
for (const s of sections) console.log(`  ${String(s.rows.length).padStart(4)}  ${s.title}`);
