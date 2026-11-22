import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SileroVad, floorFromEnv } from '../src/silero-vad.js';
import { PiVoiceService } from '../src/service.js';
import { fakeSpawn, tempStore } from './helpers.js';

class FakeTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

/** Fake session: counts runs, answers from `probability(runIndex)` and records the state it was given. */
function fakeVad(probability, opts = {}) {
  let runs = 0;
  const statesSeen = [];
  const session = {
    async run(feeds) {
      statesSeen.push(feeds.state.data[0]);
      return { output: { data: [probability(runs++)] }, stateN: { data: new Float32Array(256).fill(0.5) } };
    },
  };
  const vad = new SileroVad({ runtime: { Tensor: FakeTensor }, session, statusHz: 1000, ...opts });
  return { vad, runs: () => runs, statesSeen };
}

const frame = (amplitude) => {
  const b = Buffer.alloc(1024);
  for (let i = 0; i < 512; i++) b.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return b;
};
const QUIET = frame(5); // about -76 dBFS
const LOUD = frame(3000); // about -21 dBFS
const feed = (vad, frames) => vad.push(Buffer.concat(frames), 0);

test('floorFromEnv parses the floor and the off values', () => {
  assert.equal(floorFromEnv(undefined), -60);
  assert.equal(floorFromEnv('-50'), -50);
  assert.equal(floorFromEnv('0'), null);
  assert.equal(floorFromEnv('off'), null);
  assert.equal(floorFromEnv('banana'), -60);
  assert.equal(floorFromEnv('12'), -60);
});

test('silent frames run no inference and report probability 0', async () => {
  const { vad, runs } = fakeVad(() => 0.9);
  await vad.initialize();
  const probs = [];
  vad.on('frame', (s) => probs.push(s.probability));
  feed(vad, Array(40).fill(QUIET));
  await vad.close();
  assert.equal(runs(), 0);
  assert.equal(probs[0], 0);
  assert.equal(vad.speaking, false);
});

test('a loud frame after silence runs at once and speech starts on that frame', async () => {
  const { vad, runs, statesSeen } = fakeVad(() => 0.9);
  await vad.initialize();
  const speech = [];
  vad.on('speech', (s) => speech.push(s.at));
  vad.push(Buffer.concat([...Array(10).fill(QUIET)]), 100);
  vad.push(LOUD, 200);
  await vad.close();
  assert.equal(runs(), 1);
  assert.deepEqual(speech, [200]);
  assert.equal(statesSeen[0], 0, 'model state starts fresh after skipped silence');
});

test('the hangover keeps running inference on quiet frames until it ends, then skipping resumes', async () => {
  // 0.9 for the first run, then 0.1 (below threshold).
  const { vad, runs } = fakeVad((n) => (n === 0 ? 0.9 : 0.1), { hangoverMs: 350 });
  await vad.initialize();
  const events = [];
  vad.on('speech', () => events.push('speech'));
  vad.on('silence', () => events.push('silence'));
  vad.push(LOUD, 1000);
  vad.push(QUIET, 1100); // within hangover: runs, still speaking
  vad.push(QUIET, 1300); // within hangover
  vad.push(QUIET, 1500); // past hangover: runs, ends speech
  const afterHangover = () => runs();
  await new Promise((r) => setImmediate(r));
  await vad.close().catch(() => {});
  assert.deepEqual(events, ['speech', 'silence']);
  assert.equal(afterHangover(), 4);

  const second = fakeVad((n) => (n === 0 ? 0.9 : 0.1), { hangoverMs: 350 });
  await second.vad.initialize();
  second.vad.push(LOUD, 1000);
  second.vad.push(QUIET, 1500);
  second.vad.push(Buffer.concat(Array(5).fill(QUIET)), 1600); // not speaking any more: skipped
  await second.vad.close();
  assert.equal(second.runs(), 2);
});

test('floor off (0) runs every frame', async () => {
  const { vad, runs } = fakeVad(() => 0.01, { floorDbfs: null });
  await vad.initialize();
  feed(vad, Array(6).fill(QUIET));
  await vad.close();
  assert.equal(runs(), 6);
});

