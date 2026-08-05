/**
 * Pure resolution of "what executor does this job actually run on", given
 * that CircleCI lets a job either define its executor inline (`docker:`,
 * `machine:`, `macos:` directly under the job) or reuse one defined once
 * under top-level `executors:` via `executor: <name>` (or
 * `executor: { name: <name>, ... }`, the form that also passes parameters).
 *
 * Before this module existed, the inspector read `job.docker[0].image` and
 * `job.resource_class` straight off the job -- which is exactly wrong for
 * the (recommended, common) reusable-executor pattern: those fields simply
 * don't exist on a job that says `executor: python-lint-executor`, so the
 * inspector showed nothing, or worse, a stale value left over from whatever
 * job was selected before (see issue #27). This module centralizes the
 * "where do this job's executor fields actually come from" logic so every
 * consumer -- today's inspector, and whatever needs it next -- resolves it
 * the same way exactly once.
 *
 * Pure and framework-free -- no React, no zustand -- same as the rest of
 * `~/lib`. Built entirely on top of `documentUtils`'s `getIn`/`listKeys`
 * rather than walking raw YAML nodes: every field this module cares about
 * (`docker`, `machine`, `macos`, `resource_class`, `working_directory`,
 * `executor`) is read-only here, so there's no need for the surgical,
 * comment-preserving node access `setIn`/`deleteIn` exist for.
 */
import type { Document } from 'yaml';

import { getIn, getInWithOrigin, listKeys } from '~/lib/yaml/documentUtils';

export type ExecutorKind = 'docker' | 'machine' | 'macos' | 'unknown';

export interface ResolvedExecutor {
  /** Where the values below came from. */
  source: 'job' | 'executor' | 'orb' | 'none';
  /** Executor name when source is 'executor' or 'orb' (e.g. "python-lint-executor", "python/default"). */
  name?: string;
  kind: ExecutorKind;
  /** Primary image: docker[0].image, machine.image, or the macOS xcode version. */
  image?: string;
  /** Additional docker images beyond the primary (service containers). */
  serviceImages: string[];
  resourceClass?: string;
  workingDirectory?: string;
  /** True when the job sets a field directly, shadowing the named executor. */
  jobOverrides: string[];
  /**
   * Field names (from the same vocabulary as `jobOverrides` -- both single
   * out "this field's value isn't quite what it looks like") whose value
   * comes from a `<<` merge key rather than being written literally at the
   * job or `executors:` entry it was read from. Omitted (rather than `[]`)
   * when nothing was merge-inherited, matching how `unresolvable` and
   * `dockerLayerCaching` are already optional here. See issue #35 --
   * before `documentUtils` learned to resolve merge keys, these fields were
   * simply invisible, so there was nothing to report as overridden *or*
   * inherited; now that they resolve, a caller needs to be able to tell the
   * two apart before letting a user "edit" what looks like a plain field.
   */
  mergeInherited?: string[];
  /** The anchor each `mergeInherited` field came from, when determinable. */
  mergeSource?: Record<string, string>;
  /** Set when the executor is orb-provided and therefore not resolvable locally. */
  unresolvable?: boolean;
  /**
   * `machine` executors only: whether Docker Layer Caching is enabled.
   * Not part of the shape the panes layer and this module agreed on above
   * (kept exactly as specified so nothing has to be renegotiated) -- this
   * is an additive, optional field on top of it. Any consumer destructuring
   * only the fields it already knows about is unaffected by its presence.
   */
  dockerLayerCaching?: boolean;
}

