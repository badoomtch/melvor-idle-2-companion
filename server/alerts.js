// Alerts the companion sends as desktop notifications while it runs, page open or not: level-ups,
// goals reached, supplies running out, and progress stopping (plan steps done: see route-watcher.js). Off until you switch them on in
// Settings; the page then leaves desktop notifications to this, so nothing arrives twice.
// The settings live in the companion's own folder (alerts.json next to the history).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { playerBonuses, playerState } from '../engine/gamedata.js';
import { activityKey, currentSupplies, totalXp } from '../engine/supplies.js';

export const DEFAULT_ALERT_SETTINGS = { enabled: false, levelUps: true, runningOut: true, minutes: 15, stopped: true, planSteps: true, useBonuses: true, checkUpdates: true, goals: [] };

// Only the known fields, with sane types, so a bad request can't store junk.
export function cleanSettings(input = {}) {
  const s = { ...DEFAULT_ALERT_SETTINGS };
  for (const key of ['enabled', 'levelUps', 'runningOut', 'stopped', 'planSteps', 'useBonuses', 'checkUpdates']) if (typeof input[key] === 'boolean') s[key] = input[key];
  if (Number.isFinite(input.minutes)) s.minutes = Math.min(Math.max(Math.round(input.minutes), 1), 600);
  if (Array.isArray(input.goals)) {
    s.goals = input.goals
      .filter((g) => g && typeof g.skill === 'string' && Number.isFinite(g.target))
      .slice(0, 100)
      .map((g) => ({ skill: g.skill.slice(0, 64), target: Math.round(g.target) }));
  }
  return s;
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
    if (!seen.has(id)) seen.set(id, { low: new Set(), stuck: null, lastSave: 0, stale: false });
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

  // A new parse of a save. `before` is the previous parse of the same save (or null).
  // `save` includes the server's history and measured flows.
  function onSave(id, before, save) {
    const m = memo(id);
    // Only a save written just now means the game is running (not one found when the companion starts).
    if (now() - save.header.timestamp < 60_000) {
      m.lastSave = save.header.timestamp;
      m.stale = false;
    }
    if (!settings.enabled || !before) return [];
    const events = [];
    const levels = Object.fromEntries(Object.entries(save.skills).map(([k, s]) => [k, s.level]));
    if (settings.levelUps) {
      for (const s of gd.skills) {
        const was = before.skills[s.id]?.level;
        const nowLevel = save.skills[s.id]?.level;
        if (!was || !nowLevel || nowLevel <= was) continue;
        events.push({ title: `${s.name} level ${nowLevel}!`, body: nowLevel - was > 1 ? `Up ${nowLevel - was} levels.` : '' });
        for (const g of settings.goals) if (g.skill === s.id && was < g.target && nowLevel >= g.target) events.push({ title: `Goal reached: ${s.name} ${g.target}`, body: `${s.name} is level ${nowLevel} now.` });
      }
    }
    if (settings.runningOut) {
      gd.player = playerState(save, gd);
      gd.playerBonuses = settings.useBonuses ? playerBonuses(gd, save) : null;
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
      // Same action for 90 seconds of autosaves without any XP: stuck (bank full, out of materials, ...).
      const recent = (save.history ?? []).slice(-10);
      const flat = recent.length >= 10 && recent.at(-1).t - recent[0].t >= 85_000 && totalXp(recent[0]) === totalXp(recent.at(-1));
      if (nowActivity && flat && m.stuck !== nowActivity) {
        m.stuck = nowActivity;
        events.push({ title: 'No XP for 90 seconds', body: `${nowActivity} isn't gaining anything. Is it stuck?` });
      } else if (!flat) {
        m.stuck = null;
      }
    }
    send(events);
    return events;
  }

  // Called every few seconds: the game was saving, then went quiet for two minutes.
  function tick() {
    if (!settings.enabled || !settings.stopped) return [];
    const events = [];
    for (const m of seen.values()) {
      if (m.lastSave && !m.stale && now() - m.lastSave > 120_000) {
        m.stale = true;
        events.push({ title: 'The game stopped saving', body: 'It may have been closed, paused or frozen.' });
      }
    }
    send(events.slice(0, 1));
    return events;
  }

  return { onSave, tick, setSettings, get settings() { return settings; } };
}
