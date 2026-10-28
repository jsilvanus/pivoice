import { EventEmitter } from 'node:events';
import path from 'node:path';

const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const MODEL_SAMPLES = FRAME_SAMPLES + CONTEXT_SAMPLES;

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
  #context = new Float32Array(CONTEXT_SAMPLES);
  #pending = Buffer.alloc(0);
  #queue = Promise.resolve();
  #ready = false;
  #error = null;
  #speaking = false;
  #lastSpeechAt = -Infinity;
  #status = { available: false, ready: false, speaking: false, probability: null, at: null, error: null };

  constructor({ modelPath = process.env.PIVOICE_SILERO_MODEL_PATH || path.resolve('models/silero_vad.onnx'), threshold = 0.55, hangoverMs = 350 } = {}) {
    super();
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
      const ort = await import('onnxruntime-node');
      this.#runtime = ort;
      this.#session = await ort.InferenceSession.create(this.#modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
      });
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
      const samples = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) samples[i] = frame.readInt16LE(i * 2) / 32768;
      const at = endMs;
      this.#queue = this.#queue.then(() => this.#infer(samples, at)).catch((error) => {
        this.#error = error;
        this.#status = { ...this.#status, error: error.message };
        this.emit('status', this.status);
      });
    }
  }

  async #infer(samples, at) {
    const input = new Float32Array(MODEL_SAMPLES);
    input.set(this.#context, 0);
    input.set(samples, CONTEXT_SAMPLES);
    const feeds = {
      input: new this.#runtime.Tensor('float32', input, [1, MODEL_SAMPLES]),
      state: new this.#runtime.Tensor('float32', this.#state, [2, 1, 128]),
      sr: new this.#runtime.Tensor('int64', BigInt64Array.of(16000n), []),
    };
    const result = await this.#session.run(feeds);
    const probability = Math.max(0, Math.min(1, Number(result.output.data[0])));
    this.#state = Float32Array.from(result.stateN.data);
    this.#context = samples.slice(-CONTEXT_SAMPLES);
    if (probability >= this.#threshold) this.#lastSpeechAt = at;
    const nextSpeaking = probability >= this.#threshold || (this.#speaking && at - this.#lastSpeechAt <= this.#hangoverMs);
    const changed = nextSpeaking !== this.#speaking;
    this.#speaking = nextSpeaking;
    this.#status = { available: true, ready: true, speaking: nextSpeaking, probability, at, error: null };
    this.emit('frame', this.status);
    if (changed) this.emit(nextSpeaking ? 'speech' : 'silence', this.status);
    this.emit('status', this.status);
  }

  reset() {
    this.#pending = Buffer.alloc(0);
    this.#state = new Float32Array(2 * 128);
    this.#context = new Float32Array(CONTEXT_SAMPLES);
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
