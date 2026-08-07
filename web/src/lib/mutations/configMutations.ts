/**
 * The config mutation layer: every operation the drag-and-drop editor needs
 * to perform on a parsed CircleCI config, expressed as surgical edits to the
 * live `yaml.Document` (see `~/lib/yaml/documentUtils` for why -- rebuilding
 * containers or round-tripping through plain JS objects destroys comments,
 * key order, and formatting).
 *
 * Every export here mutates `doc` in place and returns `void`. The store is
 * responsible for cloning the document before calling in, and for
 * discarding the clone if a function throws.
 *
 * Two things make this module more than a thin wrapper over `documentUtils`:
 *
 * 1. **Alias semantics.** A workflow job entry may carry a `name:` key that
 *    aliases the underlying job; `requires:` elsewhere in the same workflow
 *    references that alias, never the bare job name (see `buildGraph.ts`,
 *    which this module has to stay consistent with). Every function that
 *    walks or edits `requires` therefore works in terms of each entry's
 *    *id* -- its alias if it has one, otherwise its job name -- not its
 *    `jobName`.
 * 2. **Reference reconciliation.** Deleting a job or a workflow entry can
 *    leave other entries' `requires:` pointing at nothing, which is exactly
 *    the config-stops-compiling bug in issue #12. Every removal path here
 *    prunes dangling references as part of the same operation, and collapses
 *    an entry whose only reason to be a map (its `requires:`) has just been
 *    removed back down to a bare string, so the config stays idiomatic.
 *
 * Kept pure and framework-free -- no React, no zustand -- same as the rest
 * of `~/lib`.
 */
import {
  Pair,
  YAMLMap,
  YAMLSeq,
  isMap,
  isScalar,
  isSeq,
  type Document,
} from 'yaml';

import {
  copyComments,
  deleteIn,
  ensureSeq,
  findAliasSites,
  getIn,
  getJobGroupNames,
  getJobNames,
  getNode,
  getWorkflowNames,
  listKeys,
  parseRequiresEntries,
  renameKey,
  setIn,
  setNodeIn,
  takeNode,
  moveSeqItem as moveSeqItemUtil,
  type Path,
  type RequireRef,
} from '~/lib/yaml/documentUtils';
import {
  executorRef,
  orbsEntry,
  stepEntry,
  workflowJobEntry,
} from '~/lib/orbs/snippets';
import { executorSignatureKey } from '~/lib/graph/detectDuplication';
import { listExecutorNames } from '~/lib/graph/resolveExecutor';
import {
  defaultMatrixName,
  readMatrixSpec,
  substituteMatrixTemplate,
} from '~/lib/yaml/matrixExpansion';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireJob(doc: Document, jobName: string): void {
  if (getJobNames(doc).includes(jobName)) return;

  // Issue #220: a job group is a real, defined thing, so "does not exist" is
  // both wrong and unhelpful when the name is a group's. Renaming or deleting
  // a group is genuinely not supported here -- neither operation means what it
  // means for a job, since a group owns no `steps:` and its members are jobs in
  // their own right -- so this still refuses. It just refuses accurately, and
  // names what the user would have to edit instead.
  if (getJobGroupNames(doc).includes(jobName)) {
    throw new Error(
      `"${jobName}" is a job group, not a job. Edit it under job-groups:, or change the workflow entry that invokes it.`,
    );
  }

  throw new Error(`Job "${jobName}" does not exist`);
}

/**
 * Throws if the node at `path` is a YAML anchor still referenced by an
 * alias/merge elsewhere -- call before deleting it. Every delete that could
 * be removing an anchor source goes through this first and refuses outright,
 * via this module's usual thrown-`Error` convention, rather than silently
 * handing back a document `toString()` can no longer serialize. See
 * `documentUtils.findAliasSites` for why that failure mode is worse than any
 * diff-quality problem, and `jobReferences.ts` for the reader that surfaces
 * the same refusal *before* the user confirms rather than after.
 */
function requireNoAliasSites(
  doc: Document,
  path: (string | number)[],
  describeTarget: string,
): void {
  const sites = findAliasSites(doc, path);
  if (sites.length === 0) return;
  const plural = sites.length > 1;
  const quoted = sites.map((s) => `"${s}"`).join(', ');
  throw new Error(
    `Cannot delete ${describeTarget}: it is a YAML anchor still referenced by ` +
      `${quoted} (a YAML alias, "*"). Deleting it would leave ` +
      `${plural ? 'those references' : 'that reference'} unresolvable and the ` +
      `document would fail to save. Remove or repoint ${plural ? 'those entries' : 'that entry'} first.`,
  );
}

/**
 * Resolves a workflow's `jobs:` sequence, throwing if the workflow doesn't
 * exist. Unlike `addJob`/`addWorkflow`, the entry-level mutations below never
 * silently create the workflow they're pointed at -- the caller (the UI) is
 * expected to have created it via `addWorkflow` first, so a missing workflow
 * here is a genuine caller error, not something to paper over.
 */
function requireWorkflowSeq(doc: Document, workflowName: string): YAMLSeq {
  const seq = getNode(doc, ['workflows', workflowName, 'jobs']);
  if (!isSeq(seq)) {
    throw new Error(`Workflow "${workflowName}" does not exist`);
  }
  return seq;
}

/** One workflow job entry, read directly off the live seq for both inspection and later surgery. */
interface WorkflowEntryNode {
  /** Index into the workflow's `jobs` sequence. */
  index: number;
  /** The entry's `name:` alias if it has one, otherwise its job name -- matches `buildGraph`'s node id. */
  id: string;
  /** The underlying job (or `orbAlias/job`) name. */
  jobName: string;
  /** The aliases/job-names this entry's `requires:` lists. */
  requires: string[];
  /** `true` for a bare `- jobName` entry rather than a `- jobName: {...}` map. */
  isString: boolean;
  /**
   * `true` when the entry carries an explicit `name:` key. Deliberately not
   * inferred from `id !== jobName`: the degenerate `- build: {name: build}`
   * has an alias that happens to equal its job name, and the difference
   * matters -- its id survives a `renameJob` of that job (the `name:` key is
   * never rewritten), where an unaliased entry's id does not. See
   * `shouldRenameRequiresIn`.
   */
  aliased: boolean;
}

function findPair(map: YAMLMap, key: string) {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

/**
 * Reads the id a `requires:` seq item refers to, for either shape an item
 * can take: a bare string (`- lint`) or a single-key status map
 * (`- lint: [success, failed]`). Used everywhere this module has to find
 * *which* item in a `requires:` list to touch (delete, rename) without
 * caring about, or disturbing, its status list -- mirrors
 * `documentUtils.parseRequiresEntries`, but stays index-oriented (returns
 * just the id, not a parsed ref) since every caller here needs the live
 * seq index to edit in place, not a detached copy of the value.
 */
function requireItemId(item: unknown): string | undefined {
  if (isScalar(item)) return String(item.value);
  if (isMap(item) && item.items.length > 0) {
    const pair = item.items[0] as Pair;
    if (isScalar(pair.key)) return String(pair.key.value);
  }
  return undefined;
}

/**
 * Converts one `requires:` entry -- either a bare id or a status-carrying
 * `RequireRef` -- into the plain JS value `doc.createNode` expects: a
 * string for the bare form, or a single-key `{ [id]: statuses }` object for
 * the status form. Used wherever a `requires:` list is rebuilt wholesale
 * (`setRequires`, and the map-conversion path of `appendRequire`) so a
 * caller that already knows an entry's statuses (e.g. re-ordering a list
 * read via a status-aware reader) can preserve them instead of the
 * mutation flattening every entry back down to a bare string.
 */
function toRequireValue(
  entry: string | RequireRef,
): string | Record<string, string[]> {
  if (typeof entry === 'string') return entry;
  return entry.statuses === undefined
    ? entry.id
    : { [entry.id]: entry.statuses };
}

/**
 * Returns `pair.value` as a `YAMLMap`, replacing it with a fresh empty one
 * first if it isn't already a map. Every workflow-entry options value
 * (`{ requires: [...], name: ..., ... }`) is structurally a map, but a
 * malformed config could have it be anything, so callers that need to add a
 * key to it go through this instead of assuming.
 */
function getOrCreateOptionsMap(doc: Document, pair: Pair): YAMLMap {
  if (isMap(pair.value)) return pair.value;
  const map = new YAMLMap(doc.schema);
  pair.value = map;
  return map;
}

/**
 * Reads one workflow's `jobs:` sequence into entries carrying both the
 * underlying job name and the id (alias-or-job-name) `requires:` actually
 * references. Mirrors `buildGraph.ts`'s `parseEntries` deliberately -- the
 * mutation layer and the graph reader must agree on what a node's id is, or
 * an edit made here would silently stop matching what the DAG pane renders.
 *
 * A `matrix:` entry (issue #284) expands into several `WorkflowEntryNode`s --
 * one per parameter combination, `exclude:`d ones removed, each with its own
 * *id* (CircleCI's own expanded name) but the *same* `index`: they are N
 * different nodes on the canvas, but exactly one YAML entry. That is what
 * makes every caller below correct for a matrix node with no changes of its
 * own -- `requireEntry`/`readEntries`'s own callers all resolve `nodeId` to a
 * `WorkflowEntryNode` and then mutate via `target.index`, never by iterating
 * every entry that shares an id or an index, so a mutation reached through
 * any one of a matrix's expanded ids still touches that single seq item
 * exactly once. (Two calls that each *individually* filter/iterate
 * `readEntries`'s result by something other than a unique id --
 * `deleteJob`'s per-workflow removal, `removeWorkflowJobEntry`'s reference
 * pruning -- do have to be matrix-aware themselves, since "every entry for
 * this job name" or "every id this index answers to" can now be more than
 * one `WorkflowEntryNode`; see their own comments.)
 */
function readEntries(doc: Document, workflowName: string): WorkflowEntryNode[] {
  const seq = getNode(doc, ['workflows', workflowName, 'jobs']);
  if (!isSeq(seq)) return [];

  const entries: WorkflowEntryNode[] = [];
  seq.items.forEach((item, index) => {
    if (isScalar(item)) {
      const jobName = String(item.value);
      entries.push({
        index,
        id: jobName,
        jobName,
        requires: [],
        isString: true,
        aliased: false,
      });
      return;
    }
    if (!isMap(item) || item.items.length === 0) return;
    const pair = item.items[0] as Pair;
    const jobName = isScalar(pair.key) ? String(pair.key.value) : '';
    let rawId = jobName;
    let hasExplicitName = false;
    let rawRequires: string[] = [];
    let hasMatrixKey = false;
    const options = pair.value;
    if (isMap(options)) {
      const namePair = findPair(options, 'name');
      if (namePair && isScalar(namePair.value)) {
        rawId = String(namePair.value.value);
        hasExplicitName = true;
      }
      const requiresPair = findPair(options, 'requires');
      rawRequires = parseRequiresEntries(requiresPair?.value).map(
        (ref) => ref.id,
      );
      hasMatrixKey = findPair(options, 'matrix') !== undefined;
    }

    const matrixSpec =
      hasMatrixKey && isMap(options) ? readMatrixSpec(doc, options) : undefined;

    if (!matrixSpec || matrixSpec.combos.length === 0) {
      entries.push({
        index,
        id: rawId,
        jobName,
        requires: rawRequires,
        isString: false,
        aliased: hasExplicitName,
      });
      return;
    }

    for (const combo of matrixSpec.combos) {
      const id = hasExplicitName
        ? substituteMatrixTemplate(rawId, combo)
        : defaultMatrixName(jobName, matrixSpec.paramNames, combo);
      const requires = rawRequires.map((reqId) =>
        substituteMatrixTemplate(reqId, combo),
      );
      // Every expanded instance's id differs from the bare `jobName` (either
      // the user's own template, substituted, or the default name CircleCI
      // computes -- which always appends at least one parameter value), so
      // this is `aliased: true` unconditionally: `shouldRenameRequiresIn`'s
      // "no entry claims the bare job name" reasoning already applies
      // correctly to a matrix entry without any special case there.
      entries.push({
        index,
        id,
        jobName,
        requires,
        isString: false,
        aliased: true,
      });
    }
  });
  return entries;
}

/**
 * Replaces the seq item at `index` with a fresh single-key map entry
 * `{ [jobName]: options }`, carrying over whatever comment sat on the old
 * node (this is only ever called to convert a bare-string entry into map
 * form, so the "old node" is always that scalar).
 */
function convertToMapEntry(
  doc: Document,
  seq: YAMLSeq,
  index: number,
  jobName: string,
  options: Record<string, unknown>,
): YAMLMap {
  const outer = new YAMLMap(doc.schema);
  outer.items.push(new Pair(doc.createNode(jobName), doc.createNode(options)));
  copyComments(seq.items[index], outer);
  seq.items[index] = outer;
  return outer;
}

/**
 * Collapses a single-key map entry back down to a bare job-name string once
 * its options map has nothing left in it (e.g. its only key was `requires:`
 * and the last requirement was just removed). Keeps the config idiomatic --
 * `- build: {}` is legal YAML but not something a human would write.
 *
 * Exported for `parameterMutations.removeParameter` (issue #250), which empties
 * an options map the same way by removing the last invocation parameter from it,
 * and must leave the same idiomatic result rather than a second, subtly
 * different collapse rule.
 */
export function collapseIfEmptyOptions(
  doc: Document,
  seq: YAMLSeq,
  index: number,
): void {
  const item = seq.items[index];
  if (!isMap(item) || item.items.length === 0) return;
  const pair = item.items[0] as Pair;
  if (!isScalar(pair.key)) return;
  const options = pair.value;
  if (isMap(options) && options.items.length === 0) {
    const scalar = doc.createNode(String(pair.key.value));
    copyComments(item, scalar);
    seq.items[index] = scalar;
  }
}

/**
 * Removes any of `ids` from every entry's `requires:` in the job-invocation
 * sequence at `jobsPath`, deleting the `requires:` key when it empties out and
 * collapsing the entry back to a bare string when that leaves it with no
 * options at all.
 *
 * Shared by `deleteJob` (pruning every alias of a deleted job), by
 * `removeWorkflowJobEntry` (pruning the one id it just removed), and -- since
 * issue #220 -- by the `job-groups` half of `deleteJob`. It takes a *path*
 * rather than a workflow name for exactly that reason: a job group's `jobs:`
 * list uses the same entry format as a workflow's, internal `requires:`
 * included, so one reconciliation walk has to serve both. Hardcoding
 * `['workflows', ...]` here is what let a deleted job go on being referenced
 * from inside a group.
 */
function pruneRequiresIds(
  doc: Document,
  jobsPath: Path,
  ids: ReadonlySet<string>,
): void {
  if (ids.size === 0) return;
  const seq = getNode(doc, jobsPath);
  if (!isSeq(seq)) return;

  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i];
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    const jobKey = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (jobKey === undefined) continue;
    const options = pair.value;
    if (!isMap(options)) continue;
    const requiresPair = findPair(options, 'requires');
    const requiresSeq = requiresPair?.value;
    if (!isSeq(requiresSeq)) continue;

    for (let r = requiresSeq.items.length - 1; r >= 0; r--) {
      const id = requireItemId(requiresSeq.items[r]);
      if (id !== undefined && ids.has(id)) {
        deleteIn(doc, [...jobsPath, i, jobKey, 'requires', r]);
      }
    }
    if (requiresSeq.items.length === 0) {
      deleteIn(doc, [...jobsPath, i, jobKey, 'requires']);
    }
    collapseIfEmptyOptions(doc, seq, i);
  }
}

