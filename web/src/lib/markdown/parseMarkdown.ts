/**
 * A small Markdown parser for **AI reply prose only** (issue #156: "the current
 * chat window does not render markdown, so it'd be really nice to support
 * that"). It produces a block/inline tree; `Markdown.tsx` turns that tree into
 * React elements. Nothing here produces, parses, or touches HTML.
 *
 * # Why this, and not a Markdown dependency
 *
 * The input is model output, shaped by third-party documentation content, and
 * it is rendered in a page that can talk to a localhost host API which reads
 * and writes files. That makes the renderer a security boundary, not a
 * formatting nicety, and the two properties that matter are:
 *
 *  1. **Raw HTML must be impossible, not filtered.** Every mainstream Markdown
 *     renderer passes HTML through by default and expects you to disable it
 *     (`marked`'s `sanitize` is removed, `markdown-it`'s `html: false`,
 *     `react-markdown` + `rehype-sanitize`), which makes safety a
 *     configuration flag one refactor away from being flipped. This parser has
 *     no HTML path at all: `<script>alert(1)</script>` is text, and the
 *     renderer's only way to emit anything is `React.createElement` with
 *     string children, which React escapes. There is nothing to sanitise
 *     because there is nothing to parse.
 *  2. **No new supply-chain surface.** `react-markdown` + `remark-gfm` +
 *     `rehype-sanitize` is ~40 transitive packages for a chat bubble, all of
 *     which would need reviewing and updating on a tool whose entire premise
 *     is running locally against the user's repository.
 *
 * This module is the successor to `~/lib/orbs/orbDescription.tsx`'s
 * "Markdown-lite subset", which that file's own comment predicted would need
 * upgrading ("if that assumption stops holding, upgrading to a real renderer is
 * a drop-in replacement"). That assumption *has* stopped holding: orb
 * descriptions are one or two inline-formatted paragraphs, whereas an AI reply
 * is a document — headings, lists, tables, and above all fenced YAML, the most
 * valuable thing the assistant produces. So this handles block structure
 * properly rather than stretching an inline-only helper to cover it.
 * `orbDescription.tsx` keeps its own narrower implementation for now (it is
 * load-bearing for the orb browser, which is concurrently owned work); this
 * module is deliberately usable as its replacement later.
 *
 * # What it supports
 *
 * ATX headings, paragraphs (with hard line breaks preserved — a single newline
 * in a chat reply is nearly always meant), fenced code blocks with an info
 * string, bullet and ordered lists (nested), block quotes, thematic breaks,
 * GFM pipe tables, and inline emphasis/strong/code/links/autolinks. Setext
 * headings, reference links, footnotes, definition lists and HTML are not
 * supported: models writing chat replies do not use them, and every construct
 * here is one more thing to get right.
 *
 * Anything unrecognised degrades to the literal text that produced it, never to
 * a hole — the same rule `internal/guides`'s AsciiDoc parser follows.
 *
 * # Where "is this linkable" is decided
 *
 * Not here. `./safeUrl`'s `classifyUrl` is the single gate for both the scheme
 * (#168) and the host (#187), and it is shared with the Sources footer
 * (`~/lib/ai/sources`) so a reply body and a citation can never disagree about
 * what this app is willing to link to.
 */
import { classifyUrl } from './safeUrl';

/** An inline run. `break` is a hard line break within a paragraph. */
export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: MarkdownInline[] }
  | { kind: 'em'; children: MarkdownInline[] }
  | { kind: 'break' }
  /**
   * A link whose `href` has already been through `classifyUrl`: an inline of
   * this kind is, by construction, an `http:`/`https:` URL on an allowed host.
   * Anything else never becomes a link at all — see `./safeUrl`.
   */
  | { kind: 'link'; href: string; children: MarkdownInline[] }
  /**
   * A link the model wrote to a **real but untrusted** host (issue #187): the
   * label still renders, and the renderer says plainly that it was not linked
   * and where it would have gone.
   *
   * Carries only the `hostname` — never the href — so there is nothing here
   * that a renderer could put in an attribute even by accident. A rejected
   * *scheme* produces plain text instead, with no target shown at all: #168
   * settled that a `javascript:`/`data:` target is not information worth
   * reprinting, whereas "this answer pointed you at app.slack.com and we
   * declined to link it" is.
   */
  | { kind: 'blockedLink'; hostname: string; children: MarkdownInline[] };

