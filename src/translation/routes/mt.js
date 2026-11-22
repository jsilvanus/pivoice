import { capability } from '../policy.js';
import { RouteError } from '../errors.js';

/**
 * The mt route: one fffleet batch job of type "translate" per batch, placed on the operator PC
 * worker (plan §6). The caller creates the fleet client (`createFleet` from fffleet) with
 * `fallback: 'none'`, so the Pi never runs a translation itself.
 *
 * Availability is the union of capabilities the orchestrator reports, refreshed by `refresh()`
 * (the manager calls it every 30 s while translation is on, and after failures).
 */
export function createMtRoute({
  fleet,
  workerPreference = ['operator-pc-translate'],
  jobTimeoutMs = 10_000,
  queueTimeoutMs = 3_000,
  idPrefix = `pivoice-tr-${Date.now().toString(36)}`,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let counter = 0;
  let capabilities = new Set();
  const stats = { jobs: 0, failed: 0, queueTimeouts: 0, lastError: null, lastRefreshAt: null };

  async function refresh() {
    try {
      const caps = await fleet.capabilities();
      const list = Array.isArray(caps?.capabilities) ? caps.capabilities : [];
      capabilities = new Set(list.filter((c) => typeof c === 'string'));
      stats.lastRefreshAt = new Date().toISOString();
    } catch (err) {
      capabilities = new Set();
      stats.lastError = `capabilities: ${err?.code ?? 'unreachable'}`;
    }
    return available;
  }

  function available(source, target) {
    return capabilities.has('type:translate') && capabilities.has(capability(source, target));
  }

  async function translate(segments, { source, target, signal } = {}) {
    const spec = {
      id: `${idPrefix}-${++counter}`,
      kind: 'batch',
      type: 'translate',
      requires: [capability(source, target)],
      workerPreference,
      timeoutMs: jobTimeoutMs,
      translate: { v: 1, source, target, segments: segments.map(({ id, text }) => ({ id, text })) },
    };
    stats.jobs++;
    let job;
    try {
      job = await fleet.submit(spec);
    } catch (err) {
      stats.failed++;
      stats.lastError = `submit: ${err?.code ?? 'error'}`;
      if (err?.code === 'INVALID_SPEC') throw new RouteError('INVALID_SPEC', 'translate job spec was refused');
      throw new RouteError('ROUTE_UNAVAILABLE', `fleet refused or unreachable (${err?.code ?? 'error'})`);
    }

    // An operator PC that is off must not collect a queue of old captions (plan §5.3).
    let queueTimedOut = false;
    const queueTimer = setTimeoutFn(() => {
      if (job.state === 'queued') {
        queueTimedOut = true;
        stats.queueTimeouts++;
        job.cancel().catch(() => {});
      }
    }, queueTimeoutMs);
    const onAbort = () => job.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    let final;
    try {
      final = await job.done;
    } catch {
      stats.failed++;
      stats.lastError = 'event stream lost';
      throw new RouteError('ROUTE_UNAVAILABLE', 'lost contact with the fleet');
    } finally {
      clearTimeoutFn(queueTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (final.state === 'succeeded') {
      const data = final.outputs?.find((o) => o.name === 'translations')?.data;
      if (!data || data.v !== 1) {
        stats.failed++;
        throw new RouteError('INVALID_RESULT', 'translate job returned no translations');
      }
      return { translations: data.translations, model: typeof data.model === 'string' ? data.model : null };
    }
    stats.failed++;
    if (queueTimedOut) {
      stats.lastError = 'queue timeout';
      throw new RouteError('ROUTE_UNAVAILABLE', 'no translation worker took the job in time');
    }
    if (final.state === 'cancelled') {
      stats.lastError = 'cancelled';
      throw new RouteError('CANCELLED', 'translate job was cancelled');
    }
    const code = final.error?.code ?? 'FAILED';
    stats.lastError = code;
    // The fleet's codes (TIMEOUT, WORKER_LOST, ...) pass through for the retry rules; the worker's own
    // message is not passed on, only its code.
    throw new RouteError(code, `translate job failed (${code})`);
  }

  return {
    name: 'mt',
    refresh,
    available,
    translate,
    status: () => ({ ...stats, directions: [...capabilities].filter((c) => c.startsWith('translate:')).map((c) => c.slice(10)).sort() }),
  };
}
