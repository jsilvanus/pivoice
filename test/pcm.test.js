import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_MS, Chunker, wavFromPcm } from '../src/pcm.js';

test('16 kHz mono s16le is 32 bytes per millisecond', () => {
  assert.equal(BYTES_PER_MS, 32);
});

test('wavFromPcm writes a valid 44-byte header followed by the PCM', () => {
  const pcm = Buffer.alloc(320, 1);
  const wav = wavFromPcm(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 320);
  assert.equal(wav.length, 364);
});

test('Chunker cuts exact chunks with absolute start and end times', () => {
  const c = new Chunker({ chunkMs: 1000 });
  const first = c.push(Buffer.alloc(32 * 600), 10_000);
  assert.equal(first.length, 0);
  const second = c.push(Buffer.alloc(32 * 600), 10_600);
  assert.equal(second.length, 1);
  assert.equal(second[0].seq, 0);
  assert.equal(second[0].startMs, 10_000);
  assert.equal(second[0].endMs, 11_000);
  assert.equal(second[0].pcm.length, 32_000);
  const tail = c.flush();
  assert.equal(tail.seq, 1);
  assert.equal(tail.startMs, 11_000);
  assert.equal(tail.pcm.length, 32 * 200);
});

test('Chunker starts a new chunk after a discontinuity (capture restart)', () => {
  const c = new Chunker({ chunkMs: 1000 });
  c.push(Buffer.alloc(32 * 300), 0);
  const out = c.push(Buffer.alloc(32 * 300), 60_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].pcm.length, 32 * 300);
  assert.equal(out[0].endMs, 300);
});
