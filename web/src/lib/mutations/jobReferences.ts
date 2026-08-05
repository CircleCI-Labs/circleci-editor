/**
 * "What will this rename/delete actually touch?" -- the read-only half of
 * issue #12.
 *
 * `configMutations.ts` already reconciles every cross-reference when a job is
 * renamed or deleted. What it cannot do is *tell the user first*, and issue
 * #12's failure mode is as much about surprise as about correctness: a job
 * name lives in up to four different places (its `jobs:` map key, every
 * workflow entry naming it, every `requires:` list mentioning it, and any
 * `name:` alias built on top of it), so an edit made in one pane silently
 * rewrites lines in three others. This module enumerates those sites so the
 * confirmation prompts can name them concretely ("`test` is required by
 * `build` and `deploy`") instead of asking a generic "are you sure?".
 *
 * Two rules this module exists to get right, and which the prompts depend on:
 *
 * 1. **Alias semantics.** `requires:` never references a bare job name when
 *    the entry carrying that job has a `name:` alias -- it references the
 *    alias. So `- some-job: {name: test}` makes `test` mean *that entry*, and
 *    a rename of the *job* `test` must leave `requires: [test]` in that
 *    workflow completely alone. `shadowedWorkflows` reports exactly those
 *    workflows, and `renameJob` skips them for the same reason.
 * 2. **No auto-rewiring.** Deleting a job in the middle of a chain removes
 *    the references to it and stops. The dependents are *not* reconnected to
 *    the dependencies, so `describeDeleteImpact`
 *    says so out loud rather than leaving the user to discover a pipeline
 *    nobody asked for.
 *
 * Pure and framework-free, like the rest of `~/lib`: it reads a `Document`
 * and returns plain data, and never mutates anything.
 */
import {
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Pair,
  type YAMLMap,
} from 'yaml';

import {
  findAliasSites,
  getJobNames,
  getNode,
  getWorkflowNames,
  parseRequiresEntries,
} from '~/lib/yaml/documentUtils';

/** One workflow job entry that resolves to the job in question. */
export interface WorkflowEntryReference {
  workflowName: string;
  /** Index within the workflow's `jobs:` sequence. */
  index: number;
  /**
   * The id `requires:` uses for this entry -- its `name:` alias when it has
   * one, otherwise the bare job name. Matches `buildGraph`'s node id.
   */
  entryId: string;
  /** True when the entry carries an explicit `name:` key, i.e. `entryId` is an alias rather than the job name. */
  aliased: boolean;
}

/** One `requires:` item pointing at the job (via a matching entry's id). */
export interface RequiresReference {
  workflowName: string;
  /** The id of the entry whose `requires:` list holds this item. */
  requiredBy: string;
  /** The id written inside `requires:` -- an entry id, so an alias when the target entry is aliased. */
  referencedId: string;
  /** Index within that entry's `requires:` sequence. */
  index: number;
}

