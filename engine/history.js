// Long-term progress from stored history points. Isomorphic.
//   point = { t, gp, slayerCoins, totalLevel, bank, xp: { skill: xp } }

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Gaps longer than this between points are time away, not play.
export const PLAY_GAP_MS = 10 * 60_000;

export const xpOf = (point, skill = null) => (skill ? point.xp?.[skill] ?? 0 : Object.values(point.xp ?? {}).reduce((s, v) => s + v, 0));

// Local midnight / start of the hour, so days match the player's clock.
export function bucketStart(t, size) {
  const d = new Date(t);
  if (size === 'hour') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const nextBucket = (start, size) => {
  const d = new Date(start);
  if (size === 'hour') d.setHours(d.getHours() + 1);
  else d.setDate(d.getDate() + 1);
  return d.getTime();
};

/**
 * Gains per hour or per day between `from` and `to`: each bucket's XP gained (all skills or one),
 * levels gained, and gold and bank value at the end of it.
 */
export function buckets(points, { size = 'day', from, to = Date.now(), skill = null }) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out = [];
  let i = 0;
  let before = null; // the last point before the current bucket
  while (i < sorted.length && sorted[i].t < from) before = sorted[i++];
  for (let start = bucketStart(from, size); start < to; start = nextBucket(start, size)) {
    const end = nextBucket(start, size);
    let last = null;
    while (i < sorted.length && sorted[i].t < end) last = sorted[i++];
    const base = before ?? (last ? sorted.find((p) => p.t >= start) : null);
    out.push({
      start,
      end,
      xp: last && base ? Math.max(0, xpOf(last, skill) - xpOf(base, skill)) : 0,
      levels: last && base ? Math.max(0, (last.totalLevel ?? 0) - (base.totalLevel ?? 0)) : 0,
      gp: (last ?? before)?.gp ?? null,
      bank: (last ?? before)?.bank ?? null,
    });
    if (last) before = last;
  }
  return out;
}

// Totals for a period: XP and levels gained, gold and bank change, and time played.
export function summary(points, { from, to = Date.now(), skill = null }) {
  const inRange = points.filter((p) => p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  const base = [...points].filter((p) => p.t < from).sort((a, b) => a.t - b.t).at(-1) ?? inRange[0];
  const last = inRange.at(-1);
  if (!base || !last) return null;
  let played = 0;
  const seq = base === inRange[0] ? inRange : [base, ...inRange];
  for (let k = 1; k < seq.length; k++) {
    const gap = seq[k].t - seq[k - 1].t;
    if (gap <= PLAY_GAP_MS) played += gap;
  }
  return {
    xp: xpOf(last, skill) - xpOf(base, skill),
    levels: (last.totalLevel ?? 0) - (base.totalLevel ?? 0),
    gp: (last.gp ?? 0) - (base.gp ?? 0),
    bank: (last.bank ?? 0) - (base.bank ?? 0),
    hoursPlayed: played / HOUR_MS,
    first: base,
    last,
  };
}

// XP gained per skill over a period, biggest first.
export function skillGains(points, { from, to = Date.now() }) {
  const inRange = points.filter((p) => p.t <= to).sort((a, b) => a.t - b.t);
  const base = inRange.filter((p) => p.t < from).at(-1) ?? inRange.find((p) => p.t >= from);
  const last = inRange.at(-1);
  if (!base || !last) return [];
  return Object.keys(last.xp ?? {})
    .map((skill) => ({ skill, xp: (last.xp[skill] ?? 0) - (base.xp?.[skill] ?? 0) }))
    .filter((x) => x.xp > 0)
    .sort((a, b) => b.xp - a.xp);
}

export const RANGES = {
  day: { label: 'Last 24 hours', ms: DAY_MS, size: 'hour' },
  week: { label: 'Last 7 days', ms: 7 * DAY_MS, size: 'day' },
  month: { label: 'Last 30 days', ms: 30 * DAY_MS, size: 'day' },
};
