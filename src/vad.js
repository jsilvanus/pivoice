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


const SPECTRAL_WINDOW_SAMPLES = 1024;
const SPECTRAL_EPS = 1e-12;

/**
 * Incremental heuristic music/speech classifier for 16 kHz mono PCM16.
 * RMS gates the expensive spectral work; quiet frames skip the FFT entirely.
 */
export class SpectralClassifier {
  #thresholdRms;
  #flatnessThreshold;
  #zcrThreshold;
  #pending = Buffer.alloc(0);
  #last = { label: 'silence', confidence: 1, features: null };

  constructor({ thresholdDb = -45, flatnessThreshold = 0.4, zcrThreshold = 0.15 } = {}) {
    this.#thresholdRms = 32768 * 10 ** (thresholdDb / 20);
    this.#flatnessThreshold = flatnessThreshold;
    this.#zcrThreshold = zcrThreshold;
  }

  get status() { return this.#last; }

  push(pcm) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, pcm]) : pcm;
    const frameBytes = SPECTRAL_WINDOW_SAMPLES * 2;
    while (this.#pending.length >= frameBytes) {
      this.#last = this.#classifyFrame(this.#pending.subarray(0, frameBytes));
      this.#pending = this.#pending.subarray(frameBytes);
    }
    return this.#last;
  }

  #classifyFrame(frame) {
    const energy = rms(frame);
    if (energy < this.#thresholdRms) {
      return { label: 'silence', confidence: 1, features: { rmsDbfs: dbfs(energy), flatness: null, zcr: null, centroidHz: null } };
    }
    const n = SPECTRAL_WINDOW_SAMPLES;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let crossings = 0;
    let previous = frame.readInt16LE(0);
    for (let i = 0; i < n; i++) {
      const sample = frame.readInt16LE(i * 2) / 32768;
      if (i > 0 && ((sample >= 0) !== (previous >= 0))) crossings++;
      previous = sample;
      re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    fft(re, im);
    let logSum = 0; let sumMag = 0; let weightedHz = 0; let bins = 0;
    for (let i = 1; i <= n / 2; i++) {
      const mag = Math.hypot(re[i], im[i]);
      logSum += Math.log(mag + SPECTRAL_EPS);
      sumMag += mag + SPECTRAL_EPS;
      weightedHz += (i * 16000 / n) * mag;
      bins++;
    }
    const flatness = Math.exp(logSum / bins) / (sumMag / bins);
    const zcr = crossings / (n - 1);
    const centroidHz = weightedHz / Math.max(SPECTRAL_EPS, sumMag);
    const flatnessVote = flatness > this.#flatnessThreshold ? 1 : -1;
    const zcrVote = zcr > this.#zcrThreshold ? 1 : -1;
    const label = flatnessVote + zcrVote >= 0 ? 'speech' : 'music';
    const flatnessDist = Math.min(1, Math.abs(flatness - this.#flatnessThreshold) / this.#flatnessThreshold);
    const zcrDist = Math.min(1, Math.abs(zcr - this.#zcrThreshold) / this.#zcrThreshold);
    const confidence = flatnessVote === zcrVote
      ? Math.min(1, 0.6 + 0.2 * (flatnessDist + zcrDist))
      : Math.max(0.4, 0.5 + 0.1 * (flatnessDist - zcrDist));
    return { label, confidence: Math.round(confidence * 100) / 100, features: { rmsDbfs: dbfs(energy), flatness, zcr, centroidHz } };
  }
}

function dbfs(value) { return value <= 0 ? -120 : 20 * Math.log10(value / 32768); }

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr0 = Math.cos(angle); const wi0 = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1; let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j]; const ui = im[i + j];
        const vr = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const vi = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const next = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0; wr = next;
      }
    }
  }
}
