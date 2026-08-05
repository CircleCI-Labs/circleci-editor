/**
 * The mutation behind issue #292's fourth approved recommendation: turning a
 * literal image tag repeated at two or more `docker:` locations
 * (`~/lib/graph/detectRepeatedImageTags.findRepeatedImageTags`) into one
 * pipeline parameter, with every one of those locations rewritten to
 * reference it.
 *
 * Deliberately its own small sibling file rather than an addition to
 * `configMutations.ts` (already large, and the file several other
 * concurrent issues touch for workflow/inspector edits) or
 * `parameterMutations.ts` (whose own contract is "parameter declarations
 * and their references", not "how a caller decided a parameter should
 * exist") -- same rationale `parameterMutations.ts`/`parameterReferences.ts`
 * already used to split out of `configMutations.ts` for issue #250.
 *
 * Follows `configMutations.extractSharedExecutor`'s own shape:
 *
 *  1. Re-verify every location still holds the exact literal this was
 *     computed from -- the document may have changed since detection ran,
 *     and writing over a location that no longer matches would silently
 *     change something the suggestion never described.
 *  2. Add the parameter via `parameterMutations.addParameter`, which is
 *     also what enforces the name is unused and legal -- not re-checked
 *     here, so there is exactly one place that validation lives.
 *  3. Rewrite every location's scalar node's own `.value` in place (never
 *     replace the node), so a comment on that line survives, the same
 *     convention `renameParameter`'s interpolation rewrite already uses.
 */
import { isScalar, type Document } from 'yaml';

import { addParameter } from '~/lib/mutations/parameterMutations';
import { getIn, getNode, type Path } from '~/lib/yaml/documentUtils';

const STALE =
  'These locations no longer all pin the same image -- one may have changed since this suggestion was computed.';

/**
 * Extracts `image` (found identically at every one of `locations`) into a
 * new pipeline parameter `paramName`, then rewrites each location to
 * `<< pipeline.parameters.<paramName> >>`.
 */
export function extractImageTagToParameter(
  doc: Document,
  locations: Path[],
  image: string,
  paramName: string,
): void {
  if (locations.length < 2) {
    throw new Error('Extracting an image tag needs at least two locations');
  }
  for (const path of locations) {
    if (getIn(doc, path) !== image) throw new Error(STALE);
  }

  addParameter(doc, { kind: 'pipeline' }, paramName, {
    type: 'string',
    default: image,
  });

  const reference = `<< pipeline.parameters.${paramName} >>`;
  for (const path of locations) {
    const node = getNode(doc, path);
    if (!isScalar(node)) throw new Error(STALE);
    node.value = reference;
  }
}
