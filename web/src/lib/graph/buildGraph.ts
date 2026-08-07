/**
 * Pure, framework-free derivation of a workflow's dependency graph from the
 * *source* config document -- never from compiled/expanded API output, so
 * this works completely offline with no CircleCI token. Keep this module
 * free of React/zustand so it stays trivial to unit test; layout
 * (`./layout.ts`) is a separate concern on purpose.
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
  getJobGroupMembers,
  getJobGroupNames,
  getJobNames,
  getNode,
  getWorkflowNames,
  parseRequiresEntries,
  type RequireRef,
} from '~/lib/yaml/documentUtils';
import {
  defaultMatrixName,
  readMatrixSpec,
  substituteMatrixTemplate,
  type MatrixCombo,
  type MatrixSpec,
} from '~/lib/yaml/matrixExpansion';

/**
 * `missing` is not a shape a config can write. It is synthesised for a
 * `requires:` naming an id no entry in the workflow has -- issue #12's
 * visible half. See `WorkflowGraph.nodes` and `GraphNode.isMissing`.
 *
 * `group` is a workflow entry whose name resolves to a top-level `job-groups`
 * entry rather than a `jobs:` one (issue #220). It is deliberately its own
 * kind rather than a `job` with a flag, because *every* rule this app applies
 * to a job node is wrong for a group: a group has no `steps:` to add to, no
 * executor to set, and no `jobs.<name>` key to rename or delete -- so the
 * existing `kind === 'job'` guards on drop targets, on the inspector's job
 * body, and on the delete affordance all come out correct with no change,
 * which is exactly why this is modelled as a kind.
 */
export type GraphNodeKind = 'job' | 'approval' | 'orb' | 'group' | 'missing';

/** One `filters:` direction (`branches:` or `tags:`) -- `only`/`ignore`, each normalized to a list even when the source wrote a bare string (see `readStringList`). */
export interface WorkflowEntryFilterGroup {
  only?: string[];
  ignore?: string[];
}

/** A workflow entry's `filters:`, present only for the directions actually declared. */
export interface WorkflowEntryFilters {
  branches?: WorkflowEntryFilterGroup;
  tags?: WorkflowEntryFilterGroup;
}

/**
 * The plain per-entry options CircleCI accepts on a workflow job entry, on
 * top of `name`/`type`/`requires`/`matrix` (which already have their own
 * `GraphNode` fields). Populated for *every* node kind -- issue #37's whole
 * point is that these are ordinary, editable workflow config regardless of
 * whether the entry's `jobName` has a local definition -- with empty
 * defaults (`[]`/`{}`, `filters` omitted) for an entry that sets none of
 * them, so consumers never have to null-check before reading.
 */
export interface WorkflowEntryOptions {
  /** `context:`, normalized to a list whether the source wrote a bare string or a list. */
  context: string[];
  /** `filters:`, or `undefined` when the entry has none. */
  filters?: WorkflowEntryFilters;
  /**
   * `pre-steps:` -- steps CircleCI splices in *before* the job's own steps
   * (for an orb job, before its generated steps). Each item is the same
   * plain-JS step shape `getIn(doc, [...,'steps'])` would produce, not a
   * live YAML node.
   */
  preSteps: unknown[];
  /** `post-steps:` -- steps spliced in after. */
  postSteps: unknown[];
  /**
   * `serial-group:` -- the string CircleCI uses to make jobs sharing it run
   * one after another *across an organisation*, not merely within this
   * workflow (issue #220).
   *
   * Read as an opaque string on purpose. Its value routinely contains pipeline
   * values (`<< pipeline.project.slug >>/deploy-group`), so its compiled
   * identity is not knowable from the source document, and two entries whose
   * `serial-group` strings differ textually may still serialise against each
   * other once compiled. That is also why this must not be turned into graph
   * *edges*: which member of a serial group runs first is decided at run time
   * by queue arrival and pipeline number, not by anything in this file, so
   * there is no truthful edge to draw. See `GraphNode.serialGroup`.
   */
  serialGroup?: string;
  /**
   * `override-with:` -- the orb job that replaces this locally-defined job's
   * configuration at the call site (issue #220). An opaque `orb/job` string;
   * nothing here resolves it, because whether the named orb job exists is a
   * fact about the orb, not about this document.
   */
  overrideWith?: string;
  /**
   * Every other sibling key in the entry's options map: an orb job's own
   * invocation parameters, or a parameterized local job's own `parameters:`
   * values passed at the call site. Excludes every key that already has a
   * dedicated field above or on `GraphNode` itself -- see
   * `RESERVED_ENTRY_KEYS` for the exact list.
   */
  parameters: Record<string, unknown>;
}

