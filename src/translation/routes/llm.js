import { RouteError } from '../errors.js';
import { directionAllowed } from '../policy.js';

const LANGUAGE_NAMES = Object.freeze({ fi: 'Finnish', en: 'English', sv: 'Swedish', ru: 'Russian', uk: 'Ukrainian', es: 'Spanish' });
const MAX_CONTEXT = 2;

/**
 * The llm route: PiVoice calls ollama directly (`POST /api/chat`), no fleet involved (plan §5.6).
 * The answer is JSON `{"translations":[{"id":0,"text":"..."}]}`; the router validates it with the
 * same rules as every route (§6.3), so this route only parses and maps failures to codes.
 *
 * Availability: `GET /api/tags` lists the configured model (polled by `refresh()`, which the
 * manager calls every 30 s while translation is on). Concurrency is 1; a batch waits for the one
 * before it. `keep_alive` stays short so the model does not hold the VRAM STT needs.
 */
export function createLlmRoute({
  url,
  model = 'qwen2.5:3b',
  timeoutMs = 8000,
  keepAlive = '30s',
  glossary = () => [],
  fetchFn = globalThis.fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const base = url ? url.replace(/\/$/, '') : null;
  let listed = false;
  let tail = Promise.resolve();
  const stats = { requests: 0, failed: 0, lastError: null, lastRefreshAt: null };

  /** fetch with a timeout that also follows the caller's signal. */
  async function call(path, init, signal) {
    const controller = new AbortController();
    const timer = setTimeoutFn(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetchFn(`${base}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeoutFn(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function refresh() {
    if (!base) return false;
    try {
      const res = await call('/api/tags', { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const names = (Array.isArray(body?.models) ? body.models : []).flatMap((m) => [m?.name, m?.model]);
      listed = names.some((name) => name === model || name === `${model}:latest`);
      stats.lastRefreshAt = new Date().toISOString();
    } catch (err) {
      listed = false;
      stats.lastError = `tags: ${err?.name === 'AbortError' ? 'timeout' : 'unreachable'}`;
    }
    return listed;
  }

  function available(source, target) {
    return Boolean(base) && listed && directionAllowed(source, target);
  }

  function buildMessages(segments, { source, target, context }) {
    const from = LANGUAGE_NAMES[source] ?? source;
    const to = LANGUAGE_NAMES[target] ?? target;
    const terms = glossary(source, target) ?? [];
    const system = [
      `You translate spoken church service captions from ${from} to ${to}.`,
      'Register: the Evangelical Lutheran church service, spoken, reverent and plain. Translate meaning faithfully; do not add, explain or leave out anything.',
      'Answer with JSON only, exactly: {"translations":[{"id":0,"text":"..."}]} with one entry per numbered line and the same ids.',
      ...(terms.length ? ['Glossary (use these renderings):', ...terms.map((t) => `${t.source} => ${t.target}`)] : []),
    ].join('\n');
    const previous = (Array.isArray(context) ? context : []).filter((t) => typeof t === 'string' && t.trim()).slice(-MAX_CONTEXT);
    const user = [
      ...(previous.length ? ['Previous lines (context only, do not translate):', ...previous.map((t) => `- ${t}`), ''] : []),
      `Translate from ${from} to ${to}:`,
      ...segments.map((s) => `${s.id}: ${s.text}`),
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  async function run(segments, opts) {
    stats.requests++;
    let res;
    try {
      res = await call(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            keep_alive: keepAlive,
            options: { temperature: 0 },
            messages: buildMessages(segments, opts),
          }),
        },
        opts.signal,
      );
    } catch (err) {
      stats.failed++;
      if (opts.signal?.aborted) throw new RouteError('CANCELLED', 'llm request was cancelled');
      stats.lastError = err?.name === 'AbortError' ? 'timeout' : 'unreachable';
      throw new RouteError(err?.name === 'AbortError' ? 'TIMEOUT' : 'ROUTE_UNAVAILABLE', `ollama ${stats.lastError}`);
    }
    if (!res.ok) {
      stats.failed++;
      stats.lastError = `HTTP ${res.status}`;
      throw new RouteError('ROUTE_UNAVAILABLE', `ollama answered HTTP ${res.status}`);
    }
    try {
      const body = await res.json();
      const parsed = JSON.parse(body?.message?.content ?? '');
      if (!Array.isArray(parsed?.translations)) throw new Error('shape');
      return { translations: parsed.translations, model: `ollama:${model}` };
    } catch {
      stats.failed++;
      stats.lastError = 'unparseable answer';
      // Never include the model's text: it is caption content.
      throw new RouteError('INVALID_RESULT', 'ollama answer was not the requested JSON');
    }
  }

  function translate(segments, { source, target, context, signal } = {}) {
    if (!base) return Promise.reject(new RouteError('ROUTE_UNAVAILABLE', 'llm route has no url'));
    const job = tail.then(() => run(segments, { source, target, context, signal }));
    tail = job.catch(() => {});
    return job;
  }

  return { name: 'llm', refresh, available, translate, status: () => ({ ...stats, model, listed }) };
}