export interface JobReferences {
  jobName: string;
  /** False when `jobs.<jobName>` doesn't exist (an orb job, or a workflow entry with no definition). */
  defined: boolean;
  /** Workflow entries whose underlying job is `jobName`, across every workflow. */
  entries: WorkflowEntryReference[];
  /** `requires:` items resolving to one of `entries` -- i.e. what would dangle. */
  requires: RequiresReference[];
  /**
   * Workflows where the bare name `jobName` is *taken* by some other job's
   * `name:` alias. In those workflows `requires: [jobName]` refers to that
   * entry, not to this job, and must be left untouched by a rename -- see
   * this module's own doc comment, rule 1.
   */
  shadowedWorkflows: string[];
  /**
   * Workflows in which a `requires: <jobName>` would be rewritten by a
   * rename, i.e. where the bare job name is genuinely this job's id. Mirrors
   * `configMutations.shouldRenameRequiresIn` exactly -- the prompt must
   * promise the same set of edits the mutation performs, or it is lying.
   * Excludes both a workflow where another job is aliased `name: jobName` and
   * the degenerate `- jobName: {name: jobName}`, whose id survives the rename.
   */
  requiresRewrittenOnRenameIn: string[];
  /**
   * Human-readable reasons a *delete* would be refused outright before it
   * changes anything: the job definition, or one of the workflow entries
   * about to be removed, is a YAML anchor something else still aliases (see
   * `documentUtils.findAliasSites`). Empty in the overwhelmingly common case.
   * A rename is never blocked by these -- it only ever rewrites a key, never
   * removes the node an anchor lives on.
   */
  deleteBlockers: string[];
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

interface ParsedEntry {
  index: number;
  jobName: string;
  entryId: string;
  aliased: boolean;
  requires: { id: string; index: number }[];
}

/**
 * Reads one workflow's `jobs:` into the id/job-name/requires shape both the
 * graph reader and the mutation layer already agree on (`buildGraph`'s
 * `parseEntries`, `configMutations`'s `readEntries`) -- kept separate from
 * both because this one additionally needs each `requires:` item's *index*,
 * which neither of those exposes, and needs to stay a detached read (no live
 * nodes) since callers hand its output to React state.
 */
function parseWorkflowEntries(
  doc: Document,
  workflowName: string,
): ParsedEntry[] {
  const seq = getNode(doc, ['workflows', workflowName, 'jobs']);
  if (!isSeq(seq)) return [];

  const entries: ParsedEntry[] = [];
  seq.items.forEach((item, index) => {
    if (isScalar(item)) {
      const jobName = String(item.value);
      entries.push({
        index,
        jobName,
        entryId: jobName,
        aliased: false,
        requires: [],
      });
      return;
    }
    if (!isMap(item) || item.items.length === 0) return;
    const pair = item.items[0] as Pair;
    const jobName = isScalar(pair.key) ? String(pair.key.value) : '';
    let entryId = jobName;
    let aliased = false;
    let requires: { id: string; index: number }[] = [];
    const options = pair.value;
    if (isMap(options)) {
      const namePair = findPair(options, 'name');
      if (namePair && isScalar(namePair.value)) {
        entryId = String(namePair.value.value);
        aliased = true;
      }
      const requiresPair = findPair(options, 'requires');
      requires = parseRequiresEntries(requiresPair?.value).map((ref, i) => ({
        id: ref.id,
        index: i,
      }));
    }
    entries.push({ index, jobName, entryId, aliased, requires });
  });
  return entries;
}

/**
 * Enumerates every place `jobName` is referenced, across the whole document.
 * Never throws and never mutates: an unknown job simply comes back with
 * `defined: false` and whatever workflow entries happen to name it anyway
 * (which is a real, renderable state -- see `GraphNode.isDefined`).
 */
export function findJobReferences(
  doc: Document,
  jobName: string,
): JobReferences {
  const defined = getJobNames(doc).includes(jobName);
  const entries: WorkflowEntryReference[] = [];
  const requires: RequiresReference[] = [];
  const shadowedWorkflows: string[] = [];
  const requiresRewrittenOnRenameIn: string[] = [];
  const deleteBlockers: string[] = [];

  if (defined) {
    for (const site of findAliasSites(doc, ['jobs', jobName])) {
      deleteBlockers.push(
        `the job definition jobs.${jobName} is a YAML anchor still aliased by "${site}"`,
      );
    }
  }

  for (const workflowName of getWorkflowNames(doc)) {
    const parsed = parseWorkflowEntries(doc, workflowName);
    const mine = parsed.filter((entry) => entry.jobName === jobName);

    // A *different* job's entry aliased as `jobName` owns that name for
    // `requires:` purposes in this workflow -- rule 1 in the module doc.
    const claimants = parsed.filter((entry) => entry.entryId === jobName);
    if (claimants.some((entry) => entry.jobName !== jobName)) {
      shadowedWorkflows.push(workflowName);
    }
    if (
      claimants.length > 0 &&
      claimants.every((entry) => entry.jobName === jobName && !entry.aliased)
    ) {
      requiresRewrittenOnRenameIn.push(workflowName);
    }

    for (const entry of mine) {
      entries.push({
        workflowName,
        index: entry.index,
        entryId: entry.entryId,
        aliased: entry.aliased,
      });
      for (const site of findAliasSites(doc, [
        'workflows',
        workflowName,
        'jobs',
        entry.index,
      ])) {
        deleteBlockers.push(
          `"${entry.entryId}"'s entry in workflow "${workflowName}" is a YAML anchor still aliased by "${site}"`,
        );
      }
    }

    const myIds = new Set(mine.map((entry) => entry.entryId));
    if (myIds.size === 0) continue;
    for (const entry of parsed) {
      for (const req of entry.requires) {
        if (!myIds.has(req.id)) continue;
        requires.push({
          workflowName,
          requiredBy: entry.entryId,
          referencedId: req.id,
          index: req.index,
        });
      }
    }
  }

  return {
    jobName,
    defined,
    entries,
    requires,
    shadowedWorkflows,
    requiresRewrittenOnRenameIn,
    deleteBlockers,
  };
}

/**
 * How many distinct sites an edit to this job would touch: the definition
 * itself (when it exists), each workflow entry, and each `requires:` item.
 * This is the number the prompts key their "is there anything to warn about
 * at all?" decision off -- a job referenced exactly once (its definition, and
 * nothing else) has no cross-references to reconcile and needs no prompt.
 */
export function countReferenceSites(refs: JobReferences): number {
  return (refs.defined ? 1 : 0) + refs.entries.length + refs.requires.length;
}

/** True when the edit touches something beyond the job definition itself. */
export function hasCrossReferences(refs: JobReferences): boolean {
  return refs.entries.length > 0 || refs.requires.length > 0;
}

/**
 * Whether a *rename* is worth prompting about -- deliberately narrower than
 * `hasCrossReferences`.
 *
 * A job with exactly one un-aliased workflow entry and nothing requiring it
 * has one visible reference: the node the user is looking at while typing the
 * new name. Renaming it is not a surprise, and prompting every time would make
 * the prompt something to dismiss reflexively rather than read. What *is*
 * worth stopping for is a reference the user cannot see from here:
 *
 *  - anything's `requires:` naming this job -- possibly in another workflow;
 *  - a second entry sharing the definition (the issue #36 case: one rename,
 *    several nodes change at once);
 *  - a workflow where the bare name is some other job's `name:` alias, which
 *    is the case most likely to look like a bug afterwards precisely *because*
 *    nothing changed there.
 */
export function renameNeedsConfirmation(refs: JobReferences): boolean {
  return (
    refs.requires.length > 0 ||
    refs.entries.length > 1 ||
    refs.shadowedWorkflows.length > 0
  );
}

/**
 * The concrete list a confirmation prompt renders: one line per site that
 * will change, plus `notes` for things that are true but aren't a site
 * (shadowed workflows, the deliberate absence of auto-rewiring) and
 * `blockers` for a delete that will be refused before it starts.
 */
export interface ReferenceImpact {
  /** One short sentence naming the operation and its blast radius. */
  headline: string;
  /** One line per site that will be rewritten or removed. */
  lines: string[];
  /** Caveats: what deliberately *won't* change, and why. */
  notes: string[];
  /** Non-empty when the operation will be refused outright -- see `JobReferences.deleteBlockers`. */
  blockers: string[];
}

function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Groups `requires:` references by the workflow they live in, preserving first-seen order. */
function groupByWorkflow(
  refs: RequiresReference[],
): { workflowName: string; requiredBy: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const existing = groups.get(ref.workflowName);
    if (existing) {
      if (!existing.includes(ref.requiredBy)) existing.push(ref.requiredBy);
    } else {
      groups.set(ref.workflowName, [ref.requiredBy]);
    }
  }
  return [...groups].map(([workflowName, requiredBy]) => ({
    workflowName,
    requiredBy,
  }));
}