/** A block. `code.language` is the fence's own info string, lowercased, never guessed. */
export type MarkdownBlock =
  | { kind: 'paragraph'; spans: MarkdownInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MarkdownInline[] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'list'; ordered: boolean; start?: number; items: MarkdownBlock[][] }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { kind: 'rule' };

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
/** A GFM table delimiter row: `|---|:--:|`, at least one dash, nothing but dashes, colons, pipes and space. */
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

interface ListItemLines {
  /** The item's own lines, dedented by the marker's width so a nested list parses recursively. */
  lines: string[];
}

/** Parses `source` into blocks. Never throws: unrecognised input becomes paragraph text. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(splitLines(source));
}

function splitLines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n');
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, , marker, info] = fence;
      const closer = marker![0]!;
      const body: string[] = [];
      index += 1;
      // An unterminated fence takes the rest of the input rather than
      // reverting to paragraph text: a reply can be cut short (a provider
      // timeout, a token limit), and a half-written YAML block is far more
      // useful as code than as one long paragraph.
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (
          new RegExp(
            `^\\s{0,3}${closer === '`' ? '`' : '~'}{${marker!.length},}\\s*$`,
          ).test(candidate)
        ) {
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      const language = (info ?? '').trim().toLowerCase();
      blocks.push({
        kind: 'code',
        text: body.join('\n'),
        ...(language === '' ? {} : { language }),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[2]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({
        kind: 'heading',
        level,
        spans: parseInline(heading[3]!),
      });
      index += 1;
      continue;
    }

    // Checked after the list-item patterns would match `- - -`? No: RULE
    // requires three or more of the same marker separated only by spaces,
    // while a list item requires content after the marker, so `- item` can
    // never match here.
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const inner: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!);
        if (match) {
          inner.push(match[1]!);
          index += 1;
          continue;
        }
        // A blank line ends the quote; lazy continuation lines belong to it.
        if (lines[index]!.trim() === '') break;
        inner.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    const table = tryParseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (BULLET_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index]!;
      if (candidate.trim() === '' || startsBlock(candidate, lines, index))
        break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInlineLines(paragraph) });
  }

  return blocks;
}

/**
 * Whether `line` interrupts a paragraph. Kept in step with the dispatch in
 * `parseBlocks` above, and deliberately conservative in the same direction
 * `internal/guides`'s parser is: a false negative glues one line onto a
 * paragraph, a false positive shreds prose into fragments.
 */
function startsBlock(line: string, lines: string[], index: number): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    tryParseTable(lines, index) !== undefined
  );
}

function parseList(
  lines: string[],
  start: number,
): { block: MarkdownBlock; next: number } {
  const first =
    BULLET_ITEM.exec(lines[start]!) ?? ORDERED_ITEM.exec(lines[start]!)!;
  const ordered =
    ORDERED_ITEM.test(lines[start]!) && !BULLET_ITEM.test(lines[start]!);
  const baseIndent = first[1]!.length;
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : undefined;

  const items: ListItemLines[] = [];
  let index = start;
  let current: ListItemLines | undefined;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      // One blank line inside a list is tolerated (a "loose" list); two ends
      // it, as does any non-indented content after a blank.
      const next = lines[index + 1];
      if (
        next === undefined ||
        next.trim() === '' ||
        (!isItemAtIndent(next, baseIndent) && indentOf(next) <= baseIndent)
      ) {
        index += 1;
        break;
      }
      current?.lines.push('');
      index += 1;
      continue;
    }

    const indent = indentOf(line);
    const item = BULLET_ITEM.exec(line) ?? ORDERED_ITEM.exec(line);

    if (item && indent <= baseIndent) {
      // A sibling item — or a marker of the other kind, which starts a new
      // list rather than joining this one.
      const itemIsOrdered = ORDERED_ITEM.test(line) && !BULLET_ITEM.test(line);
      if (indent === baseIndent && itemIsOrdered !== ordered && current) break;
      current = { lines: [item[3]!] };
      items.push(current);
      index += 1;
      continue;
    }

    if (current === undefined) break;

    if (indent > baseIndent) {
      // Nested content: dedent by the parent's indent so the recursive parse
      // sees it at column zero.
      current.lines.push(line.slice(Math.min(indent, baseIndent + 2)));
      index += 1;
      continue;
    }

    // A lazy continuation of the current item's paragraph.
    if (!startsBlock(line, lines, index)) {
      current.lines.push(line.trim());
      index += 1;
      continue;
    }
    break;
  }

  return {
    block: {
      kind: 'list',
      ordered,
      ...(startNumber !== undefined && startNumber !== 1
        ? { start: startNumber }
        : {}),
      items: items.map((item) => parseBlocks(item.lines)),
    },
    next: index,
  };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isItemAtIndent(line: string, indent: number): boolean {
  const match = BULLET_ITEM.exec(line) ?? ORDERED_ITEM.exec(line);
  return match !== null && match[1]!.length >= indent;
}

