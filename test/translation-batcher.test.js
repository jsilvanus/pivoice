import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Batcher } from '../src/translation/batcher.js';

/** A manual clock for setTimeout. */
function fakeTimers() {
  const timers = new Set();
  return {
    setTimeoutFn: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimeoutFn: (t) => timers.delete(t),
    get pending() {
      return [...timers];
    },
    fire() {
      const all = [...timers];
      timers.clear();
      for (const t of all) t.fn();
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const seg = (n, text = `s${n}`) => ({ n, text });

test('no timer while empty; a batch goes out after the window', async () => {
  const clock = fakeTimers();
  const sent = [];
  const b = new Batcher({ send: async (batch) => sent.push(batch.map((s) => s.n)), windowMs: 300, ...clock });
  assert.equal(clock.pending.length, 0);
  b.add(seg(1));
  b.add(seg(2));
  assert.equal(clock.pending.length, 1);
  assert.equal(clock.pending[0].ms, 300);
  assert.deepEqual(sent, []);
  clock.fire();
  await tick();
  assert.deepEqual(sent, [[1, 2]]);
  assert.equal(clock.pending.length, 0);
});

test('flushes at once at maxSegments and at maxChars', async () => {
  const clock = fakeTimers();
  const sent = [];
  const b = new Batcher({ send: async (batch) => sent.push(batch.map((s) => s.n)), maxSegments: 3, maxChars: 10, ...clock });
  b.add(seg(1, 'a'));
  b.add(seg(2, 'b'));
  b.add(seg(3, 'c'));
  await tick();
  assert.deepEqual(sent, [[1, 2, 3]]);
  b.add(seg(4, 'xxxxxx'));
  b.add(seg(5, 'yyyyyy'));
  await tick();
  // 12 chars > 10: they cannot share a batch, so they go as two.
  assert.deepEqual(sent, [[1, 2, 3], [4], [5]]);
  assert.equal(clock.pending.length, 0);
});

test('in-flight limit holds segments until a batch finishes', async () => {
  const clock = fakeTimers();
  const sent = [];
  const releases = [];
  const b = new Batcher({
    send: (batch) => {
      sent.push(batch.map((s) => s.n));
      return new Promise((resolve) => releases.push(resolve));
    },
    maxSegments: 1,
    maxInFlight: 2,
    ...clock,
  });
  for (const n of [1, 2, 3, 4]) b.add(seg(n));
  await tick();
  assert.deepEqual(sent, [[1], [2]]);
  assert.equal(b.inFlight, 2);
  assert.equal(b.queued, 2);
  releases.shift()();
  await tick();
  assert.deepEqual(sent, [[1], [2], [3]]);
  releases.shift()();
  await tick();
  assert.deepEqual(sent, [[1], [2], [3], [4]]);
});

test('a batch that came due while in-flight was full goes as soon as a slot frees', async () => {
  const clock = fakeTimers();
  const sent = [];
  let release;
  const b = new Batcher({
    send: (batch) => {
      sent.push(batch.map((s) => s.n));
      return new Promise((resolve) => (release = resolve));
    },
    maxInFlight: 1,
    ...clock,
  });
  b.add(seg(1));
  clock.fire();
  await tick();
  b.add(seg(2));
  clock.fire(); // due, but the slot is busy
  await tick();
  assert.deepEqual(sent, [[1]]);
  release();
  await tick();
  assert.deepEqual(sent, [[1], [2]]);
});

test('the waiting queue is bounded: the oldest is dropped and reported', () => {
  const clock = fakeTimers();
  const dropped = [];
  const b = new Batcher({ send: async () => {}, maxQueued: 2, maxSegments: 16, maxChars: 4000, onDrop: (s, why) => dropped.push([s.n, why]), ...clock });
  for (const n of [1, 2, 3]) b.add(seg(n));
  assert.deepEqual(dropped, [[1, 'queueFull']]);
  assert.equal(b.status().dropped, 1);
  b.close();
  assert.deepEqual(dropped, [[1, 'queueFull'], [2, 'closed'], [3, 'closed']]);
  assert.equal(clock.pending.length, 0);
  b.add(seg(4));
  assert.equal(b.queued, 0);
});

test('a failing send does not jam the batcher', async () => {
  const clock = fakeTimers();
  const sent = [];
  const b = new Batcher({
    send: async (batch) => {
      sent.push(batch.map((s) => s.n));
      throw new Error('boom');
    },
    maxSegments: 1,
    maxInFlight: 1,
    ...clock,
  });
  b.add(seg(1));
  b.add(seg(2));
  await tick();
  await tick();
  assert.deepEqual(sent, [[1], [2]]);
  assert.equal(b.inFlight, 0);
});
