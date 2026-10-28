import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceGate, rms } from '../src/vad.js';
import { SpectralClassifier } from '../src/spectral.js';

const loud = (ms) => Buffer.from(new Int16Array(ms * 16).fill(8000).buffer);
const quiet = (ms) => Buffer.alloc(ms * 32);

test('rms of silence is zero and of a constant is its amplitude', () => {
  assert.equal(rms(Buffer.alloc(64)), 0);
  assert.equal(rms(loud(10)), 8000);
});

test('the gate opens on speech with pre-roll and closes after the hangover', () => {
  const gate = new VoiceGate({ thresholdDb: -45, hangoverSeconds: 1, prerollSeconds: 0.5 });
  const events = [];
  gate.on('open', (e) => events.push(['open', e.startMs, e.preroll.length]));
  gate.on('close', (e) => events.push(['close', e.atMs]));

  gate.push(quiet(500), 0);
  gate.push(loud(200), 500);
  assert.equal(gate.open, true);
  gate.push(quiet(500), 700); // 500 ms of quiet: still inside hangover
  assert.equal(gate.open, true);
  gate.push(quiet(600), 1200); // now 1100 ms past last voice (ends at 700)
  assert.equal(gate.open, false);
  assert.deepEqual(events, [['open', 500, 16000], ['close', 1800]]);
  assert.equal(gate.lastVoiceMs, 700);
});

test('pre-roll is capped at the configured length', () => {
  const gate = new VoiceGate({ prerollSeconds: 0.25 });
  let preroll = null;
  gate.on('open', (e) => (preroll = e.preroll));
  gate.push(quiet(1000), 0);
  gate.push(loud(10), 1000);
  assert.equal(preroll.length, 8000);
});


test('spectral classifier skips quiet frames and detects tonal music versus noise-like speech', () => {
  const classifier = new SpectralClassifier({ silenceDbfs: -45 });
  const silence = Buffer.alloc(512 * 2);
  assert.equal(classifier.push(silence).label, 'silence');
  assert.equal(classifier.status.features.flatness, null);

  const tone = Buffer.alloc(512 * 2);
  for (let i = 0; i < 512; i++) tone.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 220 * i / 16000)), i * 2);
  assert.equal(classifier.push(tone).label, 'music');

  // Deterministic pseudo-random, noise-like signal approximates broadband consonant energy.
  const noise = Buffer.alloc(512 * 2);
  let seed = 123456789;
  for (let i = 0; i < 512; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    noise.writeInt16LE(((seed >>> 16) - 32768) >> 1, i * 2);
  }
  assert.equal(classifier.push(noise).label, 'speech');
  assert.ok(classifier.status.features.flatness > 0);
});
