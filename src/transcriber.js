import { EventEmitter } from 'node:events';

/**
 * Runs chunks through the auditor one at a time, in order. The queue is bounded:
 * when the auditor falls behind, the oldest waiting chunk is dropped, and a chunk
 * that is already too old to caption is skipped instead of shown late.
 *
 * Emits `transcript` with absolute epoch-millisecond times for each segment, and
 * `status` after a failed chunk.
 */
export class Transcriber extends EventEmitter {
  #auditor = null;
  #language = 'fi';
  #maxQueue = 3;
  #now;
  #staleMs;
  #queue = [];
  #busy = false;
  #seq = 0;
  #stats = { processed: 0, dropped: 0, stale: 0, failed: 0, lagMs: null, lastError: null };

  constructor({ now = Date.now, staleMs = 30_000 } = {}) {
    super();
    this.#now = now;
    this.#staleMs = staleMs;
  }

  get configured() {
    return this.#auditor !== null;
  }

  configure({ auditor, language, maxQueue }) {
    this.#auditor = auditor;
    this.#language = language;
    this.#maxQueue = maxQueue;
  }

  enqueue(chunk) {
    if (!this.#auditor) return;
    if (this.#queue.length >= this.#maxQueue) {
      this.#queue.shift();
      this.#stats.dropped++;
    }
    this.#queue.push(chunk);
    this.#pump();
  }

  clear() {
    this.#stats.dropped += this.#queue.length;
    this.#queue = [];
  }

  status() {
    return {
      configured: this.configured,
      busy: this.#busy,
      queued: this.#queue.length,
      maxQueue: this.#maxQueue,
      ...this.#stats,
    };
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length > 0) {
        const chunk = this.#queue.shift();
        if (this.#now() - chunk.endMs > this.#staleMs) {
          this.#stats.stale++;
          continue;
        }
        const auditor = this.#auditor;
        if (!auditor) break;
        try {
          const result = await auditor.transcribe({ pcm: chunk.pcm, language: this.#language });
          this.#stats.processed++;
          this.#stats.lagMs = this.#now() - chunk.endMs;
          this.#stats.lastError = null;
          for (const seg of result.segments) {
            const startMs = clamp(chunk.startMs + seg.startSec * 1000, chunk.startMs, chunk.endMs);
            const endMs = seg.endSec > 0 ? clamp(chunk.startMs + seg.endSec * 1000, startMs, chunk.endMs) : chunk.endMs;
            this.emit('transcript', {
              seq: ++this.#seq,
              chunkSeq: chunk.seq,
              startMs: Math.round(startMs),
              endMs: Math.round(endMs),
              text: seg.text,
              language: result.language ?? this.#language,
            });
          }
        } catch (err) {
          this.#stats.failed++;
          this.#stats.lastError = err.message;
          this.emit('status', this.status());
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
