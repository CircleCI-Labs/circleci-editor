/**
 * The mutation behind the `restore_cache`-fallback recommendation
 * (`~/lib/graph/detectCacheFallback.findMissingCacheFallbacks`), one of the
 * FE config-review methodology's own rules issue #292 adopted: "recommend
 * including at least one fallback key."
 *
 * Built on `configMutations.setStepField` -- the same generic step-field
 * setter every other step editor in this app uses -- rather than hand-
 * walking the step's YAML node, so this gets that function's existing
 * comment-preserving/shorthand-collapsing behavior for free instead of a
 * second copy of it.
 *
 * Writes `keys:` (the two-element list) *before* removing a singular
 * `key:` field, not after: `setStepField`'s removal path collapses the
 * step back to its bare shorthand form when the resulting map would be
 * empty (see that function's own doc comment), which -- if `key:` were
 * removed first, while it was still the map's only field -- would collapse
 * `restore_cache: { key: ... }` down to the bare `restore_cache` shorthand
 * before `keys:` ever got written. Writing `keys:` first means the map is
 * never empty at any point this module controls.
 */
import { type Document } from 'yaml';

import { setStepField } from '~/lib/mutations/configMutations';
import { getIn } from '~/lib/yaml/documentUtils';

const STALE =
  'This step is no longer a restore_cache step with a single cache key -- it may have changed since this suggestion was computed.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function singleKey(restoreCache: unknown): string | undefined {
  if (!isPlainRecord(restoreCache)) return undefined;
  if (typeof restoreCache.key === 'string') return restoreCache.key;
  const keys = restoreCache.keys;
  if (Array.isArray(keys) && keys.length === 1 && typeof keys[0] === 'string') {
    return keys[0];
  }
  return undefined;
}

/**
 * Adds `fallbackKey` as a second entry in `jobs.<jobName>.steps[stepIndex]`'s
 * `restore_cache`, re-reading the step fresh (rather than trusting a stale
 * `originalKey` the caller computed earlier) so a step that changed shape
 * since detection ran is refused rather than mangled.
 */
export function addCacheFallbackKey(
  doc: Document,
  jobName: string,
  stepIndex: number,
  fallbackKey: string,
): void {
  const step = getIn(doc, ['jobs', jobName, 'steps', stepIndex]);
  if (!isPlainRecord(step)) throw new Error(STALE);
  const existingKey = singleKey(step.restore_cache);
  if (existingKey === undefined) throw new Error(STALE);

  const stepPath = ['jobs', jobName, 'steps', stepIndex];
  setStepField(doc, stepPath, 'restore_cache', 'keys', [
    existingKey,
    fallbackKey,
  ]);
  setStepField(doc, stepPath, 'restore_cache', 'key', undefined);
}
