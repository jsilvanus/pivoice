import { readFile } from 'node:fs/promises';
import { baseLanguage } from './policy.js';

/**
 * Translation memory: fixed texts (liturgy) with known translations, matched exactly after
 * normalisation (plan §5.4). No fuzzy matching on purpose. The file lives outside the repository.
 *
 * File format: [{ "src": "fi", "text": "...", "tr": { "sv": "...", "en": "..." } }]
 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    // Unicode letters and digits are kept (ä, ö, å, Cyrillic); punctuation and symbols go.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TranslationMemory {
  #path;
  #readFile;
  #entries = new Map();
  #stats = { entries: 0, hits: 0, misses: 0, loadedAt: null, lastError: null };

  constructor({ path = null, readFileFn = readFile } = {}) {
    this.#path = path;
    this.#readFile = readFileFn;
  }

  get size() {
    return this.#entries.size;
  }

  /** Replaces all entries with those in `list`; invalid entries are skipped and counted. */
  load(list) {
    const next = new Map();
    let skipped = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const src = baseLanguage(item?.src);
      const key = normalizeText(item?.text);
      if (!src || !key || item?.tr === null || typeof item?.tr !== 'object') {
        skipped++;
        continue;
      }
      const translations = next.get(`${src}\u0000${key}`) ?? {};
      for (const [lang, text] of Object.entries(item.tr)) {
        const tgt = baseLanguage(lang);
        if (tgt && typeof text === 'string' && text.trim()) translations[tgt] = text.trim();
      }
      next.set(`${src}\u0000${key}`, translations);
    }
    this.#entries = next;
    this.#stats.entries = next.size;
    return { entries: next.size, skipped };
  }

  /** Reads the configured file. A missing path or file means an empty memory, not an error. */
  async reload() {
    if (!this.#path) return this.load([]);
    try {
      const result = this.load(JSON.parse(await this.#readFile(this.#path, 'utf8')));
      this.#stats.loadedAt = new Date().toISOString();
      this.#stats.lastError = null;
      return result;
    } catch (err) {
      // Only the error kind is kept: a parse error message can quote file content.
      this.#stats.lastError = err.code === 'ENOENT' ? 'memory file not found' : 'memory file could not be read';
      if (err.code === 'ENOENT') return this.load([]);
      return { entries: this.#entries.size, skipped: 0, error: this.#stats.lastError };
    }
  }

  /** The stored translation of `text` from `source` into `target`, or null. */
  lookup(source, target, text) {
    const src = baseLanguage(source);
    const tgt = baseLanguage(target);
    const hit = src && tgt ? this.#entries.get(`${src}\u0000${normalizeText(text)}`)?.[tgt] : undefined;
    if (hit) this.#stats.hits++;
    else this.#stats.misses++;
    return hit ?? null;
  }

  status() {
    return { configured: Boolean(this.#path), ...this.#stats };
  }
}