export interface GraphNode {
  /**
   * Unique within the workflow. A workflow job entry may set a `name:` key
   * to alias the same underlying job multiple times (e.g. two `test`
   * entries named `test-linux` / `test-macos`), and `requires:` elsewhere
   * in the workflow references that alias, not the job name -- so the
   * node's `id` must be the alias, never the bare job name, or cross-node
   * `requires` edges would silently fail to resolve.
   */
  id: string;
  /** The underlying job name (or orb job reference, e.g. `node/test`). */
  jobName: string;
  /** Always equal to `id`; kept as its own field so callers don't have to know id===alias. */
  alias: string;
  kind: GraphNodeKind;
  /** Set only when `kind === 'orb'`: the part of `jobName` before the `/`. */
  orbRef?: string;
  /**
   * Set only when `kind === 'group'`: the job names this `job-groups` entry
   * invokes, in document order (issue #220). `undefined` when this app could
   * not read a membership list at all -- see `getJobGroupMembers`'s own doc
   * comment on why that must never collapse into `[]`; issue #24's "Group"
   * badge and `groupSubgraph` below both key off this distinction.
   *
   * Present so a consumer can say *what* the group contains without re-reading
   * the document, and so the node can be labelled as a group rather than
   * passing for an ordinary job. This field alone is deliberately **not**
   * expanded into separate top-level graph nodes: the group is invoked as one
   * unit and its `requires:` applies to the unit, so one node per invocation
   * remains the truthful shape of *this* array. `groupSubgraph` is where the
   * members themselves live, for a caller that wants to draw them.
   */
  groupMembers?: string[];
  /**
   * Set only when `kind === 'group'` and `groupMembers` resolved: the
   * group's own interior, built by the identical machinery this file uses
   * for a workflow -- each member resolved to job/orb/approval/group, its
   * `requires:` turned into edges, a dangling reference synthesised as a
   * `missing` hole, cycles detected -- because the reference documents a
   * group's `jobs:` as following "the same format as workflow job entries"
   * and it deserves the same treatment, not a stripped-down one (issue #24).
   *
   * `undefined` whenever `groupMembers` is (nothing to draw), which is a
   * strictly *stronger* condition than the reverse: a member that itself
   * names another job-groups entry resolves to its own `kind: 'group'` node
   * here with `groupMembers` set, but no `groupSubgraph` of its own -- this
   * app draws a group's interior exactly one level deep, so a member that is
   * itself a group renders collapsed rather than recursing indefinitely (and
   * a group cannot be forced into naming itself as its own member to defeat
   * that bound, since the same one-level cutoff applies before any cycle
   * could form).
   *
   * Every node/edge id in here is prefixed `${this node's id}::` (see
   * `GraphNode.parentId`/`GraphEdge.internal`) so it can never collide with a
   * sibling workflow-level id, or with another group's own members, once a
   * caller flattens this alongside the top-level arrays for rendering.
   */
  groupSubgraph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    problems: GraphProblem[];
  };
  /**
   * Set only on a node that lives inside another node's `groupSubgraph`: that
   * group's own `id`. `undefined` for every ordinary workflow-level node.
   * This is what lets a renderer parent a member visually under its group
   * (React Flow's own `parentId` node relationship expects exactly this),
   * and what `findGraphNode` walks to resolve a member id back to the group
   * that contains it.
   */
  parentId?: string;
  /**
   * This entry's `serial-group:` string, if any -- lifted from
   * `entryOptions.serialGroup` onto the node so the DAG can mark a job that
   * queues behind other pipelines without reaching into the options bag.
   * Never an edge; see `WorkflowEntryOptions.serialGroup` for why.
   */
  serialGroup?: string;
  /** The aliases (not necessarily job names) this entry's `requires:` lists. */
  requires: string[];
  /**
   * False for a `job` node whose `jobName` is neither a top-level `jobs:`
   * entry nor orb-qualified. Approval and orb nodes are always `true`:
   * approvals need no job definition at all, and orb-provided jobs are by
   * definition never listed under `jobs:`.
   */
  isDefined: boolean;
  /**
   * True for a node expanded from a `matrix:` workflow entry (issue #284).
   * One `matrix:` entry becomes one node *per parameter combination* --
   * `exclude:`d combinations excepted -- each with its own id (CircleCI's own
   * expanded name; see `~/lib/yaml/matrixExpansion`), not one node standing in
   * for all of them. `matrixGroupSize`/`matrixParams` below carry the rest of
   * what the old boolean-only field lost: which group this instance belongs
   * to, and which combination it is.
   */
  matrix: boolean;
  /** Set only when `matrix` is true: how many sibling nodes (across every combination, minus `exclude:`) this entry expanded into -- what the DAG's "×N" badge reports, so the grouping the old single-node rendering showed doesn't disappear now that the nodes themselves are real. */
  matrixGroupSize?: number;
  /** Set only when `matrix` is true: this specific instance's own parameter values, e.g. `{ region: 'NA' }`. */
  matrixParams?: MatrixCombo;
  /** This entry's own workflow-level options -- see `WorkflowEntryOptions`. Always present, defaulted for a bare-string entry. */
  entryOptions: WorkflowEntryOptions;
  /**
   * True only for a synthesised placeholder standing in for an id some
   * entry's `requires:` names but that no entry in this workflow provides
   * (issue #12). There is no line in the config corresponding to this node --
   * it is a *hole*, drawn so the broken dependency is something the user can
   * see and click rather than an edge that silently vanished. Nothing may be
   * dropped on it, dragged from it, renamed, or deleted; the fix is always to
   * edit the `requires:` that points here, or to add the missing entry.
   */
  isMissing?: boolean;
}

