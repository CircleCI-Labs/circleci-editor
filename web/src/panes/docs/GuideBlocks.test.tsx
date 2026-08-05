import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Block, Guide } from '~/lib/guides/types';

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
