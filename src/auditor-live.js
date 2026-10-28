import { EventEmitter } from 'node:events';

/** Controls an Auditor pull-mode live session; audio is pulled by Auditor from MediaMTX. */
export class AuditorLiveClient extends EventEmitter {
  #baseUrl;
  #apiKey;
  #source;
  #language;
  #fetch;
  #sessionId = null;
  #controller = null;
  #stopping = false;

  constructor({ url, apiKey, source, language = 'fi', fetchFn = globalThis.fetch }) {
    super();
    this.#baseUrl = url.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#source = source;
    this.#language = language;
    this.#fetch = fetchFn;
  }

  get running() { return this.#sessionId !== null && !this.#stopping; }
  status() { return { configured: Boolean(this.#baseUrl && this.#source), running: this.running, sessionId: this.#sessionId }; }

  async start({ preRollPcm = null, preRollStartMs = null } = {}) {
    if (this.running) return this.status();
    if (!this.#baseUrl || !this.#source) throw new Error('Auditor live source URL is not configured');
    this.#stopping = false;
    const metadata = { source: this.#source, language: this.#language, client_ref: 'pivoice-main' };
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
    this.#sessionId = id;
    this.#controller = new AbortController();
    void this.#readEvents(id, this.#controller.signal).catch((err) => {
      if (!this.#stopping) this.emit('live-error', err);
    });
    this.emit('status', this.status());
    return this.status();
  }

  async stop() {
    const id = this.#sessionId;
    if (!id) return this.status();
    this.#stopping = true;
    this.#controller?.abort();
    this.#controller = null;
    this.#sessionId = null;
    try {
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
        let dataLines = [];
        const dispatch = () => {
          if (!dataLines.length) {
            eventName = 'message';
            return;
          }
          const raw = dataLines.join('\\n');
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
          eventName = 'message';
        };
        try {
          while (!signal.aborted && this.#sessionId === id) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = pending.indexOf('\\n')) >= 0) {
              const line = pending.slice(0, newline).replace(/\\r$/, '');
              pending = pending.slice(newline + 1);
              if (!line) dispatch();
              else if (line.startsWith('id:')) lastEventId = line.slice(3).trim();
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
          const timer = setTimeout(resolve, backoffMs);
          timer.unref?.();
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        backoffMs = Math.min(5000, backoffMs * 2);
      }
    }
  }
}
