/**
 * "What will renaming or removing this parameter actually touch?" -- the
 * read-only half of issue #250, and deliberately the same shape as
 * `jobReferences.ts` is for issue #12.
 *
 * A parameter name is a cross-reference problem in exactly the way a job name
 * is, only worse: a job name appears as a *key* or a *scalar* in a small number
 * of known places, whereas a parameter name appears inside the **text of an
 * arbitrary scalar** as `<< parameters.name >>` (element scope) or
 * `<< pipeline.parameters.name >>` (pipeline scope), anywhere in the document
 * -- a `run` command's shell, an image tag, a `when:` condition, a filter, a
 * cache key. So the enumeration cannot be a walk over a fixed list of paths;
 * it has to be a walk over every scalar.
 *
 * This module therefore does the scanning, and `describeParameterRenameImpact`/
 * `describeParameterDeleteImpact` compose the same `ReferenceImpact` that
 * `ReferenceImpactList` already renders for jobs -- the type is imported from
 * `jobReferences.ts` rather than redeclared, so the rename prompt for a
 * parameter is the same component, with the same blockers/lines/notes
 * semantics, as the rename prompt for a job. Reusing that machinery is the
 * point (issue #250 says so explicitly); a second impact renderer that drifted
 * from the first would be the failure.
 *
 * # Scope, and why it is the hard part
 *
 * CircleCI has two unrelated namespaces that both spell the word `parameters`:
 *
 * 1. **Pipeline parameters** -- top-level `parameters:`, referenced as
 *    `<< pipeline.parameters.name >>`. Document-global: every scalar in the
 *    file is a candidate site.
 * 2. **Element parameters** -- a job's (or command's, or executor's) own
 *    `parameters:`, referenced as `<< parameters.name >>`, and resolved
 *    *lexically within the element that declares it*. Two different jobs can
 *    each declare `target` and each mean their own.
 *
 * The prefixes differ, so the two never collide with each other. But two
 * *elements* absolutely do collide, which is why a job-scoped rename only
 * rewrites sites inside `jobs.<job>`'s own subtree, and why every
 * `<< parameters.name >>` found outside it is reported rather than rewritten.
 * Rewriting those would silently re-point some other job's parameter -- the
 * exact class of mistake `shouldRenameRequiresIn` exists to prevent on the job
 * side.
 *
 * # The site kinds
 *
 * - **interpolations** -- a scalar whose text contains the reference. Rewritten
 *   in place (the scalar node survives, only its string changes), so a comment
 *   on that line rides along.
 * - **invocations** -- job scope only. A job's parameters are supplied by name
 *   at the call site, as ordinary keys of a workflow entry's options map
 *   (`- build: {target: release}`) and of a job-group entry's. Renaming the
 *   declaration without renaming those keys produces `Unexpected argument(s)`
 *   at compile time, so they are part of the rename, not an afterthought.
 * - **foreign** -- a `<< parameters.name >>` we found but will *not* rewrite,
 *   because it is outside the declaring element. Usually another element's own
 *   parameter of the same name (harmless, and reported as a note only when it
 *   could be confused for ours); occasionally a genuinely unreachable site,
 *   which is what turns a rename into something we refuse rather than half-do.
 *
 * Pure and framework-free like the rest of `~/lib`: reads a `Document`,
 * returns plain data, never mutates and never throws.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Node,
  type Pair,
} from 'yaml';

import type { ReferenceImpact } from '~/lib/mutations/jobReferences';
import {
  getJobGroupNames,
  getNode,
  getWorkflowNames,
  listKeys,
  type Path,
} from '~/lib/yaml/documentUtils';

/**
 * Which `parameters:` block is being edited. Not a string enum: the job case
 * carries the job name, and every function here needs both facts together --
 * passing them separately is how a pipeline-scoped call ends up accidentally
 * reading a job's block.
 */
export type ParameterScope =
  | { kind: 'pipeline' }
  | { kind: 'job'; jobName: string };

/** The document path of `scope`'s `parameters:` map. The one place the two scopes' layouts are written down. */
export function parametersPath(scope: ParameterScope): Path {
  return scope.kind === 'pipeline'
    ? ['parameters']
    : ['jobs', scope.jobName, 'parameters'];
}

