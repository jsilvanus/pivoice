/**
 * Validates a route's answer against the batch it was given (plan §6.3).
 * The result is accepted only as a whole: any structural problem rejects every segment.
 */
export const MAX_TRANSLATION_TEXT = 500;

export class InvalidResultError extends Error {
  constructor(reason) {
    super(`invalid translation result: ${reason}`);
    this.code = 'INVALID_RESULT';
    this.reason = reason;
  }
}

/**
 * @param {Array<{id:number,text:string}>} segments  what was sent
 * @param {unknown} translations                      what came back
 * @returns {{ translations: Map<number,string>, truncated: number }}
 */
export function validateTranslations(segments, translations) {
  if (!Array.isArray(translations)) throw new InvalidResultError('translations is not an array');
  const expected = new Map(segments.map((s) => [s.id, s.text]));
  const out = new Map();
  let truncated = 0;
  for (const item of translations) {
    const id = item?.id;
    if (!expected.has(id)) throw new InvalidResultError('unknown id');
    if (out.has(id)) throw new InvalidResultError('duplicate id');
    let text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) throw new InvalidResultError('empty text');
    if (text.length > MAX_TRANSLATION_TEXT) {
      text = text.slice(0, MAX_TRANSLATION_TEXT);
      truncated++;
    }
    out.set(id, text);
  }
  if (out.size !== expected.size) throw new InvalidResultError('missing id');
  // A model that loses track repeats another segment's source text; a one-segment echo of its own
  // source is allowed (names, "Amen").
  for (const [id, text] of out) {
    for (const [otherId, source] of expected) {
      if (otherId !== id && text === source.trim() && text !== expected.get(id).trim()) {
        throw new InvalidResultError('echo of another segment');
      }
    }
  }
  return { translations: out, truncated };
}
