import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedDirections, baseLanguage, capability, directionAllowed, parseDirection, ROLLOUT_TARGETS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
} from '../src/translation/policy.js';

test('the allowed table is exactly fi/en/sv into the six targets, never into itself', () => {
  const got = allowedDirections().map(({ source, target }) => `${source}-${target}`).sort();
  const want = [];
  for (const s of ['fi', 'en', 'sv']) for (const t of ['fi', 'en', 'sv', 'ru', 'uk', 'es']) if (s !== t) want.push(`${s}-${t}`);
  assert.deepEqual(got, want.sort());
  assert.equal(got.length, 15);
  assert.deepEqual([...SOURCE_LANGUAGES], ['fi', 'en', 'sv']);
  assert.deepEqual([...TARGET_LANGUAGES], ['fi', 'en', 'sv', 'ru', 'uk', 'es']);
});

test('same-language, unsupported sources and unknown targets are refused', () => {
  assert.equal(directionAllowed('fi', 'fi'), false);
  assert.equal(directionAllowed('ru', 'fi'), false);
  assert.equal(directionAllowed('uk', 'en'), false);
  assert.equal(directionAllowed('fi', 'de'), false);
  assert.equal(directionAllowed('fi', null), false);
  assert.equal(directionAllowed('fi-FI', 'en'), true);
  assert.equal(directionAllowed('sv', 'uk'), true);
});

test('capability names and parsing', () => {
  assert.equal(capability('fi', 'en'), 'translate:fi-en');
  assert.equal(capability('sv-FI', 'uk'), 'translate:sv-uk');
  assert.deepEqual(parseDirection('translate:fi-en'), { source: 'fi', target: 'en' });
  assert.deepEqual(parseDirection('en-sv'), { source: 'en', target: 'sv' });
  assert.equal(parseDirection('translate:fi-fi'), null);
  assert.equal(parseDirection('translate:ru-fi'), null);
  assert.equal(parseDirection('filter:ass'), null);
  assert.equal(baseLanguage('not a tag!'), null);
});

test('Spanish is in the policy but not in the first rollout', () => {
  assert.ok(TARGET_LANGUAGES.includes('es'));
  assert.ok(!ROLLOUT_TARGETS.includes('es'));
  assert.deepEqual([...ROLLOUT_TARGETS], ['fi', 'en', 'sv', 'ru', 'uk']);
});
