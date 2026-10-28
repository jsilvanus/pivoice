import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { ZodError } from 'zod';
import { redactConfig } from './config.js';
import { ServiceError } from './service.js';

const MAX_BODY_BYTES = 64 * 1024;

/** Maps `METHOD /path` to the OpenAPI operationId (openapi/openapi.yaml). */
export const ROUTES = {
  'GET /api/v1/status': 'getStatus',
  'GET /api/v1/audio/devices': 'listAudioDevices',
  'GET /api/v1/config': 'getConfig',
  'PUT /api/v1/config': 'updateConfig',
  'POST /api/v1/capture/start': 'startCapture',
  'POST /api/v1/capture/stop': 'stopCapture',
  'GET /api/v1/transcription/events': 'streamTranscriptionEvents',
  'GET /api/v1/activity/idle-close': 'getActivityIdleClose',
  'PUT /api/v1/activity/idle-close': 'setActivityIdleClose',
  'POST /api/v1/activity/session/start': 'startActivitySession',
  'POST /api/v1/activity/session/stop': 'stopActivitySession',
  'GET /api/v1/radio': 'getRadio',
  'GET /api/v1/captions/status': 'getCaptionsStatus',
};

const digest = (value) => createHash('sha256').update(value).digest();

export function createServer({ service, store, token = null, allowInsecure = false }) {
  if (!token && !allowInsecure) {
    throw new Error('PIVOICE_API_TOKEN is required (PIVOICE_ALLOW_INSECURE=1 starts an open server for tests only)');
  }
  const expected = token ? digest(token) : null;

  const authorised = (req) => {
    if (!expected) return true;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return Boolean(m) && timingSafeEqual(digest(m[1]), expected);
  };

  const handlers = {
    getStatus: () => {
      const body = service.status();
      service.pollCompleted();
      return { body };
    },
    listAudioDevices: async () => ({ body: await service.listDevices() }),
    getConfig: () => ({ body: redactConfig(store.get()) }),
    updateConfig: async ({ body }) => {
      const { previous, current } = await store.update(body);
      service.applyConfig(previous, current);
      return { body: redactConfig(current) };
    },
    startCapture: () => ({ body: service.startCapture() }),
    stopCapture: () => ({ body: service.stopCapture() }),
    getActivityIdleClose: () => ({ body: { idleCloseSeconds: store.get().activity.idleCloseSeconds, prerollSeconds: store.get().activity.prerollSeconds } }),
    startActivitySession: async ({ body }) => {
      if (!body || Object.keys(body).some((key) => key !== 'trigger')) throw new HttpError(400, 'invalid_request', 'Body may contain only trigger');
      return { body: await service.startActivitySession(body.trigger ?? 'speech') };
    },
    stopActivitySession: async ({ body }) => {
      if (!body || Object.keys(body).some((key) => key !== 'reason')) throw new HttpError(400, 'invalid_request', 'Body may contain only reason');
      return { body: await service.stopActivitySession(body.reason ?? 'gateway') };
    },
    setActivityIdleClose: async ({ body }) => {
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'idleCloseSeconds')) {
        throw new HttpError(400, 'invalid_request', 'Body must contain only idleCloseSeconds');
      }
      const { previous, current } = await store.update({ activity: { idleCloseSeconds: body.idleCloseSeconds } });
      service.applyConfig(previous, current);
      return { body: { idleCloseSeconds: current.activity.idleCloseSeconds, prerollSeconds: current.activity.prerollSeconds } };
    },
    getRadio: () => ({ body: { targets: service.radio.status() } }),
    getCaptionsStatus: () => ({ body: service.captionsStatus() }),
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/ready') return sendJson(res, 200, { status: 'ready' });

    const operationId = ROUTES[`${req.method} ${url.pathname}`];
    if (!operationId) return sendError(res, 404, 'not_found', 'No such route');
    if (!authorised(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendError(res, 401, 'unauthorized', 'A valid bearer token is required');
    }
    if (operationId === 'streamTranscriptionEvents') return streamEvents(req, res, service);

    try {
      const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req) : undefined;
      const result = await handlers[operationId]({ body });
      return sendJson(res, result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return sendError(res, 400, 'invalid_config', 'Configuration is invalid', issues);
      }
      if (err instanceof ServiceError) return sendError(res, err.status, err.code, err.message);
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      console.error('pivoice: request failed:', operationId, err.message);
      return sendError(res, 500, 'internal', 'Internal error');
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal', 'Internal error');
    });
  });
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

function streamEvents(req, res, service) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const unsubscribe = service.subscribe(({ type, data }) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}
