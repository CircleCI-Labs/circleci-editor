/**
 * Renders the block tree `parseMarkdown.ts` produces as React elements (issue #156).
 *
 * # The security property, stated once
 *
 * Every node below is created by JSX with string children. There is no
 * `dangerouslySetInnerHTML` in this file, no `innerHTML`, and no HTML string
 * anywhere in the pipeline — so model output cannot introduce markup, only
 * text. The one attribute that ever takes model-supplied data is `href`, and it
 * only ever receives a value `classifyUrl` already accepted as `http:`/`https:`
 * **on an allowed host** (see `./safeUrl`); an unsafe target never reaches this
 * file, because the parser turns it into a text span or a `blockedLink` instead
 * of a link, and a `blockedLink` carries no href to render. Every link is
 * `target="_blank" rel="noopener noreferrer"`, so a linked page gets no
 * `window.opener` handle on this app and no referrer.
 *
 * `Markdown.test.tsx` asserts these properties against deliberately hostile
 * input rather than leaving them as claims.
 *
 * # Code blocks
 *
 * A fenced block tagged `yaml` or a shell dialect is highlighted by
 * `~/lib/highlight/codeHighlight`'s `HighlightedCode` — the exact same
 * tokenizers and the exact same (contrast-measured) colour palettes as the
 * YAML editor and the inspector's command field, reused (issue #291) rather
 * than mounting a CodeMirror instance or inventing a second vocabulary. That
 * matters twice over: a YAML snippet in a reply looks like the same YAML the
 * editor shows, and a chat bubble does not acquire an editor's keyboard
 * behaviour or its scroll container. Only `overflow-x` on the `<pre>` itself,
 * matching the docs pane's own precedent (`GuideBlocks.tsx`) — no new
 * vertical scroll region, which issue #88 is emphatic about.
 */
import { useMemo, type ReactNode } from 'react';

import { HighlightedCode } from '~/lib/highlight/codeHighlight';

import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from './parseMarkdown';

/**
 * Renders `source` as Markdown.
 *
 * Intended for model-authored prose. The app's own copy is written as JSX, and
 * user-typed messages stay verbatim text (see `ChatMessageView`) — running a
 * formatter over what someone literally typed would be a lie about their input.
 */
