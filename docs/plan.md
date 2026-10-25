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
          |
          +--> authenticated outbound caption publish --> public caption relay --> radio listener page (SSE)
```

Capture is shared; consumer delivery is independent. A radio or caption failure must not restart the physical capture or stop unrelated consumers. Do not proxy media bytes through the PiVoice control API.


## Network and security boundary

**Boundary definition:** the Raspberry Pi / Pi LAN is a private, untrusted-from-the-Internet zone. PiVoice is a private control-and-capture service, not a public web service. No Internet-originated connection may reach PiVoice, its control API, SSH, ALSA, or other Pi-LAN devices. The radio and caption experience may be public, but it must be delivered through a separately exposed public edge/service.

```text
Church / Pi LAN (private)                         Public Internet
┌─────────────────────────────┐                  ┌────────────────────────────┐
│ PiMatrix UI ──LAN──> PiVoice│                  │ Public radio HLS + player  │
│                   │         │                  │ Public caption SSE/relay  │
│ Hama mic ──> capture/fanout │                  └──────────────▲─────────────┘
└───────────────────┬─────────┘                                 │
                    │ outbound-only, destination allowlisted    │
                    ├── RTMP/RTMPS audio ──> public Tuberadio ───┤
                    ├── HTTPS captions ─────> authenticated relay┘
                    └── HTTPS inference ────> Auditor (where deployed)
```

### Required network policy

- **No inbound Internet access to the Pi LAN.** Do not port-forward PiVoice, PiMatrix, SSH, RTSP/RTMP ingest, or any internal service directly from the router. Do not expose PiVoice's API or its SSE endpoint publicly.
- **PiMatrix-to-PiVoice control:** LAN-only, with authentication even on the LAN where practical. Restrict the API listener/firewall to the management subnet and the PiMatrix origin; CORS is not an access-control mechanism.
- **Public listener traffic:** browsers fetch radio HLS and caption SSE from a public-facing radio/caption host, not from the Pi. Publish the caption stream to that host using an authenticated outbound connection. The caption relay must enforce a stream-specific read URL/token or equivalent access policy appropriate to whether the radio is public.
- **PiVoice egress allowlist:** permit only configured destinations and required ports. Prefer HTTPS/TLS for APIs and caption publishing. Use RTMPS if the selected radio ingest supports it; otherwise document that plain RTMP is unencrypted and use it only on a trusted path or through a protected tunnel. Never assume a port is safe merely because it is conventional.
- **Auditor placement:** if Auditor is on the Pi LAN, allow PiVoice to reach only its fixed host/port and do not publish it. If Auditor is remote, use HTTPS and service authentication; do not open a public inbound route to the Pi to make transcription work.
- **Firewall/router:** document exact source, destination, protocol, and purpose for every allowed rule. Default-deny both unsolicited inbound and unnecessary east-west traffic. Keep router port-forward rules separate from host firewall rules.
- **Secrets and identity:** separate credentials for radio ingest, caption publish, caption read (if needed), Auditor, and YouTube caption delivery. Keep them out of URLs where possible, source control, logs, status responses, and browser-visible configuration. Rotate/revoke credentials independently.
- **Failure isolation:** loss of Internet egress or the public relay must not expose a fallback listener on the Pi or interrupt local control/capture. Buffering must be bounded; on prolonged caption outage, drop stale caption events rather than replaying misleading delayed “live” captions.

### Port inventory (to be finalized against actual deployments)

| Flow | Direction from Pi LAN | Protocol/port | Exposure rule |
| --- | --- | --- | --- |
| PiMatrix browser to PiVoice API/SSE | LAN-local | HTTPS preferred; exact port configured | LAN only; never router-forwarded |
| PiVoice to Tuberadio ingest | Outbound | RTMP/RTMPS; exact configured port | Destination allowlist; prefer TLS |
| Listener browser to radio HLS | Internet to public host | HTTPS 443 | Expose only on public radio host/reverse proxy |
| PiVoice to public caption relay | Outbound | HTTPS 443 | Authenticated publish; no inbound callback |
| Listener browser to caption SSE | Internet to public host | HTTPS 443 | Public edge only; separate read policy from publish credentials |
| PiVoice to Auditor | Outbound | HTTPS or fixed LAN service port | Fixed destination; never expose Auditor just for PiVoice |
| Administration/SSH | Admin LAN/VPN only | Configured SSH port | No public port-forward |

Do not finalize firewall commands or claim a port is required until deployment locations and the selected RTMP/TLS capabilities are verified.

## Technical decisions

- Capture the Hama device through Linux ALSA and FFmpeg. Discover the actual ALSA card/device identifier and supported formats on target hardware; do not assume a fixed device index.
- Normalize the source once and branch to consumer-specific encoders/formats as needed. Use a transcription-friendly format such as mono 16 kHz PCM for Auditor uploads and an encoded audio-only stream for radio.
- Publish audio-only RTMP to Tuberadio. Reuse its existing radio/HLS implementation rather than creating a new streaming stack.
- Ensure browser CORS covers the HLS playlist and every segment/resource fetched by JavaScript players. Use an explicit origin allowlist based on the PiMatrix UI origin; avoid wildcard origins when credentials are used.
- Send short, bounded audio chunks to Auditor's `POST /inference` endpoint using multipart `file` and `language`. Support configured API-key authentication, timeouts, retries, bounded queues, lag reporting, and transcript sequence/offset tracking.
- Use the live-captions-yt core for YouTube caption delivery; do not reimplement the YouTube caption protocol in PiVoice. Verify the core's supported programmatic API before choosing the adapter.
- For web-radio captions, publish transcript events over an authenticated outbound connection to a public caption relay; listeners receive them from the public host over SSE and render them beside the audio player. Do not expose PiVoice SSE to listeners or rely on the HTML audio element to render captions.
- Keep the public listener plane (HLS and caption read) separate from the private control plane (PiMatrix/PiVoice). The Pi should not need any inbound Internet port-forward for live radio or captions.
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
- Draw and verify the actual deployment trust zones; inventory required ingress/egress by source, destination, protocol and port. Confirm whether Tuberadio and the caption relay are public services, and whether RTMPS is supported.
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
- Configure browser-facing HLS URL and CORS for the PiMatrix UI origin, including playlist and segment responses. Keep this listener on the public radio host; do not serve public HLS directly from PiVoice.
- Report stream health and reconnect state through PiVoice.
- Test playback from a separate browser/device on the church LAN, including reconnect after capture or Tuberadio restart.

**Exit criteria:** browser playback works reliably over the LAN; radio failure/recovery does not corrupt capture state.

### Phase 4 — Auditor transcription

- Implement bounded chunk generation and upload to `/inference`.
- Preserve monotonically increasing chunk IDs and audio-time offsets.
- Implement timeouts, limited retries, queue limits, lag metrics and recoverable errors.
- Publish transcript/status events through LAN-only PiVoice SSE for PiMatrix.
- Publish live-radio captions separately to the public caption relay using authenticated outbound HTTPS; provide listener SSE from the public host, with a caption display beside the audio player. Keep publish credentials server-side and distinct from listener access.
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
- Verify the router has no port-forward to PiVoice/PiMatrix/SSH and test from an external network that only intended public-host ports are reachable.
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
