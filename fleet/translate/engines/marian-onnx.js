/**
 * MarianMT (OPUS-MT) through Transformers.js and ONNX Runtime on the CPU (plan §7.4).
 *
 * The model directory is a Transformers.js-style export (config.json, tokenizer files, onnx/
 * encoder_model*.onnx and decoder_model_merged*.onnx). Models are never downloaded here:
 * remote loading is switched off, so a missing file fails instead of fetching.
 *
 * UNVERIFIED: not yet run against a real exported OPUS-MT model (plan phase 1 measures it).
 */
import path from 'node:path';

export async function createEngine(entry, { threads = 2, dtype = 'q8' } = {}) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(entry.path) + path.sep;
  const translator = await pipeline('translation', path.basename(entry.path), {
    dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  return {
    engine: 'marian-onnx',
    model: entry.model,
    async translate(texts) {
      const out = [];
      for (const text of texts) {
        const [result] = await translator(text, { max_new_tokens: 256 });
        out.push(result?.translation_text ?? '');
      }
      return out;
    },
    async dispose() {
      await translator.dispose?.();
    },
  };
}
