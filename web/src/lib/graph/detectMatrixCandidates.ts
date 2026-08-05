/**
 * Read-only detection of issue #292's second approved recommendation: a job
 * invoked several times in the same workflow with only its *arguments*
 * differing -- exactly the shape a `matrix:` stanza (issue #284, now that
 * the graph can actually model one -- see `~/lib/yaml/matrixExpansion.ts`)
 * expresses once instead of once per invocation.
 *
 * Deliberately detection-only, with no extraction mutation to go with it
 * (contrast `detectDuplication.ts`, whose two groups each feed a
 * `configMutations.extractShared*`). Collapsing N workflow entries into one
 * matrix entry is a materially bigger edit than either of those: it has to
 * pick a parameter declaration shape, decide what the matrix's `name:`
 * template should be (the entries being replaced may not agree on a
 * pattern), and re-point every `requires:` elsewhere in the workflow that
 * named one of the individual entries at the matrix's alias instead --
 * exactly the kind of "N call sites move to a shared definition" reference
 * rewrite issue #79's own hard constraint ("if you can't make a refactor
 * safe, offer fewer refactors than unsafe ones") argues against attempting
 * as a first cut. So this module only ever informs, with a concrete example
 * built from the user's own workflow and a docs link to do it by hand.
 *
 * Pure and framework-free, same convention as `detectDuplication.ts`.
 */
import type { Document } from 'yaml';

import { getIn, getWorkflowNames, type Path } from '~/lib/yaml/documentUtils';

/**
 * Workflow-entry keys that are never a matrix *parameter* -- mirrors
 * `configMutations`'s own `RESERVED_ENTRY_OPTION_KEYS` (that copy isn't
 * exported; `jobReferences.ts` keeps an equivalent copy of its own for the
 * same reason: this is a small, stable list, and importing across module
 * boundaries just to share it buys nothing over restating it, which is the
 * precedent both of those files already set).
 */
const RESERVED_ENTRY_OPTION_KEYS = new Set([
  'name',
  'type',
  'requires',
  'context',
  'filters',
  'matrix',
  'pre-steps',
  'post-steps',
]);

export interface MatrixCandidateGroup {
  workflowName: string;
  jobName: string;
  /** This invocation's `name:` alias, or the bare job name when it has none -- for display only. */
  entryIds: string[];
  /** Argument names that vary across the invocations, in first-seen order. */
  paramNames: string[];
  /** One combination per invocation, values for `paramNames` only. */
  combos: Record<string, unknown>[];
}

interface RawEntry {
  jobName: string;
  entryId: string;
  options: Record<string, unknown> | null;
}

/** Reads one workflow's `jobs:` as plain data via `getIn`, which already resolves aliases/merges -- no YAML-node handling needed for a read-only detector. */
function readEntries(doc: Document, workflowName: string): RawEntry[] {
  const raw = getIn(doc, ['workflows', workflowName, 'jobs'] as Path);
  if (!Array.isArray(raw)) return [];

  const entries: RawEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ jobName: item, entryId: item, options: null });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const [jobName, rawOptions] = Object.entries(
      item as Record<string, unknown>,
    )[0] ?? [undefined, undefined];
    if (typeof jobName !== 'string') continue;
    const options =
      rawOptions !== null &&
      typeof rawOptions === 'object' &&
      !Array.isArray(rawOptions)
        ? (rawOptions as Record<string, unknown>)
        : null;
    const entryId =
      options && typeof options.name === 'string' ? options.name : jobName;
    entries.push({ jobName, entryId, options });
  }
  return entries;
}

/** The non-reserved keys of `options`, sorted for a stable shape comparison across invocations. */
function paramKeys(options: Record<string, unknown>): string[] {
  return Object.keys(options)
    .filter((key) => !RESERVED_ENTRY_OPTION_KEYS.has(key))
    .sort();
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** Whether at least one of `paramNames` takes more than one distinct value across `combos` -- the fact that makes this a matrix candidate rather than N identical calls. */
function hasVariation(
  paramNames: string[],
  combos: Record<string, unknown>[],
): boolean {
  return paramNames.some((name) => {
    const values = new Set(combos.map((combo) => JSON.stringify(combo[name])));
    return values.size > 1;
  });
}

/**
 * Groups every workflow's repeated invocations of the same job by identical
 * argument *shape* (same parameter names, differing values), returning only
 * groups with two or more invocations, at least one real parameter, and at
 * least one parameter that actually varies.
 *
 * An invocation that already has its own `matrix:` is excluded -- it is
 * already the thing this module recommends moving *to*, not a candidate for
 * it. A bare-string invocation (no arguments at all) is excluded too: it
 * cannot be reconciled with a param-carrying sibling into one matrix without
 * inventing values it never supplied.
 */
export function findMatrixCandidates(doc: Document): MatrixCandidateGroup[] {
  const groups: MatrixCandidateGroup[] = [];

  for (const workflowName of getWorkflowNames(doc)) {
    const byJob = new Map<string, RawEntry[]>();
    for (const entry of readEntries(doc, workflowName)) {
      if (!entry.options || 'matrix' in entry.options) continue;
      const existing = byJob.get(entry.jobName);
      if (existing) existing.push(entry);
      else byJob.set(entry.jobName, [entry]);
    }

    for (const [jobName, entries] of byJob) {
      if (entries.length < 2) continue;
      const keysPerEntry = entries.map((e) => paramKeys(e.options!));
      const first = keysPerEntry[0]!;
      if (first.length === 0) continue;
      if (!keysPerEntry.every((keys) => sameKeys(keys, first))) continue;

      const combos = entries.map((e) => {
        const combo: Record<string, unknown> = {};
        for (const key of first) combo[key] = e.options![key];
        return combo;
      });
      if (!hasVariation(first, combos)) continue;

      groups.push({
        workflowName,
        jobName,
        entryIds: entries.map((e) => e.entryId),
        paramNames: first,
        combos,
      });
    }
  }

  return groups;
}
