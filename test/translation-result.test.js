import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslations } from '../src/translation/result.js';

const SEGMENTS = [
  { id: 0, text: 'Ensimmäinen lause.' },
  { id: 1, text: 'Toinen lause.' },
];

test('a complete answer in any order is accepted', () => {
  const { translations, truncated } = validateTranslations(SEGMENTS, [
    { id: 1, text: ' Second sentence. ' },
    { id: 0, text: 'First sentence.' },
  ]);
  assert.equal(translations.get(0), 'First sentence.');
  assert.equal(translations.get(1), 'Second sentence.');
  assert.equal(truncated, 0);
});

test('missing, duplicate, unknown ids, empty text and non-arrays are rejected', () => {
  const bad = {
    'missing id': [{ id: 0, text: 'a' }],
    'duplicate id': [{ id: 0, text: 'a' }, { id: 0, text: 'b' }],
    'unknown id': [{ id: 0, text: 'a' }, { id: 7, text: 'b' }],
    'empty text': [{ id: 0, text: 'a' }, { id: 1, text: '   ' }],
  };
  for (const [reason, answer] of Object.entries(bad)) {
    assert.throws(() => validateTranslations(SEGMENTS, answer), (err) => err.code === 'INVALID_RESULT' && err.reason === reason);
  }
  assert.throws(() => validateTranslations(SEGMENTS, null), { code: 'INVALID_RESULT' });
});

test('an echo of another segment is rejected, an echo of its own source is allowed', () => {
  assert.throws(
    () => validateTranslations(SEGMENTS, [{ id: 0, text: 'First.' }, { id: 1, text: 'Ensimmäinen lause.' }]),
    (err) => err.reason === 'echo of another segment',
  );
  const { translations } = validateTranslations([{ id: 0, text: 'Aamen.' }], [{ id: 0, text: 'Aamen.' }]);
  assert.equal(translations.get(0), 'Aamen.');
});

test('over-long text is cut to 500 characters and counted', () => {
  const { translations, truncated } = validateTranslations([{ id: 0, text: 'x' }], [{ id: 0, text: 'y'.repeat(600) }]);
  assert.equal(translations.get(0).length, 500);
  assert.equal(truncated, 1);
});
