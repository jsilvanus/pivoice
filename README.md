# PiVoice

Headless audio service for the PiMatrix Raspberry Pi. One Hama USB microphone is captured once and fanned out into two PCM outputs: the configured source format for radio publishing, and a separate 16 kHz mono S16LE analysis stream for metering, voice detection and transcription through liturgos-auditor. Caption delivery goes to web-radio-relay and YouTube. There is no UI. PiMatrix and picontrol talk to the OpenAPI control API. Node 24, ESM, no build step.

## Modes

Capture has a policy separate from its input backend: `capture.policy=on` captures continuously, `off` remains stopped, and `auto` runs short ALSA probes (`autoPollMode=continuous` probes again immediately; `scheduled` waits `autoPollSeconds`; `autoProbeSeconds` sets probe length) and starts full capture when probe level crosses `voice.thresholdDb`. Auto capture stops after `autoQuietSeconds` without sound and returns to scheduled probes. `capture.mode` remains the backend (`alsa` or `simulated`). Every consumer has its own `on`, `off` or `auto` mode. Speech activity uses an energy gate (`voice.thresholdDb`, `voice.hangoverSeconds`, `voice.prerollSeconds`). A separate Silero VAD model analyses 512-sample (32 ms) frames in-process through ONNX Runtime on CPU. It reports a speech probability and uses a short hangover to avoid flickering at word pauses. The spectral classifier remains as a separate music-like heuristic and exposes centroid and low-frequency ratio for diagnostics. Silero is the primary speech detector when the model and runtime are installed; if unavailable, PiVoice falls back to the energy gate.

## Auditor pull mode

By default, PiVoice uploads analysis chunks to liturgos-auditor's `/inference` endpoint. To let Auditor pull the stream itself, configure `auditor.liveSourceUrl` as the RTSP/SRT URL of the MediaMTX stream reachable from the Auditor host, and `auditor.startWhen` defaults to `capture_start` (continuous ingest while capture runs); it can instead be set to `speech` or `speech_or_music` for activity-triggered sessions. PiVoice then starts a `POST /v1/live` session and consumes its SSE transcript events; it does not upload audio chunks in this mode. Auditor must have live sessions enabled and allow the source host. The `speech` trigger uses Silero VAD when available (otherwise the energy gate); `speech_or_music` starts on Silero speech or a spectral frame classified as music. The music classification remains heuristic and may misclassify some speech, music and ambient noise. Auditor itself performs the live stream's 16 kHz mono S16LE conversion. For activity-triggered live sessions, PiGateway is the authoritative lifecycle owner: it watches PiVoice telemetry, opens the session through PiVoice, and closes it after the gateway's `idleCloseSeconds` timeout (`0` disables automatic close). Configure `PIGATEWAY_PIVOICE_API_URL` and `PIGATEWAY_PIVOICE_API_TOKEN` in PiGateway. PiVoice continuously retains a bounded rolling PCM16 pre-roll (`activity.prerollSeconds`, default 5 seconds), including the wall-clock timestamp of its first retained sample, then submits that snapshot to Auditor as multipart PCM before Auditor processes the live MediaMTX source. Auditor processes pre-roll first, anchors its sample timeline to that capture timestamp, and then continues consuming the live stream; its segmenter/VAD sends speech segments to inference and discards silence. No separate clock-anchor endpoint is needed. The buffer is cleared on capture stop/restart; radio and capture are not routed through PiGateway. The legacy PiVoice idle-close setting remains for compatibility but does not run a local timer.

## Silero VAD setup\n\nInstall the local ONNX Runtime dependency and download the pinned, SHA-256-verified Silero model with `npm run setup:silero`. This is a one-time setup and requires network access; inference itself is offline and runs in the PiVoice process on CPU. The default model path is `models/silero_vad.onnx` (ignored by git); override it with `PIVOICE_SILERO_MODEL_PATH`. If the model or runtime is missing, PiVoice reports the detector as unavailable and falls back to the existing energy gate. The ONNX model is about 2.2 MB; no GPU is required.\n\n## PiGateway telemetry

When `PIVOICE_GATEWAY_HOST` is set, PiVoice sends a 42-byte binary UDP telemetry snapshot to that host while capture is running (every 100 ms), plus a packet when capture state changes. It sends no periodic packets while idle. A type `0x02` message is sent after the PiVoice status/health poll completes. The port is `PIVOICE_GATEWAY_PORT` (default `3101`). Configure the host as the PiGateway LAN IP. This is telemetry only; audio continues to its consumers and is never sent to PiGateway. PiGateway retains the last snapshot and marks it stale after six seconds without a valid packet.

