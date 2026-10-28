import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiVoiceService } from '../src/service.js';
import { fakeSpawn, jsonResponse, tempStore, waitFor } from './helpers.js';

const NOW = Date.now();

test('one capture feeds the radio and the auditor; captions carry absolute times', async () => {
  const { store } = await tempStore({
    capture: { mode: 'alsa', device: 'hw:1,0', chunkSeconds: 1 },
    radio: { targets: [{ id: 'local', enabled: true, rtmpUrl: 'rtmp://tuberadio:1935/live/k' }] },
    auditor: { url: 'http://auditor:8090', language: 'fi' },
    captions: { relay: { mode: 'on', url: 'https://relay.example', token: 'tok' } },
  });
  const spawn = fakeSpawn();
  const relayPosts = [];
  const auditorCalls = [];
  const fetchFn = async (url, init) => {
    if (url.startsWith('http://auditor')) {
      auditorCalls.push(url);
      return jsonResponse({ language: 'fi', segments: [{ start: 0.25, end: 0.75, text: `s${auditorCalls.length}` }] });
    }
    relayPosts.push(JSON.parse(init.body));
    return jsonResponse({});
  };
  const service = new PiVoiceService({ store, spawn, fetchFn, now: () => NOW });
  service.startCapture();

  const ffmpeg = spawn.children[0];
  assert.equal(spawn.children.length, 2, 'ffmpeg for capture and one radio encoder');
  ffmpeg.stdout.write(Buffer.alloc(32_000 * 2)); // two one-second chunks
  await waitFor(() => service.captionsStatus().relay.sent === 2, 4000);

  const sent = relayPosts.flatMap((b) => b.segments.map((s) => ({ startMs: s.startedAt, endMs: s.endedAt })));
  assert.equal(auditorCalls.length, 2);
  assert.equal(sent[0].startMs, NOW + 250);
  assert.equal(sent[0].endMs, NOW + 750);
  assert.equal(sent[1].startMs, NOW + 1250);
  assert.equal(service.status().transcription.processed, 2);
  service.stop();
});

test('captions stay off when their destination is not configured', async () => {
  const { store } = await tempStore({ captions: { relay: { mode: 'on', url: 'https://r', token: null } } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => NOW });
  assert.equal(service.captionsStatus().relay.running, false);
  assert.equal(service.captionsStatus().relay.configured, false);
  assert.equal(service.captionsStatus().youtube.running, false);
});

test('applyConfig restarts capture only when the capture section changed', async () => {
  const { store } = await tempStore({ capture: { mode: 'simulated' } });
  const spawn = fakeSpawn();
  const service = new PiVoiceService({ store, spawn, now: () => NOW });
  service.startCapture();
  const previous = store.get();
  const next = { ...previous, auditor: { ...previous.auditor, language: 'sv' } };
  service.applyConfig(previous, next);
  assert.equal(service.capture.running, true);
  service.stop();
});

test('radio target mode auto starts the encoder only with speech and includes pre-roll', async () => {
  const { store } = await tempStore({
    capture: { mode: 'alsa', device: 'hw:1,0', chunkSeconds: 1 },
    voice: { thresholdDb: -45, hangoverSeconds: 0.5, prerollSeconds: 0.5 },
    radio: { targets: [{ id: 'relay', mode: 'auto', rtmpUrl: 'rtmp://relay.example:1935/live/k' }] },
  });
  const spawn = fakeSpawn();
  const service = new PiVoiceService({ store, spawn, now: () => NOW });
  service.startCapture();
  assert.equal(spawn.children.length, 1, 'only capture while silent');
  assert.equal(service.radio.status()[0].state, 'waiting');

  const mic = spawn.children[0];
  mic.stdout.write(Buffer.alloc(32_000)); // silence
  mic.stdout.write(Buffer.from(new Int16Array(16_000).fill(9000).buffer)); // speech
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawn.children.length, 2, 'encoder started on speech');
  assert.equal(service.radio.status()[0].state, 'running');
  assert.equal(service.status().voice.open, true);
  service.stop();
});

test('transcription mode off sends nothing to the auditor', async () => {
  const { store } = await tempStore({
    capture: { mode: 'simulated', chunkSeconds: 1 },
    auditor: { url: 'http://auditor', mode: 'off' },
  });
  let called = 0;
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn: async () => (called++, new Response('{}')), now: () => NOW });
  service.startCapture();
  await new Promise((r) => setTimeout(r, 1200));
  service.stop();
  assert.equal(called, 0);
  assert.equal(service.status().transcription.mode, 'off');
});