/** `["a"] -> "a"`, `["a","b"] -> "a and b"`, `["a","b","c"] -> "a, b and c"` -- for prose, not for code. */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What renaming `jobName` to `newName` will change. Only entries and
 * `requires:` items whose id is the *bare job name* are rewritten -- an
 * aliased entry keeps its alias, and every `requires:` mention of that alias
 * keeps pointing at it, which is why an aliased entry shows up as a note
 * rather than a rewritten line.
 */
export function describeRenameImpact(
  doc: Document,
  jobName: string,
  newName: string,
): ReferenceImpact {
  const refs = findJobReferences(doc, jobName);
  const lines: string[] = [];
  const notes: string[] = [];

  if (refs.defined) {
    lines.push(`the job definition: jobs.${jobName} becomes jobs.${newName}`);
  }

  const unaliased = refs.entries.filter((entry) => !entry.aliased);
  const aliased = refs.entries.filter((entry) => entry.aliased);

  for (const group of groupEntriesByWorkflow(unaliased)) {
    lines.push(
      `workflow "${group.workflowName}": ${pluralize(group.count, 'job entry', 'job entries')} renamed to ${newName}`,
    );
  }
  for (const group of groupEntriesByWorkflow(aliased)) {
    lines.push(
      `workflow "${group.workflowName}": ${pluralize(group.count, 'aliased entry', 'aliased entries')} now ${group.count === 1 ? 'points' : 'point'} at ${newName}`,
    );
  }
  if (aliased.length > 0) {
    notes.push(
      `${pluralize(aliased.length, 'entry', 'entries')} aliases this job with name:, so its alias -- and every requires: that names the alias -- stays exactly as it is.`,
    );
  }

  // Only an unaliased entry's id changes, so only a `requires:` naming the
  // bare job name -- in a workflow where that name really is this job's id --
  // gets rewritten. See `requiresRewrittenOnRenameIn`.
  const renamedRequires = refs.requires.filter(
    (ref) =>
      ref.referencedId === jobName &&
      refs.requiresRewrittenOnRenameIn.includes(ref.workflowName),
  );
  for (const group of groupByWorkflow(renamedRequires)) {
    lines.push(
      `workflow "${group.workflowName}": ${jobName} is required by ${listSentence(group.requiredBy)} -- ${group.requiredBy.length === 1 ? 'that requires: is' : 'those requires: are'} updated to ${newName}`,
    );
  }

  for (const workflowName of refs.shadowedWorkflows) {
    notes.push(
      `workflow "${workflowName}" has a different job aliased name: ${jobName}, so requires: ${jobName} there refers to that entry, not this job -- it is left untouched.`,
    );
  }

  // Sites actually rewritten: the definition, every entry naming the job
  // (aliased or not -- the entry *key* changes either way), and only those
  // `requires:` items that spell the bare job name.
  const rewrittenSites =
    (refs.defined ? 1 : 0) + refs.entries.length + renamedRequires.length;

  return {
    headline: `Renaming ${jobName} to ${newName} rewrites ${pluralize(rewrittenSites, 'place')}.`,
    lines,
    notes,
    // A rename only ever rewrites a key or a scalar's value; it never removes
    // the node a YAML anchor lives on, so it can't strand an alias.
    blockers: [],
  };
}

