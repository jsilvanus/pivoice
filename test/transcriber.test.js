import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber } from '../src/transcriber.js';
import { waitFor } from './helpers.js';

const chunk = (seq, startMs) => ({ seq, startMs, endMs: startMs + 5000, pcm: Buffer.alloc(32) });

function fakeAuditor(answer) {
  const calls = [];
  return {
    calls,
    async transcribe(args) {
      calls.push(args);
      return typeof answer === 'function' ? answer(args) : answer;
    },
  };
}

test('segments get absolute epoch times inside their chunk', async () => {
  const now = 100_000;
  const t = new Transcriber({ now: () => now });
  const events = [];
  t.on('transcript', (e) => events.push(e));
  t.configure({ auditor: fakeAuditor({ language: 'fi', segments: [{ startSec: 1, endSec: 2.5, text: 'Herra' }, { startSec: 3, endSec: 0, text: 'siunatkoon' }] }), language: 'fi', maxQueue: 3 });
  t.enqueue(chunk(7, 98_000));
  await waitFor(() => events.length === 2);
  assert.deepEqual(events[0], { seq: 1, chunkSeq: 7, startMs: 99_000, endMs: 100_500, text: 'Herra', language: 'fi' });
  assert.equal(events[1].startMs, 101_000);
  assert.equal(events[1].endMs, 103_000, 'missing end falls back to the chunk end');
});

test('a full queue drops the oldest waiting chunk', async () => {
  const release = [];
  const auditor = fakeAuditor(() => new Promise((resolve) => release.push(() => resolve({ segments: [] }))));
  const t = new Transcriber({ now: () => 0 });
  t.configure({ auditor, language: 'fi', maxQueue: 2 });
  t.enqueue(chunk(0, 0)); // in flight
  t.enqueue(chunk(1, 5000));
  t.enqueue(chunk(2, 10000));
  t.enqueue(chunk(3, 15000)); // drops chunk 1
  assert.equal(t.status().dropped, 1);
  assert.equal(t.status().queued, 2);
  t.clear();
});

test('chunks already too old are skipped, not captioned late', async () => {
  let now = 0;
  const auditor = fakeAuditor({ segments: [{ startSec: 0, endSec: 1, text: 'late' }] });
  const t = new Transcriber({ now: () => now, staleMs: 10_000 });
  t.configure({ auditor, language: 'fi', maxQueue: 3 });
  now = 60_000;
  t.enqueue(chunk(0, 0));
  await waitFor(() => t.status().stale === 1);
  assert.equal(auditor.calls.length, 0);
});

test('an auditor failure is reported and the queue keeps going', async () => {
  let n = 0;
  const auditor = fakeAuditor(() => {
    if (++n === 1) throw new Error('auditor answered HTTP 422');
    return { segments: [{ startSec: 0, endSec: 1, text: 'ok' }] };
  });
  const t = new Transcriber({ now: () => 5000 });
  const events = [];
  t.on('transcript', (e) => events.push(e));
  t.configure({ auditor, language: 'fi', maxQueue: 3 });
  t.enqueue(chunk(0, 0));
  t.enqueue(chunk(1, 5000));
  await waitFor(() => events.length === 1);
  assert.equal(t.status().failed, 1);
  assert.equal(t.status().lastError, null, 'a later success clears the error');
});

test('an unconfigured transcriber accepts nothing', () => {
  const t = new Transcriber();
  t.enqueue(chunk(0, 0));
  assert.equal(t.status().queued, 0);
  assert.equal(t.configured, false);
});
