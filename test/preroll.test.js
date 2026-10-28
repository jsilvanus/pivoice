import assert from 'node:assert/strict';
import test from 'node:test';
import { PcmRingBuffer } from '../src/preroll.js';

test('keeps a rolling snapshot bounded to configured seconds', () => {
  const buffer = new PcmRingBuffer({ seconds: 1 });
  buffer.push(Buffer.alloc(20_000, 1));
  buffer.push(Buffer.alloc(20_000, 2));
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.length, 32_000);
  assert.equal(snapshot[0], 1);
  assert.equal(snapshot[11_999], 1);
  assert.equal(snapshot[12_000], 2);
});

test('supports disabled history and resizing without exceeding the bound', () => {
  const buffer = new PcmRingBuffer({ seconds: 0 });
  buffer.push(Buffer.alloc(100));
  assert.equal(buffer.snapshot().length, 0);
  buffer.configureSeconds(0.5);
  buffer.push(Buffer.alloc(20_000, 3));
  buffer.push(Buffer.alloc(20_000, 4));
  assert.equal(buffer.snapshot().length, 16_000);
  assert.equal(buffer.snapshot()[0], 4);
  buffer.clear();
  assert.equal(buffer.durationMs, 0);
});
