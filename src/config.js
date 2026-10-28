import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Written in place of every secret when configuration is read. */
export const REDACTED = '***';

const httpUrl = z.url({ protocol: /^https?$/ });
const rtmpUrl = z.url({ protocol: /^rtmps?$/ });
const secretText = z.string().trim().min(1).max(500);

const MODE = z.enum(['on', 'off', 'auto']);

/**
 * on   - always running while capture runs
 * auto - running only while speech is detected (voice activity gate)
 * off  - never
 */
export const configSchema = z.object({
  capture: z
    .object({
      mode: z.enum(['alsa', 'simulated']).default('alsa'),
      policy: MODE.default('on'),
      autoPollSeconds: z.number().int().min(5).max(3600).default(120),
      autoProbeSeconds: z.number().int().min(1).max(5).default(2),
      autoQuietSeconds: z.number().int().min(5).max(600).default(30),
      device: z.string().trim().min(1).max(200).default('default'),
      channels: z.union([z.literal(1), z.literal(2)]).default(1),
      sampleRate: z.union([z.literal(44100), z.literal(48000)]).default(48000),
      chunkSeconds: z.number().min(1).max(30).default(5),
      autostart: z.boolean().default(false),
    })
    .prefault({}),
  voice: z
    .object({
      thresholdDb: z.number().min(-90).max(-10).default(-45),
      hangoverSeconds: z.number().min(0.5).max(30).default(3),
      prerollSeconds: z.number().min(0).max(5).default(1),
    })
    .prefault({}),
  radio: z
    .object({
      bitrate: z.string().regex(/^\d{2,3}k$/).default('96k'),
      targets: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9-]{1,40}$/),
            name: z.string().trim().max(100).default(''),
            mode: MODE.default('on'),
            rtmpUrl: rtmpUrl.nullable().default(null),
            hlsUrl: httpUrl.nullable().default(null),
          }),
        )
        .max(8)
        .default([]),
    })
    .prefault({}),
  auditor: z
    .object({
      url: httpUrl.nullable().default(null),
      apiKey: secretText.nullable().default(null),
      mode: MODE.default('on'),
      language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/).default('fi'),
      timeoutMs: z.number().int().min(1000).max(120000).default(20000),
      maxQueue: z.number().int().min(1).max(20).default(3),
    })
    .prefault({}),
  captions: z
    .object({
      relay: z
        .object({
          /** Sends transcript captions to web-radio-relay. auto = only for speech. */
          mode: MODE.default('off'),
          url: httpUrl.nullable().default(null),
          token: secretText.nullable().default(null),
        })
        .prefault({}),
      youtube: z
        .object({
          /** auto = send while the stream is online (see apiKey and videoId). */
          mode: MODE.default('off'),
          streamKey: secretText.nullable().default(null),
          /** YouTube Data API key and the video (or live broadcast) ID, used by mode "auto" to see if the stream is online. */
          apiKey: secretText.nullable().default(null),
          videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).nullable().default(null),
          /** Added to every caption timestamp so captions line up with the YouTube video delay. */
          delayMs: z.number().int().min(0).max(120000).default(0),
        })
        .prefault({}),
    })
    .prefault({}),
});

/** Secrets: never returned, never logged. Write-only through PUT /config. */
const SECRET_FIELDS = [
  ['auditor', 'apiKey'],
  ['captions', 'relay', 'token'],
  ['captions', 'youtube', 'streamKey'],
  ['captions', 'youtube', 'apiKey'],
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function getPath(obj, keys) {
  return keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, keys, value) {
  const parent = getPath(obj, keys.slice(0, -1));
  if (parent) parent[keys.at(-1)] = value;
}

/** Show the host of an RTMP ingest URL but hide its stream key (last path segment). */
export function redactRtmpUrl(url) {
  if (!url) return null;
  const u = new URL(url);
  const parts = u.pathname.split('/');
  if (parts.at(-1)) parts[parts.length - 1] = REDACTED;
  return `${u.protocol}//${u.host}${parts.join('/')}`;
}

export function redactConfig(config) {
  const out = structuredClone(config);
  for (const field of SECRET_FIELDS) {
    if (getPath(out, field)) setPath(out, field, REDACTED);
  }
  out.radio.targets = out.radio.targets.map((t) => ({ ...t, rtmpUrl: redactRtmpUrl(t.rtmpUrl) }));
  return out;
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * Apply a partial update. A secret sent back as REDACTED keeps its stored value,
 * so a client can read the config, change one field and write it back.
 * Throws a ZodError when the result is invalid.
 */
export function mergeConfig(current, patch) {
  const next = deepMerge(structuredClone(current), patch);
  for (const field of SECRET_FIELDS) {
    if (getPath(next, field) === REDACTED) setPath(next, field, getPath(current, field));
  }
  next.radio.targets = next.radio.targets.map((t) => {
    const prev = current.radio.targets.find((p) => p.id === t.id);
    return prev && t.rtmpUrl && t.rtmpUrl === redactRtmpUrl(prev.rtmpUrl) ? { ...t, rtmpUrl: prev.rtmpUrl } : t;
  });
  return configSchema.parse(next);
}

/** Persisted configuration file in the data directory (mode 0600, written atomically). */
export class ConfigStore {
  #file;
  #config = null;

  constructor(file) {
    this.#file = file;
  }

  async load() {
    let raw = {};
    try {
      raw = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read config file ${this.#file}: ${err.message}`);
    }
    this.#config = configSchema.parse(raw);
    return this.#config;
  }

  get() {
    return this.#config;
  }

  /** Validates and stores the patch. Returns the previous and the new configuration. */
  async update(patch) {
    const previous = this.#config;
    const current = mergeConfig(previous, patch ?? {});
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
    await rename(tmp, this.#file);
    this.#config = current;
    return { previous, current };
  }
}
