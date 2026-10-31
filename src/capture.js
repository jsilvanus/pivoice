import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BYTES_PER_MS, CHANNELS, SAMPLE_RATE } from './pcm.js';
import { rms } from './vad.js';

/** A restart counts as healthy (and resets the backoff) after this long. */
const STABLE_AFTER_MS = 30_000;

export function ffmpegCaptureArgs({ device, playbackDevice, channels, sampleRate }) {
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    // Timestamp ALSA packets against the host wall clock at the capture input.
    // Raw PCM pipes cannot carry packet PTS, so the supervisor maps emitted
    // samples onto this wall-clock-anchored stream timeline.
    '-use_wallclock_as_timestamps', '1', '-f', 'alsa', '-channels', String(channels), '-sample_rate', String(sampleRate), '-i', device,
    // Analysis branch: fixed 16 kHz mono PCM for metering, VAD and transcription (left channel only).
    '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
    // Source-quality branch: preserve the configured capture rate and channel count (left channel only).
    '-map', '0:a:0', '-af', channels === 1 ? 'pan=mono|c0=c0' : 'pan=stereo|c0=c0|c1=0*c0', '-ar', String(sampleRate), '-f', 's16le', 'pipe:3',
  ];
  if (playbackDevice) {
    args.push(
      // Playback branch: push captured audio back to the ALSA playback device (e.g. Hama headphone output, left only).
      '-map', '0:a:0', '-af', 'pan=stereo|c0=c0|c1=0*c0', '-ar', String(sampleRate), '-f', 'alsa', playbackDevice,
    );
  }
  return args;
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
  #sourceBytes = 0;
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
      playbackDevice: this.#config.mode === 'alsa' ? (this.#config.playbackDevice ?? null) : null,
      running: this.#active,
      state: this.#state,
      restarts: this.#restarts,
      lastError: this.#lastError,
    };
  }

  #launch() {
    this.#base = null;
    this.#launchedAt = this.#now();
    this.#bytes = 0;
    this.#sourceBytes = 0;

    if (this.#config.mode === 'simulated') {
      this.#setState('running');
      const analysisFrame = Buffer.alloc(BYTES_PER_MS * 100);
      const sourceBytesPerMs = this.#config.sampleRate * this.#config.channels * 2 / 1000;
      const sourceFrame = Buffer.alloc(sourceBytesPerMs * 100);
      this.#timer = setInterval(() => {
        this.#onData(analysisFrame, 'pcm');
        this.#onData(sourceFrame, 'source');
      }, 100);
      return;
    }

    const child = this.#spawn('ffmpeg', ffmpegCaptureArgs(this.#config), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#setState('running');
    child.stdout.on('data', (buf) => {
      if (this.#child === child) this.#onData(buf, 'pcm');
    });
    child.stdio?.[3]?.on('data', (buf) => {
      if (this.#child === child) this.#onData(buf, 'source');
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

  #onData(buf, stream = 'pcm') {
    if (!this.#active) return;
    const sourceBytesPerMs = this.#config.sampleRate * this.#config.channels * 2 / 1000;
    const bytesPerMs = stream === 'source' ? sourceBytesPerMs : BYTES_PER_MS;
    if (this.#base === null) this.#base = this.#now();
    const startMs = Math.round(this.#base + (stream === 'source' ? this.#sourceBytes : this.#bytes) / bytesPerMs);
    if (stream === 'source') this.#sourceBytes += buf.length;
    else this.#bytes += buf.length;
    if (this.#now() - this.#launchedAt > STABLE_AFTER_MS) this.#backoffMs = this.#minRestartMs;
    this.emit(stream, { pcm: buf, startMs });
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


/** Capture a short 16 kHz mono probe and return its RMS level in dBFS. */
export function probeAudio({ device, channels, sampleRate, durationSeconds = 1, spawn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'alsa', '-channels', String(channels), '-sample_rate', String(sampleRate), '-i', device,
      '-t', String(durationSeconds), '-af', 'pan=mono|c0=c0', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (buf) => chunks.push(buf));
    child.stderr?.on('data', (buf) => { stderr = buf.toString().slice(-300); });
    child.once('error', (err) => reject(new Error(err.code === 'ENOENT' ? 'ffmpeg is not installed' : err.message)));
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`audio probe failed (${code ?? signal})${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const level = rms(pcm);
      resolve(level > 0 ? 20 * Math.log10(level / 32768) : -Infinity);
    });
  });
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
      devices: [{ id: 'simulated', card: -1, device: -1, cardName: 'Simulated', deviceName: 'Silent test source', capture: true, playback: true }],
      error: null,
    });
  }
  return new Promise((resolve) => {
    execFile('arecord', ['-l'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ devices: [], error: err.code === 'ENOENT' ? 'arecord is not installed (alsa-utils)' : 'arecord -l failed' });
        return;
      }
      const captureDevices = parseArecordList(String(stdout));
      execFile('aplay', ['-l'], { timeout: 5000 }, (aplayErr, aplayStdout) => {
        if (aplayErr) {
          resolve({ devices: captureDevices.map((d) => ({ ...d, capture: true, playback: false })), error: null });
          return;
        }
        const playbackDevices = parseArecordList(String(aplayStdout));
        const map = new Map();
        for (const d of captureDevices) {
          map.set(d.id, { ...d, capture: true, playback: false });
        }
        for (const p of playbackDevices) {
          if (map.has(p.id)) {
            map.get(p.id).playback = true;
          } else {
            map.set(p.id, { ...p, capture: false, playback: true });
          }
        }
        resolve({ devices: [...map.values()], error: null });
      });
    });
  });
}

/** Parse ALSA card from device string (e.g. "hw:1,0", "plughw:1,0", "hw:CARD=Device,DEV=0"). */
export function parseCardFromDevice(device) {
  if (!device || device === 'default' || device === 'simulated') return 'default';
  const cardMatch = device.match(/CARD=([^,]+)/i);
  if (cardMatch) return cardMatch[1];
  const hwMatch = device.match(/^(?:plug)?hw:([^,]+)/);
  if (hwMatch) return hwMatch[1];
  return device;
}

/** Parses `amixer scontents` output into structured mixer controls. */
export function parseAmixerScontents(text) {
  const controls = [];
  const blocks = text.split(/(?=Simple mixer control )/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(/^Simple mixer control '([^']+)',(\d+)/m);
    if (!headerMatch) continue;
    const name = headerMatch[1];
    const index = Number(headerMatch[2]);
    const capsMatch = trimmed.match(/Capabilities:\s*(.+)/);
    const capabilities = capsMatch ? capsMatch[1].trim().split(/\s+/) : [];

    const limitsMatch = trimmed.match(/Limits:(?:\s*\w+)?\s*(\d+)\s*-\s*(\d+)/);
    const limits = limitsMatch ? { min: Number(limitsMatch[1]), max: Number(limitsMatch[2]) } : null;

    const items = [];
    for (const line of trimmed.split('\n')) {
      const lineMatch = line.match(/^\s*(Front Left|Front Right|Mono|Front|Rear|Surround):\s*(.+)$/);
      if (lineMatch) {
        const channel = lineMatch[1];
        const rest = lineMatch[2].trim();
        if (!rest) continue;

        const rawMatch = rest.match(/(?:Playback|Capture)?\s*(\d+)\b/);
        const raw = rawMatch ? Number(rawMatch[1]) : null;

        const brackets = [...rest.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
        let volumePercent = null;
        let db = null;
        let switchState = null;

        for (const b of brackets) {
          if (b.endsWith('%')) volumePercent = Number(b.slice(0, -1));
          else if (b.endsWith('dB')) db = b;
          else if (b === 'on') switchState = true;
          else if (b === 'off') switchState = false;
        }

        if (raw !== null || volumePercent !== null || db !== null || switchState !== null) {
          items.push({ channel, raw, volumePercent, db, switch: switchState });
        }
      }
    }
    controls.push({ name, index, capabilities, limits, items });
  }
  return controls;
}

export function createSimulatedMixer() {
  return [
    {
      name: 'Master',
      index: 0,
      capabilities: ['pvolume', 'pswitch', 'pswitch-joined'],
      limits: { min: 0, max: 64 },
      items: [
        { channel: 'Front Left', raw: 48, volumePercent: 75, db: '-6.00dB', switch: true },
        { channel: 'Front Right', raw: 48, volumePercent: 75, db: '-6.00dB', switch: true },
      ],
    },
    {
      name: 'Mic',
      index: 0,
      capabilities: ['cvolume', 'cswitch', 'cswitch-joined'],
      limits: { min: 0, max: 64 },
      items: [
        { channel: 'Front Left', raw: 10, volumePercent: 15, db: '-24.00dB', switch: true },
        { channel: 'Front Right', raw: 10, volumePercent: 15, db: '-24.00dB', switch: true },
      ],
    },
    {
      name: 'Mic Boost',
      index: 0,
      capabilities: ['cswitch', 'cswitch-joined'],
      limits: null,
      items: [
        { channel: 'Mono', raw: null, volumePercent: null, db: null, switch: false },
      ],
    },
    {
      name: 'Capture',
      index: 0,
      capabilities: ['cvolume', 'cswitch', 'cswitch-joined'],
      limits: { min: 0, max: 64 },
      items: [
        { channel: 'Front Left', raw: 32, volumePercent: 50, db: '-12.00dB', switch: true },
        { channel: 'Front Right', raw: 32, volumePercent: 50, db: '-12.00dB', switch: true },
      ],
    },
  ];
}

export function getAudioMixer({ mode, card = 'default', execFile = nodeExecFile, simulatedState }) {
  if (mode === 'simulated') {
    return Promise.resolve({
      card: String(card),
      controls: simulatedState || createSimulatedMixer(),
      error: null,
    });
  }
  return new Promise((resolve) => {
    const args = ['scontents'];
    if (card && card !== 'default') {
      args.unshift('-c', String(card));
    }
    execFile('amixer', args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({
          card: String(card),
          controls: [],
          error: err.code === 'ENOENT' ? 'amixer is not installed (alsa-utils)' : `amixer failed: ${err.message}`,
        });
        return;
      }
      resolve({ card: String(card), controls: parseAmixerScontents(String(stdout)), error: null });
    });
  });
}

export function setAudioMixer({ mode, card = 'default', updates = [], execFile = nodeExecFile, simulatedState }) {
  if (mode === 'simulated') {
    const state = simulatedState || createSimulatedMixer();
    for (const u of updates) {
      if (!u || !u.control) continue;
      const ctrl = state.find((c) => c.name.toLowerCase() === u.control.toLowerCase());
      if (ctrl) {
        for (const item of ctrl.items) {
          if (u.volume !== undefined && u.volume !== null) {
            const num = typeof u.volume === 'number' ? u.volume : parseInt(u.volume, 10);
            if (!Number.isNaN(num)) item.volumePercent = Math.min(100, Math.max(0, num));
          }
          if (u.switch !== undefined && u.switch !== null) {
            item.switch = Boolean(u.switch);
          }
          if (u.mute !== undefined && u.mute !== null) {
            item.switch = !u.mute;
          }
        }
      }
    }
    return Promise.resolve({ card: String(card), controls: state, error: null });
  }

  return new Promise((resolve) => {
    const runUpdate = (index) => {
      if (index >= updates.length) {
        getAudioMixer({ mode, card, execFile }).then(resolve);
        return;
      }
      const u = updates[index];
      if (!u || !u.control) {
        runUpdate(index + 1);
        return;
      }
      const args = [];
      if (card && card !== 'default') {
        args.push('-c', String(card));
      }
      args.push('sset', u.control);
      if (u.volume !== undefined && u.volume !== null) {
        args.push(typeof u.volume === 'number' ? `${u.volume}%` : String(u.volume));
      }
      if (u.switch !== undefined && u.switch !== null) {
        args.push(u.switch ? 'on' : 'off');
      }
      if (u.mute !== undefined && u.mute !== null) {
        args.push(u.mute ? 'mute' : 'unmute');
      }
      execFile('amixer', args, { timeout: 5000 }, (err) => {
        if (err) {
          resolve({
            card: String(card),
            controls: [],
            error: err.code === 'ENOENT' ? 'amixer is not installed (alsa-utils)' : `amixer sset failed: ${err.message}`,
          });
          return;
        }
        runUpdate(index + 1);
      });
    };
    runUpdate(0);
  });
}
