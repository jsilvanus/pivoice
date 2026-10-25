import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamOnlineWatcher } from '../src/captions/stream-status.js';
import { jsonResponse, waitFor } from './helpers.js';

const answer = (live) => jsonResponse({ items: [{ snippet: { liveBroadcastContent: live ? 'live' : 'none' } }] });

test('online when liveBroadcastContent is live; key goes in a header, never the URL', async () => {
  const calls = [];
  const fetchFn = async (url, init) => (calls.push({ url, init }), answer(true));
  const w = new StreamOnlineWatcher({ apiKey: 'AIza-secret', videoId: 'abcdefghijk', fetchFn, intervalMs: 60_000 });
  const changes = [];
  w.on('change', (v) => changes.push(v));
  w.start();
  await waitFor(() => w.online);
  assert.deepEqual(changes, [true]);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza-secret');
  assert.equal(calls[0].url.includes('AIza'), false);
  assert.match(calls[0].url, /videos\?part=snippet&id=abcdefghijk$/);
  w.stop();
});

test('goes offline only after two consecutive non-live polls, and a failed poll keeps the state', async () => {
  let mode = 'live';
  const fetchFn = async () => {
    if (mode === 'error') return jsonResponse({}, 500);
    return answer(mode === 'live');
  };
  const w = new StreamOnlineWatcher({ apiKey: 'k', videoId: 'abcdefghijk', fetchFn, intervalMs: 60_000 });
  await w.poll();
  assert.equal(w.online, true);
  mode = 'none';
  await w.poll();
  assert.equal(w.online, true, 'one miss is tolerated');
  mode = 'error';
  await w.poll();
  assert.equal(w.online, true, 'a failed poll does not flip the state');
  assert.match(w.status().lastError, /HTTP 500/);
  mode = 'none';
  await w.poll();
  assert.equal(w.online, false);
  assert.equal(w.status().lastError, null);
});

test('the key is removed from error text', async () => {
  const w = new StreamOnlineWatcher({ apiKey: 'SECRETKEY', videoId: 'abcdefghijk', fetchFn: async () => { throw new Error('bad SECRETKEY'); } });
  await w.poll();
  assert.equal(w.status().lastError, 'bad ***');
});

test('start needs a key and a video id', () => {
  assert.throws(() => new StreamOnlineWatcher({ apiKey: 'k' }).start(), /needs apiKey and videoId/);
});
