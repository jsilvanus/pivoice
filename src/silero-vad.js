import { EventEmitter } from 'node:events';
import path from 'node:path';

const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const MODEL_SAMPLES = FRAME_SAMPLES + CONTEXT_SAMPLES;
const PROBABILITY_BUCKETS = 10;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Streaming Silero VAD v5/v6 ONNX wrapper for 16 kHz mono PCM16.
 * Frames are evaluated sequentially to preserve recurrent model state.
 */
export class SileroVad extends EventEmitter {
  #modelPath;
  #threshold;
  #hangoverMs;
  #session = null;
  #runtime = null;
  #state = new Float32Array(2 * 128);
  #input = new Float32Array(MODEL_SAMPLES);
  #feeds = null;
  #statusEveryFrames;
  #framesSinceEmit = Infinity;
  #lastBucket = null;
  #pending = Buffer.alloc(0);
  #queue = Promise.resolve();
  #ready = false;
  #error = null;
  #injected = null;
  #speaking = false;
  #lastSpeechAt = -Infinity;
  #status = { available: false, ready: false, speaking: false, probability: null, at: null, error: null };

  /**
   * `statusHz` caps how often per-frame 'frame'/'status' events are emitted (default env
   * PIVOICE_STATUS_HZ or 5). Speech/silence transitions and probability-bucket changes
   * are always emitted immediately. `runtime`/`session` allow injecting onnxruntime (tests).
   */
  constructor({
    modelPath = process.env.PIVOICE_SILERO_MODEL_PATH || path.resolve('models/silero_vad.onnx'),
    threshold = 0.55,
    hangoverMs = 350,
    statusHz = positiveNumber(process.env.PIVOICE_STATUS_HZ, 5),
    runtime = null,
    session = null,
  } = {}) {
    super();
    // 16 kHz / 512-sample frames = 31.25 frames/s; counting frames keeps this independent of the clock.
    this.#statusEveryFrames = Math.max(1, Math.round(31.25 / positiveNumber(statusHz, 5)));
    this.#injected = runtime && session ? { runtime, session } : null;
    this.#modelPath = modelPath;
    this.#threshold = threshold;
    this.#hangoverMs = hangoverMs;
  }

  get status() { return structuredClone(this.#status); }
  get ready() { return this.#ready; }
  get speaking() { return this.#speaking; }
  get lastSpeechAt() { return Number.isFinite(this.#lastSpeechAt) ? this.#lastSpeechAt : null; }

  async initialize() {
    try {
      if (this.#injected) {
        this.#runtime = this.#injected.runtime;
        this.#session = this.#injected.session;
      } else {
        const ort = await import('onnxruntime-node');
        this.#runtime = ort;
        this.#session = await ort.InferenceSession.create(this.#modelPath, {
          executionProviders: ['cpu'],
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        });
      }
      // Tensors wrap these buffers and are reused for every frame (runs are strictly sequential).
      this.#feeds = {
        input: new this.#runtime.Tensor('float32', this.#input, [1, MODEL_SAMPLES]),
        state: new this.#runtime.Tensor('float32', this.#state, [2, 1, 128]),
        sr: new this.#runtime.Tensor('int64', BigInt64Array.of(16000n), []),
      };
      this.#ready = true;
      this.#status = { ...this.#status, available: true, ready: true, error: null };
      this.emit('status', this.status);
      return this.status;
    } catch (error) {
      this.#error = error;
      this.#status = { ...this.#status, available: false, ready: false, error: error.message };
      this.emit('status', this.status);
      return this.status;
    }
  }

  push(pcm, endMs = Date.now()) {
    if (!this.#ready || !pcm?.length) return;
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, pcm]) : pcm;
    const frameBytes = FRAME_SAMPLES * 2;
    while (this.#pending.length >= frameBytes) {
      const frame = this.#pending.subarray(0, frameBytes);
      this.#pending = this.#pending.subarray(frameBytes);
      const at = endMs;
      // `frame` is a view of the caller's buffer, which is never mutated; it is converted inside #infer.
      this.#queue = this.#queue.then(() => this.#infer(frame, at)).catch((error) => {
        this.#error = error;
        this.#status = { ...this.#status, error: error.message };
        this.emit('status', this.status);
      });
    }
  }

  async #infer(frame, at) {
    const input = this.#input;
    // Context = last 64 samples of the previous frame, already at input[FRAME_SAMPLES..]; move it to the front.
    input.copyWithin(0, FRAME_SAMPLES, MODEL_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) input[CONTEXT_SAMPLES + i] = frame.readInt16LE(i * 2) / 32768;
    const result = await this.#session.run(this.#feeds);
    const probability = Math.max(0, Math.min(1, Number(result.output.data[0])));
    this.#state.set(result.stateN.data);
    if (probability >= this.#threshold) this.#lastSpeechAt = at;
    const nextSpeaking = probability >= this.#threshold || (this.#speaking && at - this.#lastSpeechAt <= this.#hangoverMs);
    const changed = nextSpeaking !== this.#speaking;
    this.#speaking = nextSpeaking;
    this.#status = { available: true, ready: true, speaking: nextSpeaking, probability, at, error: null };
    const bucket = Math.min(PROBABILITY_BUCKETS - 1, Math.floor(probability * PROBABILITY_BUCKETS));
    const due = changed || bucket !== this.#lastBucket || ++this.#framesSinceEmit >= this.#statusEveryFrames;
    if (due) {
      this.#framesSinceEmit = 0;
      this.#lastBucket = bucket;
      this.emit('frame', this.status);
    }
    if (changed) this.emit(nextSpeaking ? 'speech' : 'silence', this.status);
    if (due) this.emit('status', this.status);
  }

  reset() {
    this.#pending = Buffer.alloc(0);
    this.#state.fill(0);
    this.#input.fill(0);
    this.#framesSinceEmit = Infinity;
    this.#lastBucket = null;
    this.#speaking = false;
    this.#lastSpeechAt = -Infinity;
    this.#queue = Promise.resolve();
    this.#status = { ...this.#status, speaking: false, probability: null, at: null };
    this.emit('status', this.status);
  }

  async close() {
    await this.#queue.catch(() => {});
    this.#session?.release?.();
    this.#session = null;
    this.#ready = false;
    this.#status = { ...this.#status, ready: false };
  }
}
