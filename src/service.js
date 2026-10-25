import { EventEmitter } from 'node:events';
import { AuditorClient } from './auditor.js';
import { CaptureSupervisor, listAudioDevices } from './capture.js';
import { RelayCaptions } from './captions/relay.js';
import { StreamOnlineWatcher } from './captions/stream-status.js';
import { YouTubeCaptions } from './captions/youtube.js';
import { Chunker } from './pcm.js';
import { RadioOutputs } from './radio.js';
import { Transcriber } from './transcriber.js';
import { VoiceGate } from './vad.js';

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Wires capture, voice detection, radio, transcription and caption delivery
 * together. Capture is shared: its PCM feeds the voice gate, the radio encoders
 * and the chunker. Every consumer follows its mode (on / off / auto) and can be
 * reconfigured without touching the others.
 */
export class PiVoiceService {
  #store;
  #now;
  #hub = new EventEmitter();
  #startedAt;
  #chunker;
  #fetchFn;
  #createSender;
  #execFile;
  #stream = null;
  #relay = null;
  #youtube = null;

  constructor({
    store, spawn, fetchFn = globalThis.fetch, createSender, execFile, now = Date.now,
    minRestartMs, maxRestartMs, staleMs,
  }) {
    this.#store = store;
    this.#now = now;
    this.#startedAt = now();
    this.#fetchFn = fetchFn;
    this.#createSender = createSender;
    this.#execFile = execFile;
    this.#hub.setMaxListeners(0);

    const cfg = store.get();
    this.capture = new CaptureSupervisor({ config: cfg.capture, spawn, now, minRestartMs, maxRestartMs });
    this.radio = new RadioOutputs({ spawn, now, minRestartMs, maxRestartMs });
    this.transcriber = new Transcriber({ now, staleMs });
    this.#chunker = new Chunker({ chunkMs: cfg.capture.chunkSeconds * 1000 });

    this.radio.configure({ targets: cfg.radio.targets, bitrate: cfg.radio.bitrate });
    this.#buildVoice(cfg);
    this.#applyAuditor(cfg);
    this.#buildCaptions(cfg);

    this.capture.on('pcm', ({ pcm, startMs }) => this.#onPcm(pcm, startMs));
    this.capture.on('state', (status) => this.#publish('capture', status));
    this.transcriber.on('transcript', (event) => this.#onTranscript(event));
    this.transcriber.on('status', (status) => this.#publish('transcription', status));
  }

  subscribe(listener) {
    const handler = (event) => listener(event);
    this.#hub.on('event', handler);
    return () => this.#hub.off('event', handler);
  }

  startCapture() {
    this.capture.start();
    this.radio.start();
    return this.status();
  }

  stopCapture() {
    this.radio.stop();
    this.capture.stop();
    this.transcriber.clear();
    return this.status();
  }

  captionsStatus() {
    const cfg = this.#store.get();
    return {
      relay: { mode: cfg.captions.relay.mode, ...this.#relay.status() },
      youtube: {
        mode: cfg.captions.youtube.mode,
        effective: this.#youtubeWanted() ? 'on' : 'off',
        stream: this.#stream.status(),
        ...this.#youtube.status(),
      },
    };
  }

  /** The YouTube stream-online watcher (auto mode). Exposed for tests and for an operator poll. */
  get streamWatcher() {
    return this.#stream;
  }

  listDevices() {
    return listAudioDevices({ mode: this.#store.get().capture.mode, execFile: this.#execFile });
  }

  /** Called after a configuration write. Restarts only what the change touches. */
  applyConfig(previous, next) {
    const changed = (section) => JSON.stringify(previous[section]) !== JSON.stringify(next[section]);

    if (changed('capture')) {
      const wasRunning = this.capture.running;
      if (wasRunning) this.stopCapture();
      this.capture.configure(next.capture);
      this.#chunker = new Chunker({ chunkMs: next.capture.chunkSeconds * 1000 });
      if (wasRunning) this.startCapture();
    }
    if (changed('voice')) this.#buildVoice(next);
    if (changed('radio')) this.radio.configure({ targets: next.radio.targets, bitrate: next.radio.bitrate });
    if (changed('auditor')) this.#applyAuditor(next);
    if (changed('captions')) this.#buildCaptions(next);
  }

  status() {
    const cfg = this.#store.get();
    return {
      startedAt: new Date(this.#startedAt).toISOString(),
      uptimeSec: Math.round((this.#now() - this.#startedAt) / 1000),
      capture: this.capture.status(),
      voice: { open: this.voice.open, lastVoiceMs: Number.isFinite(this.voice.lastVoiceMs) ? this.voice.lastVoiceMs : null },
      radio: this.radio.status(),
      transcription: { mode: cfg.auditor.mode, ...this.transcriber.status() },
      captions: this.captionsStatus(),
    };
  }

  stop() {
    this.#stream.stop();
    this.#relay.stop();
    this.#youtube.stop();
    this.stopCapture();
  }

  #buildVoice(cfg) {
    this.voice = new VoiceGate(cfg.voice);
    this.voice.on('open', ({ preroll }) => this.radio.setVoice(true, preroll));
    this.voice.on('close', () => this.radio.setVoice(false));
    this.radio.setVoice(false);
  }

  #applyAuditor(cfg) {
    const auditor = cfg.auditor.url
      ? new AuditorClient({
          url: cfg.auditor.url,
          apiKey: cfg.auditor.apiKey,
          timeoutMs: cfg.auditor.timeoutMs,
          fetchFn: this.#fetchFn,
        })
      : null;
    this.transcriber.configure({ auditor, language: cfg.auditor.language, maxQueue: cfg.auditor.maxQueue });
  }

  #buildCaptions(cfg) {
    if (this.#stream) {
      this.#stream.removeAllListeners();
      this.#stream.stop();
    }
    this.#relay?.stop();
    this.#youtube?.stop();
    this.#stream = new StreamOnlineWatcher({
      apiKey: cfg.captions.youtube.apiKey,
      videoId: cfg.captions.youtube.videoId,
      fetchFn: this.#fetchFn,
      now: this.#now,
    });
    this.#stream.on('change', () => {
      this.#publish('captions', this.captionsStatus());
      this.#syncCaptions();
    });
    this.#relay = new RelayCaptions({
      url: cfg.captions.relay.url,
      token: cfg.captions.relay.token,
      fetchFn: this.#fetchFn,
      now: this.#now,
    });
    this.#youtube = new YouTubeCaptions({
      streamKey: cfg.captions.youtube.streamKey,
      delayMs: cfg.captions.youtube.delayMs,
      createSender: this.#createSender,
    });
    this.#syncCaptions();
  }

  /** Relay runs whenever it is configured and not off. YouTube runs when wanted and configured. */
  #syncCaptions() {
    const cfg = this.#store.get();
    if (cfg.captions.relay.mode !== 'off' && this.#relay.configured) this.#relay.start();
    else this.#relay.stop();
    if (cfg.captions.youtube.mode === 'auto' && this.#stream.configured) this.#stream.start();
    else this.#stream.stop();
    try {
      if (this.#youtubeWanted()) this.#youtube.start();
      else this.#youtube.stop();
    } catch {
      // Not configured: the status shows it (configured: false). Nothing to recover from here.
    }
  }

  // YouTube "auto" means the stream is online, as reported by the stream watcher (polling the YouTube Data API).
  #youtubeWanted() {
    const mode = this.#store.get().captions.youtube.mode;
    return mode === 'on' || (mode === 'auto' && this.#stream.online);
  }

  #onPcm(pcm, startMs) {
    this.voice.push(pcm, startMs);
    this.radio.write(pcm);
    if (!this.transcriber.configured) return;
    for (const chunk of this.#chunker.push(pcm, startMs)) {
      if (this.#transcriptionWanted(chunk.startMs)) this.transcriber.enqueue(chunk);
    }
  }

  // Captions are only produced from speech, so "on" and "auto" differ only for chunks of silence.
  #transcriptionWanted(atMs) {
    const mode = this.#store.get().auditor.mode;
    return mode === 'on' || (mode === 'auto' && this.voice.lastVoiceMs >= atMs);
  }

  #onTranscript(event) {
    this.#publish('transcript', event);
    const mode = this.#store.get().captions.relay.mode;
    if (mode === 'on' || (mode === 'auto' && this.voice.lastVoiceMs >= event.startMs)) this.#relay.push(event);
    if (this.#youtubeWanted()) this.#youtube.push(event);
  }

  #publish(type, data) {
    this.#hub.emit('event', { type, data });
  }
}
