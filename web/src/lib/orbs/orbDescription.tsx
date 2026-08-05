/**
 * Renders an orb's `description` field as a small, safe subset of
 * Markdown -- bold, inline code, and links -- rather than a flat string
 * (issue #89: "it's kind of hard to just read it all").
 *
 * Orb descriptions are third-party YAML content (see `parseOrb.ts`'s own
 * doc comment on why every extraction there is defensive), so this
 * deliberately never touches `innerHTML`/`dangerouslySetInnerHTML`: every
 * node it returns is a plain React element built from matched text,
 * exactly the way React always escapes text content -- there is no code
 * path by which a description containing `<img onerror=...>` or similar
 * could execute anything.
 *
 * It's a small hand-rolled subset, not a Markdown dependency: real orb
 * descriptions in the registry are almost always one or two short
 * paragraphs with occasional emphasis/code/a link, not full documents --
 * headings, lists, and block quotes are rare enough in practice that
 * pulling in (and security-reviewing) a full Markdown renderer isn't worth
 * it for one field. If that assumption stops holding, upgrading to a real
 * renderer is a drop-in replacement for this module's one export.
 */
import type { ReactNode } from 'react';

// Matches, in order of preference at each position: **bold**, `code`, or a
// [label](url) link. The alternation order doesn't affect correctness (the
// regex always finds the leftmost match), but keeping it means each branch
// reads in the same order this doc comment lists them.
const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function renderInlineSegment(text: string, key: string): ReactNode {
  const bold = /^\*\*([^*]+)\*\*$/.exec(text);
  if (bold) return <strong key={key}>{bold[1]}</strong>;

  const code = /^`([^`]+)`$/.exec(text);
  if (code) {
    return (
      <code
        key={key}
        className="rounded bg-cc-panel px-1 py-0.5 font-mono text-[0.9em]"
      >
        {code[1]}
      </code>
    );
  }

  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(text);
  if (link) {
    const [, label, url] = link;
    // Only ever linkify an http(s) target -- third-party text is not a
    // trusted source of a `javascript:`/`data:` URL to hand to `href`.
    if (/^https?:\/\//i.test(url!)) {
      return (
        <a
          key={key}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-cc-accent hover:underline"
        >
          {label}
        </a>
      );
    }
    return text; // Malformed/non-http link syntax: show it verbatim rather than guess.
  }

  return text;
}

function renderLine(line: string, keyPrefix: string): ReactNode[] {
  return line
    .split(INLINE_TOKEN)
    .filter((segment) => segment !== '')
    .map((segment, index) =>
      renderInlineSegment(segment, `${keyPrefix}-${index}`),
    );
}

/**
 * Splits `description` into paragraphs (blank-line-separated) and lines
 * within a paragraph (single newline -- rendered as `<br />`, matching how
 * the same text reads in the orb's own YAML block scalar), running each
 * line through `renderLine` for inline emphasis/code/links.
 */
export function renderOrbDescription(description: string): ReactNode {
  const paragraphs = description.trim().split(/\n\s*\n/);
  return (
    <>
      {paragraphs.map((paragraph, pIndex) => {
        const lines = paragraph.split('\n');
        return (
          <p key={pIndex} className="mb-2 last:mb-0">
            {lines.map((line, lIndex) => (
              // eslint-disable-next-line react/no-array-index-key -- lines within one paragraph have no identity beyond position.
              <span key={lIndex}>
                {renderLine(line, `${pIndex}-${lIndex}`)}
                {lIndex < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}