/**
 * Renames every entry *name* matching `oldName` to `newName` in a
 * job-invocation sequence, handling both the bare-string and single-key-map
 * shapes. The key is renamed in place, so its position and any attached comment
 * survive.
 *
 * Factored out of `renameJob` by issue #220 so the same walk can be applied to
 * a job group's `jobs:` list as well as a workflow's. The two lists share a
 * format, and having this inline is why only one of them was ever reconciled.
 */
function renameEntryNames(
  seq: YAMLSeq,
  oldName: string,
  newName: string,
): void {
  for (const item of seq.items) {
    if (isScalar(item)) {
      if (String(item.value) === oldName) item.value = newName;
      continue;
    }
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    if (isScalar(pair.key) && String(pair.key.value) === oldName) {
      pair.key.value = newName;
    }
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface AddJobOptions {
  name: string;
  workflowName?: string;
  image?: string;
}

/**
 * Creates `jobs.<name>` as a minimal but valid job (a `docker` executor on
 * `opts.image`, defaulting to `cimg/base:current`, plus a `steps: [checkout]`)
 * so the config still compiles immediately after the drop. When
 * `opts.workflowName` is given, also appends a bare-string entry for it to
 * that workflow's `jobs:`, auto-creating `jobs:`, `workflows:`, and the
 * workflow's `jobs:` sequence as needed.
 */
export function addJob(doc: Document, opts: AddJobOptions): void {
  const { name, workflowName, image } = opts;
  if (getJobNames(doc).includes(name)) {
    throw new Error(`Job "${name}" already exists`);
  }

  setIn(doc, ['jobs', name, 'docker', 0, 'image'], image ?? DOCKER_IMAGE);
  setIn(doc, ['jobs', name, 'steps', 0], 'checkout');

  if (workflowName !== undefined) {
    const seq = ensureSeq(doc, ['workflows', workflowName, 'jobs']);
    seq.items.push(doc.createNode(name));
  }
}

/**
 * The execution environment half of issue #71's "a job is an executor plus
 * steps" model. Every drop from the palette's Executors section resolves to
 * exactly one of these before `addJobFromExecutor`/`setJobExecutorSpec` ever
 * touch the document:
 *
 *  - `docker`/`machine`/`macos`: an inline executor written directly onto
 *    the job (or, when `saveAsExecutor` is given to `addJobFromExecutor`,
 *    onto a fresh `executors:` entry the job then references by name) --
 *    covers the built-in kinds *and* the palette's "Windows"/"GPU" tiles,
 *    which are `machine` under the hood with a different default
 *    image/resource_class (see `paletteExecutors.ts`; CircleCI has no
 *    separate top-level `windows:`/`gpu:` job key).
 *  - `local`: a reference to an executor already defined in this document's
 *    own `executors:` block (`executor: <name>`) -- nothing to write beyond
 *    the reference itself.
 *  - `orb`: a reference to an orb-provided executor (`executor:
 *    <alias>/<name>`), importing the orb first if it isn't already.
 */
/**
 * A `docker:` image entry's registry-authentication block (issue #77, part
 * 3: "with custom images there might be a credential... you need to
 * support that"). Shapes verified against the vendored official schema,
 * `internal/schema/schema.json`'s `docker.items.properties` (also served
 * at `GET /api/schema`, parsed by `circleciSchema.ts`) -- not guessed:
 *
 *  - `auth`: object with required `username`/`password` strings,
 *    `additionalProperties: false`. CircleCI's own docs
 *    (circleci.com/docs/guides/execution-managed/private-images/) show
 *    `password` populated with a `$CONTEXT_OR_PROJECT_ENV_VAR` reference,
 *    never a literal secret -- see `DockerAuthFields.tsx`'s doc comment for
 *    how the UI enforces that shape rather than merely suggesting it.
 *  - `aws_auth`: `oneOf` two shapes -- `{aws_access_key_id,
 *    aws_secret_access_key}` (both required) or `{oidc_role_arn}` -- for
 *    AWS ECR. The docs example likewise shows `aws_secret_access_key` as an
 *    env-var reference.
 *
 * There is no `pull_policy` (or any image-pull-policy) field anywhere in
 * that schema for a `docker:` image entry -- checked, not assumed; see the
 * PR description for where this was verified. The user's own framing of
 * this issue ("a credential or pull policy") is therefore only half
 * implementable against what CircleCI's `docker` executor actually
 * accepts; this type covers the half that exists.
 */
export type DockerAuthSpec =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'awsKeys'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'awsOidc'; roleArn: string };

/**
 * The execution environment half of issue #71's "a job is an executor plus
 * steps" model. Every drop from the palette's Executors section resolves to
 * exactly one of these before `addJobFromExecutor`/`setJobExecutorSpec` ever
 * touch the document:
 *
 *  - `docker`/`machine`/`macos`: an inline executor written directly onto
 *    the job (or, when `saveAsExecutor` is given to `addJobFromExecutor`,
 *    onto a fresh `executors:` entry the job then references by name) --
 *    covers the built-in kinds *and* the palette's "Windows"/"GPU" tiles,
 *    which are `machine` under the hood with a different default
 *    image/resource_class (see `paletteExecutors.ts`; CircleCI has no
 *    separate top-level `windows:`/`gpu:` job key). `dockerAuth` is only
 *    ever meaningful for `kind: 'docker'` -- see `DockerAuthSpec` -- and
 *    ignored otherwise.
 *  - `local`: a reference to an executor already defined in this document's
 *    own `executors:` block (`executor: <name>`) -- nothing to write beyond
 *    the reference itself.
 *  - `orb`: a reference to an orb-provided executor (`executor:
 *    <alias>/<name>`), importing the orb first if it isn't already.
 */
export type ExecutorSpec =
  | {
      kind: 'docker' | 'machine' | 'macos';
      image?: string;
      resourceClass?: string;
      dockerAuth?: DockerAuthSpec;
    }
  | { kind: 'local'; executorName: string }
  | { kind: 'orb'; orbRef: string; orbAlias?: string; executorName: string };

/**
 * The image a `docker`/`machine` spec gets when its caller names none.
 *
 * These duplicate `paletteExecutors.ts`'s `defaultImage` for the same two cards,
 * because this module is under `~/lib` and must not import from a pane. The
 * duplication is *pinned* rather than tolerated:
 * `configMutations.defaults.test.ts` asserts each constant equals the
 * corresponding card's default, and `paletteExecutors.test.ts` asserts those
 * against the vendored documentation's own examples. So there is one fact, checked
 * in two places, and a divergence fails a test rather than producing two answers
 * to "what image does a new job get?" -- which is how `ubuntu-2204:current` here
 * outlived the docs' move to `ubuntu-2404:current` (issue #203).
 *
 * There is deliberately no macOS sibling -- see `applyExecutorSpec`.
 */
export const DOCKER_IMAGE = 'cimg/base:current';
export const MACHINE_IMAGE = 'ubuntu-2404:current';

/**
 * Writes `auth` (if any, and not `{ kind: 'none' }`) onto the `docker:`
 * image entry at `imageEntryPath` (a job/executor's `docker.<index>`),
 * using exactly the two schema-verified shapes `DockerAuthSpec` documents.
 * A no-op for `undefined`/`{ kind: 'none' }`, which is the common case (most
 * images need no registry auth at all) -- callers never need to check
 * before calling this.
 */
function applyDockerAuth(
  doc: Document,
  imageEntryPath: (string | number)[],
  auth: DockerAuthSpec | undefined,
): void {
  if (!auth || auth.kind === 'none') return;
  switch (auth.kind) {
    case 'basic':
      setIn(doc, [...imageEntryPath, 'auth', 'username'], auth.username);
      setIn(doc, [...imageEntryPath, 'auth', 'password'], auth.password);
      return;
    case 'awsKeys':
      setIn(
        doc,
        [...imageEntryPath, 'aws_auth', 'aws_access_key_id'],
        auth.accessKeyId,
      );
      setIn(
        doc,
        [...imageEntryPath, 'aws_auth', 'aws_secret_access_key'],
        auth.secretAccessKey,
      );
      return;
    case 'awsOidc':
      setIn(
        doc,
        [...imageEntryPath, 'aws_auth', 'oidc_role_arn'],
        auth.roleArn,
      );
      return;
  }
}

/**
 * Writes `spec`'s fields at `path` (a job's own body, or one `executors:`
 * entry) -- the single place that knows how each `ExecutorSpec` kind turns
 * into actual YAML, shared by `addJobFromExecutor` (writing a fresh job or
 * `executors:` entry) and `setJobExecutorSpec` (retrofitting an existing
 * job). Never touches `steps:` or anything else at `path` -- callers own the
 * rest of whatever they're building.
 */
function applyExecutorSpec(
  doc: Document,
  path: (string | number)[],
  spec: ExecutorSpec,
): void {
  switch (spec.kind) {
    case 'docker':
      setIn(doc, [...path, 'docker', 0, 'image'], spec.image ?? DOCKER_IMAGE);
      if (spec.resourceClass)
        setIn(doc, [...path, 'resource_class'], spec.resourceClass);
      applyDockerAuth(doc, [...path, 'docker', 0], spec.dockerAuth);
      return;
    case 'machine':
      setIn(doc, [...path, 'machine', 'image'], spec.image ?? MACHINE_IMAGE);
      if (spec.resourceClass)
        setIn(doc, [...path, 'resource_class'], spec.resourceClass);
      return;
    case 'macos':
      // No fallback, deliberately. Every other kind has a *product* default that
      // happens to be a legal value ("start on a general-purpose image"); there is
      // no equivalent for Xcode, and the version this line used to fall back to --
      // `15.3.0` -- was not a version CircleCI offers at all (issue #203). Refusing
      // is the only honest option left: `mutate` discards the failed clone and
      // surfaces this message, so the document is untouched and the user is told
      // what is missing, rather than being handed a job that cannot run.
      //
      // Unreachable from the UI: `ConfigureJobDialog` will not submit a macOS job
      // with no version. This is the backstop for a future caller, not an error
      // path anyone should see.
      if (!spec.image) {
        throw new Error(
          'A macOS job needs an Xcode version. Choose one from the supported versions in the Xcode version field.',
        );
      }
      setIn(doc, [...path, 'macos', 'xcode'], spec.image);
      if (spec.resourceClass)
        setIn(doc, [...path, 'resource_class'], spec.resourceClass);
      return;
    case 'local':
      if (!listExecutorNames(doc).includes(spec.executorName)) {
        throw new Error(`Executor "${spec.executorName}" does not exist`);
      }
      setIn(doc, [...path, 'executor'], spec.executorName);
      return;
    case 'orb': {
      const { alias, value: ref } = orbsEntry(spec.orbRef, spec.orbAlias);
      addOrb(doc, alias, ref);
      setIn(doc, [...path, 'executor'], executorRef(alias, spec.executorName));
    }
  }
}

export interface AddJobFromExecutorOptions {
  name: string;
  /** Auto-created (mirrors `addJob`'s own `ensureSeq` behavior) if it doesn't exist yet -- issue #71 must work on a config with no `workflows:` block at all. */
  workflowName: string;
  executor: ExecutorSpec;
  /**
   * When given (only meaningful for an inline `docker`/`machine`/`macos`
   * spec), the executor is written to `executors.<saveAsExecutor.name>`
   * instead of directly on the job, which then references it via
   * `executor: <name>` -- the "define as a reusable executor" choice
   * surfaced in `ConfigureJobDialog` (issue #71's design discussion: an
   * executor is a distinct, nameable concept in the user's own mental
   * model, not merely inline job fields).
   */
  saveAsExecutor?: { name: string };
}

/**
 * Creates `jobs.<name>` from a palette-dropped executor and appends its
 * workflow entry, as one call so both halves of "drop an executor, get a
 * job" land in a single undo step (issue #71). Mirrors `addJob`'s shape --
 * a minimal but valid job with a `steps: [checkout]` seed -- but writes the
 * dropped executor's actual fields via `applyExecutorSpec` instead of
 * `addJob`'s hardcoded `docker`/`cimg/base:current`.
 */
export function addJobFromExecutor(
  doc: Document,
  opts: AddJobFromExecutorOptions,
): void {
  const { name, workflowName, executor, saveAsExecutor } = opts;
  if (getJobNames(doc).includes(name)) {
    throw new Error(`Job "${name}" already exists`);
  }

  if (saveAsExecutor) {
    if (executor.kind === 'local' || executor.kind === 'orb') {
      throw new Error(
        '"saveAsExecutor" only applies to an inline docker/machine/macos executor',
      );
    }
    if (listExecutorNames(doc).includes(saveAsExecutor.name)) {
      throw new Error(`Executor "${saveAsExecutor.name}" already exists`);
    }
    applyExecutorSpec(doc, ['executors', saveAsExecutor.name], executor);
    setIn(doc, ['jobs', name, 'executor'], saveAsExecutor.name);
  } else {
    applyExecutorSpec(doc, ['jobs', name], executor);
  }
  setIn(doc, ['jobs', name, 'steps', 0], 'checkout');

  const seq = ensureSeq(doc, ['workflows', workflowName, 'jobs']);
  seq.items.push(doc.createNode(name));
}

/**
 * Retrofits `jobName`'s executor to `spec`, clearing whichever
 * `docker`/`machine`/`macos`/`executor` fields it previously had first --
 * unlike `applyExecutorSpec` alone, a job switching from (say) `docker` to
 * `machine` must not end up with both, which is what CircleCI's real
 * compiler rejects. Used when a palette executor card is dropped directly
 * onto an existing job node.
 */
export function setJobExecutorSpec(
  doc: Document,
  jobName: string,
  spec: ExecutorSpec,
): void {
  requireJob(doc, jobName);
  for (const key of ['docker', 'machine', 'macos', 'executor']) {
    deleteIn(doc, ['jobs', jobName, key]);
  }
  applyExecutorSpec(doc, ['jobs', jobName], spec);
}

/**
 * Deletes `jobs.<jobName>` and reconciles every workflow that referenced it
 * (fixes #12: the naive "just delete the job" left `requires:` pointing at
 * nothing, which made the config stop compiling). Removes every entry whose
 * underlying job is `jobName` -- bare-string or map form, under any alias --
 * from every workflow, then prunes `jobName` and each of those entries'
 * aliases from every remaining entry's `requires:`, collapsing an emptied
 * `requires:` back to a bare string.
 */
export function deleteJob(doc: Document, jobName: string): void {
  requireJob(doc, jobName);

  // Verify -- before touching anything -- that neither the job definition
  // nor any workflow entry about to be removed is a YAML anchor still
  // aliased elsewhere (see `requireNoAliasSites`). A rejected delete must
  // leave the document completely untouched, same as every other refusal
  // in this module, so every check happens up front.
  requireNoAliasSites(doc, ['jobs', jobName], `job "${jobName}"`);
  const perWorkflowRemovals = new Map<string, WorkflowEntryNode[]>();
  for (const workflowName of getWorkflowNames(doc)) {
    const matches = readEntries(doc, workflowName).filter(
      (e) => e.jobName === jobName,
    );
    // Issue #284: a `matrix:` entry now reads as several `WorkflowEntryNode`s
    // sharing one `index` (one per expanded instance). Deleting the same
    // `index` more than once would delete a *different*, unrelated entry the
    // second time round (each `deleteIn` shifts every later index down by
    // one) -- so this collapses `matches` to one representative per distinct
    // `index` before anything below assumes "one entry, one removal".
    const toRemove = [
      ...new Map(matches.map((entry) => [entry.index, entry])).values(),
    ];
    for (const entry of toRemove) {
      requireNoAliasSites(
        doc,
        ['workflows', workflowName, 'jobs', entry.index],
        `"${entry.id}"'s entry in workflow "${workflowName}"`,
      );
    }
    // Every id in `matches` (every expanded instance, not just the one
    // representative per index used above) has to be pruned from other
    // entries' `requires:` below -- a `requires:` naming an instance this
    // delete is about to remove must not survive as a fresh dangling
    // reference. `matches` itself (not `toRemove`) is what's stored: the
    // deletion loop below re-derives its own deduplicated index list.
    if (matches.length > 0) perWorkflowRemovals.set(workflowName, matches);
  }

  deleteIn(doc, ['jobs', jobName]);
  for (const [workflowName, allMatches] of perWorkflowRemovals) {
    const removedIds = new Set(allMatches.map((e) => e.id));
    const uniqueIndices = [...new Set(allMatches.map((e) => e.index))].sort(
      (a, b) => b - a,
    );
    for (const index of uniqueIndices) {
      deleteIn(doc, ['workflows', workflowName, 'jobs', index]);
    }
    pruneRequiresIds(doc, ['workflows', workflowName, 'jobs'], removedIds);
  }

  // Issue #220: the same reconciliation, in the namespace #12 did not know
  // about. A job group invokes jobs by name and its members depend on each
  // other through their own internal `requires:`, so deleting a job that a
  // group uses left the group invoking a job that no longer exists -- the
  // identical defect #12 fixed for workflows, one level down and silent,
  // because nothing renders a group's interior yet.
  deleteJobFromGroups(doc, jobName);
}

/**
 * Removes every invocation of `jobName` from every `job-groups` entry, and
 * prunes it from the surviving members' internal `requires:`.
 *
 * A group left with no members at all is deliberately *kept* (as `jobs: []`)
 * rather than deleted: a group is a named thing a workflow may still invoke,
 * and silently removing the definition would turn one dangling reference into
 * a different one while also throwing away the user's comments and the group's
 * name. An empty group is visible and fixable; a vanished one is neither. This
 * mirrors `deleteJob`'s existing refusal to re-wire dependents.
 */
function deleteJobFromGroups(doc: Document, jobName: string): void {
  for (const groupName of getJobGroupNames(doc)) {
    const jobsPath: Path = ['job-groups', groupName, 'jobs'];
    const seq = getNode(doc, jobsPath);
    if (!isSeq(seq)) continue;

    // Back to front, so each removal cannot shift an index still to be read.
    const removedIds = new Set<string>();
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const item = seq.items[i];
      let entryName: string | undefined;
      if (isScalar(item)) {
        entryName = String(item.value);
      } else if (isMap(item) && item.items.length > 0) {
        const pair = item.items[0] as Pair;
        if (isScalar(pair.key)) entryName = String(pair.key.value);
      }
      if (entryName === jobName) {
        removedIds.add(entryName);
        deleteIn(doc, [...jobsPath, i]);
      }
    }

    pruneRequiresIds(doc, jobsPath, removedIds);
  }
}