test('youtube auto sends captions only while the stream is online', async () => {
  const { store } = await tempStore({
    captions: { youtube: { mode: 'auto', streamKey: 'yt-key', apiKey: 'AIzaKEY', videoId: 'abcdefghijk', delayMs: 1000 } },
  });
  let online = false;
  const sent = [];
  const fetchFn = async () => jsonResponse({ items: [{ snippet: { liveBroadcastContent: online ? 'live' : 'none' } }] });
  const createSender = () => ({ start() {}, end() {}, async send(text, ts) { sent.push([text, ts]); } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn, createSender, now: () => NOW });
  await waitFor(() => service.captionsStatus().youtube.stream.lastCheckedAt !== null);
  assert.equal(service.captionsStatus().youtube.effective, 'off');

  online = true;
  await service.streamWatcher.poll();
  assert.equal(service.captionsStatus().youtube.effective, 'on');
  service.transcriber.emit('transcript', { seq: 1, startMs: 5000, endMs: 6000, text: 'Siunatkoon', language: 'fi' });
  await waitFor(() => service.captionsStatus().youtube.sent === 1);
  assert.deepEqual(sent, [['Siunatkoon', 6000]]);

  online = false;
  await service.streamWatcher.poll();
  await service.streamWatcher.poll();
  assert.equal(service.captionsStatus().youtube.effective, 'off');
  service.stop();
});

test('Auditor pull mode starts on capture start and consumes Auditor-owned RTSP transcripts', async () => {
  const { store } = await tempStore({
    capture: { mode: 'simulated' },
    auditor: {
      url: 'http://auditor:8090',
      liveSourceUrl: 'rtsp://mediamtx:8554/church',
      startWhen: 'capture_start',
      mode: 'on',
    },
  });
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST' && url.endsWith('/v1/live')) {
      return jsonResponse({ id: 'live-session-1' }, 202);
    }
    if (url.endsWith('/events')) {
      return new Response('event: transcript\ndata: {"sequence":1,"text":"Siunatkoon","language":"fi","wall_start":"2026-10-28T10:00:00.000Z","wall_end":"2026-10-28T10:00:01.000Z"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return jsonResponse({ id: 'live-session-1' });
  };
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn, now: () => NOW });
  const events = [];
  service.subscribe((event) => events.push(event));
  service.startCapture();
  await waitFor(() => events.some((event) => event.type === 'transcript'));
  assert.equal(calls[0].url, 'http://auditor:8090/v1/live');
  assert.equal(JSON.parse(calls[0].init.body).source, 'rtsp://mediamtx:8554/church');
  assert.equal(events.find((event) => event.type === 'transcript').data.text, 'Siunatkoon');
  assert.equal(service.status().transcription.configured, false, 'no chunk uploads in pull mode');
  service.stop();
});


test('activity session sends timed pre-roll and reports its byte count', async () => {
  const { store } = await tempStore({
    capture: { mode: 'alsa', device: 'hw:1,0', chunkSeconds: 1 },
    auditor: {
      url: 'http://auditor:8090',
      liveSourceUrl: 'rtsp://mediamtx:8554/church',
      startWhen: 'speech',
      mode: 'on',
    },
    activity: { prerollSeconds: 2 },
  });
  const spawn = fakeSpawn();
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/live')) return jsonResponse({ id: 'activity-session-1' }, 202);
    if (url.endsWith('/events')) {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return jsonResponse({});
  };
  const service = new PiVoiceService({ store, spawn, fetchFn, now: () => NOW });
  service.startCapture();
  spawn.children[0].stdout.write(Buffer.alloc(32_000));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = await service.startActivitySession('speech');
  assert.equal(status.preRollBytes, 32_000);
  const request = calls.find((call) => call.url.endsWith('/v1/live'));
  assert.ok(request);
  assert.equal(request.init.body.get('preroll').size, 32_000);
  const metadata = JSON.parse(request.init.body.get('metadata'));
  assert.equal(metadata.has_preroll, true);
  assert.equal(metadata.preroll_start_ms, NOW);
  service.stop();
});
