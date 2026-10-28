import { EventEmitter } from 'node:events';
import { AuditorClient } from './auditor.js';
import { AuditorLiveClient } from './auditor-live.js';
import { CaptureSupervisor, listAudioDevices, probeAudio } from './capture.js';
import { RelayCaptions } from './captions/relay.js';
import { StreamOnlineWatcher } from './captions/stream-status.js';
import { YouTubeCaptions } from './captions/youtube.js';
import { Chunker } from './pcm.js';
import { PcmRingBuffer } from './preroll.js';
import { RadioOutputs } from './radio.js';
import { Transcriber } from './transcriber.js';
import { VoiceGate } from './vad.js';
import { SpectralClassifier } from './spectral.js';
import { SileroVad } from './silero-vad.js';
import { PiVoiceTelemetryPublisher } from './telemetry.js';

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
  #preroll;
  #fetchFn;
  #createSender;
  #execFile;
  #spawn;
  #autoTimer = null;
  #autoCaptureStartedAt = null;
  #stream = null;
  #relay = null;
  #youtube = null;
  #telemetry = null;
  #liveAuditor = null;
  #meter = { rmsDbfs: null, peakDbfs: null, measuredAt: 0 };
  #spectral;
  #silero;
  #sileroInit = null;
  #auditorIdleTimer = null;
  #speechActive = false;
  #musicActive = false;

  constructor({
    store, spawn, fetchFn = globalThis.fetch, createSender, execFile, now = Date.now,
    minRestartMs, maxRestartMs, staleMs, telemetryHost, telemetryPort = 3101,
  }) {
    this.#store = store;
    this.#now = now;
    this.#startedAt = now();
    this.#fetchFn = fetchFn;
    this.#createSender = createSender;
    this.#execFile = execFile;
    this.#spawn = spawn;
    this.#hub.setMaxListeners(0);

    const cfg = store.get();
    this.capture = new CaptureSupervisor({ config: cfg.capture, spawn, now, minRestartMs, maxRestartMs });
    this.radio = new RadioOutputs({ spawn, now, minRestartMs, maxRestartMs });
    this.transcriber = new Transcriber({ now, staleMs });
    this.#chunker = new Chunker({ chunkMs: cfg.capture.chunkSeconds * 1000 });
    this.#preroll = new PcmRingBuffer({ seconds: cfg.activity.prerollSeconds });

    this.radio.configure({ targets: cfg.radio.targets, bitrate: cfg.radio.bitrate, sampleRate: cfg.capture.sampleRate, channels: cfg.capture.channels });
    this.#buildVoice(cfg);
    this.#spectral = new SpectralClassifier({ sampleRate: 16000 });
    this.#spectral.on('change', (status) => {
      this.#publish('classification', status);
      this.#musicActive = status.label === 'music';
      if (this.#musicActive) this.#activityDetected('music');
      else this.#scheduleAuditorIdleClose();
    });
    this.#silero = new SileroVad();
    this.#silero.on('speech', (status) => {
      this.#speechActive = true;
      this.#publish('speech-detection', status);
      this.#activityDetected('speech');
    });
    this.#silero.on('silence', (status) => {
      this.#speechActive = false;
      this.#publish('speech-detection', status);
      this.#scheduleAuditorIdleClose();
    });
    this.#silero.on('status', (status) => {
      this.#speechActive = status.speaking;
      this.#publish('speech-detection', status);
    });
    this.#sileroInit = this.#silero.initialize();
    this.#applyAuditor(cfg);
    this.#buildCaptions(cfg);

    this.capture.on('pcm', ({ pcm, startMs }) => this.#onPcm(pcm, startMs));
    this.capture.on('source', ({ pcm }) => this.radio.write(pcm));
    this.capture.on('state', (status) => {
      // A restarted FFmpeg process starts a new sample-time epoch. Never join
      // buffered pre-restart audio to the new capture timeline.
      if (status.state === 'restarting') {
        this.#preroll.clear();
        this.#chunker = new Chunker({ chunkMs: this.#store.get().capture.chunkSeconds * 1000 });
        this.#spectral.reset();
        this.#silero.reset();
        this.#speechActive = false;
        this.#musicActive = false;
      }
      this.#publish('capture', status);
      this.#telemetry?.sendSnapshot();
    });
    this.transcriber.on('transcript', (event) => this.#onTranscript(event));
    this.transcriber.on('status', (status) => this.#publish('transcription', status));

    if (telemetryHost) {
      this.#telemetry = new PiVoiceTelemetryPublisher({
        host: telemetryHost,
        port: telemetryPort,
        now: this.#now,
        snapshot: () => this.telemetrySnapshot(),
      });
      this.#telemetry.start();
    }
  }

  subscribe(listener) {
    const handler = (event) => listener(event);
    this.#hub.on('event', handler);
    return () => this.#hub.off('event', handler);
  }

  /** Start according to the persisted capture policy (used at process startup). */
  startConfiguredCapture() {
    const cfg = this.#store.get().capture;
    if (cfg.policy === 'off') return this.status();
    if (cfg.policy === 'auto') {
      this.#scheduleAutoProbe(0);
      return this.status();
    }
    return this.startCapture();
  }

  /** Explicit operator start; overrides auto polling until explicitly stopped. */
  startCapture() {
    clearTimeout(this.#autoTimer);
    this.#autoTimer = null;
    this.#autoCaptureStartedAt = null;
    this.capture.start();
    this.radio.start();
    this.#maybeStartAuditorLive('capture_start');
    return this.status();
  }

  stopCapture() {
    clearTimeout(this.#autoTimer);
    this.#autoTimer = null;
    this.#stopCaptureNow();
    return this.status();
  }

  #stopCaptureNow() {
    this.radio.stop();
    this.capture.stop();
    this.#preroll.clear();
    this.#spectral.reset();
    this.#silero.reset();
    this.transcriber.clear();
    this.#liveAuditor?.stop();
    this.#autoCaptureStartedAt = null;
    this.#telemetry?.sendSnapshot();
  }

  #scheduleAutoProbe(delayMs) {
    clearTimeout(this.#autoTimer);
    const cfg = this.#store.get();
    if (cfg.capture.policy !== 'auto') return;
    this.#autoTimer = setTimeout(async () => {
      this.#autoTimer = null;
      if (this.capture.running || this.#store.get().capture.policy !== 'auto') return;
      try {
        const capture = this.#store.get().capture;
        const levelDbfs = capture.mode === 'simulated' ? -120 : await probeAudio({
          device: capture.device,
          channels: capture.channels,
          sampleRate: capture.sampleRate,
          durationSeconds: capture.autoProbeSeconds,
          spawn: this.#spawn,
        });
        this.#publish('capture-probe', { at: new Date(this.#now()).toISOString(), levelDbfs });
        if (levelDbfs >= this.#store.get().voice.thresholdDb) {
          this.#autoCaptureStartedAt = this.#now();
          this.capture.start();
          this.radio.start();
          this.#maybeStartAuditorLive('capture_start');
        } else {
          this.#scheduleAutoProbe(capture.autoPollMode === 'continuous' ? 0 : capture.autoPollSeconds * 1000);
        }
      } catch (err) {
        this.#publish('capture-probe', { at: new Date(this.#now()).toISOString(), error: err.message });
        this.#scheduleAutoProbe(this.#store.get().capture.autoPollMode === 'continuous' ? 0 : this.#store.get().capture.autoPollSeconds * 1000);
      }
    }, Math.max(0, delayMs));
    this.#autoTimer.unref?.();
  }

  /** Notify PiGateway when a status/health poll has completed. */
  pollCompleted() {
    this.#telemetry?.sendPollCompleted();
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
      if (wasRunning) this.startConfiguredCapture();
    }
    if (changed('voice')) this.#buildVoice(next);
    if (changed('radio') || changed('capture')) this.radio.configure({ targets: next.radio.targets, bitrate: next.radio.bitrate, sampleRate: next.capture.sampleRate, channels: next.capture.channels });
    if (changed('auditor')) this.#applyAuditor(next);
    if (changed('activity')) this.#preroll.configureSeconds(next.activity.prerollSeconds);
    if (changed('captions')) this.#buildCaptions(next);
  }

  status() {
    const cfg = this.#store.get();
    return {
      startedAt: new Date(this.#startedAt).toISOString(),
      uptimeSec: Math.round((this.#now() - this.#startedAt) / 1000),
      capture: { ...this.capture.status(), policy: cfg.capture.policy, autoPollMode: cfg.capture.autoPollMode, autoPollSeconds: cfg.capture.autoPollSeconds },
      auditorLive: this.#liveAuditor?.status() ?? { configured: false, running: false, sessionId: null },
      preRoll: { durationMs: this.#preroll.durationMs, configuredSeconds: cfg.activity.prerollSeconds },
      voice: { open: this.voice.open, lastVoiceMs: Number.isFinite(this.voice.lastVoiceMs) ? this.voice.lastVoiceMs : null },
      spectral: this.#spectral.status,
      speechDetection: this.#silero.status,
      radio: this.radio.status(),
      transcription: { mode: cfg.auditor.mode, ...this.transcriber.status() },
      captions: this.captionsStatus(),
    };
  }

  /** Fixed-format snapshot used by the binary UDP telemetry publisher. */
  telemetrySnapshot() {
    const captureStatus = this.capture.status();
    const captureRunning = captureStatus.state === 'running' && captureStatus.running;
    const meterFresh = captureRunning && this.#now() - this.#meter.measuredAt <= 500;
    const radio = this.radio.status();
    const publisher = radio.some((target) => target.state === 'running')
      ? 'publishing'
      : radio.some((target) => target.state === 'restarting')
        ? 'reconnecting'
        : radio.some((target) => target.state === 'error')
          ? 'error'
          : 'stopped';
    return {
      rmsDbfs: meterFresh ? this.#meter.rmsDbfs : null,
      peakDbfs: meterFresh ? this.#meter.peakDbfs : null,
      classification: !captureRunning ? 'unknown' : this.#speechActive ? 'speech' : (this.#spectral.status.label === 'music' ? 'music' : (this.voice.open ? 'speech' : 'silence')),
      confidence: captureRunning && Number.isFinite(this.#spectral.status.confidence) ? Math.round(this.#spectral.status.confidence * 100) : null,
      capture: {
        state: captureStatus.state === 'running' && captureStatus.running
          ? 'running'
          : captureStatus.state === 'restarting' ? 'error' : 'stopped',
        // ffmpeg normalizes the analysis stream to S16LE; the ALSA input sample format
        // is not exposed by the current capture process, so report it as unknown.
        sampleFormat: 'unknown',
        channels: this.#store.get().capture.channels,
        sampleRateHz: this.#store.get().capture.sampleRate,
      },
      publisher,
    };
  }

  stop() {
    clearTimeout(this.#autoTimer);
    this.#autoTimer = null;
    this.#stream.stop();
    this.#relay.stop();
    this.#youtube.stop();
    this.stopCapture();
    this.#telemetry?.stop();
    clearTimeout(this.#auditorIdleTimer);
    this.#auditorIdleTimer = null;
    this.#silero.close().catch(() => {});
  }

  #buildVoice(cfg) {
    this.voice = new VoiceGate(cfg.voice);
    this.voice.on('open', ({ preroll }) => {
      this.radio.setVoice(true, preroll);
      // PiGateway, not the local VAD callback, opens activity-triggered sessions.
    });
    this.voice.on('close', () => this.radio.setVoice(false));
    this.radio.setVoice(false);
  }

  #applyAuditor(cfg) {
    this.#liveAuditor?.stop();
    this.#liveAuditor = cfg.auditor.url && cfg.auditor.liveSourceUrl
      ? new AuditorLiveClient({
          url: cfg.auditor.url,
          apiKey: cfg.auditor.apiKey,
          source: cfg.auditor.liveSourceUrl,
          language: cfg.auditor.language,
          fetchFn: this.#fetchFn,
        })
      : null;
    if (this.#liveAuditor) {
      this.#liveAuditor.on('transcript', (event) => this.#onTranscript(event));
      this.#liveAuditor.on('live-event', (event) => this.#publish('auditor-live', event));
      this.#liveAuditor.on('live-error', (err) => this.#publish('auditor-live', { type: 'error', message: err.message }));
      this.#liveAuditor.on('status', (status) => this.#publish('auditor-live', { type: 'status', data: status }));
    }
    const auditor = cfg.auditor.url && !cfg.auditor.liveSourceUrl
      ? new AuditorClient({
          url: cfg.auditor.url,
          apiKey: cfg.auditor.apiKey,
          timeoutMs: cfg.auditor.timeoutMs,
          fetchFn: this.#fetchFn,
        })
      : null;
    this.transcriber.configure({ auditor, language: cfg.auditor.language, maxQueue: cfg.auditor.maxQueue });
    if (this.capture.running) {
      this.#maybeStartAuditorLive(cfg.auditor.startWhen === 'capture_start' ? 'capture_start' : this.#spectral.status.label);
    }
  }

  #activityDetected(trigger) {
    // PiGateway owns session lifecycle. PiVoice only reports activity and retains PCM.
    this.#publish('activity', { trigger, at: new Date(this.#now()).toISOString() });
  }

  async startActivitySession(trigger = 'speech', delivery = null) {
    const cfg = this.#store.get().auditor;
    if (!this.capture.running) throw new ServiceError(409, 'capture_not_running', 'Capture must be running before an activity session can start');
    if (!this.#liveAuditor || cfg.mode === 'off') throw new ServiceError(409, 'auditor_not_configured', 'Auditor live mode is not configured or is disabled');
    if (cfg.startWhen === 'capture_start') throw new ServiceError(409, 'capture_start_mode', 'Auditor is configured to start with capture, not on activity');
    if (cfg.startWhen === 'speech' && trigger !== 'speech') throw new ServiceError(409, 'trigger_not_enabled', 'Auditor is configured to start on speech only');
    if (!['speech', 'music'].includes(trigger)) throw new ServiceError(400, 'invalid_trigger', 'trigger must be speech or music');
    const preRoll = this.#preroll.snapshotWithTiming();
    const status = await this.#liveAuditor.start({ preRollPcm: preRoll.pcm, preRollStartMs: preRoll.startMs, delivery });
    this.#publish('activity-session', { state: 'running', trigger, preRollBytes: preRoll.pcm.length, ...status });
    return { ...status, trigger, preRollBytes: preRoll.pcm.length };
  }

  async stopActivitySession(reason = 'idle') {
    if (!this.#liveAuditor) return { configured: false, running: false, sessionId: null };
    // In continuous-ingest mode, ignore gateway idle-close requests; the Auditor
    // reader remains attached until capture itself stops, while its VAD gates inference.
    if (this.#store.get().auditor.startWhen === 'capture_start') return this.#liveAuditor.status();
    const status = await this.#liveAuditor.stop();
    this.#publish('activity-session', { state: 'stopped', reason, ...status });
    return status;
  }

  #scheduleAuditorIdleClose() {
    // Intentionally no local timer: PiGateway is the authoritative lifecycle owner.
  }

  #maybeStartAuditorLive(trigger) {
    const cfg = this.#store.get().auditor;
    if (!this.#liveAuditor || cfg.mode === 'off' || this.#liveAuditor.running) return;
    const shouldStart = cfg.startWhen === 'capture_start' && trigger === 'capture_start';
    if (shouldStart) {
      clearTimeout(this.#auditorIdleTimer);
      this.#auditorIdleTimer = null;
      const preRoll = this.#preroll.snapshotWithTiming();
      this.#liveAuditor.start({ preRollPcm: preRoll.pcm, preRollStartMs: preRoll.startMs }).catch((err) => {
        this.#publish('auditor-live', { type: 'error', message: err.message });
      });
    }
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
    this.#meter = measurePcm(pcm, this.#now());
    this.#preroll.push(pcm, startMs);
    const endMs = startMs + pcm.length / 32;
    this.#spectral.push(pcm, endMs);
    this.#silero.push(pcm, endMs);
    this.voice.push(pcm, startMs);
    const captureCfg = this.#store.get().capture;
    if (captureCfg.policy === 'auto' && this.#autoCaptureStartedAt !== null) {
      const lastSoundAt = Number.isFinite(this.voice.lastVoiceMs) && this.voice.lastVoiceMs >= this.#autoCaptureStartedAt
        ? this.voice.lastVoiceMs
        : this.#autoCaptureStartedAt;
      if (this.#now() - lastSoundAt >= captureCfg.autoQuietSeconds * 1000) {
        this.#stopCaptureNow();
        this.#scheduleAutoProbe(captureCfg.autoPollMode === 'continuous' ? 0 : captureCfg.autoPollSeconds * 1000);
        return;
      }
    }
    if (!this.transcriber.configured) return;
    for (const chunk of this.#chunker.push(pcm, startMs)) {
      if (this.#transcriptionWanted(chunk.startMs)) this.transcriber.enqueue(chunk);
    }
  }

  // Captions are only produced from speech, so "on" and "auto" differ only for chunks of silence.
  #transcriptionWanted(atMs) {
    const mode = this.#store.get().auditor.mode;
    const lastSpeechMs = this.#silero.ready ? this.#silero.lastSpeechAt : this.voice.lastVoiceMs;
    const speechActive = Number.isFinite(lastSpeechMs) && lastSpeechMs >= atMs;
    return mode === 'on' || (mode === 'auto' && speechActive);
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

function measurePcm(pcm, measuredAt) {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return { rmsDbfs: null, peakDbfs: null, measuredAt };
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sumSquares / samples);
  const dbfs = (value) => value <= 0 ? -120 : 20 * Math.log10(value / 32768);
  return { rmsDbfs: dbfs(rms), peakDbfs: dbfs(peak), measuredAt };
}