/**
 * Renames every occurrence of `oldId` to `newId` in every entry's
 * `requires:` within `seq` -- both the bare-string form and a status-map
 * entry's own key (whose status list is left untouched). Factored out so
 * `renameJob` (renaming a bare job name that may also be some entry's own
 * requires-id) and `setWorkflowJobEntryAlias` (renaming an entry's alias,
 * exactly as much its identity for `requires:` purposes as a bare job name
 * is -- see `buildGraph.ts`) don't each reimplement this walk.
 */
function renameRequiresReferences(
  seq: YAMLSeq,
  oldId: string,
  newId: string,
): void {
  for (const item of seq.items) {
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    const options = pair.value;
    if (!isMap(options)) continue;
    const requiresPair = findPair(options, 'requires');
    const requiresSeq = requiresPair?.value;
    if (!isSeq(requiresSeq)) continue;
    for (const req of requiresSeq.items) {
      if (isScalar(req)) {
        if (String(req.value) === oldId) req.value = newId;
        continue;
      }
      // Status map form (`- oldId: [success, failed]`): rename just the key
      // in place so the status list attached to it survives untouched.
      if (isMap(req) && req.items.length > 0) {
        const reqPair = req.items[0] as Pair;
        if (isScalar(reqPair.key) && String(reqPair.key.value) === oldId) {
          reqPair.key.value = newId;
        }
      }
    }
  }
}

