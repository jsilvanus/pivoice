import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePiVoicePacket, PIVOICE_PACKET_BYTES } from '../src/telemetry.js';

test('binary telemetry packet is fixed-size, big-endian, and carries current classification', () => {
  const snapshot = {
    rmsDbfs: -42.125,
    peakDbfs: -3.5,
    classification: 'speech',
    confidence: 100,
    capture: { state: 'running', sampleFormat: 'unknown', channels: 1, sampleRateHz: 48000 },
    publisher: 'publishing',
  };
  const first = encodePiVoicePacket(snapshot, 7, 1_761_600_000_123);
  const second = encodePiVoicePacket(snapshot, 8, 1_761_600_000_223);
  assert.equal(first.length, PIVOICE_PACKET_BYTES);
  assert.equal(first.toString('ascii', 0, 2), 'PV');
  assert.equal(first.readUInt8(2), 1);
  assert.equal(first.readUInt8(3), 1);
  assert.equal(first.readUInt16BE(6), 22);
  assert.equal(first.readUInt32BE(8), 7);
  assert.equal(first.readBigUInt64BE(12), 1_761_600_000_123n);
  assert.equal(first.readInt32BE(20), -42125);
  assert.equal(first.readInt32BE(24), -3500);
  assert.equal(first.readUInt8(28), 2);
  assert.equal(first.readUInt8(29), 100);
  assert.equal(first.readUInt8(30), 1);
  assert.equal(first.readUInt8(31), 0);
  assert.equal(first.readUInt16BE(32), 1);
  assert.equal(first.readUInt32BE(34), 48000);
  assert.equal(first.readUInt8(38), 1);
  assert.deepEqual([...first.subarray(39)], [0, 0, 0]);
  assert.equal(second.readUInt8(28), 2, 'classification is included on every packet');
});

test('unavailable meter and confidence use the protocol sentinels', () => {
  const packet = encodePiVoicePacket({
    rmsDbfs: null,
    peakDbfs: null,
    classification: 'unknown',
    confidence: null,
    capture: { state: 'stopped', sampleFormat: 'unknown', channels: 1, sampleRateHz: 48000 },
    publisher: 'stopped',
  }, 0, 1);
  assert.equal(packet.readInt32BE(20), -2147483648);
  assert.equal(packet.readInt32BE(24), -2147483648);
  assert.equal(packet.readUInt8(29), 255);
});


test('service telemetry snapshot reports stopped capture as unknown and no fake confidence', async () => {
  const { PiVoiceService } = await import('../src/service.js');
  const { tempStore, fakeSpawn } = await import('./helpers.js');
  const { store } = await tempStore({ capture: { mode: 'simulated' } });
  const service = new PiVoiceService({ store, spawn: fakeSpawn() });
  try {
    const snapshot = service.telemetrySnapshot();
    assert.equal(snapshot.capture.state, 'stopped');
    assert.equal(snapshot.classification, 'unknown');
    assert.equal(snapshot.confidence, null);
    assert.equal(snapshot.publisher, 'stopped');
  } finally {
    service.stop();
  }
});


test('health-poll packet uses message type 2 and preserves the same snapshot layout', () => {
  const packet = encodePiVoicePacket({
    rmsDbfs: -20,
    peakDbfs: -2,
    classification: 'silence',
    confidence: null,
    capture: { state: 'stopped', sampleFormat: 'unknown', channels: 1, sampleRateHz: 48000 },
    publisher: 'stopped',
  }, 9, 1_761_600_000_999, 2);
  assert.equal(packet.length, PIVOICE_PACKET_BYTES);
  assert.equal(packet.readUInt8(3), 2);
  assert.equal(packet.readUInt8(28), 1, 'classification remains present in poll snapshots');
});
