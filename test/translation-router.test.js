import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/translation/router.js';
import { RouteError } from '../src/translation/errors.js';

const NOW = 100_000;
const SEGMENTS = [{ id: 0, text: 'Yksi.', endMs: NOW }, { id: 1, text: 'Kaksi.', endMs: NOW }];

function fakeRoute(name, { available = true, results = [] } = {}) {
  const calls = [];
  return {
    name,
    calls,
    available: () => available,
    async translate(segments) {
      calls.push(segments.length);
      const next = results.length ? results.shift() : 'ok';
      if (next instanceof Error) throw next;
      return { model: `${name}-model`, translations: segments.map((s) => ({ id: s.id, text: `${name}:${s.id}` })) };
    },
  };
}

const router = (routes, chain, now = () => NOW) => createRouter({ routes, chainFor: () => chain, maxAgeMs: 60_000, now });

test('works with only the mt route registered', async () => {
  const mt = fakeRoute('mt');
  const r = router({ mt }, ['mt', 'hosted']);
  const out = await r.translate(SEGMENTS, { source: 'fi', target: 'en' });
  assert.equal(out.route, 'mt');
  assert.equal(out.model, 'mt-model');
  assert.equal(out.translations.get(1), 'mt:1');
  assert.deepEqual(r.routes(), ['mt']);
  assert.equal(r.available('fi', 'en'), true);
});

test('chain order; an unavailable route is skipped', async () => {
  const mt = fakeRoute('mt', { available: false });
  const llm = fakeRoute('llm');
  const hosted = fakeRoute('hosted');
  const out = await router({ mt, llm, hosted }, ['mt', 'hosted', 'llm']).translate(SEGMENTS, { source: 'fi', target: 'en' });
  assert.equal(out.route, 'hosted');
  assert.equal(mt.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('a retryable failure is retried once on the same route, then the next route takes it', async () => {
  const mt = fakeRoute('mt', { results: [new RouteError('WORKER_LOST', 'x'), new RouteError('WORKER_LOST', 'x')] });
  const hosted = fakeRoute('hosted');
  const out = await router({ mt, hosted }, ['mt', 'hosted']).translate(SEGMENTS, { source: 'fi', target: 'en' });
  assert.equal(mt.calls.length, 2);
  assert.equal(out.route, 'hosted');
});

test('a non-retryable failure goes straight to the next route; an invalid answer counts as a failure', async () => {
  const mt = fakeRoute('mt', { results: [new RouteError('INFERENCE_FAILED', 'x')] });
  const bad = {
    name: 'llm',
    available: () => true,
    translate: async () => ({ translations: [{ id: 0, text: 'only one' }] }),
  };
  const hosted = fakeRoute('hosted');
  const out = await router({ mt, llm: bad, hosted }, ['mt', 'llm', 'hosted']).translate(SEGMENTS, { source: 'fi', target: 'en' });
  assert.equal(mt.calls.length, 1);
  assert.equal(out.route, 'hosted');
});

test('no next route when the deadline is too close; the last error is thrown', async () => {
  const mt = fakeRoute('mt', { results: [new RouteError('INFERENCE_FAILED', 'x')] });
  const hosted = fakeRoute('hosted');
  const r = router({ mt, hosted }, ['mt', 'hosted'], () => NOW + 59_500);
  await assert.rejects(r.translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'INFERENCE_FAILED' });
  assert.equal(hosted.calls.length, 0);
});

test('nothing available: NO_ROUTE; cancel is not retried', async () => {
  await assert.rejects(router({ mt: fakeRoute('mt', { available: false }) }, ['mt']).translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'NO_ROUTE' });
  assert.equal(router({}, ['mt']).available('fi', 'en'), false);
  const mt = fakeRoute('mt', { results: [new RouteError('CANCELLED', 'x')] });
  const hosted = fakeRoute('hosted');
  await assert.rejects(router({ mt, hosted }, ['mt', 'hosted']).translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'CANCELLED' });
  assert.equal(hosted.calls.length, 0);
});
