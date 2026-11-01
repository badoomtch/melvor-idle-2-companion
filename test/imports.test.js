// The browser loads the UI as ES modules: one bad named import stops the whole page from loading,
// and nothing else in the tests would notice. This checks every named import against its module.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['ui', 'ui/pages', 'engine'];

const exportCache = new Map();
function exportsOf(file) {
  if (!exportCache.has(file)) {
    const src = readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
    exportCache.set(file, names);
  }
  return exportCache.get(file);
}

test('every named import in the UI and engine exists', () => {
  const problems = [];
  for (const dir of DIRS) {
    for (const name of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.js'))) {
      const file = join(ROOT, dir, name);
      for (const m of readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        const target = m[2].startsWith('/') ? join(ROOT, m[2]) : resolve(dirname(file), m[2]);
        let names;
        try {
          names = exportsOf(target);
        } catch {
          problems.push(`${dir}/${name}: ${m[2]} doesn't exist`);
          continue;
        }
        for (const part of m[1].split(',')) {
          const imported = part.trim().split(/\s+as\s+/)[0].trim();
          if (imported && !names.has(imported)) problems.push(`${dir}/${name}: ${m[2]} has no export '${imported}'`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

// A syntax error in any one module stops the whole page in the browser; the named-import check above
// reads files as text and wouldn't notice.
test('every UI, engine and server module parses', async () => {
  const { execFileSync } = await import('node:child_process');
  const problems = [];
  for (const dir of [...DIRS, 'server']) {
    for (const name of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
      try {
        execFileSync(process.execPath, ['--check', join(ROOT, dir, name)], { stdio: 'pipe' });
      } catch (e) {
        problems.push(`${dir}/${name}: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) ?? 'does not parse'}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
