/**
 * Surgical-edit helper layer over the `yaml` package's CST/AST.
 *
 * Every function here mutates or reads the `yaml.Document` node graph
 * directly instead of round-tripping through plain JS objects. That
 * distinction is the entire point of this module: converting a config to a
 * JS object and re-serializing it (`doc.toJS()` -> mutate -> `YAML.stringify`)
 * is exactly what destroyed users' comments, key order, and formatting in
 * the predecessor project. Every write here instead finds the precise node
 * to change and mutates it (or splices a sibling list) in place, so
 * everything the parser did not touch is byte-identical on `doc.toString()`.
 *
 * Keep this module pure and framework-free -- no React, no zustand -- so it
 * stays trivial to unit test and safe to reuse from the DAG pane in a later
 * milestone.
 */
import {
  Document,
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
} from 'yaml';
import { toJS, type ToJSContext } from 'yaml/util';

/** A path segment: a map key or a sequence index. */
export type PathSegment = string | number;
/** A path from the document root down to a value, e.g. `['jobs', 'build']`. */
export type Path = readonly PathSegment[];

export interface ParseResult {
  /** The parsed document, or `null` if `text` failed to parse. */
  doc: Document.Parsed | null;
  /** A short, single-line description of the first parse error, if any. */
  error: string | null;
}

/**
 * Parses YAML text into a `Document`. Unlike `parseDocument` alone, this
 * normalizes the (verbose, multi-line, source-snippet-embedded) error
 * message down to one line suitable for an inline status message, and
 * returns `doc: null` on failure so callers can't accidentally treat a
 * partially-composed, error-bearing document as usable.
 *
 * Passes `{ merge: true }` so `<<` merge keys are recognized (issue #35).
 * Without it, `yaml` still parses a merge key as a document -- it composes
 * to a literal `"<<"` entry and every field it was supposed to pull in from
 * the anchor it points at is simply absent from every read, with no error
 * anywhere -- which is exactly the "config a user wrote survives editing"
 * promise breaking silently. Verified empirically (see documentUtils.test.ts
 * and roundtrip.test.ts) that turning this on does not change `toString()`
 * output for any document, merge keys or not: `merge` only affects how
 * `<<` composes into the read-side node graph (giving its Scalar key a
 * `addToJSMap` that expands to the merged sources), not how anything
 * stringifies back out.
 */
export function parseConfig(text: string): ParseResult {
  const doc = parseDocument(text, { merge: true });
  const [firstError] = doc.errors;
  if (firstError) {
    return { doc: null, error: formatParseError(firstError) };
  }
  return { doc, error: null };
}

function formatParseError(error: { message: string }): string {
  // yaml's error messages are prettified with an embedded source snippet
  // and caret, e.g. "Bad indentation ... at line 2, column 1:\n\nfoo: [1\n\n^".
  // The first line already has the "at line X, column Y" location, so we
  // drop everything after it for a compact, single-line status message.
  const firstLine = error.message.split('\n')[0] ?? error.message;
  return firstLine.replace(/:$/, '');
}

/** Deep-clones a document so React/zustand see a new reference. */
export function cloneDocument(doc: Document): Document {
  return doc.clone();
}

/** `path[index]`, but typed as always-present -- callers guarantee `index` is in range. */
function segmentAt(path: Path, index: number): PathSegment {
  const seg = path[index];
  if (seg === undefined) {
    throw new Error(`Path segment at index ${index} is out of bounds`);
  }
  return seg;
}

function keyMatches(key: unknown, seg: PathSegment): boolean {
  if (isScalar(key)) {
    return String(key.value) === String(seg);
  }
  return key === seg;
}

/**
 * True when `key` is a `<<` merge key's own key node. `yaml` (with `merge:
 * true`, see `parseConfig`) resolves a literal `<<` key to a `Scalar`
 * wrapping `Symbol('<<')`, not the string `"<<"` -- so `String(key.value)`
 * (what `keyMatches` compares) never accidentally matches a real field
 * name, and this needs its own check to recognize it at all.
 */
function isMergeKeyNode(key: unknown): boolean {
  if (!isScalar(key)) return false;
  const v: unknown = key.value;
  return v === '<<' || (typeof v === 'symbol' && v.description === '<<');
}

/**
 * Resolves a `<<` pair's value to the ordered list of source maps it merges
 * in, dereferencing aliases against `doc`. Handles both shapes CircleCI
 * configs use: a single alias/map (`<<: *base`) and a sequence of them
 * (`<<: [*a, *b]`). Anything that doesn't resolve to a map (a dangling
 * alias, a scalar, ...) is silently skipped -- a malformed merge source
 * should degrade to "this field isn't inherited from here" rather than
 * throw, consistent with the rest of this read layer.
 */
function collectMergeSources(value: unknown, doc: Document): YAMLMap[] {
  const items = isSeq(value) ? value.items : [value];
  const sources: YAMLMap[] = [];
  for (const item of items) {
    const resolved = isAlias(item) ? item.resolve(doc) : item;
    if (isMap(resolved)) sources.push(resolved);
  }
  return sources;
}

