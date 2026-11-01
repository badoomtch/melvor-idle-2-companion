// Asks GitHub for the companion's newest release, so the page can say when there's a new version.
// The only request the companion makes to the internet: it can be turned off in Settings, and with
// no connection it just stays quiet.

const EVERY_MS = 6 * 60 * 60_000;

// "v0.3.0" or "0.3.0" -> [0, 3, 0]; null for anything else.
const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
};

// Whether version a is newer than b.
export function isNewer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// "https://github.com/owner/name(.git)" or "github:owner/name" -> "owner/name".
export function repoFrom(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = /(?:github\.com[/:]|^github:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? m[1] : null;
}

/**
 * @param repo "owner/name" on GitHub, or null to never check
 * @param current this companion's version
 * @param enabled () => whether checking is switched on
 */
export function createUpdateCheck({ repo, current, enabled = () => true, fetchImpl = globalThis.fetch }) {
  let latest = null; // { version, url, name, publishedAt } when GitHub has something newer
  let checkedAt = null;

  async function check() {
    if (!repo || !enabled() || !fetchImpl) return;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `melvor-companion/${current}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const r = await res.json();
      checkedAt = Date.now();
      latest = isNewer(r.tag_name, current) ? { version: String(r.tag_name).replace(/^v/, ''), url: r.html_url, name: r.name || null, publishedAt: r.published_at ?? null } : null;
    } catch {
      // offline, rate-limited or GitHub is down: try again next time
    }
  }

  function start() {
    setTimeout(check, 5_000).unref();
    setInterval(check, EVERY_MS).unref();
  }

  return { check, start, info: () => (repo && enabled() ? { current, latest, checkedAt, releases: `https://github.com/${repo}/releases` } : null) };
}
