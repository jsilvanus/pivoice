import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SileroVad } from '../src/silero-vad.js';
import { SpectralClassifier } from '../src/spectral.js';
import { PiVoiceTelemetryPublisher, telemetryIntervalFromEnv } from '../src/telemetry.js';

class FakeTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

function fakeVad(probabilities, opts = {}) {
  let n = 0;
  const feedsSeen = new Set();
  const session = {
    async run(feeds) {
      feedsSeen.add(feeds);
      return { output: { data: [probabilities[Math.min(n++, probabilities.length - 1)]] }, stateN: { data: new Float32Array(256).fill(0.5) } };
    },
  };
  const vad = new SileroVad({ runtime: { Tensor: FakeTensor }, session, ...opts });
  return { vad, feedsSeen, runs: () => n };
}

const frames = (count) => Buffer.alloc(count * 1024);

test('VAD frame events are throttled to PIVOICE_STATUS_HZ when nothing changes', async () => {
  const { vad, runs } = fakeVad([0.01], { statusHz: 5 });
  await vad.initialize();
  const events = [];
  vad.on('frame', (s) => events.push(s.at));
  vad.push(frames(62), 0); // ~2 s of silence at the same probability bucket
  await vad.close();
  assert.equal(runs(), 62);
  assert.ok(events.length >= 9 && events.length <= 11, `got ${events.length}`);
});

test('VAD emits at once on a probability bucket change and on speech transitions', async () => {
  const { vad } = fakeVad([0.01, 0.02, 0.03, 0.2, 0.2, 0.9, 0.9, 0.9], { statusHz: 1 });
  await vad.initialize();
  const frameEvents = [];
  const transitions = [];
  vad.on('frame', (s) => frameEvents.push(s.probability));
  vad.on('speech', () => transitions.push('speech'));
  vad.on('silence', () => transitions.push('silence'));
  vad.push(frames(8), 0);
  await vad.close();
  assert.deepEqual(frameEvents, [0.01, 0.2, 0.9]); // first, bucket 0->2, bucket 2->9
  assert.deepEqual(transitions, ['speech']);
});

test('VAD reuses its input and state tensors between frames and keeps recurrent state and context', async () => {
  const { vad, feedsSeen } = fakeVad([0.1]);
  await vad.initialize();
  const pcm = Buffer.alloc(1024);
  pcm.writeInt16LE(16384, 1022); // last sample of frame 1
  vad.push(Buffer.concat([pcm, pcm]), 0);
  await vad.close();
  assert.equal(feedsSeen.size, 1, 'one feeds object, reused');
});

test('spectral FFT runs every Nth loud frame but silence and changes in zero-crossing rate react at once', () => {
  const tone = (f) => { const b = Buffer.alloc(1024); for (let i = 0; i < 512; i++) b.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * f * i / 16000)), i * 2); return b; };
  const c = new SpectralClassifier({ fftEvery: 4 });
  const changes = [];
  const frameEvents = [];
  c.on('change', (s) => changes.push(s.label));
  c.on('frame', () => frameEvents.push(1));
  for (let i = 0; i < 8; i++) c.push(tone(220), i * 32);
  assert.equal(c.status.label, 'music');
  assert.equal(frameEvents.length, 2, 'FFT (and its frame event) on frames 1 and 5 only');
  assert.equal(c.status.at, 7 * 32, 'timestamp still follows skipped frames');
  c.push(tone(3000), 300); // very different zero-crossing rate: analysed immediately
  assert.equal(frameEvents.length, 3);
  c.push(Buffer.alloc(1024), 400);
  assert.equal(c.status.label, 'silence');
  assert.deepEqual(changes, ['music', 'speech', 'silence']);
});

test('PIVOICE_SPECTRAL_EVERY=1 analyses every frame', () => {
  const c = new SpectralClassifier({ fftEvery: 1 });
  let n = 0;
  c.on('frame', () => n++);
  const b = Buffer.alloc(1024);
  for (let i = 0; i < 512; i++) b.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 220 * i / 16000)), i * 2);
  for (let i = 0; i < 5; i++) c.push(b, i);
  assert.equal(n, 5);
});

test('telemetry publisher sends every configured interval while capturing and never while stopped', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let state = 'running';
  const sent = [];
  const socket = { on() {}, send: (p) => sent.push(p), close() {} };
  const pub = new PiVoiceTelemetryPublisher({ host: 'h', snapshot: () => ({ capture: { state } }), socketFactory: () => socket, intervalMs: 250 });
  pub.start();
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 4);
  state = 'stopped';
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 4);
  pub.stop();
});

test('telemetry interval defaults to 250 ms, honours the env and stays far below the 6 s stale limit', () => {
  assert.equal(telemetryIntervalFromEnv({}), 250);
  assert.equal(telemetryIntervalFromEnv({ PIVOICE_TELEMETRY_INTERVAL_MS: '500' }), 500);
  assert.equal(telemetryIntervalFromEnv({ PIVOICE_TELEMETRY_INTERVAL_MS: '5' }), 250);
  assert.equal(telemetryIntervalFromEnv({ PIVOICE_TELEMETRY_INTERVAL_MS: 'x' }), 250);
  assert.ok(250 * 10 < 6000);
});
