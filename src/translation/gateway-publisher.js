/**
 * Publishes translation events to pigateway with `POST /api/v1/translations` (Bearer key), which
 * puts them on its bus as `translation` events (plan §9.2, §10.1). Batched like RelayCaptions:
 * a bounded buffer, stale events dropped rather than replayed as live, a refused batch dropped so
 * later ones are not held behind it. The key never appears in status or errors.
 */
const MAX_BATCH = 100;

export class GatewayTranslations {
  #url;
  #token;
  #fetch;
  #now;
  #batchSize;
  #flushMs;
  #maxAgeMs;
  #maxBuffer;
  #running = false;
  #timer = null;
  #sending = false;
  #buffer = [];
  #stats = { sent: 0, failed: 0, dropped: 0, lastError: null, lastSentAt: null };

  constructor({
    url = null, token = null, fetchFn = globalThis.fetch, now = Date.now,
    batchSize = 10, flushMs = 1000, maxAgeMs = 60_000, maxBuffer = 500,
  } = {}) {
    this.#url = url ? url.replace(/\/$/, '') : null;
    this.#token = token;
    this.#fetch = fetchFn;
    this.#now = now;
    this.#batchSize = Math.min(batchSize, MAX_BATCH);
    this.#flushMs = flushMs;
    this.#maxAgeMs = maxAgeMs;
    this.#maxBuffer = maxBuffer;
  }

  get configured() {
    return Boolean(this.#url && this.#token);
  }

  start() {
    if (!this.configured) throw new Error('gateway publisher needs url and token');
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => this.flush(), this.#flushMs);
    this.#timer.unref();
  }

  stop() {
    this.#running = false;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#buffer = [];
  }

  /** @param {object} event a translation event (plan §5.7) */
  push(event) {
    if (!this.#running) return;
    if (this.#buffer.length >= this.#maxBuffer) {
      this.#buffer.shift();
      this.#stats.dropped++;
    }
    this.#buffer.push(event);
    if (this.#buffer.length >= this.#batchSize) this.flush();
  }

  async flush() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#buffer.length > 0) {
        const cutoff = this.#now() - this.#maxAgeMs;
        while (this.#buffer.length > 0 && this.#buffer[0].endMs < cutoff) {
          this.#buffer.shift();
          this.#stats.dropped++;
        }
        if (this.#buffer.length === 0) break;
        const batch = this.#buffer.slice(0, this.#batchSize);
        try {
          await this.#post(batch);
          this.#buffer.splice(0, batch.length);
          this.#stats.sent += batch.length;
          this.#stats.lastSentAt = new Date(this.#now()).toISOString();
          this.#stats.lastError = null;
        } catch (err) {
          this.#stats.failed++;
          this.#stats.lastError = err.message;
          if (err.permanent) {
            this.#buffer.splice(0, batch.length);
            this.#stats.dropped += batch.length;
            continue;
          }
          break;
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  status() {
    return {
      configured: this.configured,
      running: this.#running,
      host: this.#url ? new URL(this.#url).host : null,
      queued: this.#buffer.length,
      ...this.#stats,
    };
  }

  async #post(batch) {
    let res;
    try {
      res = await this.#fetch(`${this.#url}/api/v1/translations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Error(`gateway unreachable (${err?.name === 'TimeoutError' ? 'timeout' : 'network'})`);
    }
    if (!res.ok) {
      const err = new Error(`gateway answered HTTP ${res.status}`);
      err.permanent = res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status);
      throw err;
    }
  }
}
