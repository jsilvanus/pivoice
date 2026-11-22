import { canRetry } from './deadline.js';
import { RouteError } from './errors.js';
import { validateTranslations } from './result.js';

/**
 * Tries a direction's routes in chain order (plan §5.6). The first available route takes the batch;
 * a retryable failure is retried once on the same route, any failure hands the batch to the next
 * route while the deadline allows. One route per batch, so the result names exactly one route.
 *
 * Routes: `{ name, available(source, target), translate(segments, opts) -> { translations, model } }`.
 */
export function createRouter({ routes, chainFor, maxAgeMs = 60_000, now = Date.now, minRemainingMs = 1000 }) {
  const byName = new Map(Object.entries(routes).filter(([, route]) => route));

  function chain(source, target) {
    return chainFor(source, target).map((name) => byName.get(name)).filter(Boolean);
  }

  function available(source, target) {
    return chain(source, target).some((route) => route.available(source, target));
  }

  function timeLeft(segments) {
    const earliest = Math.min(...segments.map((s) => s.endMs + maxAgeMs));
    return earliest - now();
  }

  /**
   * @param {Array<{id:number,text:string,endMs:number}>} segments
   * @returns {Promise<{ route: string, model: string|null, translations: Map<number,string>, truncated: number }>}
   */
  async function translate(segments, { source, target, context, signal } = {}) {
    let lastError = null;
    let tried = 0;
    for (const route of chain(source, target)) {
      if (!route.available(source, target)) continue;
      if (tried > 0 && timeLeft(segments) < minRemainingMs) break;
      tried++;
      for (let attempt = 0; ; attempt++) {
        try {
          const answer = await route.translate(segments, { source, target, context, signal });
          const { translations, truncated } = validateTranslations(segments, answer?.translations);
          return { route: route.name, model: answer?.model ?? null, translations, truncated };
        } catch (err) {
          lastError = err;
          if (err?.code === 'CANCELLED' || signal?.aborted) throw err;
          if (!canRetry({ code: err?.code, attempt, segments, now: now(), maxAgeMs, minRemainingMs })) break;
        }
      }
    }
    if (lastError) throw lastError;
    throw new RouteError('NO_ROUTE', 'no translation route is available for this direction');
  }

  return { translate, available, routes: () => [...byName.keys()] };
}
