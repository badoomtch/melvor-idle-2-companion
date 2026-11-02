// Companion UI controller: loads data and saves, keeps state, routes, and re-renders on change.
import { currentActivity } from '/engine/advisor.js';
import { createGameData, playerBonuses, playerCombatMods, playerState } from '/engine/gamedata.js';
import { playtestReport } from '/engine/playtest-report.js';
import { activityKey, currentSupplies, totalXp } from '/engine/supplies.js';
import { installChartTooltips } from '/ui/charts.js';
import { configureIcons, duration, esc, exact, iconUrl } from '/ui/format.js';
import { AUTOSAVE_MS, renderLivePill, renderMini, renderSaveBar, renderTabs, renderTopAlerts, renderView, TABS, THEMES, topAlerts } from '/ui/views.js';
import { itemCard } from '/ui/pages/item-info.js';

const main = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const savebarEl = document.getElementById('savebar');
const topAlertsEl = document.getElementById('top-alerts');
const heartbeatEl = document.getElementById('heartbeat');
const toastsEl = document.getElementById('toasts');
const hoverEl = document.getElementById('hover-card');

// localStorage can be unavailable (private windows, blocked storage); the app works without it.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`melvor-companion:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`melvor-companion:${key}`, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
};

const state = {
  status: null,
  save: null,
  saveId: store.get('saveId', null),
  levelSource: store.get('levelSource', 'save'),
  manualLevels: store.get('manualLevels', {}),
  food: store.get('food', null),
  goals: store.get('goals', []),
  theme: store.get('theme', 'system'),
  notify: store.get('notify', false),
  alerts: { runningOut: true, stopped: true, planSteps: true, harvests: true, ranch: true, rareFinds: true, minutes: 15, ...store.get('alerts', {}) },
  useBonuses: store.get('useBonuses', true),
  // The plan on What next: the companion keeps it and moves it on with each autosave (server/route-watcher.js).
  plan: null,
  serverAlerts: null,
  route: { tab: 'overview', args: [] },
  live: { connected: false, pulse: false },
  ui: {
    expanded: new Set(),
    sort: 'xp',
    skillOverride: {},
    lastSkill: null,
    calc: { skill: null, target: null, methodKey: 'best' },
    offline: { methodKey: '', hours: 8 },
    drop: { chance: 1, tries: 100 },
    lookupQuery: '',
    bankFilter: '',
    goalSkill: null,
    goalTarget: 10,
    combat: { style: null, skill: '', sort: 'xp', target: {}, showAll: false, showRisky: false },
    // Kept between visits: the rarity picked and "Only ones I haven't found".
    rare: { band: 'all', missing: false, ...store.get('rare', {}) },
    away: { hours: store.get('awayHours', 8), goal: 'xp', skill: '' },
    // How long the Overview's stock-up plans for.
    stockHours: store.get('stockHours', 2),
  },
};
let gd = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const clampLevel = (n) => Math.min(Math.max(Math.round(Number(n) || 1), 1), gd.levelCap);

// Desktop notifications sent by the companion itself (see server/alerts.js). When they're on, this page
// leaves desktop notifications to the companion and only shows its own pop-ups.
async function loadServerAlerts() {
  try {
    state.serverAlerts = await fetchJson('/api/alerts');
    if (state.serverAlerts.enabled) await syncServerAlerts();
  } catch {
    state.serverAlerts = null; // an older companion without them
  }
}
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
// The companion needs this page's alert choices and goals to send the same alerts.
async function syncServerAlerts(enabled = state.serverAlerts?.enabled) {
  if (!state.serverAlerts) return;
  try {
    state.serverAlerts = await postJson('/api/alerts', {
      enabled,
      levelUps: true,
      runningOut: state.alerts.runningOut,
      stopped: state.alerts.stopped,
      planSteps: state.alerts.planSteps !== false,
      harvests: state.alerts.harvests !== false,
      ranch: state.alerts.ranch !== false,
      rareFinds: state.alerts.rareFinds !== false,
      minutes: state.alerts.minutes,
      useBonuses: state.useBonuses,
      checkUpdates: state.serverAlerts.checkUpdates !== false,
      goals: state.goals.map(({ skill, target }) => ({ skill, target })),
    });
  } catch (e) {
    toast("Couldn't update the companion's notifications", e.message);
  }
}

async function loadStatus() {
  try {
    state.status = await fetchJson('/api/status');
  } catch {
    state.status = null;
  }
}

