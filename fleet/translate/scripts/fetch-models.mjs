#!/usr/bin/env node
/**
 * Fetch OPUS-MT translation models for the translate worker (plan §7.4, task T19).
 *
 *   node scripts/fetch-models.mjs --dir <model dir> [--directions fi-en,en-fi] [--force]
 *        [--revision fi-en=<commit>] [--python python3] [--hub https://huggingface.co]
 *
 * For each direction it takes, in this order:
 *   1. a published Transformers.js ONNX conversion (`Xenova/opus-mt-<src>-<tgt>`) with int8 files, or
 *   2. the original `Helsinki-NLP/opus-mt-<src>-<tgt>` checkpoint, exported and quantised by
 *      `export_marian.py` (needs Python with optimum, see that file).
 * Every file is pinned to one commit and checked against the hub's size and sha256. A direction is
 * written to a staging folder and moved into place only when complete, then `models.json` is updated
 * (other entries are kept). Run it once by hand, never from a service. Weights never go in a repository.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDirection } from '../../../src/translation/policy.js';

export const DEFAULT_HUB = 'https://huggingface.co';
/** First rollout: Finnish to English only (the rest are fetched on request with --directions). */
export const DEFAULT_DIRECTIONS = ['fi-en'];

export const PUBLISHED_FILES = Object.freeze({
  required: [
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
  optional: ['special_tokens_map.json'],
});
export const EXPORT_FILES = Object.freeze({
  required: ['config.json', 'tokenizer_config.json', 'vocab.json', 'source.spm', 'target.spm'],
  optional: ['generation_config.json', 'special_tokens_map.json'],
  weights: ['model.safetensors', 'pytorch_model.bin'],
});
/** What the engine reads; checked before an existing folder counts as complete. */
export const ENGINE_FILES = PUBLISHED_FILES.required;

const LICENCES = { 'apache-2.0': 'Apache-2.0', 'cc-by-4.0': 'CC-BY-4.0', mit: 'MIT' };

export function parseArgs(argv) {
  const opts = { dir: null, directions: DEFAULT_DIRECTIONS, force: false, revisions: {}, python: 'python3', hub: DEFAULT_HUB };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--dir') opts.dir = next();
    else if (arg === '--directions') opts.directions = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--force') opts.force = true;
    else if (arg === '--python') opts.python = next();
    else if (arg === '--hub') opts.hub = next().replace(/\/+$/, '');
    else if (arg === '--revision') {
      const [d, rev] = next().split('=');
      if (!d || !rev) throw new Error('--revision takes <direction>=<commit>');
      opts.revisions[d] = rev;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.dir) throw new Error('--dir is required');
  for (const d of opts.directions) if (!parseDirection(d)) throw new Error(`direction ${d} is not allowed by the language policy`);
  return opts;
}

async function hubJson(fetchFn, url) {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`hub answered ${res.status} for ${url}`);
  return res.json();
}

/** Model info at one revision, with per-file size and sha256 (LFS files). */
export async function modelInfo(repo, revision, { fetchFn = fetch, hub = DEFAULT_HUB } = {}) {
  const info = await hubJson(fetchFn, `${hub}/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`);
  if (!info) return null;
  const files = new Map();
  for (const s of info.siblings ?? []) {
    files.set(s.rfilename, { path: s.rfilename, size: s.lfs?.size ?? s.size ?? null, sha256: s.lfs?.sha256 ?? null });
  }
  return { repo, sha: info.sha, licence: info.cardData?.license ?? null, files };
}

function pick(files, { required, optional = [], weights = [] }) {
  if (required.some((f) => !files.has(f))) return null;
  const list = [...required, ...optional.filter((f) => files.has(f))].map((f) => files.get(f));
  if (weights.length) {
    const w = weights.find((f) => files.has(f));
    if (!w) return null;
    list.push(files.get(w));
  }
  return list;
}

/** Decide where a direction comes from. Returns null when neither source has it. */
export async function resolveSource(direction, { fetchFn = fetch, hub = DEFAULT_HUB, revision = 'main' } = {}) {
  const upstreamRepo = `Helsinki-NLP/opus-mt-${direction}`;
  const upstream = await modelInfo(upstreamRepo, 'main', { fetchFn, hub });
  const licence = normaliseLicence(upstream?.licence);

  const published = await modelInfo(`Xenova/opus-mt-${direction}`, revision, { fetchFn, hub });
  const publishedFiles = published && pick(published.files, PUBLISHED_FILES);
  if (publishedFiles) {
    return { direction, method: 'published-onnx', repo: published.repo, sha: published.sha, files: publishedFiles, upstream: upstreamRepo, licence };
  }
  if (!upstream) return null;
  const pinned = revision === 'main' ? upstream : await modelInfo(upstreamRepo, revision, { fetchFn, hub });
  const exportFiles = pinned && pick(pinned.files, EXPORT_FILES);
  if (!exportFiles) return null;
  return { direction, method: 'export', repo: upstreamRepo, sha: pinned.sha, files: exportFiles, upstream: upstreamRepo, licence };
}

export function normaliseLicence(id) {
  if (typeof id !== 'string') return null;
  return LICENCES[id.toLowerCase()] ?? id;
}

