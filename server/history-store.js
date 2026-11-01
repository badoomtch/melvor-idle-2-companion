// Long-term history: one compact point per save every few minutes, kept in the companion's own folder
// (history/<save id>.jsonl). It only ever writes there, never near the game's files.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const POINT_EVERY_MS = 5 * 60_000;

export function createHistoryStore(dir) {
  const lastWritten = new Map(); // save id -> time of the newest stored point
  const queues = new Map(); // save id -> pending write, so points are appended one at a time
  const file = (id) => join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);

  async function read(id) {
    let text;
    try {
      text = await readFile(file(id), 'utf8');
    } catch {
      return [];
    }
    const points = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        points.push(JSON.parse(line));
      } catch {
        // a line cut short by a crash; skip it
      }
    }
    return points;
  }

  // Stores the point if the last stored one is old enough.
  function record(id, point) {
    const run = async () => {
      if (!lastWritten.has(id)) lastWritten.set(id, (await read(id)).at(-1)?.t ?? -Infinity);
      if (point.t - lastWritten.get(id) < POINT_EVERY_MS) return;
      lastWritten.set(id, point.t);
      await mkdir(dir, { recursive: true });
      await appendFile(file(id), `${JSON.stringify(point)}\n`);
    };
    const next = (queues.get(id) ?? Promise.resolve()).then(run, run);
    queues.set(id, next.catch(() => {}));
    return next;
  }

  return { read, record };
}