/**
 * The dotted expression a reference to `name` in `scope` is written with,
 * *without* the surrounding `<< >>`. `pipeline.parameters.x` for a pipeline
 * parameter, `parameters.x` for an element one.
 *
 * Note the containment relationship, which is why every matcher below anchors
 * on `<<`: `parameters.x` is a suffix of `pipeline.parameters.x`. A naive
 * substring search for the element form would match every pipeline reference
 * too.
 */
export function referenceExpression(
  scope: ParameterScope,
  name: string,
): string {
  return scope.kind === 'pipeline'
    ? `pipeline.parameters.${name}`
    : `parameters.${name}`;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches `<< expr >>` with the interior whitespace captured on both sides, so
 * a rewrite can put the new expression back between exactly the spaces that
 * were already there. CircleCI accepts `<<x>>` and `<< x >>` alike, and
 * normalising one into the other would show up as a spurious diff line in the
 * Save dialog for a rename that was supposed to touch only the name.
 *
 * Anchored on the literal `<<`/`>>` so `parameters.x` cannot match inside
 * `pipeline.parameters.x`: after `<<` and optional space the next characters
 * must be `parameters`, and in the pipeline form they are `pipeline`.
 * Terminated by `>>` so `x` cannot match a prefix of `x-ray` either.
 */
function referenceMatcher(expression: string): RegExp {
  return new RegExp(`(<<)(\\s*)${escapeRegExp(expression)}(\\s*)(>>)`, 'g');
}

/** How many times `expression` is referenced in `text`. */
export function countReferencesInText(
  text: string,
  expression: string,
): number {
  return text.match(referenceMatcher(expression))?.length ?? 0;
}

/**
 * Replaces every `<< oldExpression >>` in `text` with the same reference
 * spelling `newExpression`, preserving each occurrence's own interior spacing.
 */
export function rewriteReferencesInText(
  text: string,
  oldExpression: string,
  newExpression: string,
): string {
  return text.replace(
    referenceMatcher(oldExpression),
    (_match, open: string, before: string, after: string, close: string) =>
      `${open}${before}${newExpression}${after}${close}`,
  );
}

/** One scalar in the document whose text references the parameter. */
export interface InterpolationSite {
  /** Path to the scalar node, so a caller can re-resolve it and rewrite in place. */
  path: Path;
  /** How many times the reference appears inside this one scalar. */
  occurrences: number;
  /** True when the reference is in a map *key* rather than a value -- rare, and worth saying out loud in a prompt. */
  inKey: boolean;
}

/** One call site supplying a job parameter by name (job scope only). */
export interface InvocationSite {
  /** `workflows` or `job-groups` -- which container the entry lives in. */
  container: 'workflows' | 'job-groups';
  /** The workflow's or group's own name. */
  ownerName: string;
  /** Index within that owner's `jobs:` sequence. */
  index: number;
  /** The entry's id -- its `name:` alias when it has one, else the job name. Matches `buildGraph`'s node id. */
  entryId: string;
}

export interface ParameterReferences {
  scope: ParameterScope;
  name: string;
  /** False when `scope`'s `parameters:` has no such key. */
  declared: boolean;
  /** Sites this rename/delete will rewrite. */
  interpolations: InterpolationSite[];
  /** Call sites supplying this parameter by name. Always empty for a pipeline parameter -- those are supplied through the API, not in the config. */
  invocations: InvocationSite[];
  /**
   * `<< parameters.name >>` sites found outside the declaring element, which
   * this rename deliberately leaves alone. Empty for a pipeline scope, whose
   * references are global by definition.
   */
  foreign: InterpolationSite[];
  /**
   * Elements (`jobs.x`, `commands.y`, `executors.z`) other than this one that
   * declare a parameter of the same name -- the reason most `foreign` sites are
   * nothing to worry about.
   */
  alsoDeclaredBy: string[];
  /**
   * Reasons a rename cannot be completed and must be refused outright, rather
   * than leaving a reference dangling. Empty in the overwhelmingly common case;
   * see `blockingForeignSites` for the one case that fills it.
   */
  renameBlockers: string[];
}

/** Every element kind that can declare its own `parameters:`, in the order a report should list them. */
const ELEMENT_CONTAINERS = ['jobs', 'commands', 'executors'] as const;

/**
 * Walks every scalar under `node` (a subtree, or the document root), calling
 * `visit` with the scalar's string value and its path.
 *
 * Hand-rolled rather than `yaml`'s own `visit`: this needs a `Path` in the
 * shape `documentUtils` uses (so a caller can hand it straight back to
 * `getNode`), which `visit`'s ancestor array does not give directly, and it
 * needs to *not* follow aliases. Following an alias would report the anchor's
 * bytes once per alias site and then rewrite them once per site, which for a
 * `replace`-based rewrite is harmless but for the count shown in a prompt is a
 * lie.
 */
function walkScalars(
  node: Node | undefined,
  base: Path,
  visit: (text: string, path: Path, inKey: boolean) => void,
): void {
  if (node === undefined || isAlias(node)) return;
  if (isScalar(node)) {
    if (typeof node.value === 'string') visit(node.value, base, false);
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      walkScalars(item as Node, [...base, index], visit);
    });
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = pair.key;
      if (!isScalar(key)) continue;
      const keyValue = key.value;
      // A `<<` merge key's own key node is a Symbol; it has no text to scan and
      // no path segment worth recording (`listKeys` skips it for the same
      // reason).
      if (typeof keyValue === 'symbol') continue;
      const segment = String(keyValue);
      if (typeof keyValue === 'string') {
        visit(keyValue, [...base, segment], true);
      }
      walkScalars(pair.value as Node, [...base, segment], visit);
    }
  }
}

