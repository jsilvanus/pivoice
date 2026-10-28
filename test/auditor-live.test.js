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
