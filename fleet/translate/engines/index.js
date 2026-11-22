/**
 * Engine registry. An engine is `{ engine, model, translate(texts, { signal }) -> texts, dispose?() }`.
 * Engines with heavy runtimes are imported only when a manifest entry asks for them.
 */
const ENGINES = {
  // Added with T14 (marian-onnx, @huggingface/transformers).
  'marian-onnx': () => import('./marian-onnx.js'),
};

export async function createEngine(entry, options = {}) {
  const load = ENGINES[entry.engine];
  if (!load) throw Object.assign(new Error(`unknown engine ${entry.engine}`), { code: 'UNKNOWN_ENGINE' });
  const mod = await load();
  return mod.createEngine(entry, options);
}