/**
 * Renames `jobs.<oldName>` to `newName` in place (via `renameKey`, so the
 * key's position and comment survive) and updates every workflow entry and
 * `requires:` mention that used the bare job name as its id.
 *
 * An entry that aliases the job via `name:` keeps that alias untouched --
 * only the underlying job key it points at changes -- because `requires:`
 * elsewhere in the workflow references the alias, not the job name, and would
 * otherwise be broken by a rename it never depended on.
 *
 * The same rule read the other way is the subtle case (issue #12): a
 * `requires: [oldName]` is only *this job's* reference when some entry in
 * that workflow actually has `oldName` as its id -- i.e. an entry naming this
 * job with no `name:` alias of its own. If instead a *different* job's entry
 * carries `name: oldName`, that alias owns the name for `requires:` purposes
 * and rewriting it would silently re-point a dependency at a job that isn't
 * even in the workflow. Each workflow is therefore decided independently,
 * before any of its keys are touched, by `shouldRenameRequiresIn` below.
 */
export function renameJob(
  doc: Document,
  oldName: string,
  newName: string,
): void {
  requireJob(doc, oldName);
  if (oldName === newName) return;
  if (getJobNames(doc).includes(newName)) {
    throw new Error(`Job "${newName}" already exists`);
  }

  // Decided per workflow *before* the rename, while entry ids still reflect
  // `oldName` -- see this function's doc comment and `shouldRenameRequiresIn`.
  const renameRequiresIn = new Map<string, boolean>();
  for (const workflowName of getWorkflowNames(doc)) {
    renameRequiresIn.set(
      workflowName,
      shouldRenameRequiresIn(readEntries(doc, workflowName), oldName),
    );
  }

  renameKey(doc, ['jobs'], oldName, newName);

  for (const workflowName of getWorkflowNames(doc)) {
    const seq = getNode(doc, ['workflows', workflowName, 'jobs']);
    if (!isSeq(seq)) continue;

    renameEntryNames(seq, oldName, newName);

    if (renameRequiresIn.get(workflowName) === true) {
      renameRequiresReferences(seq, oldName, newName);
    }
  }

  // Issue #220: job groups invoke jobs by name too, so a rename that stopped
  // at `workflows:` left every group that used this job pointing at a name
  // that no longer exists.
  //
  // No `shouldRenameRequiresIn` equivalent is needed here, and that is a fact
  // about groups rather than an omission: a group's `jobs:` entries are
  // documented as taking the same format as workflow entries, but an alias
  // inside a group has no workflow-level identity to protect -- the group is
  // invoked as a unit, and its internal `requires:` can only refer to its own
  // members. So an internal `requires:` naming `oldName` is this job, always.
  for (const groupName of getJobGroupNames(doc)) {
    const seq = getNode(doc, ['job-groups', groupName, 'jobs']);
    if (!isSeq(seq)) continue;
    renameEntryNames(seq, oldName, newName);
    renameRequiresReferences(seq, oldName, newName);
  }
}

/**
 * Whether `requires: [jobName]` inside this one workflow refers to the job
 * being renamed, and so has to be rewritten with it.
 *
 * True only when the workflow has an entry whose *id* is `jobName` because it
 * names that job with no `name:` alias -- that entry's id is about to change,
 * so every `requires:` naming it must change too. False when:
 *
 *  - no entry in this workflow has `jobName` as its id (nothing here refers
 *    to the job by that name; any `requires: [jobName]` is already dangling
 *    and rewriting it would just move the breakage somewhere less obvious);
 *  - `jobName` is some *other* job's `name:` alias (the alias keeps its id
 *    across this rename, so the reference is still correct as written);
 *  - the only entry for this job spells its alias out explicitly
 *    (`- jobName: {name: jobName}`), which likewise survives the key rename
 *    with its id intact.
 */
function shouldRenameRequiresIn(
  entries: WorkflowEntryNode[],
  jobName: string,
): boolean {
  const claimants = entries.filter((entry) => entry.id === jobName);
  if (claimants.length === 0) return false;
  // A duplicate id is an invalid config either way; treat "any claimant keeps
  // its id across the rename" as reason enough to leave `requires:` alone,
  // since corrupting a live reference is worse than leaving a stale one.
  return claimants.every(
    (entry) => entry.jobName === jobName && !entry.aliased,
  );
}

// ---------------------------------------------------------------------------
// Workflows and workflow job entries
// ---------------------------------------------------------------------------

/** Creates an empty workflow with a `jobs: []` sequence. Rejects a duplicate workflow name. */
export function addWorkflow(doc: Document, workflowName: string): void {
  if (getWorkflowNames(doc).includes(workflowName)) {
    throw new Error(`Workflow "${workflowName}" already exists`);
  }
  setIn(doc, ['workflows', workflowName, 'jobs'], []);
}

/**
 * Appends a job entry to `workflowName`'s `jobs:`. Bare-string form unless
 * `opts.alias` or a non-empty `opts.requires` is given, in which case it's
 * written as the single-key map form so there's somewhere for `name:` /
 * `requires:` to live.
 */
export function addWorkflowJobEntry(
  doc: Document,
  workflowName: string,
  jobName: string,
  opts?: { requires?: string[]; alias?: string },
): void {
  const seq = requireWorkflowSeq(doc, workflowName);
  const hasAlias = opts?.alias !== undefined;
  const hasRequires = opts?.requires !== undefined && opts.requires.length > 0;

  if (!hasAlias && !hasRequires) {
    seq.items.push(doc.createNode(jobName));
    return;
  }

  const options: Record<string, unknown> = {};
  if (hasAlias) options.name = opts?.alias;
  if (hasRequires) options.requires = opts?.requires;
  seq.items.push(doc.createNode({ [jobName]: options }));
}

/**
 * Removes the workflow job entry identified by `nodeId` (its alias, or its
 * job name if it has none) and prunes that id from every other entry's
 * `requires:` in the same workflow, same collapse rule as `deleteJob`, so
 * removing one entry from a workflow can't leave a dangling reference behind.
 *
 * `nodeId` may be one of several ids a `matrix:` entry expanded into (issue
 * #284) -- there is only one YAML entry to remove either way (`target.index`
 * resolves to it, whichever expanded id got passed in), but *every* id that
 * entry expanded into must be pruned from other entries' `requires:`, not
 * just the one the caller happened to click: deleting the entry removes
 * every one of its instances, so a `requires:` naming a sibling instance
 * (e.g. the `EU` half of a `NA`/`EU` matrix removed via its `NA` node) would
 * otherwise survive as a fresh dangling reference this same call was
 * supposed to prevent.
 */
export function removeWorkflowJobEntry(
  doc: Document,
  workflowName: string,
  nodeId: string,
): void {
  requireWorkflowSeq(doc, workflowName);
  const entries = readEntries(doc, workflowName);
  const target = entries.find((e) => e.id === nodeId);
  if (!target) {
    throw new Error(`Workflow "${workflowName}" has no entry "${nodeId}"`);
  }
  const groupIds = new Set(
    entries.filter((e) => e.index === target.index).map((e) => e.id),
  );

  requireNoAliasSites(
    doc,
    ['workflows', workflowName, 'jobs', target.index],
    `"${nodeId}"'s entry in workflow "${workflowName}"`,
  );

  deleteIn(doc, ['workflows', workflowName, 'jobs', target.index]);
  pruneRequiresIds(doc, ['workflows', workflowName, 'jobs'], groupIds);
}

// ---------------------------------------------------------------------------
// requires
// ---------------------------------------------------------------------------

/** Builds an id -> [ids that require it] map, i.e. "what comes after id", for cycle detection. */
function buildSuccessors(entries: WorkflowEntryNode[]): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const entry of entries) successors.set(entry.id, []);
  for (const entry of entries) {
    for (const req of entry.requires) {
      successors.get(req)?.push(entry.id);
    }
  }
  return successors;
}

