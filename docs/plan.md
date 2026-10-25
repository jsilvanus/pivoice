# PiVoice plan and roadmap

## Goal

PiVoice is a headless audio-capture and distribution service for the PiMatrix Raspberry Pi. It captures the Hama USB sound card microphone input once and fans audio out to three independent consumers:

1. Web radio, reusing Tuberadio's radio pipeline and browser player.
2. Live speech transcription through liturgos-auditor.
3. YouTube captions through the existing live-captions-yt core.

PiMatrix owns the operator UI. PiVoice has no separate UI and exposes a versioned OpenAPI HTTP API.

## Architecture

```text
Hama USB audio capture (ALSA)
          |
          v
   PiVoice capture pipeline
          |
          +--> audio-only RTMP --> Tuberadio --> HLS --> browser player
          |
          +--> bounded audio chunks --> liturgos-auditor /inference
          |                                  |
          |                                  v
          |                         transcript events --> PiVoice SSE --> PiMatrix UI
          |
          +--> transcript text --> live-captions-yt core --> YouTube caption ingestion
```

Capture is shared; consumer delivery is independent. A radio or caption failure must not restart the physical capture or stop unrelated consumers. Do not proxy media bytes through the PiVoice control API.

## Technical decisions

- Capture the Hama device through Linux ALSA and FFmpeg. Discover the actual ALSA card/device identifier and supported formats on target hardware; do not assume a fixed device index.
- Normalize the source once and branch to consumer-specific encoders/formats as needed. Use a transcription-friendly format such as mono 16 kHz PCM for Auditor uploads and an encoded audio-only stream for radio.
- Publish audio-only RTMP to Tuberadio. Reuse its existing radio/HLS implementation rather than creating a new streaming stack.
- Ensure browser CORS covers the HLS playlist and every segment/resource fetched by JavaScript players. Use an explicit origin allowlist based on the PiMatrix UI origin; avoid wildcard origins when credentials are used.
- Send short, bounded audio chunks to Auditor's `POST /inference` endpoint using multipart `file` and `language`. Support configured API-key authentication, timeouts, retries, bounded queues, lag reporting, and transcript sequence/offset tracking.
- Use the live-captions-yt core for YouTube caption delivery; do not reimplement the YouTube caption protocol in PiVoice. Verify the core's supported programmatic API before choosing the adapter.
- Important distinction: YouTube's caption ingestion URL/key are not the same as the video's RTMP ingest address/key. The caption sender must receive caption-specific configuration. The video stream itself must be delivered to YouTube separately unless a separate video relay is deliberately added.
- Prefer Podman-compatible deployment on the Pi. Keep device access limited to the capture service and pass the ALSA device through explicitly.
- Store secrets outside source control. Status/config read operations must not return API keys or caption keys.
- OpenAPI is canonical. Generate API clients and types from `openapi/openapi.yaml`; avoid duplicate handwritten contracts.

## Proposed API

All operational routes are under `/api/v1`; `/health` and `/ready` are unversioned probes.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process liveness |
| GET | `/ready` | Readiness of required runtime components |
| GET | `/api/v1/status` | Capture and per-consumer state, errors, lag and uptime |
| GET | `/api/v1/audio/devices` | Discover capture devices and supported modes |
| GET | `/api/v1/config` | Read non-secret configuration |
| PUT | `/api/v1/config` | Update device, radio, Auditor and caption settings |
| POST | `/api/v1/capture/start` | Start shared capture pipeline |
| POST | `/api/v1/capture/stop` | Stop capture and consumers cleanly |
| GET | `/api/v1/transcription/events` | SSE transcript and transcription-status events |
| GET | `/api/v1/radio` | Browser-facing radio URLs and readiness |
| GET | `/api/v1/captions/status` | Caption sender status, without secrets |
| POST | `/api/v1/captions/start` | Start caption delivery |
| POST | `/api/v1/captions/stop` | Stop caption delivery |

This is a proposed initial contract; confirm the LCYT integration surface and refine endpoints before implementation. Use consistent JSON errors, documented state enums, operation IDs, examples, and explicit security requirements in OpenAPI.

## Roadmap

### Phase 0 — Verify integration contracts and hardware

- Inspect Tuberadio's RTMP ingest, HLS URL layout, CORS handling, and runtime configuration.
- Inspect the current live-captions-yt core API and determine how PiVoice can create/configure/start/stop a sender without its UI or a separate long-lived LCYT web app.
- Confirm Auditor endpoint authentication and expected audio formats.
- On the Pi, enumerate ALSA devices and test the Hama microphone input, sample formats, sample rates, channel count, gain, and clipping.
- Decide service-to-service URLs and credentials for the deployment network.

**Exit criteria:** documented, tested contracts for all three consumers and a confirmed ALSA capture command.

### Phase 1 — Repository foundation and API contract