function collectInterpolations(
  doc: Document,
  root: Path,
  expression: string,
): InterpolationSite[] {
  const sites: InterpolationSite[] = [];
  const rootNode =
    root.length === 0 ? (doc.contents as Node | null) : getNode(doc, root);
  walkScalars(rootNode ?? undefined, root, (text, path, inKey) => {
    const occurrences = countReferencesInText(text, expression);
    if (occurrences > 0) sites.push({ path, occurrences, inKey });
  });
  return sites;
}

/** True when `candidate` is `prefix` itself or sits underneath it. */
function isUnder(candidate: Path, prefix: Path): boolean {
  if (candidate.length < prefix.length) return false;
  return prefix.every((segment, i) => candidate[i] === segment);
}

/** Reads one workflow's or group's `jobs:` entries as `{ index, jobName, entryId }`, ignoring anything malformed. */
function readEntryIds(
  doc: Document,
  container: 'workflows' | 'job-groups',
  ownerName: string,
): { index: number; jobName: string; entryId: string }[] {
  const seq = getNode(doc, [container, ownerName, 'jobs']);
  if (!isSeq(seq)) return [];
  const entries: { index: number; jobName: string; entryId: string }[] = [];
  seq.items.forEach((item, index) => {
    if (isScalar(item)) {
      const jobName = String(item.value);
      entries.push({ index, jobName, entryId: jobName });
      return;
    }
    if (!isMap(item) || item.items.length === 0) return;
    // `as Pair` for the same reason `jobReferences.parseWorkflowEntries` does
    // it: the length check above already established the item exists, and
    // `noUncheckedIndexedAccess` cannot see that.
    const pair = item.items[0] as Pair;
    if (!isScalar(pair.key)) return;
    const jobName = String(pair.key.value);
    let entryId = jobName;
    const options = pair.value;
    if (isMap(options)) {
      const namePair = options.items.find(
        (p) => isScalar(p.key) && String(p.key.value) === 'name',
      );
      if (namePair && isScalar(namePair.value)) {
        entryId = String(namePair.value.value);
      }
    }
    entries.push({ index, jobName, entryId });
  });
  return entries;
}

/**
 * Every entry invoking `jobName` that already supplies `paramName` as one of
 * its option keys. A bare-string entry (`- build`) supplies nothing, so it is
 * not a site; an entry that simply does not pass this parameter (relying on its
 * default) is likewise not a site, and must not be given one -- writing the key
 * in would be inventing a value the user never set.
 */
