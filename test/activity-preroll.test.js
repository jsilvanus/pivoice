import assert from 'node:assert/strict';
import test from 'node:test';
import { PiVoiceService } from '../src/service.js';
import { fakeSpawn, jsonResponse, tempStore, waitFor } from './helpers.js';

test('gateway-opened Auditor session receives the rolling PCM snapshot before live audio', async () => {
  const { store } = await tempStore({
    capture: { mode: 'simulated' },
    activity: { prerollSeconds: 1 },
    auditor: {
      url: 'http://auditor:8090',
      liveSourceUrl: 'rtsp://mediamtx:8554/church',
      startWhen: 'speech',
      mode: 'on'
    }
  });
  let startForm = null;
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/v1/live') && init.method === 'POST') {
      startForm = init.body;
      return jsonResponse({ id: 'live-1' }, 202);
    }
    if (url.endsWith('/events')) return new Response('', { status: 200 });
    return jsonResponse({});
  };
  const service = new PiVoiceService({ store, spawn: fakeSpawn(), fetchFn });
  try {
    service.startCapture();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await service.startActivitySession('speech');
    assert.equal(result.running, true);
    assert.ok(startForm instanceof FormData);
    const metadata = JSON.parse(startForm.get('metadata'));
    assert.equal(metadata.has_preroll, true);
    const preroll = startForm.get('preroll');
    assert.ok(preroll instanceof Blob);
    assert.ok(preroll.size > 0);
    assert.ok(preroll.size <= 32_000);
  } finally {
    service.stop();
  }
});