export function Markdown({
  source,
  className = '',
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={`min-w-0 ${className}`} data-testid="markdown">
      {blocks.map((block, index) => (
        // Blocks have no identity beyond their position in one immutable reply.
        // eslint-disable-next-line react/no-array-index-key
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

/**
 * Heading sizes, downshifted (#192's fourth pattern, applied by #209).
 *
 * Chunk maps every level, `h1` through `h6`, onto one small heading style, and
 * the reason is worth restating rather than just copying: a model writes `#`
 * because it thinks it is writing a *document*, and this is a 320px-wide pane in
 * which a `text-base` heading came out larger than the pane's own title. The
 * largest heading a reply can now produce is the size of its own body text,
 * distinguished by weight — which is what "a model's `#` doesn't shout" means
 * here.
 *
 * Two tiers rather than their one, the single place this diverges: a reply that
 * uses `#` and `###` for two real levels of structure keeps the distinction, and
 * flattening it would turn a genuinely nested answer into a wall. Both tiers are
 * smaller than the top tier was.
 *
 * Only the *size* moved. `aria-level` stays fixed below the pane's own heading —
 * see `BlockView`'s `heading` case for why model output must not inject structure
 * into this page's outline.
 */
const HEADING_CLASSES: Record<number, string> = {
  1: 'text-sm',
  2: 'text-sm',
  3: 'text-xs',
  4: 'text-xs',
  5: 'text-xs',
  6: 'text-xs',
};

function BlockView({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="mb-2 whitespace-pre-wrap break-words last:mb-0">
          <Inlines spans={block.spans} />
        </p>
      );

    case 'heading': {
      // Headings inside a chat bubble are visual weight, not document
      // structure: the transcript's own heading hierarchy belongs to the app
      // (`Panel`'s `<h2>`), and letting model output inject `<h1>`s into it
      // would make the page outline nonsense for a screen-reader user. So this
      // renders a styled paragraph with `role="heading"` at a fixed level
      // *below* the pane's own -- announced as a heading, without rewriting the
      // page's structure.
      return (
        <p
          role="heading"
          aria-level={3}
          className={`mb-1 mt-3 font-semibold text-cc-text first:mt-0 ${HEADING_CLASSES[block.level] ?? 'text-sm'}`}
        >
          <Inlines spans={block.spans} />
        </p>
      );
    }

    case 'code':
      return <CodeBlock text={block.text} language={block.language} />;

    case 'list': {
      const className = block.ordered
        ? 'mb-2 list-decimal pl-5 last:mb-0'
        : 'mb-2 list-disc pl-5 last:mb-0';
      const items = block.items.map((blocks, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={index} className="mb-0.5 last:mb-0">
          {blocks.map((inner, innerIndex) => (
            // eslint-disable-next-line react/no-array-index-key
            <BlockView key={innerIndex} block={inner} />
          ))}
        </li>
      ));
      return block.ordered ? (
        <ol className={className} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      );
    }

    case 'quote':
      return (
        <blockquote className="mb-2 border-l-2 border-cc-border-strong pl-2 text-cc-text-muted last:mb-0">
          {block.blocks.map((inner, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <BlockView key={index} block={inner} />
          ))}
        </blockquote>
      );

    case 'table':
      return (
        // The horizontal scroll lives on this wrapper, never on the pane.
        <div className="mb-2 min-w-0 overflow-x-auto last:mb-0">
          <table className="w-full border-collapse text-2xs">
            {block.header.length > 0 ? (
              <thead>
                <tr>
                  {block.header.map((cell, index) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <th
                      key={index}
                      className="border border-cc-border px-1.5 py-1 text-left font-semibold text-cc-text"
                    >
                      <Inlines spans={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <td
                      key={cellIndex}
                      className="border border-cc-border px-1.5 py-1 align-top text-cc-text-muted"
                    >
                      <Inlines spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'rule':
      return <hr className="my-2 border-cc-border" />;
  }
}

function Inlines({ spans }: { spans: MarkdownInline[] }): ReactNode {
  return (
    <>
      {spans.map((span, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <InlineView key={index} span={span} />
      ))}
    </>
  );
}

function InlineView({ span }: { span: MarkdownInline }): ReactNode {
  switch (span.kind) {
    case 'text':
      return span.text;
    case 'break':
      return <br />;
    case 'code':
      return (
        <code className="rounded bg-cc-panel px-1 py-0.5 font-mono text-[0.9em] text-cc-text">
          {span.text}
        </code>
      );
    case 'strong':
      return (
        <strong className="font-semibold">
          <Inlines spans={span.children} />
        </strong>
      );
    case 'em':
      return (
        <em className="italic">
          <Inlines spans={span.children} />
        </em>
      );
    case 'link':
      // `href` is a URL `classifyUrl` already validated as http(s) on an
      // allowed host -- see `./safeUrl`. `noopener noreferrer` on a
      // model-supplied destination is not optional: it denies the opened page a
      // handle on this window and tells it nothing about where the click came
      // from.
      return (
        <a
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-cc-accent underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-1 focus-visible:ring-cc-accent"
        >
          <Inlines spans={span.children} />
        </a>
      );
    case 'blockedLink': {
      // Issue #187. A model may put a link anywhere, and the reply body is
      // "anywhere" -- so the host allowlist applies here exactly as it does to
      // the Sources footer. Deliberately *not* silently dropped to bare text:
      // that would hide the fact that this answer pointed somewhere, which is
      // the same dishonesty the ungrounded-reply notice exists to avoid.
      //
      // Not styled like a link (no accent, no underline): it must not read as
      // clickable, because it isn't. There is no `href` to render even in
      // principle -- the parser hands this inline a hostname and nothing else.
      const labelShowsHost = plainText(span.children).includes(span.hostname);
      return (
        <>
          <span className="break-words text-cc-text-muted">
            <Inlines spans={span.children} />
          </span>{' '}
          <span className="whitespace-nowrap text-2xs text-cc-text-faint">
            ({labelShowsHost ? 'not linked' : `not linked: ${span.hostname}`})
          </span>
        </>
      );
    }
  }
}

/**
 * The text an inline run reads as, used only to decide whether a blocked link's
 * annotation needs to repeat the hostname (it doesn't, for a bare URL whose own
 * text already shows it). Presentation-only: nothing security-relevant depends
 * on it.
 */
function plainText(spans: MarkdownInline[]): string {
  return spans
    .map((span) => {
      switch (span.kind) {
        case 'text':
        case 'code':
          return span.text;
        case 'strong':
        case 'em':
        case 'link':
        case 'blockedLink':
          return plainText(span.children);
        case 'break':
          return '\n';
      }
    })
    .join('');
}

function CodeBlock({
  text,
  language,
}: {
  text: string;
  language?: string;
}): ReactNode {
  return (
    <div className="mb-2 min-w-0 last:mb-0">
      {language ? (
        <p className="mb-0.5 font-mono text-2xs uppercase tracking-wide text-cc-text-faint">
          {language}
        </p>
      ) : null}
      {/* `overflow-x-auto` on the `pre` itself, never on the pane: a long
          command line scrolls within its own block. Same rule as
          `GuideBlocks.tsx`. */}
      <pre className="overflow-x-auto rounded-md border border-cc-border bg-cc-panel p-2 text-xs leading-relaxed">
        <code className="font-mono text-cc-text">
          <HighlightedCode text={text} language={language} />
        </code>
      </pre>
    </div>
  );
}
