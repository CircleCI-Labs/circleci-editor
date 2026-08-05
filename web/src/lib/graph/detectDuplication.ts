/**
 * Read-only detection of the two shapes of repetition issue #79 calls out
 * as worth *offering* to fix, not just noticing: two or more jobs with
 * byte-for-byte identical inline executors, or byte-for-byte identical
 * `steps:`. Both are real signals a reusable definition would help --
 * "the reusable config mindset ... is a gateway to CircleCI orbs" -- and
 * both are mechanical enough to extract as a safe, undoable AST edit (see
 * `configMutations.extractSharedExecutor`/`extractSharedCommand`, which
 * this module's output feeds).
 *
 * Deliberately narrow about what counts as "duplicate":
 *
 *  - An executor only counts if it's inline (`resolveJobExecutor`'s
 *    `source === 'job'`) -- a job already on a named `executor:` is already
 *    doing the reusable thing, so it's not a candidate to *become* one.
 *  - Steps must match as a *whole array*, not a subsequence. Detecting (and
 *    then safely extracting) a shared subsequence embedded in otherwise
 *    different jobs is a meaningfully harder problem -- which steps of a
 *    longer list "belong" to the shared part is not always unambiguous once
 *    parameters or ordering-sensitive steps are involved -- and issue #79's
 *    own hard constraint is "if you can't make a given refactor safe, offer
 *    fewer refactors rather than unsafe ones." Whole-array matching has an
 *    unambiguous extraction (replace the whole list with one command
 *    reference); anything narrower is left for a future issue.
 *  - A job whose only step is the bare `checkout` is excluded even if
 *    several jobs share it -- extracting a "command" that saves nothing
 *    over writing `checkout` directly would be noise, not a nudge toward
 *    reuse.
 *
 * Pure and framework-free -- no React, no zustand -- same convention as the
 * rest of `~/lib`.
 */
import type { Document } from 'yaml';

import { getJobNames, getIn } from '~/lib/yaml/documentUtils';
import { resolveJobExecutor, type ExecutorKind } from './resolveExecutor';

export interface DuplicateExecutorGroup {
  /** Stable identity for this group across re-renders -- the jobs sharing this exact executor shape, in document order. */
  jobNames: string[];
  kind: Exclude<ExecutorKind, 'unknown'>;
  /** The shared image (or Xcode version, for `macos`), shown in the suggestion so it's clear which jobs/image this is about without opening each one. */
  image: string | undefined;
}

export interface DuplicateStepsGroup {
  jobNames: string[];
  /** Number of steps in the shared sequence -- shown so the suggestion reads as "12 identical steps", not just "these jobs match". */
  stepCount: number;
}

/**
 * A JSON-stable signature for one job's *inline* executor, or `null` when
 * the job has no inline executor to compare (it's on a named `executor:`,
 * an orb executor, or nothing at all). Reuses `resolveJobExecutor` rather
 * than re-reading `docker:`/`machine:`/`macos:` itself, so this stays
 * consistent with the inspector's own idea of what a job's executor is --
 * including issue #35's merge-key resolution, which a naive `getIn` here
 * would silently miss.
 *
 * Exported (as `executorSignatureKey`, the string alone) so
 * `configMutations.extractSharedExecutor` can re-verify, immediately before
 * it mutates anything, that the jobs it was asked to merge are still
 * identical -- the document may have changed since whatever computed
 * `DuplicateExecutorGroup` last ran, and a partial extraction across jobs
 * that turned out to differ would silently change behavior for whichever
 * ones didn't actually match. Both callers must derive "identical" the same
 * way, or a job the UI showed as part of a group could fail that re-check
 * for a reason the user never saw.
 */
function inlineExecutorSignature(
  doc: Document,
  jobName: string,
): {
  key: string;
  kind: Exclude<ExecutorKind, 'unknown'>;
  image: string | undefined;
} | null {
  const resolved = resolveJobExecutor(doc, jobName);
  if (resolved.source !== 'job' || resolved.kind === 'unknown') return null;
  const key = JSON.stringify({
    kind: resolved.kind,
    image: resolved.image ?? null,
    serviceImages: resolved.serviceImages,
    resourceClass: resolved.resourceClass ?? null,
    workingDirectory: resolved.workingDirectory ?? null,
    dockerLayerCaching: resolved.dockerLayerCaching ?? null,
  });
  return { key, kind: resolved.kind, image: resolved.image };
}

/**
 * Groups every job by its inline executor's exact signature, returning only
 * the groups with two or more members -- a group of one is not a
 * duplication to offer anything about.
 */
export function findDuplicateExecutors(
  doc: Document,
): DuplicateExecutorGroup[] {
  const byKey = new Map<
    string,
    {
      jobNames: string[];
      kind: Exclude<ExecutorKind, 'unknown'>;
      image: string | undefined;
    }
  >();

  for (const jobName of getJobNames(doc)) {
    const sig = inlineExecutorSignature(doc, jobName);
    if (!sig) continue;
    const entry = byKey.get(sig.key);
    if (entry) entry.jobNames.push(jobName);
    else
      byKey.set(sig.key, {
        jobNames: [jobName],
        kind: sig.kind,
        image: sig.image,
      });
  }

  return [...byKey.values()]
    .filter((group) => group.jobNames.length >= 2)
    .map((group) => ({
      jobNames: group.jobNames,
      kind: group.kind,
      image: group.image,
    }));
}

/** `true` for the one steps shape this module deliberately treats as "not worth extracting" -- see the module doc. */
function isTrivialSteps(steps: unknown[]): boolean {
  return steps.length === 1 && steps[0] === 'checkout';
}

/**
 * Groups every job by its whole `steps:` array, compared structurally (via
 * a JSON signature -- steps are already plain, order-sensitive JS values by
 * the time `getIn` returns them, so this is exactly the "byte-for-byte
 * identical" comparison the module doc promises, without needing a custom
 * deep-equal). Returns only groups with two or more members and at least
 * one real step.
 */
export function findDuplicateStepSequences(
  doc: Document,
): DuplicateStepsGroup[] {
  const byKey = new Map<string, { jobNames: string[]; stepCount: number }>();

  for (const jobName of getJobNames(doc)) {
    const steps = getIn(doc, ['jobs', jobName, 'steps']);
    if (!Array.isArray(steps) || steps.length === 0 || isTrivialSteps(steps))
      continue;
    const key = JSON.stringify(steps);
    const entry = byKey.get(key);
    if (entry) entry.jobNames.push(jobName);
    else byKey.set(key, { jobNames: [jobName], stepCount: steps.length });
  }

  return [...byKey.values()].filter((group) => group.jobNames.length >= 2);
}

/**
 * The signature string alone (no kind/image breakout) for one job's inline
 * executor, or `null` when it has none -- see `inlineExecutorSignature`'s
 * doc comment for why this is exported and who uses it.
 */
export function executorSignatureKey(
  doc: Document,
  jobName: string,
): string | null {
  return inlineExecutorSignature(doc, jobName)?.key ?? null;
}