The [shared protocol specification](docs/pivoice-telemetry.md) is also recorded in PiGateway.

### Protocol v1 (42 bytes)

All multi-byte fields are big-endian. No JSON and no audio payload.

Header (20 bytes):

| Offset | Size | Field | Definition |
|---:|---:|---|---|
| 0 | 2 | Magic | ASCII `PV` |
| 2 | 1 | Version | `1` |
| 3 | 1 | Type | `0x01` snapshot; `0x02` poll completed |
| 4 | 2 | Flags | Reserved, zero |
| 6 | 2 | Payload length | `22` |
| 8 | 4 | Sequence | Unsigned 32-bit counter, wraps |
| 12 | 8 | Timestamp | Unix milliseconds, unsigned 64-bit |

Payload (22 bytes):

| Offset | Size | Field | Definition |
|---:|---:|---|---|
| 20 | 4 | RMS | Signed int32 milli-dBFS; `-2147483648` unavailable |
| 24 | 4 | Peak | Signed int32 milli-dBFS; `-2147483648` unavailable |
| 28 | 1 | Classification | `0` unknown, `1` silence, `2` speech, `3` music |
| 29 | 1 | Confidence | `0–100`; `255` unavailable |
| 30 | 1 | Capture state | `0` stopped, `1` running, `2` error |
| 31 | 1 | Sample format | `0` unknown, `1` S16LE, `2` S24LE, `3` S32LE, `4` FLOAT32 |
| 32 | 2 | Channels | Unsigned 16-bit |
| 34 | 4 | Capture sample rate | Unsigned 32-bit Hz |
| 38 | 1 | Publisher state | `0` stopped, `1` publishing, `2` reconnecting, `3` error |
| 39 | 3 | Reserved | Zero |

Telemetry classification now uses the spectral heuristic while capture is running (`silence`, `speech` or `music`); it reports `unknown` when stopped. Confidence is a coarse heuristic indicator, not a calibrated probability. The energy gate remains independently responsible for speech activity and radio auto-start. Metering and transcription use the analysis output (16 kHz, mono, S16LE); radio encoders receive the separate source-format output at the configured capture sample rate and channel count. The reported sample format is `unknown` because ffmpeg does not currently expose the negotiated ALSA input sample format.

## Audio Hardware & Hama Setup

PiVoice captures audio from a USB sound card (such as the Hama USB audio adapter with 3.5 mm mic and headphone jacks) and can simultaneously route that audio back to the card's headphone output within the same FFmpeg process.

### Full-Duplex Capture and Playback Loopback

- **Same Process Execution**: When `capture.playbackDevice` is configured, FFmpeg captures from `capture.device` and outputs to `capture.playbackDevice` in the same pipeline. Because the ADC input and DAC output share the same USB audio crystal oscillator, there is zero clock drift.
- **Mono, Left-Only Audio Routing**:
  - Analysis stream (`pipe:1`): Maps `-af pan=mono|c0=c0` at 16 kHz S16LE. This takes input channel 0 (Left) directly without the 6 dB volume attenuation and noise injection caused by standard stereo-to-mono downmixing `(L + R)/2`.
  - Playback stream (`capture.playbackDevice`): Maps `-af pan=stereo|c0=c0|c1=0*c0`. Left channel carries the captured audio; Right channel is muted (`0*c0`). This prevents short-circuiting the right amplifier channel to ground when connecting a mono 3.5 mm TS plug into the stereo headphone jack.

### ALSA Device Discovery

To find and configure the correct ALSA card on the Pi:

1. **List all ALSA devices**:
   ```bash
   pivoice list-audio-devices
   # Or GET /api/v1/audio/devices
   ```
   Inspect the response: cards with `"capture": true, "playback": true` (e.g. `hw:1,0`) are duplex USB sound cards with both microphone input and headphone output.

2. **Inspect Mixer Controls**:
   ```bash
   pivoice get-audio-mixer
   # Or GET /api/v1/audio/mixer?card=1
   ```
   Verify that controls such as `Mic`, `Mic Boost`, and `Master` appear on that card.

3. **Configure PiVoice**:
   Use `plughw` notation (e.g. `plughw:1,0` or `plughw:CARD=Device,DEV=0`) so ALSA automatically performs any software format/rate adjustments if needed:
   ```json
   {
     "capture": {
       "device": "plughw:1,0",
       "playbackDevice": "plughw:1,0",
       "channels": 1,
       "sampleRate": 48000
     }
   }
   ```