- Add project architecture, local development, configuration and deployment documentation.
- Define `openapi/openapi.yaml` as the canonical contract.
- Establish the Node.js service, configuration validation, structured logging, health/readiness endpoints, and generated client workflow.
- Add unit-test scaffolding and CI for lint, type-check, OpenAPI validation, build and tests.

**Exit criteria:** service builds in CI, OpenAPI validates, generated client is reproducible, and no UI is included.

### Phase 2 — Hama capture lifecycle

- Implement ALSA device discovery and explicit device selection.
- Implement capture start/stop, process supervision, restart backoff, shutdown cleanup and diagnostic status.
- Add simulated capture mode for development without hardware.
- Add tests for process failures, repeated start/stop, unavailable device and shutdown.

**Exit criteria:** stable, observable capture lifecycle on the Pi and deterministic tests without hardware.

### Phase 3 — Web radio integration

- Publish an audio-only RTMP stream into Tuberadio.
- Configure browser-facing HLS URL and CORS for the PiMatrix UI origin, including playlist and segment responses.
- Report stream health and reconnect state through PiVoice.
- Test playback from a separate browser/device on the church LAN, including reconnect after capture or Tuberadio restart.

**Exit criteria:** browser playback works reliably over the LAN; radio failure/recovery does not corrupt capture state.

### Phase 4 — Auditor transcription

- Implement bounded chunk generation and upload to `/inference`.
- Preserve monotonically increasing chunk IDs and audio-time offsets.
- Implement timeouts, limited retries, queue limits, lag metrics and recoverable errors.
- Publish transcript/status events through SSE.
- Test silence, noisy input, service unavailable, slow inference and reconnecting UI clients.

**Exit criteria:** PiMatrix can observe live transcript events and transcription failures without interrupting radio.

### Phase 5 — YouTube caption delivery

- Implement an adapter around the verified live-captions-yt core API.
- Configure caption destination/key securely through PiVoice configuration.
- Send transcript results with appropriate timestamps and ordering; handle sender errors and reconnects.
- Keep caption delivery independently startable/stoppable and report state without exposing credentials.
- Document that the video RTMP stream and YouTube caption ingestion are separate channels.

**Exit criteria:** end-to-end captions arrive at a test YouTube Live caption endpoint/session using the existing LCYT core.

### Phase 6 — PiMatrix integration

- Generate the PiMatrix-facing TypeScript client from PiVoice OpenAPI.
- Add PiVoice status, audio-device selection, capture controls, radio status, transcription display, and caption controls to the existing PiMatrix UI.
- Configure the correct browser origin and radio URL for LAN access.
- Ensure secrets are only submitted through configuration writes and never displayed back.

**Exit criteria:** operators can use all required functions through PiMatrix; PiVoice has no UI.

### Phase 7 — Deployment, resilience and acceptance

- Add Podman-compatible deployment and explicit ALSA device access.
- Add persistent configuration, safe secret injection, startup ordering and health checks.
- Test reboot recovery, unplug/replug, consumer outages, sustained operation, CPU/memory use and network disconnects.
- Verify CORS, authentication, log redaction and that no public control endpoints are unintentionally exposed.
- Document installation, troubleshooting, API usage and acceptance-test steps.

**Exit criteria:** reproducible Pi deployment, documented recovery behavior, CI green and end-to-end acceptance checks passed.

## Non-goals

- No separate PiVoice UI.
- No new speech-recognition model or replacement for liturgos-auditor.
- No reimplementation of YouTube's caption protocol.
- No video encoding or video RTMP publishing as part of the audio capture path.
- No media-byte proxying through the PiVoice API.

## Risks and open questions

- The Hama USB audio device's exact ALSA interface and mic input capabilities must be verified on the target Pi.
- Tuberadio's current deployment mode, ARM64 compatibility, and CORS configuration must be verified.
- The correct LCYT core integration may be a package-level sender or an existing backend endpoint; choose after inspection rather than coupling PiVoice to LCYT's UI.
- USB mic input level, noise, and clipping may need mixer gain or a suitable audio interface.
- Define whether radio should remain live if Auditor or LCYT is down (recommended: yes), and specify queue/drop policy for transcription lag.
- Decide which PiMatrix origins are allowed and how service-to-service credentials are provisioned.

## References

- [Tuberadio](https://github.com/jsilvanus/Tuberadio)
- [liturgos-auditor](https://github.com/jsilvanus/liturgos-auditor)
- [live-captions-yt](https://github.com/jsilvanus/live-captions-yt)
- [PiMatrix](https://github.com/jsilvanus/pimatrix)
- [Auditor integration guide](https://github.com/jsilvanus/liturgos-auditor/blob/main/docs/integration.md)
- [LCYT deployment guide](https://github.com/jsilvanus/live-captions-yt/blob/main/docs/DEPLOY.md)
