// Alerts the companion sends as desktop notifications while it runs, page open or not: level-ups,
// goals reached, supplies running out, progress stopping (plan steps done: see route-watcher.js), farming plots
// ready to harvest, ranch animals hungry, sick or about to die of age, and rare finds (rare-finds.js).
// Off until you switch them on in Settings; the page then leaves desktop notifications to this, so
// nothing arrives twice.
// The settings live in the companion's own folder (alerts.json next to the history).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { farmingPlots } from '../engine/farming-plots.js';
import { playerBonuses, playerState } from '../engine/gamedata.js';
import { ranchModel } from '../engine/ranch.js';
import { rareOdds } from '../engine/rare-items.js';
import { stuckFor, stuckText } from '../engine/stuck.js';
import { activityKey, currentSupplies } from '../engine/supplies.js';

export const DEFAULT_ALERT_SETTINGS = { enabled: false, levelUps: true, runningOut: true, minutes: 15, stopped: true, planSteps: true, harvests: true, ranch: true, rareFinds: true, useBonuses: true, checkUpdates: true, goals: [] };

// Only the known fields, with sane types, so a bad request can't store junk.
export function cleanSettings(input = {}) {
  const s = { ...DEFAULT_ALERT_SETTINGS };
  for (const key of ['enabled', 'levelUps', 'runningOut', 'stopped', 'planSteps', 'harvests', 'ranch', 'rareFinds', 'useBonuses', 'checkUpdates']) if (typeof input[key] === 'boolean') s[key] = input[key];
  if (Number.isFinite(input.minutes)) s.minutes = Math.min(Math.max(Math.round(input.minutes), 1), 600);
  if (Array.isArray(input.goals)) {
    s.goals = input.goals
      .filter((g) => g && typeof g.skill === 'string' && Number.isFinite(g.target))
      .slice(0, 100)
      .map((g) => ({ skill: g.skill.slice(0, 64), target: Math.round(g.target) }));
  }
  return s;
}

const HOUR_MS = 3_600_000;

// Plots that need you when they're ready: not the ones set to harvest themselves.
const harvestPlots = (gd, save, at) => (farmingPlots(gd, save, at)?.plots ?? [])
  .filter((p) => !p.auto?.harvest && (p.state === 'grown' || ((p.state === 'growing' || p.state === 'regrowing') && p.readyAt != null)))
  .map((p) => ({ id: p.id, name: p.name, crop: p.method?.name ?? p.recipe, grown: p.state === 'grown', readyAt: p.readyAt }));

// Ranch problems worth a notification, one per enclosure and kind: hungry, sick, or an animal that dies
// of age within the hour with nothing set to replace it.
function ranchProblems(gd, save, at) {
  const ranch = ranchModel(gd, save, { now: at, bonuses: [] });
  const out = [];
  for (const e of ranch?.enclosures ?? []) {
    for (const a of e.attention) {
      if (a.kind === 'hungry') out.push({ key: `hungry:${e.land}`, title: a.count === 1 ? 'An animal is hungry' : 'Animals are hungry', body: a.text });
      if (a.kind === 'sick') out.push({ key: `sick:${e.land}`, title: a.count === 1 ? 'An animal is sick' : 'Animals are sick', body: a.text });
    }
    const dying = e.animals.filter((a) => a.deathAt - at <= HOUR_MS && !e.autoBuy.includes(a.species));
    if (dying.length) out.push({ key: `old:${e.land}`, title: 'Dying of old age within the hour', body: `${e.landName} (${e.name}): ${[...new Set(dying.map((a) => a.name))].join(', ')}. Auto-buy is off, so nothing will replace ${dying.length === 1 ? 'it' : 'them'}.` });
  }
  return out;
}

// A rare find (rare-finds.js), with the item's best odds: "Rare find: Chef's Hat", "1 in 867 per action,
// from Chef (Thieving)".
function findEvent(gd, find) {
  const odds = rareOdds(gd, find.item);
  const s = odds?.source;
  const title = `Rare find: ${gd.itemName(find.item)}${find.count > 1 ? ` (${find.count.toLocaleString()})` : ''}`;
  if (!s) return { title, body: '' };
  const from = s.type === 'method' ? `${s.method.name} (${gd.skillName(s.method.skill)})` : s.type === 'enemy' ? s.enemy.name : gd.itemName(s.from);
  const per = s.type === 'method' ? 'per action' : s.type === 'enemy' ? 'per kill' : 'per chest';
  return { title, body: `1 in ${Math.max(1, Math.round(1 / odds.p)).toLocaleString()} ${per}, from ${from}` };
}