function collectInvocations(
  doc: Document,
  jobName: string,
  paramName: string,
): InvocationSite[] {
  const sites: InvocationSite[] = [];
  const owners: [container: 'workflows' | 'job-groups', names: string[]][] = [
    ['workflows', getWorkflowNames(doc)],
    ['job-groups', getJobGroupNames(doc)],
  ];
  for (const [container, names] of owners) {
    for (const ownerName of names) {
      for (const entry of readEntryIds(doc, container, ownerName)) {
        if (entry.jobName !== jobName) continue;
        const options = getNode(doc, [
          container,
          ownerName,
          'jobs',
          entry.index,
          jobName,
        ]);
        if (!isMap(options)) continue;
        const has = options.items.some(
          (p) => isScalar(p.key) && String(p.key.value) === paramName,
        );
        if (!has) continue;
        sites.push({
          container,
          ownerName,
          index: entry.index,
          entryId: entry.entryId,
        });
      }
    }
  }
  return sites;
}

/** Dotted names of every element whose own `parameters:` declares `name`. */
function elementsDeclaring(doc: Document, name: string): string[] {
  const found: string[] = [];
  for (const container of ELEMENT_CONTAINERS) {
    for (const elementName of listKeys(doc, [container])) {
      if (
        listKeys(doc, [container, elementName, 'parameters']).includes(name)
      ) {
        found.push(`${container}.${elementName}`);
      }
    }
  }
  return found;
}

/**
 * Whether the element at `elementPath` inherits keys from elsewhere -- either
 * its whole value is a YAML alias, or its map contains a `<<` merge key.
 *
 * This is the fact that decides refuse-vs-warn for a foreign site. If the job
 * is entirely self-contained, a `<< parameters.name >>` outside it provably is
 * not this job's reference: nothing in this job's own bytes could have put it
 * there. If the job merges an anchor, part of the job's *effective* body lives
 * in bytes shared with whatever else merges that anchor -- so a foreign site
 * might well be this job's reference, and rewriting it would change every other
 * user of the anchor at the same time (the shadowing hazard `setIn` already
 * refuses). Neither rewriting nor skipping is safe, so we do neither and
 * refuse the rename with the list.
 */
function inheritsFromElsewhere(doc: Document, elementPath: Path): boolean {
  const parentPath = elementPath.slice(0, -1);
  const last = elementPath[elementPath.length - 1];
  const parent = getNode(doc, parentPath);
  if (isMap(parent)) {
    const pair = parent.items.find(
      (p) => isScalar(p.key) && String(p.key.value) === String(last),
    );
    if (pair && isAlias(pair.value)) return true;
  }
  const node = getNode(doc, elementPath);
  if (!isMap(node)) return false;
  return node.items.some(
    (p) => isScalar(p.key) && typeof p.key.value === 'symbol',
  );
}

/**
 * Enumerates every place `name` is referenced, for the given scope. Never
 * throws and never mutates: an undeclared parameter simply comes back with
 * `declared: false` and whatever references happen to name it anyway, which is
 * a real state a config can be in (and one worth showing).
 */
export function findParameterReferences(
  doc: Document,
  scope: ParameterScope,
  name: string,
): ParameterReferences {
  const declared = listKeys(doc, parametersPath(scope)).includes(name);
  const expression = referenceExpression(scope, name);

  if (scope.kind === 'pipeline') {
    return {
      scope,
      name,
      declared,
      // Pipeline references are global: there is no narrower subtree they could
      // be confined to, and no other namespace that spells them the same way.
      interpolations: collectInterpolations(doc, [], expression),
      invocations: [],
      foreign: [],
      alsoDeclaredBy: [],
      renameBlockers: [],
    };
  }

  const elementPath: Path = ['jobs', scope.jobName];
  const all = collectInterpolations(doc, [], expression);
  const interpolations = all.filter((site) => isUnder(site.path, elementPath));
  const foreign = all.filter((site) => !isUnder(site.path, elementPath));
  const owners = elementsDeclaring(doc, name);
  const alsoDeclaredBy = owners.filter(
    (owner) => owner !== `jobs.${scope.jobName}`,
  );

  const renameBlockers =
    foreign.length > 0 && inheritsFromElsewhere(doc, elementPath)
      ? blockingForeignSites(foreign, owners, name)
      : [];

  return {
    scope,
    name,
    declared,
    interpolations,
    invocations: collectInvocations(doc, scope.jobName, name),
    foreign,
    alsoDeclaredBy,
    renameBlockers,
  };
}

