// Shared audio format and chunking. Everything inside PiVoice is 16 kHz mono
// signed 16-bit little-endian PCM, so one millisecond is exactly 32 bytes.

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BYTES_PER_MS = (SAMPLE_RATE * 2 * CHANNELS) / 1000;

// A buffer whose start time differs from the expected position by more than
// this (for example after a capture restart) starts a new chunk.
const DISCONTINUITY_MS = 100;

/** Wrap raw PCM in a 44-byte WAV header (what liturgos-auditor expects in `file`). */
export function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Cuts a continuous PCM stream into fixed-length chunks that carry their
 * wall-clock start and end (epoch milliseconds). Chunks never mix audio from
 * before and after a discontinuity.
 */
export class Chunker {
  #chunkBytes;
  #parts = [];
  #bytes = 0;
  #startMs = 0;
  #seq = 0;

  constructor({ chunkMs }) {
    this.#chunkBytes = chunkMs * BYTES_PER_MS;
  }

  /** Feed PCM whose first byte is at `startMs`. Returns the chunks completed by this call. */
  push(pcm, startMs) {
    const out = [];
    if (this.#bytes > 0) {
      const expected = this.#startMs + this.#bytes / BYTES_PER_MS;
      if (Math.abs(startMs - expected) > DISCONTINUITY_MS) out.push(this.#take());
    }
    if (this.#bytes === 0) this.#startMs = startMs;
    let rest = pcm;
    while (this.#bytes + rest.length >= this.#chunkBytes) {
      const take = this.#chunkBytes - this.#bytes;
      this.#parts.push(rest.subarray(0, take));
      this.#bytes += take;
      rest = rest.subarray(take);
      out.push(this.#take());
    }
    if (rest.length > 0) {
      this.#parts.push(rest);
      this.#bytes += rest.length;
    }
    return out;
  }

  /** Emit whatever is pending (used on shutdown). */
  flush() {
    return this.#bytes > 0 ? this.#take() : null;
  }

  #take() {
    const pcm = Buffer.concat(this.#parts, this.#bytes);
    const startMs = this.#startMs;
    const endMs = Math.round(startMs + pcm.length / BYTES_PER_MS);
    const chunk = { seq: this.#seq++, startMs, endMs, pcm };
    this.#parts = [];
    this.#bytes = 0;
    this.#startMs = endMs;
    return chunk;
  }
}
