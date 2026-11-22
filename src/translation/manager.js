import { EventEmitter } from 'node:events';
import { Batcher } from './batcher.js';
import { partitionExpired } from './deadline.js';
import { baseLanguage, directionAllowed, isSourceLanguage } from './policy.js';
import { enabledDirections } from './config.js';

const MAX_TEXT = 500;

/**
 * Translation lifecycle in PiVoice (plan §5). Takes final transcripts, looks them up in the
 * translation memory, batches the rest per direction, sends batches through the router and emits
 * one `translation` event per segment and target.
 *
 * Costs nothing while stopped: no timers, and `handle()` returns at once (plan §5.1a).
 *
 * Events: 'translation' (plan §5.7), 'status' (after a change worth showing).
 */
export class TranslationManager extends EventEmitter {
  #config;
  #router;
  #memory;
  #routes;
  #now;
  #setTimeout;
  #clearTimeout;
  #setInterval;
  #clearInterval;
  #refreshMs;
  #running = false;
  #refreshTimer = null;
  #batchers = new Map();
  #controller = null;
  #stats = new Map();
  #skipped = { unsupportedSource: 0, unavailable: 0 };
  #localId = 0;

  /**
   * @param {object} o
   * @param {() => object} o.config      current `translation` config block
   * @param {object} o.router             from createRouter
   * @param {object} [o.memory]           TranslationMemory
   * @param {Record<string, object>} [o.routes]  routes with optional refresh() and status()
   */
  constructor({
    config,
    router,
    memory = null,
    routes = {},
    now = Date.now,
    refreshMs = 30_000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    super();
    this.#config = config;
    this.#router = router;
    this.#memory = memory;
    this.#routes = routes;
    this.#now = now;
    this.#refreshMs = refreshMs;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
  }

  get running() {
    return this.#running;
  }

  /** Starts route availability polling. Call when translation becomes active. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    void this.refresh();
    this.#refreshTimer = this.#setInterval(() => void this.refresh(), this.#refreshMs);
    this.#refreshTimer?.unref?.();
  }

  /** Stops polling, drops what waits in batchers and aborts batches in flight. */
  stop() {
    if (!this.#running) return;
    this.#running = false;
    if (this.#refreshTimer) this.#clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#controller?.abort();
    this.#controller = null;
    for (const batcher of this.#batchers.values()) batcher.close();
    this.#batchers.clear();
  }

  async refresh() {
    await Promise.all(Object.values(this.#routes).map((r) => r?.refresh?.().catch(() => {})));
  }

  /**
   * One final transcript. `session` identifies the auditor session (or a PiVoice run id) so that
   * `${session}:${seq}` is a key other services can compute too (plan §5.1).
   */
  handle(event, { session = 'pivoice' } = {}) {
    if (!this.#running) return;
    try {
      this.#handle(event, session);
    } catch {
      // A bug here must never reach the original caption path.
    }
  }

  #handle(event, session) {
    const cfg = this.#config();
    const text = typeof event?.text === 'string' ? event.text.trim().slice(0, MAX_TEXT) : '';
    if (!text || !Number.isFinite(event.startMs)) return;
    const source = baseLanguage(event.language);
    if (!isSourceLanguage(source)) {
      this.#skipped.unsupportedSource++;
      return;
    }
    const segmentBase = {
      sourceKey: `${session}:${event.seq}`,
      sourceSeq: event.seq,
      session,
      source,
      text,
      startMs: event.startMs,
      endMs: Number.isFinite(event.endMs) ? Math.max(event.endMs, event.startMs) : event.startMs,
    };
    for (const { target } of enabledDirections(cfg, source)) {
      const stats = this.#targetStats(target);
      const hit = this.#memory?.lookup(source, target, text);
      if (hit) {
        stats.fromMemory++;
        this.#emitTranslation({ ...segmentBase, target }, hit, { origin: 'memory', route: null, model: null, latencyMs: 0 });
        continue;
      }
      if (!this.#router.available(source, target)) {
        stats.dropped.unavailable++;
        this.#skipped.unavailable++;
        continue;
      }
      this.#batcherFor(source, target, cfg).add({ ...segmentBase, target, receivedAt: this.#now() });
    }
  }

  #batcherFor(source, target, cfg) {
    const key = `${source}-${target}`;
    let batcher = this.#batchers.get(key);
    if (!batcher) {
      batcher = new Batcher({
        send: (batch) => this.#send(source, target, batch),
        onDrop: (segment, why) => {
          if (why === 'queueFull') this.#targetStats(target).dropped.queueFull++;
        },
        windowMs: cfg.batch.windowMs,
        maxSegments: cfg.batch.maxSegments,
        maxChars: cfg.batch.maxChars,
        maxInFlight: cfg.maxInFlightPerTarget,
        maxQueued: cfg.maxQueuedPerTarget,
        setTimeoutFn: this.#setTimeout,
        clearTimeoutFn: this.#clearTimeout,
      });
      this.#batchers.set(key, batcher);
    }
    return batcher;
  }

  async #send(source, target, batch) {
    const cfg = this.#config();
    const stats = this.#targetStats(target);
    const { live, expired } = partitionExpired(batch, this.#now(), cfg.maxAgeMs);
    stats.dropped.late += expired.length;
    if (live.length === 0) return;
    // Ids are local to the batch; nothing else about the session goes to a route.
    const segments = live.map((s) => ({ id: this.#localId++ % 1_000_000, text: s.text, endMs: s.endMs, ref: s }));
    const signal = this.#controller?.signal;
    let result;
    try {
      result = await this.#router.translate(segments, { source, target, signal });
    } catch (err) {
      if (signal?.aborted) return;
      stats.failed += segments.length;
      stats.lastError = err?.code ?? 'error';
      this.emit('status', this.status());
      return;
    }
    stats.truncated += result.truncated;
    const at = this.#now();
    for (const s of segments) {
      if (at > s.endMs + cfg.maxAgeMs) {
        stats.dropped.late++;
        continue;
      }
      this.#emitTranslation(s.ref, result.translations.get(s.id), {
        origin: 'model',
        route: result.route,
        model: result.model,
        latencyMs: Math.max(0, at - s.ref.receivedAt),
      });
    }
    stats.lastError = null;
  }

  #emitTranslation(segment, text, { origin, route, model, latencyMs }) {
    const stats = this.#targetStats(segment.target);
    stats.sent++;
    stats.route = route ?? stats.route;
    stats.model = model ?? stats.model;
    if (origin === 'model') stats.latencies.push(latencyMs);
    if (stats.latencies.length > 200) stats.latencies.shift();
    this.emit('translation', {
      sourceKey: segment.sourceKey,
      sourceSeq: segment.sourceSeq,
      session: segment.session,
      source: segment.source,
      lang: segment.target,
      text: text.slice(0, MAX_TEXT),
      startMs: segment.startMs,
      endMs: segment.endMs,
      origin,
      ...(route ? { route } : {}),
      ...(model ? { model } : {}),
      latencyMs,
    });
  }

  #targetStats(target) {
    let s = this.#stats.get(target);
    if (!s) {
      s = { sent: 0, fromMemory: 0, failed: 0, truncated: 0, dropped: { late: 0, unavailable: 0, queueFull: 0 }, route: null, model: null, lastError: null, latencies: [] };
      this.#stats.set(target, s);
    }
    return s;
  }

  /**
   * Status for the API: counts, availability and latency, never caption text. Pass the current
   * source language to get per-target availability.
   */
  status({ source: sourceLanguage = null } = {}) {
    const cfg = this.#config();
    const source = baseLanguage(sourceLanguage) ?? null;
    const targets = {};
    for (const target of cfg.targets) {
      const s = this.#targetStats(target);
      targets[target] = {
        sent: s.sent,
        fromMemory: s.fromMemory,
        failed: s.failed,
        truncated: s.truncated,
        dropped: { ...s.dropped },
        route: s.route,
        model: s.model,
        lastError: s.lastError,
        latencyMs: percentiles(s.latencies),
      };
      if (source && directionAllowed(source, target)) targets[target].available = this.#router.available(source, target);
    }
    const routes = {};
    for (const [name, route] of Object.entries(this.#routes)) if (route?.status) routes[name] = route.status();
    return {
      mode: cfg.mode,
      running: this.#running,
      targets,
      routes,
      skipped: { ...this.#skipped },
      memory: this.#memory?.status?.() ?? null,
    };
  }

  /** Which configured targets can be translated from `source` right now. */
  availability(source) {
    const cfg = this.#config();
    return Object.fromEntries(
      cfg.targets.filter((t) => directionAllowed(source, t)).map((t) => [t, this.#router.available(source, t)]),
    );
  }
}

function percentiles(values) {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}
