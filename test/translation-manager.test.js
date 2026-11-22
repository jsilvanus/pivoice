import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationManager } from '../src/translation/manager.js';
import { translationSchema } from '../src/translation/config.js';
import { TranslationMemory } from '../src/translation/memory.js';

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    setTimeoutFn: (fn, ms) => { const id = next++; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeoutFn: (id) => timers.delete(id),
    setIntervalFn: (fn, ms) => { const id = next++; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearIntervalFn: (id) => timers.delete(id),
    fireTimeouts() {
      for (const [id, t] of [...timers]) if (t.kind === 'timeout') { timers.delete(id); t.fn(); }
    },
  };
}

function setup({ cfg = {}, translate, available = () => true, memory = null, now = () => 10_000 } = {}) {
  const config = translationSchema.parse({ mode: 'on', targets: ['en', 'sv'], ...cfg });
  const calls = [];
  const router = {
    available,
    async translate(segments, opts) {
      calls.push({ segments, opts });
      if (translate) return translate(segments, opts);
      return { route: 'mt', model: 'm@1', truncated: 0, translations: new Map(segments.map((s) => [s.id, `${opts.target}:${s.text}`])) };
    },
  };
  let refreshes = 0;
  const routes = { mt: { refresh: async () => { refreshes++; }, status: () => ({ ok: true }) } };
  const timers = fakeTimers();
  const manager = new TranslationManager({ config: () => config, router, memory, routes, now, ...timers });
  const events = [];
  manager.on('translation', (e) => events.push(e));
  return { manager, calls, events, timers, refreshes: () => refreshes };
}

const flush = () => new Promise((r) => setImmediate(r));
const ev = (seq, text, extra = {}) => ({ seq, chunkSeq: 1, startMs: 1000 * seq, endMs: 1000 * seq + 900, text, language: 'fi', ...extra });

test('stopped manager does nothing and holds no timers', () => {
  const { manager, calls, timers } = setup();
  manager.handle(ev(1, 'Herra olkoon teidän kanssanne'));
  assert.equal(calls.length, 0);
  assert.equal(timers.timers.size, 0);
});

test('start polls routes, stop clears every timer', async () => {
  const { manager, timers, refreshes } = setup();
  manager.start();
  await flush();
  assert.equal(refreshes(), 1);
  manager.handle(ev(1, 'Hyvää huomenta'));
  assert.ok(timers.timers.size >= 2);
  manager.stop();
  assert.equal(timers.timers.size, 0);
  assert.equal(manager.running, false);
});

test('batches per direction and emits the event shape of plan §5.7', async () => {
  const { manager, calls, events, timers } = setup();
  manager.start();
  manager.handle(ev(3, 'Hyvää huomenta'), { session: 'abc' });
  timers.fireTimeouts();
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.opts.target).sort(), ['en', 'sv']);
  const en = events.find((e) => e.lang === 'en');
  assert.deepEqual(Object.keys(en).sort(), ['endMs', 'lang', 'latencyMs', 'model', 'origin', 'route', 'session', 'source', 'sourceKey', 'sourceSeq', 'startMs', 'text'].sort());
  assert.equal(en.sourceKey, 'abc:3');
  assert.equal(en.source, 'fi');
  assert.equal(en.text, 'en:Hyvää huomenta');
  assert.equal(en.origin, 'model');
  assert.equal(en.route, 'mt');
  manager.stop();
});

test('default session key is pivoice:<seq>; routes never see the session', async () => {
  const { manager, calls, events, timers } = setup({ cfg: { targets: ['en'] } });
  manager.start();
  manager.handle(ev(7, 'Kiitos'));
  timers.fireTimeouts();
  await flush();
  assert.equal(events[0].sourceKey, 'pivoice:7');
  assert.deepEqual(Object.keys(calls[0].segments[0]).sort(), ['endMs', 'id', 'ref', 'text']);
  manager.stop();
});

