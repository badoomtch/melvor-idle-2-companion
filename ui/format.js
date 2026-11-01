// Formatting and HTML helpers for the companion UI.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function num(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e9) return `${nf2.format(n / 1e9)}B`;
  if (a >= 1e6) return `${nf2.format(n / 1e6)}M`;
  if (a >= 1e4) return `${nf1.format(n / 1e3)}k`;
  if (a >= 100 || Number.isInteger(n)) return nf0.format(n);
  if (a >= 1) return nf1.format(n);
  return nf2.format(n);
}

export const exact = (n) => (n == null || !Number.isFinite(n) ? num(n) : nf0.format(n));

export function gp(n, { signed = false } = {}) {
  if (n == null || Number.isNaN(n)) return '–';
  const s = num(n);
  return signed && n > 0 ? `+${s}` : s;
}

export const pct = (p, digits = 0) => (p == null ? '–' : `${(p * 100).toFixed(digits)}%`);

export function duration(hours) {
  if (hours == null || Number.isNaN(hours)) return '–';
  if (!Number.isFinite(hours)) return 'never';
  const mins = hours * 60;
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${Math.round(mins)} min`;
  if (hours < 48) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${nf1.format(hours / 24)} days`;
}

export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Stable hue per skill for its badge.
export function skillHue(skill) {
  let h = 0;
  for (const c of String(skill)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// Bundled game icons (data/icons.json maps res:// paths to files under /ui/).
let iconManifest = {};
let skillIconPaths = {};
export function configureIcons(manifest, skills) {
  iconManifest = manifest ?? {};
  skillIconPaths = Object.fromEntries((skills ?? []).map((s) => [s.id, s.icon]));
}
export const iconUrl = (resPath) => (resPath && iconManifest[resPath] ? `/ui/${iconManifest[resPath]}` : null);
export function iconImg(resPath, cls = 'icon') {
  const url = iconUrl(resPath);
  return url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async">` : '';
}

// A skill's game icon, or a coloured two-letter badge when there isn't one.
export function badge(skill, name = skill) {
  const url = iconUrl(skillIconPaths[skill]);
  if (url) return `<img class="skill-badge skill-icon" src="${esc(url)}" alt="" loading="lazy" decoding="async">`;
  return `<span class="skill-badge" style="--hue:${skillHue(skill)}" aria-hidden="true">${esc(String(name).slice(0, 2))}</span>`;
}
