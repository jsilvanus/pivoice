import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchModels, parseArgs, resolveSource, manifestEntry, PUBLISHED_FILES } from '../scripts/fetch-models.mjs';

const SHA = (n) => n.repeat(40);
const body = (name) => Buffer.from(`fake contents of ${name}`);

/** A fake hub: repos -> { sha, license, files: { path: Buffer } }. Counts downloads. */
function fakeHub(repos, { corrupt = null } = {}) {
  const downloads = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    let m = u.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/revision\/([^/]+)$/);
    if (m) {
      const repo = repos[m[1]];
      if (!repo || (m[2] !== 'main' && m[2] !== repo.sha)) return new Response('', { status: 401 });
      return Response.json({
        sha: repo.sha,
        cardData: repo.license ? { license: repo.license } : {},
        siblings: Object.entries(repo.files).map(([rfilename, buf]) => ({
          rfilename,
          size: buf.length,
          lfs: rfilename.endsWith('.onnx') || rfilename.endsWith('.bin') ? { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') } : undefined,
        })),
      });
    }
    m = u.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
    if (m) {
      const repo = repos[m[1]];
      if (!repo || m[2] !== repo.sha || !repo.files[m[3]]) return new Response('', { status: 404 });
      downloads.push(`${m[1]}:${m[3]}`);
      const buf = corrupt === m[3] ? Buffer.from('tampered!') : repo.files[m[3]];
      return new Response(buf);
    }
    return new Response('', { status: 404 });
  };
  return { fetchFn, downloads };
}

const publishedRepo = (sha) => ({
  sha,
  files: Object.fromEntries([...PUBLISHED_FILES.required, 'special_tokens_map.json', 'README.md', 'onnx/encoder_model.onnx'].map((f) => [f, body(f)])),
});
const upstreamRepo = (sha, license = 'apache-2.0') => ({
  sha,
  license,
  files: Object.fromEntries(['config.json', 'generation_config.json', 'tokenizer_config.json', 'vocab.json', 'source.spm', 'target.spm', 'pytorch_model.bin', 'tf_model.h5'].map((f) => [f, body(f)])),
});

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'fetch-models-'));
}

test('parseArgs: defaults, directions checked against the language policy', () => {
  const o = parseArgs(['--dir', '/m']);
  assert.deepEqual(o.directions, ['fi-en']);
  assert.deepEqual(parseArgs(['--dir', '/m', '--directions', 'fi-sv, en-fi', '--revision', 'fi-sv=abc']).revisions, { 'fi-sv': 'abc' });
  assert.throws(() => parseArgs([]), /--dir/);
  assert.throws(() => parseArgs(['--dir', '/m', '--directions', 'ru-fi']), /not allowed/);
});

test('resolveSource prefers a published ONNX conversion, takes the licence from upstream', async () => {
  const { fetchFn } = fakeHub({ 'Xenova/opus-mt-fi-en': publishedRepo(SHA('a')), 'Helsinki-NLP/opus-mt-fi-en': upstreamRepo(SHA('b'), 'cc-by-4.0') });
  const s = await resolveSource('fi-en', { fetchFn, hub: 'http://hub' });
  assert.equal(s.method, 'published-onnx');
  assert.equal(s.repo, 'Xenova/opus-mt-fi-en');
  assert.equal(s.licence, 'CC-BY-4.0');
  assert.ok(!s.files.some((f) => f.path === 'README.md' || f.path === 'onnx/encoder_model.onnx'), 'only the files the engine needs');
});

test('resolveSource falls back to export of the upstream checkpoint, or null', async () => {
  const { fetchFn } = fakeHub({ 'Helsinki-NLP/opus-mt-fi-sv': upstreamRepo(SHA('c')) });
  const s = await resolveSource('fi-sv', { fetchFn, hub: 'http://hub' });
  assert.equal(s.method, 'export');
  assert.ok(s.files.some((f) => f.path === 'pytorch_model.bin'));
  assert.ok(!s.files.some((f) => f.path === 'tf_model.h5'));
  assert.equal(await resolveSource('en-uk', { fetchFn, hub: 'http://hub' }), null);
});

