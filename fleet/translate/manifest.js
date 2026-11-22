import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDirection } from '../../src/translation/policy.js';

/**
 * Reads `models.json` from the model directory (outside the repository):
 * { "fi-en": { "engine": "marian-onnx", "path": "opus-mt-fi-en", "revision": "...", "licence": "CC-BY-4.0" } }
 * Entries for directions the policy does not allow, or with a path outside the directory, are dropped.
 */
export function parseManifest(json, modelDir) {
  const out = {};
  const skipped = [];
  const root = path.resolve(modelDir);
  for (const [key, entry] of Object.entries(json && typeof json === 'object' ? json : {})) {
    const direction = parseDirection(key);
    const rel = typeof entry?.path === 'string' ? entry.path : null;
    const full = rel ? path.resolve(root, rel) : null;
    if (!direction || typeof entry?.engine !== 'string' || !full || !full.startsWith(root + path.sep)) {
      skipped.push(key);
      continue;
    }
    out[key] = {
      direction: key,
      source: direction.source,
      target: direction.target,
      engine: entry.engine,
      path: full,
      revision: typeof entry.revision === 'string' ? entry.revision : null,
      licence: typeof entry.licence === 'string' ? entry.licence : null,
      model: `${path.basename(full)}${entry.revision ? `@${entry.revision}` : ''}`,
    };
  }
  return { entries: out, skipped };
}

export async function loadManifest(modelDir, { readFileFn = readFile } = {}) {
  if (!modelDir) throw new Error('TRANSLATE_MODEL_DIR is not set');
  const raw = await readFileFn(path.join(modelDir, 'models.json'), 'utf8');
  return parseManifest(JSON.parse(raw), modelDir).entries;
}