// The plan the companion is keeping for this save.
async function loadPlan() {
  if (!state.saveId) return;
  try {
    const p = await fetchJson(`/api/route?id=${encodeURIComponent(state.saveId)}`);
    state.plan = p.plan ? { id: p.id, ...p.plan } : null;
  } catch {
    // keep what we had
  }
}

// Says when the plan moves on while you're looking (the companion sends the desktop notification).
function announcePlan(before, after) {
  if (!before || !after || before.id !== after.id || before.madeAt !== after.madeAt || state.levelSource !== 'save') return;
  const was = new Set(before.done);
  const steps = after.legs.flatMap((l) => l.steps).filter((st) => after.done.includes(st.id) && !was.has(st.id));
  const goal = after.legs.find((l) => l.steps.every((st) => after.done.includes(st.id)) && l.steps.some((st) => !was.has(st.id)));
  const title = (g) => (g.kind === 'gear' ? `${g.label} made: equip it` : g.kind === 'mastery' ? `${gd.skillName(g.skill)} Mastery: ${g.label}` : `${gd.skillName(g.skill)} ${g.to} reached`);
  if (goal) toast(title(goal), 'On to the next goal in your plan.');
  else if (steps.length) toast(steps.length === 1 ? 'Plan step done' : `${steps.length} plan steps done`, 'What next shows the next one.');
}

// What each action really gave you, for the Accuracy page.
async function loadObservations() {
  if (state.route.tab !== 'accuracy' || !state.saveId) return;
  try {
    const o = await fetchJson(`/api/observations?id=${encodeURIComponent(state.saveId)}`);
    state.observations = { id: o.id, actions: o.actions };
  } catch {
    // keep what we had
  }
}

// Long-term history for the History page, fetched when it's open.
async function loadHistory() {
  if (!['history', 'shop'].includes(state.route.tab) || !state.saveId) return;
  try {
    const h = await fetchJson(`/api/history?id=${encodeURIComponent(state.saveId)}`);
    state.history = { id: h.id, points: h.points };
  } catch {
    // keep what we had
  }
}

// Rare finds the companion has logged (server/rare-finds.js), for the Rare items page.
async function loadFinds() {
  if (state.route.tab !== 'rare' || !state.saveId) return false;
  try {
    const f = await fetchJson(`/api/finds?id=${encodeURIComponent(state.saveId)}`);
    state.finds = { id: f.id, list: f.finds };
  } catch {
    // keep what we had
  }
  return true;
}

// "While you were away" on the Overview (pages/away-summary.js): when this page comes back into view more
// than 30 minutes after you last had it open, what happened in between. Its history and rare finds are
// fetched once, so the numbers don't move while you read them, and it stays until you dismiss it.
const AWAY_MS = 30 * 60_000;
function noteSeen() {
  if (document.hidden || !gd) return;
  const now = Date.now();
  const last = store.get('lastSeen', null);
  if (last && now - last > AWAY_MS && state.saveId) {
    const away = { id: state.saveId, from: last, to: now, points: null, finds: [] };
    state.awaySummary = away;
    const q = `?id=${encodeURIComponent(away.id)}`;
    Promise.all([fetchJson(`/api/history${q}`), fetchJson(`/api/finds${q}`).catch(() => ({ finds: [] }))])
      .then(([h, f]) => Object.assign(away, { points: h.points, finds: f.finds }))
      .catch(() => Object.assign(away, { points: [] }))
      .then(render);
  }
  if (!last || now - last >= 10_000) store.set('lastSeen', now);
}
document.addEventListener('visibilitychange', () => (document.hidden ? store.set('lastSeen', Date.now()) : noteSeen()));

async function loadSave() {
  const saves = state.status?.saves ?? [];
  if (!saves.some((s) => s.id === state.saveId && !s.error)) state.saveId = state.status?.defaultSaveId ?? null;
  if (!state.saveId) {
    state.save = null;
    return;
  }
  try {
    state.save = await fetchJson(`/api/save?id=${encodeURIComponent(state.saveId)}`);
  } catch {
    // Keep the previous parse if the game is mid-write.
  }
}

function levelsAndXp() {
  const levels = {};
  const xp = {};
  const fromSave = state.levelSource === 'save' && state.save;
  for (const s of gd.skills) {
    if (fromSave) {
      const k = state.save.skills[s.id];
      levels[s.id] = k?.level ?? 1;
      xp[s.id] = k?.xp ?? gd.xp.xpForLevel(levels[s.id]);
    } else {
      levels[s.id] = clampLevel(state.manualLevels[s.id] ?? 1);
      xp[s.id] = gd.xp.xpForLevel(levels[s.id]);
    }
  }
  return { levels, xp };
}

