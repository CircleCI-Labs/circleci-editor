/**
 * Which CircleCI contexts the open config actually asks for.
 *
 * Needed by issue #194's run confirmation, which has to say what a run will
 * touch *before* it spends anything. A context restricted to other projects is
 * the failure mode this exists to surface: the config compiles, the pipeline
 * starts, and the job dies when CircleCI declines to hand over the context --
 * which is precisely the `other-projects-only` case, now costing credits
 * instead of costing nothing.
 *
 * Read from the `Document`, not from the text: the `eemeli/yaml` Document is
 * this app's single source of truth for what the config says, and
 * `buildWorkflowGraph` already normalises `context:` from CircleCI's
 * bare-string-or-list shorthand into a list. Re-parsing here would be a second
 * opinion about the same file, which is how the two drift.
 */
import type { Document } from 'yaml';

import { buildWorkflowGraph, listWorkflows } from '~/lib/graph/buildGraph';

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

  const seen = new Set<string>();
  const names: string[] = [];

  for (const workflow of listWorkflows(doc)) {
    for (const node of buildWorkflowGraph(doc, workflow).nodes) {
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
