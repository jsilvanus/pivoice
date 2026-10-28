// Bounded rolling PCM history. Input is 16 kHz mono S16LE (32 bytes/ms).
// Capture keeps feeding this while downstream transcription sessions are closed.
export class PcmRingBuffer {
  #maxBytes;
  #parts = [];
  #bytes = 0;

  constructor({ seconds = 5, maxSeconds = 30 } = {}) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > maxSeconds) {
      throw new RangeError(`seconds must be between 0 and ${maxSeconds}`);
    }
    this.#maxBytes = Math.floor(seconds * 32_000);
  }

  get durationMs() { return this.#bytes / 32; }

  configureSeconds(seconds, maxSeconds = 30) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > maxSeconds) {
      throw new RangeError(`seconds must be between 0 and ${maxSeconds}`);
    }
    this.#maxBytes = Math.floor(seconds * 32_000);
    this.#trim();
  }

  push(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || this.#maxBytes === 0) return;
    // Copy input: capture owns/reuses its chunks independently.
    const copy = Buffer.from(pcm);
    this.#parts.push(copy);
    this.#bytes += copy.length;
    this.#trim();
  }

  snapshot() {
    return Buffer.concat(this.#parts, this.#bytes);
  }

  clear() {
    this.#parts = [];
    this.#bytes = 0;
  }

  #trim() {
    while (this.#bytes > this.#maxBytes && this.#parts.length) {
      const excess = this.#bytes - this.#maxBytes;
      const first = this.#parts[0];
      if (first.length <= excess) {
        this.#parts.shift();
        this.#bytes -= first.length;
      } else {
        // Copy the retained suffix so a small view cannot keep the whole old chunk alive.
        this.#parts[0] = Buffer.from(first.subarray(excess));
        this.#bytes -= excess;
      }
    }
  }
}