/**
 * A pipe table, recognised only by its delimiter row — `| a | b |` on its own
 * is far more likely to be prose containing a pipe than a one-row table.
 */
function tryParseTable(
  lines: string[],
  start: number,
): { block: MarkdownBlock; next: number } | undefined {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (headerLine === undefined || delimiterLine === undefined) return undefined;
  if (!headerLine.includes('|')) return undefined;
  if (!delimiterLine.includes('-') || !TABLE_DELIMITER.test(delimiterLine)) {
    return undefined;
  }

  const header = splitRow(headerLine);
  if (header.length === 0) return undefined;

  const rows: MarkdownInline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '' || !line.includes('|')) break;
    rows.push(splitRow(line).map((cell) => parseInline(cell)));
    index += 1;
  }

  return {
    block: {
      kind: 'table',
      header: header.map((cell) => parseInline(cell)),
      rows,
    },
    next: index,
  };
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('|').map((cell) => cell.trim());
}

/** Joins a paragraph's lines with hard breaks between them. */
function parseInlineLines(lines: string[]): MarkdownInline[] {
  const spans: MarkdownInline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) spans.push({ kind: 'break' });
    spans.push(...parseInline(line));
  });
  return spans;
}

/**
 * One pass of alternation, leftmost match wins, in this order: code span,
 * strong, emphasis, image, link, angle-bracket autolink, bare URL.
 *
 * `_underscore_` emphasis is guarded by `(?<!\w)`/`(?!\w)` so `save_cache` and
 * `restore_cache` — which appear constantly in this app's domain — are not read
 * as emphasis. Code spans come first so `` `**not bold**` `` stays literal.
 */
/**
 * The target inside a `](...)`, allowing one level of balanced parentheses so
 * `https://en.wikipedia.org/wiki/Foo_(bar)` survives -- and so does
 * `javascript:alert(1)`, which matters for the opposite reason: the whole
 * malicious target must be consumed by the match, or a stray `)` is left
 * dangling in the prose next to the (correctly) de-linked label.
 */
const URL_IN_PARENS = '(?:[^()\\s]|\\([^()\\s]*\\))*';

const INLINE_TOKEN = new RegExp(
  [
    '(?<codeTicks>`+)(?<code>[\\s\\S]*?)\\k<codeTicks>',
    '\\*\\*(?<strong>[\\s\\S]+?)\\*\\*',
    '__(?<strongU>[\\s\\S]+?)__',
    '(?<!\\w)\\*(?<em>[^*\\n]+?)\\*(?!\\w)',
    '(?<!\\w)_(?<emU>[^_\\n]+?)_(?!\\w)',
    '!\\[(?<imageAlt>[^\\]]*)\\]\\((?<imageUrl>' + URL_IN_PARENS + ')\\)',
    '\\[(?<linkText>[^\\]]*)\\]\\((?<linkUrl>' + URL_IN_PARENS + ')\\)',
    '<(?<autolink>[a-zA-Z][a-zA-Z0-9+.-]*:[^>\\s]+)>',
    // A bare URL. Sentence punctuation is excluded from the *last* character
    // rather than trimmed afterwards, so "see https://circleci.com/docs/x."
    // does not linkify the full stop -- the same trick
    // internal/ai/anthropic's own sourceURLPattern uses.
    '(?<bare>[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s<>()\\[\\]"\'`]*[^\\s<>()\\[\\]"\'`.,;:!?])',
  ].join('|'),
  'g',
);

/**
 * Parses inline markup in `text`.
 *
 * `allowLinks` is false inside a link's own label, so a pathological
 * `[a [b](x)](y)` cannot nest anchors (invalid markup, and a confusing click
 * target); the inner link's text survives as plain text.
 */
export function parseInline(text: string, allowLinks = true): MarkdownInline[] {
  const spans: MarkdownInline[] = [];
  let cursor = 0;

  // `matchAll`, not `exec` in a loop: this function recurses (a link's label, a
  // strong run's contents), and a shared `RegExp` with the `g` flag carries
  // `lastIndex` as mutable state -- a nested call would rewind the outer scan
  // and, in the worst case, never terminate. `matchAll` iterates over its own
  // clone, so recursion is safe.
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const groups = match.groups ?? {};

    // A zero-width match contributes nothing.
    if (match[0] === '') continue;

    const span = inlineFor(groups, match[0], allowLinks);
    if (span === undefined) continue;

    if (match.index > cursor) {
      pushText(spans, text.slice(cursor, match.index));
    }
    if (span === 'literal') {
      pushText(spans, match[0]);
    } else {
      spans.push(span);
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) pushText(spans, text.slice(cursor));
  return spans;
}

