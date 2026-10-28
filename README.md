# PiVoice

Headless audio service for the PiMatrix Raspberry Pi. One Hama USB microphone is captured once and fanned out into two PCM outputs: the configured source format for radio publishing, and a separate 16 kHz mono S16LE analysis stream for metering, voice detection and transcription through liturgos-auditor. Caption delivery goes to web-radio-relay and YouTube. There is no UI. PiMatrix and picontrol talk to the OpenAPI control API. Node 24, ESM, no build step.

## Modes

Capture has a policy separate from its input backend: `capture.policy=on` captures continuously, `off` remains stopped, and `auto` runs short ALSA probes (`autoPollMode=continuous` probes again immediately; `scheduled` waits `autoPollSeconds`; `autoProbeSeconds` sets probe length) and starts full capture when probe level crosses `voice.thresholdDb`. Auto capture stops after `autoQuietSeconds` without sound and returns to scheduled probes. `capture.mode` remains the backend (`alsa` or `simulated`). Every consumer has its own `on`, `off` or `auto` mode. Voice detection is currently an energy gate (`voice.thresholdDb`, `voice.hangoverSeconds`, `voice.prerollSeconds`).

## Auditor pull mode

By default, PiVoice uploads analysis chunks to liturgos-auditor's `/inference` endpoint. To let Auditor pull the stream itself, configure `auditor.liveSourceUrl` as the RTSP/SRT URL of the MediaMTX stream reachable from the Auditor host, and configure `auditor.startWhen`: `capture_start`, `speech`, or `speech_or_music`. PiVoice then starts a `POST /v1/live` session and consumes its SSE transcript events; it does not upload audio chunks in this mode. Auditor must have live sessions enabled and allow the source host. The speech/music trigger currently uses PiVoice's energy gate: it wakes on sound above threshold and is not yet a semantic speech-vs-music classifier. Auditor itself performs the live stream's 16 kHz mono S16LE conversion.

## PiGateway telemetry

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

The current classifier is the existing energy-based voice gate: while capture is running it reports `speech` when the gate is open and `silence` otherwise. It reports `unknown` when capture is stopped. This does not distinguish music from speech, and confidence is unavailable for this deterministic gate. Metering and transcription use the analysis output (16 kHz, mono, S16LE); radio encoders receive the separate source-format output at the configured capture sample rate and channel count. The reported sample format is `unknown` because ffmpeg does not currently expose the negotiated ALSA input sample format.

## Timing and sync

Capture stamps every PCM buffer with its wall-clock start (epoch ms, NTP-synced Pi clock). Chunks, transcript segments and captions carry those epoch times. web-radio-relay holds audio back by its listener delay and releases each caption at `startedAt + delay`. YouTube captions use `captions.youtube.delayMs`.

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

OpenAPI: `openapi/openapi.yaml`. Routes under `/api/v1`, plus `/health` and `/ready`. Main operations: `GET /api/v1/status`, `GET/PUT /api/v1/config`, `POST /api/v1/capture/start`, `POST /api/v1/capture/stop`, and `GET /api/v1/transcription/events`.

## Failure isolation

Capture is shared; a radio encoder, auditor or relay failing never restarts capture. ffmpeg processes restart with exponential backoff. Transcription queues are bounded and stale chunks are skipped; the relay buffers unreachable periods for at most 60 seconds.

## Tests

`npm test` runs the suite with fakes; it does not require ffmpeg, network or audio hardware.
