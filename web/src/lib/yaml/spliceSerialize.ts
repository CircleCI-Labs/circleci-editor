/**
 * Splice-based re-serialization (issue #81, #39).
 *
 * `Document.toString()` re-emits the *entire* document using `eemeli/yaml`'s
 * own indentation/spacing rules, not each node's original layout. For most of
 * a config that never matters (the rules happen to reproduce the source), but
 * two real-world failure modes were reported against real repos:
 *
 *  1. A single YAML document can legitimately mix stringify conventions at
 *     different nesting depths -- e.g. status-conditioned `requires:` entries
 *     hand-written with no extra indent (`indentSeq: false`-shaped) while
 *     every other sequence in the same file uses the extra-indent convention
 *     (`indentSeq: true`, this library's default). A single global
 *     `toString()` option cannot satisfy both at once, so re-emitting the
 *     whole document necessarily rewrites whichever convention it doesn't
 *     match -- confirmed empirically against the real config that reported
 *     this (see the module's test file and the PR for #81).
 *  2. Blank-line trailing whitespace and extra blank lines at EOF are not
 *     even *retained* on the parsed `Document` -- there is no toString()
 *     option that could preserve them, because the information is discarded
 *     at parse time, not just at stringify time.
 *
 * Both are fixed the same way: don't re-emit content that didn't change.
 * This module walks the *old* (last-saved) and *new* (mutated) document
 * trees in parallel and, for every subtree that is unchanged, splices the
 * verbatim bytes of the old source back in rather than asking `yaml` to
 * regenerate them. Only the subtree that actually changed is freshly
 * rendered. That fixes #81's indentation churn and #39's comment
 * padding/relocation for every *untouched* region, which is precisely the
 * region "minimal diff" is supposed to cover. What remains unfixed:
 * cross-container moves, and the *edited* node's own comment padding.
 *
 * Correctness is protected by a hard safety net (`serializeMinimalDiff`):
 * the spliced text is re-parsed and checked for semantic equivalence with
 * the mutated document before being trusted at all. Any mismatch, or any
 * exception anywhere in the recursive walk, falls back to the old
 * `newDoc.toString()` behavior -- so this can only ever match or improve on
 * the pre-existing diff, never regress a document to invalid or wrong
 * output.
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
  isScalar,
  isSeq,
  parseDocument,
  type Node,
} from 'yaml';
import { diffArrays } from 'diff';

/** A node with a valid `[start, valueEnd, end]` source range. */
type Ranged = Node & { range: [number, number, number] };

function hasRange(node: unknown): node is Ranged {
  return isNode(node) && Array.isArray((node as Node).range);
}

// ---------------------------------------------------------------------------
// Deep structural equality (ignores `range`/`srcToken` -- those describe
// *position in the old source*, which is exactly what we're trying to decide
// whether to keep, not a property of the node's meaning).
// ---------------------------------------------------------------------------

function scalarEqual(a: Scalar, b: Scalar): boolean {
  return (
    a.value === b.value &&
    (a.comment ?? null) === (b.comment ?? null) &&
    (a.commentBefore ?? null) === (b.commentBefore ?? null) &&
    !!a.spaceBefore === !!b.spaceBefore &&
    (a.anchor ?? null) === (b.anchor ?? null) &&
    (a.tag ?? null) === (b.tag ?? null) &&
    a.type === b.type
  );
}

