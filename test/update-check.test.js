// The new-version check against GitHub releases, with GitHub faked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpdateCheck, isNewer, repoFrom } from '../server/update-check.js';

const github = (release, ok = true) => async (url) => ({ ok, url, json: async () => release });

test('version numbers compare part by part', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('nightly', '0.2.0'), false, 'a tag that is not a version is never newer');
});

test('the repository comes from package.json', () => {
  assert.equal(repoFrom({ repository: { url: 'https://github.com/someone/melvor-idle-2-companion.git' } }), 'someone/melvor-idle-2-companion');
  assert.equal(repoFrom({ repository: 'github:someone/thing' }), 'someone/thing');
  assert.equal(repoFrom({}), null);
});

test('a newer release is offered with its page; the same version is not', async () => {
  const newer = createUpdateCheck({ repo: 'someone/thing', current: '0.2.0', fetchImpl: github({ tag_name: 'v0.3.0', html_url: 'https://github.com/someone/thing/releases/tag/v0.3.0' }) });
  await newer.check();
  assert.equal(newer.info().latest.version, '0.3.0');
  assert.match(newer.info().latest.url, /releases\/tag\/v0\.3\.0$/);

  const same = createUpdateCheck({ repo: 'someone/thing', current: '0.3.0', fetchImpl: github({ tag_name: 'v0.3.0' }) });
  await same.check();
  assert.equal(same.info().latest, null);
  assert.ok(same.info().checkedAt > 0);
});

test('switched off, offline or no repository: no request and nothing to show', async () => {
  let asked = 0;
  const count = async () => {
    asked++;
    throw new Error('offline');
  };
  const off = createUpdateCheck({ repo: 'someone/thing', current: '0.2.0', enabled: () => false, fetchImpl: count });
  await off.check();
  assert.equal(asked, 0);
  assert.equal(off.info(), null);

  const offline = createUpdateCheck({ repo: 'someone/thing', current: '0.2.0', fetchImpl: count });
  await offline.check();
  assert.equal(asked, 1);
  assert.equal(offline.info().latest, null, 'stays quiet without a connection');

  assert.equal(createUpdateCheck({ repo: null, current: '0.2.0', fetchImpl: count }).info(), null);
});
