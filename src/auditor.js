import { wavFromPcm } from './pcm.js';

export class AuditorError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.retryable = retryable;
  }
}

/** Accepts the whisper.cpp-style `/inference` response and returns plain segments. */
export function normaliseInference(body) {
  const segments = Array.isArray(body?.segments)
    ? body.segments
        .map((s) => ({ startSec: Number(s.start) || 0, endSec: Number(s.end) || 0, text: String(s.text ?? '').trim() }))
        .filter((s) => s.text)
    : [];
  if (segments.length === 0 && typeof body?.text === 'string' && body.text.trim()) {
    segments.push({ startSec: 0, endSec: 0, text: body.text.trim() });
  }
  return { language: body?.language ?? null, segments };
}

/**
 * Client for liturgos-auditor's `POST /inference`. Sends one WAV chunk per call,
 * with a timeout and a few retries on 503 (queue full or model loading) and on
 * network errors. Other 4xx responses fail at once.
 */
export class AuditorClient {
  #base;
  #apiKey;
  #timeoutMs;
  #retries;
  #retryDelayMs;
  #fetch;
  #preferJobs = false;

  constructor({ url, apiKey = null, timeoutMs = 20000, retries = 2, retryDelayMs = 500, fetchFn = globalThis.fetch }) {
    this.#base = url.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#retryDelayMs = retryDelayMs;
    this.#fetch = fetchFn;
  }

  async transcribe({ pcm, language }) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        if (this.#preferJobs) {
          return await this.#viaJob({ pcm, language });
        }
        return await this.#once({ pcm, language });
      } catch (err) {
        if (err instanceof AuditorError && !err.retryable) throw err;
        lastError = err;
        // If /inference failed with 500, fall back to /v1/jobs batch pipeline
        if (!this.#preferJobs && err instanceof AuditorError && err.message.includes('HTTP 500')) {
          try {
            const result = await this.#viaJob({ pcm, language });
            this.#preferJobs = true;
            return result;
          } catch (jobErr) {
            lastError = jobErr;
          }
        }
      }
      if (attempt < this.#retries) {
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * 2 ** attempt));
      }
    }
    throw lastError;
  }

  async #viaJob({ pcm, language }) {
    const form = new FormData();
    form.append('file', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'chunk.wav');
    form.append('language', language);
    form.append('word_timestamps', 'true');
    const headers = this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
    const res = await this.#fetch(`${this.#base}/v1/jobs`, {
      method: 'POST',
      body: form,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const retryable = res.status === 503 || res.status === 429 || res.status >= 500;
      throw new AuditorError(`auditor jobs answered HTTP ${res.status}`, { retryable });
    }
    const { id } = await res.json();
    if (!id) throw new AuditorError('no job id returned', { retryable: false });

    const pollStart = Date.now();
    while (Date.now() - pollStart < this.#timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pollRes = await this.#fetch(`${this.#base}/v1/jobs/${id}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!pollRes.ok) continue;
      const status = await pollRes.json();
      if (status.status === 'completed') {
        const resultRes = await this.#fetch(`${this.#base}/v1/jobs/${id}/result`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!resultRes.ok) throw new AuditorError(`auditor job result HTTP ${resultRes.status}`, { retryable: false });
        return normaliseInference(await resultRes.json());
      }
      if (status.status === 'failed' || status.status === 'error') {
        throw new AuditorError(`auditor job failed: ${status.error || 'unknown error'}`, { retryable: false });
      }
    }
    throw new AuditorError('auditor job timed out', { retryable: true });
  }

  async #once({ pcm, language }) {
    const form = new FormData();
    form.append('file', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'chunk.wav');
    form.append('language', language);
    const headers = this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
    const res = await this.#fetch(`${this.#base}/inference`, {
      method: 'POST',
      body: form,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const retryable = res.status === 503 || res.status === 429 || res.status >= 500;
      throw new AuditorError(`auditor answered HTTP ${res.status}`, { retryable });
    }
    return normaliseInference(await res.json());
  }
}
