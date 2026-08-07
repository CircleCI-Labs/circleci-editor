/**
 * Which CircleCI contexts the open config actually asks for -- either as a
 * whole (`referencedContexts`) or for one job in particular
 * (`contextsForJob`).
 *
 * `referencedContexts` was built for issue #194's run confirmation, which has
 * to say what a run will touch *before* it spends anything. A context
 * restricted to other projects is the failure mode this exists to surface:
 * the config compiles, the pipeline starts, and the job dies when CircleCI
 * declines to hand over the context -- which is precisely the
 * `other-projects-only` case, now costing credits instead of costing nothing.
 *
 * `contextsForJob` answers the same question narrowed to one job, for issue
 * #23's `$NAME` completions inside that job's own `run` commands -- see its
 * own doc comment for why the answer is a union across every entry that
 * invokes the job, not "the" entry.
 *
 * Both read from the `Document`, not from the text: the `eemeli/yaml`
 * Document is this app's single source of truth for what the config says,
 * and `buildWorkflowGraph` already normalises `context:` from CircleCI's
 * bare-string-or-list shorthand into a list. Re-parsing here would be a second
 * opinion about the same file, which is how the two drift.
 */
import type { Document } from 'yaml';

import {
  buildWorkflowGraph,
  listWorkflows,
  type GraphNode,
} from '~/lib/graph/buildGraph';

/**
 * Every context name referenced by any workflow job entry in `doc`, in
 * document order, deduplicated.
 *
 * Empty means "this config references no contexts", which is a useful thing to
 * be able to say plainly. It does *not* mean "we could not tell": a document
 * that will not parse is not a document this function is given, because the
 * caller has a parse error to report instead.
 */
export function referencedContexts(doc: Document | null): string[] {
  if (!doc) return [];
  return collectContextNames(doc, () => true);
}

/**
 * Every context name attached to `jobName` by *any* workflow entry that
 * invokes it -- the narrower question issue #23's `$NAME` completions need,
 * as distinct from `referencedContexts`' "every context this whole config
 * touches".
 *
 * ## Why the union across entries, not "the" entry
 *
 * A job's `steps:` are written once, but nothing stops a workflow -- or
 * several -- from invoking the same job from more than one entry, each with
 * its own `context:`. There is no "the" workflow entry a job's steps belong
 * to while you are looking at `jobs.<name>.steps`, only "every place that
 * invokes this job", so this returns the union across all of them rather
 * than guessing at one.
 *
 * This can offer a name that is not attached on *every* path that runs this
 * job -- an entry with no `context:` at all still shares the job body with
 * one that has `context: [deploy-prod]`. That is a real, accepted gap, not
 * an oversight: the alternative (offer nothing unless every invocation
 * agrees) throws away a completion that is genuinely valid whenever the
 * entry that attaches it is the one that runs, on the strength of a sibling
 * entry that never claimed otherwise. `referencedContexts` already makes
 * the identical call for the run-confirmation dialog (issue #194), which
 * lists every context *any* job in the config might ask for rather than
 * intersecting across jobs -- this keeps the two consistent rather than
 * inventing a stricter rule just for completions.
 *
 * What this function's caller must still get right, and what makes the gap
 * above acceptable rather than the exact failure issue #23 warns against: it
 * is scoped to contexts *this job* attaches through *some* real workflow
 * entry, never to the organisation's full context list. An org-wide list
 * would offer a name with no path to it ever being true; this offers a name
 * that is true on at least one path, which is offering less than a
 * guarantee but strictly more than nothing.
 */
export function contextsForJob(
  doc: Document | null,
  jobName: string,
): string[] {
  if (!doc) return [];
  return collectContextNames(doc, (node) => node.jobName === jobName);
}

/**
 * Shared walk behind `referencedContexts` and `contextsForJob`: every
 * `context:` name on a node `include` accepts, deduplicated, in document
 * order.
 */
function collectContextNames(
  doc: Document,
  include: (node: GraphNode) => boolean,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const workflow of listWorkflows(doc)) {
    for (const node of buildWorkflowGraph(doc, workflow).nodes) {
      if (!include(node)) continue;
      for (const name of node.entryOptions.context) {
        const trimmed = name.trim();
        // A `context:` entry that is a parameter reference
        // (`<< pipeline.parameters.ctx >>`) names no context this editor can
        // resolve, and pretending otherwise would produce a confident
        // "no context with this name" about something that will resolve fine
        // at run time. Skipped rather than reported as missing.
        if (trimmed === '' || trimmed.includes('<<')) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        names.push(trimmed);
      }
    }
  }

  return names;
}
