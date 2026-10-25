/**
 * Publishes captions to web-radio-relay (jsilvanus/web-radio-relay) with
 * `POST /api/v1/captions`, Bearer token. Events are batched and carry their own
 * epoch-millisecond times; the relay applies the listener delay on its side.
 * While the relay is unreachable events wait in a bounded buffer; anything older
 * than `maxAgeMs` is dropped rather than replayed as if it were live.
 */
const MAX_TEXT = 500;
const MAX_BATCH = 100;

export class RelayCaptions {
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
    if (!this.configured) throw new Error('caption relay needs url and token');
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

  push(event) {
    if (!this.#running) return;
    if (this.#buffer.length >= this.#maxBuffer) {
      this.#buffer.shift();
      this.#stats.dropped++;
    }
    this.#buffer.push({
      seq: event.seq,
      lang: event.language,
      text: event.text.slice(0, MAX_TEXT),
      startedAt: event.startMs,
      endedAt: Math.max(event.endMs, event.startMs),
    });
    if (this.#buffer.length >= this.#batchSize) this.flush();
  }

  async flush() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#buffer.length > 0) {
        const cutoff = this.#now() - this.#maxAgeMs;
        while (this.#buffer.length > 0 && this.#buffer[0].endedAt < cutoff) {
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
    const res = await this.#fetch(`${this.#url}/api/v1/captions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        segments: batch.map(({ lang, text, startedAt, endedAt }) => ({ lang, text, startedAt, endedAt })),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`caption relay answered HTTP ${res.status}`);
  }
}