/** Breadth-first search for a path from `start` to `goal` following `adjacency`. */
function findPath(
  adjacency: Map<string, string[]>,
  start: string,
  goal: string,
): string[] | undefined {
  const queue: string[][] = [[start]];
  const visited = new Set([start]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const node = path[path.length - 1];
    if (node === undefined) continue;
    if (node === goal) return path;
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return undefined;
}

function appendRequire(
  doc: Document,
  seq: YAMLSeq,
  target: WorkflowEntryNode,
  sourceId: string,
): void {
  const item = seq.items[target.index];
  if (isScalar(item)) {
    convertToMapEntry(doc, seq, target.index, target.jobName, {
      requires: [sourceId],
    });
    return;
  }
  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed workflow entry at index ${target.index}`);
  }
  const pair = item.items[0] as Pair;
  const options = getOrCreateOptionsMap(doc, pair);
  const requiresPair = findPair(options, 'requires');
  if (requiresPair && isSeq(requiresPair.value)) {
    requiresPair.value.items.push(doc.createNode(sourceId));
  } else {
    options.items.push(
      new Pair(doc.createNode('requires'), doc.createNode([sourceId])),
    );
  }
}

/**
 * Adds `sourceNodeId` to `targetNodeId`'s `requires:` in `workflowName`,
 * converting a bare-string target entry into map form as needed.
 *
 * Idempotent: a `requires:` that already lists `sourceNodeId` is left alone.
 * Refuses a self-loop (`targetNodeId === sourceNodeId`) and refuses any edit
 * that would close a cycle -- found by walking the *existing* `requires`
 * graph forward from `targetNodeId` (via "what requires this id", the
 * reverse of `requires:` itself) to see whether `sourceNodeId` is already
 * reachable; if it is, `sourceNodeId` transitively depends on `targetNodeId`
 * already, so requiring `sourceNodeId` from `targetNodeId` would close the
 * loop. Both node ids are resolved the same way `buildGraph` resolves them:
 * an entry's `name:` alias if it has one, otherwise its job name.
 */
export function addRequire(
  doc: Document,
  workflowName: string,
  targetNodeId: string,
  sourceNodeId: string,
): void {
  const seq = requireWorkflowSeq(doc, workflowName);
  const entries = readEntries(doc, workflowName);
  const target = entries.find((e) => e.id === targetNodeId);
  const source = entries.find((e) => e.id === sourceNodeId);
  if (!target)
    throw new Error(
      `Workflow "${workflowName}" has no entry "${targetNodeId}"`,
    );
  if (!source)
    throw new Error(
      `Workflow "${workflowName}" has no entry "${sourceNodeId}"`,
    );

  if (targetNodeId === sourceNodeId) {
    throw new Error(`"${targetNodeId}" cannot require itself`);
  }
  if (target.requires.includes(sourceNodeId)) return;

  const successors = buildSuccessors(entries);
  const existingPath = findPath(successors, targetNodeId, sourceNodeId);
  if (existingPath) {
    throw new Error(
      `Making "${targetNodeId}" require "${sourceNodeId}" would create a dependency ` +
        `cycle: ${sourceNodeId} -> ${existingPath.join(' -> ')}`,
    );
  }

  appendRequire(doc, seq, target, sourceNodeId);
}

/**
 * Removes `sourceNodeId` from `targetNodeId`'s `requires:` in `workflowName`.
 * Removing the last requirement deletes the `requires:` key and, if that
 * leaves the entry's options map empty, collapses it back to a bare string.
 */
export function removeRequire(
  doc: Document,
  workflowName: string,
  targetNodeId: string,
  sourceNodeId: string,
): void {
  const seq = requireWorkflowSeq(doc, workflowName);
  const entries = readEntries(doc, workflowName);
  const target = entries.find((e) => e.id === targetNodeId);
  if (!target)
    throw new Error(
      `Workflow "${workflowName}" has no entry "${targetNodeId}"`,
    );
  if (target.isString) return;

  const item = seq.items[target.index];
  if (!isMap(item) || item.items.length === 0) return;
  const pair = item.items[0] as Pair;
  const jobKey = isScalar(pair.key) ? String(pair.key.value) : undefined;
  if (jobKey === undefined) return;
  const options = pair.value;
  if (!isMap(options)) return;
  const requiresPair = findPair(options, 'requires');
  const requiresSeq = requiresPair?.value;
  if (!isSeq(requiresSeq)) return;

  for (let r = requiresSeq.items.length - 1; r >= 0; r--) {
    if (requireItemId(requiresSeq.items[r]) === sourceNodeId) {
      deleteIn(doc, [
        'workflows',
        workflowName,
        'jobs',
        target.index,
        jobKey,
        'requires',
        r,
      ]);
    }
  }
  if (requiresSeq.items.length === 0) {
    deleteIn(doc, [
      'workflows',
      workflowName,
      'jobs',
      target.index,
      jobKey,
      'requires',
    ]);
  }
  collapseIfEmptyOptions(doc, seq, target.index);
}

/**
 * Replaces `nodeId`'s entire `requires:` list with `requires` (order
 * preserved). An empty list removes `requires:` entirely (collapsing to a
 * bare string if that was the entry's only option); a non-empty list
 * converts a bare-string entry into map form as needed.
 *
 * Each item may be a bare id (plain dependency) or a `RequireRef` carrying
 * `statuses` (status-conditioned dependency, see issue #26) -- accepting
 * both means a caller that read the existing list with statuses attached
 * (e.g. to reorder it) can pass it straight back through without having to
 * flatten every entry down to a bare id first.
 */
export function setRequires(
  doc: Document,
  workflowName: string,
  nodeId: string,
  requires: ReadonlyArray<string | RequireRef>,
): void {
  const seq = requireWorkflowSeq(doc, workflowName);
  const entries = readEntries(doc, workflowName);
  const target = entries.find((e) => e.id === nodeId);
  if (!target)
    throw new Error(`Workflow "${workflowName}" has no entry "${nodeId}"`);

  if (requires.length === 0) {
    if (target.isString) return;
    const item = seq.items[target.index];
    if (isMap(item) && item.items.length > 0) {
      const pair = item.items[0] as Pair;
      const jobKey = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (jobKey !== undefined) {
        deleteIn(doc, [
          'workflows',
          workflowName,
          'jobs',
          target.index,
          jobKey,
          'requires',
        ]);
        collapseIfEmptyOptions(doc, seq, target.index);
      }
    }
    return;
  }

  const values = requires.map(toRequireValue);

  const item = seq.items[target.index];
  if (isScalar(item)) {
    convertToMapEntry(doc, seq, target.index, target.jobName, {
      requires: values,
    });
    return;
  }
  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed workflow entry at index ${target.index}`);
  }
  const pair = item.items[0] as Pair;
  const options = getOrCreateOptionsMap(doc, pair);
  const requiresPair = findPair(options, 'requires');
  if (requiresPair && isSeq(requiresPair.value)) {
    requiresPair.value.items.splice(
      0,
      requiresPair.value.items.length,
      ...values.map((v) => doc.createNode(v)),
    );
  } else {
    options.items.push(
      new Pair(doc.createNode('requires'), doc.createNode(values)),
    );
  }
}

// ---------------------------------------------------------------------------
// Workflow entry options (issues #36, #37)
// ---------------------------------------------------------------------------

/** The `pre-steps`/`post-steps` keys `addWorkflowEntryStep`/`removeWorkflowEntryStep`/`moveWorkflowEntryStep` operate on. */
export type WorkflowEntryStepsKey = 'pre-steps' | 'post-steps';

/** Every key with its own dedicated setter or field elsewhere -- never settable through the generic `setWorkflowJobEntryOption`/`setWorkflowJobEntryParameter`. Mirrors `buildGraph.ts`'s `RESERVED_ENTRY_KEYS`. */
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

/** Resolves `nodeId` to its live seq/entry, throwing the same "no such entry" error every per-entry mutation below needs. */
function requireEntry(
  doc: Document,
  workflowName: string,
  nodeId: string,
): { seq: YAMLSeq; entries: WorkflowEntryNode[]; target: WorkflowEntryNode } {
  const seq = requireWorkflowSeq(doc, workflowName);
  const entries = readEntries(doc, workflowName);
  const target = entries.find((e) => e.id === nodeId);
  if (!target) {
    throw new Error(`Workflow "${workflowName}" has no entry "${nodeId}"`);
  }
  return { seq, entries, target };
}

/**
 * Sets `key` in `target`'s options map to `value` -- converting a
 * bare-string entry into map form first if needed -- or, when `value` is
 * `undefined`, deletes `key` and collapses the entry back to a bare string
 * once nothing else remains. The single place every per-entry field setter
 * below goes through, so the bare-string<->map conversion and the
 * empty-options collapse -- both already proven correct by `requires:`'s
 * own tests (`appendRequire`/`setRequires`/`removeRequire` above) -- are
 * written exactly once rather than five times over.
 */
function setEntryOptionKey(
  doc: Document,
  seq: YAMLSeq,
  target: WorkflowEntryNode,
  key: string,
  value: unknown,
): void {
  const item = seq.items[target.index];

  if (value === undefined) {
    if (target.isString) return; // nothing to delete
    if (!isMap(item) || item.items.length === 0) return;
    const pair = item.items[0] as Pair;
    const options = pair.value;
    if (!isMap(options)) return;
    const existing = findPair(options, key);
    if (existing) {
      options.items.splice(options.items.indexOf(existing), 1);
    }
    collapseIfEmptyOptions(doc, seq, target.index);
    return;
  }

  if (isScalar(item)) {
    convertToMapEntry(doc, seq, target.index, target.jobName, { [key]: value });
    return;
  }
  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed workflow entry at index ${target.index}`);
  }
  const pair = item.items[0] as Pair;
  const options = getOrCreateOptionsMap(doc, pair);
  const existing = findPair(options, key);
  if (existing) {
    existing.value = doc.createNode(value);
  } else {
    options.items.push(new Pair(doc.createNode(key), doc.createNode(value)));
  }
}

/**
 * Sets `key` -- one of the plain per-entry options CircleCI accepts on a
 * workflow job entry other than `requires`/`name` (which have their own
 * dedicated setters above/below): `context`, `filters`, or an invocation
 * parameter of the entry's own job/orb-job -- to `value` on the entry
 * identified by `nodeId` in `workflowName`. `value === undefined` deletes
 * the key, collapsing the entry back to a bare string if nothing else
 * remains.
 *
 * Deliberately generic over `key` rather than one setter per field: every
 * one of these fields is just a sibling key in the same options map and
 * needs exactly the same bare-string<->map handling (`setEntryOptionKey`),
 * so a single function is what keeps that logic from being written several
 * times over (issue #37). Prefer `setWorkflowJobEntryParameter` for an
 * invocation parameter specifically -- it guards against a parameter
 * happening to be named one of the reserved keys below.
 */
export function setWorkflowJobEntryOption(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: string,
  value: unknown,
): void {
  if (key === 'name' || key === 'requires') {
    throw new Error(`"${key}" has its own dedicated setter; use that instead`);
  }
  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  setEntryOptionKey(doc, seq, target, key, value);
}

/**
 * Appends `contextName` to the `context:` list of the entry identified by
 * `nodeId` in `workflowName`, creating the key (and promoting a bare-string
 * entry to map form) as needed. A no-op when the context is already listed.
 *
 * Deliberately an append rather than a call to `setWorkflowJobEntryOption`
 * with a rebuilt array, which is how the inspector's own `ContextSection`
 * writes this key. That whole-value replace is correct for an editor that
 * owns the entire list, but it discards the existing `context:` sequence and
 * builds a new one -- so any comment attached to an item already there dies
 * with it. Dragging a context in from the palette adds *one* item and must
 * leave the rest of the file, comments included, byte-identical.
 *
 * The scalar case is the one worth spelling out: CircleCI accepts
 * `context: org-global` as shorthand for a one-item list, and the existing
 * `ensureEntryStepsSeq` helper would replace such a scalar with a fresh empty
 * seq, silently dropping the context already there. Here it is widened into a
 * two-item list instead.
 */
export function addWorkflowJobEntryContext(
  doc: Document,
  workflowName: string,
  nodeId: string,
  contextName: string,
): void {
  const trimmed = contextName.trim();
  if (trimmed === '') {
    throw new Error('A context name is required');
  }

  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  const item = seq.items[target.index];

  // A bare `- build` entry: promote it, carrying its comment across.
  if (isScalar(item)) {
    convertToMapEntry(doc, seq, target.index, target.jobName, {
      context: [trimmed],
    });
    return;
  }
  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed workflow entry at index ${target.index}`);
  }

  const pair = item.items[0] as Pair;
  const options = getOrCreateOptionsMap(doc, pair);
  const existing = findPair(options, 'context');

  // No `context:` yet -- add the key with a one-item list.
  if (!existing) {
    options.items.push(
      new Pair(doc.createNode('context'), doc.createNode([trimmed])),
    );
    return;
  }

  // `context: [a, b]` -- push onto the *live* seq, so the items already
  // there keep their formatting and comments.
  if (isSeq(existing.value)) {
    const already = existing.value.items.some(
      (entry) => isScalar(entry) && String(entry.value) === trimmed,
    );
    if (already) return;
    existing.value.items.push(doc.createNode(trimmed));
    return;
  }

  // `context: org-global` -- widen the shorthand scalar into a list rather
  // than overwriting it.
  if (isScalar(existing.value)) {
    const current = String(existing.value.value);
    if (current === trimmed) return;
    existing.value = doc.createNode([current, trimmed]);
    return;
  }

  throw new Error(
    `Workflow entry "${nodeId}" has a "context" value that is neither a string nor a list`,
  );
}

/**
 * Removes `contextName` from the `context:` list of the entry identified by
 * `nodeId` in `workflowName`, deleting the key entirely (and collapsing the
 * entry back to a bare string when nothing else remains) once it was the last
 * one. A no-op when the context is not listed.
 *
 * The mirror of `addWorkflowJobEntryContext`, and surgical for the same reason:
 * it splices one item out of the *live* seq, so the sibling items --
 * and any comment attached to them -- survive untouched. Removing one of three
 * contexts by rebuilding the list from an array, which is what the inspector
 * used to do, silently takes the other two's comments with it.
 *
 * The scalar shorthand (`context: org-global`) is handled explicitly: removing
 * the name it holds deletes the key, and removing any other name does nothing.
 */
export function removeWorkflowJobEntryContext(
  doc: Document,
  workflowName: string,
  nodeId: string,
  contextName: string,
): void {
  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  const item = seq.items[target.index];

  // A bare `- build` entry has no `context:` to remove from.
  if (isScalar(item)) return;
  if (!isMap(item) || item.items.length === 0) return;

  const pair = item.items[0] as Pair;
  const options = pair.value;
  if (!isMap(options)) return;
  const existing = findPair(options, 'context');
  if (!existing) return;

  const dropKey = () => {
    options.items.splice(options.items.indexOf(existing), 1);
    collapseIfEmptyOptions(doc, seq, target.index);
  };

  if (isSeq(existing.value)) {
    const index = existing.value.items.findIndex(
      (entry) => isScalar(entry) && String(entry.value) === contextName,
    );
    if (index === -1) return;
    existing.value.items.splice(index, 1);
    // An empty `context: []` is valid YAML but meaningless config, and
    // leaving one behind would be a visible artefact of the edit.
    if (existing.value.items.length === 0) dropKey();
    return;
  }

  if (
    isScalar(existing.value) &&
    String(existing.value.value) === contextName
  ) {
    dropKey();
  }
}

