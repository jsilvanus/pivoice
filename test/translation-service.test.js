import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiVoiceService } from '../src/service.js';
import { TranslationManager } from '../src/translation/manager.js';
import { fakeSpawn, jsonResponse, tempStore, waitFor } from './helpers.js';

const NOW = Date.now();

function fakeStack(calls = []) {
  return ({ config }) => {
    const router = {
      available: () => true,
      async translate(segments, { target }) {
        calls.push({ target, n: segments.length });
        return { route: 'mt', model: 'fake@1', truncated: 0, translations: new Map(segments.map((s) => [s.id, `[${target}] ${s.text}`])) };
      },
    };
    return { manager: new TranslationManager({ config, router, routes: {} }), memory: null, routes: {} };
  };
}

const transcript = (seq, text) => ({ seq, chunkSeq: 1, startMs: NOW + seq * 1000, endMs: NOW + seq * 1000 + 800, text, language: 'fi' });

test('translation off builds nothing', async () => {
  const { store } = await tempStore({});
  let built = 0;
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => NOW, createTranslationFn: () => { built++; return fakeStack()(); } });
  service.transcriber.emit('transcript', transcript(1, 'Hei'));
  assert.equal(built, 0);
  assert.equal(service.translationStatus().running, false);
  service.stop();
});

test('a transcript becomes a translation event and a relay segment with its own language', async () => {
  const { store } = await tempStore({
    captions: { relay: { mode: 'on', url: 'https://relay.example', token: 'tok' } },
    translation: { mode: 'on', targets: ['en', 'sv'] },
  });
  const posts = [];
  const fetchFn = async (url, init) => { posts.push(JSON.parse(init.body)); return jsonResponse({}); };
  const calls = [];
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn, now: () => Date.now(), createTranslationFn: fakeStack(calls) });
  const events = [];
  const unsubscribe = service.subscribe((e) => events.push(e));
  service.transcriber.emit('transcript', { ...transcript(1, 'Hyvää huomenta'), startMs: Date.now(), endMs: Date.now() + 800 });
  await waitFor(() => events.filter((e) => e.type === 'translation').length === 2, 3000);
  const en = events.find((e) => e.type === 'translation' && e.data.lang === 'en').data;
  assert.equal(en.text, '[en] Hyvää huomenta');
  assert.match(en.sourceKey, /^pivoice-[0-9a-f]{8}:1$/);
  await waitFor(() => posts.flatMap((b) => b.segments).length >= 3, 4000);
  const langs = posts.flatMap((b) => b.segments).map((s) => s.lang).sort();
  assert.deepEqual(langs, ['en', 'fi', 'sv']);
  const status = service.translationStatus();
  assert.equal(status.running, true);
  assert.equal(status.perTarget.en.sent, 1);
  assert.equal(status.perTarget.en.available, true);
  unsubscribe();
  service.stop();
});

test('a failing translation manager cannot break the original captions', async () => {
  const { store } = await tempStore({ translation: { mode: 'on' } });
  const broken = () => {
    const manager = new TranslationManager({ config: () => store.get().translation, router: { available: () => true, translate: async () => ({}) } });
    manager.handle = () => { throw new Error('boom'); };
    return { manager, memory: null, routes: {} };
  };
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => NOW, createTranslationFn: broken });
  const events = [];
  service.subscribe((e) => events.push(e));
  assert.doesNotThrow(() => service.transcriber.emit('transcript', transcript(2, 'Hei')));
  assert.equal(events.filter((e) => e.type === 'transcript').length, 1);
  service.stop();
});

test('auto runs translation only while a caption output runs', async () => {
  const { store } = await tempStore({ translation: { mode: 'auto' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn: async () => jsonResponse({}), now: () => NOW, createTranslationFn: fakeStack() });
  assert.equal(service.translationStatus().running, false);
  const { previous, current } = await store.update({ captions: { relay: { mode: 'on', url: 'https://r.example', token: 't' } } });
  service.applyConfig(previous, current);
  assert.equal(service.translationStatus().running, true);
  const off = await store.update({ captions: { relay: { mode: 'off' } } });
  service.applyConfig(off.previous, off.current);
  assert.equal(service.translationStatus().running, false);
  service.stop();
});

test('switching translation off stops the manager', async () => {
  const { store } = await tempStore({ translation: { mode: 'on' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), now: () => NOW, createTranslationFn: fakeStack() });
  assert.equal(service.translationStatus().running, true);
  const { previous, current } = await store.update({ translation: { mode: 'off' } });
  service.applyConfig(previous, current);
  assert.equal(service.translationStatus().running, false);
  assert.equal(service.translationStatus().mode, 'off');
  service.stop();
});
