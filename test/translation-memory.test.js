import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, TranslationMemory } from '../src/translation/memory.js';

// Invented texts only; no real liturgy in the repository.
const ENTRIES = [
  { src: 'fi', text: 'Kello lyö kaksitoista.', tr: { en: 'The clock strikes twelve.', sv: 'Klockan slår tolv.' } },
  { src: 'sv', text: 'Åsnan går över ån.', tr: { fi: 'Aasi kulkee joen yli.' } },
];

test('normalisation folds case, spaces and punctuation and keeps Nordic and Cyrillic letters', () => {
  assert.equal(normalizeText('  Kello   LYÖ, kaksitoista! '), 'kello lyö kaksitoista');
  assert.equal(normalizeText('Åsnan går över ån.'), 'åsnan går över ån');
  assert.equal(normalizeText('Привет, мир!'), 'привет мир');
  assert.notEqual(normalizeText('lyö'), normalizeText('lyo'));
});

test('exact match after normalisation; no fuzzy hits', () => {
  const memory = new TranslationMemory();
  memory.load(ENTRIES);
  assert.equal(memory.lookup('fi', 'en', 'kello lyö kaksitoista'), 'The clock strikes twelve.');
  assert.equal(memory.lookup('fi', 'sv', 'Kello lyö kaksitoista!!'), 'Klockan slår tolv.');
  assert.equal(memory.lookup('sv', 'fi', 'ÅSNAN går över ån'), 'Aasi kulkee joen yli.');
  assert.equal(memory.lookup('fi', 'en', 'Kello lyö kolmetoista.'), null);
  assert.equal(memory.lookup('fi', 'en', 'Kello lyö'), null);
  assert.equal(memory.lookup('fi', 'uk', 'Kello lyö kaksitoista.'), null);
  assert.equal(memory.lookup('en', 'fi', 'Kello lyö kaksitoista.'), null);
  assert.equal(memory.status().hits, 3);
});

test('invalid entries are skipped; load replaces everything', () => {
  const memory = new TranslationMemory();
  assert.deepEqual(memory.load([...ENTRIES, { src: 'xx!', text: 'a', tr: {} }, { src: 'fi', text: '', tr: { en: 'x' } }, null]), { entries: 2, skipped: 3 });
  memory.load([{ src: 'fi', text: 'Uusi.', tr: { en: 'New.' } }]);
  assert.equal(memory.size, 1);
  assert.equal(memory.lookup('fi', 'en', 'Kello lyö kaksitoista.'), null);
  assert.equal(memory.lookup('fi', 'en', 'uusi'), 'New.');
});

test('reload reads the file; a missing file is an empty memory, a broken file keeps the old one', async () => {
  const files = { '/m.json': JSON.stringify(ENTRIES) };
  const readFileFn = async (p) => {
    if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return files[p];
  };
  const memory = new TranslationMemory({ path: '/m.json', readFileFn });
  await memory.reload();
  assert.equal(memory.size, 2);
  files['/m.json'] = '{ not json "Kello lyö"';
  const broken = await memory.reload();
  assert.equal(memory.size, 2);
  assert.ok(!broken.error.includes('Kello'));
  delete files['/m.json'];
  await memory.reload();
  assert.equal(memory.size, 0);
  assert.equal((await new TranslationMemory().reload()).entries, 0);
});
