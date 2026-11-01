// Small single-series SVG charts: columns and lines. Marks carry the series colour, text stays in text
// colours, gridlines are hairlines. Hover and keyboard tooltips come from data-tip-* attributes,
// handled in app.js; every value is also in a table on the page.
import { esc } from '/ui/format.js';

const W = 640;
const PAD = { l: 52, r: 16, t: 20, b: 28 };

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// Three hairline gridlines with compact tick labels.
function grid(lo, hi, plotH, format) {
  return [0, 0.5, 1]
    .map((f) => {
      const y = PAD.t + plotH * (1 - f);
      return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/><text class="tick" x="${PAD.l - 8}" y="${y + 4}" text-anchor="end">${esc(format(lo + (hi - lo) * f))}</text>`;
    })
    .join('');
}

// A bar with a 4px rounded top and a square foot on the baseline.
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/**
 * @param points [{ label, value, tip }] — label is the x tick, tip names the bar in its tooltip
 */
export function columnChart(points, { title, format = String, height = 210 }) {
  const plotW = W - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const band = plotW / Math.max(points.length, 1);
  const barW = Math.max(2, Math.min(24, band - 2));
  const every = Math.ceil(points.length / 8);
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? 0) ? i : best), -1);
  const cols = points.map((p, i) => {
    const bandX = PAD.l + band * i;
    const h = (plotH * p.value) / max;
    const x = bandX + (band - barW) / 2;
    const y = PAD.t + plotH - h;
    const bar = h > 0.5 ? `<path class="bar" d="${barPath(x, y, barW, h)}"/>` : '';
    const peakLabel = i === peak && p.value > 0 ? `<text class="value" x="${x + barW / 2}" y="${y - 6}" text-anchor="middle">${esc(format(p.value))}</text>` : '';
    const tick = i % every === 0 ? `<text class="tick" x="${bandX + band / 2}" y="${height - 8}" text-anchor="middle">${esc(p.label)}</text>` : '';
    return `<g class="col">${bar}${peakLabel}${tick}<rect class="hit" x="${bandX}" y="${PAD.t}" width="${band}" height="${plotH}" tabindex="0" data-tip-value="${esc(format(p.value))}" data-tip-label="${esc(p.tip)}" aria-label="${esc(`${p.tip}: ${format(p.value)}`)}"/></g>`;
  });
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${height}" role="group" aria-label="${esc(title)}">${grid(0, max, plotH, format)}${cols.join('')}<line class="baseline" x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + plotH}" y2="${PAD.t + plotH}"/></svg></figure>`;
}

/**
 * @param points [{ t, v }] oldest first
 * @param timeLabel (t) => string for ticks and tooltips
 */
export function lineChart(points, { title, format = String, timeLabel, height = 190 }) {
  if (points.length < 2) return '<p class="muted small">Not enough history in this range yet.</p>';
  // At most ~300 points: a line can't show more than the chart is wide.
  const step = Math.ceil(points.length / 300);
  const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const plotW = W - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const t0 = pts[0].t;
  const t1 = pts.at(-1).t;
  const x = (t) => PAD.l + (plotW * (t - t0)) / (t1 - t0 || 1);
  const y = (v) => PAD.t + plotH * (1 - (v - lo) / (hi - lo || 1));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const base = PAD.t + plotH;
  const area = `${line}L${x(t1).toFixed(1)},${base}L${x(t0).toFixed(1)},${base}Z`;
  const end = pts.at(-1);
  const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text class="tick" x="${x(t)}" y="${height - 8}" text-anchor="${['start', 'middle', 'end'][i]}">${esc(timeLabel(t))}</text>`).join('');
  const data = esc(JSON.stringify({ xs: pts.map((p) => +x(p.t).toFixed(1)), ys: pts.map((p) => +y(p.v).toFixed(1)), values: pts.map((p) => format(p.v)), labels: pts.map((p) => timeLabel(p.t)) }));
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${height}" role="group" aria-label="${esc(title)}">
    ${grid(lo, hi, plotH, format)}
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    <line class="crosshair" x1="0" x2="0" y1="${PAD.t}" y2="${base}" visibility="hidden"/>
    <circle class="dot hover-dot" r="4" cx="0" cy="0" visibility="hidden"/>
    <circle class="dot" r="4" cx="${x(end.t)}" cy="${y(end.v)}"/>
    <text class="value" x="${x(end.t) - 8}" y="${y(end.v) - 10}" text-anchor="end">${esc(format(end.v))}</text>
    ${ticks}
    <rect class="line-hit" x="${PAD.l}" y="${PAD.t}" width="${plotW}" height="${plotH}" data-line="${data}"/>
  </svg></figure>`;
}

// The page's chart tooltip: one element, filled with textContent, placed by the hovered mark.
export function installChartTooltips(doc = document) {
  const tip = doc.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  doc.body.append(tip);
  const show = (value, label, x, y) => {
    const v = doc.createElement('strong');
    v.textContent = value;
    const l = doc.createElement('span');
    l.textContent = label;
    tip.replaceChildren(v, l);
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(8, x - w / 2), innerWidth - w - 8)}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
  };
  const hide = () => (tip.hidden = true);
  // The tooltip is placed for where the mark was; scrolling moves the mark away from it.
  addEventListener('scroll', hide, { passive: true });
  const markTip = (e) => {
    const el = e.target.closest?.('[data-tip-value]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el.dataset.tipValue, el.dataset.tipLabel, r.left + r.width / 2, r.top + 12);
  };
  doc.addEventListener('pointerover', markTip);
  doc.addEventListener('focusin', markTip);
  doc.addEventListener('pointerout', (e) => e.target.closest?.('[data-tip-value], .line-hit') && hide());
  doc.addEventListener('focusout', (e) => e.target.closest?.('[data-tip-value]') && hide());

  const cache = new WeakMap();
  doc.addEventListener('pointermove', (e) => {
    const hit = e.target.closest?.('.line-hit');
    if (!hit) return;
    if (!cache.has(hit)) cache.set(hit, JSON.parse(hit.dataset.line));
    const d = cache.get(hit);
    const svg = hit.ownerSVGElement;
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    let i = 0;
    for (let k = 1; k < d.xs.length; k++) if (Math.abs(d.xs[k] - vx) < Math.abs(d.xs[i] - vx)) i = k;
    const cross = svg.querySelector('.crosshair');
    const dot = svg.querySelector('.hover-dot');
    cross.setAttribute('x1', d.xs[i]);
    cross.setAttribute('x2', d.xs[i]);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', d.xs[i]);
    dot.setAttribute('cy', d.ys[i]);
    dot.setAttribute('visibility', 'visible');
    const scale = box.width / svg.viewBox.baseVal.width;
    show(d.values[i], d.labels[i], box.left + d.xs[i] * scale, box.top + d.ys[i] * scale);
  });
  doc.addEventListener('pointerout', (e) => {
    const hit = e.target.closest?.('.line-hit');
    if (!hit) return;
    hit.ownerSVGElement.querySelector('.crosshair')?.setAttribute('visibility', 'hidden');
    hit.ownerSVGElement.querySelector('.hover-dot')?.setAttribute('visibility', 'hidden');
  });
}
