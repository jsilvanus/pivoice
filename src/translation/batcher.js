/**
 * Micro-batches segments for one translation direction (plan §5.2 steps 4 and 6).
 *
 * A batch is sent `windowMs` after its first segment, or at once when it reaches `maxSegments`
 * or `maxChars`. At most `maxInFlight` batches run at a time; while that is full, segments wait.
 * The waiting queue is bounded: past `maxQueued` the oldest segment is dropped and reported.
 * No timer exists while the queue is empty.
 */
export class Batcher {
  #windowMs;
  #maxSegments;
  #maxChars;
  #maxInFlight;
  #maxQueued;
  #send;
  #onDrop;
  #setTimeout;
  #clearTimeout;
  #queue = [];
  #timer = null;
  #inFlight = 0;
  /** Set when a batch was due but the in-flight window was full. */
  #due = false;
  #closed = false;
  #stats = { batches: 0, segments: 0, dropped: 0 };

  constructor({
    send,
    onDrop = () => {},
    windowMs = 300,
    maxSegments = 8,
    maxChars = 2000,
    maxInFlight = 2,
    maxQueued = 50,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    if (typeof send !== 'function') throw new TypeError('send is required');
    this.#send = send;
    this.#onDrop = onDrop;
    this.#windowMs = windowMs;
    this.#maxSegments = maxSegments;
    this.#maxChars = maxChars;
    this.#maxInFlight = maxInFlight;
    this.#maxQueued = maxQueued;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
  }

  get queued() {
    return this.#queue.length;
  }

  get inFlight() {
    return this.#inFlight;
  }

  /** `segment.text` is required; everything else is passed through to `send`. */
  add(segment) {
    if (this.#closed) return;
    this.#queue.push(segment);
    while (this.#queue.length > this.#maxQueued) {
      this.#stats.dropped++;
      this.#onDrop(this.#queue.shift(), 'queueFull');
    }
    if (this.#full()) this.#flush();
    else if (!this.#timer) this.#arm();
  }

  /** Stops timers and drops what is waiting (reported as `closed`). Batches in flight finish. */
  close() {
    this.#closed = true;
    this.#disarm();
    for (const segment of this.#queue.splice(0)) this.#onDrop(segment, 'closed');
  }

  status() {
    return { queued: this.#queue.length, inFlight: this.#inFlight, ...this.#stats };
  }

  #chars(count = this.#queue.length) {
    let chars = 0;
    for (let i = 0; i < count; i++) chars += this.#queue[i].text.length;
    return chars;
  }

  #full() {
    return this.#queue.length >= this.#maxSegments || this.#chars() >= this.#maxChars;
  }

  #arm() {
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, this.#windowMs);
    this.#timer?.unref?.();
  }

  #disarm() {
    if (this.#timer) this.#clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Takes the next batch off the queue: up to maxSegments, and within maxChars (at least one). */
  #take() {
    let count = 0;
    let chars = 0;
    while (count < this.#queue.length && count < this.#maxSegments) {
      const next = this.#queue[count].text.length;
      if (count > 0 && chars + next > this.#maxChars) break;
      chars += next;
      count++;
    }
    return this.#queue.splice(0, count);
  }

  #flush() {
    this.#disarm();
    this.#due = false;
    while (this.#queue.length > 0 && this.#inFlight < this.#maxInFlight && !this.#closed) {
      const batch = this.#take();
      this.#inFlight++;
      this.#stats.batches++;
      this.#stats.segments += batch.length;
      Promise.resolve()
        .then(() => this.#send(batch))
        .catch(() => {})
        .finally(() => {
          this.#inFlight--;
          // Segments that waited behind a full in-flight window go now if a batch is due.
          if (this.#queue.length > 0 && !this.#closed) {
            if (this.#due || this.#full()) this.#flush();
            else if (!this.#timer) this.#arm();
          }
        });
    }
    if (this.#queue.length > 0) this.#due = true;
  }
}