interface EffectivePair {
  pair: Pair;
  /** Anchor name of the merge source `pair` was actually found on, set only when `pair` was not a literal, direct entry of the map originally searched. */
  via?: string;
}

/**
 * Finds the pair for `seg` in `map`, the way CircleCI (and every other YAML
 * 1.1 consumer) actually reads a map: a literal key always wins, and only
 * when there isn't one do the map's `<<` merge sources get consulted, in
 * order (per the YAML merge spec -- confirmed empirically against this
 * exact `yaml` version in documentUtils.test.ts -- a key from an earlier
 * source in a `<<: [*a, *b]` list wins over the same key from a later one).
 * Recurses into each source so a merge source that itself merges another
 * anchor resolves transitively. `seen` guards against a pathological
 * circular `<<` chain looping forever.
 */
function findEffectivePair(
  map: YAMLMap,
  seg: PathSegment,
  doc: Document,
  seen: Set<YAMLMap> = new Set(),
): EffectivePair | undefined {
  if (seen.has(map)) return undefined;
  seen.add(map);

  const direct = map.items.find((p) => keyMatches(p.key, seg));
  if (direct) return { pair: direct };

  const mergePair = map.items.find((p) => isMergeKeyNode(p.key));
  if (!mergePair) return undefined;

  for (const source of collectMergeSources(mergePair.value, doc)) {
    const found = findEffectivePair(source, seg, doc, seen);
    if (found) return { pair: found.pair, via: found.via ?? source.anchor };
  }
  return undefined;
}

/** Where a resolved value's data actually came from -- see `getInWithOrigin`. */
export type ValueOrigin = 'own' | 'merged' | 'absent';

export interface ResolvedValue {
  /** The plain JS value at the path, or `undefined` when `origin` is `'absent'`. */
  value: unknown;
  origin: ValueOrigin;
  /** The anchor name the value was inherited from, when `origin === 'merged'` and it's determinable (the merge source had an anchor at all). */
  via?: string;
}

interface PathResolution {
  node: Node | undefined;
  /**
   * `'merged'` if `node` (when found) -- or, when `node` is `undefined`,
   * whatever the path managed to reach before it stopped resolving -- was
   * reached by crossing a `<<` merge key anywhere along the way. Once a
   * path crosses a merge key everything beneath it is, by definition, not
   * literally written at the location that was asked for, so this only
   * ever escalates from `'own'` to `'merged'`, never back.
   *
   * Deliberately reported even when `node` is `undefined` (unlike the
   * public `ValueOrigin`, which collapses that case to `'absent'`) -- this
   * is what `setIn`'s merge guard uses to also refuse writes *underneath* a
   * merge-inherited container (e.g. a new key inside a `docker:` array that
   * only exists via `<<`), not only writes that exactly overwrite an
   * inherited scalar.
   */
  origin: 'own' | 'merged';
  via?: string;
}

/** Shared path-walking core for `getNode`, `getIn`, `getInWithOrigin`, and `setIn`'s merge guard. */
function resolvePath(doc: Document, path: Path): PathResolution {
  if (path.length === 0) {
    return {
      node: isNode(doc.contents) ? doc.contents : undefined,
      origin: 'own',
    };
  }

  let node: unknown = doc.contents;
  let origin: 'own' | 'merged' = 'own';
  let via: string | undefined;

  for (const seg of path) {
    // `node` is what the *previous* segment resolved to. If it's an alias
    // and there's more path left to walk through it (i.e. we're here at
    // all), dereference it now -- but only now, not at the very end: a
    // path that resolves to an alias as its final value (a whole-value
    // alias like `deploy_prod_canary: *deploy_prod`) must come back as
    // that live `Alias` node, unresolved, for `getNode` callers that mutate
    // by node identity.
    if (isAlias(node)) node = node.resolve(doc);

    if (isMap(node)) {
      const found = findEffectivePair(node, seg, doc);
      if (!found) return { node: undefined, origin, via };
      node = found.pair.value;
      if (found.via !== undefined) {
        origin = 'merged';
        via = found.via;
      }
    } else if (isSeq(node)) {
      const next: unknown =
        typeof seg === 'number' ? node.items[seg] : undefined;
      if (next === undefined) return { node: undefined, origin, via };
      node = next;
    } else {
      return { node: undefined, origin, via };
    }
  }
  return { node: isNode(node) ? node : undefined, origin, via };
}

/**
 * Resolves `path` against `doc` and returns the YAML node at that location
 * (a `Scalar`, `YAMLMap`, `YAMLSeq`, or `Alias`), or `undefined` if any
 * segment doesn't resolve. Unlike `getIn`, this never unwraps or copies --
 * the returned node is the live node in `doc`, so mutating it (e.g. setting
 * `.value` on a returned `Scalar`) edits the document in place.
 *
 * Transparently walks through `<<` merge keys and (when there's more path
 * left to traverse) whole-value aliases, so a path can reach into a field a
 * job only has because it merges in an anchor -- see issue #35. A path that
 * resolves to an alias or a merge-inherited node exactly at its last
 * segment is still returned as that live node (not resolved further),
 * since some callers want to inspect that identity itself.
 */
