import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bucketStart, buckets, skillGains, summary } from '../engine/history.js';
import { createHistoryStore, POINT_EVERY_MS } from '../server/history-store.js';

const day0 = new Date(2026, 9, 20).getTime(); // local midnight
const H = 3_600_000;
const point = (t, mining, fishing, extra = {}) => ({ t, gp: 1000 + mining, bank: 5000, totalLevel: 100 + Math.floor(mining / 1000), xp: { Mining: mining, Fishing: fishing }, ...extra });

const points = [
  point(day0 + 10 * H, 0, 0),
  point(day0 + 11 * H, 500, 100),
  point(day0 + 12 * H, 1500, 100),
  point(day0 + 24 * H + 9 * H, 1500, 400), // next day
  point(day0 + 24 * H + 9 * H + 5 * 60_000, 2000, 400),
];

test('buckets XP by local day, from the last point before each day', () => {
  const b = buckets(points, { size: 'day', from: day0, to: day0 + 2 * 24 * H });
  assert.equal(b.length, 2);
  assert.equal(b[0].xp, 1600);
  assert.equal(b[1].xp, 800);
  assert.equal(b[0].levels, 1);
  assert.equal(b[1].levels, 1);
  assert.equal(b[1].gp, 3000);
  assert.equal(buckets(points, { size: 'day', from: day0, to: day0 + 2 * 24 * H, skill: 'Fishing' })[1].xp, 300);
});

test('hour buckets start on the hour', () => {
  assert.equal(bucketStart(day0 + 10 * H + 1234, 'hour'), day0 + 10 * H);
  // A gain counts in the bucket of the point that recorded it (points are 5 minutes apart in practice).
  const b = buckets(points, { size: 'hour', from: day0 + 10 * H, to: day0 + 13 * H });
  assert.deepEqual(b.map((x) => x.xp), [0, 600, 1000]);
});

test('summary counts only short gaps as time played', () => {
  const s = summary(points, { from: day0, to: day0 + 3 * 24 * H });
  assert.equal(s.xp, 2400);
  assert.equal(s.gp, 2000);
  assert.ok(Math.abs(s.hoursPlayed - 5 / 60) < 1e-9, 'only the 5-minute gap is play');
  assert.deepEqual(skillGains(points, { from: day0, to: day0 + 3 * 24 * H }), [{ skill: 'Mining', xp: 2000 }, { skill: 'Fishing', xp: 400 }]);
});

test('the history store appends at most one point every few minutes, in its own folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-history-'));
  try {
    const store = createHistoryStore(dir);
    await store.record('a/b:c', point(0, 1, 1));
    await store.record('a/b:c', point(60_000, 2, 2));
    await store.record('a/b:c', point(POINT_EVERY_MS + 1, 3, 3));
    const lines = readFileSync(join(dir, 'a_b_c.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'the id is made safe for a file name and close points are skipped');
    assert.deepEqual((await store.read('a/b:c')).map((p) => p.xp.Mining), [1, 3]);
    assert.deepEqual(await createHistoryStore(dir).read('missing'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
