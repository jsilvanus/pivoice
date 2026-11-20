import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditorLiveClient } from '../src/auditor-live.js';

test('starts a pull session, maps Auditor SSE wall times, and deletes the session', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'live-1' }), { status: 202 });
    if (url.endsWith('/events')) {
      return new Response('event: transcript\ndata: {"sequence":7,"text":"Terve","language":"fi","wall_start":"2026-10-28T10:00:00.000Z","wall_end":"2026-10-28T10:00:01.000Z"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ id: 'live-1' }), { status: 200 });
  };
  const client = new AuditorLiveClient({
    url: 'http://auditor:8090/',
    apiKey: 'secret',
    source: 'rtsp://mediamtx:8554/church',
    language: 'fi',
    fetchFn,
  });
  const transcripts = [];
  client.on('transcript', (event) => transcripts.push(event));
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.status().running, true);
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].text, 'Terve');
  assert.equal(transcripts[0].startMs, Date.parse('2026-10-28T10:00:00.000Z'));
  assert.equal(calls[0].url, 'http://auditor:8090/v1/live');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  await client.stop();
  assert.equal(client.status().running, false);
  assert.equal(calls.at(-1).init.method, 'DELETE');
});


test('stop racing a pending start deletes the session created by the late response', async () => {
  let resolveStart;
  const calls = [];
  const client = new AuditorLiveClient({
    url: 'http://auditor:8090',
    source: 'rtsp://mediamtx:8554/church',
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return await new Promise((resolve) => { resolveStart = resolve; });
      }
      return new Response('{}', { status: 200 });
    },
  });
  const starting = client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = client.stop();
  resolveStart?.(new Response(JSON.stringify({ id: 'late-session' }), { status: 202 }));
  await Promise.all([starting, stopping]);
  assert.equal(client.status().running, false);
  assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.ok(calls.at(-1).url.endsWith('/v1/live/late-session'));
});

test('push mode starts without liveSourceUrl and streams raw 16 kHz s16le PCM to /audio', async () => {
  const calls = [];
  const client = new AuditorLiveClient({
    url: 'http://auditor:8090',
    apiKey: 'secret',
    inputMode: 'push',
    language: 'fi',
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === 'POST' && url.endsWith('/v1/live')) {
        return new Response(JSON.stringify({ id: 'push-1' }), { status: 202 });
      }
      if (url.endsWith('/events')) {
        return new Response('', { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/audio')) {
        return new Response(JSON.stringify({ accepted_bytes: init.body?.length ?? 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
  });

  await client.start();
  assert.equal(client.status().inputMode, 'push');
  const startBody = JSON.parse(calls[0].init.body);
  assert.equal(startBody.input_mode, 'push');

  const pcm = Buffer.alloc(3200, 1);
  client.pushPcm(pcm);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const audioCalls = calls.filter((c) => c.url.endsWith('/v1/live/push-1/audio'));
  assert.equal(audioCalls.length, 1);
  assert.equal(audioCalls[0].init.headers['content-type'], 'application/octet-stream');
  assert.equal(audioCalls[0].init.body, pcm);

  await client.stop();
  const eofCall = calls.find((c) => c.url.endsWith('/v1/live/push-1/audio') && c.init.headers['x-eof'] === '1');
  assert.ok(eofCall, 'stop() sends x-eof: 1 to close push audio stream');
});
