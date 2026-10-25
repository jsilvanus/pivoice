import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BYTES_PER_MS, CHANNELS, SAMPLE_RATE } from './pcm.js';

/** A restart counts as healthy (and resets the backoff) after this long. */
const STABLE_AFTER_MS = 30_000;

export function ffmpegCaptureArgs({ device, channels, sampleRate }) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-f', 'alsa', '-channels', String(channels), '-sample_rate', String(sampleRate), '-i', device,
    '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ];
}

/**
 * Owns the single capture process (ffmpeg reading ALSA, or a silent simulated
 * source for development). Emits `pcm` with `{ pcm, startMs }` where startMs is
 * the wall-clock time of the first byte. Restarts ffmpeg with backoff; a
 * failure here never touches the radio or caption consumers beyond their input.
 */
export class CaptureSupervisor extends EventEmitter {
  #config;
  #spawn;
  #now;
  #minRestartMs;
  #maxRestartMs;
  #active = false;
  #state = 'stopped';
  #child = null;
  #timer = null;
  #backoffMs;
  #launchedAt = 0;
  #base = 0;
  #bytes = 0;
  #restarts = 0;
  #lastError = null;
  #stderrLine = '';

  constructor({ config, spawn = nodeSpawn, now = Date.now, minRestartMs = 1000, maxRestartMs = 30000 }) {
    super();
    this.#config = config;
    this.#spawn = spawn;
    this.#now = now;
    this.#minRestartMs = minRestartMs;
    this.#maxRestartMs = maxRestartMs;
    this.#backoffMs = minRestartMs;
  }

  get running() {
    return this.#active;
  }

  /** Takes effect the next time capture starts. */
  configure(config) {
    this.#config = config;
  }

  start() {
    if (this.#active) return this.status();
    this.#active = true;
    this.#backoffMs = this.#minRestartMs;
    this.#launch();
    return this.status();
  }

  stop() {
    this.#active = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    this.#child = null;
    if (child) child.kill('SIGTERM');
    this.#setState('stopped');
    return this.status();
  }

  status() {
    return {
      mode: this.#config.mode,
      device: this.#config.mode === 'alsa' ? this.#config.device : 'simulated',
      running: this.#active,
      state: this.#state,
      restarts: this.#restarts,
      lastError: this.#lastError,
    };
  }

  #launch() {
    this.#base = this.#now();
    this.#launchedAt = this.#base;
    this.#bytes = 0;

    if (this.#config.mode === 'simulated') {
      this.#setState('running');
      const frame = Buffer.alloc(BYTES_PER_MS * 100);
      this.#timer = setInterval(() => this.#onData(frame), 100);
      return;
    }

    const child = this.#spawn('ffmpeg', ffmpegCaptureArgs(this.#config), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;
    this.#setState('running');
    child.stdout.on('data', (buf) => {
      if (this.#child === child) this.#onData(buf);
    });
    child.stderr?.on('data', (buf) => {
      const lines = buf.toString().split('\n').filter((l) => l.trim());
      if (lines.length) this.#stderrLine = lines.at(-1).slice(0, 200);
    });
    child.on('error', (err) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#fail(err.code === 'ENOENT' ? 'ffmpeg is not installed' : err.message);
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#fail(`ffmpeg exited (${code ?? signal})${this.#stderrLine ? `: ${this.#stderrLine}` : ''}`);
    });
  }

  #onData(buf) {
    if (!this.#active) return;
    const startMs = Math.round(this.#base + this.#bytes / BYTES_PER_MS);
    this.#bytes += buf.length;
    if (this.#now() - this.#launchedAt > STABLE_AFTER_MS) this.#backoffMs = this.#minRestartMs;
    this.emit('pcm', { pcm: buf, startMs });
  }

  #fail(message) {
    if (!this.#active) return;
    this.#lastError = message;
    this.#restarts++;
    this.#setState('restarting');
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#maxRestartMs, this.#backoffMs * 2);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#active) this.#launch();
    }, delay);
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', this.status());
  }
}

/** Parses `arecord -l` output into capture devices. */
export function parseArecordList(text) {
  const devices = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^card (\d+): .*?\[([^\]]*)\], device (\d+): .*?\[([^\]]*)\]/);
    if (m) {
      devices.push({ id: `hw:${m[1]},${m[3]}`, card: Number(m[1]), device: Number(m[3]), cardName: m[2], deviceName: m[4] });
    }
  }
  return devices;
}

export function listAudioDevices({ mode, execFile = nodeExecFile }) {
  if (mode === 'simulated') {
    return Promise.resolve({
      devices: [{ id: 'simulated', card: -1, device: -1, cardName: 'Simulated', deviceName: 'Silent test source' }],
      error: null,
    });
  }
  return new Promise((resolve) => {
    execFile('arecord', ['-l'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ devices: [], error: err.code === 'ENOENT' ? 'arecord is not installed (alsa-utils)' : 'arecord -l failed' });
        return;
      }
      resolve({ devices: parseArecordList(String(stdout)), error: null });
    });
  });
}
