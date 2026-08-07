import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Block, Guide, Span } from '~/lib/guides/types';

import { BlockList, type GuideRenderContext } from './GuideBlocks';

/**
 * Issue #291: the reference pane's code blocks must be highlighted from the
 * language the AsciiDoc source declared (`Block.language`, already carried
 * through by `internal/guides/asciidoc.go` -- this file was the piece
 * dropping it), reusing the exact same tokenizer/palette module the AI chat
 * transcript uses (`~/lib/highlight/codeHighlight`), never guessing a
 * language, and never adding a nested (vertical) scroll region.
 */
const BASE_GUIDE: Guide = {
  id: 'configuration-reference',
  origin: 'circleci',
  title: 'Configuration reference',
  url: 'https://circleci.com/docs/reference/configuration-reference/',
  sections: [],
};

const CONTEXT: GuideRenderContext = {
  guide: BASE_GUIDE,
  onNavigate: () => {},
};

function renderCodeBlock(block: Block) {
  return render(<BlockList blocks={[block]} context={CONTEXT} />);
}

describe('GuideBlocks: code block highlighting', () => {
  it('highlights a declared-YAML block with the shared tokenizer, verbatim', () => {
    const text =
      'jobs:\n  build: # a comment\n    docker:\n      - image: cimg/base';
    const { container } = renderCodeBlock({
      kind: 'code',
      language: 'yaml',
      text,
    });

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // Verbatim -- the parser's own rule, and this file's, that a code sample
    // is never rewritten, re-indented or trimmed.
    expect(pre?.textContent).toBe(text);

    const coloured = [...container.querySelectorAll('pre span')].filter(
      (span) => (span as HTMLElement).style.color !== '',
    );
    expect(coloured.length).toBeGreaterThan(0);
  });

  it('highlights a declared-shell block with the shared tokenizer, verbatim', () => {
    const text = 'echo "$(date)" && exit 1';
    const { container } = renderCodeBlock({
      kind: 'code',
      language: 'shell',
      text,
    });

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe(text);
    const coloured = [...container.querySelectorAll('pre span')].filter(
      (span) => (span as HTMLElement).style.color !== '',
    );
    expect(coloured.length).toBeGreaterThan(0);
  });

  it('renders a block with no declared language as plain text -- never guessed', () => {
    const text = 'jobs:\n  build:\n';
    const { container } = renderCodeBlock({ kind: 'code', text });

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe(text);
    const coloured = [...container.querySelectorAll('pre span')].filter(
      (span) => (span as HTMLElement).style.color !== '',
    );
    expect(coloured).toHaveLength(0);
  });

  it('renders a block whose declared language is unsupported as plain text', () => {
    // json/python/etc: recognised as *declared*, but this pane has no
    // tokenizer for them, and a wrongly-highlighted block is worse than an
    // unhighlighted one -- so it must fall back to plain text, not a guess.
    const text = '{ "resource_class": "medium" }';
    const { container } = renderCodeBlock({
      kind: 'code',
      language: 'json',
      text,
    });

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe(text);
    const coloured = [...container.querySelectorAll('pre span')].filter(
      (span) => (span as HTMLElement).style.color !== '',
    );
    expect(coloured).toHaveLength(0);
  });

  it('never introduces a vertical scroll region -- only the pre may scroll, and only horizontally', () => {
    // Issue #88: doc examples have long lines, but a horizontally
    // scrolling block inside a scrolling pane is a defect here, not a fix.
    const text = 'run: '.repeat(200) + 'echo done';
    const { container } = renderCodeBlock({
      kind: 'code',
      language: 'shell',
      text,
    });

    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.className).not.toContain('overflow-y');
    expect(pre?.className).not.toContain('overflow-auto');
  });

  it("paints the code block on --color-cc-panel, the surface the highlighter's palette is proven against", () => {
    const { container } = renderCodeBlock({
      kind: 'code',
      language: 'yaml',
      text: 'jobs: {}',
    });
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('bg-cc-panel');
    expect(pre?.className).not.toContain('bg-cc-panel-raised');
  });
});

/**
 * Issue #10: an outbound `link` span must look different from an in-app
 * `ref` span, and the difference must not be colour alone. These render the
 * two span kinds side by side, exactly as they appear together in real
 * prose (see the "See the `save_cache` section... Upstream links out too"
 * paragraph in `docs-guides.spec.ts`'s fixture).
 */
describe('GuideBlocks: external vs in-app links (issue #10)', () => {
  function renderParagraph(
    spans: Span[],
    context: GuideRenderContext = CONTEXT,
  ) {
    return render(
      <BlockList blocks={[{ kind: 'paragraph', spans }]} context={context} />,
    );
  }

  it('marks an outbound link with a non-colour glyph and an accessible "opens in a new tab" cue', () => {
    renderParagraph([
      {
        kind: 'link',
        text: 'Reusable Configuration',
        url: 'https://circleci.com/docs/reference/reusing-config/',
      },
    ]);
    const link = screen.getByRole('link', { name: /Reusable Configuration/ });
    // The glyph is visible text content, not a CSS colour -- present
    // regardless of theme or contrast settings.
    expect(link.textContent).toContain('↗');
    expect(link).toHaveAccessibleName(/opens in a new tab/i);
  });

  it('does not mark an in-pane cross-reference button -- it never leaves the app', () => {
    // Unlike a `link` span, `ref` needs its target to actually resolve
    // (`resolveRef` reads `guide.anchors`) to render as a button at all.
    const guide: Guide = {
      ...BASE_GUIDE,
      anchors: { savecache: 'savecache' },
    };
    renderParagraph(
      [{ kind: 'ref', text: 'save_cache', target: 'savecache' }],
      { guide, onNavigate: () => {} },
    );
    const button = screen.getByRole('button', { name: 'save_cache' });
    expect(button.textContent).not.toContain('↗');
  });

  it('does not mark an unresolvable cross-reference -- it renders as plain text, not a link', () => {
    // resolveRef returns undefined when `guide.anchors` has no entry for the
    // target (an upstream cross-reference that was already broken in the
    // source, or one this snapshot never recorded) -- the exact "cannot be
    // resolved" case docsLinks.ts and this file's own rule 2 both call out.
    renderParagraph([
      { kind: 'ref', text: 'nonexistent', target: 'nonexistent' },
    ]);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('nonexistent')).toBeInTheDocument();
  });
});
