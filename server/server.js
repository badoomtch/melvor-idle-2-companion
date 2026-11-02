#!/usr/bin/env node
// Melvor Idle 2 Companion: a local web app that watches your saves and tells you what to do next.
//
//   node server/server.js [--port 47820] [--saves <folder>] [--no-open]
//
// Serves only to this computer (127.0.0.1). Saves are read, never written.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentActivity } from '../engine/advisor.js';
import { createGameData, ownedItems, playerBonuses, playerState } from '../engine/gamedata.js';
import { activityKey, measureFlows } from '../engine/supplies.js';
import { createXpTable } from '../engine/xp.js';
import { createAlertWatcher } from './alerts.js';
import { createRouteWatcher } from './route-watcher.js';
import { createHistoryStore } from './history-store.js';
import { createNotifier } from './notifier.js';
import { createObservationStore } from './observations.js';
import { listSaveFiles, resolveSaveDirs } from './save-locator.js';
import { readSaveFile } from './save-reader.js';
import { createUpdateCheck, repoFrom } from './update-check.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'companion-data.json');
// The packaged .exe keeps history outside its versioned app folder, so updates don't lose it.
const HISTORY_DIR = process.env.MELVOR_COMPANION_HISTORY || join(ROOT, 'history');
const STATIC_ROOTS = { '/ui/': join(ROOT, 'ui'), '/engine/': join(ROOT, 'engine'), '/data/': join(ROOT, 'data') };
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const HISTORY_LIMIT = 400; // about an hour of the game's 10-second autosaves
const STOCK_LIMIT = 120; // item counts for the last ~20 minutes, to measure what's being used up

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node server/server.js [--port 47820] [--saves <folder>] [--no-open]');
  process.exit(0);
}
if (!existsSync(DATA_FILE)) {
  console.error(`Missing ${DATA_FILE}. Run "npm run build-data" first.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const appVersion = pkg.version;
// Changes whenever the page's files or the game data change: an open page compares it after a
// reconnect and offers to reload, so it never runs old code against a new companion.
function buildId() {
  const hash = createHash('sha256').update(appVersion);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const st = statSync(file);
      if (st.isDirectory()) walk(file);
      else hash.update(`${file}:${st.size}:${st.mtimeMs}`);
    }
  };
  for (const dir of [join(ROOT, 'ui'), join(ROOT, 'engine')]) if (existsSync(dir)) walk(dir);
  hash.update(String(statSync(DATA_FILE).mtimeMs));
  return hash.digest('hex').slice(0, 12);
}
const build = buildId();
const mechanics = data.meta.mechanics;
const xpTable = createXpTable(mechanics.xpTable);
let saveDirs = resolveSaveDirs(args.saves);
const historyStore = createHistoryStore(HISTORY_DIR);
const observations = createObservationStore(HISTORY_DIR);
const notify = createNotifier();
const alerts = createAlertWatcher({ gd: createGameData(data), dir: HISTORY_DIR, notify });
// Plans use your own speed from what each action has really given you.
const routes = createRouteWatcher({ gd: createGameData(data), dir: HISTORY_DIR, notify, settings: () => alerts.settings, actions: (id) => observations.peek(id) });
// Whether GitHub has a newer release (package.json's repository, or MELVOR_COMPANION_REPO for a fork),
// unless it's turned off in Settings.
const updates = createUpdateCheck({ repo: process.env.MELVOR_COMPANION_REPO || repoFrom(pkg), current: appVersion, enabled: () => alerts.settings.checkUpdates !== false });

// What the companion predicted for the action a save shows, with that save's levels and bonuses, so a
// measurement is compared with the estimate of its own time, not one made after later upgrades.
const estimateGd = createGameData(data);
function predicted(parsed) {
  if (!parsed?.skills) return null;
  try {
    const levels = Object.fromEntries(Object.entries(parsed.skills).map(([k, s]) => [k, s.level]));
    estimateGd.player = playerState(parsed, estimateGd);
    estimateGd.playerBonuses = alerts.settings.useBonuses === false ? null : playerBonuses(estimateGd, parsed);
    const a = currentActivity(estimateGd, parsed.header, levels);
    return a?.skill && a.rates ? { skill: a.skill, xpPerHour: a.rates.xpPerHour } : null;
  } catch {
    return null;
  }
}

// Two consecutive autosaves of the same action: add what it gave to that action's record.
function recordObservation(id, before, after, beforeStock, afterStock, prediction = null) {
  if (!before || !after.activity || before.activity !== after.activity) return;
  const seconds = (after.t - before.t) / 1000;
  if (!(seconds > 0) || seconds > 120) return;
  const xp = Object.fromEntries(Object.entries(after.xp).map(([k, v]) => [k, v - (before.xp[k] ?? v)]).filter(([, d]) => d > 0));
  const items = {};
  if (beforeStock && afterStock) {
    for (const k of new Set([...Object.keys(beforeStock.stock), ...Object.keys(afterStock.stock)])) {
      const d = (afterStock.stock[k] ?? 0) - (beforeStock.stock[k] ?? 0);
      if (d) items[k] = d;
    }
  }
  // The same stretch's XP in the action's skill against what was predicted for it.
  const timed = prediction ? { seconds, xp: xp[prediction.skill] ?? 0, est: (prediction.xpPerHour * seconds) / 3600 } : null;
  observations.add(id, after.activity, seconds, xp, items, timed).catch((e) => console.error(`Could not record action: ${e.message}`));
}

// Bank value at sell prices (GP only), for the long-term history.
const bankValue = (parsed) => Object.entries(parsed.bank?.items ?? {}).reduce((sum, [id, qty]) => sum + (data.items[id]?.currency === 'GoldPieces' ? data.items[id].sell * qty : 0), 0);
const historyPoint = (parsed, snapshot) => ({
  t: snapshot.t,
  gp: parsed.header.gp,
  slayerCoins: parsed.header.slayerCoins,
  totalLevel: parsed.header.totalLevel,
  bank: bankValue(parsed),
  xp: Object.fromEntries(Object.entries(snapshot.xp).map(([k, v]) => [k, Math.round(v)])),
});

// id -> { id, file, mtimeMs, parsed, error, history[], stock[], flows }
const saves = new Map();
const clients = new Set();
let boundPort = 0;

function refresh() {
  saveDirs = resolveSaveDirs(args.saves);
  const files = listSaveFiles(saveDirs);
  const seen = new Set();
  const changed = [];
  for (const f of files) {
    seen.add(f.id);
    const entry = saves.get(f.id) ?? { id: f.id, history: [], stock: [], flows: null, parsed: null, error: null, mtimeMs: -1 };
    if (entry.mtimeMs === f.mtimeMs) continue;
    entry.file = f.file;
    const previousError = entry.error;
    const before = entry.parsed;
    try {
      const parsed = readSaveFile(f.file, { levelCap: mechanics.levelCap, xpTable });
      entry.parsed = parsed;
      entry.error = null;
      entry.mtimeMs = f.mtimeMs;
      const snapshot = {
        t: parsed.header.timestamp,
        gp: parsed.header.gp,
        activity: activityKey(parsed.header),
        xp: Object.fromEntries(Object.entries(parsed.skills).map(([skill, s]) => [skill, s.xp])),
      };
      if (entry.history.at(-1)?.t !== snapshot.t) {
        const previous = entry.history.at(-1);
        const previousStock = entry.stock.at(-1);
        entry.history.push(snapshot);
        if (entry.history.length > HISTORY_LIMIT) entry.history.shift();
        entry.stock.push({ t: snapshot.t, activity: snapshot.activity, stock: ownedItems(parsed) });
        if (entry.stock.length > STOCK_LIMIT) entry.stock.shift();
        recordObservation(f.id, previous, snapshot, previousStock, entry.stock.at(-1), predicted(before ?? parsed));
        entry.flows = measureFlows(entry.stock);
        historyStore.record(f.id, historyPoint(parsed, snapshot)).catch((e) => console.error(`Could not write history: ${e.message}`));
        try {
          alerts.onSave(f.id, before, { ...parsed, history: entry.history, flows: entry.flows });
        } catch (e) {
          console.error(`Could not check alerts: ${e.message}`);
        }
        try {
          routes.onSave(f.id, { ...parsed, history: entry.history });
        } catch (e) {
          console.error(`Could not update the plan: ${e.message}`);
        }
      }
      changed.push(f.id);
    } catch (e) {
      // Usually the game is mid-write; keep the last good parse and retry on the next tick.
      entry.error = e.message;
      entry.mtimeMs = -1;
      if (entry.error !== previousError) changed.push(f.id);
    }
    saves.set(f.id, entry);
  }
  // The game swaps files when it saves (.sav -> .bak, then .tmp -> .sav), so a save can vanish for a moment.
  const now = Date.now();
  for (const [id, entry] of saves) {
    if (seen.has(id)) {
      entry.missingSince = null;
      continue;
    }
    entry.missingSince ??= now;
    if (now - entry.missingSince > 30_000) {
      saves.delete(id);
      changed.push(id);
    }
  }
  if (changed.length) broadcast({ type: 'saves-changed', ids: changed });
}

let refreshTimer = null;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 700);
};

// One watcher per save folder; folders can appear later (first launch, a new Steam account).
const watchers = new Map();
function ensureWatchers() {
  for (const dir of saveDirs) {
    if (watchers.has(dir) || !existsSync(dir)) continue;
    try {
      const w = watch(dir, scheduleRefresh);
      w.on('error', () => {
        w.close();
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {
      // retried on the next poll
    }
  }
}

function summary(entry) {
  const h = entry.parsed?.header;
  return {
    id: entry.id,
    error: entry.parsed ? null : entry.error,
    name: h?.characterName ?? null,
    totalLevel: h?.totalLevel ?? null,
    gp: h?.gp ?? null,
    timestamp: h?.timestamp ?? null,
    activity: [h?.activeEntityName, h?.activeActionName].filter(Boolean).join(' - '),
    isDemo: h?.isDemo ?? null,
  };
}

function mostRecentSaveId() {
  let best = null;
  for (const e of saves.values()) {
    if (e.parsed && (!best || e.parsed.header.timestamp > best.parsed.header.timestamp)) best = e;
  }
  return best?.id ?? null;
}

function broadcast(message) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(line);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendStatic(req, res, rootDir, relativePath) {
  let rel;
  try {
    rel = decodeURIComponent(relativePath);
  } catch {
    rel = '\0';
  }
  const file = resolve(rootDir, rel);
  if (rel.includes('\0') || !file.startsWith(rootDir + sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    // Revalidated on every load; unchanged files answer 304 so reloads stay quick.
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const body = await readFile(file);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Only answer requests addressed to this machine, which stops other websites from
// reading the companion through DNS rebinding.
function isAllowedHost(host) {
  return [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(String(host ?? '').toLowerCase());
}

const server = createServer(async (req, res) => {
  try {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    if (req.method === 'POST' && (url.pathname.startsWith('/api/alerts') || url.pathname === '/api/route/replan')) return handlePost(req, res, url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    switch (url.pathname) {
      case '/api/alerts':
        return sendJson(res, alerts.settings);
      case '/api/route': {
        const id = url.searchParams.get('id') || mostRecentSaveId();
        return sendJson(res, { id, plan: id ? routes.get(id) : null });
      }
      case '/':
        return sendStatic(req, res, STATIC_ROOTS['/ui/'], 'index.html');
      case '/api/status':
        return sendJson(res, {
          appVersion,
          build,
          data: { source: data.meta.source, generatedAt: data.meta.generatedAt, includeLocked: data.meta.includeLocked },
          saveDirs,
          saveDirExists: saveDirs.some((d) => existsSync(d)),
          saves: [...saves.values()].map(summary).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)),
          defaultSaveId: mostRecentSaveId(),
          update: updates.info(),
        });
      case '/api/save': {
        const id = url.searchParams.get('id') || mostRecentSaveId();
        const entry = id ? saves.get(id) : null;
        if (!entry?.parsed) return sendJson(res, { error: entry?.error ?? 'No save found' }, 404);
        return sendJson(res, { id, ...entry.parsed, history: entry.history, flows: entry.flows });
      }
      case '/api/observations': {
        const id = url.searchParams.get('id') || mostRecentSaveId();
        return sendJson(res, { id, actions: id ? await observations.get(id) : {} });
      }
      case '/api/history': {
        const id = url.searchParams.get('id') || mostRecentSaveId();
        const entry = id ? saves.get(id) : null;
        const points = id ? await historyStore.read(id) : [];
        // Add the live point so today's numbers are up to date between stored points.
        const latest = entry?.parsed && entry.history.at(-1);
        if (latest && latest.t > (points.at(-1)?.t ?? 0)) points.push(historyPoint(entry.parsed, latest));
        return sendJson(res, { id, points });
      }
      case '/api/events':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }
    for (const [prefix, dir] of Object.entries(STATIC_ROOTS)) {
      if (url.pathname.startsWith(prefix)) return sendStatic(req, res, dir, url.pathname.slice(prefix.length));
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
  }
});

// The only things the page can change: alert settings, a test notification, and asking for a new plan.
// JSON only, from the companion's own page: another website can't send a JSON POST here without a CORS
// preflight, which this server never answers.
function handlePost(req, res, path) {
  const origin = req.headers.origin;
  if ((origin && !isAllowedHost(origin.replace(/^http:\/\//, ''))) || !/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 65_536) req.destroy();
  });
  req.on('end', () => {
    try {
      if (path === '/api/alerts/test') {
        notify('Melvor Idle 2 Companion', 'Notifications are working. You will get alerts here while the companion runs.');
        return sendJson(res, { ok: true });
      }
      if (path === '/api/route/replan') {
        const { id } = JSON.parse(body || '{}');
        const plan = typeof id === 'string' ? routes.replan(id) : null;
        return plan ? sendJson(res, { id, plan }) : sendJson(res, { error: 'No save to plan from yet' }, 404);
      }
      if (path !== '/api/alerts') return sendJson(res, { error: 'Not found' }, 404);
      const settings = alerts.setSettings(JSON.parse(body || '{}'));
      updates.check(); // switched on just now: look straight away
      return sendJson(res, settings);
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  });
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser launcher available; the URL is printed anyway
  }
}

// Tries the port, then the next ones if they're taken. Each attempt removes its own listeners, so only
// the port that actually opens announces itself (and opens the browser).
function listen(port, retries = 20) {
  const onListening = () => {
    server.off('error', onError);
    started(port);
  };
  const onError = (e) => {
    server.off('listening', onListening);
    if (e.code === 'EADDRINUSE' && retries > 0) return listen(port + 1, retries - 1);
    console.error(`Could not start the companion: ${e.message}`);
    process.exit(1);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

function started(port) {
  boundPort = port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\n  Melvor Idle 2 Companion v${appVersion}`);
  console.log(`  Open:     ${url}`);
  const found = saveDirs.filter((d) => existsSync(d));
  console.log(`  Saves:    ${found.length ? found.join('\n            ') : `${saveDirs[0]}  (not found yet - start the game, or pass --saves <folder>)`}`);
  console.log(`  Found:    ${saves.size} save${saves.size === 1 ? '' : 's'}`);
  console.log('  Press Ctrl+C to stop.\n');
  if (!args.noOpen) openBrowser(url);
}

function parseArgs(argv) {
  const out = { port: 47820, saves: undefined, noOpen: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--saves') out.saves = resolve(argv[++i]);
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

refresh();
ensureWatchers();
updates.start();
setInterval(() => {
  ensureWatchers();
  refresh();
  alerts.tick();
}, 10_000).unref();
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();
listen(args.port);