export function getNode(doc: Document, path: Path): Node | undefined {
  return resolvePath(doc, path).node;
}

/**
 * Finds every `*alias`/`<<: *alias` site elsewhere in the document that
 * references the YAML anchor on the live node currently at `path`, as a
 * human-readable dotted path to each site (its ancestry of map keys, e.g.
 * `"jobs.deploy_prod_canary"`). Returns `[]` when the node at `path` isn't
 * an anchor source at all, or is one but nothing aliases it.
 *
 * This exists because `deleteIn` (and the mutation layer's map-to-scalar
 * collapse) are purely structural: neither has any idea a node they're about
 * to remove might be a `&anchor`'s *source*, so deleting it out from under
 * an alias leaves that alias unresolvable -- and `doc.toString()` then
 * *throws* instead of producing a bad-but-serializable diff, which is worse
 * than any diff quality issue: the store derives `text` from `toString()`,
 * so the document can no longer be saved at all.
 *
 * Lives here rather than in `configMutations.ts` (where it started) because
 * two layers need it: the mutations themselves, to *refuse* a delete that
 * would strand an alias, and the reference enumerator behind the rename/
 * delete confirmation prompts (`~/lib/mutations/jobReferences.ts`), to tell
 * the user *up front* that the delete will be refused and why -- rather than
 * letting them confirm an action that then fails.
 */
export function findAliasSites(doc: Document, path: Path): string[] {
  const target = getNode(doc, path);
  const anchor = target?.anchor;
  if (!anchor) return [];

  const sites: string[] = [];
  visit(doc, {
    Alias(_key, node, ancestry) {
      if (node.source !== anchor) return;
      const label = ancestry
        .filter(isPair)
        .map((pair) => (isScalar(pair.key) ? String(pair.key.value) : '?'))
        .join('.');
      sites.push(label.length > 0 ? label : `*${anchor}`);
    },
  });
  return sites;
}

/**
 * Resolves `path` against `doc` and returns a plain JS value (unwrapped
 * from its node). Correctly resolves values reached only through a `<<`
 * merge key or a whole-value alias (issue #35) -- a scalar leaf still
 * returns its raw `.value` (so e.g. a `!!timestamp` scalar comes back as
 * whatever the schema resolved it to, not a re-stringified copy), while a
 * map/seq/alias is converted through `yaml`'s own `toJS`, given a proper
 * conversion context so nested merges and aliases inside it resolve too
 * (calling `.toJSON()` with no context, which is what this used to do,
 * throws on a nested merge key and silently stubs out a nested alias).
 */
export function getIn(doc: Document, path: Path): unknown {
  const { node } = resolvePath(doc, path);
  if (node === undefined) return undefined;
  return unwrapNode(doc, node);
}

/**
 * Like `getIn`, but reports where the value actually came from -- whether
 * it's written literally at `path`, only present because `path` merges in
 * an anchor via `<<` (in which case `via` names that anchor when
 * determinable), or not present at all. This is what lets a caller (e.g.
 * `resolveExecutor.ts`, or the inspector pane) tell "this job's own
 * `docker:`" apart from "this job's `docker:` only exists because it
 * merges `&base`" -- the distinction the rest of this module was blind to
 * before issue #35, and that a plain `getIn` (by design, for every current
 * caller that doesn't need it) still doesn't surface.
 */
export function getInWithOrigin(doc: Document, path: Path): ResolvedValue {
  const { node, origin, via } = resolvePath(doc, path);
  if (node === undefined) return { value: undefined, origin: 'absent' };
  const value = unwrapNode(doc, node);
  return via !== undefined ? { value, origin, via } : { value, origin };
}

/** Builds a fresh `yaml` conversion context for one `toJS` call -- see `unwrapNode`. */
function makeToJSContext(doc: Document): ToJSContext {
  return {
    anchors: new Map(),
    doc,
    keep: false,
    mapAsMap: false,
    mapKeyWarned: false,
    maxAliasCount: 100,
  };
}

/** Unwraps a live YAML node to a plain JS value, resolving merges/aliases within it. */
function unwrapNode(doc: Document, node: Node): unknown {
  if (isScalar(node)) return node.value;
  return toJS(node, null, makeToJSContext(doc));
}

function isPrimitive(
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
 * Copies comment/spacing metadata from one node to another. Used when a
 * value's node has to be swapped out entirely (e.g. replacing a scalar with
 * a map) so the position it lived at doesn't silently lose its comments.
 *
 * Exported so callers outside this module (e.g. the mutation layer, which
 * has to swap a workflow-job-entry node between its bare-string and
 * single-key-map shapes) can preserve comments across the same kind of
 * node-shape change without duplicating this logic.
 */
export function copyComments(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return;
  if (from.comment != null) to.comment = from.comment;
  if (from.commentBefore != null) to.commentBefore = from.commentBefore;
  if (from.spaceBefore) to.spaceBefore = from.spaceBefore;
}

