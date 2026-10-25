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
  const service = new PiVoiceService({ store, ...deps });
  const server = createServer({
    service,
    store,
    token: env.PIVOICE_API_TOKEN || null,
    allowInsecure: env.PIVOICE_ALLOW_INSECURE === '1',
  });
  return { store, service, server };
}
