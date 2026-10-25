import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditorClient, AuditorError, normaliseInference } from '../src/auditor.js';
import { jsonResponse } from './helpers.js';

const pcm = Buffer.alloc(3200);

test('normaliseInference keeps segments and falls back to the whole text', () => {
  assert.deepEqual(normaliseInference({ language: 'fi', segments: [{ start: 0.5, end: 1.5, text: ' tuore ' }, { start: 2, end: 3, text: ' ' }] }), {
    language: 'fi',
    segments: [{ startSec: 0.5, endSec: 1.5, text: 'tuore' }],
  });
  assert.deepEqual(normaliseInference({ text: 'kaikki' }).segments, [{ startSec: 0, endSec: 0, text: 'kaikki' }]);
  assert.deepEqual(normaliseInference({ text: '' }).segments, []);
});

test('posts a WAV chunk with language and the bearer key, then parses the answer', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ language: 'fi', text: 'hei', segments: [{ start: 0, end: 1, text: 'hei' }] });
  };
  const client = new AuditorClient({ url: 'http://auditor:8090/', apiKey: 'k1', fetchFn });
  const out = await client.transcribe({ pcm, language: 'fi' });
  assert.equal(calls[0].url, 'http://auditor:8090/inference');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k1');
  const form = calls[0].init.body;
  assert.equal(form.get('language'), 'fi');
  assert.equal((await form.get('file').text()).slice(0, 4), 'RIFF');
  assert.equal(out.segments[0].text, 'hei');
});

test('503 is retried, and a 422 fails at once', async () => {
  let n = 0;
  const fetchFn = async () => (++n < 3 ? jsonResponse({}, 503) : jsonResponse({ text: 'ok' }));
  const client = new AuditorClient({ url: 'http://a', fetchFn, retryDelayMs: 1 });
  assert.equal((await client.transcribe({ pcm, language: 'fi' })).segments[0].text, 'ok');
  assert.equal(n, 3);

  let m = 0;
  const bad = new AuditorClient({ url: 'http://a', fetchFn: async () => (++m, jsonResponse({ detail: 'x' }, 422)), retryDelayMs: 1 });
  await assert.rejects(bad.transcribe({ pcm, language: 'fi' }), (err) => err instanceof AuditorError && !err.retryable);
  assert.equal(m, 1);
});