test('quiet speech just above the floor still passes', async () => {
  const { vad, runs } = fakeVad(() => 0.9);
  await vad.initialize();
  feed(vad, [frame(100)]); // about -50 dBFS
  await vad.close();
  assert.equal(runs(), 1);
  assert.equal(vad.speaking, true);
});

test('setSuspended stops inference, ends speech, flags skipped idle and resumes with a fresh state', async () => {
  const { vad, runs, statesSeen } = fakeVad(() => 0.9);
  await vad.initialize();
  const events = [];
  vad.on('silence', () => events.push('silence'));
  vad.push(LOUD, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(vad.speaking, true);
  vad.setSuspended(true);
  assert.deepEqual(events, ['silence']);
  assert.equal(vad.status.skipped, 'idle');
  assert.equal(vad.status.speaking, false);
  vad.push(LOUD, 100);
  vad.push(LOUD, 200);
  await vad.close().catch(() => {});
  assert.equal(runs(), 1);

  const again = fakeVad(() => 0.9);
  await again.vad.initialize();
  again.vad.setSuspended(true);
  again.vad.setSuspended(false);
  assert.equal(again.vad.status.skipped, undefined);
  again.vad.push(LOUD, 0);
  await again.vad.close();
  assert.equal(again.runs(), 1);
  assert.equal(again.statesSeen[0], 0);
  assert.equal(statesSeen.length, 1);
});

test('service: speechDetectionNeeded follows its consumers and the silero status reports idle', async () => {
  const { store } = await tempStore({ capture: { mode: 'simulated' }, auditor: { mode: 'auto', startWhen: 'capture_start' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => 1 });
  // No auditor URL: transcriber not configured, no gateway, no subscribers.
  assert.equal(service.speechDetectionNeeded(), false);
  const off = service.subscribe(() => {});
  assert.equal(service.speechDetectionNeeded(), true, 'an event subscriber needs it');
  assert.equal(service.status().speechDetection.skipped, undefined);
  off();
  assert.equal(service.speechDetectionNeeded(), false);
  assert.equal(service.status().speechDetection.skipped, 'idle');
  service.stop();
});

test('service: push auditor in auto mode needs speech detection; PIVOICE_VAD_ON_DEMAND off keeps it on', async () => {
  const { store } = await tempStore({ auditor: { url: 'http://auditor:8090', liveMode: 'push', mode: 'auto', startWhen: 'capture_start' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => 1 });
  // live push: transcriber unconfigured and startWhen=capture_start, so nothing reads it
  assert.equal(service.speechDetectionNeeded(), false);
  service.stop();

  const { store: s2 } = await tempStore({ auditor: { url: 'http://auditor:8090', liveSourceUrl: 'rtsp://x/y', liveMode: 'pull', mode: 'auto' } });
  const liveOnly = new PiVoiceService({ store: s2, spawn: fakeSpawn(), now: () => 1 });
  assert.equal(liveOnly.speechDetectionNeeded(), false, 'live auditor, startWhen capture_start, no gateway');
  liveOnly.stop();

  const { store: s3 } = await tempStore({ auditor: { url: 'http://auditor:8090', mode: 'auto' } });
  const legacy = new PiVoiceService({ store: s3, spawn: fakeSpawn(), now: () => 1 });
  assert.equal(legacy.speechDetectionNeeded(), true, 'chunk upload gated by speech');
  legacy.stop();

  const { store: s4 } = await tempStore({});
  const forced = new PiVoiceService({ store: s4, spawn: fakeSpawn(), now: () => 1, vadOnDemand: false });
  assert.equal(forced.speechDetectionNeeded(), true);
  forced.stop();
});

test('service: a gateway with an activity-triggered live auditor needs it', async () => {
  const { store } = await tempStore({ auditor: { url: 'http://auditor:8090', liveSourceUrl: 'rtsp://x/y', liveMode: 'pull', mode: 'auto', startWhen: 'speech_or_music' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => 1, telemetryHost: '127.0.0.1', telemetryPort: 39101 });
  assert.equal(service.speechDetectionNeeded(), true);
  service.stop();
});
