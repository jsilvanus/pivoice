import { EventEmitter } from 'node:events';

const FRAME_SIZE = 512;
const EPS = 1e-12;

/** Lightweight PCM16 spectral heuristic. Not a trained speech/music model. */
export class SpectralClassifier extends EventEmitter {
  #pending = Buffer.alloc(0);
  #sampleRate;
  #silenceRms;
  #flatnessThreshold;
  #zcrThreshold;
  #current = { label: 'unknown', confidence: null, features: null, at: null };

  constructor({ sampleRate = 16000, silenceDbfs = -55, flatnessThreshold = 0.4, zcrThreshold = 0.15 } = {}) {
    super();
    this.#sampleRate = sampleRate;
    this.#silenceRms = 32768 * 10 ** (silenceDbfs / 20);
    this.#flatnessThreshold = flatnessThreshold;
    this.#zcrThreshold = zcrThreshold;
  }

  get status() {
    return structuredClone(this.#current);
  }

  reset() {
    this.#pending = Buffer.alloc(0);
    this.#current = { label: 'unknown', confidence: null, features: null, at: null };
  }

  push(pcm, endMs = Date.now()) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, pcm]) : pcm;
    const frameBytes = FRAME_SIZE * 2;
    while (this.#pending.length >= frameBytes) {
      const frame = this.#pending.subarray(0, frameBytes);
      this.#pending = this.#pending.subarray(frameBytes);
      this.#classify(frame, endMs);
    }
    // Bound memory if an upstream discontinuity produces an unexpectedly huge buffer.
    if (this.#pending.length > frameBytes * 8) this.#pending = this.#pending.subarray(-frameBytes);
    return this.status;
  }

  #classify(frame, at) {
    const n = FRAME_SIZE;
    const samples = new Float64Array(n);
    let sumSquares = 0;
    let crossings = 0;
    for (let i = 0; i < n; i++) {
      const value = frame.readInt16LE(i * 2);
      samples[i] = value / 32768;
      sumSquares += value * value;
      if (i && ((value >= 0) !== (frame.readInt16LE((i - 1) * 2) >= 0))) crossings++;
    }
    const rms = Math.sqrt(sumSquares / n);
    const rmsDbfs = rms <= 0 ? -120 : 20 * Math.log10(rms / 32768);
    if (rms < this.#silenceRms) {
      this.#set({ label: 'silence', confidence: 1, features: { rmsDbfs, flatness: null, zcr: null, centroidHz: null }, at });
      return;
    }

    // Hann-windowed radix-2 FFT. Only the non-negative half-spectrum is needed.
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wrStep = Math.cos(angle);
      const wiStep = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let wr = 1, wi = 0;
        for (let j = 0; j < len / 2; j++) {
          const even = start + j, odd = even + len / 2;
          const tr = wr * re[odd] - wi * im[odd];
          const ti = wr * im[odd] + wi * re[odd];
          re[odd] = re[even] - tr;
          im[odd] = im[even] - ti;
          re[even] += tr;
          im[even] += ti;
          const nextWr = wr * wrStep - wi * wiStep;
          wi = wr * wiStep + wi * wrStep;
          wr = nextWr;
        }
      }
    }

    let logSum = 0, sumMag = 0, weighted = 0, total = 0, low = 0;
    const bins = n / 2;
    for (let i = 1; i < bins; i++) {
      const mag = Math.hypot(re[i], im[i]);
      const safe = mag + EPS;
      logSum += Math.log(safe);
      sumMag += safe;
      const hz = (i * this.#sampleRate) / n;
      weighted += hz * mag;
      total += mag;
      if (hz < 300) low += mag;
    }
    const flatness = sumMag > 0 ? Math.exp(logSum / (bins - 1)) / (sumMag / (bins - 1)) : 0;
    const zcr = crossings / (n - 1);
    const centroidHz = total ? weighted / total : 0;
    const flatnessMusic = flatness <= this.#flatnessThreshold;
    const zcrMusic = zcr <= this.#zcrThreshold;
    const label = flatnessMusic && zcrMusic ? 'music' : 'speech';
    const confidence = flatnessMusic === zcrMusic ? 0.75 : 0.5;
    this.#set({ label, confidence, features: { rmsDbfs, flatness, zcr, centroidHz, lowFrequencyRatio: total ? low / total : 0 }, at });
  }

  #set(next) {
    const changed = next.label !== this.#current.label;
    this.#current = next;
    this.emit('frame', this.status);
    if (changed) this.emit('change', this.status);
  }
}