/** True if `a` and `b` are the same value, comments, anchors and shape, all the way down. */
export function nodeDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isScalar(a) && isScalar(b)) return scalarEqual(a, b);
  if (isMap(a) && isMap(b)) {
    if (a.items.length !== b.items.length) return false;
    if ((a.anchor ?? null) !== (b.anchor ?? null)) return false;
    if ((a.tag ?? null) !== (b.tag ?? null)) return false;
    if ((a.comment ?? null) !== (b.comment ?? null)) return false;
    if ((a.commentBefore ?? null) !== (b.commentBefore ?? null)) return false;
    if (!!a.spaceBefore !== !!b.spaceBefore) return false;
    for (let i = 0; i < a.items.length; i++) {
      const pa = a.items[i] as Pair;
      const pb = b.items[i] as Pair;
      if (!keyEqual(pa.key, pb.key)) return false;
      if (!nodeDeepEqual(pa.value, pb.value)) return false;
    }
    return true;
  }
  if (isSeq(a) && isSeq(b)) {
    if (a.items.length !== b.items.length) return false;
    if ((a.anchor ?? null) !== (b.anchor ?? null)) return false;
    if ((a.tag ?? null) !== (b.tag ?? null)) return false;
    if ((a.comment ?? null) !== (b.comment ?? null)) return false;
    if ((a.commentBefore ?? null) !== (b.commentBefore ?? null)) return false;
    if (!!a.spaceBefore !== !!b.spaceBefore) return false;
    for (let i = 0; i < a.items.length; i++) {
      if (!nodeDeepEqual(a.items[i], b.items[i])) return false;
    }
    return true;
  }
  if (isAlias(a) && isAlias(b)) {
    return (
      a.source === b.source &&
      (a.comment ?? null) === (b.comment ?? null) &&
      (a.commentBefore ?? null) === (b.commentBefore ?? null)
    );
  }
  return false;
}

function keyEqual(a: unknown, b: unknown): boolean {
  if (isScalar(a) && isScalar(b)) return scalarEqual(a, b);
  return nodeDeepEqual(a, b);
}

/** String form of a map key, used only for LCS alignment -- never for equality of the pair as a whole. */
function keyString(key: unknown): string {
  if (isScalar(key)) {
    const v: unknown = key.value;
    if (typeof v === 'symbol') return `<<merge:${v.description ?? ''}>>`;
    return String(v);
  }
  return String(key);
}

// ---------------------------------------------------------------------------
// Text-position helpers
// ---------------------------------------------------------------------------

/** 0-based column of `offset` on its line. */
function columnOf(text: string, offset: number): number {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return offset - lineStart;
}

function spaces(n: number): string {
  return ' '.repeat(Math.max(0, n));
}