export interface GraphEdge {
  id: string;
  /** The required node's id -- runs first. */
  source: string;
  /** The requiring node's id -- runs after `source`. */
  target: string;
  /**
   * Explicit job-status conditions from a status-map `requires:` entry
   * (`- lint: [success, failed]`), or `undefined` for the plain-string
   * form. Purely descriptive -- the edge itself, and where it points, is
   * identical either way (see issue #26); this is only here so the UI can
   * show that the edge also fires on e.g. `failed`.
   */
  statuses?: string[];
  /**
   * True when `source` is a synthesised `missing` node -- this edge points at
   * a `requires:` target that does not exist (issue #12). Kept as a real edge
   * to a real (if placeholder) node rather than being dropped, so ELK lays it
   * out normally and the break is visible on the canvas; the UI styles it as
   * broken. See `WorkflowGraph.nodes`.
   */
  dangling?: boolean;
  /**
   * True for an edge inside a group's own `groupSubgraph` -- a member's
   * `requires:` naming a sibling member, never a workflow-level dependency
   * (issue #24). A renderer must withhold the unlink affordance a workflow-
   * level edge gets: removing one would mean mutating
   * `job-groups.<name>.jobs[i].requires`, and this app has no mutation for
   * that yet. Offering a control that silently does nothing (or worse, edits
   * the wrong path) is exactly the dishonest-UI failure this project refuses
   * to ship, so the flag exists to let a renderer refuse instead.
   */
  internal?: boolean;
}

export interface GraphProblem {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  /**
   * Set on the "`requires:` names an id nothing provides" problem: the alias
   * whose `requires:` is wrong, and the id it names. Present so a consumer
   * can act on the problem -- resolve it to a line, offer a fix -- without
   * re-parsing `message`, which is prose and free to be reworded (issue
   * #148). Purely additive: nothing here changes which problems are
   * reported or what they say.
   */
  danglingRequire?: { fromAlias: string; missingId: string };
  /** Set on the "entry references a job that isn't defined under `jobs:`" problem: the job name that has no definition. Same rationale as `danglingRequire`. */
  undefinedJob?: string;
}

export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  problems: GraphProblem[];
}

/** Thin wrapper over `getWorkflowNames` so graph/pane code has one obvious import for "what can I render". */
export function listWorkflows(doc: Document): string[] {
  return getWorkflowNames(doc);
}

