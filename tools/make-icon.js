#!/usr/bin/env node
// Makes ui/brand/logo.ico, the Windows program icon, from ui/brand/logo.svg: the logo drawn at each
// icon size by headless Chrome (or Edge) on a see-through background, packed as PNG images.
// tools/build-exe.js puts it into the exe. Run it again whenever the logo changes:
//
//   node tools/make-icon.js            (set CHROME to the browser's path if it isn't found)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(ROOT, 'ui', 'brand', 'logo.svg');
const OUT = join(ROOT, 'ui', 'brand', 'logo.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PORT = 9341;

const browser = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME to its path.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'companion-icon-'));
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = [];
for (let i = 0; i < 50 && !targets.some((t) => t.type === 'page'); i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((done) => {
  const n = ++id;
  pending.set(n, done);
  ws.send(JSON.stringify({ id: n, method, params }));
});

// Each size on its own see-through page, the logo filling it.
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const logo = `data:image/svg+xml;base64,${readFileSync(SVG).toString('base64')}`;
const images = [];
for (const size of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  const page = `data:text/html,${encodeURIComponent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${logo}">`)}`;
  await send('Page.navigate', { url: page });
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  images.push({ size, png: Buffer.from(shot.result.data, 'base64') });
}
ws.close();
proc.kill();
await sleep(300);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  // the browser may still hold it for a moment
}

// The .ico: a 6-byte header, a 16-byte entry per image, then the PNG images.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, png }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // no palette
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
console.log(`Wrote ui/brand/logo.ico: ${images.map((i) => i.size).join(', ')} px (${(offset / 1024).toFixed(0)} KB).`);
process.exit(0);