/** Same grouping as `groupByWorkflow`, for entry references. */
function groupEntriesByWorkflow(
  entries: WorkflowEntryReference[],
): { workflowName: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.workflowName, (counts.get(entry.workflowName) ?? 0) + 1);
  }
  return [...counts].map(([workflowName, count]) => ({ workflowName, count }));
}

/**
 * What deleting `jobName` will change -- and, just as importantly, what it
 * deliberately *won't*: dependents of a deleted job are never re-pointed at
 * that job's own dependencies. The resulting graph may be missing a
 * link the user wanted; the prompt says so, and the DAG then renders the
 * result honestly rather than inventing an edge.
 */
export function describeDeleteImpact(
  doc: Document,
  jobName: string,
): ReferenceImpact {
  const refs = findJobReferences(doc, jobName);
  const lines: string[] = [];
  const notes: string[] = [];

  if (refs.defined) lines.push(`the job definition: jobs.${jobName}`);

  for (const group of groupEntriesByWorkflow(refs.entries)) {
    lines.push(
      `workflow "${group.workflowName}": ${pluralize(group.count, 'job entry', 'job entries')} removed`,
    );
  }

  const groups = groupByWorkflow(refs.requires);
  for (const group of groups) {
    lines.push(
      `workflow "${group.workflowName}": removed from ${listSentence(group.requiredBy)}'s requires:`,
    );
  }

  if (groups.length > 0) {
    const dependents = [...new Set(refs.requires.map((ref) => ref.requiredBy))];
    notes.push(
      `${listSentence(dependents)} ${dependents.length === 1 ? 'is' : 'are'} not re-pointed at whatever ${jobName} required -- reconnect ${dependents.length === 1 ? 'it' : 'them'} yourself if that's what you want.`,
    );
  }

  return {
    headline: `Deleting ${jobName} changes ${pluralize(countReferenceSites(refs), 'place')}.`,
    lines,
    notes,
    blockers: refs.deleteBlockers,
  };
}
