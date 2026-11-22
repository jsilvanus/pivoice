import { z } from 'zod';
import { directionAllowed, parseDirection, TARGET_LANGUAGES } from './policy.js';

/** Routes a direction can use (plan §5.6). `memory` is always tried first and is not a route. */
export const ROUTE_NAMES = Object.freeze(['mt', 'llm', 'hosted']);

const httpUrl = z.string().refine((value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'Invalid URL');

const route = z.enum(ROUTE_NAMES);
const chain = z.array(route).max(ROUTE_NAMES.length).refine((list) => new Set(list).size === list.length, 'A route is listed twice');
const workerId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/** `routes`: `default` plus per-direction chains such as `fi-uk`. */
const routesSchema = z
  .record(chain)
  .default({ default: ['mt'] })
  .superRefine((routes, ctx) => {
    for (const key of Object.keys(routes)) {
      if (key !== 'default' && !parseDirection(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Not an allowed direction (e.g. fi-en)' });
      }
    }
  })
  .transform((routes) => ({ default: ['mt'], ...routes }));

export const translationSchema = z.object({
  /** off = nothing runs; on = translate every final transcript; auto = while a caption output is running. */
  mode: z.enum(['off', 'on', 'auto']).default('off'),
  targets: z
    .array(z.enum(TARGET_LANGUAGES))
    .max(TARGET_LANGUAGES.length)
    .refine((list) => new Set(list).size === list.length, 'A target is listed twice')
    .default(['en']),
  /** JSON file of fixed texts and their translations, outside the repository. */
  memoryPath: z.string().trim().min(1).max(500).nullable().default(null),
  routes: routesSchema,
  fleet: z
    .object({
      url: httpUrl.nullable().default(null),
      workerPreference: z.array(workerId).min(1).max(8).default(['operator-pc-translate']),
    })
    .default({}),
  llm: z
    .object({
      url: httpUrl.nullable().default(null),
      model: z.string().trim().min(1).max(100).default('qwen2.5:3b'),
      timeoutMs: z.number().int().min(1000).max(60000).default(8000),
      keepAlive: z.string().regex(/^\d{1,4}[smh]$/).default('30s'),
    })
    .default({}),
  hosted: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['google', 'deepl']).default('google'),
      url: httpUrl.default('https://translation.googleapis.com'),
      timeoutMs: z.number().int().min(1000).max(30000).default(5000),
      monthlyCharBudget: z.number().int().min(0).max(100_000_000).default(500_000),
    })
    .default({}),
  batch: z
    .object({
      windowMs: z.number().int().min(0).max(5000).default(300),
      maxSegments: z.number().int().min(1).max(16).default(8),
      maxChars: z.number().int().min(100).max(4000).default(2000),
    })
    .default({}),
  maxInFlightPerTarget: z.number().int().min(1).max(8).default(2),
  maxQueuedPerTarget: z.number().int().min(1).max(500).default(50),
  jobTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
  queueTimeoutMs: z.number().int().min(500).max(60000).default(3000),
  maxAgeMs: z.number().int().min(5000).max(600000).default(60000),
  publish: z
    .object({
      events: z.boolean().default(true),
      relay: z.boolean().default(true),
      gateway: z.boolean().default(false),
    })
    .default({}),
});

/** Directions the config would translate for a source language (targets equal to the source are skipped). */
export function enabledDirections(config, source) {
  return config.targets.filter((target) => directionAllowed(source, target)).map((target) => ({ source, target }));
}

/** The route chain for a direction: its own entry, else `default`. */
export function routeChain(config, source, target) {
  return config.routes[`${source}-${target}`] ?? config.routes.default ?? ['mt'];
}