test('a memory hit skips the routes', async () => {
  const memory = new TranslationMemory({ path: 'x', readFileFn: async () => '' });
  memory.load([{ src: 'fi', text: 'Herra olkoon teidän kanssanne', tr: { en: 'The Lord be with you' } }]);
  const { manager, calls, events, timers } = setup({ cfg: { targets: ['en'] }, memory });
  manager.start();
  manager.handle(ev(1, 'Herra olkoon teidän kanssanne.'));
  timers.fireTimeouts();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(events[0].origin, 'memory');
  assert.equal(events[0].text, 'The Lord be with you');
  assert.equal(manager.status().targets.en.fromMemory, 1);
  manager.stop();
});

test('unsupported source, unavailable route and same-language target are skipped', async () => {
  const { manager, calls, timers } = setup({ cfg: { targets: ['en'] }, available: () => false });
  manager.start();
  manager.handle(ev(1, 'Привет', { language: 'ru' }));
  manager.handle(ev(2, 'Hei'));
  manager.handle(ev(3, 'Hello', { language: 'en' }));
  timers.fireTimeouts();
  await flush();
  assert.equal(calls.length, 0);
  const s = manager.status();
  assert.equal(s.skipped.unsupportedSource, 1);
  assert.equal(s.targets.en.dropped.unavailable, 1);
  manager.stop();
});

test('expired segments are dropped before sending', async () => {
  let t = 10_000;
  const { manager, calls, timers } = setup({ cfg: { targets: ['en'] }, now: () => t });
  manager.start();
  manager.handle(ev(1, 'Vanha'));
  t = 200_000;
  timers.fireTimeouts();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(manager.status().targets.en.dropped.late, 1);
  manager.stop();
});

test('router failure counts and records only the error code', async () => {
  const { manager, events, timers } = setup({
    cfg: { targets: ['en'] },
    translate: async () => { throw Object.assign(new Error('secret text here'), { code: 'NO_ROUTE' }); },
  });
  manager.start();
  manager.handle(ev(1, 'Hei'));
  timers.fireTimeouts();
  await flush();
  assert.equal(events.length, 0);
  const s = manager.status().targets.en;
  assert.equal(s.failed, 1);
  assert.equal(s.lastError, 'NO_ROUTE');
  assert.ok(!JSON.stringify(manager.status()).includes('Hei'));
  manager.stop();
});

test('stop aborts a batch in flight and nothing is emitted after', async () => {
  let release;
  const { manager, events, calls, timers } = setup({
    cfg: { targets: ['en'] },
    translate: (segments, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve({ route: 'mt', model: 'm', truncated: 0, translations: new Map(segments.map((s) => [s.id, 'x'])) });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('c'), { code: 'CANCELLED' })));
    }),
  });
  manager.start();
  manager.handle(ev(1, 'Hei'));
  timers.fireTimeouts();
  await flush();
  assert.equal(calls.length, 1);
  manager.stop();
  release();
  await flush();
  assert.equal(events.length, 0);
  assert.equal(manager.status().targets.en.failed, 0);
});

test('status gives availability for a source and latency percentiles', async () => {
  const { manager, timers } = setup({ cfg: { targets: ['en', 'fi'] } });
  manager.start();
  manager.handle(ev(1, 'Hei'));
  timers.fireTimeouts();
  await flush();
  const s = manager.status({ source: 'fi' });
  assert.equal(s.targets.en.available, true);
  assert.equal(s.targets.fi.available, undefined);
  assert.equal(s.targets.en.latencyMs.p50, 0);
  assert.deepEqual(s.routes, { mt: { ok: true } });
  assert.deepEqual(manager.availability('fi'), { en: true });
  manager.stop();
});

test('a throwing router.available never escapes handle()', () => {
  const { manager } = setup({ available: () => { throw new Error('boom'); } });
  manager.start();
  assert.doesNotThrow(() => manager.handle(ev(1, 'Hei')));
  manager.stop();
});
