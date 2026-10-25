import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadioOutputs, radioEncoderArgs } from '../src/radio.js';
import { fakeSpawn, waitFor } from './helpers.js';

const target = (over = {}) => ({ id: 'local', name: 'Local', mode: 'on', rtmpUrl: 'rtmp://tuberadio:1935/live/k', hlsUrl: null, ...over });

test('encoder reads raw PCM on stdin and pushes audio-only FLV to RTMP', () => {
  const args = radioEncoderArgs({ rtmpUrl: 'rtmp://x/live/k', bitrate: '96k' });
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-b:a') + 1], '96k');
  assert.equal(args.at(-1), 'rtmp://x/live/k');
  assert.equal(args.includes('-c:v'), false);
});

test('PCM written to the radio reaches every running encoder', () => {
  const spawn = fakeSpawn();
  const radio = new RadioOutputs({ spawn });
  radio.configure({ targets: [target(), target({ id: 'vps' })], bitrate: '96k' });
  radio.start();
  assert.equal(spawn.children.length, 2);
  const seen = [];
  spawn.children[0].stdin.on('data', (d) => seen.push(d.length));
  radio.write(Buffer.alloc(3200));
  return waitFor(() => seen.length === 1).then(() => assert.equal(seen[0], 3200));
});

test('disabled and unconfigured targets are not started and say why', () => {
  const spawn = fakeSpawn();
  const radio = new RadioOutputs({ spawn });
  radio.configure({ targets: [target({ mode: 'off' }), target({ id: 'b', rtmpUrl: null })], bitrate: '96k' });
  radio.start();
  assert.equal(spawn.children.length, 0);
  assert.deepEqual(radio.status().map((s) => s.state), ['off', 'unconfigured']);
});

test('a crashed encoder restarts on its own', async () => {
  const spawn = fakeSpawn();
  const radio = new RadioOutputs({ spawn, minRestartMs: 5, maxRestartMs: 20 });
  radio.configure({ targets: [target()], bitrate: '96k' });
  radio.start();
  spawn.children[0].exit(1);
  await waitFor(() => spawn.children.length === 2);
  assert.equal(radio.status()[0].restarts, 1);
  radio.stop();
});

test('changing a target stops the old encoder', () => {
  const spawn = fakeSpawn();
  const radio = new RadioOutputs({ spawn });
  radio.configure({ targets: [target()], bitrate: '96k' });
  radio.start();
  radio.configure({ targets: [target({ rtmpUrl: 'rtmp://other/live/k' })], bitrate: '96k' });
  assert.deepEqual(spawn.children[0].killed, ['SIGTERM']);
  assert.equal(spawn.children.length, 2);
  radio.stop();
});