/**
 * Sets the value at `path`, creating intermediate maps as needed.
 *
 * When the target already exists and both the old and new values are
 * scalars, this mutates the existing `Scalar` node's `.value` in place
 * rather than replacing the node -- that is what keeps the node's own
 * comment, anchor, and style attached and leaves every sibling key, its
 * order, and its comments completely untouched. Only when a container has
 * to change shape (e.g. a scalar becoming a map) is a new node created, and
 * even then any comment on the old node is carried over.
 *
 * Refuses to write anywhere `path` is currently merge-inherited (issue
 * #35): every write below walks straight to `container.items` and appends
 * or mutates a *literal* pair there, with no idea a `<<` even exists --
 * that is exactly correct for a genuinely new field, but for a field that
 * already has a value via `<<` it would silently add a second, job-level
 * pair that shadows the shared anchor instead of changing it. The config
 * would keep compiling (explicit keys win over merge keys), so nothing
 * would ever surface the divergence; repeated across every job sharing
 * that anchor, each one would drift independently. Throwing here -- rather
 * than writing the override anyway -- was chosen over the alternative
 * (writing it, but flagging it in a return value) because this module's
 * only other error-signalling convention is a thrown `Error`, which the
 * store already catches from mutation calls and surfaces to the UI; a
 * caller that actually wants the override has to say so explicitly via
 * `setInOverridingMerge` instead, so every place that creates a shadowing
 * duplicate is visible by name at the call site, not just reachable by
 * accident.
 */
export function setIn(doc: Document, path: Path, value: unknown): void {
  const { origin, via } = resolvePath(doc, path);
  if (origin === 'merged') {
    throw new Error(mergeWriteRefusalMessage(path, via));
  }
  writeLiteral(doc, path, value);
}

/**
 * Deliberately writes `value` at `path` even when it is (wholly or
 * partly, see `resolvePath`'s "escalates, never de-escalates" note)
 * merge-inherited, creating (or overwriting) a literal, job-level pair that
 * shadows whatever `<<` would otherwise have supplied there. This is the
 * one function in this module allowed to create that shadow -- see
 * `setIn`'s refusal for why the ordinary path doesn't -- so a caller that
 * reaches for it is choosing, on purpose, to let this job diverge from the
 * anchor (e.g. after the UI told the user their edit would do exactly that
 * and asked them to confirm), not doing it by accident.
 *
 * Returns whether `path` was in fact merge-inherited immediately before
 * this call (and the anchor it came from, when determinable), so the
 * caller can report what just happened, e.g. "this job now has its own
 * `resource_class`; it no longer follows `&base`".
 */
export function setInOverridingMerge(
  doc: Document,
  path: Path,
  value: unknown,
): { overrode: boolean; via?: string } {
  const { origin, via } = resolvePath(doc, path);
  writeLiteral(doc, path, value);
  return origin === 'merged' ? { overrode: true, via } : { overrode: false };
}

function mergeWriteRefusalMessage(path: Path, via: string | undefined): string {
  const target = path.join('.');
  const anchor = via ? ` (anchor "&${via}")` : '';
  return (
    `Refusing to set "${target}": its current value is inherited through a ` +
    `YAML merge key ("<<")${anchor}, not written literally there. Writing ` +
    `it directly would silently create a job-level field that shadows the ` +
    `shared anchor instead of changing it. Edit the anchor's own definition` +
    `${via ? ` (&${via})` : ''} to change every job that shares it, or call ` +
    `setInOverridingMerge to deliberately give this job its own value.`
  );
}

function writeLiteral(doc: Document, path: Path, value: unknown): void {
  if (path.length === 0) {
    doc.contents = doc.createNode(value);
    return;
  }

  if (!isMap(doc.contents) && !isSeq(doc.contents)) {
    doc.contents = new YAMLMap(doc.schema);
  }

  let container: YAMLMap | YAMLSeq = doc.contents;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = segmentAt(path, i);
    const nextSegIsIndex = typeof path[i + 1] === 'number';
    container = stepOrCreate(container, seg, nextSegIsIndex, doc);
  }

  const lastSeg = segmentAt(path, path.length - 1);
  assignAt(container, lastSeg, value, doc);
}

function stepOrCreate(
  container: YAMLMap | YAMLSeq,
  seg: PathSegment,
  nextSegIsIndex: boolean,
  doc: Document,
): YAMLMap | YAMLSeq {
  const makeChild = (): YAMLMap | YAMLSeq =>
    nextSegIsIndex ? new YAMLSeq(doc.schema) : new YAMLMap(doc.schema);

  if (isSeq(container)) {
    if (typeof seg !== 'number') {
      throw new Error(
        `Expected a numeric path segment for a sequence, got "${String(seg)}"`,
      );
    }
    const existing = container.items[seg];
    if (isMap(existing) || isSeq(existing)) return existing;
    const child = makeChild();
    copyComments(existing, child);
    container.items[seg] = child;
    return child;
  }

  const pair = container.items.find((p) => keyMatches(p.key, seg));
  if (pair) {
    if (isMap(pair.value) || isSeq(pair.value)) return pair.value;
    const child = makeChild();
    copyComments(pair.value, child);
    pair.value = child;
    return child;
  }
  const child = makeChild();
  container.add(new Pair(doc.createNode(String(seg)), child));
  return child;
}

