// What each action actually gave you: XP and item changes between consecutive autosaves of the same
// action, added up per action and kept in the companion's own folder (history/<save id>.actions.json),
// so the estimates can be checked against real play. Never writes near the game's files.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SAVE_EVERY_MS = 60_000;

export function createObservationStore(dir) {
  const byId = new Map(); // save id -> { actions, dirty, savedAt }
  const file = (id) => join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.actions.json`);

  async function load(id) {
    if (!byId.has(id)) {
      let actions = {};
      try {
        actions = JSON.parse(await readFile(file(id), 'utf8'));
      } catch {
        // nothing recorded yet
      }
      byId.set(id, { actions, dirty: false, savedAt: 0 });
    }
    return byId.get(id);
  }

  /**
   * Adds the gains between two saves of the same action.
   * @param xp { skill: gained } and items { item: change } over `seconds`
   * @param timed { seconds, xp, est }: the XP gained in the action's skill and what was predicted for
   *   the same stretch at the time, when the companion could predict it
   */
  async function add(id, activity, seconds, xp, items, timed = null) {
    const entry = await load(id);
    const a = (entry.actions[activity] ??= { seconds: 0, xp: {}, items: {}, firstSeen: Date.now(), lastSeen: 0 });
    a.seconds += seconds;
    a.lastSeen = Date.now();
    for (const [k, v] of Object.entries(xp)) if (v) a.xp[k] = (a.xp[k] ?? 0) + v;
    for (const [k, v] of Object.entries(items)) if (v) a.items[k] = (a.items[k] ?? 0) + v;
    if (timed) {
      a.timed ??= { seconds: 0, xp: 0, est: 0 };
      a.timed.seconds += timed.seconds;
      a.timed.xp += timed.xp;
      a.timed.est += timed.est;
    }
    entry.dirty = true;
    if (Date.now() - entry.savedAt > SAVE_EVERY_MS) await flush(id);
  }

  async function flush(id) {
    const entry = byId.get(id);
    if (!entry?.dirty) return;
    entry.dirty = false;
    entry.savedAt = Date.now();
    await mkdir(dir, { recursive: true });
    await writeFile(file(id), JSON.stringify(entry.actions));
  }

  // The record right now, read from disk the first time: for work that can't wait (making a plan).
  function peek(id) {
    if (!byId.has(id)) {
      let actions = {};
      try {
        actions = JSON.parse(readFileSync(file(id), 'utf8'));
      } catch {
        // nothing recorded yet
      }
      byId.set(id, { actions, dirty: false, savedAt: 0 });
    }
    return byId.get(id).actions;
  }

  return { add, flush, peek, get: async (id) => (await load(id)).actions };
}