### Mic vs. Line Level Transitions (RCA to 3.5 mm)

When connecting external audio gear (such as a mixing desk tape/rec out or induction loop) to the Hama sound card via RCA <-> 3.5 mm adapter cables:

- **Input Side (RCA Line Out -> Hama 3.5 mm Mic In)**:
  - Standard RCA outputs are **Line level** (~300 mV to 1 V RMS), whereas the Hama mic jack expects a sensitive **Mic level** signal (~1 mV to 10 mV) and supplies a DC bias voltage ("plug-in power").
  - Connecting line-level audio directly into a mic jack will severely clip and distort the ADC.
  - **Software adjustment**:
    1. Turn off `Mic Boost`:
       ```bash
       pivoice set-audio-mixer --body '{"control":"Mic Boost","switch":false}'
       ```
    2. Lower the input capture gain to around 5%–15%:
       ```bash
       pivoice set-audio-mixer --body '{"control":"Mic","volume":10}'
       ```
  - **Hardware recommendation**: For optimal signal-to-noise ratio and protection against DC bias, insert a passive **-30 dB to -40 dB line-to-mic attenuator pad** or DI box between the RCA output and the Hama mic jack.

- **Output Side (Hama 3.5 mm Headphone Out -> RCA Line In)**:
  - The Hama headphone jack delivers low-impedance audio capable of driving headphones or high-impedance RCA line inputs (-10 dBV consumer line level).
  - Set the `Master` playback level to 70%–80% to avoid clipping the internal headphone amplifier:
       ```bash
       pivoice set-audio-mixer --body '{"control":"Master","volume":75}'
       ```
  - **Wiring**: On a 3.5 mm TRS to dual RCA cable, Tip corresponds to Left (typically White RCA), which carries the active mono signal. Ring corresponds to Right (Red RCA), which is muted by PiVoice. Connect the Left (White) RCA to your target equipment.


## Timing and sync

The ALSA input is timestamped against the Pi's wall clock by FFmpeg (`-use_wallclock_as_timestamps 1`). The raw PCM output pipes do not preserve packet PTS, so PiVoice maps each output branch onto a sample-count timeline anchored when the first PCM buffer arrives after capture starts; subsequent buffer times advance by their exact sample duration. This avoids anchoring the timeline to FFmpeg process launch, but the initial timestamp still includes capture/FFmpeg output latency rather than a hardware ALSA timestamp. Keep the Pi clock NTP-synchronised. Chunks, transcript segments and captions carry epoch-millisecond times. web-radio-relay holds audio back by its listener delay and releases each caption at `startedAt + delay`. YouTube captions use `captions.youtube.delayMs`.

## Configuration

Stored in `$PIVOICE_DATA_DIR/config.json` (mode 0600). Change it with `PUT /api/v1/config` (partial; nested objects merge). Secrets are write-only and redacted as `***`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIVOICE_API_TOKEN` | required | Bearer token for `/api/v1` |
| `PIVOICE_ALLOW_INSECURE` | unset | `1` allows an open server (tests only) |
| `PIVOICE_HOST` | `127.0.0.1` | HTTP listen address |
| `PIVOICE_PORT` | `8095` | HTTP port |
| `PIVOICE_DATA_DIR` | `./data` | Configuration directory |
| `PIVOICE_GATEWAY_HOST` | unset | PiGateway LAN IP; unset disables UDP telemetry |
| `PIVOICE_GATEWAY_PORT` | `3101` | PiGateway UDP telemetry port |

## API

OpenAPI: `openapi/openapi.yaml`. Routes under `/api/v1`, plus `/health` and `/ready`. Main operations: `GET /api/v1/status`, `GET/PUT /api/v1/config`, `POST /api/v1/capture/start`, `POST /api/v1/capture/stop`, `GET /api/v1/transcription/events`, and `GET/PUT /api/v1/audio/mixer` (ALSA mixer volume, mute, and boost controls).

## Failure isolation

Capture is shared; a radio encoder, auditor or relay failing never restarts capture. ffmpeg processes restart with exponential backoff. Transcription queues are bounded and stale chunks are skipped; the relay buffers unreachable periods for at most 60 seconds.

## Tests

`npm test` runs the suite with fakes; it does not require ffmpeg, network or audio hardware.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `npm run status` in `D:\piecosystem`.
