import { spawn as nodeSpawn } from 'node:child_process';
import { BYTES_PER_MS, CHANNELS, SAMPLE_RATE } from './pcm.js';

/** Radio writes are dropped (and counted) when an encoder falls this far behind. */
const MAX_BACKLOG_MS = 5000;
const STABLE_AFTER_MS = 30_000;

export function radioEncoderArgs({ rtmpUrl, bitrate }) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
    '-c:a', 'aac', '-b:a', bitrate,
    '-f', 'flv', rtmpUrl,
  ];
}

/**
 * One ffmpeg encoder per radio target, pushing audio-only RTMP to an ingest
 * (the local Tuberadio, or web-radio-relay on the VPS). Target modes:
 *   on   - encoder runs while capture runs
 *   auto - encoder runs only while the voice gate is open (start on VAD)
 *   off  - encoder never runs
 * Each encoder restarts on its own; none of them can stop capture.
 */
export class RadioOutputs {
  #spawn;
  #now;
  #minRestartMs;
  #maxRestartMs;
  #bitrate = '96k';
  #active = false;
  #voice = false;
  #outputs = new Map();

  constructor({ spawn = nodeSpawn, now = Date.now, minRestartMs = 1000, maxRestartMs = 30000 } = {}) {
    this.#spawn = spawn;
    this.#now = now;
    this.#minRestartMs = minRestartMs;
    this.#maxRestartMs = maxRestartMs;
  }

  configure({ targets, bitrate }) {
    this.#bitrate = bitrate;
    const wanted = new Map(targets.map((t) => [t.id, t]));
    for (const [id, out] of this.#outputs) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(out.target) || out.bitrate !== bitrate) {
        this.#stopOutput(out);
        this.#outputs.delete(id);
      }
    }
    for (const target of targets) {
      if (!this.#outputs.has(target.id)) {
        this.#outputs.set(target.id, {
          target, bitrate, child: null, timer: null, state: 'stopped',
          restarts: 0, lastError: null, dropped: 0, backoffMs: this.#minRestartMs, launchedAt: 0,
        });
      }
    }
    if (this.#active) for (const out of this.#outputs.values()) this.#startOutput(out);
  }

  start() {
    this.#active = true;
    for (const out of this.#outputs.values()) this.#startOutput(out);
  }

  stop() {
    this.#active = false;
    this.#voice = false;
    for (const out of this.#outputs.values()) this.#stopOutput(out);
  }

  /**
   * Voice gate changed. Auto targets start (and get the pre-roll so speech is not
   * cut) or stop. `on` targets are unaffected.
   */
  setVoice(open, preroll = null) {
    this.#voice = open;
    if (!this.#active) return;
    for (const out of this.#outputs.values()) {
      if (out.target.mode !== 'auto') continue;
      if (open) {
        this.#startOutput(out);
        if (out.child && preroll?.length) out.child.stdin.write(preroll);
      } else {
        this.#stopOutput(out);
      }
    }
  }

  /** Forward a PCM buffer to every running encoder. Never throws, never blocks. */
  write(pcm) {
    for (const out of this.#outputs.values()) {
      const stdin = out.child?.stdin;
      if (!stdin || stdin.destroyed) continue;
      if (stdin.writableLength > MAX_BACKLOG_MS * BYTES_PER_MS) {
        out.dropped++;
        continue;
      }
      stdin.write(pcm);
    }
  }

  status() {
    return [...this.#outputs.values()].map((out) => ({
      id: out.target.id,
      name: out.target.name,
      mode: out.target.mode,
      hlsUrl: out.target.hlsUrl,
      state: this.#stateOf(out),
      restarts: out.restarts,
      lastError: out.lastError,
      dropped: out.dropped,
    }));
  }

  #stateOf(out) {
    if (out.target.mode === 'off') return 'off';
    if (!out.target.rtmpUrl) return 'unconfigured';
    if (out.child) return 'running';
    if (out.target.mode === 'auto' && (!this.#active || !this.#voice)) return 'waiting';
    return out.state;
  }

  #shouldRun(out) {
    if (!this.#active) return false;
    if (out.target.mode === 'off' || !out.target.rtmpUrl) return false;
    return out.target.mode === 'on' || this.#voice;
  }

  #startOutput(out) {
    if (out.child || out.timer || !this.#shouldRun(out)) return;
    const child = this.#spawn('ffmpeg', radioEncoderArgs({ rtmpUrl: out.target.rtmpUrl, bitrate: out.bitrate }), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    out.child = child;
    out.state = 'running';
    out.launchedAt = this.#now();
    child.stdin.on('error', () => {}); // EPIPE once ffmpeg has exited; the exit handler restarts it
    child.stderr?.resume();
    child.on('error', (err) => this.#onExit(out, child, err.code === 'ENOENT' ? 'ffmpeg is not installed' : err.message));
    child.on('exit', (code, signal) => this.#onExit(out, child, `ffmpeg exited (${code ?? signal})`));
  }

  #onExit(out, child, message) {
    if (out.child !== child) return;
    out.child = null;
    out.lastError = message;
    out.restarts++;
    if (!this.#shouldRun(out)) {
      out.state = 'stopped';
      return;
    }
    if (this.#now() - out.launchedAt > STABLE_AFTER_MS) out.backoffMs = this.#minRestartMs;
    out.state = 'restarting';
    const delay = out.backoffMs;
    out.backoffMs = Math.min(this.#maxRestartMs, out.backoffMs * 2);
    out.timer = setTimeout(() => {
      out.timer = null;
      this.#startOutput(out);
    }, delay);
  }

  #stopOutput(out) {
    clearTimeout(out.timer);
    out.timer = null;
    const child = out.child;
    out.child = null;
    out.state = 'stopped';
    if (child) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  }
}