/** Prepends `indent` to every line of `text` (never to the trailing empty line a `\n`-terminated string splits into). */
function prependIndent(text: string, indent: string): string {
  if (indent === '') return text;
  const lines = text.split('\n');
  return lines
    .map((line, i) =>
      i === lines.length - 1 && line === '' ? line : indent + line,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Fresh rendering -- used only for genuinely new/changed content, never for
// anything already covered by a verbatim splice. Renders `node` in isolation
// via a throwaway wrapper document (so the real stringify engine decides
// inline-vs-block, quoting, comment placement, ...) and re-indents the
// result to `indent`.
// ---------------------------------------------------------------------------

/**
 * Renders a whole fresh "key: value" pair. `key` is spliced in as the real
 * node (not rebuilt from its string form) specifically so any comment or
 * blank-line-before already attached to it -- e.g. a section header that
 * happens to sit above the one pair being fresh-rendered -- survives.
 */
function renderFreshPair(key: Node, value: Node, indent: string): string {
  const tmp = new Document();
  const map = new YAMLMap();
  map.items = [new Pair(key, value)];
  tmp.contents = map;
  return prependIndent(tmp.toString(), indent);
}

function renderFreshItem(value: Node, indent: string): string {
  const tmp = new Document();
  const seq = new YAMLSeq();
  seq.items = [value];
  tmp.contents = seq;
  return prependIndent(tmp.toString(), indent);
}

/** Renders any node (root-level, no key/dash prefix) fresh -- used only when nothing old survives at all. */
function renderFreshRoot(value: Node): string {
  const tmp = new Document();
  tmp.contents = value;
  return tmp.toString();
}

// ---------------------------------------------------------------------------
// Map recursion
// ---------------------------------------------------------------------------

/**
 * Reconstructs the text for every pair of `newMap`, reusing verbatim bytes
 * from `oldText` (via `oldMap`) wherever a pair is untouched, recursing
 * where a pair's value changed but kept the same container kind, and falling
 * back to a fresh render only for the pair(s) that actually differ.
 */
/**
 * Strips one `indent` from `text`'s first line only, leaving every later line
 * alone.
 *
 * The callers of `renderMapChildren`/`renderSeqChildren` splice the old bytes
 * up to the first child's *key*, which is past that line's indentation -- so
 * by the time children are rendered, the first child's indentation has already
 * been emitted. An unchanged first child is spliced verbatim from its key
 * onward and so fits that convention naturally, but a *regenerated* one comes
 * from `renderFreshPair`, which indents every line including the first, and
 * the two indents added up:
 *
 *     jobs:
 *       build:
 *             executor: other      # 8 spaces, was 4
 *         steps:
 *
 * `serializeMinimalDiff`'s safety net then rejected the splice as a structural
 * change and re-emitted the whole document, which is why editing the *first*
 * key of any nested block reflowed every comment in the file while editing the
 * second key of the same block was fine. That asymmetry is what made this look
 * like an unrelated flake rather than one bug.
 */
function dropFirstLineIndent(text: string, indent: string): string {
  if (indent === '' || !text.startsWith(indent)) return text;
  return text.slice(indent.length);
}

function renderMapChildren(
  oldMap: YAMLMap | undefined,
  newMap: YAMLMap,
  oldText: string,
  fallbackIndent: string,
  startCursor?: number,
): string {
  const oldPairs = (oldMap?.items ?? []) as Pair[];
  const newPairs = newMap.items as Pair[];

  const firstOldKey = oldPairs[0]?.key;
  const indent = hasRange(firstOldKey)
    ? spaces(columnOf(oldText, firstOldKey.range[0]))
    : fallbackIndent;

  const oldByKey = new Map<string, Pair>();
  for (const p of oldPairs) oldByKey.set(keyString(p.key), p);

  const oldTokens = oldPairs.map((p, i) => ({ i, key: keyString(p.key) }));
  const newTokens = newPairs.map((p, i) => ({ i, key: keyString(p.key) }));
  const chunks = diffArrays<{ i: number; key: string }>(oldTokens, newTokens, {
    comparator: (a, b) => a.key === b.key,
  });

  let cursor = startCursor ?? (hasRange(oldMap) ? oldMap.range[0] : 0);
  // True when this call begins exactly at the map's own first key, which is
  // precisely when the caller has already emitted that line's indentation.
  // See dropFirstLineIndent for what went wrong without this.
  const indentAlreadyEmitted = startCursor === undefined && hasRange(oldMap);
  const removedOrphans: Pair[] = [];
  const parts: string[] = [];

  for (const chunk of chunks) {
    if (chunk.removed) {
      for (const tok of chunk.value) {
        const oldPair = oldPairs[tok.i];
        if (!oldPair) continue;
        removedOrphans.push(oldPair);
        if (hasRange(oldPair.value)) cursor = oldPair.value.range[2];
      }
      continue;
    }
    if (chunk.added) {
      for (const tok of chunk.value) {
        const newPair = newPairs[tok.i];
        if (!newPair) continue;
        parts.push(renderMapEntry(newPair, oldText, indent, removedOrphans));
      }
      continue;
    }
    // Common-by-key chunk: `chunk.value` holds the *new* tokens (jsdiff's
    // array-diff yields the second array's items for equal runs), but the
    // corresponding old pair is found by key, not by position.
    for (const tok of chunk.value) {
      const newPair = newPairs[tok.i];
      if (!newPair) continue;
      const oldPair = oldByKey.get(tok.key);
      const { text, nextCursor } = renderMapEntryWithCursor(
        oldPair,
        newPair,
        oldText,
        cursor,
        indent,
        removedOrphans,
      );
      parts.push(text);
      cursor = nextCursor;
    }
  }

  const out = parts.join('');
  return indentAlreadyEmitted ? dropFirstLineIndent(out, indent) : out;
}

/** Looks for an unused removed pair whose *value* (not key) matches `value` -- a rename. */
function takeRenamedOrphan(orphans: Pair[], value: unknown): Pair | undefined {
  const idx = orphans.findIndex((o) => nodeDeepEqual(o.value, value));
  if (idx === -1) return undefined;
  const [orphan] = orphans.splice(idx, 1);
  return orphan;
}

/** Renders a pair with no matching old key at this position (an insertion, unless it's a moved/renamed orphan). */
function renderMapEntry(
  newPair: Pair,
  oldText: string,
  indent: string,
  orphans: Pair[],
): string {
  const renamed = takeRenamedOrphan(orphans, newPair.value);
  if (renamed && hasRange(renamed.value)) {
    // Same value, different key/position: reuse the value verbatim, only the
    // key line is regenerated (this app never moves a value across depths
    // via a plain rename, so no reindent is needed here).
    return renderKeyedValue(renamed, newPair, oldText, indent, false);
  }
  return renderFreshPair(newPair.key as Node, newPair.value as Node, indent);
}

function renderMapEntryWithCursor(
  oldPair: Pair | undefined,
  newPair: Pair,
  oldText: string,
  cursor: number,
  indent: string,
  orphans: Pair[],
): { text: string; nextCursor: number } {
  if (!oldPair || !hasRange(oldPair.value)) {
    return {
      text: renderMapEntry(newPair, oldText, indent, orphans),
      nextCursor: cursor,
    };
  }

  const keyChanged = !keyEqual(oldPair.key, newPair.key);
  const valueEqual = nodeDeepEqual(oldPair.value, newPair.value);

  if (!keyChanged && valueEqual) {
    // Fully unchanged: reuse everything verbatim, including whatever comment
    // and blank-line padding preceded this pair -- the #39 fix for anything
    // the user didn't touch.
    return {
      text: oldText.slice(cursor, oldPair.value.range[2]),
      nextCursor: oldPair.value.range[2],
    };
  }

  if (valueEqual) {
    // Only the key text/comment changed (e.g. renameKey, or a section-header
    // comment reattached onto this pair after a sibling was deleted): keep
    // the value's bytes verbatim, regenerate the gap/comment/key line from
    // the *new* key's own properties -- `cursor`'s old gap is not reused
    // here, since it may hold a now-stale comment (e.g. one just reattached
    // away from this pair) or duplicate one `renderKeyedValue` re-emits.
    return {
      text: renderKeyedValue(oldPair, newPair, oldText, indent, false),
      nextCursor: oldPair.value.range[2],
    };
  }

  const bothMaps = isMap(oldPair.value) && isMap(newPair.value);
  const bothSeqs = isSeq(oldPair.value) && isSeq(newPair.value);
  if (
    (bothMaps || bothSeqs) &&
    !containerHeaderChanged(oldPair.value, newPair.value)
  ) {
    // Same container kind, and the value's own leading comment/blank-line is
    // unchanged: keep the "<comment><key>: " prefix and separator verbatim
    // (regenerating just the key text itself if it changed), recurse into
    // just the children.
    const valueRange = (oldPair.value as Ranged).range;
    const childFallbackIndent = indent + '  ';
    const children = bothMaps
      ? renderMapChildren(
          oldPair.value as YAMLMap,
          newPair.value as YAMLMap,
          oldText,
          childFallbackIndent,
        )
      : renderSeqChildren(
          oldPair.value as YAMLSeq,
          newPair.value as YAMLSeq,
          oldText,
          childFallbackIndent,
        );
    const prefix = keyChanged
      ? oldText.slice(cursor, keyLineStart(oldPair, oldText)) +
        keyAndSeparator(oldPair, newPair, oldText, indent)
      : oldText.slice(cursor, valueRange[0]);
    return { text: prefix + children, nextCursor: valueRange[2] };
  }

  // Value changed kind, or is a leaf scalar with a new value: fresh-render
  // the whole pair. Every *other* pair is untouched, so this is still only a
  // single-pair diff, matching what a targeted edit should look like.
  //
  // A scalar whose trailing comment was column-aligned is handled first, so
  // that editing the value does not collapse the alignment of its own line --
  // the one region the splice-by-subtree approach cannot protect by leaving
  // bytes alone, because those bytes are exactly what changed.
  const alignedScalar = renderScalarPairKeepingCommentColumn(
    oldPair,
    newPair,
    oldText,
    indent,
  );
  if (alignedScalar !== undefined) {
    return { text: alignedScalar, nextCursor: oldPair.value.range[2] };
  }

  return {
    text: renderFreshPair(newPair.key as Node, newPair.value as Node, indent),
    nextCursor: oldPair.value.range[2],
  };
}

/** True if a container value's own commentBefore/spaceBefore changed (rare: a comment directly above a nested block). */
function containerHeaderChanged(oldValue: unknown, newValue: unknown): boolean {
  if (!isNode(oldValue) || !isNode(newValue)) return false;
  return (
    (oldValue.commentBefore ?? null) !== (newValue.commentBefore ?? null) ||
    !!oldValue.spaceBefore !== !!newValue.spaceBefore
  );
}

/**
 * Offset where this pair's own leading gap (blank line/comment) stops and its
 * key line begins -- including that line's own indentation.
 *
 * Including the indentation is the whole point. The caller splices
 * `oldText.slice(cursor, keyLineStart(...))` verbatim and then asks
 * `keyAndSeparator` to regenerate the key line *with* `indent`. Returning the
 * key's own offset instead meant the verbatim slice already carried the line's
 * leading spaces and `indent` added them a second time, so a renamed key came
 * out at twice its proper indentation:
 *
 *     jobs:
 *         compile:            # was at 2 spaces, emitted at 4
 *         docker:             # now a sibling of `compile`, not its child
 *
 * That is a structural change, not a cosmetic one, so `serializeMinimalDiff`'s
 * safety net rejected the whole splice and fell back to re-emitting the entire
 * document -- which is how renaming one job silently reflowed every comment in
 * the file. The bug was invisible from the outside precisely because the
 * safety net was doing its job.
 *
 * The walk back covers spaces and tabs only, and only when it reaches the
 * start of a line. A key preceded by anything else on its line -- `- ` for a
 * map inside a sequence item, or a flow mapping -- returns the key's own
 * offset unchanged, so those keep splicing exactly as before rather than
 * losing the `- ` to a slice that stopped short of it.
 */
function keyLineStart(pair: Pair, oldText: string): number {
  const key = pair.key;
  const at = hasRange(key)
    ? key.range[0]
    : hasRange(pair.value)
      ? pair.value.range[0]
      : oldText.length;

  let i = at;
  while (i > 0 && (oldText[i - 1] === ' ' || oldText[i - 1] === '\t')) i--;
  return i === 0 || oldText[i - 1] === '\n' ? i : at;
}

/**
 * Column of the `#` of a trailing comment sitting on the same line as
 * `pair`'s scalar value, or undefined if there is no such comment.
 *
 * Only whitespace may separate the value from the `#`: anything else means the
 * `#` is part of the value rather than a comment introducer, and mistaking one
 * for the other would move text the user wrote into a comment.
 *
 * A *single* space does not count. One space is ordinary spacing, not an
 * alignment the user chose, so holding the `#` at that exact column when the
 * value gets shorter would insert padding they never wrote -- which is the
 * same class of unasked-for change this whole module exists to avoid, just in
 * the opposite direction. Two or more spaces is the signal that the column was
 * deliberate. An existing orb-version-bump test caught this: bumping
 * `circleci/slack@99.99.99` to `@4.13.3` is two characters shorter, and column
 * preservation turned `value # bump me` into `value   # bump me`.
 */
function trailingCommentColumn(
  pair: Pair,
  oldText: string,
): { column: number; from: number } | undefined {
  if (!hasRange(pair.value)) return undefined;
  const valueEnd = pair.value.range[1];
  const newline = oldText.indexOf('\n', valueEnd);
  const lineEnd = newline === -1 ? oldText.length : newline;
  const rest = oldText.slice(valueEnd, lineEnd);
  const hash = rest.indexOf('#');
  if (hash === -1) return undefined;
  const gap = rest.slice(0, hash);
  if (!/^[ \t]{2,}$/.test(gap)) return undefined;
  return { column: columnOf(oldText, valueEnd + hash), from: valueEnd + hash };
}

/**
 * Re-renders a pair whose scalar value changed, keeping a trailing comment at
 * the column it was written at.
 *
 * A house style that column-aligns trailing comments is common in CI configs,
 * and `renderFreshPair` cannot preserve it: `yaml`'s stringify emits exactly
 * one space before a comment, so editing one value collapsed the alignment of
 * that line and made the save diff show a change the user did not ask for.
 *
 * The comment's *column* is preserved rather than the original run of spaces,
 * because the point of the style is the column -- reusing the old padding
 * verbatim would shift the comment by however much the value's length changed
 * and break the very alignment being protected. When the new value is long
 * enough to reach or pass the old column there is no alignment left to keep,
 * so it falls back to a single space, which is what any formatter would do.
 *
 * Returns undefined when this does not apply, and the caller fresh-renders as
 * before.
 */
function renderScalarPairKeepingCommentColumn(
  oldPair: Pair,
  newPair: Pair,
  oldText: string,
  indent: string,
): string | undefined {
  if (!isScalar(oldPair.value) || !isScalar(newPair.value)) return undefined;
  if (!hasRange(oldPair.value)) return undefined;
  // A changed comment is the user's own edit; only carry an unchanged one.
  if ((oldPair.value.comment ?? null) !== (newPair.value.comment ?? null))
    return undefined;
  if (!keyEqual(oldPair.key, newPair.key)) return undefined;

  const aligned = trailingCommentColumn(oldPair, oldText);
  if (!aligned) return undefined;

  const colonEnd = hasRange(oldPair.key)
    ? oldPair.key.range[1] + 1
    : oldPair.value.range[0];
  const sep = oldText.slice(colonEnd, oldPair.value.range[0]);
  // Anything other than same-line spacing (a newline-and-indent separator)
  // means the comment is not trailing this line in the first place.
  if (!/^[ \t]*$/.test(sep)) return undefined;

  const rendered = renderFreshValueOnly(newPair.value);
  if (rendered === undefined) return undefined;

  const head = `${indent}${keyString(newPair.key)}:${sep}${rendered}`;
  const pad =
    aligned.column > head.length ? spaces(aligned.column - head.length) : ' ';
  return head + pad + oldText.slice(aligned.from, oldPair.value.range[2]);
}

/**
 * Renders just a scalar's own text, with its comment suppressed so the caller
 * can place the comment itself. Returns undefined if the scalar would not
 * render on a single line (a block scalar, or one carrying its own leading
 * comment), where a trailing-comment column is not a meaningful thing to
 * preserve.
 */
function renderFreshValueOnly(value: Scalar): string | undefined {
  const clone = new Scalar(value.value);
  clone.type = value.type;
  const tmp = new Document(clone);
  const text = tmp.toString().replace(/\n$/, '');
  return text.includes('\n') ? undefined : text;
}

/**
 * Renders "<key>:" followed by whatever separator (a single space, or a
 * newline-and-indent) originally sat between `oldPair`'s colon and its
 * value -- reused verbatim because the value's *kind* (scalar vs. block
 * collection) is unchanged here, so the separator that already suited it
 * is still correct, regardless of whether the key text itself changed.
 */
function keyAndSeparator(
  oldPair: Pair,
  newPair: Pair,
  oldText: string,
  indent: string,
): string {
  const oldKey = oldPair.key;
  const colonEnd = hasRange(oldKey)
    ? oldKey.range[1] + 1
    : hasRange(oldPair.value)
      ? oldPair.value.range[0]
      : 0;
  const sep = hasRange(oldPair.value)
    ? oldText.slice(colonEnd, oldPair.value.range[0])
    : ' ';
  return `${indent}${keyString(newPair.key)}:${sep}`;
}

/**
 * Renders "<comment before key><key>: <value>" for a pair whose value is
 * being kept verbatim (from `oldPair`) but whose key text/comment may have
 * changed. When `wholePairIsFresh` the value itself is *not* reused (the
 * caller is asking for a from-scratch render, e.g. a renamed-and-moved
 * orphan) so this falls through to `renderFreshPair`.
 */
function renderKeyedValue(
  oldPair: Pair,
  newPair: Pair,
  oldText: string,
  indent: string,
  wholePairIsFresh: boolean,
): string {
  if (wholePairIsFresh || !hasRange(oldPair.value)) {
    return renderFreshPair(newPair.key as Node, newPair.value as Node, indent);
  }
  const newKey = newPair.key;
  const spaceBefore = isNode(newKey) ? !!newKey.spaceBefore : false;
  const commentBefore = isNode(newKey) ? newKey.commentBefore : null;
  let head = '';
  if (spaceBefore) head += '\n';
  if (commentBefore) {
    for (const line of commentBefore.split('\n')) {
      head += `${indent}#${line}\n`;
    }
  }
  head += keyAndSeparator(oldPair, newPair, oldText, indent);
  return head + oldText.slice(oldPair.value.range[0], oldPair.value.range[2]);
}

// ---------------------------------------------------------------------------
// Sequence recursion
// ---------------------------------------------------------------------------

function itemRange(item: unknown): [number, number, number] | undefined {
  return hasRange(item) ? item.range : undefined;
}

function renderSeqChildren(
  oldSeq: YAMLSeq | undefined,
  newSeq: YAMLSeq,
  oldText: string,
  fallbackIndent: string,
  startCursor?: number,
): string {
  const oldItems = (oldSeq?.items ?? []) as Node[];
  const newItems = newSeq.items as Node[];

  const firstOldRange = itemRange(oldItems[0]);
  // The dash sits 2 columns to the left of the item's own content start in
  // the overwhelmingly common "- " convention; used only to place freshly
  // rendered siblings, so an unusual dash spacing here costs at most cosmetic
  // alignment on a newly inserted item, never a correctness issue.
  const indent = firstOldRange
    ? spaces(Math.max(0, columnOf(oldText, firstOldRange[0]) - 2))
    : fallbackIndent;

  const chunks = diffArrays<Node>(oldItems, newItems, {
    comparator: nodeDeepEqual,
  });

  let cursor = startCursor ?? (hasRange(oldSeq) ? oldSeq.range[0] : 0);
  const removedOrphans: { node: Node; range: [number, number, number] }[] = [];
  const parts: string[] = [];
  let oldPtr = 0;

  for (const chunk of chunks) {
    if (chunk.removed) {
      for (const node of chunk.value) {
        const r = itemRange(node);
        if (r) {
          removedOrphans.push({ node, range: r });
          cursor = r[2];
        }
        oldPtr++;
      }
      continue;
    }
    if (chunk.added) {
      for (const node of chunk.value) {
        const orphanIdx = removedOrphans.findIndex((o) =>
          nodeDeepEqual(o.node, node),
        );
        const [orphan] =
          orphanIdx !== -1 ? removedOrphans.splice(orphanIdx, 1) : [];
        if (orphan) {
          // Same depth (same seq), so the orphan's own bytes are still valid
          // verbatim -- this is what makes a plain reorder (moveSeqItem) a
          // pure move rather than a delete+insert.
          parts.push(oldText.slice(orphan.range[0], orphan.range[2]));
        } else if (isNode(node)) {
          parts.push(renderFreshItem(node, indent));
        }
      }
      continue;
    }
    // Common chunk: same node (by deep equality) in both -- reuse verbatim.
    for (const node of chunk.value) {
      const r = itemRange(oldItems[oldPtr]);
      if (r) {
        parts.push(oldText.slice(cursor, r[2]));
        cursor = r[2];
      } else if (isNode(node)) {
        parts.push(renderFreshItem(node, indent));
      }
      oldPtr++;
    }
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/**
 * Reconstructs the text for `newDoc.contents` reusing `oldText` (via
 * `oldDoc`, whose ranges must correspond to `oldText`) wherever nothing
 * changed. Throws on anything it doesn't know how to handle (multi-document
 * streams, flow-only documents with no ranges, etc.) so the caller's fallback
 * takes over -- this function is never the last line of defense on its own.
 */
function spliceBody(
  oldText: string,
  oldDoc: Document,
  newDoc: Document,
): string {
  const oldRoot = oldDoc.contents;
  const newRoot = newDoc.contents;
  if (!isNode(newRoot)) return renderFreshRoot(newRoot as unknown as Node);
  if (!isNode(oldRoot) || nodeDeepEqual(oldRoot, newRoot)) {
    if (
      isNode(oldRoot) &&
      nodeDeepEqual(oldRoot, newRoot) &&
      hasRange(oldRoot)
    ) {
      return oldText.slice(0, oldRoot.range[2]);
    }
    return renderFreshRoot(newRoot);
  }

  // `startCursor: 0`, not the root node's own `range[0]`, is load-bearing.
  // A leading file-level comment (`# This config builds ...` at the very top
  // of practically every real config, and of every fixture in this repo) is
  // parsed onto the *first pair's key* as its `commentBefore`, and sits in
  // the bytes *before* the root map's range starts. Every nested container
  // gets those leading bytes for free -- its parent pair contributes them as
  // the gap between its colon and the child's range -- but the root has no
  // parent, so starting at `oldRoot.range[0]` silently dropped them from the
  // splice. The spliced text then failed the `semanticallyEquivalent` safety
  // net (the first key's `commentBefore` was missing), so *every* mutation on
  // *every* commented config fell back to whole-document `toString()` -- i.e.
  // this entire module was inert for exactly the configs it exists to
  // protect. Verified by the leading-comment tests in this module's own spec
  // and by `configMutations.test.ts`'s rename/delete comment assertions,
  // which failed on the relocated comment before this line changed.
  if (isMap(oldRoot) && isMap(newRoot)) {
    return renderMapChildren(oldRoot, newRoot, oldText, '', 0);
  }
  if (isSeq(oldRoot) && isSeq(newRoot)) {
    return renderSeqChildren(oldRoot, newRoot, oldText, '', 0);
  }
  return renderFreshRoot(newRoot);
}

/**
 * The document's own trailing region -- blank lines, trailing whitespace,
 * an end-of-stream comment -- lives after the last top-level node's range
 * and is never part of any node's content. It is preserved verbatim
 * unconditionally, which is what fixes the "five trailing blank lines
 * removed" half of #81: that region was never examined by anything above,
 * so there's nothing there to trigger a fresh render.
 */
function trailingRegion(oldText: string, oldDoc: Document): string {
  const root = oldDoc.contents;
  if (!hasRange(root)) return '';
  return oldText.slice(root.range[2]);
}

/** Best-effort deep-equality check between two freshly parsed documents' contents, ignoring source position. */
function semanticallyEquivalent(a: unknown, b: unknown): boolean {
  return nodeDeepEqual(a, b);
}

/**
 * Produces text for `newDoc` that reuses as much of `oldText` verbatim as
 * possible, falling back to `newDoc.toString(options)` -- today's behavior
 * -- if the splice attempt throws or, once reparsed, doesn't mean the same
 * thing as `newDoc`. That fallback is the safety net that makes this an
 * unconditional improvement rather than a new correctness risk: the worst
 * case is identical to what shipped before this module existed.
 */
export function serializeMinimalDiff(
  oldText: string,
  oldDoc: Document,
  newDoc: Document,
  options?: Parameters<Document['toString']>[0],
): string {
  const naive = () => newDoc.toString(options);
  try {
    const body = spliceBody(oldText, oldDoc, newDoc);
    const spliced = body + trailingRegion(oldText, oldDoc);

    const reparsed = parseDocument(spliced, { merge: true });
    if (reparsed.errors.length > 0) return naive();
    if (!semanticallyEquivalent(reparsed.contents, newDoc.contents))
      return naive();

    return spliced;
  } catch {
    return naive();
  }
}