/**
 * The subset of `foreign` sites that make a rename unsafe, as prose. A foreign
 * site inside an element that declares the same parameter itself is that
 * element's business and never blocks; anything else, in a job that merges an
 * anchor, might be this job's own reference reached through the merge.
 */
function blockingForeignSites(
  foreign: InterpolationSite[],
  owners: string[],
  name: string,
): string[] {
  const owned = new Set(owners);
  const blocking: string[] = [];
  for (const site of foreign) {
    const owner = `${String(site.path[0])}.${String(site.path[1])}`;
    if (owned.has(owner)) continue;
    blocking.push(
      `${dotted(site.path)} references << parameters.${name} >>, but this job ` +
        `inherits part of its body through a YAML merge key or alias -- so that ` +
        `reference may be this job's, and it may belong to something else that ` +
        `shares the same bytes. Rewriting it could change another job; leaving ` +
        `it would dangle. Inline the merge, or rename the parameter in the YAML pane.`,
    );
  }
  return blocking;
}

/** `['jobs','build','steps',1]` -> `jobs.build.steps.1` -- the same dotted form `findAliasSites` reports. */
function dotted(path: Path): string {
  return path.map((segment) => String(segment)).join('.');
}

/** Total occurrences across sites, which is what a headline counts -- two references in one `run` command are two places a reader has to check, not one. */
function totalOccurrences(sites: InterpolationSite[]): number {
  return sites.reduce((sum, site) => sum + site.occurrences, 0);
}

/**
 * How many distinct places a rename or delete of this parameter touches: the
 * declaration, every interpolation occurrence, and every invocation key.
 */
export function countParameterSites(refs: ParameterReferences): number {
  return (
    (refs.declared ? 1 : 0) +
    totalOccurrences(refs.interpolations) +
    refs.invocations.length
  );
}

/**
 * Whether a rename is worth prompting about. Deliberately narrower than "has
 * any reference at all", for the same reason `renameNeedsConfirmation` is on the
 * job side: a prompt that fires on every rename becomes something to dismiss
 * reflexively.
 *
 * A parameter that is declared and referenced nowhere has nothing to reconcile.
 * Anything else does -- and unlike a job name, a parameter reference is *never*
 * visible from where the rename is typed (it is buried in the text of a shell
 * command or an image tag), so there is no equivalent of the job side's
 * "the only reference is the node you are looking at" exemption.
 */
export function parameterRenameNeedsConfirmation(
  refs: ParameterReferences,
): boolean {
  return (
    refs.interpolations.length > 0 ||
    refs.invocations.length > 0 ||
    refs.foreign.length > 0 ||
    refs.renameBlockers.length > 0
  );
}

function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** `["a"] -> "a"`, `["a","b"] -> "a and b"`, `["a","b","c"] -> "a, b and c"` -- for prose, not for code. */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function scopeLabel(scope: ParameterScope): string {
  return scope.kind === 'pipeline'
    ? 'pipeline parameter'
    : `parameter of job "${scope.jobName}"`;
}

function interpolationLines(
  sites: InterpolationSite[],
  oldExpression: string,
  newExpression: string,
): string[] {
  return sites.map((site) => {
    const where = site.inKey ? ' (in a key)' : '';
    const times =
      site.occurrences > 1 ? ` (${site.occurrences} occurrences)` : '';
    return `${dotted(site.path)}${where}: << ${oldExpression} >> becomes << ${newExpression} >>${times}`;
  });
}

function invocationLines(sites: InvocationSite[], newName: string): string[] {
  return sites.map(
    (site) =>
      `${site.container === 'workflows' ? 'workflow' : 'job group'} "${site.ownerName}": "${site.entryId}" passes this parameter -- that key becomes ${newName}`,
  );
}

/**
 * What renaming `name` to `newName` will change, in the shape
 * `ReferenceImpactList` renders.
 */