/**
 * Maps one regex match to its inline, `'literal'` when the syntax matched but
 * the content must be shown verbatim (an unsafe link target, most importantly),
 * or `undefined` when the match should be ignored entirely.
 */
function inlineFor(
  groups: Record<string, string | undefined>,
  matched: string,
  allowLinks: boolean,
): MarkdownInline | 'literal' | undefined {
  if (groups.code !== undefined) {
    // CommonMark strips one leading/trailing space from a code span, which is
    // how `` ` `` is written inside one.
    const text = groups.code.replace(/^ (.*) $/s, '$1');
    return { kind: 'code', text };
  }
  const strong = groups.strong ?? groups.strongU;
  if (strong !== undefined) {
    return { kind: 'strong', children: parseInline(strong, allowLinks) };
  }
  const em = groups.em ?? groups.emU;
  if (em !== undefined) {
    return { kind: 'em', children: parseInline(em, allowLinks) };
  }

  if (groups.imageUrl !== undefined) {
    // An image is deliberately never rendered as an `<img>`: loading a
    // model-chosen remote asset would leak that this app requested it, give an
    // `onerror`/`onload` handler somewhere to live if this ever grew an HTML
    // path, and let a broken or enormous asset wreck a chat bubble. A
    // documentation screenshot is a *link* here, labelled with its own alt
    // text.
    const verdict = classifyUrl(groups.imageUrl);
    const alt = (groups.imageAlt ?? '').trim();
    if (!allowLinks || !verdict.allowed) {
      // An untrusted host is still worth naming (#187) -- a screenshot hosted
      // somewhere arbitrary is exactly the kind of citation the user should
      // know about rather than have quietly disappear.
      if (allowLinks && !verdict.allowed && verdict.reason === 'host') {
        return {
          kind: 'blockedLink',
          hostname: verdict.hostname,
          children: [
            { kind: 'text', text: alt === '' ? verdict.hostname : alt },
          ],
        };
      }
      return alt === '' ? 'literal' : { kind: 'text', text: alt };
    }
    return {
      kind: 'link',
      href: verdict.href,
      children: [{ kind: 'text', text: alt === '' ? verdict.href : alt }],
    };
  }

  if (groups.linkUrl !== undefined) {
    const verdict = classifyUrl(groups.linkUrl);
    const label = groups.linkText ?? '';
    if (!verdict.allowed) {
      if (verdict.reason === 'host') {
        // A real http(s) URL to a host this app does not vouch for: the label
        // renders, and the renderer says where it would have gone. Not silently
        // dropped, and not clickable.
        return {
          kind: 'blockedLink',
          hostname: verdict.hostname,
          children:
            label.trim() === ''
              ? [{ kind: 'text', text: verdict.hostname }]
              : parseInline(label, false),
        };
      }
      // The target is not linkable at all (`javascript:`, `data:`, a relative
      // path): show the label as plain text and drop the target on the floor.
      // Never a dead `<a>`, and never the raw target as an href.
      return label.trim() === '' ? 'literal' : { kind: 'text', text: label };
    }
    if (!allowLinks) return { kind: 'text', text: label };
    return {
      kind: 'link',
      href: verdict.href,
      children: parseInline(label, false),
    };
  }

  const url = groups.autolink ?? groups.bare;
  if (url !== undefined) {
    const verdict = classifyUrl(url);
    // An unsafe autolink (`<javascript:alert(1)>`, `<data:text/html,...>`)
    // stays literal text: the reader sees exactly what the model wrote, and
    // there is no anchor to click.
    if (!verdict.allowed) {
      if (allowLinks && verdict.reason === 'host') {
        return {
          kind: 'blockedLink',
          hostname: verdict.hostname,
          children: [{ kind: 'text', text: url }],
        };
      }
      return 'literal';
    }
    if (!allowLinks) return 'literal';
    return {
      kind: 'link',
      href: verdict.href,
      children: [{ kind: 'text', text: url }],
    };
  }

  return matched === '' ? undefined : 'literal';
}

function pushText(spans: MarkdownInline[], text: string): void {
  if (text === '') return;
  const last = spans[spans.length - 1];
  if (last && last.kind === 'text') {
    last.text += text;
    return;
  }
  spans.push({ kind: 'text', text });
}
