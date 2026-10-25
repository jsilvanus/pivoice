import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { PiVoiceService } from '../src/service.js';
import { fakeSpawn, tempStore } from './helpers.js';

const TOKEN = 'lan-secret';
let server;
let base;
let service;
let configFile;

before(async () => {
  const { store, dir } = await tempStore({});
  configFile = `${dir}/config.json`;
  service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => Date.now() });
  server = createServer({ service, store, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  service.stop();
  server.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

test('probes are open and everything under /api/v1 needs the bearer token', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const res = await fetch(`${base}/api/v1/status`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await fetch(`${base}/api/v1/status`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/status`, { headers: auth })).status, 200);
});

test('the token is not accepted in the query string', async () => {
  assert.equal((await fetch(`${base}/api/v1/status?token=${TOKEN}`)).status, 401);
});

test('unknown routes answer 404 JSON', async () => {
  const res = await fetch(`${base}/api/v1/nope`, { headers: auth });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

test('configuration writes are validated; the response and reads never show secrets', async () => {
  const bad = await fetch(`${base}/api/v1/config`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ auditor: { url: 'not a url', apiKey: 'sekret-1' } }),
  });
  const badBody = await bad.json();
  assert.equal(bad.status, 400);
  assert.equal(badBody.error.details[0].path, 'auditor.url');
  assert.equal(JSON.stringify(badBody).includes('sekret-1'), false);

  const ok = await fetch(`${base}/api/v1/config`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ auditor: { url: 'http://auditor:8090', apiKey: 'sekret-1' } }),
  });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.auditor.apiKey, '***');
  const read = await (await fetch(`${base}/api/v1/config`, { headers: auth })).text();
  assert.equal(read.includes('sekret-1'), false);
  const { readFile } = await import('node:fs/promises');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).auditor.apiKey, 'sekret-1', 'stored for the service');
});

test('a body that is not JSON is a 400', async () => {
  const res = await fetch(`${base}/api/v1/config`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

test('captions are controlled by modes in the configuration, not by start/stop routes', async () => {
  assert.equal((await fetch(`${base}/api/v1/captions/start`, { method: 'POST', headers: auth })).status, 404);
  const res = await fetch(`${base}/api/v1/captions/status`, { headers: auth });
  assert.equal((await res.json()).relay.mode, 'off');
});

test('the transcription event stream delivers capture state changes', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/transcription/events`, { headers: auth, signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // ": connected"
  await fetch(`${base}/api/v1/capture/start`, { method: 'POST', headers: auth });
  let text = '';
  while (!text.includes('event: capture')) text += decoder.decode((await reader.read()).value);
  assert.match(text, /event: capture\ndata: \{.*"running":true/);
  controller.abort();
  await fetch(`${base}/api/v1/capture/stop`, { method: 'POST', headers: auth });
});
