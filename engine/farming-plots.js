// Farming plots from the save: what each plot is growing and when it's ready. Isomorphic.
//
// The save holds each plot's timer as ticks left at the moment it was written (save-reader.js), so the
// time left counts down from the save's own timestamp and stays right between autosaves. Plots keep
// growing while the game is closed: it catches up when it's opened again.

const humanize = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();

// Plot ids are the game's names without spaces ("Allotment3", "MillFarm1"); the save has no category,
// so it comes from the data when the data has it, else from the Farming category the id starts with.
function plotInfo(gd, id) {
  const known = gd.raw?.farmingPlots?.[id];
  const [, prefix = id, n = ''] = /^(.*?)(\d*)$/.exec(id);
  const base = humanize(prefix);
  const categories = [...new Set((gd.methodsBySkill?.Farming ?? []).map((m) => m.category).filter(Boolean))];
  const category = known?.category ?? categories.find((c) => c.toLowerCase().startsWith(base.toLowerCase())) ?? base;
  return { name: known?.name ?? `${base}${n ? ` ${n}` : ''}`, category, prefix: base, number: n ? Number(n) : null };
}

/**
 * Every plot with its state, and what's ready or next.
 * status: 'locked' | 'empty' | 'growing' | 'ready' | 'harvesting' (an auto-harvest plot whose time has
 * passed: it harvests itself) | 'bonus' (a flower giving its bonus).
 */
export function farmingPlots(gd, save, now = Date.now()) {
  const f = save?.farming;
  if (!f?.plots) return null;
  const savedAt = save.header?.timestamp ?? now;
  const plots = f.plots.map((p) => {
    const info = plotInfo(gd, p.id);
    const method = p.recipe ? gd.methodByKey?.get(`Farming/${p.recipe}`) ?? null : null;
    const paused = p.timer?.state === 'paused';
    const readyAt = p.timer?.msLeft != null && !paused ? savedAt + p.timer.msLeft : null;
    const msLeft = paused ? p.timer.msLeft : readyAt != null ? Math.max(0, readyAt - now) : null;
    let status = p.state;
    if (p.state === 'grown') status = 'ready';
    else if (p.state === 'growing' || p.state === 'regrowing') status = readyAt != null && now >= readyAt ? (p.auto?.harvest ? 'harvesting' : 'ready') : 'growing';
    return { ...p, ...info, method, readyAt, msLeft, paused, status };
  });
  const groups = [];
  for (const p of plots) {
    let g = groups.find((x) => x.category === p.category);
    if (!g) groups.push((g = { category: p.category, plots: [] }));
    g.plots.push(p);
  }
  const growing = plots.filter((p) => p.status === 'growing' && p.readyAt != null).sort((a, b) => a.readyAt - b.readyAt);
  return {
    plots,
    groups,
    ready: plots.filter((p) => p.status === 'ready'),
    next: growing[0] ?? null,
    planted: plots.filter((p) => !['locked', 'empty'].includes(p.state)).length,
  };
}

// "Allotment 4-10, Herb 2": plot names with runs of numbers joined up.
export function plotRanges(plots) {
  const out = [];
  for (const p of plots) {
    const last = out.at(-1);
    if (last && p.number != null && last.prefix === p.prefix && last.to === p.number - 1) last.to = p.number;
    else out.push({ prefix: p.prefix, from: p.number, to: p.number, name: p.name });
  }
  return out.map((r) => (r.from == null ? r.name : r.from === r.to ? `${r.prefix} ${r.from}` : `${r.prefix} ${r.from}-${r.to}`)).join(', ');
}
