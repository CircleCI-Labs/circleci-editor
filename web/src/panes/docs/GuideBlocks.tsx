/**
 * Renders the guide block model (`~/lib/guides/types`) with this app's own
 * components and theme tokens (issue #104).
 *
 * Every colour, size and border here is a `--color-cc-*` token, so the guides
 * look like part of the editor in both light and dark themes rather than like
 * an embedded web page. That is the whole reason the Go host parses AsciiDoc
 * into data instead of handing over HTML: there is no foreign stylesheet to
 * fight and no third-party markup to sanitise.
 *
 * Two rules this file must keep:
 *
 *  1. **Code samples are selectable, verbatim text.** Users copy them into a
 *     config. No syntax rewriting, no re-indenting, no trimming. Syntax
 *     highlighting (below) only ever wraps the source's own bytes in
 *     `<span>`s -- it never rewrites, reorders or drops a character of them.
 *  2. **A cross-reference that cannot be resolved renders as plain text, never
 *     as a control that does nothing.** Upstream ships three broken ones today;
 *     `resolveRef` returning `undefined` is the expected case, not an error.
 *
 * # Code blocks and syntax highlighting (issue #291)
 *
 * `Block.language` is the AsciiDoc source's *own* declared language
 * (`[source,yaml]`, a ```` ```bash ```` fence, ...), parsed by
 * `internal/guides/asciidoc.go` and carried through the block model
 * untouched -- `CodeBlock` below is what had been dropping it on the floor.
 * Highlighting happens here, at render time in this file, from that
 * declared language only: never guessed, and never by transforming the
 * vendored AsciiDoc snapshot itself (which would invalidate its manifest's
 * per-file hashes).
 *
 * `~/lib/highlight/codeHighlight`'s `HighlightedCode` is the same component
 * the AI chat transcript's fenced code blocks use (`~/lib/markdown/
 * Markdown.tsx`) -- the same tokenizers, the same colour palettes as the
 * YAML editor and the inspector's command field, so a `run:` block reads
 * with the same colours here as it does in the editor. A block with no
 * declared language, or one that module doesn't recognise, renders as plain
 * monospace text.
 */
import type { ReactNode } from 'react';

import { resolveRef } from '~/lib/guides/guides';
import type { Block, Guide, ListItem, Span } from '~/lib/guides/types';
import { HighlightedCode } from '~/lib/highlight/codeHighlight';

/** Admonition tones, mapped onto the app's semantic colours. */
const ADMONITION_TONES: Record<
  string,
  { border: string; label: string; bg: string }
> = {
  NOTE: {
    border: 'border-l-cc-info',
    label: 'text-cc-info',
    bg: 'bg-[color-mix(in_srgb,var(--color-cc-info)_8%,transparent)]',
  },
  TIP: {
    border: 'border-l-cc-success',
    label: 'text-cc-success',
    bg: 'bg-[color-mix(in_srgb,var(--color-cc-success)_8%,transparent)]',
  },
  IMPORTANT: {
    border: 'border-l-cc-warning',
    label: 'text-cc-warning',
    bg: 'bg-[color-mix(in_srgb,var(--color-cc-warning)_8%,transparent)]',
  },
  WARNING: {
    border: 'border-l-cc-warning',
    label: 'text-cc-warning',
    bg: 'bg-[color-mix(in_srgb,var(--color-cc-warning)_8%,transparent)]',
  },
  CAUTION: {
    border: 'border-l-cc-danger',
    label: 'text-cc-danger',
    bg: 'bg-[color-mix(in_srgb,var(--color-cc-danger)_8%,transparent)]',
  },
};

const FALLBACK_TONE = {
  border: 'border-l-cc-border-strong',
  label: 'text-cc-text-muted',
  bg: 'bg-cc-panel-raised',
};

export interface GuideRenderContext {
  /** The guide these blocks belong to, for resolving `ref` spans. */
  guide: Guide;
  /** Navigates the pane to a section in the same guide. */
  onNavigate: (sectionId: string) => void;
}

