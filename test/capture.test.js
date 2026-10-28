import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSupervisor, ffmpegCaptureArgs, listAudioDevices, parseArecordList } from '../src/capture.js';
import { fakeSpawn, waitFor } from './helpers.js';

const config = { mode: 'alsa', device: 'hw:1,0', channels: 1, sampleRate: 48000, chunkSeconds: 5, autostart: false };

test('ffmpeg reads ALSA once and fans out analysis PCM plus source-format PCM', () => {
  const args = ffmpegCaptureArgs(config);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'alsa']);
  assert.equal(args[args.indexOf('-i') + 1], 'hw:1,0');
  assert.ok(args.includes('pipe:1'));
  assert.equal(args[args.indexOf('-ar') + 1], '16000');
  assert.equal(args.at(-1), 'pipe:3');
  assert.ok(args.includes('48000'));
  assert.ok(args.includes('pipe:1'));
});

test('PCM from ffmpeg carries wall-clock start times', async () => {
  const spawn = fakeSpawn();
  const now = 1_000_000;
  const cap = new CaptureSupervisor({ config, spawn, now: () => now });
  const got = [];
  cap.on('pcm', (e) => got.push(e));
  cap.start();
  spawn.children[0].stdout.write(Buffer.alloc(3200));
  spawn.children[0].stdout.write(Buffer.alloc(1600));
  await waitFor(() => got.length === 2);
  assert.equal(got[0].startMs, now);
  assert.equal(got[1].startMs, now + 100);
  cap.stop();
});

test('an exited ffmpeg is restarted with doubling backoff, and stop() prevents restarts', async () => {
  const spawn = fakeSpawn();
  const cap = new CaptureSupervisor({ config, spawn, minRestartMs: 10, maxRestartMs: 40 });
  cap.start();
  spawn.children[0].exit(1);
  assert.equal(cap.status().state, 'restarting');
  await waitFor(() => spawn.children.length === 2);
  spawn.children[1].exit(1);
  await waitFor(() => spawn.children.length === 3);
  assert.equal(cap.status().restarts, 2);
  assert.match(cap.status().lastError, /ffmpeg exited \(1\)/);
  cap.stop();
  assert.equal(cap.status().state, 'stopped');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spawn.children.length, 3);
  assert.deepEqual(spawn.children[2].killed, ['SIGTERM']);
});

test('a missing ffmpeg binary is reported in readable words', async () => {
  const spawn = fakeSpawn();
  const cap = new CaptureSupervisor({ config, spawn, minRestartMs: 10_000 });
  cap.start();
  const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  spawn.children[0].emit('error', err);
  assert.equal(cap.status().lastError, 'ffmpeg is not installed');
  cap.stop();
});

test('simulated mode needs no ffmpeg and emits silence in real time', async () => {
  const spawn = fakeSpawn();
  const cap = new CaptureSupervisor({ config: { ...config, mode: 'simulated' }, spawn });
  let count = 0;
  cap.on('pcm', ({ pcm }) => (count += pcm.length));
  cap.start();
  await waitFor(() => count >= 3200);
  cap.stop();
  assert.equal(spawn.children.length, 0);
});

test('arecord -l output is parsed into hw ids', () => {
  const text = 'card 0: Headphones [Headphones], device 0: Analog [Analog]\n  Subdevices: 1/1\ncard 1: Device [USB Audio Device], device 0: USB Audio [USB Audio]\n';
  assert.deepEqual(parseArecordList(text), [
    { id: 'hw:0,0', card: 0, device: 0, cardName: 'Headphones', deviceName: 'Analog' },
    { id: 'hw:1,0', card: 1, device: 0, cardName: 'USB Audio Device', deviceName: 'USB Audio' },
  ]);
});

test('listAudioDevices reports a missing arecord', async () => {
  const execFile = (cmd, args, opts, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '');
  const out = await listAudioDevices({ mode: 'alsa', execFile });
  assert.deepEqual(out, { devices: [], error: 'arecord is not installed (alsa-utils)' });
});