// Real XP per hour (including every bonus the player has) over the latest unbroken stretch of play.
// The game autosaves every 10 seconds, so a longer gap means it was closed or paused.
const PLAY_GAP_MS = 120_000;
const MEASURE_WINDOW_MS = 3_600_000;

function measuredRates() {
  const history = state.save?.history ?? [];
  if (state.levelSource !== 'save' || history.length < 2) return { rates: {}, minutes: 0 };
  const last = history.at(-1);
  let i = history.length - 1;
  // Only saves of the action you're doing now, so switching actions doesn't blend two rates.
  while (i > 0 && history[i].t - history[i - 1].t <= PLAY_GAP_MS && last.t - history[i - 1].t <= MEASURE_WINDOW_MS && history[i - 1].activity === last.activity) i--;
  const first = history[i];
  const hours = (last.t - first.t) / 3_600_000;
  if (hours < 30 / 3600) return { rates: {}, minutes: 0 };
  const rates = {};
  for (const [skill, xp] of Object.entries(last.xp)) {
    const gained = xp - (first.xp[skill] ?? xp);
    if (gained > 0) rates[skill] = gained / hours;
  }
  return { rates, minutes: hours * 60 };
}

// Tells the engine what the save shows you own and have equipped, so tool requirements can be checked.
function syncPlayer() {
  const save = state.levelSource === 'save' ? state.save : null;
  gd.player = save ? playerState(save, gd) : null;
  // Your upgrades, tools, potions, pets and prayers go into every rate unless you switch them off.
  const counted = save && state.useBonuses;
  gd.playerBonuses = counted ? playerBonuses(gd, save) : null;
  gd.playerCombatMods = counted ? playerCombatMods(gd, save) : null;
}

function viewContext() {
  syncPlayer();
  const { levels, xp } = levelsAndXp();
  const measured = measuredRates();
  const bank = state.save?.bank?.items ?? null;
  // Stock for materials and supplies: the bank plus toolbelts and worn gear.
  const stock = gd.player?.owned ?? bank;
  return { state, gd, levels, xp, bank, stock, save: state.save, measured: measured.rates, measuredMinutes: measured.minutes, persist: (key, value) => store.set(key, value) };
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const tab = parts[0] === 'mini' || TABS.some(([id]) => id === parts[0]) ? parts[0] : 'overview';
  return { tab, args: parts.slice(1) };
}

// A newer release on GitHub: where to get it, until you download it or say "Not now".
// Once, until answered: desktop notifications are off until you turn them on, and running out of
// arrows with the page in the background is exactly what they're for.
function notifyPrompt() {
  if (!state.serverAlerts || state.serverAlerts.enabled || store.get('notifyAsked', false)) return '';
  return `<div class="notice"><span>Get a desktop notification when you run out of something, nothing is training or the game stops saving? It works with this page closed.</span><span><button class="primary" data-action="notifyYes">Turn on</button> <button data-action="notifyNo">No thanks</button></span></div>`;
}

function newRelease() {
  const latest = state.status?.update?.latest;
  if (!latest || store.get('skipVersion', null) === latest.version) return '';
  return `<div class="notice update-ready"><span>Version ${esc(latest.version)} of the companion is out (you have ${esc(state.status.update.current)}). <a href="${esc(latest.url)}" target="_blank" rel="noopener">Download it from GitHub</a></span><button data-action="skipVersion" data-value="${esc(latest.version)}">Not now</button></div>`;
}

function render() {
  const ctx = viewContext();
  const active = document.activeElement;
  const focusId = active?.id && main.contains(active) ? active.id : null;
  const selection = focusId && (active.type === 'text' || active.type === 'search') ? [active.selectionStart, active.selectionEnd] : null;

  tabsEl.innerHTML = renderTabs(state.route, ctx);
  // Autosaves re-render the top bar; keep the theme menu open if you're looking at it.
  const menuOpen = document.getElementById('theme-menu')?.open;
  savebarEl.innerHTML = renderSaveBar(ctx);
  if (menuOpen) document.getElementById('theme-menu').open = true;
  // What needs you now: stays in the top bar while it's true, with a tone for a new red one if you want it.
  const warnings = topAlerts(ctx);
  topAlertsEl.innerHTML = renderTopAlerts(ctx, warnings);
  chime(warnings);
  document.title = pageTitle(ctx);
  renderMiniWindow(ctx);
  // #/mini is the pop-up fallback when the browser can't pin a window on top.
  document.body.classList.toggle('mini-mode', state.route.tab === 'mini');
  try {
    const update = state.updateReady ? '<div class="notice update-ready"><span>The companion was updated. Reload to use the new version.</span><button class="primary" data-action="reload">Reload</button></div>' : newRelease();
    main.innerHTML = state.route.tab === 'mini' ? `<div class="mini">${renderMini(ctx)}</div>` : update + notifyPrompt() + renderView(ctx);
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection) el.setSelectionRange(...selection);
    }
  }
}

