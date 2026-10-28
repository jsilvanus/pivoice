import { EventEmitter } from 'node:events';
import { BYTES_PER_MS } from './pcm.js';

/**
 * Energy-based voice activity gate. Opens on speech-level audio and closes after
 * `hangoverSeconds` of quiet. It keeps the last `prerollSeconds` of audio so the
 * start of speech is not cut when a radio encoder starts. Times are the PCM's own
 * epoch milliseconds, so the gate is deterministic and easy to test.
 *
 * Emits 'open' ({ startMs, preroll }) and 'close' ({ atMs }).
 */
export class VoiceGate extends EventEmitter {
  #thresholdRms;
  #hangoverMs;
  #prerollBytes;
  #open = false;
  #lastVoiceMs = -Infinity;
  #preroll = Buffer.alloc(0);

  constructor({ thresholdDb = -45, hangoverSeconds = 3, prerollSeconds = 1 } = {}) {
    super();
    this.#thresholdRms = 32768 * 10 ** (thresholdDb / 20);
    this.#hangoverMs = hangoverSeconds * 1000;
    this.#prerollBytes = Math.round(prerollSeconds * 1000 * BYTES_PER_MS);
  }

  get open() {
    return this.#open;
  }

  /** Epoch ms of the last buffer that contained speech-level audio. */
  get lastVoiceMs() {
    return this.#lastVoiceMs;
  }

  push(pcm, startMs) {
    const endMs = startMs + pcm.length / BYTES_PER_MS;
    if (rms(pcm) >= this.#thresholdRms) {
      this.#lastVoiceMs = endMs;
      if (!this.#open) {
        this.#open = true;
        this.emit('open', { startMs, preroll: this.#preroll });
      }
    } else if (this.#open && endMs - this.#lastVoiceMs > this.#hangoverMs) {
      this.#open = false;
      this.emit('close', { atMs: endMs });
    }
    this.#preroll = Buffer.concat([this.#preroll, pcm]).subarray(-this.#prerollBytes);
  }
}

/** Root mean square of 16-bit little-endian samples. */
export function rms(pcm) {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples * 2; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

