/** Deadlines and retry rules (plan §5.3). */

/** A segment is useful until its caption has been shown: audio end + max age. */
export function deadlineOf(segment, maxAgeMs) {
  return segment.endMs + maxAgeMs;
}

export function isExpired(segment, now, maxAgeMs) {
  return now > deadlineOf(segment, maxAgeMs);
}

/** Splits segments into those still useful and the expired ones. */
export function partitionExpired(segments, now, maxAgeMs) {
  const live = [];
  const expired = [];
  for (const segment of segments) (isExpired(segment, now, maxAgeMs) ? expired : live).push(segment);
  return { live, expired };
}

/** Errors worth one more try (the same batch may succeed on another attempt or route). */
export const RETRYABLE_CODES = Object.freeze(['WORKER_LOST', 'ORCHESTRATOR_RESTARTED', 'TIMEOUT', 'ROUTE_TIMEOUT', 'ROUTE_UNAVAILABLE']);

/**
 * One retry, only for retryable codes, and only if the earliest deadline in the batch leaves
 * at least `minRemainingMs` for it.
 */
export function canRetry({ code, attempt, segments, now, maxAgeMs, minRemainingMs = 1000 }) {
  if (attempt >= 1 || !RETRYABLE_CODES.includes(code) || segments.length === 0) return false;
  const earliest = Math.min(...segments.map((s) => deadlineOf(s, maxAgeMs)));
  return earliest - now >= minRemainingMs;
}
