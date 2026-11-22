import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRetry, deadlineOf, isExpired, partitionExpired } from '../src/translation/deadline.js';

const seg = (endMs) => ({ endMs, text: 'x' });

test('a segment expires maxAgeMs after its audio ends', () => {
  assert.equal(deadlineOf(seg(1000), 60_000), 61_000);
  assert.equal(isExpired(seg(1000), 61_000, 60_000), false);
  assert.equal(isExpired(seg(1000), 61_001, 60_000), true);
  const { live, expired } = partitionExpired([seg(0), seg(50_000), seg(10)], 60_011, 60_000);
  assert.deepEqual(live.map((s) => s.endMs), [50_000]);
  assert.deepEqual(expired.map((s) => s.endMs), [0, 10]);
});

test('one retry, only for retryable codes, only with time left before the earliest deadline', () => {
  const segments = [seg(10_000), seg(20_000)];
  const base = { segments, maxAgeMs: 60_000, attempt: 0 };
  assert.equal(canRetry({ ...base, code: 'WORKER_LOST', now: 60_000 }), true);
  assert.equal(canRetry({ ...base, code: 'TIMEOUT', now: 60_000 }), true);
  assert.equal(canRetry({ ...base, code: 'ORCHESTRATOR_RESTARTED', now: 60_000 }), true);
  assert.equal(canRetry({ ...base, code: 'INVALID_SPEC', now: 60_000 }), false);
  assert.equal(canRetry({ ...base, code: 'INVALID_RESULT', now: 60_000 }), false);
  assert.equal(canRetry({ ...base, code: 'WORKER_LOST', now: 69_500 }), false);
  assert.equal(canRetry({ ...base, code: 'WORKER_LOST', now: 60_000, attempt: 1 }), false);
  assert.equal(canRetry({ ...base, segments: [], code: 'WORKER_LOST', now: 0 }), false);
});
