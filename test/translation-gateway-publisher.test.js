import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayTranslations } from '../src/translation/gateway-publisher.js';

const event = (n, endMs = 1_000_000) => ({ sourceKey: `s:${n}`, sourceSeq: n, session: 's', source: 'fi', lang: 'en', text: `invented ${n}`, startMs: endMs - 500, endMs, origin: 'model', route: 'mt', model: 'm', latencyMs: 100 });
const ok = { ok: true, status: 200 };

test('posts batched events with the Bearer key to /api/v1/translations', async () => {
  const calls = [];
  const pub = new GatewayTranslations({ url: 'http://gw:3000/', token: 'secret-key', batchSize: 2, fetchFn: async (url, init) => { calls.push({ url, init }); return ok; }, now: () => 1_000_000 });
  pub.start();
  pub.push(event(1));
  pub.push(event(2));
  pub.push(event(3));
  for (let i = 0; i < 20 && pub.status().sent < 3; i++) await new Promise((r) => setTimeout(r, 5));
  pub.stop();
  assert.equal(calls[0].url, 'http://gw:3000/api/v1/translations');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(calls[0].init.body).events.map((e) => e.sourceSeq), [1, 2]);
  assert.equal(pub.status().sent, 3);
});

test('push does nothing while stopped; stop clears the buffer', () => {
  const pub = new GatewayTranslations({ url: 'http://gw', token: 't', fetchFn: async () => ok });
  pub.push(event(1));
  assert.equal(pub.status().queued, 0);
  pub.start();
  pub.push(event(1));
  assert.equal(pub.status().queued, 1);
  pub.stop();
  assert.equal(pub.status().queued, 0);
});

test('the buffer is bounded and stale events are dropped', async () => {
  const calls = [];
  const pub = new GatewayTranslations({ url: 'http://gw', token: 't', batchSize: 100, maxBuffer: 2, maxAgeMs: 60_000, now: () => 1_000_000, fetchFn: async (u, i) => { calls.push(i); return ok; } });
  pub.start();
  pub.push(event(1, 100)); // stale
  pub.push(event(2));
  pub.push(event(3));
  assert.equal(pub.status().dropped, 1);
  await pub.flush();
  pub.stop();
  assert.deepEqual(JSON.parse(calls[0].body).events.map((e) => e.sourceSeq), [2, 3]);
  const stale = new GatewayTranslations({ url: 'http://gw', token: 't', now: () => 1_000_000, fetchFn: async () => ok });
  stale.start();
  stale.push(event(9, 10));
  await stale.flush();
  assert.equal(stale.status().sent, 0);
  assert.equal(stale.status().dropped, 1);
  stale.stop();
});

test('an outage keeps events; a refused batch is dropped; auth failures keep them', async () => {
  let status = 503;
  const pub = new GatewayTranslations({ url: 'http://gw', token: 't', now: () => 1_000_000, fetchFn: async () => ({ ok: status === 200, status }) });
  pub.start();
  pub.push(event(1));
  await pub.flush();
  assert.equal(pub.status().queued, 1);
  status = 401;
  await pub.flush();
  assert.equal(pub.status().queued, 1);
  status = 400;
  await pub.flush();
  assert.equal(pub.status().queued, 0);
  assert.equal(pub.status().dropped, 1);
  pub.stop();
});

test('the token and caption text never appear in status or errors', async () => {
  const pub = new GatewayTranslations({ url: 'http://gw:3000', token: 'secret-key', now: () => 1_000_000, fetchFn: async () => { throw new Error('boom secret-key invented 1'); } });
  pub.start();
  pub.push(event(1));
  await pub.flush();
  const dump = JSON.stringify(pub.status());
  assert.ok(!dump.includes('secret-key'));
  assert.ok(!dump.includes('invented'));
  assert.equal(pub.status().host, 'gw:3000');
  pub.stop();
});

test('unconfigured publisher cannot start', () => {
  assert.throws(() => new GatewayTranslations({}).start());
});
