import { EventEmitter } from 'node:events';

const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Polls the YouTube Data API (videos.list, liveBroadcastContent) to tell whether
 * the stream is online. Used by captions.youtube.mode "auto". The API key goes
 * in a header, never in the URL. The watcher goes offline only after `offAfter`
 * consecutive non-live polls, so one flaky answer does not stop captions. A
 * failed poll keeps the last known state.
 *
 * Emits 'change' with `true` (online) or `false` (offline).
 */
export class StreamOnlineWatcher extends EventEmitter {
  #apiKey;
  #videoId;
  #fetch;
  #now;
  #intervalMs;
  #offAfter;
  #online = false;
  #misses = 0;
  #timer = null;
  #stats = { lastCheckedAt: null, lastError: null };

  constructor({ apiKey = null, videoId = null, fetchFn = globalThis.fetch, now = Date.now, intervalMs = 30_000, offAfter = 2 } = {}) {
    super();
    this.#apiKey = apiKey;
    this.#videoId = videoId;
    this.#fetch = fetchFn;
    this.#now = now;
    this.#intervalMs = intervalMs;
    this.#offAfter = offAfter;
  }

  get configured() {
    return Boolean(this.#apiKey && this.#videoId);
  }

  get online() {
    return this.#online;
  }

  start() {
    if (!this.configured) throw new Error('YouTube stream check needs apiKey and videoId');
    if (this.#timer) return;
    this.#timer = setInterval(() => this.poll(), this.#intervalMs);
    this.#timer.unref();
    this.poll();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#misses = 0;
    if (this.#online) {
      this.#online = false;
      this.emit('change', false);
    }
  }

  async poll() {
    try {
      const url = `${YT_API}/videos?part=snippet&id=${encodeURIComponent(this.#videoId)}`;
      const res = await this.#fetch(url, { headers: { 'x-goog-api-key': this.#apiKey }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`YouTube API answered HTTP ${res.status}`);
      const body = await res.json();
      const live = body.items?.[0]?.snippet?.liveBroadcastContent === 'live';
      this.#stats = { lastCheckedAt: new Date(this.#now()).toISOString(), lastError: null };
      this.#observe(live);
    } catch (err) {
      this.#stats = { ...this.#stats, lastError: this.#redact(err.message) };
    }
  }

  status() {
    return { configured: this.configured, watching: this.#timer !== null, online: this.#online, ...this.#stats };
  }

  #observe(live) {
    if (live) {
      this.#misses = 0;
      if (!this.#online) {
        this.#online = true;
        this.emit('change', true);
      }
      return;
    }
    this.#misses++;
    if (this.#online && this.#misses >= this.#offAfter) {
      this.#online = false;
      this.emit('change', false);
    }
  }

  #redact(message) {
    return this.#apiKey ? message.split(this.#apiKey).join('***') : message;
  }
}
