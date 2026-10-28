# PiVoice UDP telemetry protocol v1

This is the shared PiVoice → PiGateway wire contract. Keep the protocol definitions in both repositories in sync.

## Transport and liveness

- UDP, default destination port **3101**.
- One fixed **42-byte** packet: 20-byte header + 22-byte payload.
- PiVoice sends a full snapshot every **100 ms**, including when capture is stopped.
- A valid packet refreshes PiGateway's heartbeat. State becomes stale after **6 seconds** without a valid packet.
- No retransmissions, separate heartbeat message, JSON or audio payload.
- PiGateway can restrict senders with `PIGATEWAY_PIVOICE_ALLOWED_HOSTS`.
- All multi-byte integers are big-endian. Audio samples are not part of this protocol.

## Header — 20 bytes

| Offset | Size | Field | Definition |
|---:|---:|---|---|
| 0 | 2 | Magic | ASCII `PV` (`0x50 0x56`) |
| 2 | 1 | Version | `1` |
| 3 | 1 | Type | `0x01` fixed telemetry snapshot |
| 4 | 2 | Flags | Reserved; must be zero |
| 6 | 2 | Payload length | `22` |
| 8 | 4 | Sequence | Unsigned 32-bit counter, wraps at 2³² |
| 12 | 8 | Timestamp | Unsigned 64-bit Unix milliseconds |

## Payload — 22 bytes

Offsets below are absolute from the start of the complete UDP packet.

| Offset | Size | Field | Definition |
|---:|---:|---|---|
| 20 | 4 | RMS | Signed int32 milli-dBFS; `-2147483648` unavailable |
| 24 | 4 | Peak | Signed int32 milli-dBFS; `-2147483648` unavailable |
| 28 | 1 | Classification | `0` unknown, `1` silence, `2` speech, `3` music |
| 29 | 1 | Confidence | `0–100`; `255` unavailable |
| 30 | 1 | Capture state | `0` stopped, `1` running, `2` error |
| 31 | 1 | Sample format | `0` unknown, `1` S16LE, `2` S24LE, `3` S32LE, `4` FLOAT32 |
| 32 | 2 | Channels | Unsigned 16-bit count |
| 34 | 4 | Capture sample rate | Unsigned 32-bit Hz |
| 38 | 1 | Publisher state | `0` stopped, `1` publishing, `2` reconnecting, `3` error |
| 39 | 3 | Reserved | Must be zero |

For meter values other than the unavailable sentinel, divide by 1,000 to get dBFS. PiVoice's current classification is its energy-based VAD: `speech` while the gate is open, `silence` while it is closed, and `unknown` when capture is stopped. It does not yet distinguish music from speech. Metering uses the 16 kHz mono S16LE analysis branch. The capture sample rate and channel count represent the configured ALSA input request; sample format remains `unknown` until the negotiated ALSA input format is exposed.

## PiGateway state

- Validates packet size, magic, version, type, flags, payload length, enum ranges and reserved bytes.
- Invalid packets and packets from disallowed sender IPs do not refresh liveness.
- Stores the latest snapshot in memory.
- Exposes it as `pivoice` in `GET /api/v1/status` and emits the `pivoice` event on `GET /api/v1/events` (SSE).
- Reports `connected: false, stale: true` after six seconds without a valid packet.
