import dgram from 'node:dgram';

export const PIVOICE_UDP_PORT = 3101;
export const PIVOICE_PACKET_BYTES = 42;
const HEADER_BYTES = 20;
const PAYLOAD_BYTES = 22;
const UNAVAILABLE_DBFS = -2147483648;

const CLASSIFICATION = { unknown: 0, silence: 1, speech: 2, music: 3 };
const CAPTURE_STATE = { stopped: 0, running: 1, error: 2 };
const SAMPLE_FORMAT = { unknown: 0, S16LE: 1, S24LE: 2, S32LE: 3, FLOAT32: 4 };
const PUBLISHER_STATE = { stopped: 0, publishing: 1, reconnecting: 2, error: 3 };

export function encodePiVoicePacket(snapshot, sequence, timestampMs = Date.now()) {
  const packet = Buffer.alloc(HEADER_BYTES + PAYLOAD_BYTES);
  packet.write('PV', 0, 'ascii');
  packet.writeUInt8(1, 2);
  packet.writeUInt8(1, 3); // fixed telemetry snapshot
  packet.writeUInt16BE(0, 4); // flags reserved
  packet.writeUInt16BE(PAYLOAD_BYTES, 6);
  packet.writeUInt32BE(sequence >>> 0, 8);
  packet.writeBigUInt64BE(BigInt(Math.trunc(timestampMs)), 12);

  packet.writeInt32BE(encodeDbfs(snapshot.rmsDbfs), 20);
  packet.writeInt32BE(encodeDbfs(snapshot.peakDbfs), 24);
  packet.writeUInt8(CLASSIFICATION[snapshot.classification] ?? 0, 28);
  packet.writeUInt8(Number.isInteger(snapshot.confidence) && snapshot.confidence >= 0 && snapshot.confidence <= 100 ? snapshot.confidence : 255, 29);
  packet.writeUInt8(CAPTURE_STATE[snapshot.capture?.state] ?? 0, 30);
  packet.writeUInt8(SAMPLE_FORMAT[snapshot.capture?.sampleFormat] ?? 0, 31);
  packet.writeUInt16BE(validUnsigned(snapshot.capture?.channels, 65535), 32);
  packet.writeUInt32BE(validUnsigned(snapshot.capture?.sampleRateHz, 0xffffffff), 34);
  packet.writeUInt8(PUBLISHER_STATE[snapshot.publisher] ?? 0, 38);
  // bytes 39-41 are reserved and remain zero
  return packet;
}

function encodeDbfs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNAVAILABLE_DBFS;
  return Math.max(-2147483647, Math.min(2147483647, Math.round(value * 1000)));
}

function validUnsigned(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
}

/** Periodically sends the latest state even when capture is stopped; receipt is the gateway heartbeat. */
export class PiVoiceTelemetryPublisher {
  #host;
  #port;
  #snapshot;
  #now;
  #socket;
  #timer = null;
  #sequence = 0;

  constructor({ host, port = PIVOICE_UDP_PORT, snapshot, now = Date.now, socketFactory = () => dgram.createSocket('udp4') }) {
    if (!host) throw new Error('PiVoice telemetry host is required');
    this.#host = host;
    this.#port = port;
    this.#snapshot = snapshot;
    this.#now = now;
    this.#socket = socketFactory();
    this.#socket.on('error', () => {}); // telemetry must never interrupt capture or audio delivery
  }

  start() {
    if (this.#timer) return;
    const send = () => {
      let packet;
      try {
        packet = encodePiVoicePacket(this.#snapshot(), this.#sequence++, this.#now());
      } catch {
        return;
      }
      this.#socket.send(packet, this.#port, this.#host, () => {});
    };
    send();
    this.#timer = setInterval(send, 100);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#socket.close();
  }
}