// The tab title shows what you're training, so it's readable from the taskbar.
function pageTitle(ctx) {
  const activity = ctx.save && currentActivity(gd, ctx.save.header, ctx.levels);
  if (!activity?.skill) return 'Melvor Idle 2 Companion';
  const skill = gd.skillName(activity.skill);
  return `${skill} ${ctx.levels[activity.skill]}${activity.method ? ` · ${activity.method.name}` : ''} | Melvor Idle 2 Companion`;
}

function applyTheme() {
  if (state.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}

function setTheme(theme) {
  if (!THEMES.some((t) => t.id === theme)) return;
  state.theme = theme;
  store.set('theme', theme);
  applyTheme();
}

// Pop-ups in the corner, plus a desktop notification when this tab is in the background.
function toast(title, body = '', icon = null) {
  state.lastAlert = { title, body, at: Date.now() };
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon ? `<img class="icon" src="${esc(icon)}" alt="">` : ''}<div><strong>${esc(title)}</strong>${body ? `<span class="small muted">${esc(body)}</span>` : ''}</div>`;
  toastsEl.append(el);
  while (toastsEl.children.length > 4) toastsEl.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, 7000);
  if (state.notify && !state.serverAlerts?.enabled && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: icon ?? undefined, tag: title });
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}

// Compares two parses of the same save and announces level-ups and goals reached.
function announceProgress(before, after) {
  if (!before || !after || before.id !== after.id || state.levelSource !== 'save') return;
  for (const s of gd.skills) {
    const was = before.skills[s.id]?.level;
    const now = after.skills[s.id]?.level;
    if (!was || !now || now <= was) continue;
    const icon = iconUrl(s.icon);
    toast(`${s.name} level ${now}`, now - was > 1 ? `Up ${now - was} levels` : '', icon);
    for (const g of state.goals) {
      if (g.skill === s.id && was < g.target && now >= g.target) toast(`Goal reached: ${s.name} ${g.target}`, `${s.name} is level ${now} now.`, icon);
    }
  }
  if (before.header.totalLevel < after.header.totalLevel && after.header.totalLevel % 50 === 0) {
    toast(`Total level ${exact(after.header.totalLevel)}`, 'Another milestone.');
  }
}

// The mini window: an always-on-top Document Picture-in-Picture window where the browser supports
// it (Chrome, Edge), otherwise a small pop-up of #/mini.
let miniWindow = null;
async function openMiniWindow() {
  if (miniWindow) {
    miniWindow.focus();
    return;
  }
  const popup = () => window.open(`${location.origin}/#/mini`, 'melvor-mini', 'popup,width=360,height=560');
  if (!('documentPictureInPicture' in window)) {
    popup();
    return;
  }
  let pip;
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 460 });
  } catch {
    // Some embedded browsers expose the API but can't open the window.
    popup();
    return;
  }
  const css = pip.document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${location.origin}/ui/styles.css`;
  pip.document.head.append(css);
  pip.document.title = 'Melvor Idle 2 Companion';
  if (document.documentElement.dataset.theme) pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pip.document.body.innerHTML = '<div class="mini" id="mini-root"></div>';
  pip.addEventListener('pagehide', () => {
    miniWindow = null;
  });
  miniWindow = pip;
  renderMiniWindow(viewContext());
}
function renderMiniWindow(ctx) {
  const root = miniWindow?.document.getElementById('mini-root');
  if (!root) return;
  miniWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? '';
  if (!document.documentElement.dataset.theme) delete miniWindow.document.documentElement.dataset.theme;
  root.innerHTML = renderMini(ctx);
}

// Warnings about the game: supplies running low, and progress stopping. Each fires once until it clears.
const alerted = { low: new Set(), stuck: null, stale: false, sawSave: false, staleShown: null };
function checkAlerts(before, after) {
  if (!after || state.levelSource !== 'save' || (before && before.id !== after.id)) return;
  const ctx = viewContext();
  if (state.alerts.runningOut) {
    for (const s of currentSupplies(gd, after, ctx.levels, ctx.stock)) {
      const minutes = s.hoursLeft * 60;
      if (minutes <= state.alerts.minutes && !alerted.low.has(s.item)) {
        alerted.low.add(s.item);
        const name = gd.itemName(s.item);
        toast(s.qty > 0 ? `Running low: ${name}` : `Out of ${name}`, s.qty > 0 ? `About ${duration(s.hoursLeft)} left (${exact(s.qty)} left).` : 'The game will stop what it was doing.', iconUrl(gd.items[s.item]?.icon));
      } else if (minutes > state.alerts.minutes * 1.5) {
        alerted.low.delete(s.item);
      }
    }
  }
  if (!state.alerts.stopped || !before) return;
  const was = activityKey(before.header);
  const now = activityKey(after.header);
  if (was && !now) toast('Nothing is training', `${was} stopped.`);
  // Same action for 90 seconds of autosaves without any XP: stuck (bank full, nothing to burn, ...).
  const recent = (after.history ?? []).slice(-10);
  const flat = recent.length >= 10 && recent.at(-1).t - recent[0].t >= 85_000 && totalXp(recent[0]) === totalXp(recent.at(-1));
  if (now && flat && alerted.stuck !== now) {
    alerted.stuck = now;
    toast('No XP for 90 seconds', `${now} isn't gaining anything. Is it stuck?`);
  } else if (!flat) {
    alerted.stuck = null;
  }
}

