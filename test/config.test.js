import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { configSchema, mergeConfig, redactConfig, redactRtmpUrl, REDACTED } from '../src/config.js';
import { tempStore } from './helpers.js';

const base = () => configSchema.parse({});

test('defaults are valid and closed (no targets, captions off, no secrets)', () => {
  const cfg = base();
  assert.equal(cfg.capture.mode, 'alsa');
  assert.equal(cfg.capture.device, 'default');
  assert.equal(cfg.capture.policy, 'on');
  assert.equal(cfg.capture.autoPollMode, 'scheduled');
  assert.equal(cfg.capture.autoPollSeconds, 120);
  assert.equal(cfg.captions.youtube.mode, 'off');
  assert.equal(cfg.radio.targets.length, 0);
  assert.equal(cfg.auditor.apiKey, null);
  assert.equal(cfg.auditor.startWhen, 'capture_start');
  assert.equal(cfg.auditor.idleCloseSeconds, 15);
  assert.equal(cfg.auditor.liveSourceUrl, null);
});

test('invalid values are rejected', () => {
  assert.throws(() => configSchema.parse({ auditor: { url: 'not a url' } }));
  assert.throws(() => configSchema.parse({ auditor: { liveSourceUrl: 'https://not-rtsp.example' } }));
  assert.throws(() => configSchema.parse({ auditor: { idleCloseSeconds: -1 } }));
  assert.throws(() => configSchema.parse({ auditor: { idleCloseSeconds: 3601 } }));
  assert.throws(() => configSchema.parse({ radio: { targets: [{ id: 'Bad Id!' }] } }));
  assert.throws(() => configSchema.parse({ radio: { targets: [{ id: 'a', rtmpUrl: 'https://x' }] } }));
});

test('redaction hides secrets and the RTMP stream key, keeps the host', () => {
  const cfg = configSchema.parse({
    auditor: { url: 'http://auditor:8090', apiKey: 'sekret' },
    captions: { relay: { token: 't0k', streamId: 'main' }, youtube: { streamKey: 'yt-key' } },
    radio: { targets: [{ id: 'vps', rtmpUrl: 'rtmp://relay.example:1935/live/abc123' }] },
  });
  const shown = JSON.stringify(redactConfig(cfg));
  for (const secret of ['sekret', 't0k', 'yt-key', 'abc123']) assert.equal(shown.includes(secret), false, secret);
  const out = redactConfig(cfg);
  assert.equal(out.auditor.apiKey, REDACTED);
  assert.equal(out.radio.targets[0].rtmpUrl, 'rtmp://relay.example:1935/live/***');
  assert.equal(redactRtmpUrl('rtmp://h/live/k'), 'rtmp://h/live/***');
});

test('a redacted value written back keeps the stored secret', () => {
  const current = configSchema.parse({
    auditor: { url: 'http://a', apiKey: 'keep-me' },
    radio: { targets: [{ id: 'vps', rtmpUrl: 'rtmp://h/live/secretkey' }] },
  });
  const next = mergeConfig(current, {
    auditor: { apiKey: REDACTED, language: 'en' },
    radio: { targets: [{ id: 'vps', rtmpUrl: 'rtmp://h/live/***', enabled: true }] },
  });
  assert.equal(next.auditor.apiKey, 'keep-me');
  assert.equal(next.auditor.language, 'en');
  assert.equal(next.radio.targets[0].rtmpUrl, 'rtmp://h/live/secretkey');
});

test('store persists atomically with mode 0600 and reloads', async () => {
  const { store, dir } = await tempStore();
  const { previous, current } = await store.update({ captions: { youtube: { mode: 'on', streamKey: 'k1' } } });
  assert.equal(previous.captions.youtube.mode, 'off');
  assert.equal(current.captions.youtube.streamKey, 'k1');
  const file = path.join(dir, 'config.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.captions.youtube.streamKey, 'k1');
});