export function createAlertWatcher({ gd, dir, notify, now = () => Date.now() }) {
  const file = join(dir, 'alerts.json');
  let settings = { ...DEFAULT_ALERT_SETTINGS };
  try {
    if (existsSync(file)) settings = cleanSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // unreadable settings: start from the defaults
  }
  // Per save: what's already been announced, so each warning fires once until it clears.
  const seen = new Map();
  const memo = (id) => {
    if (!seen.has(id)) seen.set(id, { low: new Set(), stuck: null, lastSave: 0, stale: false, plots: [], harvested: new Set(), ranch: new Set() });
    return seen.get(id);
  };

  function setSettings(input) {
    settings = cleanSettings(input);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2));
    return settings;
  }

  // One notification per autosave at most: several events are combined.
  function send(events) {
    if (!events.length) return;
    if (events.length === 1) notify(events[0].title, events[0].body);
    else notify(`${events.length} updates from Melvor`, events.map((e) => e.title).join(' · '));
  }

  // Plots that have become ready since they were last announced: once per harvest. A plot is announced
  // again only after it stops being ready (harvested, replanted or regrowing).
  function harvestEvents(m, quiet = false) {
    const t = now();
    const ready = m.plots.filter((p) => p.grown || t >= p.readyAt);
    const fresh = ready.filter((p) => !m.harvested.has(p.id));
    m.harvested = new Set(ready.map((p) => p.id));
    if (quiet || !fresh.length) return [];
    if (fresh.length === 1) return [{ title: `${fresh[0].crop} is ready to harvest`, body: fresh[0].name }];
    return [{ title: `${fresh.length} plots are ready to harvest`, body: [...new Set(fresh.map((p) => p.crop))].join(', ') }];
  }

  // A new parse of a save. `before` is the previous parse of the same save (or null).
  // `save` includes the server's history and measured flows, and the rare finds since `before`.
  function onSave(id, before, save) {
    const m = memo(id);
    // Only a save written just now means the game is running (not one found when the companion starts).
    if (now() - save.header.timestamp < 60_000) {
      m.lastSave = save.header.timestamp;
      m.stale = false;
    }
    // What's already ready when the companion starts (or while these alerts are off) isn't news.
    m.plots = harvestPlots(gd, save, now());
    const quiet = !settings.enabled || !before;
    const harvests = harvestEvents(m, quiet || !settings.harvests);
    const problems = settings.ranch ? ranchProblems(gd, save, now()) : [];
    const newProblems = problems.filter((p) => !m.ranch.has(p.key));
    m.ranch = new Set(problems.map((p) => p.key));
    if (quiet) return [];
    const events = [...(settings.rareFinds ? (save.finds ?? []).map((f) => findEvent(gd, f)) : []), ...harvests, ...newProblems.map(({ title, body }) => ({ title, body }))];
    const levels = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.level]));
    if (settings.levelUps) {
      for (const s of gd.skills) {
        const was = before.skills[s.id]?.level;
        const nowLevel = save.skills[s.id]?.level;
        if (!was || !nowLevel || nowLevel <= was) continue;
        events.push({ title: `${s.name} level ${nowLevel}`, body: nowLevel - was > 1 ? `Up ${nowLevel - was} levels.` : '' });
        for (const g of settings.goals) if (g.skill === s.id && was < g.target && nowLevel >= g.target) events.push({ title: `Goal reached: ${s.name} ${g.target}`, body: `${s.name} is level ${nowLevel} now.` });
      }
    }
    // Your bank, bonuses and journal: what you use up, and how long a hunting catch takes.
    if (settings.runningOut || settings.stopped) {
      gd.player = playerState(save, gd);
      gd.playerBonuses = settings.useBonuses ? playerBonuses(gd, save) : null;
    }
    if (settings.runningOut) {
      for (const s of currentSupplies(gd, save, levels, gd.player.owned)) {
        const minutes = s.hoursLeft * 60;
        if (minutes <= settings.minutes && !m.low.has(s.item)) {
          m.low.add(s.item);
          const name = gd.itemName(s.item);
          events.push(s.qty > 0 ? { title: `Running low: ${name}`, body: `About ${Math.max(1, Math.round(minutes))} min left (${s.qty} left).` } : { title: `Out of ${name}`, body: 'The game will stop what it was doing.' });
        } else if (minutes > settings.minutes * 1.5) {
          m.low.delete(s.item);
        }
      }
    }
    if (settings.stopped) {
      const was = activityKey(before.header);
      const nowActivity = activityKey(save.header);
      if (was && !nowActivity) events.push({ title: 'Nothing is training', body: `${was} stopped.` });
      // The same action without any XP for longer than it normally ever goes: stuck (bank full, out of materials, ...).
      const stuck = stuckFor(gd, save, levels);
      if (stuck && m.stuck !== nowActivity) {
        m.stuck = nowActivity;
        events.push(stuckText(stuck));
      } else if (!stuck) {
        m.stuck = null;
      }
    }
    send(events);
    return events;
  }

  // Called every few seconds: the game was saving, then went quiet for two minutes. Plots that become
  // ready between autosaves, or while the game is closed (they keep growing), are announced from here.
  function tick() {
    if (!settings.enabled) return [];
    const events = [];
    if (settings.stopped) {
      for (const m of seen.values()) {
        if (m.lastSave && !m.stale && now() - m.lastSave > 120_000) {
          m.stale = true;
          events.push({ title: 'The game stopped saving', body: 'It may have been closed, paused or frozen.' });
        }
      }
    }
    const harvests = settings.harvests ? [...seen.values()].flatMap((m) => harvestEvents(m)) : [];
    send([...events.slice(0, 1), ...harvests]);
    return [...events, ...harvests];
  }

  return { onSave, tick, setSettings, get settings() { return settings; } };
}