function assignAt(
  container: YAMLMap | YAMLSeq,
  seg: PathSegment,
  value: unknown,
  doc: Document,
): void {
  if (isSeq(container)) {
    if (typeof seg !== 'number') {
      throw new Error(
        `Expected a numeric path segment for a sequence, got "${String(seg)}"`,
      );
    }
    const existing = container.items[seg];
    if (isScalar(existing) && isPrimitive(value)) {
      existing.value = value;
      return;
    }
    const node = doc.createNode(value);
    copyComments(existing, node);
    container.items[seg] = node;
    return;
  }

  const pair = container.items.find((p) => keyMatches(p.key, seg));
  if (pair) {
    const existing = pair.value;
    if (isScalar(existing) && isPrimitive(value)) {
      existing.value = value;
      return;
    }
    const node = doc.createNode(value);
    copyComments(existing, node);
    pair.value = node;
    return;
  }
  container.add(new Pair(doc.createNode(String(seg)), doc.createNode(value)));
}

function isCommentHolder(value: unknown): value is Scalar | YAMLMap | YAMLSeq {
  return isScalar(value) || isMap(value) || isSeq(value);
}

/**
 * A `commentBefore` that ends with a trailing newline (beyond the join
 * between comment lines) means there was a *blank line* between the last
 * comment line and the node itself, e.g.:
 *
 *   # Deploy jobs
 *
 *   deploy:
 *     ...
 *
 * That blank line is how a human distinguishes "this labels the group
 * below" from "this is a note about the very next item". We treat the
 * former as a section header: it must outlive the deletion of the single
 * item it happens to precede.
 */
function isSectionHeader(node: unknown): node is Scalar | YAMLMap | YAMLSeq {
  return (
    isCommentHolder(node) &&
    typeof node.commentBefore === 'string' &&
    node.commentBefore.endsWith('\n')
  );
}

/** Moves a section-header comment from a node being deleted onto its new next sibling. */
function reattachSectionHeader(removed: unknown, next: unknown): void {
  if (!isSectionHeader(removed) || !isCommentHolder(next)) return;
  next.commentBefore = next.commentBefore
    ? `${removed.commentBefore}\n${next.commentBefore}`
    : removed.commentBefore;
  if (removed.spaceBefore && !next.spaceBefore) {
    next.spaceBefore = true;
  }
}

/**
 * Deletes the value at `path`.
 *
 * A comment bound to the deleted node is deleted along with it -- except a
 * section-header comment (see `isSectionHeader`), which is re-attached to
 * whatever becomes the next sibling so a header describing a group of
 * items survives deleting the first item underneath it.
 */
export function deleteIn(doc: Document, path: Path): boolean {
  if (path.length === 0) return false;
  const parentPath = path.slice(0, -1);
  const lastSeg = segmentAt(path, path.length - 1);
  const parent = getNode(doc, parentPath);

  if (isMap(parent)) {
    const idx = parent.items.findIndex((p) => keyMatches(p.key, lastSeg));
    if (idx === -1) return false;
    const [removed] = parent.items.splice(idx, 1);
    const next: Pair | undefined = parent.items[idx];
    reattachSectionHeader(removed?.key, next?.key);
    return true;
  }

  if (isSeq(parent)) {
    if (typeof lastSeg !== 'number') return false;
    if (lastSeg < 0 || lastSeg >= parent.items.length) return false;
    const [removed] = parent.items.splice(lastSeg, 1);
    const next: unknown = parent.items[lastSeg];
    reattachSectionHeader(removed, next);
    return true;
  }

  return false;
}

/**
 * Removes the node at `path` and returns it live, rather than discarding it
 * the way `deleteIn` does -- the same splice mechanics (including
 * `reattachSectionHeader`), but keeping the removed value node instead of a
 * boolean so a caller can re-parent it elsewhere via `setNodeIn` without
 * losing whatever comments, anchors, or block-scalar style it already
 * carries.
 *
 * This is what makes issue #79's duplicate-executor/duplicate-steps
 * extraction a genuine move rather than a delete-and-recreate-from-JS: the
 * latter (`getIn` the value, `deleteIn` the original, `setIn` the JS value
 * at the new location) is what every other "shared" concept in this app is
 * built on, but `setIn`'s final step always wraps its value through
 * `doc.createNode`, which fabricates a brand-new node with no memory of any
 * comment that lived on the original -- exactly the failure mode this
 * module exists to avoid (see the module doc). `takeNode` + `setNodeIn`
 * keep the original node object across the move, so any comment attached to
 * it (a note on a specific step, an inline comment on an image tag, ...)
 * travels with it.
 *
 * Deliberately does not attempt to preserve a comment on the *key* being
 * removed (e.g. `# builds the image\ndocker:`) -- see `setNodeIn`'s own note
 * on why that is the correct behavior here, not a gap.
 */