/** Download one file into `dest`, checking size and sha256 when the hub gave them. */
export async function downloadFile(source, file, dest, { fetchFn = fetch, hub = DEFAULT_HUB } = {}) {
  const url = `${hub}/${source.repo}/resolve/${source.sha}/${file.path}`;
  const res = await fetchFn(url);
  if (!res.ok || !res.body) throw new Error(`download of ${file.path} failed: ${res.status}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body;
  await pipeline(body, counter, createWriteStream(dest));
  if (file.size != null && size !== file.size) throw new Error(`${file.path}: expected ${file.size} bytes, got ${size}`);
  const digest = hash.digest('hex');
  if (file.sha256 && digest !== file.sha256) throw new Error(`${file.path}: sha256 mismatch`);
  return { path: file.path, size, sha256: digest };
}

export function runPython(python, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: 'inherit' });
    child.on('error', (err) =>
      reject(err.code === 'ENOENT'
        ? new Error(`this direction has no published ONNX conversion and needs export, but ${python} was not found (see fleet/translate/README.md, "Exporting a model")`)
        : err));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${python} ${path.basename(args[0])} exited with ${code}`))));
  });
}

async function readModelsJson(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeModelsJson(dir, json) {
  const tmp = path.join(dir, `.models.json.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`);
  await rename(tmp, path.join(dir, 'models.json'));
}

async function complete(folder) {
  for (const f of ENGINE_FILES) {
    try {
      await stat(path.join(folder, f));
    } catch {
      return false;
    }
  }
  return true;
}

export function manifestEntry(source, folderName, now = new Date()) {
  return {
    engine: 'marian-onnx',
    path: folderName,
    revision: source.sha.slice(0, 12),
    commit: source.sha,
    source: source.repo,
    upstream: source.upstream,
    method: source.method,
    licence: source.licence,
    attribution: `${source.upstream} (Language Technology Research Group at the University of Helsinki, OPUS-MT)`,
    fetchedAt: now.toISOString(),
  };
}

/**
 * Fetch every direction. `log` gets one line per step; nothing else is printed.
 * @returns {Promise<{ fetched: string[], skipped: string[], unavailable: string[], failed: Array<{direction:string, reason:string}> }>}
 */
export async function fetchModels(opts, { fetchFn = fetch, runExport = null, log = (line) => console.error(line), now = () => new Date() } = {}) {
  const dir = path.resolve(opts.dir);
  await mkdir(dir, { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exportFn = runExport ?? ((snapshot, out) => runPython(opts.python, [path.join(here, 'export_marian.py'), snapshot, out]));
  const result = { fetched: [], skipped: [], unavailable: [], failed: [] };

  for (const direction of opts.directions) {
    const folderName = `opus-mt-${direction}`;
    const folder = path.join(dir, folderName);
    const staging = path.join(dir, `.staging-${folderName}`);
    const snapshot = path.join(dir, `.snapshot-${folderName}`);
    try {
      const source = await resolveSource(direction, { fetchFn, hub: opts.hub, revision: opts.revisions[direction] ?? 'main' });
      if (!source) {
        log(`${direction}: no OPUS-MT model on the hub, not fetched`);
        result.unavailable.push(direction);
        continue;
      }
      const manifest = await readModelsJson(dir);
      if (!opts.force && manifest[direction]?.commit === source.sha && (await complete(folder))) {
        log(`${direction}: up to date (${source.repo}@${source.sha.slice(0, 12)})`);
        result.skipped.push(direction);
        continue;
      }
      await rm(staging, { recursive: true, force: true });
      await rm(snapshot, { recursive: true, force: true });
      const target = source.method === 'export' ? snapshot : staging;
      log(`${direction}: ${source.method} from ${source.repo}@${source.sha.slice(0, 12)}, ${source.files.length} files`);
      for (const file of source.files) await downloadFile(source, file, path.join(target, file.path), { fetchFn, hub: opts.hub });
      if (source.method === 'export') {
        log(`${direction}: exporting to ONNX and quantising (Python)`);
        await exportFn(snapshot, staging);
        await rm(snapshot, { recursive: true, force: true });
      }
      if (!(await complete(staging))) throw new Error('engine files missing after fetch');
      await rm(folder, { recursive: true, force: true });
      await rename(staging, folder);
      const latest = await readModelsJson(dir);
      latest[direction] = manifestEntry(source, folderName, now());
      await writeModelsJson(dir, latest);
      log(`${direction}: ready (${latest[direction].licence ?? 'licence unknown'})`);
      result.fetched.push(direction);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(snapshot, { recursive: true, force: true }).catch(() => {});
      log(`${direction}: failed: ${err.message}`);
      result.failed.push({ direction, reason: err.message });
    }
  }
  return result;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`fetch-models: ${err.message}`);
    console.error('usage: node scripts/fetch-models.mjs --dir <model dir> [--directions fi-en,en-fi] [--force] [--revision fi-en=<commit>] [--python python3]');
    process.exit(2);
  }
  const result = await fetchModels(opts);
  console.error(`fetch-models: fetched ${result.fetched.length}, up to date ${result.skipped.length}, unavailable ${result.unavailable.length}, failed ${result.failed.length}`);
  process.exit(result.failed.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
