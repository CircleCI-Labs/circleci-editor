/**
 * Read-only detection of one rule this app's rejected-candidates review
 * (issue #292) pulled from CircleCI Field Engineering's config-review methodology
 * rather than the issue's own list: "recommend including at least one
 * fallback key" for a `restore_cache` step that has exactly one.
 *
 * CircleCI's own caching guide (linked from the recommendation) documents
 * the mechanism this relies on: a `restore_cache` key list is tried in
 * order, and a key with no exact match is still matched *by prefix* -- the
 * manual's own worked example pairs `my-cache-{{ checksum "..." }}` with a
 * bare `my-cache-` second key for exactly that reason. So "strip the
 * template interpolation off the front of the one key this job already
 * has" is not a guess at what a good fallback would be; it's the same
 * prefix CircleCI's docs use in their own example, mechanically derived
 * from a key the user already wrote.
 *
 * Scoped to a job's own `steps:` only (not `commands:`, and not a workflow
 * entry's `pre-steps`/`post-steps` override) -- by far the common place a
 * `restore_cache` step is written directly, and narrow enough that the
 * companion mutation (`~/lib/mutations/cacheFallbackMutations.ts`) only
 * ever needs one, simple path shape. A `restore_cache` step reached some
 * other way is left to the user, the same trade-off `detectDuplication.ts`
 * makes for a step sub-sequence embedded in a longer job.
 *
 * Pure and framework-free, same convention as `detectDuplication.ts`.
 */
import type { Document } from 'yaml';

import { getIn, getJobNames } from '~/lib/yaml/documentUtils';

export interface MissingCacheFallbackGroup {
  jobName: string;
  stepIndex: number;
  /** The one key this step already has -- `key:`, or a one-element `keys:`. */
  originalKey: string;
  /** `originalKey` up to (not including) its first `{{ ... }}` template -- the fallback CircleCI's own docs pair with a checksum key. */
  suggestedFallback: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The step's one existing cache key, from either `key:` or a single-element `keys:` -- `undefined` for anything else (already has a fallback, or has neither field). */
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
 * Scans every job's own `steps:` for a `restore_cache` with exactly one key
 * that contains a `{{ ... }}` template with real prefix text before it --
 * both a fully-templated key (`{{ checksum "x" }}`, no prefix at all) and a
 * key with no template (nothing this app can call a "checksum key" in the
 * first place) are left alone, since neither has a sensible mechanical
 * fallback to derive.
 */
export function findMissingCacheFallbacks(
  doc: Document,
): MissingCacheFallbackGroup[] {
  const out: MissingCacheFallbackGroup[] = [];

  for (const jobName of getJobNames(doc)) {
    const steps = getIn(doc, ['jobs', jobName, 'steps']);
    if (!Array.isArray(steps)) continue;

    steps.forEach((step, stepIndex) => {
      if (!isPlainRecord(step)) return;
      const key = singleKey(step.restore_cache);
      if (key === undefined) return;

      const templateIndex = key.indexOf('{{');
      if (templateIndex <= 0) return; // no template at all, or no prefix text before one

      out.push({
        jobName,
        stepIndex,
        originalKey: key,
        suggestedFallback: key.slice(0, templateIndex),
      });
    });
  }

  return out;
}