export function takeNode(doc: Document, path: Path): Node | undefined {
  if (path.length === 0) return undefined;
  const parentPath = path.slice(0, -1);
  const lastSeg = segmentAt(path, path.length - 1);
  const parent = getNode(doc, parentPath);

  if (isMap(parent)) {
    const idx = parent.items.findIndex((p) => keyMatches(p.key, lastSeg));
    if (idx === -1) return undefined;
    const [removed] = parent.items.splice(idx, 1);
    const next: Pair | undefined = parent.items[idx];
    reattachSectionHeader(removed?.key, next?.key);
    return removed && isNode(removed.value) ? removed.value : undefined;
  }

  if (isSeq(parent)) {
    if (typeof lastSeg !== 'number') return undefined;
    if (lastSeg < 0 || lastSeg >= parent.items.length) return undefined;
    const [removed] = parent.items.splice(lastSeg, 1);
    const next: unknown = parent.items[lastSeg];
    reattachSectionHeader(removed, next);
    return isNode(removed) ? removed : undefined;
  }

  return undefined;
}

function assignNodeAt(
  container: YAMLMap | YAMLSeq,
  seg: PathSegment,
  node: Node,
  doc: Document,
): void {
  if (isSeq(container)) {
    if (typeof seg !== 'number') {
      throw new Error(
        `Expected a numeric path segment for a sequence, got "${String(seg)}"`,
      );
    }
    container.items[seg] = node;
    return;
  }

  const pair = container.items.find((p) => keyMatches(p.key, seg));
  if (pair) {
    pair.value = node;
    return;
  }
  container.add(new Pair(doc.createNode(String(seg)), node));
}

/**
 * Sets a *live* node at `path` verbatim -- the `takeNode` counterpart of
 * `setIn`. Unlike `setIn` (which always creates a brand-new node from a
 * plain JS value via `doc.createNode`), this splices `node` itself into
 * place, so any comment, anchor, or block-scalar style already on it is
 * whatever ends up at `path`, unchanged.
 *
 * Intermediate containers are created the same way `setIn` creates them
 * (`stepOrCreate`); only the final assignment differs. Does not call
 * `copyComments` at the destination the way `setIn`'s `assignAt` does when
 * replacing an existing value -- there usually is no pre-existing value at
 * an extraction's destination (a fresh `executors:`/`commands:` entry), and
 * a comment that labelled the *old* key at the source (e.g. `# builds the
 * image` directly above a job's `docker:`) describes a field that no longer
 * exists on that job once this runs (it becomes `executor: <name>`
 * instead), so there is nothing sensible to reattach it to here -- it is
 * dropped, consistent with how `deleteIn` already drops a plain (non
 * section-header) comment on any other key it removes.
 */
export function setNodeIn(doc: Document, path: Path, node: Node): void {
  if (path.length === 0) {
    doc.contents = node;
    return;
  }

  if (!isMap(doc.contents) && !isSeq(doc.contents)) {
    doc.contents = new YAMLMap(doc.schema);
  }

  let container: YAMLMap | YAMLSeq = doc.contents;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = segmentAt(path, i);
    const nextSegIsIndex = typeof path[i + 1] === 'number';
    container = stepOrCreate(container, seg, nextSegIsIndex, doc);
  }

  const lastSeg = segmentAt(path, path.length - 1);
  assignNodeAt(container, lastSeg, node, doc);
}

/**
 * Renames a map key in place: the `Pair`'s position in `items` never
 * changes, and when the key is a plain scalar (the overwhelmingly common
 * case) we mutate its `.value` directly, which keeps any comment attached
 * to that key node. This is deliberately not delete-then-append, which
 * would move the entry to the end of the map and could orphan its comment.
 */
export function renameKey(
  doc: Document,
  path: Path,
  oldKey: string,
  newKey: string,
): boolean {
  const node = getNode(doc, path);
  if (!isMap(node)) return false;
  if (oldKey === newKey) return true;

  const pair = node.items.find((p) => keyMatches(p.key, oldKey));
  if (!pair) return false;
  const collision = node.items.find((p) => keyMatches(p.key, newKey));
  if (collision && collision !== pair) return false;

  if (isScalar(pair.key)) {
    pair.key.value = newKey;
  } else {
    const newKeyNode = doc.createNode(newKey);
    copyComments(pair.key, newKeyNode);
    pair.key = newKeyNode;
  }
  return true;
}

/**
 * Reorders a sequence item from `fromIndex` to `toIndex`. The item's own
 * node (and thus any `comment`/`commentBefore` attached to it) is spliced
 * as one unit, so its comment travels with it to the new position.
 */
export function moveSeqItem(
  doc: Document,
  path: Path,
  fromIndex: number,
  toIndex: number,
): boolean {
  const node = getNode(doc, path);
  if (!isSeq(node)) return false;
  const { items } = node;
  if (fromIndex < 0 || fromIndex >= items.length) return false;
  const clampedTo = Math.max(0, Math.min(toIndex, items.length - 1));
  if (clampedTo === fromIndex) return true;

  const [item] = items.splice(fromIndex, 1);
  items.splice(clampedTo, 0, item);
  return true;
}

