import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslateExecutor, readPayload } from '../executor.js';
import { parseManifest } from '../manifest.js';

// Invented sentences; the test checks they never appear in errors or logs.
const TEXTS = ['Kello lyö kaksitoista.', 'Aasi kulkee joen yli.'];

const MANIFEST = {
  'fi-en': { direction: 'fi-en', engine: 'fake', model: 'fake-fi-en' },
  'fi-sv': { direction: 'fi-sv', engine: 'fake', model: 'fake-fi-sv' },
  'en-fi': { direction: 'en-fi', engine: 'fake', model: 'fake-en-fi' },
  'sv-fi': { direction: 'sv-fi', engine: 'fake', model: 'fake-sv-fi' },
};

function fakeFactory({ loads = [], disposed = [], fail = null, delay = 0 } = {}) {
  return async (entry) => {
    loads.push(entry.direction);
    if (fail === 'load') throw new Error('broken model');
    return {
      engine: 'fake',
      model: entry.model,
      async translate(texts, { signal } = {}) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (signal?.aborted) throw new Error('aborted');
        if (fail === 'infer') throw new Error(`cannot translate ${texts[0]}`);
        if (fail === 'empty') return [''];
        return texts.map((t) => `[${entry.direction}] ${t.length}`);
      },
      async dispose() {
        disposed.push(entry.direction);
      },
    };
  };
}

const spec = (over = {}) => ({
  kind: 'batch',
  type: 'translate',
  translate: { v: 1, source: 'fi', target: 'en', segments: TEXTS.map((text, id) => ({ id, text })), ...over },
});

function setup(opts = {}, maxLoaded = 3) {
  const logs = [];
  const ex = createTranslateExecutor({
    manifest: async () => MANIFEST,
    engineFactory: fakeFactory(opts),
    maxLoaded,
    log: (l) => logs.push(l),
  });
  return { ex, logs };
}

function assertNoText(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const t of TEXTS) assert.ok(!s.includes(t), 'caption text leaked');
}

test('translates a batch and returns inline results keyed by id', async () => {
  const { ex, logs } = setup();
  const states = [];
  const result = await ex.run(spec(), { setState: (s) => states.push(s), progress: () => {} });
  assert.equal(result.exitCode, 0);
  const [out] = result.outputs;
  assert.equal(out.name, 'translations');
  assert.equal(out.uri, 'inline:');
  assert.deepEqual(out.data, {
    v: 1,
    model: 'fake-fi-en',
    engine: 'fake',
    translations: [{ id: 0, text: '[fi-en] 22' }, { id: 1, text: '[fi-en] 21' }],
  });
  assert.deepEqual(states, ['loading-model', 'running']);
  assertNoText(logs.join('\n'));
});

test('payload validation names fields, never content', () => {
  const cases = [
    [{ v: 2 }, 'INVALID_INPUT'],
    [{ source: 'fi', target: 'fi' }, 'UNSUPPORTED_DIRECTION'],
    [{ source: 'ru', target: 'fi' }, 'UNSUPPORTED_DIRECTION'],
    [{ segments: [] }, 'INVALID_INPUT'],
    [{ segments: Array.from({ length: 17 }, (_, id) => ({ id, text: 'a' })) }, 'INVALID_INPUT'],
    [{ segments: [{ id: 0, text: 'a' }, { id: 0, text: 'b' }] }, 'INVALID_INPUT'],
    [{ segments: [{ id: -1, text: 'a' }] }, 'INVALID_INPUT'],
    [{ segments: [{ id: 0, text: '   ' }] }, 'INVALID_INPUT'],
    [{ segments: [{ id: 0, text: 'x'.repeat(501) }] }, 'INVALID_INPUT'],
    [{ segments: Array.from({ length: 9 }, (_, id) => ({ id, text: 'x'.repeat(450) })) }, 'INVALID_INPUT'],
  ];
  for (const [over, code] of cases) {
    assert.throws(() => readPayload(spec(over)), (err) => err.code === code && !err.message.includes('xxxx'), JSON.stringify(over).slice(0, 80));
  }
  assert.throws(() => readPayload({}), { code: 'INVALID_INPUT' });
});

