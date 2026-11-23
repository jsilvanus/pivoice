// Runs the real marian-onnx engine only when PIVOICE_TRANSLATE_MODEL_DIR points at a fetched model
// directory (scripts/fetch-models.mjs). Without it, only the parts that need no model run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslateExecutor } from '../executor.js';
import { loadManifest, parseManifest } from '../manifest.js';
import { createEngine } from '../engines/index.js';

const MODEL_DIR = process.env.PIVOICE_TRANSLATE_MODEL_DIR;
// Invented sentences.
const TEXTS = ['Hyvää huomenta kaikille.', 'Kello lyö kaksitoista ja aasi kulkee joen yli.'];

test('manifest written by fetch-models parses (extra fields ignored)', () => {
  const { entries, skipped } = parseManifest({
    'fi-en': { engine: 'marian-onnx', path: 'opus-mt-fi-en', revision: 'a623e4812687', commit: 'a'.repeat(40), source: 'Xenova/opus-mt-fi-en', method: 'published-onnx', licence: 'Apache-2.0' },
  }, '/models');
  assert.deepEqual(skipped, []);
  assert.equal(entries['fi-en'].engine, 'marian-onnx');
  assert.equal(entries['fi-en'].model, 'opus-mt-fi-en@a623e4812687');
});

test('unknown engine is refused', async () => {
  await assert.rejects(createEngine({ engine: 'nope' }), { code: 'UNKNOWN_ENGINE' });
});

test('real model: fi-en translates through the executor', { skip: !MODEL_DIR && 'PIVOICE_TRANSLATE_MODEL_DIR not set' }, async () => {
  const manifest = await loadManifest(MODEL_DIR);
  assert.ok(manifest['fi-en'], 'models.json has no fi-en entry');
  const lines = [];
  const exec = createTranslateExecutor({
    manifest: async () => manifest,
    engineFactory: (entry) => createEngine(entry, { threads: 2 }),
    log: (line) => lines.push(typeof line === 'string' ? line : JSON.stringify(line)),
  });
  const res = await exec.run({ kind: 'batch', type: 'translate', translate: { v: 1, source: 'fi', target: 'en', segments: TEXTS.map((text, id) => ({ id, text })) } }, {});
  const segments = res.outputs[0].data.translations;
  assert.equal(res.outputs[0].data.engine, 'marian-onnx');
  assert.equal(segments.length, TEXTS.length);
  for (const [i, s] of segments.entries()) {
    assert.ok(s.text.trim().length > 0);
    assert.notEqual(s.text, TEXTS[i]);
  }
  assert.match(segments[0].text, /good morning/i);
  for (const t of TEXTS) assert.ok(!lines.join('\n').includes(t), 'caption text leaked into the log');
});