/**
 * Sets (or clears, when `value` is `undefined`) one invocation parameter --
 * an orb job's own parameter, or a parameterized local job's own
 * `parameters:` value passed at the call site -- on the entry identified by
 * `nodeId`. A thin, clearly-named wrapper over `setWorkflowJobEntryOption`
 * that also guards against a parameter happening to be named one of the
 * reserved workflow-entry keys (`context`, `filters`, ...), which would
 * otherwise silently corrupt those fields instead of setting the parameter.
 */
export function setWorkflowJobEntryParameter(
  doc: Document,
  workflowName: string,
  nodeId: string,
  paramName: string,
  value: unknown,
): void {
  if (RESERVED_ENTRY_OPTION_KEYS.has(paramName)) {
    throw new Error(
      `"${paramName}" is a reserved workflow-entry key, not a parameter`,
    );
  }
  setWorkflowJobEntryOption(doc, workflowName, nodeId, paramName, value);
}

/**
 * Sets (or clears) `nodeId`'s own `name:` alias within `workflowName`.
 *
 * Unlike a raw `setWorkflowJobEntryOption(doc, wf, id, 'name', ...)` call,
 * this also renames every other entry's `requires:` in the same workflow
 * that referenced the old id -- an alias is this entry's identity for
 * `requires:` purposes (see `buildGraph.ts`), exactly the way `renameJob`
 * keeps `requires:` in sync when a bare job name changes. This is issue
 * #36's fix: editing one entry's own alias must never touch the shared job
 * definition it points at, nor any *other* entry aliasing that same job --
 * both of which `renameJob` (which this used to be the only way to affect
 * an entry's id) would do.
 *
 * `alias` empty/undefined removes the `name:` key, reverting the entry's id
 * back to its bare job name. Rejects a resulting id that collides with
 * another entry already in the workflow, leaving the document unchanged.
 */
export function setWorkflowJobEntryAlias(
  doc: Document,
  workflowName: string,
  nodeId: string,
  alias: string | undefined,
): void {
  const { seq, entries, target } = requireEntry(doc, workflowName, nodeId);

  const trimmed = alias?.trim();
  const newId = trimmed && trimmed.length > 0 ? trimmed : target.jobName;
  if (newId === target.id) return;

  const collision = entries.some((e) => e !== target && e.id === newId);
  if (collision) {
    throw new Error(
      `Workflow "${workflowName}" already has an entry "${newId}"`,
    );
  }

  setEntryOptionKey(
    doc,
    seq,
    target,
    'name',
    newId === target.jobName ? undefined : newId,
  );
  renameRequiresReferences(seq, target.id, newId);
}

/**
 * Returns the live `YAMLSeq` for `target`'s `pre-steps:`/`post-steps:`,
 * creating it (and converting a bare-string entry into map form first) if
 * it doesn't already exist.
 */
