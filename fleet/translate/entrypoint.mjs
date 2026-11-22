#!/usr/bin/env node
/**
 * Container entrypoint of the translate worker (plan §7.2).
 *
 * fffleet executors cannot report capabilities themselves, so this script loads every model in
 * models.json once, translates one invented sentence, and starts fffleet-worker with
 * FFFLEET_CAPABILITIES extended by `translate:<src>-<tgt>` for each model that passed.
 * A model change needs a restart of the container.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadManifest } from './manifest.js';
import { createEngine } from './engines/index.js';

/** Invented probe sentences, one per source language. */
export const PROBES = Object.freeze({
  fi: 'Hyvää huomenta kaikille.',
  en: 'Good morning, everyone.',
  sv: 'God morgon allihopa.',
});

/**
 * @returns {Promise<{ capabilities: string[], passed: string[], failed: Array<{direction:string, reason:string}> }>}
 */
export async function scanCapabilities(entries, engineFactory, { timeoutMs = 120_000 } = {}) {
  const passed = [];
  const failed = [];
  for (const entry of Object.values(entries)) {
    const probe = PROBES[entry.source];
    let engine = null;
    try {
      engine = await withTimeout(Promise.resolve().then(() => engineFactory(entry)), timeoutMs);
      const [text] = await withTimeout(engine.translate([probe]), timeoutMs);
      const out = typeof text === 'string' ? text.trim() : '';
      if (!out) failed.push({ direction: entry.direction, reason: 'empty output' });
      else if (out === probe) failed.push({ direction: entry.direction, reason: 'output equals input' });
      else passed.push(entry.direction);
    } catch (err) {
      failed.push({ direction: entry.direction, reason: err?.code === 'TIMEOUT' ? 'timeout' : 'load or inference failed' });
    } finally {
      await engine?.dispose?.().catch(() => {});
    }
  }
  passed.sort();
  return { capabilities: passed.map((d) => `translate:${d}`), passed, failed };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** FFFLEET_CAPABILITIES with the translate capabilities added (existing entries kept). */
export function mergeCapabilities(existing, added) {
  const list = String(existing ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...list.filter((c) => !c.startsWith('translate:')), ...added])].join(',');
}

async function main() {
  const modelDir = process.env.TRANSLATE_MODEL_DIR;
  let entries = {};
  try {
    entries = await loadManifest(modelDir);
  } catch (err) {
    console.error(`translate-worker: no usable models.json in TRANSLATE_MODEL_DIR (${err.code ?? err.message}); starting without translate capabilities`);
  }
  const threads = Number(process.env.TRANSLATE_THREADS) || 2;
  const { capabilities, passed, failed } = await scanCapabilities(entries, (entry) => createEngine(entry, { threads }));
  console.error(`translate-worker: directions ready: ${passed.join(', ') || 'none'}`);
  for (const f of failed) console.error(`translate-worker: ${f.direction} not offered: ${f.reason}`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = {
    ...process.env,
    FFFLEET_CAPABILITIES: mergeCapabilities(process.env.FFFLEET_CAPABILITIES, capabilities),
    FFFLEET_EXECUTORS: [process.env.FFFLEET_EXECUTORS, path.join(here, 'executor.js')].filter(Boolean).join(','),
  };
  const bin = process.env.FFFLEET_WORKER_BIN || 'fffleet-worker';
  const child = spawn(bin, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
