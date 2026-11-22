/**
 * Language policy for caption translation (docs/translations/plan.md §4).
 * Sources and targets are fixed here; widening them is a reviewed change to this file.
 */
export const SOURCE_LANGUAGES = Object.freeze(['fi', 'en', 'sv']);
export const TARGET_LANGUAGES = Object.freeze(['fi', 'en', 'sv', 'ru', 'uk', 'es']);
/** Targets built and evaluated in the first rollout; `es` stays in the policy but comes later. */
export const ROLLOUT_TARGETS = Object.freeze(['fi', 'en', 'sv', 'ru', 'uk']);

/** Base language of a tag: `fi-FI` -> `fi`. Null for anything that is not a language tag. */
export function baseLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const match = /^([a-z]{2,3})(?:-[a-z0-9]{1,8})*$/i.exec(tag.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isSourceLanguage(lang) {
  return SOURCE_LANGUAGES.includes(baseLanguage(lang));
}

export function isTargetLanguage(lang) {
  return TARGET_LANGUAGES.includes(baseLanguage(lang));
}

/** True when the policy allows translating `source` into `target` directly (no pivot, not into itself). */
export function directionAllowed(source, target) {
  const src = baseLanguage(source);
  const tgt = baseLanguage(target);
  return Boolean(src && tgt && src !== tgt && SOURCE_LANGUAGES.includes(src) && TARGET_LANGUAGES.includes(tgt));
}

/** `fi-en` */
export function directionKey(source, target) {
  return `${baseLanguage(source)}-${baseLanguage(target)}`;
}

/** fffleet capability a worker advertises for a direction: `translate:fi-en`. */
export function capability(source, target) {
  return `translate:${directionKey(source, target)}`;
}

/** Parses `translate:fi-en` (or `fi-en`) into `{ source, target }`; null when not an allowed direction. */
export function parseDirection(value) {
  const match = /^(?:translate:)?([a-z]{2,3})-([a-z]{2,3})$/.exec(String(value ?? ''));
  if (!match || !directionAllowed(match[1], match[2])) return null;
  return { source: match[1], target: match[2] };
}

/** Every policy-allowed direction as `{ source, target }`. */
export function allowedDirections() {
  return SOURCE_LANGUAGES.flatMap((source) =>
    TARGET_LANGUAGES.filter((target) => target !== source).map((target) => ({ source, target })),
  );
}