// A short tone when a red warning (out of something, no XP) appears that wasn't there before, if it's
// switched on in Settings. Browsers only allow sound after a click on the page, so the player's next
// click wakes it up.
const heard = new Set();
let audio = null;
function chime(warnings) {
  const bad = warnings.filter((w) => w.level === 'bad').map((w) => w.text);
  const fresh = bad.some((t) => !heard.has(t));
  heard.clear();
  for (const t of bad) heard.add(t);
  if (!fresh || !state.alerts.sound || !audio || audio.state !== 'running') return;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.frequency.value = 660;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
  tone.connect(gain).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 0.6);
}
document.addEventListener('click', () => {
  if (!state.alerts.sound || !('AudioContext' in window)) return;
  audio ??= new AudioContext();
  if (audio.state === 'suspended') audio.resume();
});

// Point at an item anywhere and a card says what it is, without leaving the page; anything with a
// data-tip (the ? beside a swap) shows its text the same way. Keyboard focus works too.
function showHover(target) {
  const link = target.closest?.('a[href^="#/lookup/item/"], [data-tip]');
  if (!link || !main.contains(link) && !link.closest('#tabs, .topbar')) return hideHover();
  const html = link.dataset.tip
    ? `<p class="small">${esc(link.dataset.tip)}</p>`
    : itemCard(viewContext(), decodeURIComponent(link.getAttribute('href').replace('#/lookup/item/', '')));
  if (!html) return hideHover();
  hoverEl.innerHTML = html;
  hoverEl.hidden = false;
  const r = link.getBoundingClientRect();
  const w = hoverEl.offsetWidth;
  const h = hoverEl.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  const below = r.bottom + 8 + h < window.innerHeight;
  hoverEl.style.left = `${left}px`;
  hoverEl.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
}
function hideHover() {
  hoverEl.hidden = true;
}
document.addEventListener('mouseover', (e) => showHover(e.target));
document.addEventListener('focusin', (e) => showHover(e.target));
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || !e.target.closest?.('a[href^="#/lookup/item/"], [data-tip]')?.contains(e.relatedTarget)) hideHover();
});
window.addEventListener('scroll', hideHover, { passive: true });
window.addEventListener('hashchange', hideHover);

