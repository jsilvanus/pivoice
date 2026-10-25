import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayCaptions } from '../src/captions/relay.js';
import { YouTubeCaptions } from '../src/captions/youtube.js';
import { jsonResponse, waitFor } from './helpers.js';

const ev = (seq, startMs = seq * 1000) => ({ seq, chunkSeq: 0, startMs, endMs: startMs + 900, text: `t${seq}`, language: 'fi' });

test('relay posts batches with the bearer token, never in the URL', async () => {
  const posts = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse({ ok: true });
  };
  const relay = new RelayCaptions({ url: 'https://relay.example/', token: 'tok', fetchFn, now: () => 1000, batchSize: 2, flushMs: 60_000 });
  relay.start();
  relay.push(ev(1));
  relay.push(ev(2));
  await waitFor(() => relay.status().sent === 2);
  assert.equal(posts[0].url, 'https://relay.example/api/v1/captions');
  assert.equal(posts[0].init.headers.authorization, 'Bearer tok');
  assert.equal(posts[0].url.includes('tok'), false);
  assert.deepEqual(posts[0].body.segments[0], { lang: 'fi', text: 't1', startedAt: 1000, endedAt: 1900 });
  relay.stop();
});

test('relay keeps events while down and drops them once too old', async () => {
  let up = false;
  let now = 0;
  const fetchFn = async () => (up ? jsonResponse({}) : jsonResponse({}, 503));
  const relay = new RelayCaptions({ url: 'https://r', token: 't', fetchFn, now: () => now, batchSize: 10, flushMs: 60_000, maxAgeMs: 10_000 });
  relay.start();
  relay.push(ev(1, 0));
  await relay.flush();
  assert.equal(relay.status().queued, 1);
  assert.match(relay.status().lastError, /HTTP 503/);
  now = 20_000;
  up = true;
  await relay.flush();
  assert.equal(relay.status().queued, 0);
  assert.equal(relay.status().dropped, 1);
  assert.equal(relay.status().sent, 0);
  relay.stop();
});

test('relay refuses to start without url and token', () => {
  assert.throws(() => new RelayCaptions({ url: 'https://r', token: null }).start(), /needs url and token/);
});

test('YouTube captions keep order, add the delay and hide the stream key in errors', async () => {
  const sent = [];
  let fail = false;
  const createSender = () => ({
    start() {},
    end() {},
    async send(text, ts) {
      if (fail) throw new Error(`cannot reach ingest for key yt-SECRET`);
      sent.push([text, ts]);
    },
  });
  const yt = new YouTubeCaptions({ streamKey: 'yt-SECRET', delayMs: 2000, createSender });
  yt.start();
  yt.push(ev(1, 1000));
  yt.push(ev(2, 2000));
  await new Promise((r) => setTimeout(r, 0));
  await waitFor(() => yt.status().sent === 2);
  assert.deepEqual(sent, [['t1', 3000], ['t2', 4000]]);
  fail = true;
  yt.push(ev(3));
  await waitFor(() => yt.status().failed === 1);
  assert.equal(yt.status().lastError, 'cannot reach ingest for key ***');
  yt.stop();
  assert.equal(yt.status().running, false);
});

test('YouTube start without a key is an error', () => {
  assert.throws(() => new YouTubeCaptions({}).start(), /stream key is not set/);
});