test('a direction without an installed model is UNSUPPORTED_DIRECTION', async () => {
  const { ex } = setup();
  await assert.rejects(ex.run(spec({ target: 'uk' })), { code: 'UNSUPPORTED_DIRECTION' });
});

test('load and inference failures have codes and no caption text', async () => {
  for (const [fail, code] of [['load', 'MODEL_UNAVAILABLE'], ['infer', 'INFERENCE_FAILED'], ['empty', 'INFERENCE_FAILED']]) {
    const { ex, logs } = setup({ fail });
    await assert.rejects(ex.run(spec()), (err) => {
      assert.equal(err.code, code);
      assertNoText(err.message);
      return true;
    });
    assertNoText(logs.join('\n'));
  }
});

test('a failed load is retried on the next job', async () => {
  const loads = [];
  let broken = true;
  const ex = createTranslateExecutor({
    manifest: async () => MANIFEST,
    engineFactory: async (entry) => {
      loads.push(entry.direction);
      if (broken) throw new Error('x');
      return fakeFactory()(entry);
    },
  });
  await assert.rejects(ex.run(spec()), { code: 'MODEL_UNAVAILABLE' });
  broken = false;
  assert.equal((await ex.run(spec())).exitCode, 0);
  assert.equal(loads.length, 2);
});

test('cancel through rt.signal stops between segments', async () => {
  const { ex } = setup({ delay: 20 });
  const controller = new AbortController();
  const many = spec({ segments: Array.from({ length: 5 }, (_, id) => ({ id, text: `s${id}` })) });
  const running = ex.run(many, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, { code: 'CANCELLED' });
  const already = new AbortController();
  already.abort();
  await assert.rejects(ex.run(spec(), { signal: already.signal }), { code: 'CANCELLED' });
});

test('loaded models are kept up to maxLoaded, least recently used unloaded first', async () => {
  const loads = [];
  const disposed = [];
  const ex = createTranslateExecutor({ manifest: async () => MANIFEST, engineFactory: fakeFactory({ loads, disposed }), maxLoaded: 2 });
  await ex.run(spec({ target: 'en' }));
  await ex.run(spec({ target: 'sv' }));
  await ex.run(spec({ target: 'en' }));
  await ex.run(spec({ source: 'en', target: 'fi' }));
  assert.deepEqual(disposed, ['fi-sv']);
  assert.deepEqual(ex.loadedDirections().sort(), ['en-fi', 'fi-en']);
  await ex.run(spec({ target: 'en' }));
  assert.deepEqual(loads, ['fi-en', 'fi-sv', 'en-fi']);
});

test('jobs of one direction run one at a time', async () => {
  let active = 0;
  let peak = 0;
  const ex = createTranslateExecutor({
    manifest: async () => MANIFEST,
    engineFactory: async (entry) => ({
      engine: 'fake',
      model: entry.model,
      async translate(texts) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return texts.map(() => 'ok');
      },
    }),
  });
  await Promise.all([ex.run(spec()), ex.run(spec()), ex.run(spec())]);
  assert.equal(peak, 1);
});

test('manifest parsing keeps allowed directions inside the model directory', () => {
  const { entries, skipped } = parseManifest(
    {
      'fi-en': { engine: 'marian-onnx', path: 'opus-mt-fi-en', revision: 'abc', licence: 'CC-BY-4.0' },
      'fi-fi': { engine: 'marian-onnx', path: 'x' },
      'ru-fi': { engine: 'marian-onnx', path: 'x' },
      'fi-sv': { engine: 'marian-onnx', path: '../outside' },
      'fi-uk': { path: 'no-engine' },
    },
    '/models',
  );
  assert.deepEqual(Object.keys(entries), ['fi-en']);
  assert.equal(entries['fi-en'].path, '/models/opus-mt-fi-en');
  assert.equal(entries['fi-en'].model, 'opus-mt-fi-en@abc');
  assert.deepEqual(skipped.sort(), ['fi-fi', 'fi-sv', 'fi-uk', 'ru-fi']);
});