/** A `ResolvedExecutor` with nothing resolved -- the shared "give up" value. */
function emptyResolution(name?: string): ResolvedExecutor {
  return {
    source: 'none',
    name,
    kind: 'unknown',
    serviceImages: [],
    jobOverrides: [],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The subset of `ResolvedExecutor` that comes purely from *one*
 * `docker:`/`machine:`/`macos:`-shaped node -- a job's own inline executor
 * fields, or a single `executors:` entry. Kept separate from
 * `ResolvedExecutor` because `resolveJobExecutor` has to read this shape
 * twice over (once for the job, in case it defines its executor inline; once
 * for the named `executors:` entry it points at) and then decide, per
 * field, whether the job's own value should win -- that decision (and the
 * `jobOverrides`/`source`/`unresolvable` bookkeeping around it) belongs to
 * the caller, not to this shape-reader.
 */
interface ExecutorShape {
  kind: ExecutorKind;
  image?: string;
  serviceImages: string[];
  resourceClass?: string;
  workingDirectory?: string;
  dockerLayerCaching?: boolean;
  /**
   * Field names within this one shape (see `ResolvedExecutor.mergeInherited`
   * for the full rationale) whose value came from a `<<` merge key rather
   * than being written literally at `path`. Always present here (unlike on
   * `ResolvedExecutor`, where it's omitted when empty) since this is an
   * internal accumulator, not part of the shape returned to a caller.
   */
  mergeInherited: string[];
  /** The anchor each `mergeInherited` field came from, when determinable. */
  mergeSource: Record<string, string>;
}

/** Records that `field` was merge-inherited, if `resolved.origin` says so. */
function noteMerge(
  mergeInherited: string[],
  mergeSource: Record<string, string>,
  field: string,
  resolved: { origin: 'own' | 'merged' | 'absent'; via?: string },
): void {
  if (resolved.origin !== 'merged') return;
  mergeInherited.push(field);
  if (resolved.via !== undefined) mergeSource[field] = resolved.via;
}

/**
 * Reads the executor-shaped fields directly at `path` (a job, or one
 * `executors:` entry). `docker:` is checked before `machine:`/`macos:`
 * because a job is never expected to declare more than one, but a
 * defensively-malformed config could -- in that case `docker:` wins,
 * matching CircleCI's own documented precedence for the (invalid, but not
 * worth throwing over) case of multiple executor types on one job.
 *
 * Uses `getInWithOrigin` instead of `getIn` for every field so a field this
 * job/executor only has because it merges in an anchor (issue #35) is (a)
 * actually readable at all -- before `documentUtils` resolved merge keys,
 * it simply wasn't -- and (b) distinguishable from one written literally
 * here, via the `mergeInherited`/`mergeSource` accumulators.
 */
function readExecutorShape(
  doc: Document,
  path: (string | number)[],
): ExecutorShape {
  const mergeInherited: string[] = [];
  const mergeSource: Record<string, string> = {};

  const dockerResolved = getInWithOrigin(doc, [...path, 'docker']);
  const docker = dockerResolved.value;
  const resourceClassResolved = getInWithOrigin(doc, [
    ...path,
    'resource_class',
  ]);
  const resourceClass = asString(resourceClassResolved.value);
  const workingDirectoryResolved = getInWithOrigin(doc, [
    ...path,
    'working_directory',
  ]);
  const workingDirectory = asString(workingDirectoryResolved.value);
  noteMerge(
    mergeInherited,
    mergeSource,
    'resource_class',
    resourceClassResolved,
  );
  noteMerge(
    mergeInherited,
    mergeSource,
    'working_directory',
    workingDirectoryResolved,
  );

  if (Array.isArray(docker)) {
    noteMerge(mergeInherited, mergeSource, 'docker', dockerResolved);
    const images = docker
      .map((entry) => (isPlainRecord(entry) ? entry.image : undefined))
      .filter((v): v is string => typeof v === 'string');
    return {
      kind: 'docker',
      image: images[0],
      serviceImages: images.slice(1),
      resourceClass,
      workingDirectory,
      mergeInherited,
      mergeSource,
    };
  }

  const machineResolved = getInWithOrigin(doc, [...path, 'machine']);
  const machine = machineResolved.value;
  if (machine !== undefined) {
    noteMerge(mergeInherited, mergeSource, 'machine', machineResolved);
    // `machine:` also accepts a bare `true` (no image/dlc override) as
    // shorthand for "use the default machine executor".
    const machineMap = isPlainRecord(machine) ? machine : {};
    return {
      kind: 'machine',
      image: asString(machineMap.image),
      serviceImages: [],
      resourceClass,
      workingDirectory,
      dockerLayerCaching:
        typeof machineMap.docker_layer_caching === 'boolean'
          ? machineMap.docker_layer_caching
          : undefined,
      mergeInherited,
      mergeSource,
    };
  }

  const macosResolved = getInWithOrigin(doc, [...path, 'macos']);
  const macos = macosResolved.value;
  if (isPlainRecord(macos)) {
    noteMerge(mergeInherited, mergeSource, 'macos', macosResolved);
    return {
      kind: 'macos',
      image: asString(macos.xcode),
      serviceImages: [],
      resourceClass,
      workingDirectory,
      mergeInherited,
      mergeSource,
    };
  }

  return {
    kind: 'unknown',
    serviceImages: [],
    resourceClass,
    workingDirectory,
    mergeInherited,
    mergeSource,
  };
}

/** Spreads `mergeInherited`/`mergeSource` onto a return object, omitting each when empty (see `ResolvedExecutor.mergeInherited`). */
function withMergeProvenance<T extends object>(
  base: T,
  mergeInherited: string[],
  mergeSource: Record<string, string>,
): T {
  return {
    ...base,
    ...(mergeInherited.length ? { mergeInherited } : {}),
    ...(Object.keys(mergeSource).length ? { mergeSource } : {}),
  };
}

/** True when the job under `jobPath` declares an executor inline, rather than (or in addition to) referencing one via `executor:`. */
function hasInlineExecutorFields(
  doc: Document,
  jobPath: (string | number)[],
): boolean {
  return (
    getIn(doc, [...jobPath, 'docker']) !== undefined ||
    getIn(doc, [...jobPath, 'machine']) !== undefined ||
    getIn(doc, [...jobPath, 'macos']) !== undefined
  );
}

/** Lists the names of all top-level `executors:` entries, in document order. */
export function listExecutorNames(doc: Document): string[] {
  return listKeys(doc, ['executors']);
}

/**
 * Resolves the executor `jobName` actually runs on, following a named
 * `executor:` reference to its `executors:` definition when the job uses
 * one, and reporting job-level fields that shadow it (`jobOverrides`) so a
 * caller can distinguish "the executor's own resource class" from "this job
 * bumped it up for itself" instead of presenting an inherited value as if
 * it were the job's.
 *
 * Never throws -- an unknown job, or a job with no usable executor
 * information at all, resolves to `{ source: 'none', kind: 'unknown', ... }`
 * rather than an exception, consistent with the rest of the graph-reading
 * layer treating a malformed/incomplete config as something to describe,
 * not fail on.
 */
export function resolveJobExecutor(
  doc: Document,
  jobName: string,
): ResolvedExecutor {
  const jobPath = ['jobs', jobName];
  const jobNode = getIn(doc, jobPath);
  if (!isPlainRecord(jobNode)) return emptyResolution();

  // Inline executor fields on the job itself take priority: a job can't
  // simultaneously use `executor:` and its own `docker:`/`machine:`/`macos:`
  // (the real compiler rejects that combination), so if the job has any of
  // these there is, by construction, no named executor being shadowed --
  // `jobOverrides` stays empty.
  if (hasInlineExecutorFields(doc, jobPath)) {
    const { mergeInherited, mergeSource, ...shape } = readExecutorShape(
      doc,
      jobPath,
    );
    return withMergeProvenance(
      { source: 'job', jobOverrides: [], ...shape },
      mergeInherited,
      mergeSource,
    );
  }

  const executorField = getIn(doc, [...jobPath, 'executor']);
  const executorName =
    asString(executorField) ??
    (isPlainRecord(executorField) ? asString(executorField.name) : undefined);

  if (executorName === undefined) return emptyResolution();

  // Fields CircleCI documents as overridable per-job even when `executor:`
  // names a shared executor -- the job keeps that executor's image, but can
  // still ask for more resources or a different working directory for
  // itself alone. These are readable (and worth surfacing) regardless of
  // whether the named executor itself can be resolved. `getInWithOrigin`
  // (rather than `getIn`) lets a value that's here only via `<<` be told
  // apart from one the job actually wrote for itself -- only the latter is
  // a genuine "job override" of the named executor.
  const jobResourceClassResolved = getInWithOrigin(doc, [
    ...jobPath,
    'resource_class',
  ]);
  const jobWorkingDirectoryResolved = getInWithOrigin(doc, [
    ...jobPath,
    'working_directory',
  ]);
  const jobResourceClass = asString(jobResourceClassResolved.value);
  const jobWorkingDirectory = asString(jobWorkingDirectoryResolved.value);

  const jobOverrides: string[] = [];
  const mergeInherited: string[] = [];
  const mergeSource: Record<string, string> = {};
  if (jobResourceClassResolved.origin === 'own') {
    jobOverrides.push('resource_class');
  } else {
    noteMerge(
      mergeInherited,
      mergeSource,
      'resource_class',
      jobResourceClassResolved,
    );
  }
  if (jobWorkingDirectoryResolved.origin === 'own') {
    jobOverrides.push('working_directory');
  } else {
    noteMerge(
      mergeInherited,
      mergeSource,
      'working_directory',
      jobWorkingDirectoryResolved,
    );
  }

  // An orb-qualified name (`orbAlias/executorName`) is defined inside the
  // orb package, not this document -- there is nothing here to resolve it
  // against, so we deliberately do not guess at its image/kind/etc. Only
  // the job's own overrides are real, locally-known values.
  if (executorName.includes('/')) {
    return withMergeProvenance(
      {
        source: 'orb',
        name: executorName,
        kind: 'unknown',
        serviceImages: [],
        resourceClass: jobResourceClass,
        workingDirectory: jobWorkingDirectory,
        jobOverrides,
        unresolvable: true,
      },
      mergeInherited,
      mergeSource,
    );
  }

  if (!listExecutorNames(doc).includes(executorName)) {
    return withMergeProvenance(
      {
        source: 'none',
        name: executorName,
        kind: 'unknown',
        serviceImages: [],
        resourceClass: jobResourceClass,
        workingDirectory: jobWorkingDirectory,
        jobOverrides,
      },
      mergeInherited,
      mergeSource,
    );
  }

  const shape = readExecutorShape(doc, ['executors', executorName]);
  // The executor definition's own merge-inherited fields (issue #35: e.g.
  // `python-lint-executor: <<: *base`) are real provenance too, but only
  // for whichever of `resource_class`/`working_directory` the job didn't
  // already supply -- the job's own value (own *or* merged) wins for
  // display, exactly as `resourceClass`/`workingDirectory` below already
  // prefer `job* ?? shape.*`, so attributing both would double-report one
  // field under two different sources.
  for (const field of shape.mergeInherited) {
    if (field === 'resource_class' && jobResourceClass !== undefined) continue;
    if (field === 'working_directory' && jobWorkingDirectory !== undefined) {
      continue;
    }
    mergeInherited.push(field);
    if (shape.mergeSource[field] !== undefined) {
      mergeSource[field] = shape.mergeSource[field];
    }
  }

  return withMergeProvenance(
    {
      source: 'executor',
      name: executorName,
      kind: shape.kind,
      image: shape.image,
      serviceImages: shape.serviceImages,
      resourceClass: jobResourceClass ?? shape.resourceClass,
      workingDirectory: jobWorkingDirectory ?? shape.workingDirectory,
      dockerLayerCaching: shape.dockerLayerCaching,
      jobOverrides,
    },
    mergeInherited,
    mergeSource,
  );
}