export function describeParameterRenameImpact(
  doc: Document,
  scope: ParameterScope,
  name: string,
  newName: string,
): ReferenceImpact {
  const refs = findParameterReferences(doc, scope, name);
  const oldExpression = referenceExpression(scope, name);
  const newExpression = referenceExpression(scope, newName);
  const lines: string[] = [];
  const notes: string[] = [];

  if (refs.declared) {
    lines.push(
      `the declaration: ${dotted(parametersPath(scope))}.${name} becomes ${newName}`,
    );
  }
  lines.push(
    ...interpolationLines(refs.interpolations, oldExpression, newExpression),
  );
  lines.push(...invocationLines(refs.invocations, newName));

  if (refs.alsoDeclaredBy.length > 0) {
    notes.push(
      `${listSentence(refs.alsoDeclaredBy)} ${refs.alsoDeclaredBy.length === 1 ? 'declares' : 'declare'} a parameter also called ${name}. Element parameters are scoped to the element that declares them, so ${refs.alsoDeclaredBy.length === 1 ? 'its' : 'their'} own << parameters.${name} >> references are left exactly as they are.`,
    );
  }

  const unexplainedForeign = refs.foreign.filter(
    (site) =>
      !refs.alsoDeclaredBy.includes(
        `${String(site.path[0])}.${String(site.path[1])}`,
      ),
  );
  if (unexplainedForeign.length > 0 && refs.renameBlockers.length === 0) {
    notes.push(
      `${listSentence(unexplainedForeign.map((site) => dotted(site.path)))} ${unexplainedForeign.length === 1 ? 'writes' : 'write'} << parameters.${name} >> outside this job, where nothing declares it. ${unexplainedForeign.length === 1 ? 'That reference is' : 'Those references are'} already unresolvable, and this rename does not touch ${unexplainedForeign.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (scope.kind === 'pipeline') {
    notes.push(
      'Pipeline parameters are also supplied from outside this file -- API triggers, schedules, and the continuation orb name them as strings. Those callers are not updated by this rename.',
    );
  }

  return {
    headline: `Renaming the ${scopeLabel(scope)} ${name} to ${newName} rewrites ${pluralize(countParameterSites(refs), 'place')}.`,
    lines,
    notes,
    blockers: refs.renameBlockers,
  };
}

/**
 * What removing `name` will change -- and what it deliberately won't. Removing
 * a parameter cannot repair the references to it: substituting each one with the
 * parameter's own default would be authoring, and is exactly the class of guess
 * already refused on the job side. So the references are named, left alone, and
 * the config is allowed to be visibly broken until the user decides what those
 * places should say instead.
 */
export function describeParameterDeleteImpact(
  doc: Document,
  scope: ParameterScope,
  name: string,
): ReferenceImpact {
  const refs = findParameterReferences(doc, scope, name);
  const expression = referenceExpression(scope, name);
  const lines: string[] = [];
  const notes: string[] = [];

  if (refs.declared) {
    lines.push(`the declaration: ${dotted(parametersPath(scope))}.${name}`);
  }
  for (const site of refs.invocations) {
    lines.push(
      `${site.container === 'workflows' ? 'workflow' : 'job group'} "${site.ownerName}": "${site.entryId}" stops passing ${name}`,
    );
  }

  const references = totalOccurrences(refs.interpolations);
  if (refs.interpolations.length > 0) {
    const one = refs.interpolations.length === 1;
    notes.push(
      `${listSentence(refs.interpolations.map((site) => dotted(site.path)))} still ${one ? 'writes' : 'write'} << ${expression} >>, and ${one ? 'it is' : 'they are'} left exactly as ${one ? 'it is' : 'they are'}. Substituting the default there would be writing config you never asked for; the compiler will report ${one ? 'it' : 'them'} instead, which is the honest outcome.`,
    );
  }

  return {
    headline:
      `Removing the ${scopeLabel(scope)} ${name} changes ${pluralize((refs.declared ? 1 : 0) + refs.invocations.length, 'place')}` +
      (references > 0
        ? `, and leaves ${pluralize(references, 'reference')} pointing at nothing.`
        : '.'),
    lines,
    notes,
    // A removal never strands a YAML anchor the way deleting a job can: the
    // node removed is a parameter definition, and `removeParameter` refuses
    // when it is itself an anchor (see `parameterMutations.ts`).
    blockers: [],
  };
}
