import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSupervisor, ffmpegCaptureArgs, getAudioMixer, listAudioDevices, parseAmixerScontents, parseArecordList, parseCardFromDevice, setAudioMixer } from '../src/capture.js';
import { fakeSpawn, waitFor } from './helpers.js';

const config = { mode: 'alsa', device: 'hw:1,0', channels: 1, sampleRate: 48000, chunkSeconds: 5, autostart: false };

test('ffmpeg reads ALSA once and fans out analysis PCM plus source-format PCM', () => {
  const args = ffmpegCaptureArgs(config);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'alsa']);
  assert.equal(args[args.indexOf('-i') + 1], 'hw:1,0');
  assert.ok(args.includes('pipe:1'));
  assert.ok(args.includes('-use_wallclock_as_timestamps'));
  assert.equal(args[args.indexOf('-use_wallclock_as_timestamps') + 1], '1');
  assert.equal(args[args.indexOf('-ar') + 1], '16000');
  assert.equal(args.at(-1), 'pipe:3');
  assert.ok(args.includes('48000'));
  assert.ok(args.includes('pipe:1'));
});

test('analysis and source PCM branches have independent wall-clock byte timelines', async () => {
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

test('ffmpegCaptureArgs includes ALSA playback branch when playbackDevice is configured', () => {
  const args = ffmpegCaptureArgs({ mode: 'alsa', device: 'hw:1,0', playbackDevice: 'plughw:1,0', channels: 1, sampleRate: 48000 });
  assert.ok(args.includes('plughw:1,0'));
  const alsaIndex = args.lastIndexOf('-f');
  assert.equal(args[alsaIndex + 1], 'alsa');
  assert.equal(args[alsaIndex + 2], 'plughw:1,0');
  // Playback branch outputs stereo with left-only audio (right channel muted)
  const panIdx = args.lastIndexOf('-af');
  assert.equal(args[panIdx + 1], 'pan=stereo|c0=c0|c1=0*c0');
});

test('ffmpegCaptureArgs maps left-channel only for both 1-channel and 2-channel capture', () => {
  const mono = ffmpegCaptureArgs({ mode: 'alsa', device: 'hw:1,0', channels: 1, sampleRate: 48000 });
  assert.ok(mono.includes('pan=mono|c0=c0'));

  const stereo = ffmpegCaptureArgs({ mode: 'alsa', device: 'hw:1,0', channels: 2, sampleRate: 48000 });
  assert.ok(stereo.includes('pan=mono|c0=c0'));
  assert.ok(stereo.includes('pan=stereo|c0=c0|c1=0*c0'));
});

test('CaptureSupervisor status reports playbackDevice', () => {
  const spawn = fakeSpawn();
  const cap = new CaptureSupervisor({ config: { mode: 'alsa', device: 'hw:1,0', playbackDevice: 'hw:1,0', channels: 1, sampleRate: 48000 }, spawn });
  assert.equal(cap.status().playbackDevice, 'hw:1,0');

  const sim = new CaptureSupervisor({ config: { mode: 'simulated' }, spawn });
  assert.equal(sim.status().playbackDevice, null);
});

test('parseCardFromDevice extracts card index or name correctly', () => {
  assert.equal(parseCardFromDevice('hw:1,0'), '1');
  assert.equal(parseCardFromDevice('plughw:2,0'), '2');
  assert.equal(parseCardFromDevice('hw:CARD=Device,DEV=0'), 'Device');
  assert.equal(parseCardFromDevice('default'), 'default');
  assert.equal(parseCardFromDevice(null), 'default');
});

test('parseAmixerScontents parses volumes, dB, limits and switches', () => {
  const sample = `
Simple mixer control 'Master',0
  Capabilities: pvolume pswitch pswitch-joined
  Playback channels: Front Left - Front Right
  Limits: Playback 0 - 64
  Front Left: Playback 48 [75%] [-6.00dB] [on]
  Front Right: Playback 48 [75%] [-6.00dB] [on]
Simple mixer control 'Mic',0
  Capabilities: cvolume cswitch
  Capture channels: Front Left - Front Right
  Limits: Capture 0 - 64
  Front Left: Capture 10 [15%] [-24.00dB] [on]
  Front Right: Capture 10 [15%] [-24.00dB] [on]
Simple mixer control 'Mic Boost',0
  Capabilities: cswitch
  Capture channels: Mono
  Mono: Capture [off]
`;
  const controls = parseAmixerScontents(sample);
  assert.equal(controls.length, 3);
  assert.equal(controls[0].name, 'Master');
  assert.equal(controls[0].items[0].volumePercent, 75);
  assert.equal(controls[1].name, 'Mic');
  assert.equal(controls[1].items[0].volumePercent, 15);
  assert.equal(controls[2].name, 'Mic Boost');
  assert.equal(controls[2].items[0].switch, false);
});

test('getAudioMixer and setAudioMixer update simulated controls', async () => {
  const initial = await getAudioMixer({ mode: 'simulated', card: '1' });
  assert.equal(initial.card, '1');
  assert.ok(initial.controls.length >= 3);
  const mic = initial.controls.find((c) => c.name === 'Mic');
  assert.equal(mic.items[0].volumePercent, 15);

  const updated = await setAudioMixer({
    mode: 'simulated',
    card: '1',
    updates: [
      { control: 'Mic', volume: 10 },
      { control: 'Mic Boost', switch: false },
    ],
    simulatedState: initial.controls,
  });
  const updatedMic = updated.controls.find((c) => c.name === 'Mic');
  assert.equal(updatedMic.items[0].volumePercent, 10);
});

test('getAudioMixer executes amixer with card option and handles errors', async () => {
  const fakeExec = (cmd, args, opts, cb) => {
    assert.equal(cmd, 'amixer');
    assert.deepEqual(args, ['-c', '1', 'scontents']);
    cb(null, `Simple mixer control 'Mic',0\n  Capabilities: cvolume\n  Front Left: Capture 10 [15%] [on]`);
  };
  const res = await getAudioMixer({ mode: 'alsa', card: '1', execFile: fakeExec });
  assert.equal(res.controls.length, 1);
  assert.equal(res.controls[0].name, 'Mic');

  const failExec = (cmd, args, opts, cb) => {
    const err = new Error('not found');
    err.code = 'ENOENT';
    cb(err);
  };
  const failRes = await getAudioMixer({ mode: 'alsa', card: '1', execFile: failExec });
  assert.equal(failRes.error, 'amixer is not installed (alsa-utils)');
});
