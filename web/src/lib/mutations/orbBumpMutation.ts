/**
 * The (optional) action on the outdated-orb recommendation
 * (`~/lib/graph/detectOutdatedOrbs.findOutdatedOrbs`): rewriting one
 * `orbs:` alias's version in place.
 *
 * Mirrors `~/lib/validation/suggestions.ts`'s `orbVersionSuggestion.apply`
 * exactly (find the `orbs:` pair whose scalar value is the ref this was
 * computed from, mutate that scalar's own `.value` rather than replacing
 * the node) -- not imported from there because that function is `apply`,
 * a closure captured at diagnostic-render time for a *different* trigger
 * (a version that does not exist at all), not something this module's
 * caller can reuse directly. Kept as its own tiny, independently testable
 * function instead of inlining the four lines into the palette component.
 */
import { isMap, isScalar, type Document } from 'yaml';

import { getNode } from '~/lib/yaml/documentUtils';

const STALE =
  'This orb import changed since this suggestion was computed -- reopen it to see the current version.';

/** Rewrites `orbs.<alias>` from `fromRef` to `toRef`, refusing if the alias no longer holds exactly `fromRef`. */
export function bumpOrbVersion(
  doc: Document,
  alias: string,
  fromRef: string,
  toRef: string,
): void {
  const orbs = getNode(doc, ['orbs']);
  if (!isMap(orbs)) throw new Error(STALE);
  const pair = orbs.items.find(
    (item) => isScalar(item.key) && String(item.key.value) === alias,
  );
  if (!pair || !isScalar(pair.value) || pair.value.value !== fromRef) {
    throw new Error(STALE);
  }
  pair.value.value = toRef;
}
