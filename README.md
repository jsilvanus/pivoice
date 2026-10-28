# PiVoice

Headless audio service for the PiMatrix Raspberry Pi. One Hama USB microphone is captured once and fanned out to web radio (RTMP), live transcription through liturgos-auditor, and caption delivery to web-radio-relay and YouTube. There is no UI. PiMatrix and picontrol talk to the OpenAPI control API. Node 24, ESM, no build step.

## Modes

Every consumer has a mode: `on`, `off` or `auto`. Web radio and transcription can use voice activity detection; captions can be filtered by speech. Voice detection is an energy gate (`voice.thresholdDb`, `voice.hangoverSeconds`, `voice.prerollSeconds`).

## PiGateway telemetry

When `PIVOICE_GATEWAY_HOST` is set, PiVoice sends a 42-byte binary UDP telemetry snapshot to that host every 100 ms. The port is `PIVOICE_GATEWAY_PORT` (default `3101`). Configure the host as the PiGateway LAN IP. This is telemetry only; audio continues to its consumers and is never sent to PiGateway. Snapshots continue when capture is stopped so packet receipt acts as the gateway heartbeat.

The [shared protocol specification](docs/pivoice-telemetry.md) is also recorded in PiGateway.

### Protocol v1 (42 bytes)

All multi-byte fields are big-endian. No JSON and no audio payload.

Header (20 bytes):

| Offset | Size | Field | Definition |
|---:|---:|---|---|
| 0 | 2 | Magic | ASCII `PV` |
| 2 | 1 | Version | `1` |
| 3 | 1 | Type | `0x01`, telemetry snapshot |
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

The current classifier is the existing energy-based voice gate: while capture is running it reports `speech` when the gate is open and `silence` otherwise. It reports `unknown` when capture is stopped. This does not claim to distinguish music from speech, and confidence is reported as unavailable for this deterministic gate. Metering uses the analysis PCM (16 kHz, mono, S16LE); capture sample rate and channel count report the configured ALSA input request. The ALSA input sample format is `unknown` because ffmpeg does not currently expose the negotiated input sample format.

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