test('fetchModels: published direction lands complete, models.json written, rerun skips', async () => {
  const dir = await tmp();
  const hub = fakeHub({ 'Xenova/opus-mt-fi-en': publishedRepo(SHA('a')), 'Helsinki-NLP/opus-mt-fi-en': upstreamRepo(SHA('b')) });
  const lines = [];
  const opts = parseArgs(['--dir', dir, '--hub', 'http://hub']);
  const r1 = await fetchModels(opts, { fetchFn: hub.fetchFn, log: (l) => lines.push(l), now: () => new Date(0) });
  assert.deepEqual(r1.fetched, ['fi-en']);
  const json = JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8'));
  assert.deepEqual(json['fi-en'], manifestEntry({ sha: SHA('a'), repo: 'Xenova/opus-mt-fi-en', upstream: 'Helsinki-NLP/opus-mt-fi-en', method: 'published-onnx', licence: 'Apache-2.0' }, 'opus-mt-fi-en', new Date(0)));
  await stat(path.join(dir, 'opus-mt-fi-en/onnx/decoder_model_merged_quantized.onnx'));
  assert.deepEqual((await readdir(dir)).sort(), ['models.json', 'opus-mt-fi-en']);
  const before = hub.downloads.length;
  const r2 = await fetchModels(opts, { fetchFn: hub.fetchFn, log: () => {} });
  assert.deepEqual(r2.skipped, ['fi-en']);
  assert.equal(hub.downloads.length, before, 'no downloads when up to date');
  await rm(dir, { recursive: true, force: true });
});

test('fetchModels: hash mismatch fails the direction and leaves nothing behind', async () => {
  const dir = await tmp();
  const hub = fakeHub({ 'Xenova/opus-mt-fi-en': publishedRepo(SHA('a')) }, { corrupt: 'onnx/encoder_model_quantized.onnx' });
  const r = await fetchModels(parseArgs(['--dir', dir, '--hub', 'http://hub']), { fetchFn: hub.fetchFn, log: () => {} });
  assert.equal(r.failed[0].direction, 'fi-en');
  assert.match(r.failed[0].reason, /bytes|sha256/);
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('fetchModels: export direction runs the exporter on the snapshot and keeps other entries', async () => {
  const dir = await tmp();
  const hub = fakeHub({ 'Xenova/opus-mt-fi-en': publishedRepo(SHA('a')), 'Helsinki-NLP/opus-mt-fi-sv': upstreamRepo(SHA('c')) });
  const calls = [];
  const runExport = async (snapshot, out) => {
    calls.push((await readdir(snapshot)).sort());
    const { mkdir, writeFile } = await import('node:fs/promises');
    for (const f of PUBLISHED_FILES.required) {
      await mkdir(path.dirname(path.join(out, f)), { recursive: true });
      await writeFile(path.join(out, f), 'x');
    }
  };
  const r = await fetchModels(parseArgs(['--dir', dir, '--hub', 'http://hub', '--directions', 'fi-en,fi-sv,en-uk']), { fetchFn: hub.fetchFn, runExport, log: () => {} });
  assert.deepEqual(r.fetched, ['fi-en', 'fi-sv']);
  assert.deepEqual(r.unavailable, ['en-uk']);
  assert.ok(calls[0].includes('pytorch_model.bin') && calls[0].includes('source.spm'));
  const json = JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8'));
  assert.deepEqual(Object.keys(json).sort(), ['fi-en', 'fi-sv']);
  assert.equal(json['fi-sv'].method, 'export');
  assert.deepEqual((await readdir(dir)).sort(), ['models.json', 'opus-mt-fi-en', 'opus-mt-fi-sv']);
  await rm(dir, { recursive: true, force: true });
});
