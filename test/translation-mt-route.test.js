import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFleet, validateSpec } from 'fffleet';
import { createMtRoute } from '../src/translation/routes/mt.js';
import { createTranslateExecutor } from '../fleet/translate/executor.js';

const SEGMENTS = [
  { id: 0, text: 'Kello lyö kaksitoista.', endMs: 0 },
  { id: 1, text: 'Aasi kulkee joen yli.', endMs: 0 },
];

/** A real in-process fffleet runner with the real executor and a fake engine. */
function localFleet({ capabilities = ['type:translate', 'translate:fi-en'], engine } = {}) {
  const executor = createTranslateExecutor({
    manifest: async () => ({ 'fi-en': { direction: 'fi-en', engine: 'fake', model: 'fake-fi-en@1' } }),
    engineFactory: async () =>
      engine ?? { engine: 'fake', model: 'fake-fi-en@1', translate: async (texts) => texts.map((t) => `EN(${t.length})`) },
  });
  const fleet = createFleet({ fallback: 'none', local: { slots: { default: 2 }, executors: { translate: executor.run } } });
  return { fleet: { submit: (s) => fleet.submit(s), capabilities: async () => ({ capabilities }), close: () => fleet.close() }, inner: fleet };
}

test('the job spec is a valid fffleet spec placed by capability on the operator PC worker', async () => {
  const submitted = [];
  const fake = {
    capabilities: async () => ({ capabilities: [] }),
    submit: async (spec) => {
      submitted.push(spec);
      const job = new EventEmitter();
      job.state = 'succeeded';
      job.cancel = async () => {};
      job.done = Promise.resolve({ state: 'succeeded', outputs: [{ name: 'translations', data: { v: 1, model: 'm', translations: [] } }] });
      return job;
    },
  };
  const route = createMtRoute({ fleet: fake, idPrefix: 'pivoice-tr-test' });
  await route.translate(SEGMENTS, { source: 'fi', target: 'en' });
  const [spec] = submitted;
  assert.equal(validateSpec(spec).ok, true, JSON.stringify(validateSpec(spec).errors));
  assert.equal(spec.type, 'translate');
  assert.equal(spec.kind, 'batch');
  assert.deepEqual(spec.requires, ['translate:fi-en']);
  assert.deepEqual(spec.workerPreference, ['operator-pc-translate']);
  assert.equal(spec.id, 'pivoice-tr-test-1');
  // Only id and text go to the worker: no times, sessions or other caption data.
  assert.deepEqual(spec.translate, { v: 1, source: 'fi', target: 'en', segments: SEGMENTS.map(({ id, text }) => ({ id, text })) });
  assert.ok(!spec.id.includes('Kello'));
});

test('end to end through an in-process fleet and the real executor', async () => {
  const { fleet, inner } = localFleet();
  try {
    const route = createMtRoute({ fleet });
    assert.equal(route.available('fi', 'en'), false);
    await route.refresh();
    assert.equal(route.available('fi', 'en'), true);
    assert.equal(route.available('fi', 'sv'), false);
    const answer = await route.translate(SEGMENTS, { source: 'fi', target: 'en' });
    assert.equal(answer.model, 'fake-fi-en@1');
    assert.deepEqual(answer.translations, [{ id: 0, text: 'EN(22)' }, { id: 1, text: 'EN(21)' }]);
    assert.deepEqual(route.status().directions, ['fi-en']);
  } finally {
    await inner.close();
  }
});

test('a worker failure surfaces its code, not its message', async () => {
  const { fleet, inner } = localFleet({ engine: { engine: 'fake', model: 'x', translate: async () => { throw new Error('secret Kello'); } } });
  try {
    const route = createMtRoute({ fleet });
    await assert.rejects(route.translate(SEGMENTS, { source: 'fi', target: 'en' }), (err) => {
      assert.equal(err.code, 'INFERENCE_FAILED');
      assert.ok(!err.message.includes('Kello'));
      return true;
    });
  } finally {
    await inner.close();
  }
});

function queuedFleet() {
  const cancelled = [];
  const fleet = {
    capabilities: async () => ({ capabilities: ['type:translate', 'translate:fi-en'] }),
    submit: async (spec) => {
      const job = new EventEmitter();
      job.state = 'queued';
      let resolve;
      job.done = new Promise((r) => (resolve = r));
      job.cancel = async () => {
        cancelled.push(spec.id);
        job.state = 'cancelled';
        resolve({ state: 'cancelled', outputs: [] });
      };
      return job;
    },
  };
  return { fleet, cancelled };
}

test('a job nobody takes is cancelled after the queue timeout and reported as unavailable', async () => {
  const { fleet, cancelled } = queuedFleet();
  const route = createMtRoute({ fleet, queueTimeoutMs: 10 });
  await assert.rejects(route.translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'ROUTE_UNAVAILABLE' });
  assert.equal(cancelled.length, 1);
  assert.equal(route.status().queueTimeouts, 1);
});

test('aborting the signal cancels the job', async () => {
  const { fleet, cancelled } = queuedFleet();
  const route = createMtRoute({ fleet, queueTimeoutMs: 60_000 });
  const controller = new AbortController();
  const p = route.translate(SEGMENTS, { source: 'fi', target: 'en', signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(p, { code: 'CANCELLED' });
  assert.equal(cancelled.length, 1);
});

test('an unreachable fleet makes the route unavailable', async () => {
  const route = createMtRoute({
    fleet: {
      capabilities: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      submit: async () => { throw Object.assign(new Error('down'), { code: 'UNREACHABLE' }); },
    },
  });
  await route.refresh();
  assert.equal(route.available('fi', 'en'), false);
  await assert.rejects(route.translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'ROUTE_UNAVAILABLE' });
});