// Once a second: the "updated Xs ago" pill and the autosave bar under the top bar.
function tick() {
  const pill = document.getElementById('live-pill');
  const ctx = { state, save: state.save };
  if (pill) pill.innerHTML = renderLivePill(ctx);
  const miniPill = miniWindow?.document.getElementById('mini-live') ?? document.getElementById('mini-live');
  if (miniPill) miniPill.innerHTML = renderLivePill(ctx);
  const age = state.save ? Date.now() - state.save.header.timestamp : Infinity;
  const live = state.levelSource === 'save' && state.live.connected && age <= 60_000;
  heartbeatEl.style.width = live ? `${Math.min(100, (age / AUTOSAVE_MS) * 100)}%` : '100%';
  heartbeatEl.parentElement.classList.toggle('stale', !live);
  // The top bar's warnings change on their own when the game stops saving.
  const stale = !!state.save && state.live.connected && age > 120_000;
  if (stale !== alerted.staleShown || (stale && age % 60_000 < 1000)) {
    alerted.staleShown = stale;
    topAlertsEl.innerHTML = renderTopAlerts(viewContext());
  }
  // The game was saving while this page was open, then stopped for two minutes.
  if (state.alerts.stopped && alerted.sawSave && !alerted.stale && state.live.connected && age > 120_000) {
    alerted.stale = true;
    toast('The game stopped saving', 'It may have been closed, paused or frozen.');
  }
  // Also after the computer sleeps with this page in view.
  noteSeen();
}