/**
 * Returns the live `YAMLSeq` node at `path`, creating an empty one (plus any
 * intermediate maps) if nothing exists there yet.
 *
 * This has to check for an existing sequence *before* falling back to
 * `setIn(doc, path, [])` -- `setIn` on an already-populated sequence would
 * replace it with a fresh empty one and silently discard every item, which
 * is exactly wrong for callers like "append a step to this job" that must
 * not disturb a sequence that already has content.
 */
export function ensureSeq(doc: Document, path: Path): YAMLSeq {
  const existing = getNode(doc, path);
  if (isSeq(existing)) return existing;
  if (existing !== undefined) {
    throw new Error(
      `Expected a sequence at path "${path.join('.')}", found something else`,
    );
  }
  setIn(doc, path, []);
  const created = getNode(doc, path);
  if (!isSeq(created)) {
    throw new Error(`Failed to create a sequence at path "${path.join('.')}"`);
  }
  return created;
}

/**
 * Lists the keys of the map at `path`, in document order. Skips a literal
 * `<<` merge key -- its key is a `Scalar` wrapping `Symbol('<<')` once
 * `merge: true` is on (see `parseConfig`), and `String(Symbol('<<'))` is
 * `"Symbol(<<)"`, which is not a key any caller of this list-of-names
 * helper (job names, executor names, ...) would ever want to see.
 */
export function listKeys(doc: Document, path: Path): string[] {
  const node = getNode(doc, path);
  if (!isMap(node)) return [];
  const keys: string[] = [];
  for (const pair of node.items) {
    if (isScalar(pair.key) && !isMergeKeyNode(pair.key)) {
      keys.push(String(pair.key.value));
    }
  }
  return keys;
}

/** Lists the names of all top-level jobs. */
export function getJobNames(doc: Document): string[] {
  return listKeys(doc, ['jobs']);
}

/**
 * Lists the names of all top-level job groups -- CircleCI's `job-groups` key
 * (issue #220).
 *
 * A job group is a named set of job invocations, with their own internal
 * `requires:`, that a workflow invokes as a single unit exactly the way it
 * invokes a job. That makes this the *second* namespace a workflow entry's
 * name can resolve into, alongside `jobs:` and orb-qualified names -- and
 * before this existed, a workflow entry naming a group was reported as a
 * reference to an undefined job, which is a false error about valid config.
 *
 * Deliberately a sibling of `getJobNames` rather than folded into it: the two
 * are not interchangeable. A group has no `steps:`, no executor and no
 * `jobs.<name>` key, so every caller that wants "somewhere I can add a step"
 * must keep asking `getJobNames`, and only callers resolving a *reference*
 * should consult both.
 */
export function getJobGroupNames(doc: Document): string[] {
  return listKeys(doc, ['job-groups']);
}

/**
 * Lists the job names invoked inside job group `groupName`, in document
 * order.
 *
 * Reads the same two entry shapes a workflow's `jobs:` list accepts (a bare
 * string, or a single-key map carrying `requires:` and friends), because the
 * reference specifies a group's `jobs` as "following the same format as
 * workflow job entries".
 *
 * Returns `undefined`, not `[]`, when `jobs:` is missing or is not a
 * sequence at all -- issue #24's truthfulness rule for the DAG's own "Group"
 * badge. The vendored schema makes `jobs` required with `minItems: 1`, so a
 * *valid* group can never legitimately have zero members: an empty result
 * only ever means this app could not read a membership list from the
 * document, not that the group declares none. `[]` is reserved for exactly
 * that "declares none" case -- reachable today only via this app's own edit
 * path (`deleteJobFromGroups` deliberately leaves `jobs: []` behind rather
 * than deleting the group, so the empty list stays visible and fixable) --
 * and must keep meaning that, or a group a user just emptied by deleting its
 * last member would render identically to one whose `jobs:` this app simply
 * couldn't parse.
 */
export function getJobGroupMembers(
  doc: Document,
  groupName: string,
): string[] | undefined {
  const seq = getNode(doc, ['job-groups', groupName, 'jobs']);
  if (!isSeq(seq)) return undefined;

  const members: string[] = [];
  for (const item of seq.items) {
    if (isScalar(item)) {
      members.push(String(item.value));
      continue;
    }
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    if (isScalar(pair.key)) members.push(String(pair.key.value));
  }
  return members;
}

/**
 * True iff `doc` has a top-level `setup: true` -- CircleCI's own signal
 * (see https://circleci.com/docs/guides/orchestrate/using-dynamic-configuration/)
 * that this config is a *setup* workflow, whose job is normally to hand off
 * to a continuation config it generates. Issue #106 asks for a badge naming
 * this explicitly ("maybe a little badge up at the top where the config
 * is"), since `setup: true` is otherwise an easy-to-miss line in the YAML.
 *
 * Reads via `getIn` (not a raw `doc.get`) so it resolves the same way every
 * other read in this module does -- through a `<<` merge key, if a config
 * genuinely defined `setup` that way (unusual, but not invalid YAML).
 */
export function isSetupConfig(doc: Document): boolean {
  return getIn(doc, ['setup']) === true;
}

