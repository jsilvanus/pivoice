import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCapabilities, PROBES, scanCapabilities } from '../entrypoint.mjs';

const entry = (direction, extra = {}) => ({ direction, source: direction.slice(0, 2), target: direction.slice(3), engine: 'fake', model: direction, ...extra });

test('passing models become capabilities, failing ones are left out with a reason', async () => {
  const disposed = [];
  const factory = async (e) => {
    if (e.broken === 'load') throw new Error('no files');
    return {
      async translate(texts) {
        if (e.broken === 'echo') return texts;
        if (e.broken === 'empty') return [' '];
        return texts.map((t) => `${e.direction}:${t.length}`);
      },
      async dispose() {
        disposed.push(e.direction);
      },
    };
  };
  const entries = {
    'fi-en': entry('fi-en'),
    'sv-fi': entry('sv-fi'),
    'fi-sv': entry('fi-sv', { broken: 'load' }),
    'en-fi': entry('en-fi', { broken: 'echo' }),
    'fi-uk': entry('fi-uk', { broken: 'empty' }),
  };
  const result = await scanCapabilities(entries, factory);
  assert.deepEqual(result.capabilities, ['translate:fi-en', 'translate:sv-fi']);
  assert.deepEqual(result.failed.map((f) => [f.direction, f.reason]), [
    ['fi-sv', 'load or inference failed'],
    ['en-fi', 'output equals input'],
    ['fi-uk', 'empty output'],
  ]);
  assert.deepEqual(disposed.sort(), ['en-fi', 'fi-en', 'fi-uk', 'sv-fi']);
});

test('an empty manifest starts with no translate capabilities', async () => {
  assert.deepEqual((await scanCapabilities({}, async () => ({}))).capabilities, []);
});

test('a hanging model times out', async () => {
  const result = await scanCapabilities({ 'fi-en': entry('fi-en') }, () => new Promise(() => {}), { timeoutMs: 20 });
  assert.deepEqual(result.failed, [{ direction: 'fi-en', reason: 'timeout' }]);
});

test('capabilities merge keeps other entries and replaces old translate ones', () => {
  assert.equal(mergeCapabilities('net:mediamtx, translate:fi-sv', ['translate:fi-en']), 'net:mediamtx,translate:fi-en');
  assert.equal(mergeCapabilities(undefined, []), '');
  assert.ok(PROBES.fi && PROBES.en && PROBES.sv);
});
