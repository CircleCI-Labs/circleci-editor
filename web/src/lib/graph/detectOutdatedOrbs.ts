/**
 * Read-only detection of issue #292's third approved recommendation: an
 * `orbs:` import pinned to a version behind the registry's own latest for
 * that orb.
 *
 * This is explicitly **information, not a diagnostic** -- unlike
 * `orbVersionSuggestion` in `~/lib/validation/suggestions.ts` (which fires
 * only when the pinned version does not exist at all, a real compile
 * error), a version that is merely behind latest is not wrong. Plenty of
 * teams pin deliberately, for stability or to control when they take a
 * breaking change -- the caller (`RecommendationsSection`) is responsible
 * for keeping the copy phrased as a fact, never a problem.
 *
 * **Never fetches.** The whole point of "the registry data is already
 * held" (issue #292's own framing) is that this module takes the version
 * cache as a parameter rather than reaching for `useOrbStore` or
 * `getOrbSource` itself -- so an orb this session hasn't already looked up
 * (via the orb browser, an orb job/command's parameter panel, or a
 * version-not-found diagnostic) simply produces no suggestion for that orb,
 * rather than this feature quietly making its own network request the user
 * never asked for. See the "no recommendation may require a network call
 * the user has not already paid for" rule in issue #292.
 *
 * Pure and framework-free, same convention as `detectDuplication.ts`.
 */
import type { Document } from 'yaml';

import { parseOrbRef } from '~/lib/orbs/types';
import { getIn, listKeys } from '~/lib/yaml/documentUtils';

/** The subset of `OrbVersionInfo` (`~/state/orbStore.ts`) this module reads -- kept as its own shape so this stays pure and doesn't import a zustand store. */
export interface OrbVersionCacheEntry {
  versions: string[];
  latestVersion: string;
}

export interface OutdatedOrbGroup {
  /** The `orbs:` alias this config uses (e.g. `"node"` in `orbs: { node: circleci/node@5.0.0 }`). */
  alias: string;
  /** Canonical `"<namespace>/<name>"`, matching how the cache keys its entries. */
  orbName: string;
  pinnedVersion: string;
  latestVersion: string;
}

/**
 * Scans this config's `orbs:` block against `cache` (keyed by canonical
 * `"<namespace>/<name>"`, as `useOrbStore`'s `orbVersionsCache` already is),
 * returning one entry per alias whose pinned version:
 *
 *  - is a real, parseable `namespace/name@version` reference (an inline orb
 *    body, or a bare `namespace/name` with no version, has nothing to
 *    compare and is skipped);
 *  - is present in the cache's own `versions` list -- so a `@volatile`/
 *    `@dev:branch` tag, which never appears in a published version list,
 *    is never misread as "behind latest" (it isn't a pinned release at
 *    all); this also means a version the registry has since *removed* is
 *    left alone here, since a diagnostic elsewhere already owns "this
 *    version doesn't exist";
 *  - differs from `cache`'s `latestVersion` for that orb.
 */
export function findOutdatedOrbs(
  doc: Document,
  cache: Record<string, OrbVersionCacheEntry>,
): OutdatedOrbGroup[] {
  const out: OutdatedOrbGroup[] = [];

  for (const alias of listKeys(doc, ['orbs'])) {
    const raw = getIn(doc, ['orbs', alias]);
    if (typeof raw !== 'string') continue; // an inline orb body -- nothing to compare a version against

    const { namespace, orbName, version } = parseOrbRef(raw);
    if (!namespace || !orbName || !version) continue;

    const name = `${namespace}/${orbName}`;
    const info = cache[name];
    if (!info || !info.latestVersion) continue;
    if (!info.versions.includes(version)) continue;
    if (info.latestVersion === version) continue;

    out.push({
      alias,
      orbName: name,
      pinnedVersion: version,
      latestVersion: info.latestVersion,
    });
  }

  return out;
}
