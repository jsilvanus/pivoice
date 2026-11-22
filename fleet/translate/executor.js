/**
 * fffleet executor for job type "translate" (docs/translations/plan.md §6, §7.3).
 *
 * Enable on a worker with FFFLEET_EXECUTORS=<path>/fleet/translate/executor.js. The worker translates
 * the segments of one direction with a locally installed model. It keeps no caption state and never
 * logs or returns caption text in errors.
 *
 * spec.translate = { v: 1, source, target, segments: [{ id, text }] }
 * result output "translations" (inline): { v: 1, model, engine, translations: [{ id, text }] }
 */
import { directionAllowed, directionKey } from '../../src/translation/policy.js';
import { loadManifest } from './manifest.js';
import { createEngine } from './engines/index.js';

export const LIMITS = Object.freeze({ maxSegments: 16, maxSegmentChars: 500, maxJobChars: 4000 });

export function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Validates the payload; messages name fields, never their content. */
export function readPayload(spec) {
  const p = spec?.translate;
  if (!p || typeof p !== 'object') throw fail('INVALID_INPUT', 'spec.translate is required');
  if (p.v !== 1) throw fail('INVALID_INPUT', 'spec.translate.v must be 1');
  if (!directionAllowed(p.source, p.target)) throw fail('UNSUPPORTED_DIRECTION', 'direction is not allowed by the language policy');
  const segments = p.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > LIMITS.maxSegments) {
    throw fail('INVALID_INPUT', `segments must hold 1 to ${LIMITS.maxSegments} items`);
  }
  const ids = new Set();
  let chars = 0;
  for (const [index, s] of segments.entries()) {
    if (!Number.isInteger(s?.id) || s.id < 0) throw fail('INVALID_INPUT', `segments[${index}].id must be a non-negative integer`);
    if (ids.has(s.id)) throw fail('INVALID_INPUT', `segments[${index}].id is a duplicate`);
    ids.add(s.id);
    if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > LIMITS.maxSegmentChars) {
      throw fail('INVALID_INPUT', `segments[${index}].text must be 1 to ${LIMITS.maxSegmentChars} characters`);
    }
    chars += s.text.length;
  }
  if (chars > LIMITS.maxJobChars) throw fail('INVALID_INPUT', `segments exceed ${LIMITS.maxJobChars} characters`);
  return { source: p.source.slice(0, 2), target: p.target.slice(0, 2), direction: directionKey(p.source, p.target), segments };
}

/**
 * @param {object} opts
 * @param {() => Promise<Record<string, object>>} opts.manifest   direction -> manifest entry
 * @param {(entry: object) => Promise<{ translate(texts: string[], o: {signal?: AbortSignal}): Promise<string[]>, dispose?(): Promise<void>, model: string, engine: string }>} opts.engineFactory
 * @param {number} [opts.maxLoaded]  engines kept loaded (least recently used is unloaded first)
 * @param {(line: string) => void} [opts.log]  receives counts and timings only
 */
export function createTranslateExecutor({ manifest, engineFactory, maxLoaded = 3, log = () => {}, now = () => performance.now() }) {
  /** direction -> { promise, lastUsed, chain } */
  const loaded = new Map();
  let manifestPromise = null;

  async function entryFor(direction) {
    manifestPromise ??= Promise.resolve().then(manifest);
    const entries = await manifestPromise.catch(() => {
      manifestPromise = null;
      throw fail('MODEL_UNAVAILABLE', 'model manifest could not be read');
    });
    const entry = entries[direction];
    if (!entry) throw fail('UNSUPPORTED_DIRECTION', `no model installed for ${direction}`);
    return entry;
  }

  async function evict() {
    while (loaded.size > maxLoaded) {
      const [oldest] = [...loaded.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      loaded.delete(oldest[0]);
      const engine = await oldest[1].promise.catch(() => null);
      await oldest[1].chain; // let running inference finish before unloading
      await engine?.dispose?.().catch(() => {});
      log(`translate: unloaded ${oldest[0]}`);
    }
  }

  async function engineFor(direction, rt) {
    let slot = loaded.get(direction);
    if (!slot) {
      // The slot is registered before any await, so concurrent jobs of one direction share it.
      const started = now();
      slot = {
        lastUsed: started,
        chain: Promise.resolve(),
        promise: entryFor(direction).then(async (entry) => {
          rt?.setState?.('loading-model');
          const engine = await Promise.resolve()
            .then(() => engineFactory(entry))
            .catch(() => {
              throw fail('MODEL_UNAVAILABLE', `model for ${direction} could not be loaded`);
            });
          log(`translate: loaded ${direction} in ${Math.round(now() - started)} ms`);
          return engine;
        }),
      };
      loaded.set(direction, slot);
      const current = slot;
      current.promise.catch(() => {
        if (loaded.get(direction) === current) loaded.delete(direction);
      });
      await evict();
    }
    slot.lastUsed = now();
    return { slot, engine: await slot.promise };
  }

  async function run(spec, rt = {}) {
    const { direction, segments } = readPayload(spec);
    const signal = rt.signal;
    if (signal?.aborted) throw fail('CANCELLED', 'job was cancelled');
    const { slot, engine } = await engineFor(direction, rt);
    rt.setState?.('running');
    const started = now();
    // One inference at a time per model: queue behind earlier jobs of the same direction.
    const work = slot.chain.then(async () => {
      const out = [];
      for (const s of segments) {
        if (signal?.aborted) throw fail('CANCELLED', 'job was cancelled');
        let texts;
        try {
          texts = await engine.translate([s.text], { signal });
        } catch (err) {
          if (signal?.aborted) throw fail('CANCELLED', 'job was cancelled');
          throw fail('INFERENCE_FAILED', `inference failed (${err?.code ?? err?.name ?? 'error'})`);
        }
        const text = Array.isArray(texts) && typeof texts[0] === 'string' ? texts[0].trim() : '';
        if (!text) throw fail('INFERENCE_FAILED', 'engine returned no text');
        out.push({ id: s.id, text });
        rt.progress?.(out.length / segments.length);
      }
      return out;
    });
    slot.chain = work.catch(() => {});
    const translations = await work;
    const chars = segments.reduce((n, s) => n + s.text.length, 0);
    log(`translate: ${direction} ${segments.length} segments ${chars} chars in ${Math.round(now() - started)} ms`);
    const data = { v: 1, model: engine.model, engine: engine.engine, translations };
    return {
      exitCode: 0,
      outputs: [{ name: 'translations', uri: 'inline:', bytes: Buffer.byteLength(JSON.stringify(data)), data }],
      stderrTail: null,
    };
  }

  return { type: 'translate', run, loadedDirections: () => [...loaded.keys()] };
}

/** The worker's default executor: models from TRANSLATE_MODEL_DIR, engines from ./engines. */
const executor = createTranslateExecutor({
  manifest: () => loadManifest(process.env.TRANSLATE_MODEL_DIR),
  engineFactory: (entry) => createEngine(entry, { threads: Number(process.env.TRANSLATE_THREADS) || 2 }),
  maxLoaded: Number(process.env.TRANSLATE_MAX_LOADED) || 3,
  log: (line) => process.stderr.write(`${line}\n`),
});

export default { type: executor.type, run: executor.run };
