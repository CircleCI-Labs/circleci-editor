/**
 * Figures out *what* is being typed at a cursor position in a YAML
 * document -- which map (or, forced into map shape, which sequence item --
 * see below) contains it, whether it's a fresh key or an existing key's
 * value, and the prefix typed so far -- by asking the real `yaml` parser,
 * never by pattern-matching the surrounding text with regular expressions.
 *
 * The one line the cursor is actually on almost never parses as valid YAML
 * on its own while it's mid-typed (`"  re"` with no colon yet, or
 * `"resource_class: med"` with an incomplete value): `yaml`'s composer
 * would either error out or, worse, silently misinterpret it as a
 * continuation of the previous line's scalar. So rather than parsing the
 * literal buffer, `resolveCursorContext` rewrites *only the current line*
 * into a syntactically complete `key: null` pair -- preserving its
 * indentation and any sequence "- " marker exactly, and either keeping its
 * already-typed key (if the cursor is after that key's colon: it's a
 * *value* being completed) or replacing everything from the first
 * non-indentation character onward with a placeholder key (if not: a *key*
 * is being completed) -- then parses *that*, and walks its real node tree
 * (via every node's `.range`) to find exactly which map now holds the
 * resulting pair.
 *
 * This deliberately treats a sequence item that's just becoming a bare
 * scalar (e.g. typing `checkout` under `steps:`) as if it were a
 * single-key map instead. That's not what the final document will
 * actually be if the user stops here, but it doesn't need to be: forcing
 * map shape still correctly identifies which sequence and index the cursor
 * is inside (the map's own path is identical either way -- `[...,
 * 'steps', 0]` -- since YAML block-sequence items share the same
 * indentation column whether they're a scalar or the first key of a map),
 * and the two possible interpretations ("propose a bare step name" vs
 * "propose a step name to follow with a colon") are handled by the
 * completion source recognizing the same path in both cases, not by this
 * module having to disambiguate them up front.
 */
import {
  Scalar,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
} from 'yaml';

/** A path segment: a map key or a sequence index, root-relative. */
export type PathSegment = string | number;

export interface CursorContext {
  /**
   * Path from the document root down to the map that directly holds the
   * pair being edited (not including that pair's own key). `[]` at the
   * document root, `['jobs', 'build']` inside a job body,
   * `['workflows', 'test', 'jobs', 0]` inside a (possibly bare-scalar)
   * workflow job entry, `['jobs', 'build', 'steps', 2]` inside a
   * (possibly bare-scalar) step.
   */
  containerPath: PathSegment[];
  /** `'value'` when the cursor is after an already-written key's `:`; `'key'` otherwise. */
  slot: 'key' | 'value';
  /** The key whose value is being completed. Only set when `slot === 'value'`. */
  key?: string;
  /** Buffer offset where a completion should start replacing text (the first character of `prefix`). */
  from: number;
  /** The text already typed for the key or value being completed, i.e. `text.slice(from, pos)`. */
  prefix: string;
}

/** A synthetic key substituted in for whatever (partial) key text the user has actually typed, so the rewritten line always parses as a complete pair. Chosen to be a valid bare YAML scalar with no chance of colliding with a real CircleCI key. */
const PLACEHOLDER_KEY = '__vce_key__';

function lineBounds(
  text: string,
  pos: number,
): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const nextNewline = text.indexOf('\n', pos);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return { lineStart, lineEnd };
}

/** Where this line's content starts: past its leading spaces, and past a `"- "` sequence marker immediately after them, if any. */
function findKeyStart(
  text: string,
  lineStart: number,
  lineEnd: number,
): number {
  let i = lineStart;
  while (i < lineEnd && text[i] === ' ') i++;

  const isDashMarker =
    text[i] === '-' && (i + 1 >= lineEnd || text[i + 1] === ' ');
  if (!isDashMarker) return i;

  let j = i + 1;
  while (j < lineEnd && text[j] === ' ') j++;
  return j;
}

interface LineAnalysis {
  /** Offset of the pair-separating `:`, or -1 if this line has none (outside any comment/bracket). */
  colonIdx: number;
  /** Flow-collection (`{}`/`[]`) bracket nesting depth at `pos`; completion is suppressed when this is nonzero -- see the module doc comment's scope note. */
  bracketDepthAtPos: number;
  /** Offset where a `#` comment begins on this line, or -1. */
  commentIdx: number;
}

