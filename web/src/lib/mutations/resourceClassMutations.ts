/**
 * The (currently dormant) action behind issue #307's resource-class
 * right-sizing recommendation
 * (`~/lib/graph/detectResourceUtilization.findResourceUtilizationFindings`):
 * rewriting a job's `resource_class:` to the class the finding suggests.
 *
 * "Currently dormant" because a finding only ever carries a
 * `suggestedClass` once issue #305's offerings cache confirms that class
 * actually exists for this job's platform (see that module's own doc
 * comment). That cache has landed, but it lists resource-class *names* with
 * no size ordering, and it is not a superset of the vendored resource-class
 * tables -- so nothing can yet say which class is one size down. #312 tracks
 * deriving that ordering. Until it does, no call site populates a
 * `suggestedClass` and `RecommendationsSection.tsx` renders no action button.
 * The mutation itself is written and tested now rather than left for whoever
 * wires it in, so that landing is a one-line `action={...}` addition.
 *
 * Uses `setIn` (not `setInOverridingMerge`): a `resource_class:` shared via
 * a YAML merge anchor is exactly the case `setIn`'s refusal exists for
 * (issue #35) -- this recommendation is about one job's own measured usage,
 * not a mandate to fork every job that happens to share the anchor, so a
 * merge-inherited field refuses rather than silently diverging one job from
 * the rest.
 */
import type { Document } from 'yaml';

import { setIn } from '~/lib/yaml/documentUtils';

/** Sets `jobs.<jobName>.resource_class` to `resourceClass`. Throws (via `setIn`) if that field is currently supplied through a merge anchor rather than written on the job itself. */
export function setResourceClass(
  doc: Document,
  jobName: string,
  resourceClass: string,
): void {
  setIn(doc, ['jobs', jobName, 'resource_class'], resourceClass);
}
