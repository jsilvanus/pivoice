import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, mergeConfig, redactConfig } from '../src/config.js';
import { enabledDirections, routeChain } from '../src/translation/config.js';

test('translation is off by default with local-only routing', () => {
  const t = configSchema.parse({}).translation;
  assert.equal(t.mode, 'off');
  assert.deepEqual(t.targets, ['en']);
  assert.deepEqual(t.routes, { default: ['mt'] });
  assert.equal(t.hosted.enabled, false);
  assert.equal(t.hosted.provider, 'google');
  assert.deepEqual(t.fleet.workerPreference, ['operator-pc-translate']);
  assert.equal(t.batch.windowMs, 300);
  assert.equal(t.maxAgeMs, 60_000);
  assert.equal(t.queueTimeoutMs, 3000);
  assert.deepEqual(t.publish, { events: true, relay: true, gateway: false });
});

test('invalid targets, routes and chains are rejected', () => {
  const bad = [
    { targets: ['de'] },
    { targets: ['en', 'en'] },
    { routes: { default: ['cloud'] } },
    { routes: { default: ['mt', 'mt'] } },
    { routes: { 'fi-fi': ['mt'] } },
    { routes: { 'ru-fi': ['mt'] } },
    { hosted: { provider: 'openai' } },
    { fleet: { url: 'ftp://x' } },
  ];
  for (const translation of bad) assert.throws(() => configSchema.parse({ translation }), JSON.stringify(translation));
});

test('no secret is accepted in the translation config', () => {
  const parsed = configSchema.parse({ translation: { hosted: { apiKey: 'k', key: 'k' }, fleet: { clientSecret: 's' } } });
  assert.equal(JSON.stringify(parsed).includes('"k"'), false);
  assert.equal(JSON.stringify(parsed).includes('"s"'), false);
});

test('patches merge; a direction chain overrides the default', () => {
  const current = configSchema.parse({});
  const next = mergeConfig(current, { translation: { mode: 'on', targets: ['en', 'sv', 'uk'], routes: { 'fi-uk': ['mt', 'llm'] } } });
  assert.equal(next.translation.mode, 'on');
  assert.deepEqual(routeChain(next.translation, 'fi', 'uk'), ['mt', 'llm']);
  assert.deepEqual(routeChain(next.translation, 'fi', 'en'), ['mt']);
  assert.equal(redactConfig(next).translation.mode, 'on');
});

test('enabled directions skip the target equal to the source', () => {
  const t = configSchema.parse({ translation: { targets: ['fi', 'en', 'sv'] } }).translation;
  assert.deepEqual(enabledDirections(t, 'fi').map((d) => d.target), ['en', 'sv']);
  assert.deepEqual(enabledDirections(t, 'sv').map((d) => d.target), ['fi', 'en']);
  assert.deepEqual(enabledDirections(t, 'ru'), []);
});