const ACTIONS = {
  reload() {
    location.reload();
  },
  // A new release on GitHub you'd rather not hear about again.
  skipVersion(el) {
    store.set('skipVersion', el.dataset.value);
    render();
  },
  async checkUpdates() {
    if (!state.serverAlerts) return;
    state.serverAlerts = { ...state.serverAlerts, checkUpdates: state.serverAlerts.checkUpdates === false };
    await syncServerAlerts();
    render();
  },
  // What next: a fresh plan when you'd rather not follow this one.
  async replan() {
    if (!state.save) return;
    try {
      const p = await postJson('/api/route/replan', { id: state.save.id });
      state.plan = { id: p.id, ...p.plan };
    } catch (e) {
      toast("Couldn't make a new plan", e.message);
    }
    render();
  },
  theme(el) {
    setTheme(el.dataset.value);
    el.closest('details')?.removeAttribute('open');
  },
  async notify() {
    if (state.notify && Notification.permission === 'granted') {
      state.notify = false;
    } else {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      state.notify = permission === 'granted';
      if (state.notify) toast('Desktop notifications on', "You'll get one when you level up while this tab is in the background.");
    }
    store.set('notify', state.notify);
    render();
  },
  useBonuses() {
    state.useBonuses = !state.useBonuses;
    store.set('useBonuses', state.useBonuses);
    syncServerAlerts();
  },
  alertToggle(el) {
    state.alerts = { ...state.alerts, [el.dataset.key]: !state.alerts[el.dataset.key] };
    store.set('alerts', state.alerts);
    syncServerAlerts();
  },
  async notifyYes() {
    store.set('notifyAsked', true);
    await ACTIONS.serverAlerts();
  },
  stockHours(el) {
    state.ui.stockHours = Number(el.dataset.value);
    store.set('stockHours', state.ui.stockHours);
  },
  notifyNo() {
    store.set('notifyAsked', true);
    toast('No desktop notifications', 'Warnings still show at the top of the page. Turn notifications on any time in Settings.');
  },
  async serverAlerts() {
    await syncServerAlerts(!state.serverAlerts?.enabled);
    if (state.serverAlerts?.enabled) toast('Companion notifications on', 'Alerts now arrive as desktop notifications while the companion runs, even with this page closed.');
    render();
  },
  // The playtest report (engine/playtest-report.js) as a file the player can choose to share.
  async exportStats() {
    if (!state.save) return;
    let actions = {};
    try {
      actions = (await fetchJson(`/api/observations?id=${encodeURIComponent(state.save.id)}`)).actions ?? {};
    } catch {
      // older companion: no measurements to include
    }
    const report = playtestReport(gd, state.save, { levels: levelsAndXp().levels, observations: actions, appVersion: state.status?.appVersion ?? null });
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `melvor-playtest-stats-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Stats file saved', 'Check your downloads folder.');
  },
  async testServerAlert() {
    try {
      await postJson('/api/alerts/test', {});
    } catch (e) {
      toast("Couldn't send a test notification", e.message);
    }
  },
  testToast() {
    const s = gd.skills.find((k) => state.save?.skills[k.id]) ?? gd.skills[0];
    const level = state.save?.skills[s.id]?.level ?? 2;
    toast(`${s.name} level ${level}!`, 'This is what a level-up looks like.', iconUrl(s.icon));
  },
  historyRange(el) {
    state.ui.historyRange = el.dataset.value;
  },
  async popOut() {
    await openMiniWindow();
  },
  slayerSort(el) {
    state.ui.slayerSort = el.dataset.value;
  },
  awayGoal(el) {
    state.ui.away.goal = el.dataset.value;
  },
  // "Got it" on While you were away: hidden until the next time you're away.
  awayDismiss() {
    state.awaySummary = null;
  },
  combatStyle(el) {
    state.ui.combat.style = el.dataset.value;
    state.ui.combat.showAll = false;
  },
  combatSort(el) {
    state.ui.combat.sort = el.dataset.value;
  },
  combatTarget(el) {
    state.ui.combat.target = { ...state.ui.combat.target, [el.dataset.style]: el.dataset.enemy || null };
    // A fight shown for another style opens that style, on the Combat page when asked from elsewhere.
    state.ui.combat.style = el.dataset.style;
    if (el.dataset.go) location.hash = el.dataset.go;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  combatShowAll() {
    state.ui.combat.showAll = true;
  },
  combatRisky() {
    state.ui.combat.showRisky = !state.ui.combat.showRisky;
  },
  rareBand(el) {
    state.ui.rare.band = el.dataset.value;
    store.set('rare', state.ui.rare);
  },
  rareMissing() {
    state.ui.rare.missing = !state.ui.rare.missing;
    store.set('rare', state.ui.rare);
  },
  toggle(el) {
    const key = el.dataset.key;
    if (state.ui.expanded.has(key)) state.ui.expanded.delete(key);
    else state.ui.expanded.add(key);
  },
  sort(el) {
    state.ui.sort = el.dataset.value;
  },
  resetSkillLevel(el) {
    delete state.ui.skillOverride[el.dataset.skill];
  },
  levelSource(el) {
    state.levelSource = el.dataset.value;
    store.set('levelSource', state.levelSource);
  },
  copyLevels() {
    for (const [skill, s] of Object.entries(state.save?.skills ?? {})) state.manualLevels[skill] = s.level;
    store.set('manualLevels', state.manualLevels);
  },
  addGoal() {
    const skill = state.ui.goalSkill ?? gd.skills[0].id;
    const target = clampLevel(state.ui.goalTarget);
    state.goals = [...state.goals.filter((g) => !(g.skill === skill && g.target === target)), { id: Date.now().toString(36), skill, target }];
    store.set('goals', state.goals);
    syncServerAlerts();
  },
  removeGoal(el) {
    state.goals = state.goals.filter((g) => g.id !== el.dataset.id);
    store.set('goals', state.goals);
    syncServerAlerts();
  },
};

document.addEventListener('click', (e) => {
  const menu = document.getElementById('theme-menu');
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
  const el = e.target.closest('[data-action]');
  const action = el && ACTIONS[el.dataset.action];
  if (!action) return;
  e.preventDefault();
  action(el);
  render();
});

// Numeric fields ignore the empty in-between state while typing.
function onBind(e) {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  const v = el.value;
  const n = Number(v);
  const numeric = el.type === 'number';
  if (numeric && (v === '' || !Number.isFinite(n))) return;
  switch (el.dataset.bind) {
    case 'theme':
      setTheme(v);
      break;
    case 'saveId':
      state.saveId = v;
      store.set('saveId', v);
      loadSave().then(render);
      return;
    case 'skillLevel':
      state.ui.skillOverride[el.dataset.skill] = clampLevel(n);
      break;
    case 'manualLevel':
      state.manualLevels[el.dataset.skill] = clampLevel(n);
      store.set('manualLevels', state.manualLevels);
      break;
    case 'food':
      state.food = v;
      gd.preferredFood = v;
      store.set('food', v);
      break;
    case 'historySkill':
      state.ui.historySkill = v;
      break;
    case 'away.hours':
      state.ui.away.hours = n;
      store.set('awayHours', n);
      break;
    case 'away.skill':
      state.ui.away.skill = v;
      break;
    case 'combat.skill':
      state.ui.combat.skill = v;
      break;
    case 'alerts.minutes':
      state.alerts = { ...state.alerts, minutes: Math.min(Math.max(Math.round(n), 1), 600) };
      store.set('alerts', state.alerts);
      syncServerAlerts();
      return;
    case 'lookupQuery':
      state.ui.lookupQuery = v;
      break;
    case 'bankFilter':
      state.ui.bankFilter = v;
      break;
    case 'goalSkill':
      state.ui.goalSkill = v;
      return;
    case 'goalTarget':
      state.ui.goalTarget = n;
      return;
    case 'calc.skill':
      state.ui.calc = { skill: v, target: null, methodKey: 'best' };
      break;
    case 'calc.target':
      state.ui.calc.target = clampLevel(n);
      break;
    case 'calc.methodKey':
      state.ui.calc.methodKey = v;
      break;
    case 'offline.methodKey':
      state.ui.offline.methodKey = v;
      break;
    case 'offline.hours':
      state.ui.offline.hours = n;
      break;
    case 'drop.chance':
      state.ui.drop.chance = n;
      break;
    case 'drop.tries':
      state.ui.drop.tries = n;
      break;
    default:
      return;
  }
  render();
}
document.addEventListener('keydown', (e) => {
  const menu = document.getElementById('theme-menu');
  if (e.key === 'Escape' && menu?.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

document.addEventListener('input', onBind);
document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') return; // selects already handled on input
  onBind(e);
});

function connectLive() {
  const events = new EventSource('/api/events');
  events.onopen = async () => {
    const reconnected = state.live.lost;
    state.live.connected = true;
    state.live.lost = false;
    tick();
    // The companion was restarted: if its files changed, this page is out of date.
    if (reconnected) {
      await loadStatus();
      if (state.status?.build && state.loadedBuild && state.status.build !== state.loadedBuild) {
        state.updateReady = true;
        render();
      }
    }
  };
  events.onerror = () => {
    state.live.connected = false;
    state.live.lost = true;
    tick();
  };
  events.onmessage = async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type !== 'saves-changed') return;
    const before = state.save;
    await loadStatus();
    await loadSave();
    announceProgress(before, state.save);
    const planBefore = state.plan;
    await loadPlan();
    announcePlan(planBefore, state.plan);
    await loadHistory();
    await loadObservations();
    await loadFinds();
    state.live.pulse = state.save?.header.timestamp !== before?.header.timestamp;
    if (state.live.pulse) {
      alerted.sawSave = true;
      alerted.stale = false;
      checkAlerts(before, state.save);
    }
    render();
    state.live.pulse = false;
  };
}

// Icons are optional: without data/icons.json the UI falls back to coloured letter badges.
async function loadIcons() {
  let manifest = {};
  try {
    manifest = await fetchJson('/data/icons.json');
  } catch {
    // no bundled icons
  }
  configureIcons(manifest, gd.skills);
  if (manifest.logo) {
    const url = `/ui/${manifest.logo}`;
    const mark = document.getElementById('brand-mark');
    mark.classList.add('logo');
    mark.innerHTML = `<img src="${esc(url)}" alt="">`;
    document.getElementById('favicon').href = url;
  }
}

async function init() {
  applyTheme();
  try {
    gd = createGameData(await fetchJson('/data/companion-data.json'));
  } catch (e) {
    main.innerHTML = `<div class="card empty"><h2>Couldn't load the game data</h2><p>${esc(e.message)}</p><p>Run <code>npm run build-data</code> and restart the companion.</p></div>`;
    return;
  }
  await loadIcons();
  gd.preferredFood = state.food && gd.items[state.food] ? state.food : null;
  state.ui.calc.skill = gd.trainableSkills[0];
  state.ui.goalSkill = gd.skills.find((s) => gd.methodsBySkill[s.id])?.id ?? gd.skills[0].id;
  state.route = parseRoute();
  await loadStatus();
  state.loadedBuild = state.status?.build ?? null;
  await loadSave();
  await loadPlan();

  if (state.save) {
    const activity = currentActivity(gd, state.save.header, levelsAndXp().levels);
    if (activity?.method) {
      state.ui.offline.methodKey = activity.method.key;
      state.ui.lastSkill = activity.skill;
      state.ui.calc = { skill: activity.skill, target: Math.min((state.save.skills[activity.skill]?.level ?? 1) + 1, gd.levelCap), methodKey: 'best' };
    }
  }

  render();
  connectLive();
  window.addEventListener('hashchange', () => {
    state.route = parseRoute();
    render();
    window.scrollTo(0, 0);
    loadHistory().then(() => ['history', 'shop'].includes(state.route.tab) && render());
    loadObservations().then(() => state.route.tab === 'accuracy' && render());
    loadFinds().then((loaded) => loaded && render());
  });
  installChartTooltips();
  loadHistory().then(() => ['history', 'shop'].includes(state.route.tab) && render());
  loadObservations().then(() => state.route.tab === 'accuracy' && render());
  loadFinds().then((loaded) => loaded && render());
  loadServerAlerts().then(render);
  tick();
  setInterval(tick, 1000);
}

init();
