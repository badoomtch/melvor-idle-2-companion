// Rare finds: a rare item whose found count (the save's BankItemFound statistic) went up between two
// autosaves the companion saw. Logged per save in the companion's own folder (history/<save id>.finds.json,
// never near the game's files) and announced through the alerts (alerts.js). The Rare items page and the
// Overview's "While you were away" show the log.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rareOdds } from '../engine/rare-items.js';
import { activityKey } from '../engine/supplies.js';

export const FIND_LIMIT = 200;

// The save counts finds by local item id ("ChefsHat"); the game data uses full ids ("MelvorBase:ChefsHat").
const fullIds = new WeakMap();
function fullId(gd, local) {
  if (!fullIds.has(gd)) fullIds.set(gd, new Map(Object.keys(gd.items).map((id) => [id.split(':').pop(), id])));
  return fullIds.get(gd).get(local);
}

// Uncommon items (1 in 20 to 100) turn up every few minutes while you do what gives them, so only Rare
// and rarer count as finds.
export const isFind = (odds) => !!odds && odds.rarity.id !== 'uncommon';

/**
 * The rare finds between two parses of the same save. Nothing for the first parse the companion sees
 * (`before` null), for a different character, or when either parse lacks the statistic.
 * @returns [{ item, at, count, activity }]: count is how many turned up, at the new save's time
 */
export function rareFinds(gd, before, after) {
  const was = before?.itemsFound;
  const now = after?.itemsFound;
  if (!was || !now || before.header.uuid !== after.header.uuid || !(after.header.timestamp > before.header.timestamp)) return [];
  const out = [];
  for (const [local, total] of Object.entries(now)) {
    const count = total - (was[local] ?? 0);
    const item = count > 0 ? fullId(gd, local) : null;
    if (item && isFind(rareOdds(gd, item))) out.push({ item, at: after.header.timestamp, count, activity: activityKey(after.header) });
  }
  return out;
}

export function createFindLog({ gd, dir }) {
  const byId = new Map(); // save id -> finds, oldest first
  const queues = new Map(); // save id -> pending write, so writes happen one at a time
  const file = (id) => join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.finds.json`);

  async function load(id) {
    if (!byId.has(id)) {
      let finds = [];
      try {
        const stored = JSON.parse(await readFile(file(id), 'utf8'));
        if (Array.isArray(stored)) finds = stored;
      } catch {
        // nothing logged yet
      }
      if (!byId.has(id)) byId.set(id, finds);
    }
    return byId.get(id);
  }

  // Adds finds and keeps the latest FIND_LIMIT.
  function add(id, finds) {
    if (!finds.length) return Promise.resolve();
    const run = async () => {
      byId.set(id, [...(await load(id)), ...finds].slice(-FIND_LIMIT));
      await mkdir(dir, { recursive: true });
      await writeFile(file(id), JSON.stringify(byId.get(id)));
    };
    const next = (queues.get(id) ?? Promise.resolve()).then(run, run);
    queues.set(id, next.catch(() => {}));
    return next;
  }

  /** A new parse of a save: log what it found since the previous one, and return it. */
  function onSave(id, before, save) {
    const finds = rareFinds(gd, before, save);
    add(id, finds).catch((e) => console.error(`Could not log rare finds: ${e.message}`));
    return finds;
  }

  return { onSave, add, get: async (id) => [...(await load(id))] };
}
