import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpectralClassifier } from '../src/spectral.js';

function tone(freq, amplitude = 10000, count = 512) {
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) out.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 16000)), i * 2);
  return out;
}

function noise(count = 512, amplitude = 10000) {
  const out = Buffer.alloc(count * 2);
  let seed = 123456789;
  for (let i = 0; i < count; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    out.writeInt16LE(Math.round(((seed / 0xffffffff) * 2 - 1) * amplitude), i * 2);
  }
  return out;
}

test('spectral classifier treats silence separately from sound', () => {
  const classifier = new SpectralClassifier();
  classifier.push(Buffer.alloc(1024), 1000);
  assert.equal(classifier.status.label, 'silence');
  assert.equal(classifier.status.confidence, 1);
});

test('spectral classifier identifies a sustained tonal signal as music-like', () => {
  const classifier = new SpectralClassifier();
  classifier.push(tone(440), 1000);
  assert.equal(classifier.status.label, 'music');
  assert.ok(classifier.status.features.flatness < 0.4);
});

test('spectral classifier identifies broadband noisy audio as speech-like, not music', () => {
  const classifier = new SpectralClassifier();
  classifier.push(noise(), 1000);
  assert.equal(classifier.status.label, 'speech');
  assert.ok(classifier.status.features.flatness > 0.4);
});
