import { createFleet } from 'fffleet';
import { routeChain } from './config.js';
import { TranslationManager } from './manager.js';
import { TranslationMemory } from './memory.js';
import { createRouter } from './router.js';
import { createMtRoute } from './routes/mt.js';

/**
 * Builds the translation stack from the `translation` config block (plan §5, §8.1). Only the mt
 * route exists so far (local mode first). Secrets come from the environment only:
 * FFFLEET_CLIENT_ID + FFFLEET_CLIENT_SECRET, or FFFLEET_TOKEN.
 *
 * Nothing here starts a timer or a connection: the manager polls only after `start()`.
 */
export function createTranslation({ config, env = process.env, fetchFn = globalThis.fetch, createFleetFn = createFleet }) {
  const cfg = config();
  const fleetUrl = cfg.fleet.url ?? env.PIVOICE_FFFLEET_URL ?? null;
  const routes = {};
  if (fleetUrl) {
    const fleet = createFleetFn({
      url: fleetUrl,
      clientId: env.FFFLEET_CLIENT_ID || undefined,
      clientSecret: env.FFFLEET_CLIENT_SECRET || undefined,
      token: env.FFFLEET_TOKEN || undefined,
      scope: 'jobs',
      // The Pi never translates itself (plan §6.1).
      fallback: 'none',
      fetch: fetchFn,
    });
    routes.mt = createMtRoute({
      fleet,
      workerPreference: cfg.fleet.workerPreference,
      jobTimeoutMs: cfg.jobTimeoutMs,
      queueTimeoutMs: cfg.queueTimeoutMs,
    });
  }
  const router = createRouter({
    routes,
    chainFor: (source, target) => routeChain(config(), source, target),
    maxAgeMs: cfg.maxAgeMs,
  });
  const memory = new TranslationMemory({ path: cfg.memoryPath });
  const manager = new TranslationManager({ config, router, memory, routes });
  return { manager, memory, routes };
}