function SpanList({
  spans,
  context,
}: {
  spans: readonly Span[] | undefined;
  context: GuideRenderContext;
}) {
  if (!spans) return null;
  return (
    <>
      {spans.map((span, index) => (
        // Index keys: spans are a positional, immutable rendering of one
        // parsed paragraph -- there is no stable identity to key on and the
        // list is never reordered or spliced.
        // eslint-disable-next-line react/no-array-index-key
        <SpanNode key={index} span={span} context={context} />
      ))}
    </>
  );
}

function SpanNode({
  span,
  context,
}: {
  span: Span;
  context: GuideRenderContext;
}) {
  const children: ReactNode =
    span.children && span.children.length > 0 ? (
      <SpanList spans={span.children} context={context} />
    ) : (
      span.text
    );

  switch (span.kind) {
    case 'code':
      return (
        <code className="rounded bg-cc-panel-raised px-1 py-0.5 font-mono text-[0.92em] text-cc-text">
          {span.text}
        </code>
      );
    case 'strong':
      return <strong className="font-semibold text-cc-text">{children}</strong>;
    case 'em':
      return <em className="italic">{children}</em>;
    case 'link':
      return (
        <a
          href={span.url}
          target="_blank"
          rel="noreferrer"
          className="text-cc-accent underline decoration-cc-accent/40 hover:decoration-cc-accent"
        >
          {children}
        </a>
      );
    case 'ref': {
      const sectionId = resolveRef(context.guide, span.target);
      if (!sectionId) {
        // Unresolvable -- including because upstream's own cross-reference is
        // broken. Show the words, offer no control.
        return <>{children}</>;
      }
      return (
        <button
          type="button"
          onClick={() => context.onNavigate(sectionId)}
          className="text-cc-accent underline decoration-cc-accent/40 hover:decoration-cc-accent"
        >
          {children}
        </button>
      );
    }
    case 'text':
      return <>{span.text}</>;
    default:
      // An unknown span kind (a host newer than this bundle) still shows its
      // text rather than vanishing.
      return <>{span.text}</>;
  }
}

function CodeBlock({ block }: { block: Block }) {
  return (
    <figure className="min-w-0">
      {block.title ? (
        <figcaption className="mb-1 text-2xs font-medium uppercase tracking-wide text-cc-text-faint">
          {block.title}
        </figcaption>
      ) : null}
      {/* `overflow-x-auto` on the `pre` itself, never on the pane: a long
          sample must scroll inside its own box rather than making the whole
          reading column scroll sideways (issue #88).

          `bg-cc-panel`, not `-panel-raised`: the highlighter's colour
          palette is only contrast-measured against `-panel` (see
          `~/lib/highlight/codeHighlight.test.ts`) -- two of the shell
          palette's own colours fall under AA on `-panel-raised` in light
          mode. */}
      <pre className="overflow-x-auto rounded-md border border-cc-border bg-cc-panel p-2 text-xs leading-relaxed">
        <code className="font-mono text-cc-text">
          <HighlightedCode text={block.text ?? ''} language={block.language} />
        </code>
      </pre>
      {block.language ? (
        <span className="sr-only">{`Language: ${block.language}`}</span>
      ) : null}
    </figure>
  );
}

