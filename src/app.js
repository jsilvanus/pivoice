import path from 'node:path';
import { ConfigStore } from './config.js';
import { createServer } from './server.js';
import { PiVoiceService } from './service.js';

/**
 * Builds the whole service from the environment. Dependencies (spawn, fetch,
 * execFile, the caption sender factory, the clock) can be replaced in tests.
 */
export async function createApp({ env = process.env, ...deps } = {}) {
  const dataDir = env.PIVOICE_DATA_DIR ?? './data';
  const store = new ConfigStore(path.join(dataDir, 'config.json'));
  await store.load();
  const initial = store.get();
  const seedPatch = {};
  if (initial.radio.targets.length === 0 && env.PIVOICE_RADIO_RTMP_URL) {
    seedPatch.radio = {
      targets: [
        {
          id: env.PIVOICE_RADIO_TARGET_ID || 'relay',
          name: env.PIVOICE_RADIO_TARGET_NAME || 'Web Radio Relay',
          mode: env.PIVOICE_RADIO_MODE || 'auto',
          rtmpUrl: env.PIVOICE_RADIO_RTMP_URL,
          hlsUrl: env.PIVOICE_RADIO_HLS_URL || null,
        },
      ],
    };
    if (env.PIVOICE_RADIO_BITRATE) seedPatch.radio.bitrate = env.PIVOICE_RADIO_BITRATE;
  }
  if (!initial.captions?.relay?.url && env.PIVOICE_CAPTION_RELAY_URL) {
    seedPatch.captions = {
      relay: {
        mode: env.PIVOICE_CAPTION_RELAY_MODE || 'auto',
        url: env.PIVOICE_CAPTION_RELAY_URL,
        token: env.PIVOICE_CAPTION_RELAY_TOKEN || null,
        stream: env.PIVOICE_CAPTION_RELAY_STREAM || null,
      },
    };
  }
  if (Object.keys(seedPatch).length > 0) {
    await store.update(seedPatch);
  }
  const telemetryPort = Number(env.PIVOICE_GATEWAY_PORT ?? 3101);
  if (!Number.isInteger(telemetryPort) || telemetryPort < 1 || telemetryPort > 65535) {
    throw new Error('PIVOICE_GATEWAY_PORT must be an integer between 1 and 65535');
  }
  const service = new PiVoiceService({
    store,
    telemetryHost: env.PIVOICE_GATEWAY_HOST?.trim() || undefined,
    telemetryPort,
    ...deps,
  });
  const server = createServer({
    service,
    store,
    token: env.PIVOICE_API_TOKEN || null,
    allowInsecure: env.PIVOICE_ALLOW_INSECURE === '1',
  });
  return { store, service, server };
}