/**
 * Lists the names of all workflows. Filters out non-map entries (like a
 * legacy `workflows: version: 2` key) since a real workflow is always a map
 * with at least a `jobs` list.
 */
export function getWorkflowNames(doc: Document): string[] {
  const node = getNode(doc, ['workflows']);
  if (!isMap(node)) return [];
  const names: string[] = [];
  for (const pair of node.items) {
    if (isScalar(pair.key) && isMap(pair.value)) {
      names.push(String(pair.key.value));
    }
  }
  return names;
}

export interface WorkflowJobEntry {
  /** The job name this entry refers to. */
  jobName: string;
  /** Names listed under this entry's `requires`, if any. */
  requires: string[];
  /** This entry's index within the workflow's `jobs` sequence. */
  index: number;
  /** `true` if the entry is a bare job-name string rather than a `{ jobName: {...} }` map. */
  isString: boolean;
}

/**
 * One entry of a `requires:` list. CircleCI accepts two shapes per entry
 * (see issue #26):
 *
 *   - a bare string          `- lint`                       -- wait for success only
 *   - a single-key status map `- lint: [success, failed]`   -- wait for one of the listed statuses
 *
 * The compiler normalizes the map form to a plain dependency on its key --
 * `- lint: [success, failed]` becomes `requires: [lint]` -- so `id` is
 * always the piece that participates in graph topology; `statuses` is
 * display-only metadata about *when* the dependency is satisfied, and never
 * changes which edges exist.
 */
export interface RequireRef {
  /** The required job/alias's id -- what an edge in the graph resolves to. */
  id: string;
  /**
   * Explicit statuses this requirement waits on, or `undefined` for the
   * bare-string form. Deliberately not defaulted to `['success']` so a
   * caller can tell "no status was written" from "the config explicitly
   * wrote just success" -- the two are equivalent at runtime, but only the
   * latter should round-trip back out as a status map.
   */
  statuses?: string[];
  /**
   * Set when this entry used the map form but its value wasn't a plain
   * list of status strings (e.g. a scalar, or a nested map). The id is
   * still trusted -- it's the map's only key, and the compiler only ever
   * looks at that key for topology -- but `statuses` could not be read
   * reliably, so callers should treat this as "malformed, but not fatal"
   * rather than silently dropping the requirement.
   */
  malformedStatuses?: boolean;
}

/**
 * Parses a `requires:` sequence node into a flat list of `{ id, statuses? }`
 * refs, accepting both shapes an entry can take (see `RequireRef`). Used by
 * every reader of `requires:` -- `getWorkflowJobEntries` below,
 * `buildGraph.ts`, and `configMutations.ts` -- so they can't drift apart on
 * what counts as "the id" for a status-conditioned entry.
 *
 * Permissive by design: an item this can't make sense of is simply skipped
 * (never thrown), because a config with a slightly malformed `requires:`
 * entry should still render everything else instead of blanking out.
 */
export function parseRequiresEntries(node: unknown): RequireRef[] {
  if (!isSeq(node)) return [];

  const refs: RequireRef[] = [];
  for (const item of node.items) {
    if (isScalar(item)) {
      refs.push({ id: String(item.value) });
      continue;
    }
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0] as Pair;
    if (!isScalar(pair.key)) continue;
    const id = String(pair.key.value);
    const value = pair.value;

    if (isSeq(value)) {
      let malformedStatuses = false;
      const statuses = value.items.map((status) => {
        if (isScalar(status)) return String(status.value);
        malformedStatuses = true;
        return String(status);
      });
      refs.push({
        id,
        statuses,
        malformedStatuses: malformedStatuses || undefined,
      });
    } else {
      // The map form's value must be a list of statuses; anything else
      // (a bare scalar, a nested map, ...) is malformed. The id is still
      // meaningful -- keep it -- but there is no status list worth trusting.
      refs.push({ id, malformedStatuses: true });
    }
  }
  return refs;
}

/**
 * Reads the `jobs` list of a workflow as a flat list of entries. This is a
 * read model only -- turning it into a graph (resolving `requires` across
 * entries, laying out nodes, etc.) is M2's job, not this module's.
 */
export function getWorkflowJobEntries(
  doc: Document,
  workflowName: string,
): WorkflowJobEntry[] {
  const seq = getNode(doc, ['workflows', workflowName, 'jobs']);
  if (!isSeq(seq)) return [];

  const entries: WorkflowJobEntry[] = [];
  seq.items.forEach((item, index) => {
    if (isScalar(item)) {
      entries.push({
        jobName: String(item.value),
        requires: [],
        index,
        isString: true,
      });
      return;
    }
    if (isMap(item)) {
      const pair = item.items[0] as Pair | undefined;
      const jobName = pair && isScalar(pair.key) ? String(pair.key.value) : '';
      let requires: string[] = [];
      const options = pair?.value;
      if (isMap(options)) {
        const requiresPair = options.items.find((p) =>
          keyMatches(p.key, 'requires'),
        );
        requires = parseRequiresEntries(requiresPair?.value).map(
          (ref) => ref.id,
        );
      }
      entries.push({ jobName, requires, index, isString: false });
    }
  });
  return entries;
}