/** Single left-to-right scan of one line answering everything `resolveCursorContext` needs to know about it, without ever constructing a `RegExp`. */
function analyzeLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  pos: number,
  keyStart: number,
): LineAnalysis {
  let bracketDepth = 0;
  let colonIdx = -1;
  let commentIdx = -1;
  let bracketDepthAtPos = 0;
  let capturedAtPos = false;

  for (let i = lineStart; i < lineEnd; i++) {
    if (i === pos) {
      bracketDepthAtPos = bracketDepth;
      capturedAtPos = true;
    }
    if (commentIdx !== -1) continue;

    const ch = text[i];
    if (ch === '{' || ch === '[') {
      bracketDepth++;
    } else if (ch === '}' || ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (
      ch === '#' &&
      bracketDepth === 0 &&
      i >= keyStart &&
      (i === lineStart || text[i - 1] === ' ')
    ) {
      commentIdx = i;
    } else if (
      ch === ':' &&
      bracketDepth === 0 &&
      colonIdx === -1 &&
      i >= keyStart
    ) {
      const next = text[i + 1];
      if (i + 1 >= lineEnd || next === ' ') colonIdx = i;
    }
  }
  if (!capturedAtPos && pos === lineEnd) bracketDepthAtPos = bracketDepth;

  return { colonIdx, bracketDepthAtPos, commentIdx };
}

function rangeContains(node: Node, offset: number): boolean {
  const range = node.range;
  return range != null && offset >= range[0] && offset < range[2];
}

/**
 * Walks `doc`'s real node tree looking for the map pair whose *key* starts
 * exactly at `anchorOffset` -- the position `resolveCursorContext` spliced
 * either the placeholder key or the user's own already-typed key into. On
 * success, returns the path from the root down to (but not including) that
 * pair's own key -- i.e. the path to its containing map.
 */
function locateContainerPath(
  doc: Document,
  anchorOffset: number,
): PathSegment[] | null {
  function search(node: unknown, path: PathSegment[]): PathSegment[] | null {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (
          isNode(pair.key) &&
          pair.key.range != null &&
          pair.key.range[0] === anchorOffset
        ) {
          return path;
        }
      }
      for (const pair of node.items) {
        if (
          isNode(pair.value) &&
          rangeContains(pair.value, anchorOffset) &&
          isScalar(pair.key)
        ) {
          const found = search(pair.value, [...path, String(pair.key.value)]);
          if (found) return found;
        }
      }
      return null;
    }
    if (isSeq(node)) {
      for (let index = 0; index < node.items.length; index++) {
        const item: unknown = node.items[index];
        if (isNode(item) && rangeContains(item, anchorOffset)) {
          const found = search(item, [...path, index]);
          if (found) return found;
        }
      }
      return null;
    }
    return null;
  }

  return search(doc.contents, []);
}

/**
 * True when `pos` falls inside a quoted (`'...'`/`"..."`) or block
 * (`|`/`>`) scalar anywhere in `doc` -- i.e. inside string content, not
 * YAML structure -- so callers can refuse to complete there. Takes an
 * already-parsed `Document` (rather than parsing `text` itself) so a
 * caller that needs that same parse for other purposes (e.g. this
 * document's job names) doesn't pay for it twice.
 */
export function isInsideOpaqueScalar(doc: Document, pos: number): boolean {
  const OPAQUE_TYPES: ReadonlySet<string> = new Set([
    Scalar.QUOTE_SINGLE,
    Scalar.QUOTE_DOUBLE,
    Scalar.BLOCK_LITERAL,
    Scalar.BLOCK_FOLDED,
  ]);

  function check(node: unknown): boolean {
    if (isScalar(node)) {
      if (!rangeContains(node, pos)) return false;
      return typeof node.type === 'string' && OPAQUE_TYPES.has(node.type);
    }
    if (isMap(node)) {
      return node.items.some((pair) => check(pair.key) || check(pair.value));
    }
    if (isSeq(node)) {
      return node.items.some((item) => check(item));
    }
    return false;
  }

  return check(doc.contents);
}

/**
 * Resolves what's being typed at `pos` in `text` -- see the module doc
 * comment for the line-rewriting approach. Returns `null` whenever the
 * position can't be confidently resolved (the rewritten line still doesn't
 * parse, the cursor is inside a flow `{}`/`[]` collection, or on a comment)
 * rather than guessing -- consistent with this feature's "under-report
 * rather than mislead" mandate. Does *not* check for quoted/block scalars;
 * callers should consult `isInsideOpaqueScalar` against their own parse of
 * the unmodified document first.
 */
export function resolveCursorContext(
  text: string,
  pos: number,
): CursorContext | null {
  const { lineStart, lineEnd } = lineBounds(text, pos);
  const keyStart = findKeyStart(text, lineStart, lineEnd);
  if (pos < keyStart) return null;

  const { colonIdx, bracketDepthAtPos, commentIdx } = analyzeLine(
    text,
    lineStart,
    lineEnd,
    pos,
    keyStart,
  );
  if (bracketDepthAtPos > 0) return null;
  if (commentIdx !== -1 && pos >= commentIdx) return null;

  const isValueSlot = colonIdx !== -1 && colonIdx < pos;

  let workingText: string;
  let anchorOffset: number;
  let from: number;
  let key: string | undefined;

  if (isValueSlot) {
    key = text.slice(keyStart, colonIdx).trim();
    let valueStart = colonIdx + 1;
    while (text[valueStart] === ' ') valueStart++;
    from = valueStart;
    anchorOffset = keyStart;
    workingText = text.slice(0, colonIdx + 1) + ' null' + text.slice(lineEnd);
  } else {
    from = keyStart;
    anchorOffset = keyStart;
    workingText =
      text.slice(0, keyStart) +
      PLACEHOLDER_KEY +
      ': null' +
      text.slice(lineEnd);
  }

  const workingDoc = parseDocument(workingText, { merge: true });
  if (workingDoc.errors.length > 0) return null;

  const containerPath = locateContainerPath(workingDoc, anchorOffset);
  if (containerPath === null) return null;

  return {
    containerPath,
    slot: isValueSlot ? 'value' : 'key',
    key,
    from,
    prefix: text.slice(from, pos),
  };
}
