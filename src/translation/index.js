import { createFleet } from 'fffleet';
import { routeChain } from './config.js';
import { TranslationManager } from './manager.js';
import { TranslationMemory } from './memory.js';
import { GatewayTranslations } from './gateway-publisher.js';
import { createRouter } from './router.js';
import { createLlmRoute } from './routes/llm.js';
import { createMtRoute } from './routes/mt.js';

/**
 * Builds the translation stack from the `translation` config block (plan §5, §8.1). The mt route exists when a fleet URL is set, llm when `llm.url` is set. Secrets come from the environment only:
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
  if (cfg.llm.url) {
    routes.llm = createLlmRoute({
      url: cfg.llm.url,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
      keepAlive: cfg.llm.keepAlive,
      fetchFn,
    });
  }
  const router = createRouter({
    routes,
    chainFor: (source, target) => routeChain(config(), source, target),
    maxAgeMs: cfg.maxAgeMs,
  });
  const memory = new TranslationMemory({ path: cfg.memoryPath });
  const manager = new TranslationManager({ config, router, memory, routes });
  // pigateway bus publisher (plan §9.2). Key from the environment only; used when publish.gateway is on.
  const gateway = new GatewayTranslations({
    url: env.PIVOICE_GATEWAY_URL,
    token: env.PIVOICE_GATEWAY_API_KEY,
    fetchFn,
    maxAgeMs: cfg.maxAgeMs,
  });
  return { manager, memory, routes, gateway };
}