function ensureEntryStepsSeq(
  doc: Document,
  seq: YAMLSeq,
  target: WorkflowEntryNode,
  key: WorkflowEntryStepsKey,
): YAMLSeq {
  const item = seq.items[target.index];
  if (isScalar(item)) {
    const outer = convertToMapEntry(doc, seq, target.index, target.jobName, {
      [key]: [],
    });
    const pair = outer.items[0] as Pair;
    const created = findPair(pair.value as YAMLMap, key)?.value;
    if (!isSeq(created)) {
      throw new Error(
        `Failed to create "${key}" on workflow entry "${target.id}"`,
      );
    }
    return created;
  }
  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed workflow entry at index ${target.index}`);
  }
  const pair = item.items[0] as Pair;
  const options = getOrCreateOptionsMap(doc, pair);
  const existing = findPair(options, key);
  if (existing && isSeq(existing.value)) return existing.value;
  const newSeq = new YAMLSeq(doc.schema);
  if (existing) existing.value = newSeq;
  else options.items.push(new Pair(doc.createNode(key), newSeq));
  return newSeq;
}

/** Resolves the live `pre-steps:`/`post-steps:` seq for an existing entry, throwing if the entry has none -- shared by `removeWorkflowEntryStep`/`moveWorkflowEntryStep`, which (unlike `addWorkflowEntryStep`) never create one. */
function requireEntryStepsSeq(
  seq: YAMLSeq,
  target: WorkflowEntryNode,
  key: WorkflowEntryStepsKey,
): YAMLSeq {
  const item = seq.items[target.index];
  if (isMap(item) && item.items.length > 0) {
    const pair = item.items[0] as Pair;
    const options = pair.value;
    if (isMap(options)) {
      const stepsPair = findPair(options, key);
      if (isSeq(stepsPair?.value)) return stepsPair.value;
    }
  }
  throw new Error(`Entry "${target.id}" has no "${key}"`);
}

/**
 * Inserts `step` into `nodeId`'s `pre-steps:`/`post-steps:` at `index`
 * (default: append), creating the list -- and converting the entry to map
 * form -- as needed. Mirrors `addStep`, rooted at the workflow entry instead
 * of `jobs.<name>` (issue #37: these are ordinary, editable workflow config
 * for every node kind, not just a locally-defined job's own steps).
 */
export function addWorkflowEntryStep(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  step: unknown,
  index?: number,
): void {
  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  const stepsSeq = ensureEntryStepsSeq(doc, seq, target, key);
  const node = doc.createNode(step);
  const insertAt =
    index === undefined
      ? stepsSeq.items.length
      : Math.max(0, Math.min(index, stepsSeq.items.length));
  stepsSeq.items.splice(insertAt, 0, node);
}

/** Removes the step at `index` from `nodeId`'s `pre-steps:`/`post-steps:`, deleting the key (and collapsing the entry to a bare string) once it empties out. Mirrors `removeStep`. */
export function removeWorkflowEntryStep(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  index: number,
): void {
  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  const stepsSeq = requireEntryStepsSeq(seq, target, key);
  if (index < 0 || index >= stepsSeq.items.length) {
    throw new Error(`Entry "${nodeId}" has no "${key}" step at index ${index}`);
  }
  stepsSeq.items.splice(index, 1);
  if (stepsSeq.items.length === 0) {
    setEntryOptionKey(doc, seq, target, key, undefined);
  }
}

/** Reorders a step within `nodeId`'s `pre-steps:`/`post-steps:`, carrying its comment (if any) with it. Mirrors `moveStep`. */
export function moveWorkflowEntryStep(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  fromIndex: number,
  toIndex: number,
): void {
  const { seq, target } = requireEntry(doc, workflowName, nodeId);
  const stepsSeq = requireEntryStepsSeq(seq, target, key);
  if (fromIndex < 0 || fromIndex >= stepsSeq.items.length) {
    throw new Error(
      `Entry "${nodeId}" has no "${key}" step at index ${fromIndex}`,
    );
  }
  const clampedTo = Math.max(0, Math.min(toIndex, stepsSeq.items.length - 1));
  const [moved] = stepsSeq.items.splice(fromIndex, 1);
  stepsSeq.items.splice(clampedTo, 0, moved);
}

/**
 * Sets a nested field within one step of `nodeId`'s
 * `pre-steps:`/`post-steps:` -- `path` is relative to that step's own array
 * slot, e.g. `[index, '<orb>/<command>', paramName]`, the same shape
 * `setJobField`'s callers use relative to `jobs.<name>.steps`. Lets the
 * inspector's step-parameter editor be rooted at a workflow entry instead of
 * a job body without a separate implementation.
 */
export function setWorkflowEntryStepField(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  path: (string | number)[],
  value: unknown,
): void {
  const { target } = requireEntry(doc, workflowName, nodeId);
  setIn(
    doc,
    [
      'workflows',
      workflowName,
      'jobs',
      target.index,
      target.jobName,
      key,
      ...path,
    ],
    value,
  );
}

// ---------------------------------------------------------------------------
// Individual step fields (issue #48)
// ---------------------------------------------------------------------------

/**
 * Step keywords whose short form is a bare string carrying no payload
 * (`- checkout`), per the vendored JSON Schema's `definitions.step`
 * (`internal/schema/schema.json`) -- collapsing an emptied value map for one
 * of these back down to that form (`collapseStepIfEmpty`) therefore loses
 * nothing. `run` is deliberately not here: its shorthand (`- run: "npm
 * test"`) is a bare *string value* under the `run:` key, not a bare
 * top-level string step, and it isn't payload-free -- the string doubles as
 * `command` -- so it's handled separately via `shorthandField` instead.
 */
export const BARE_STRING_STEP_KEYS = new Set([
  'checkout',
  'setup_remote_docker',
  'add_ssh_keys',
]);

function isPrimitiveValue(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Returns the live single-key value map for the step at index `idx` of
 * `seq`, promoting either shape that isn't already one:
 *
 *  - a bare-string step (`- checkout`) becomes `{ [stepKey]: {} }`;
 *  - a single-key map whose own value is a scalar -- `run`'s shorthand
 *    (`- run: "npm test"`, where the string doubles as both `command` and
 *    the step's implicit name) -- becomes `{ [stepKey]: { [shorthandField]:
 *    <that string> } }`, so promoting the step to set some *other* field
 *    doesn't silently drop what the shorthand carried.
 *
 * Either way the original node's own comment travels with it to its new
 * home, via `copyComments` -- same convention as every other shape-changing
 * write in this module (`convertToMapEntry`, `ensureEntryStepsSeq`, ...).
 */
function ensureStepValueMap(
  doc: Document,
  seq: YAMLSeq,
  idx: number,
  stepKey: string,
  shorthandField?: string,
): YAMLMap {
  const item = seq.items[idx];

  if (isScalar(item)) {
    if (String(item.value) !== stepKey) {
      throw new Error(`Step at index ${idx} is not a "${stepKey}" step`);
    }
    const map = new YAMLMap(doc.schema);
    const outer = new YAMLMap(doc.schema);
    outer.items.push(new Pair(doc.createNode(stepKey), map));
    copyComments(item, outer);
    seq.items[idx] = outer;
    return map;
  }

  if (!isMap(item) || item.items.length === 0) {
    throw new Error(`Malformed step at index ${idx}`);
  }
  const pair = item.items[0] as Pair;
  if (!isScalar(pair.key) || String(pair.key.value) !== stepKey) {
    throw new Error(`Step at index ${idx} is not a "${stepKey}" step`);
  }
  if (isMap(pair.value)) return pair.value;

  const map = new YAMLMap(doc.schema);
  if (shorthandField !== undefined && isScalar(pair.value)) {
    map.items.push(
      new Pair(
        doc.createNode(shorthandField),
        doc.createNode(pair.value.value),
      ),
    );
  }
  copyComments(pair.value, map);
  pair.value = map;
  return map;
}

/**
 * Whether an emptied value map under `stepKey` can be collapsed back to a bare
 * `- <stepKey>` without losing anything.
 *
 * Two cases qualify. `BARE_STRING_STEP_KEYS` are the built-in keywords whose
 * short form carries no payload (`- checkout`). And a **command invocation** --
 * anything containing `/`, i.e. `<orb-alias>/<command>` -- qualifies for the
 * same reason: `- act/install` and `- act/install: {}` invoke the same command
 * with the same (no) arguments, and the bare form is both idiomatic and exactly
 * what `snippets.stepEntry` writes when a command is inserted with no
 * parameters. Without this, clearing the last parameter of a command step left
 * `- act/install: {}` behind -- valid, but not something a human would write,
 * and not what inserting the same step produces.
 *
 * `run` is excluded by both rules on purpose: collapsing an emptied `run: {}`
 * would silently lose the fact that `command:` is still required there. Mirrors
 * `collapseIfEmptyOptions`'s "keep the config idiomatic" rationale.
 */
function canCollapseStepToBareString(stepKey: string): boolean {
  return BARE_STRING_STEP_KEYS.has(stepKey) || stepKey.includes('/');
}

/**
 * Collapses the step at index `idx` of `seq` back down to a bare string once
 * its value map has emptied out, for the step keys
 * `canCollapseStepToBareString` allows.
 */
function collapseStepIfEmpty(
  doc: Document,
  seq: YAMLSeq,
  idx: number,
  stepKey: string,
): void {
  if (!canCollapseStepToBareString(stepKey)) return;
  const item = seq.items[idx];
  if (!isMap(item) || item.items.length === 0) return;
  const pair = item.items[0] as Pair;
  if (!isMap(pair.value) || pair.value.items.length > 0) return;
  const scalar = doc.createNode(stepKey);
  copyComments(item, scalar);
  seq.items[idx] = scalar;
}

/**
 * Sets (or, with `value === undefined`, removes) one top-level field of the
 * step keyed `stepKey`, addressed by `stepPath` -- the full path from the
 * document root to that step's own array slot, e.g. `['jobs', 'build',
 * 'steps', 2]`, or, for one nested inside a `when`/`unless` group, `['jobs',
 * 'build', 'steps', 2, 'when', 'steps', 0]`. Converts between the step's
 * bare-string/shorthand and single-key-map shapes as needed
 * (`ensureStepValueMap`/`collapseStepIfEmpty`) so callers -- the inspector's
 * per-step-type field editors (issue #48) -- never have to know which shape
 * a given step is currently written in, and a bare `- checkout` only ever
 * becomes `- checkout: {...}` once the user actually sets a field on it.
 *
 * `shorthandField` names the field a bare *scalar* step value implicitly
 * sets -- only `run` has one (`command`); omit for every other step
 * keyword, none of which has a scalar-value shorthand.
 */
export function setStepField(
  doc: Document,
  stepPath: (string | number)[],
  stepKey: string,
  fieldName: string,
  value: unknown,
  shorthandField?: string,
): void {
  const idx = stepPath[stepPath.length - 1];
  const parentPath = stepPath.slice(0, -1);
  if (typeof idx !== 'number') {
    throw new Error(
      `Step path "${stepPath.join('.')}" must end in a numeric index`,
    );
  }
  const seq = getNode(doc, parentPath);
  if (!isSeq(seq)) {
    throw new Error(`No steps sequence at "${parentPath.join('.')}"`);
  }
  if (idx < 0 || idx >= seq.items.length) {
    throw new Error(`No step at index ${idx}`);
  }

  if (value === undefined) {
    const item = seq.items[idx];
    if (isMap(item) && item.items.length > 0) {
      const pair = item.items[0] as Pair;
      if (isMap(pair.value)) {
        const existing = findPair(pair.value, fieldName);
        if (existing)
          pair.value.items.splice(pair.value.items.indexOf(existing), 1);
        collapseStepIfEmpty(doc, seq, idx, stepKey);
      }
    }
    return;
  }

  const map = ensureStepValueMap(doc, seq, idx, stepKey, shorthandField);
  const existing = findPair(map, fieldName);
  if (existing) {
    if (isScalar(existing.value) && isPrimitiveValue(value)) {
      existing.value.value = value;
    } else {
      const node = doc.createNode(value);
      copyComments(existing.value, node);
      existing.value = node;
    }
  } else {
    map.items.push(new Pair(doc.createNode(fieldName), doc.createNode(value)));
  }
}

/**
 * `setStepField`, rooted at a workflow entry's `pre-steps:`/`post-steps:`
 * instead of a job's own `steps:` -- resolves `nodeId`'s live entry fresh
 * (via `requireEntry`, same as `setWorkflowEntryStepField` above) so callers
 * never have to carry the entry's current seq index themselves.
 */
export function setWorkflowEntryStepFieldValue(
  doc: Document,
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  relativeStepPath: (string | number)[],
  stepKey: string,
  fieldName: string,
  value: unknown,
  shorthandField?: string,
): void {
  const { target } = requireEntry(doc, workflowName, nodeId);
  setStepField(
    doc,
    [
      'workflows',
      workflowName,
      'jobs',
      target.index,
      target.jobName,
      key,
      ...relativeStepPath,
    ],
    stepKey,
    fieldName,
    value,
    shorthandField,
  );
}

// ---------------------------------------------------------------------------
// Job fields and steps
// ---------------------------------------------------------------------------

/** Sets `jobs.<jobName>.<path...>` to `value`, creating intermediate containers as needed. */
export function setJobField(
  doc: Document,
  jobName: string,
  path: (string | number)[],
  value: unknown,
): void {
  requireJob(doc, jobName);
  setIn(doc, ['jobs', jobName, ...path], value);
}

/** Removes `jobs.<jobName>.<path...>` -- the "revert to inherited" side of issue #27's per-job executor-override UX (undoes what `setJobField` wrote, e.g. a job-level `resource_class` that shadowed a named executor). */
export function unsetJobField(
  doc: Document,
  jobName: string,
  path: (string | number)[],
): void {
  requireJob(doc, jobName);
  deleteIn(doc, ['jobs', jobName, ...path]);
}

/**
 * Sets the image on `jobName`'s own `docker` executor (`docker[0].image`),
 * creating the `docker:` list if absent. Only touches the job's inline
 * `docker` executor -- a job that instead uses an orb `executor:` reference
 * is out of scope for this helper; use `setJobExecutorFromOrb` for that.
 */
export function setExecutorImage(
  doc: Document,
  jobName: string,
  image: string,
): void {
  requireJob(doc, jobName);
  setIn(doc, ['jobs', jobName, 'docker', 0, 'image'], image);
}

/**
 * Sets `executors.<executorName>.<path...>` to `value`, creating
 * intermediate containers as needed -- mirrors `setJobField`, but for the
 * `executors:` namespace. This is the "edit the executor" side of issue
 * #27's inherited-value UX: unlike `setJobField`'s `resource_class`
 * override, which shadows a named executor for one job only, this changes
 * the executor itself and therefore every job that references it -- the
 * inspector must make that distinction explicit rather than silently
 * picking one (see `resolveJobExecutor`'s `jobOverrides`).
 */
export function setExecutorField(
  doc: Document,
  executorName: string,
  path: (string | number)[],
  value: unknown,
): void {
  if (!listExecutorNames(doc).includes(executorName)) {
    throw new Error(`Executor "${executorName}" does not exist`);
  }
  setIn(doc, ['executors', executorName, ...path], value);
}

/**
 * Inserts `step` into `jobName`'s `steps:` at `index` (default: append),
 * creating `steps:` if absent.
 */
export function addStep(
  doc: Document,
  jobName: string,
  step: unknown,
  index?: number,
): void {
  requireJob(doc, jobName);
  const seq = ensureSeq(doc, ['jobs', jobName, 'steps']);
  const node = doc.createNode(step);
  const insertAt =
    index === undefined
      ? seq.items.length
      : Math.max(0, Math.min(index, seq.items.length));
  seq.items.splice(insertAt, 0, node);
}

/** Removes the step at `index` from `jobName`'s `steps:`. */
export function removeStep(
  doc: Document,
  jobName: string,
  index: number,
): void {
  requireJob(doc, jobName);
  const removed = deleteIn(doc, ['jobs', jobName, 'steps', index]);
  if (!removed) {
    throw new Error(`Job "${jobName}" has no step at index ${index}`);
  }
}

/**
 * Moves a step within `jobName`'s `steps:` from `fromIndex` to `toIndex`.
 * Delegates to `moveSeqItem` so the step's own comment (if any) travels with
 * it to its new position instead of staying pinned to the old slot.
 */
export function moveStep(
  doc: Document,
  jobName: string,
  fromIndex: number,
  toIndex: number,
): void {
  requireJob(doc, jobName);
  const moved = moveSeqItemUtil(
    doc,
    ['jobs', jobName, 'steps'],
    fromIndex,
    toIndex,
  );
  if (!moved) {
    throw new Error(`Job "${jobName}" has no step at index ${fromIndex}`);
  }
}

// ---------------------------------------------------------------------------
// Orbs
// ---------------------------------------------------------------------------

/**
 * Ensures `orbs.<alias>: <ref>` exists. Idempotent: calling this again with
 * the same alias and ref is a no-op mutation (setting a scalar to the value
 * it already holds produces no diff), which is what lets `insertOrbJob`
 * import the same orb for a second dropped job without duplicating the
 * `orbs:` entry.
 */
export function addOrb(doc: Document, alias: string, ref: string): void {
  setIn(doc, ['orbs', alias], ref);
}

/**
 * Drops an orb job onto a workflow: ensures the orb is imported (deriving
 * the alias from `orbRef` via `snippets.orbsEntry` unless `orbAlias`
 * overrides it), then appends `"<alias>/<jobName>"` to the workflow's
 * `jobs:` -- bare string when there are no params/requires, otherwise the
 * single-key map form (via `snippets.workflowJobEntry`).
 */
export function insertOrbJob(
  doc: Document,
  args: {
    workflowName: string;
    orbRef: string;
    orbAlias?: string;
    jobName: string;
    params?: Record<string, unknown>;
    requires?: string[];
    /** This entry's own `name:` alias -- see `setWorkflowJobEntryAlias`. */
    alias?: string;
    context?: string[];
    filters?: unknown;
    /** Applied in order via `addWorkflowEntryStep`. */
    preSteps?: unknown[];
    /** Applied in order via `addWorkflowEntryStep`. */
    postSteps?: unknown[];
  },
): void {
  const seq = requireWorkflowSeq(doc, args.workflowName);
  const { alias: orbAlias, value: ref } = orbsEntry(args.orbRef, args.orbAlias);
  addOrb(doc, orbAlias, ref);

  const entryValue = workflowJobEntry(
    orbAlias,
    args.jobName,
    args.params,
    args.requires,
  );
  seq.items.push(doc.createNode(entryValue));

  // Everything below is optional, workflow-entry-level config carried by
  // the initial drop itself (issue #37) -- without this, editing an orb
  // job's context/filters/pre-steps/post-steps/alias would work fine once
  // it's in the document, but nothing dropped in by drag-and-drop could
  // ever *start out* with any of them set.
  const originalId = `${orbAlias}/${args.jobName}`;
  if (args.alias) {
    setWorkflowJobEntryAlias(doc, args.workflowName, originalId, args.alias);
  }
  const nodeId = args.alias || originalId;
  if (args.context && args.context.length > 0) {
    setWorkflowJobEntryOption(
      doc,
      args.workflowName,
      nodeId,
      'context',
      args.context,
    );
  }
  if (args.filters !== undefined) {
    setWorkflowJobEntryOption(
      doc,
      args.workflowName,
      nodeId,
      'filters',
      args.filters,
    );
  }
  for (const step of args.preSteps ?? []) {
    addWorkflowEntryStep(doc, args.workflowName, nodeId, 'pre-steps', step);
  }
  for (const step of args.postSteps ?? []) {
    addWorkflowEntryStep(doc, args.workflowName, nodeId, 'post-steps', step);
  }
}

/**
 * Drops an orb command onto a job's `steps:`: ensures the orb is imported,
 * then delegates to `addStep` for the actual insertion (so index handling,
 * `steps:` auto-creation, etc. only live in one place).
 */
export function insertOrbStep(
  doc: Document,
  args: {
    jobName: string;
    orbRef: string;
    orbAlias?: string;
    commandName: string;
    params?: Record<string, unknown>;
    index?: number;
  },
): void {
  requireJob(doc, args.jobName);
  const { alias, value: ref } = orbsEntry(args.orbRef, args.orbAlias);
  addOrb(doc, alias, ref);

  const stepValue = stepEntry(alias, args.commandName, args.params);
  addStep(doc, args.jobName, stepValue, args.index);
}

/**
 * Drops an orb command onto a workflow entry's `pre-steps:`/`post-steps:`:
 * ensures the orb is imported, then delegates to `addWorkflowEntryStep` for
 * the actual insertion. The pre-steps/post-steps counterpart of
 * `insertOrbStep` above -- issue #21 found the two lists asymmetric: reorder
 * (`moveWorkflowEntryStep`) and remove already worked on pre/post-steps, but
 * nothing landed a *new* orb command there, so the inspector's own drop
 * target had no mutation to call even once it was wired up.
 */
export function insertOrbEntryStep(
  doc: Document,
  args: {
    workflowName: string;
    nodeId: string;
    key: WorkflowEntryStepsKey;
    orbRef: string;
    orbAlias?: string;
    commandName: string;
    params?: Record<string, unknown>;
    index?: number;
  },
): void {
  const { alias, value: ref } = orbsEntry(args.orbRef, args.orbAlias);
  addOrb(doc, alias, ref);

  const stepValue = stepEntry(alias, args.commandName, args.params);
  addWorkflowEntryStep(
    doc,
    args.workflowName,
    args.nodeId,
    args.key,
    stepValue,
    args.index,
  );
}

/**
 * Sets `jobs.<jobName>.executor` to an orb executor reference
 * (`"<alias>/<executorName>"`), ensuring the orb is imported first.
 */
export function setJobExecutorFromOrb(
  doc: Document,
  args: {
    jobName: string;
    orbRef: string;
    orbAlias?: string;
    executorName: string;
  },
): void {
  requireJob(doc, args.jobName);
  const { alias, value: ref } = orbsEntry(args.orbRef, args.orbAlias);
  addOrb(doc, alias, ref);

  setIn(
    doc,
    ['jobs', args.jobName, 'executor'],
    executorRef(alias, args.executorName),
  );
}

// ---------------------------------------------------------------------------
// Reusable-config extraction (issue #79)
//
// "Reusable configs are kind of a gateway to CircleCI orbs afterwards" --
// the highest-value item issue #79 asks for is noticing when two or more
// jobs already carry identical inline executors, or an identical `steps:`
// list, and offering to factor the shared part out into a named
// `executors:`/`commands:` entry the jobs then reference. `detectDuplication.ts`
// finds the candidates (read-only); the two functions below perform the
// extraction itself, once a user has chosen to accept the suggestion.
//
// Both follow the same shape, deliberately kept as parallel as the two
// underlying YAML shapes allow:
//
//  1. Refuse up front (document untouched) if there are fewer than two
//     jobs, the destination name is already taken, any job doesn't exist,
//     or -- re-derived here, not trusted from the caller -- the jobs no
//     longer actually match. That last check matters because a caller
//     builds `jobNames` from a `DuplicateExecutorGroup`/`DuplicateStepsGroup`
//     computed against a snapshot of the document that may since have
//     changed (the user could have edited one of the jobs, or queued two
//     suggestions from one stale render); extracting across jobs that have
//     quietly diverged would silently change one of them's behavior, which
//     is exactly the "mangled config" failure issue #79 calls out as
//     poisoning the whole feature.
//  2. Pick the first job (in the order given -- callers pass document
//     order) as the *source*: its actual field/steps node is moved (via
//     `takeNode`/`setNodeIn`, not copied via `getIn`+`setIn`) to the new
//     `executors:`/`commands:` entry, so any comment inside that structure
//     (a note on a specific image tag, a step-level comment, ...) survives
//     at its new home instead of being discarded and rebuilt from a plain
//     JS value. See `documentUtils.setNodeIn`'s own doc comment for why a
//     comment on the *removed key itself* (e.g. "# builds the image" right
//     above a job's `docker:`) is not preserved -- that key no longer
//     exists on the job either way once this runs.
//  3. Every other job in the group has its now-redundant fields deleted and
//     replaced with a reference to the new shared entry.
// ---------------------------------------------------------------------------

/** Fields that make up an executor's own shape, in the order they're moved/deleted -- see `applyExecutorSpec`, which is what originally wrote them onto a job in this same shape. */
const EXECUTOR_SHAPE_FIELDS = [
  'docker',
  'machine',
  'macos',
  'resource_class',
  'working_directory',
] as const;

/**
 * Extracts the identical inline executor shared by `jobNames` (at least
 * two, and only ever validly the output of `detectDuplication.findDuplicateExecutors`)
 * into a new `executors.<executorName>` entry, then points every one of
 * those jobs at it via `executor: <executorName>` -- the AST-level version
 * of the "reusable executor" checkbox `ConfigureJobDialog` already offers
 * for a single new job, generalized to jobs that already exist and already
 * agree with each other.
 */
export function extractSharedExecutor(
  doc: Document,
  jobNames: string[],
  executorName: string,
): void {
  if (jobNames.length < 2) {
    throw new Error('Extracting a reusable executor needs at least two jobs');
  }
  if (listExecutorNames(doc).includes(executorName)) {
    throw new Error(`Executor "${executorName}" already exists`);
  }
  for (const jobName of jobNames) requireJob(doc, jobName);

  const signatures = jobNames.map((jobName) =>
    executorSignatureKey(doc, jobName),
  );
  const [first, ...rest] = signatures;
  if (first === null || rest.some((sig) => sig !== first)) {
    throw new Error(
      'These jobs no longer have identical inline executors -- refusing to extract. ' +
        'One of them may have been edited since this suggestion was computed.',
    );
  }

  const [sourceJob, ...otherJobs] = jobNames as [string, ...string[]];

  for (const field of EXECUTOR_SHAPE_FIELDS) {
    const node = takeNode(doc, ['jobs', sourceJob, field]);
    if (node) setNodeIn(doc, ['executors', executorName, field], node);
  }
  setIn(doc, ['jobs', sourceJob, 'executor'], executorName);

  for (const jobName of otherJobs) {
    for (const field of EXECUTOR_SHAPE_FIELDS) {
      deleteIn(doc, ['jobs', jobName, field]);
    }
    setIn(doc, ['jobs', jobName, 'executor'], executorName);
  }
}

/**
 * Extracts the identical `steps:` shared by `jobNames` (at least two, and
 * only ever validly the output of `detectDuplication.findDuplicateStepSequences`)
 * into a new `commands.<commandName>.steps`, then replaces every one of
 * those jobs' own `steps:` with the single-item list `[<commandName>]` --
 * the "flexible requires with the requires key" idea (see #78's docs link
 * on reusable config), applied to `steps:` rather than `executors:`.
 *
 * Deliberately does not attempt to give the new command any `parameters:`
 * -- every job's steps were byte-for-byte identical to begin with (that's
 * the whole detection criterion), so there is nothing parameter-shaped to
 * infer; a user who wants the command parameterized can do that afterward
 * the same way they would for one they wrote by hand.
 */
export function extractSharedCommand(
  doc: Document,
  jobNames: string[],
  commandName: string,
): void {
  if (jobNames.length < 2) {
    throw new Error('Extracting a reusable command needs at least two jobs');
  }
  if (listKeys(doc, ['commands']).includes(commandName)) {
    throw new Error(`Command "${commandName}" already exists`);
  }
  for (const jobName of jobNames) requireJob(doc, jobName);

  const signatures = jobNames.map((jobName) =>
    JSON.stringify(getIn(doc, ['jobs', jobName, 'steps'])),
  );
  const [first, ...rest] = signatures;
  if (first === undefined || rest.some((sig) => sig !== first)) {
    throw new Error(
      'These jobs no longer have identical steps -- refusing to extract. ' +
        'One of them may have been edited since this suggestion was computed.',
    );
  }

  const [sourceJob, ...otherJobs] = jobNames as [string, ...string[]];

  const stepsNode = takeNode(doc, ['jobs', sourceJob, 'steps']);
  if (!stepsNode) {
    throw new Error(`Job "${sourceJob}" has no steps to extract`);
  }
  setNodeIn(doc, ['commands', commandName, 'steps'], stepsNode);
  setIn(doc, ['jobs', sourceJob, 'steps', 0], commandName);

  for (const jobName of otherJobs) {
    deleteIn(doc, ['jobs', jobName, 'steps']);
    setIn(doc, ['jobs', jobName, 'steps', 0], commandName);
  }
}

// ---------------------------------------------------------------------------
// workflow-level fields (issue #288)
// ---------------------------------------------------------------------------
//
// Everything above this point edits a *workflow entry* -- one job's place in
// a workflow's `jobs:` list. Nothing above touches the workflow's own
// top-level keys (`when`, `unless`, `triggers`, `max_auto_reruns`), because
// until issue #288 nothing in the UI selected the workflow itself to edit
// them. These four mirror `setJobField`/`unsetJobField` exactly -- the same
// "resolve the owner, then delegate to `setIn`/`deleteIn`" shape -- just
// rooted at `workflows.<name>` instead of `jobs.<name>`.

function requireWorkflow(doc: Document, workflowName: string): void {
  if (!getWorkflowNames(doc).includes(workflowName)) {
    throw new Error(`Workflow "${workflowName}" does not exist`);
  }
}

/**
 * Sets `workflows.<workflowName>.<path...>` to `value`, creating
 * intermediate containers as needed -- the workflow-level counterpart of
 * `setJobField`. Used for `when`/`unless` (a string, or a `logic` map --
 * see the inspector's `LogicValueEditor`, which is careful to write back
 * whichever shape it was given rather than normalizing one into the other)
 * and for `max_auto_reruns` (a number), and by the trigger helpers below for
 * one trigger's own `schedule.cron`/`schedule.filters`.
 */
export function setWorkflowField(
  doc: Document,
  workflowName: string,
  path: (string | number)[],
  value: unknown,
): void {
  requireWorkflow(doc, workflowName);
  setIn(doc, ['workflows', workflowName, ...path], value);
}

/** Removes `workflows.<workflowName>.<path...>` -- the "clear this field" counterpart of `setWorkflowField`, e.g. dropping `when`/`unless` entirely rather than writing an empty string. */
export function unsetWorkflowField(
  doc: Document,
  workflowName: string,
  path: (string | number)[],
): void {
  requireWorkflow(doc, workflowName);
  deleteIn(doc, ['workflows', workflowName, ...path]);
}

/**
 * Appends a new `schedule:` trigger to `workflowName`'s `triggers:`,
 * creating the list if absent. Seeded with a syntactically valid cron (every
 * day at midnight UTC) and no `filters:` -- `cron:` is the schema's one
 * *required* field of a schedule trigger, so a bare `- schedule: {}` would
 * be invalid CircleCI syntax the instant it's added, before the user has
 * touched anything.
 */
export function addWorkflowTrigger(doc: Document, workflowName: string): void {
  requireWorkflow(doc, workflowName);
  const seq = ensureSeq(doc, ['workflows', workflowName, 'triggers']);
  seq.items.push(doc.createNode({ schedule: { cron: '0 0 * * *' } }));
}

/** Removes the trigger at `index` from `workflowName`'s `triggers:`. */
export function removeWorkflowTrigger(
  doc: Document,
  workflowName: string,
  index: number,
): void {
  requireWorkflow(doc, workflowName);
  deleteIn(doc, ['workflows', workflowName, 'triggers', index]);
}
