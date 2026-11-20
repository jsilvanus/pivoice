import { EventEmitter } from 'node:events';

/** Controls an Auditor live session (direct 16 kHz mono s16le PCM push or RTSP/SRT pull). */
export class AuditorLiveClient extends EventEmitter {
  #baseUrl;
  #apiKey;
  #source;
  #inputMode;
  #language;
  #fetch;
  #sessionId = null;
  #controller = null;
  #stopping = false;
  #generation = 0;
  #startPromise = null;
  #pcmQueue = [];
  #pcmPumping = false;
  #maxQueuedChunks = 64;

  constructor({ url, apiKey, source = null, inputMode = null, language = 'fi', fetchFn = globalThis.fetch }) {
    super();
    this.#baseUrl = url.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#source = source;
    this.#inputMode = inputMode || (source ? 'pull' : 'push');
    this.#language = language;
    this.#fetch = fetchFn;
  }

  get inputMode() { return this.#inputMode; }
  get running() { return this.#sessionId !== null && !this.#stopping; }
  status() {
    const configured = Boolean(this.#baseUrl && (this.#inputMode === 'push' || this.#source));
    return { configured, running: this.running, sessionId: this.#sessionId, inputMode: this.#inputMode };
  }

  async start(options = {}) {
    if (this.running) return this.status();
    if (this.#startPromise) return this.#startPromise;
    const generation = ++this.#generation;
    this.#stopping = false;
    const pending = this.#startSession(options, generation);
    this.#startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.#startPromise === pending) this.#startPromise = null;
    }
  }

  async #startSession({ preRollPcm = null, preRollStartMs = null, delivery = null } = {}, generation) {
    if (!this.#baseUrl || (this.#inputMode === 'pull' && !this.#source)) {
      throw new Error('Auditor live source URL is not configured');
    }
    const metadata = {
      ...(this.#inputMode === 'push' ? { input_mode: 'push', source: 'pcm://push' } : { source: this.#source }),
      language: this.#language,
      client_ref: 'pivoice-main',
      ...(delivery ? { delivery } : {}),
    };
    let request;
    if (Buffer.isBuffer(preRollPcm) && preRollPcm.length > 0) {
      const form = new FormData();
      form.set('metadata', JSON.stringify({
        ...metadata,
        has_preroll: true,
        ...(Number.isFinite(preRollStartMs) ? { preroll_start_ms: preRollStartMs } : {}),
      }));
      form.set('preroll', new Blob([preRollPcm], { type: 'application/octet-stream' }), 'preroll.pcm');
      request = { method: 'POST', headers: this.#headers(), body: form };
    } else {
      request = {
        method: 'POST',
        headers: this.#headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(metadata),
      };
    }
    const response = await this.#fetch(`${this.#baseUrl}/v1/live`, request);
    if (!response.ok) throw new Error(`Auditor live start failed (HTTP ${response.status})`);
    const body = await response.json();
    const id = body.id ?? body.session_id ?? body.session?.id;
    if (typeof id !== 'string' || !id) throw new Error('Auditor live start response did not contain a session id');
    // stop() can race the HTTP start response. If the request created a session
    // after stop was requested, delete it rather than leaving an orphan behind.
    if (generation !== this.#generation || this.#stopping) {
      await this.#fetch(`${this.#baseUrl}/v1/live/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: this.#headers(),
      }).catch(() => {});
      return this.status();
    }
    this.#sessionId = id;
    this.#controller = new AbortController();
    void this.#readEvents(id, this.#controller.signal).catch((err) => {
      if (!this.#stopping) this.emit('live-error', err);
    });
    this.emit('status', this.status());
    return this.status();
  }

  async stop() {
    this.#stopping = true;
    this.#generation++;
    const id = this.#sessionId;
    if (!id) {
      if (this.#startPromise) await this.#startPromise.catch(() => undefined);
      this.emit('status', this.status());
      return this.status();
    }
    this.#controller?.abort();
    this.#controller = null;
    this.#sessionId = null;
    this.#pcmQueue = [];
    try {
      if (this.#inputMode === 'push') {
        await this.#fetch(`${this.#baseUrl}/v1/live/${encodeURIComponent(id)}/audio`, {
          method: 'POST',
          headers: this.#headers({ 'content-type': 'application/octet-stream', 'x-eof': '1' }),
          body: new Uint8Array(0),
        }).catch(() => {});
      }
      await this.#fetch(`${this.#baseUrl}/v1/live/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.#headers(),
      });
    } catch (err) {
      this.emit('live-error', err);
    }
    this.emit('status', this.status());
    return this.status();
  }

  /** Pushes raw 16 kHz mono s16le PCM bytes to an active push-mode live session. */
  pushPcm(pcm) {
    if (this.#inputMode !== 'push' || !this.running || !Buffer.isBuffer(pcm) || pcm.length === 0) return;
    if (this.#pcmQueue.length >= this.#maxQueuedChunks) {
      this.#pcmQueue.shift();
    }
    this.#pcmQueue.push(pcm);
    void this.#pumpPcm();
  }

  async #pumpPcm() {
    if (this.#pcmPumping) return;
    this.#pcmPumping = true;
    try {
      while (this.#pcmQueue.length > 0 && this.running) {
        const id = this.#sessionId;
        const chunk = this.#pcmQueue.shift();
        if (!id || !chunk) break;
        const res = await this.#fetch(`${this.#baseUrl}/v1/live/${encodeURIComponent(id)}/audio`, {
          method: 'POST',
          headers: this.#headers({ 'content-type': 'application/octet-stream' }),
          body: chunk,
        });
        if (!res.ok) {
          throw new Error(`Auditor live audio push failed (HTTP ${res.status})`);
        }
      }
    } catch (err) {
      if (!this.#stopping) this.emit('live-error', err);
    } finally {
      this.#pcmPumping = false;
    }
  }

  #headers(extra = {}) {
    return { ...extra, ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}) };
  }

  async #readEvents(id, signal) {
    let lastEventId = null;
    let backoffMs = 250;
    while (!signal.aborted && this.#sessionId === id) {
      try {
        const headers = this.#headers({ accept: 'text/event-stream' });
        if (lastEventId !== null) headers['last-event-id'] = lastEventId;
        const response = await this.#fetch(`${this.#baseUrl}/v1/live/${encodeURIComponent(id)}/events`, {
          headers, signal,
        });
        if (!response.ok || !response.body) throw new Error(`Auditor live events failed (HTTP ${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let eventName = 'message';
        let eventId = null;
        let dataLines = [];
        const dispatch = () => {
          if (!dataLines.length) {
            eventName = 'message';
            return;
          }
          const raw = dataLines.join('\n');
          dataLines = [];
          try {
            const data = JSON.parse(raw);
            if (eventName === 'transcript') {
              const startMs = Date.parse(data.wall_start);
              const endMs = Date.parse(data.wall_end);
              if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
                this.emit('transcript', {
                  seq: Number(data.sequence) || 0, chunkSeq: null, startMs, endMs,
                  text: String(data.text ?? ''), language: data.language ?? this.#language,
                });
              }
            } else if (eventName === 'status' || eventName === 'error') {
              this.emit('live-event', { type: eventName, data });
            }
          } catch {
            this.emit('live-event', { type: 'parse-error' });
          }
          if (eventId !== null) lastEventId = eventId;
          eventId = null;
          eventName = 'message';
        };
        try {
          while (!signal.aborted && this.#sessionId === id) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline).replace(/\r$/, '');
              pending = pending.slice(newline + 1);
              if (!line) dispatch();
              else if (line.startsWith('id:')) eventId = line.slice(3).trim();
              else if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
          }
        } finally {
          try { await reader.cancel(); } catch {}
        }
        if (signal.aborted || this.#sessionId !== id) return;
        throw new Error('Auditor live event stream ended; reconnecting');
      } catch (err) {
        if (signal.aborted || this.#sessionId !== id) return;
        this.emit('live-error', err);
        await new Promise((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, backoffMs);
          timer.unref?.();
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        backoffMs = Math.min(5000, backoffMs * 2);
      }
    }
  }
}