interface RawEntry {
  jobName: string;
  /** Already-expanded (template-substituted, or default-computed) for a matrix instance -- see `parseEntries`. */
  alias: string;
  /** Already-expanded for a matrix instance: each id has this instance's own `<< matrix.* >>` tokens substituted, same as `alias`. */
  requires: RequireRef[];
  isApproval: boolean;
  matrix: boolean;
  matrixGroupSize?: number;
  matrixParams?: MatrixCombo;
  /**
   * Set only when `matrix` is true: the string another entry's `requires:`
   * can use to mean "every instance of this matrix" -- `matrix.alias` if the
   * entry set one, otherwise the bare job name (CircleCI's own default; see
   * `configuration-reference.adoc`'s "Dependencies and matrix jobs"). Read by
   * `buildWorkflowGraph` to build `matrixAliasToInstanceIds`.
   */
  matrixAlias?: string;
  entryOptions: WorkflowEntryOptions;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

/**
 * Every key with its own dedicated `GraphNode`/`WorkflowEntryOptions` field --
 * everything else in an entry's options map is an invocation parameter.
 *
 * `serial-group` and `override-with` were added by issue #220. Both are keys
 * CircleCI defines on a workflow job invocation, and leaving them out of this
 * set did not merely lose them: it filed them under `entryOptions.parameters`,
 * i.e. reported two pieces of orchestration config as though the user had
 * passed a parameter of that name to the job. Since the inspector only renders
 * parameters a job or orb actually *declares*, the practical result was that
 * both keys were silently invisible while being modelled as something they
 * are not.
 */
const RESERVED_ENTRY_KEYS = new Set([
  'name',
  'type',
  'requires',
  'context',
  'filters',
  'matrix',
  'pre-steps',
  'post-steps',
  'serial-group',
  'override-with',
]);

/** A live YAML node, unwrapped to the same plain-JS shape `getIn` would produce. */
function nodeToJS(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  if (isMap(node) || isSeq(node)) return node.toJSON();
  return node;
}

/** A field CircleCI accepts as either a bare string or a list of strings (`context:`, and each of `filters.branches`/`filters.tags`'s `only`/`ignore`), normalized to a list either way. */
function readStringList(value: unknown): string[] {
  if (isScalar(value)) return [String(value.value)];
  if (isSeq(value)) {
    return value.items.filter(isScalar).map((item) => String(item.value));
  }
  return [];
}

function readFilterGroup(value: unknown): WorkflowEntryFilterGroup | undefined {
  if (!isMap(value)) return undefined;
  const only = readStringList(findPair(value, 'only')?.value);
  const ignore = readStringList(findPair(value, 'ignore')?.value);
  const result: WorkflowEntryFilterGroup = {};
  if (only.length > 0) result.only = only;
  if (ignore.length > 0) result.ignore = ignore;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readFilters(value: unknown): WorkflowEntryFilters | undefined {
  if (!isMap(value)) return undefined;
  const branches = readFilterGroup(findPair(value, 'branches')?.value);
  const tags = readFilterGroup(findPair(value, 'tags')?.value);
  if (!branches && !tags) return undefined;
  const result: WorkflowEntryFilters = {};
  if (branches) result.branches = branches;
  if (tags) result.tags = tags;
  return result;
}

/** `pre-steps:`/`post-steps:`, read to the same plain-JS shape a job's own `steps:` would produce via `getIn`. */
function readSteps(value: unknown): unknown[] {
  if (!isSeq(value)) return [];
  return value.items.map((item) => nodeToJS(item));
}

function emptyEntryOptions(): WorkflowEntryOptions {
  return { context: [], preSteps: [], postSteps: [], parameters: {} };
}

/** Reads every option on one workflow entry's options map beyond `name`/`type`/`requires`/`matrix` -- see `WorkflowEntryOptions`. */
function readEntryOptions(options: YAMLMap): WorkflowEntryOptions {
  const contextPair = findPair(options, 'context');
  const context = contextPair ? readStringList(contextPair.value) : [];

  const serialGroup = readOptionalString(options, 'serial-group');
  const overrideWith = readOptionalString(options, 'override-with');

  const filtersPair = findPair(options, 'filters');
  const filters = filtersPair ? readFilters(filtersPair.value) : undefined;

  const preStepsPair = findPair(options, 'pre-steps');
  const preSteps = preStepsPair ? readSteps(preStepsPair.value) : [];

  const postStepsPair = findPair(options, 'post-steps');
  const postSteps = postStepsPair ? readSteps(postStepsPair.value) : [];

  const parameters: Record<string, unknown> = {};
  for (const p of options.items) {
    if (!isScalar(p.key)) continue;
    const key = String(p.key.value);
    if (RESERVED_ENTRY_KEYS.has(key)) continue;
    parameters[key] = nodeToJS(p.value);
  }

  return {
    context,
    filters,
    preSteps,
    postSteps,
    serialGroup,
    overrideWith,
    parameters,
  };
}

/**
 * Reads one scalar string key off an entry's options map, or `undefined` when
 * it is absent or is not a scalar.
 *
 * A non-scalar is treated as absent rather than coerced: `serial-group` and
 * `override-with` are specified as strings, and a config that wrote a map or a
 * list there has a validation problem for the compiler to report -- inventing
 * a string from it here would hide that.
 */
function readOptionalString(options: YAMLMap, key: string): string | undefined {
  const pair = findPair(options, key);
  if (!pair || !isScalar(pair.value)) return undefined;
  return String(pair.value.value);
}

/**
 * Reads a `jobs:` sequence -- a workflow's own, or a `job-groups` entry's,
 * both documented as the same shape -- into a flat list of raw entries,
 * handling both shapes a job entry can take: a bare string (`- build`) or a
 * single-key map (`- build: { requires: [...], name: ..., type: ... }`).
 *
 * A `matrix:` entry is expanded here, into one `RawEntry` per parameter
 * combination (issue #284) -- every downstream consumer (the node builder
 * below, and `buildNodesAndEdges`'s `requires:`/dangling-check loop) then
 * sees exactly the jobs CircleCI itself would run, with no separate
 * expansion step of its own to keep in sync. `alias` and `requires` on each
 * expanded `RawEntry` already have this *instance's own* `<< matrix.* >>`
 * tokens substituted (see `~/lib/yaml/matrixExpansion`), so a matrix job's
 * `requires:` naming another matrix's expanded instance (or its own
 * combination) resolves the same way CircleCI resolves it, not as a literal,
 * unresolved template string.
 *
 * Factored out from a workflow-specific lookup (issue #24) so a group's own
 * `jobs:` -- resolved by its caller via a different path, `['job-groups',
 * name, 'jobs']` rather than `['workflows', name, 'jobs']` -- gets the
 * identical parsing rather than a second, drifting implementation.
 */
function parseEntriesFromSeq(doc: Document, seq: unknown): RawEntry[] {
  if (!isSeq(seq)) return [];

  const entries: RawEntry[] = [];
  for (const item of seq.items) {
    if (isScalar(item)) {
      const jobName = String(item.value);
      entries.push({
        jobName,
        alias: jobName,
        requires: [],
        isApproval: false,
        matrix: false,
        entryOptions: emptyEntryOptions(),
      });
      continue;
    }

    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    const jobName = isScalar(pair.key) ? String(pair.key.value) : '';
    const options = pair.value;

    let rawAlias = jobName;
    let hasExplicitName = false;
    let rawRequires: RequireRef[] = [];
    let isApproval = false;
    let hasMatrixKey = false;
    let matrixSpec: MatrixSpec | undefined;
    let entryOptions = emptyEntryOptions();

    if (isMap(options)) {
      const namePair = findPair(options, 'name');
      if (namePair && isScalar(namePair.value)) {
        rawAlias = String(namePair.value.value);
        hasExplicitName = true;
      }

      const typePair = findPair(options, 'type');
      isApproval = Boolean(
        typePair &&
        isScalar(typePair.value) &&
        String(typePair.value.value) === 'approval',
      );

      hasMatrixKey = findPair(options, 'matrix') !== undefined;
      matrixSpec = hasMatrixKey ? readMatrixSpec(doc, options) : undefined;

      const requiresPair = findPair(options, 'requires');
      rawRequires = parseRequiresEntries(requiresPair?.value);

      entryOptions = readEntryOptions(options);
    }

    // No `matrix:`, or one this app can't make sense of (`readMatrixSpec`'s
    // own doc comment): exactly the pre-#284 single node. `matrix` still
    // reports whether the key is present, so an unreadable-but-present
    // `matrix:` at least keeps showing *something* is a matrix rather than
    // silently reverting to a plain job -- no worse than before this issue.
    if (!matrixSpec || matrixSpec.combos.length === 0) {
      entries.push({
        jobName,
        alias: rawAlias,
        requires: rawRequires,
        isApproval,
        matrix: hasMatrixKey,
        entryOptions,
      });
      continue;
    }

    const matrixAlias = matrixSpec.alias ?? jobName;
    const groupSize = matrixSpec.combos.length;
    for (const combo of matrixSpec.combos) {
      const alias = hasExplicitName
        ? substituteMatrixTemplate(rawAlias, combo)
        : defaultMatrixName(jobName, matrixSpec.paramNames, combo);
      const requires = rawRequires.map((ref) => ({
        ...ref,
        id: substituteMatrixTemplate(ref.id, combo),
      }));
      entries.push({
        jobName,
        alias,
        requires,
        isApproval,
        matrix: true,
        matrixGroupSize: groupSize,
        matrixParams: combo,
        matrixAlias,
        entryOptions,
      });
    }
  }
  return entries;
}

/** One workflow's own `jobs:` sequence, parsed via `parseEntriesFromSeq`. */
function parseEntries(doc: Document, workflowName: string): RawEntry[] {
  return parseEntriesFromSeq(
    doc,
    getNode(doc, ['workflows', workflowName, 'jobs']),
  );
}

/**
 * One `job-groups` entry's own `jobs:` sequence, parsed via
 * `parseEntriesFromSeq` -- the same reader a workflow's own `jobs:` uses,
 * because the reference documents a group's members as following identical
 * syntax (issue #24).
 */
function parseGroupEntries(doc: Document, groupName: string): RawEntry[] {
  return parseEntriesFromSeq(
    doc,
    getNode(doc, ['job-groups', groupName, 'jobs']),
  );
}

/**
 * Decides which namespace a workflow entry's name resolves into.
 *
 * Order matters and is checked in decreasing certainty: `type: approval` is
 * stated outright by the entry, a job-group name is a key this document
 * defines, an orb reference is recognisable from its `/`, and a plain job name
 * is the remainder. Groups are tested before the orb check even though a group
 * name cannot contain a `/` (CircleCI's own name pattern forbids it), so that
 * a future loosening of either rule fails towards "this is the group the user
 * defined" rather than towards a phantom orb.
 */
function resolveKind(
  jobName: string,
  isApproval: boolean,
  jobGroups: Set<string>,
): { kind: GraphNodeKind; orbRef?: string } {
  if (isApproval) return { kind: 'approval' };
  if (jobGroups.has(jobName)) return { kind: 'group' };
  const slashIndex = jobName.indexOf('/');
  if (slashIndex > 0)
    return { kind: 'orb', orbRef: jobName.slice(0, slashIndex) };
  return { kind: 'job' };
}

/**
 * Job-status values CircleCI's status-conditioned `requires:` syntax is
 * known to accept. This is a best-effort list, not something pulled from a
 * verified exhaustive spec -- we couldn't confirm the full accepted set
 * against the real compiler -- so a value outside it is reported as a
 * *warning* only (see the loop in `buildWorkflowGraph`), never an error:
 * being behind on the docs must never block a config the real compiler
 * would happily accept.
 */
const KNOWN_REQUIRE_STATUSES = new Set(['success', 'failed', 'canceled']);

/** The placeholder node standing in for a `requires:` target nothing provides -- see `GraphNode.isMissing`. */
function missingNode(id: string): GraphNode {
  return {
    id,
    jobName: id,
    alias: id,
    kind: 'missing',
    requires: [],
    isDefined: false,
    matrix: false,
    entryOptions: emptyEntryOptions(),
    isMissing: true,
  };
}

/**
 * Builds a dependency graph from an already-parsed list of entries -- a
 * workflow's own `jobs:`, or (issue #24) one `job-groups` entry's `jobs:`,
 * both documented as the same shape and so both deserving the identical
 * treatment: kind resolution, dangling-`requires:` detection, and cycle
 * detection, not a stripped-down version of it for whichever namespace
 * showed up second.
 *
 * Unknown `requires` targets, references to undefined jobs, and dependency
 * cycles are collected as `problems` rather than thrown, so a broken config
 * can still be rendered (with warnings) instead of blanking out the DAG pane.
 *
 * A `requires:` naming an id no entry provides (issue #12: what renaming or
 * deleting a job used to leave behind, and what a hand-edited config can
 * always contain) is deliberately *not* dropped. It becomes a synthesised
 * `missing` placeholder node plus a `dangling` edge into the entry that
 * requires it, so the break renders as a visible hole in the graph rather
 * than as an edge that silently isn't there. The `error` problem describing it
 * is still reported exactly as before -- the placeholder is additional
 * signal, not a replacement for it. ELK lays these out like any other node
 * (`layout.test.ts` pins that it doesn't throw), which is the whole reason
 * this is modelled as a node rather than as a half-drawn edge.
 *
 * `expandGroups` bounds how deep a group's own interior gets resolved.
 * `buildWorkflowGraph` (below) calls this with `true` for a workflow's own
 * entries, so each `group`-kind node it produces also gets a `groupSubgraph`
 * -- but that recursive call, for the group's *own* members, passes `false`,
 * so a member that itself names another job-groups entry resolves to a
 * `group`-kind node (with its own `groupMembers`) but no further
 * `groupSubgraph`. This isn't a shortcut taken for convenience: it is the
 * only depth this app's canvas can actually draw (issue #24 expands one
 * level, the selected group's direct members, never a member-of-a-member),
 * and stopping the *data* at the same depth the *renderer* stops at means
 * there is no `groupSubgraph` anywhere that claims to be drawable but isn't
 * -- and, as a side effect, makes a group that names itself (directly or via
 * a cycle of groups) structurally impossible to recurse into forever, with
 * no separate cycle guard required.
 */
function buildNodesAndEdges(
  doc: Document,
  entries: RawEntry[],
  definedGroups: Set<string>,
  expandGroups: boolean,
): { nodes: GraphNode[]; edges: GraphEdge[]; problems: GraphProblem[] } {
  const definedJobs = new Set(getJobNames(doc));

  const nodes: GraphNode[] = entries.map((entry) => {
    const { kind, orbRef } = resolveKind(
      entry.jobName,
      entry.isApproval,
      definedGroups,
    );
    // Unchanged, and correct for the new kind without a special case: only a
    // `job` needs a `jobs:` key to be considered defined, and a `group` has
    // already been resolved against `job-groups` by resolveKind.
    const isDefined = kind === 'job' ? definedJobs.has(entry.jobName) : true;
    const groupMembers =
      kind === 'group' ? getJobGroupMembers(doc, entry.jobName) : undefined;
    return {
      id: entry.alias,
      jobName: entry.jobName,
      alias: entry.alias,
      kind,
      orbRef,
      groupMembers,
      // Filled in once every node exists (below): building a group's own
      // interior needs `parseGroupEntries`/a recursive call, which is easier
      // to reason about as a second pass than interleaved with this map.
      groupSubgraph: undefined,
      serialGroup: entry.entryOptions.serialGroup,
      // Ids only -- the map form's statuses are metadata for the edge, not
      // part of what a node "requires" topologically (see `RequireRef`).
      requires: entry.requires.map((ref) => ref.id),
      isDefined,
      matrix: entry.matrix,
      matrixGroupSize: entry.matrixGroupSize,
      matrixParams: entry.matrixParams,
      entryOptions: entry.entryOptions,
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const problems: GraphProblem[] = [];
  const edges: GraphEdge[] = [];
  const usedEdgeIds = new Set<string>();
  /** Synthesised placeholders, appended after every real node so a bare-string entry's model order is unaffected. */
  const missing = new Map<string, GraphNode>();

  // A `requires:` entry can also name a matrix's *alias* -- `matrix.alias` if
  // the entry set one, otherwise (CircleCI's own default) the bare job name
  // -- to mean "every instance of this matrix", per
  // `configuration-reference.adoc`'s "Dependencies and matrix jobs". Built
  // once here so the loop below can fan a single `requires:` entry out to
  // every instance instead of reporting it dangling. A real node id always
  // wins over this if one happens to coincide (checked first, below).
  const matrixAliasToInstanceIds = new Map<string, string[]>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const node = nodes[i];
    if (!entry?.matrix || !node) continue;
    const key = entry.matrixAlias ?? entry.jobName;
    const existing = matrixAliasToInstanceIds.get(key);
    if (existing) existing.push(node.id);
    else matrixAliasToInstanceIds.set(key, [node.id]);
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const entry = entries[i];
    if (!node || !entry) continue;

    if (node.kind === 'job' && !node.isDefined) {
      problems.push({
        severity: 'warning',
        message: `"${node.alias}" references job "${node.jobName}", which is not defined under jobs: and is not an orb job`,
        nodeId: node.id,
        undefinedJob: node.jobName,
      });
    }

    // Issue #24: a group's own interior, resolved by the identical function
    // one level down (`expandGroups: false`, so it goes no deeper than
    // this) -- see this function's own doc comment on why the bound is here
    // rather than a separate cycle guard. `groupMembers === undefined` means
    // this app could not read a membership list at all (`getJobGroupMembers`'s
    // own doc comment), and there is nothing to build an interior from.
    if (
      expandGroups &&
      node.kind === 'group' &&
      node.groupMembers !== undefined
    ) {
      const memberEntries = parseGroupEntries(doc, node.jobName);
      const built = buildNodesAndEdges(
        doc,
        memberEntries,
        definedGroups,
        false,
      );
      const prefix = `${node.id}::`;
      node.groupSubgraph = {
        nodes: built.nodes.map((member) => ({
          ...member,
          id: `${prefix}${member.id}`,
          parentId: node.id,
        })),
        edges: built.edges.map((memberEdge) => ({
          ...memberEdge,
          id: `${prefix}${memberEdge.id}`,
          source: `${prefix}${memberEdge.source}`,
          target: `${prefix}${memberEdge.target}`,
          internal: true,
        })),
        problems: built.problems,
      };
      // Surfaced at the workflow's own level too, not only inside
      // `groupSubgraph` -- a broken internal dependency is a real config
      // problem whether or not anyone has expanded this group to look. The
      // `nodeId` points at the *group's* own id (prefixed member ids are
      // meaningless before a renderer decides to draw the interior), which
      // is also what makes clicking the banner entry select something real.
      for (const memberProblem of built.problems) {
        problems.push({
          ...memberProblem,
          message: `In job group "${node.jobName}": ${memberProblem.message}`,
          nodeId: node.id,
        });
      }
    }

    for (const req of entry.requires) {
      if (req.malformedStatuses) {
        problems.push({
          severity: 'warning',
          message: `"${node.alias}" requires "${req.id}" with a status list that isn't a plain list of job-status strings; treating it as an unconditional dependency`,
          nodeId: node.id,
        });
      } else if (req.statuses) {
        for (const status of req.statuses) {
          if (!KNOWN_REQUIRE_STATUSES.has(status)) {
            problems.push({
              severity: 'warning',
              message: `"${node.alias}" requires "${req.id}" on unrecognized status "${status}"`,
              nodeId: node.id,
            });
          }
        }
      }

      // Issue #284: `req.id` may name either one real node (the common case,
      // and always tried first) or a matrix's alias, meaning "every instance
      // of that matrix" -- see `matrixAliasToInstanceIds` above. Only when
      // neither resolves is this a genuine dangling reference; expansion is
      // the fix for the false positive, not a loosening of this check, so a
      // name that truly doesn't resolve still reports exactly the same
      // `error` it always has.
      const directHit = nodeIds.has(req.id);
      const fanoutIds = directHit
        ? undefined
        : matrixAliasToInstanceIds.get(req.id);
      const targetIds = directHit ? [req.id] : fanoutIds;

      if (!targetIds) {
        problems.push({
          severity: 'error',
          message: `"${node.alias}" requires unknown job "${req.id}"`,
          nodeId: node.id,
          danglingRequire: { fromAlias: node.alias, missingId: req.id },
        });
        // Synthesise the hole rather than dropping the edge -- see this
        // function's doc comment. One placeholder per missing id, however
        // many entries require it.
        if (!missing.has(req.id)) missing.set(req.id, missingNode(req.id));
      }

      for (const targetId of targetIds ?? [req.id]) {
        let edgeId = `${targetId}->${node.id}`;
        let suffix = 0;
        while (usedEdgeIds.has(edgeId)) {
          suffix += 1;
          edgeId = `${targetId}->${node.id}#${suffix}`;
        }
        usedEdgeIds.add(edgeId);
        edges.push({
          id: edgeId,
          source: targetId,
          target: node.id,
          statuses: req.statuses,
          dangling: !targetIds || undefined,
        });
      }
    }
  }

  nodes.push(...missing.values());

  problems.push(...detectCycles(nodes, edges));

  return { nodes, edges, problems };
}

/**
 * Builds the dependency graph for one workflow directly from the parsed
 * config document -- see `buildNodesAndEdges` for what this actually does;
 * this is now just that function fed the workflow's own entries, with
 * `expandGroups: true` so every `group`-kind node it produces also gets a
 * `groupSubgraph` (issue #24).
 */
export function buildWorkflowGraph(
  doc: Document,
  workflowName: string,
): WorkflowGraph {
  const entries = parseEntries(doc, workflowName);
  // The second namespace a workflow entry's name can resolve into (issue
  // #220). Before this, a workflow invoking a job group was reported as
  // referencing an undefined job -- a false error about valid config, and on
  // the one surface this app's whole claim rests on.
  const definedGroups = new Set(getJobGroupNames(doc));
  return buildNodesAndEdges(doc, entries, definedGroups, true);
}

/**
 * Resolves `id` to its `GraphNode`, searching not just `graph.nodes` but one
 * level into every group's own `groupSubgraph` (issue #24) -- because a
 * group member's id only exists there, never in `graph.nodes` itself (see
 * `WorkflowGraph.nodes`'s own contract: one node per *invocation*, and a
 * group is invoked as a unit). `DagPane` uses this for every lookup that
 * used to assume "selected id -> a top-level node" -- the inspector, the
 * delete-confirm popover, diagnostic attribution -- so selecting an expanded
 * group's member keeps working exactly like selecting anything else, rather
 * than silently resolving to nothing because it lives one level down.
 */
export function findGraphNode(
  graph: WorkflowGraph,
  id: string,
): GraphNode | undefined {
  for (const node of graph.nodes) {
    if (node.id === id) return node;
    const member = node.groupSubgraph?.nodes.find((n) => n.id === id);
    if (member) return member;
  }
  return undefined;
}

/**
 * Finds cycles in the `requires` graph with a DFS over a 3-color visited
 * state (unvisited / visiting / done). A cycle here would make topological
 * layout undefined and risks an infinite loop in a naive walker, so this
 * has to run before handing anything to ELK -- and, because config authors
 * can and do write cyclic `requires` by accident, it must always terminate
 * even on adversarial input (self-loops, several overlapping cycles).
 */
function detectCycles(nodes: GraphNode[], edges: GraphEdge[]): GraphProblem[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const seenSignatures = new Set<string>();
  const problems: GraphProblem[] = [];

  function visit(id: string): void {
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === 'visiting') {
        const idx = stack.indexOf(next);
        const cycle = [...stack.slice(idx), next];
        const signature = cycleSignature(cycle);
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          problems.push({
            severity: 'error',
            message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
            nodeId: cycle[0],
          });
        }
      } else if (state.get(next) !== 'done') {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 'done');
  }

  for (const node of nodes) {
    if (!state.has(node.id)) visit(node.id);
  }
  return problems;
}

/**
 * A rotation- and duplicate-free key for a cycle, so the same cycle found
 * from two different DFS entry points (or walked in the same direction
 * from a different starting node) is only reported once.
 */
function cycleSignature(cycle: string[]): string {
  const unique = cycle.slice(0, -1);
  let minIndex = 0;
  for (let i = 1; i < unique.length; i++) {
    const candidate = unique[i];
    const current = unique[minIndex];
    if (
      candidate !== undefined &&
      current !== undefined &&
      candidate < current
    ) {
      minIndex = i;
    }
  }
  const rotated = [...unique.slice(minIndex), ...unique.slice(0, minIndex)];
  return rotated.join('>');
}
