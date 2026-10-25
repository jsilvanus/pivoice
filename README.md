# PiVoice

Headless audio service for the PiMatrix Raspberry Pi. One Hama USB microphone is
captured once and fanned out to:

1. **Web radio** (audio only, RTMP) to the local Tuberadio and/or to web-radio-relay on the VPS.
2. **Live transcription** through liturgos-auditor (`POST /inference`), in bounded chunks.
3. **Captions** to web-radio-relay (`POST /api/v1/captions`, timed, Bearer token) and, later, YouTube
   (through the `lcyt` core; YouTube work is deferred).

There is no UI. PiMatrix and picontrol talk to the OpenAPI control API. Node 24, ESM, no build step.

## Modes

Every consumer has a mode: **`on`**, **`off`** or **`auto`**.

| Setting | Path in config | `auto` means |
| --- | --- | --- |
| Web radio to a target | `radio.targets[].mode` | encoder runs only while speech is detected (VAD); pre-roll is sent so speech is not cut |
| Transcription | `auditor.mode` | only chunks with speech are sent to the auditor |
| Captions to web-radio-relay | `captions.relay.mode` | only captions of speech are sent |
| Captions to YouTube | `captions.youtube.mode` | the stream is online: PiVoice polls the YouTube Data API (`videos.list`, `liveBroadcastContent`) every 30 s for `captions.youtube.videoId`, using `captions.youtube.apiKey` (sent in a header). It goes offline after two consecutive non-live polls. A failed poll keeps the last state |

Voice detection is an energy gate (`voice.thresholdDb`, `voice.hangoverSeconds`, `voice.prerollSeconds`).

## Timing and sync

Capture stamps every PCM buffer with its wall-clock start (epoch ms, NTP-synced Pi clock). Chunks,
transcript segments and captions carry those epoch times. web-radio-relay holds the audio back by its
listener delay and releases each caption at `startedAt + delay`, so PiVoice sends no delay.
YouTube captions use `captions.youtube.delayMs` on the sender side (for when YouTube is built).

## Failure isolation

- Capture is shared; a radio encoder, the auditor or the relay failing never restarts capture.
- Each ffmpeg (capture, each radio target) restarts with exponential backoff.
- YouTube auto: a failed stream check keeps the last known state, so captions are not cut by an API outage.
- Transcription queue is bounded: the oldest waiting chunk is dropped; chunks older than 30 s are skipped.
- The relay buffers while it is unreachable, for at most 60 s; older events are dropped, not replayed.

## Configuration

Stored in `$PIVOICE_DATA_DIR/config.json` (mode 0600). Change it with `PUT /api/v1/config`
(partial; nested objects merge). Secrets are write-only: they come back as `"***"`, and sending
`"***"` back keeps the stored value. RTMP stream keys are redacted the same way.

Example (`PUT /api/v1/config`):

```json
{
  "capture": { "mode": "alsa", "device": "hw:1,0", "autostart": true },
  "radio": {
    "bitrate": "96k",
    "targets": [
      { "id": "local", "name": "Tuberadio at the church", "mode": "on", "rtmpUrl": "rtmp://tuberadio:1935/live/KEY", "hlsUrl": "http://tuberadio:8080/hls/stream.m3u8" },
      { "id": "relay", "name": "web-radio-relay (VPS)", "mode": "auto", "rtmpUrl": "rtmp://relay.example:1935/live/KEY" }
    ]
  },
  "auditor": { "url": "http://auditor.lan:8090", "apiKey": "…", "mode": "on", "language": "fi" },
  "captions": {
    "relay": { "mode": "on", "url": "https://relay.example", "token": "RELAY_API_TOKEN" },
    "youtube": { "mode": "auto", "streamKey": "…", "apiKey": "…", "videoId": "abcdefghijk", "delayMs": 0 }
  }
}
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIVOICE_API_TOKEN` | required | Bearer token for `/api/v1` (not accepted in the query string) |
| `PIVOICE_ALLOW_INSECURE` | unset | `1` starts without a token. Tests only |
| `PIVOICE_HOST` | `127.0.0.1` | Listen address. On the Pi LAN use the management interface address |
| `PIVOICE_PORT` | `8095` | Listen port |
| `PIVOICE_DATA_DIR` | `./data` | Holds `config.json` |

Capture needs `ffmpeg` and ALSA (`arecord -l` lists devices). Find the Hama card with
`GET /api/v1/audio/devices`; do not assume a card index.

## API

OpenAPI: `openapi/openapi.yaml` (canonical). Routes under `/api/v1`, plus `/health` and `/ready`.

| Operation | Route |
| --- | --- |
| getStatus | `GET /api/v1/status` |
| listAudioDevices | `GET /api/v1/audio/devices` |
| getConfig / updateConfig | `GET`, `PUT /api/v1/config` |
| startCapture / stopCapture | `POST /api/v1/capture/start`, `/stop` |
| streamTranscriptionEvents | `GET /api/v1/transcription/events` (SSE: `capture`, `transcription`, `transcript`) |
| getRadio | `GET /api/v1/radio` |
| getCaptionsStatus | `GET /api/v1/captions/status` |

Errors are JSON `{ "error": { "code", "message", "details"? } }`. Config errors list paths, never values.

## CLI

The CLI table is generated from the spec (`npm run generate`; CI checks it with `npm run check:generated`).

```sh
export PIVOICE_SERVER=http://pi.lan:8095 PIVOICE_TOKEN=…
node cli/pivoice.js get-status
node cli/pivoice.js update-config --body-file radio.json
node cli/pivoice.js stream-transcription-events
node cli/pivoice.js help
```

## web-radio-relay contract

Captions are published to `POST {relay}/api/v1/captions` with `Authorization: Bearer <token>`:

```json
{ "segments": [ { "lang": "fi", "text": "…", "startedAt": 1761380000000, "endedAt": 1761380003000 } ] }
```

Up to 100 segments per request. Times are epoch milliseconds on the Pi clock. Audio goes over RTMP
to `rtmp://<relay>:1935/live/<stream-key>`. Checked against the Tuberadio relay's `server/openapi.json`
(checked against web-radio-relay `server/openapi.json` at af76462); not yet tested against a deployed relay. A batch the relay refuses with a 4xx (other than 401, 403, 429) is dropped so later captions still go out.

## Tests

`npm test` runs everything with fakes: no ffmpeg, no network, no hardware. Capture, radio,
auditor, relay and YouTube each take injected `spawn`/`fetch`/sender. The YouTube path uses the real
`lcyt` package only for its import; the sender is replaced in tests.

## Not verified

- Hama capture on a real Pi (ALSA format, gain, clipping): untested.
- Real auditor, real web-radio-relay, real YouTube ingest and the stream-online check against live YouTube: untested.
- RTMP into web-radio-relay: untested.
- Auto modes (VAD thresholds) on real room audio: needs tuning on site.
- Translation: deferred; the caption `lang` field is kept so it can be added.