function TableBlock({
  block,
  context,
}: {
  block: Block;
  context: GuideRenderContext;
}) {
  const table = block.table;
  if (!table) return null;
  return (
    <div className="min-w-0 overflow-x-auto">
      {block.title ? (
        <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-cc-text-faint">
          {block.title}
        </p>
      ) : null}
      <table className="w-full border-collapse text-left text-xs">
        {table.header && table.header.length > 0 ? (
          <thead>
            <tr className="border-b border-cc-border text-2xs uppercase tracking-wide text-cc-text-faint">
              {table.header.map((cell, index) => (
                // eslint-disable-next-line react/no-array-index-key -- a header cell's position is its identity; the row is never reordered.
                <th key={index} className="py-1 pr-3 font-semibold">
                  <SpanList spans={cell.spans} context={context} />
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {table.rows.map((row, rowIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- table rows have no id in the source and are never reordered.
            <tr
              key={rowIndex}
              className="border-b border-cc-border/50 align-top"
            >
              {row.map((cell, cellIndex) => (
                // eslint-disable-next-line react/no-array-index-key -- see the row above.
                <td key={cellIndex} className="py-1 pr-3 text-cc-text-muted">
                  <SpanList spans={cell.spans} context={context} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdmonitionBlock({
  block,
  context,
}: {
  block: Block;
  context: GuideRenderContext;
}) {
  const name = block.admonition ?? 'NOTE';
  const tone = ADMONITION_TONES[name] ?? FALLBACK_TONE;
  return (
    <aside
      className={`min-w-0 rounded-r border-l-2 py-2 pl-3 pr-2 ${tone.border} ${tone.bg}`}
    >
      <p
        className={`mb-1 text-2xs font-semibold uppercase tracking-wide ${tone.label}`}
      >
        {name}
      </p>
      <BlockList blocks={block.blocks} context={context} />
    </aside>
  );
}

function ListBlock({
  block,
  context,
}: {
  block: Block;
  context: GuideRenderContext;
}) {
  const items: readonly ListItem[] = block.items ?? [];
  const className =
    'ml-4 flex flex-col gap-1 text-xs text-cc-text-muted ' +
    (block.ordered ? 'list-decimal' : 'list-disc');
  const content = items.map((item, index) => (
    // eslint-disable-next-line react/no-array-index-key -- list items have no id in the source; position is their identity.
    <li key={index} className="min-w-0">
      <BlockList blocks={item.blocks} context={context} />
    </li>
  ));
  return block.ordered ? (
    <ol className={className}>{content}</ol>
  ) : (
    <ul className={className}>{content}</ul>
  );
}

/** The parser's own voice: something in the source isn't reproduced here. */
function ParserNoteBlock({
  block,
  context,
}: {
  block: Block;
  context: GuideRenderContext;
}) {
  return (
    <p
      className="min-w-0 rounded border border-dashed border-cc-border-strong px-2 py-1.5 text-2xs text-cc-text-faint"
      data-testid="guide-parser-note"
    >
      <SpanList spans={block.spans} context={context} />
    </p>
  );
}

function BlockNode({
  block,
  context,
}: {
  block: Block;
  context: GuideRenderContext;
}) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="min-w-0 text-xs leading-relaxed text-cc-text-muted">
          <SpanList spans={block.spans} context={context} />
        </p>
      );
    case 'code':
      return <CodeBlock block={block} />;
    case 'table':
      return <TableBlock block={block} context={context} />;
    case 'admonition':
      return <AdmonitionBlock block={block} context={context} />;
    case 'list':
      return <ListBlock block={block} context={context} />;
    case 'heading':
      return (
        <h4 id={block.id} className="mt-1 text-xs font-semibold text-cc-text">
          <SpanList spans={block.spans} context={context} />
        </h4>
      );
    case 'note':
      return <ParserNoteBlock block={block} context={context} />;
    default:
      // An unknown block kind from a newer host: show whatever text it
      // carries rather than dropping it silently.
      return (
        <p className="min-w-0 text-xs leading-relaxed text-cc-text-muted">
          <SpanList spans={block.spans} context={context} />
          {block.text}
        </p>
      );
  }
}

/** Renders a list of blocks in document order. */
export function BlockList({
  blocks,
  context,
}: {
  blocks: readonly Block[] | undefined;
  context: GuideRenderContext;
}) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {blocks.map((block, index) => (
        // eslint-disable-next-line react/no-array-index-key -- a block's position in its section is its identity; the list is immutable per render.
        <BlockNode key={index} block={block} context={context} />
      ))}
    </div>
  );
}
