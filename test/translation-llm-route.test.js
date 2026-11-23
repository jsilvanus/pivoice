import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmRoute } from '../src/translation/routes/llm.js';
import { createRouter } from '../src/translation/router.js';

const SEGMENTS = [
  { id: 0, text: 'Herra olkoon teidän kanssanne.', endMs: Date.now() },
  { id: 1, text: 'Ja myös sinun henkesi kanssa.', endMs: Date.now() },
];

function fakeOllama({ models = [{ name: 'qwen2.5:3b' }], answer, status = 200, delayMs = 0 } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models }) };
    return { ok: status === 200, status, json: async () => ({ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }) };
  };
  return { fetchFn, calls };
}

const GOOD = { translations: [{ id: 0, text: 'The Lord be with you.' }, { id: 1, text: 'And also with you.' }] };

test('availability follows /api/tags and the policy', async () => {
  const { fetchFn, calls } = fakeOllama();
  const route = createLlmRoute({ url: 'http://pc:11434/', fetchFn });
  assert.equal(route.available('fi', 'en'), false);
  await route.refresh();
  assert.equal(calls[0].url, 'http://pc:11434/api/tags');
  assert.equal(route.available('fi', 'en'), true);
  assert.equal(route.available('ru', 'en'), false);
  const other = createLlmRoute({ url: 'http://pc:11434', model: 'missing', fetchFn });
  await other.refresh();
  assert.equal(other.available('fi', 'en'), false);
});

test('unreachable ollama makes the route unavailable', async () => {
  const route = createLlmRoute({ url: 'http://pc:11434', fetchFn: async () => { throw new Error('down'); } });
  assert.equal(await route.refresh(), false);
  assert.equal(route.available('fi', 'en'), false);
});

test('the prompt names the direction, glossary and context; the answer is parsed', async () => {
  const { fetchFn, calls } = fakeOllama({ answer: GOOD });
  const route = createLlmRoute({ url: 'http://pc:11434', fetchFn, glossary: () => [{ source: 'seurakunta', target: 'congregation' }] });
  await route.refresh();
  const answer = await route.translate(SEGMENTS, { source: 'fi', target: 'en', context: ['a', 'b', 'previous line'] });
  const chat = calls.find((c) => c.url.endsWith('/api/chat'));
  const body = JSON.parse(chat.init.body);
  assert.equal(body.format, 'json');
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, '30s');
  const text = body.messages.map((m) => m.content).join('\n');
  assert.match(text, /Finnish to English/);
  assert.match(text, /seurakunta => congregation/);
  assert.match(text, /previous line/);
  assert.doesNotMatch(text, /- a\n/);
  assert.match(text, /0: Herra olkoon/);
  assert.deepEqual(answer.translations, GOOD.translations);
  assert.equal(answer.model, 'ollama:qwen2.5:3b');
});

test('non-JSON and wrong ids are rejected (the router validates)', async () => {
  const bad = fakeOllama({ answer: 'not json' });
  const route = createLlmRoute({ url: 'http://pc:11434', fetchFn: bad.fetchFn });
  await route.refresh();
  await assert.rejects(route.translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'INVALID_RESULT' });

  const wrong = fakeOllama({ answer: { translations: [{ id: 7, text: 'x' }, { id: 0, text: 'y' }] } });
  const route2 = createLlmRoute({ url: 'http://pc:11434', fetchFn: wrong.fetchFn });
  await route2.refresh();
  const router = createRouter({ routes: { llm: route2 }, chainFor: () => ['llm'], maxAgeMs: 60_000 });
  await assert.rejects(router.translate(SEGMENTS.map((s) => ({ ...s, endMs: Date.now() })), { source: 'fi', target: 'en' }), { code: 'INVALID_RESULT' });
});

test('a slow model times out and aborts the request', async () => {
  const { fetchFn } = fakeOllama({ answer: GOOD, delayMs: 200 });
  const fast = createLlmRoute({
    url: 'http://pc:11434',
    timeoutMs: 20,
    fetchFn: async (url, init) => (url.endsWith('/api/tags') ? { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) } : fetchFn(url, init)),
  });
  await fast.refresh();
  await assert.rejects(fast.translate(SEGMENTS, { source: 'fi', target: 'en' }), { code: 'TIMEOUT' });
});

test('HTTP errors map to ROUTE_UNAVAILABLE and caption text stays out of errors and logs', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    const { fetchFn } = fakeOllama({ answer: GOOD, status: 500 });
    const route = createLlmRoute({ url: 'http://pc:11434', fetchFn });
    await route.refresh();
    const err = await route.translate(SEGMENTS, { source: 'fi', target: 'en' }).catch((e) => e);
    assert.equal(err.code, 'ROUTE_UNAVAILABLE');
    assert.doesNotMatch(err.message, /Herra/);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!lines.join('\n').includes('Herra'));
});

test('requests run one at a time', async () => {
  let active = 0;
  let peak = 0;
  const fetchFn = async (url) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) };
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(GOOD) } }) };
  };
  const route = createLlmRoute({ url: 'http://pc:11434', fetchFn });
  await route.refresh();
  await Promise.all([route.translate(SEGMENTS, { source: 'fi', target: 'en' }), route.translate(SEGMENTS, { source: 'fi', target: 'en' })]);
  assert.equal(peak, 1);
});
