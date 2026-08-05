import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

/**
 * The rendering tests that matter are the hostile ones: this component renders
 * model output, shaped by third-party documentation content, inside a page that
 * can reach a localhost host API (issue #156). Each case below is written as
 * "what an attacker would try", and asserts on the rendered DOM rather than on
 * the parse tree, because the DOM is what a browser would act on.
 */
describe('Markdown: hostile input', () => {
  it('renders a <script> tag as visible text, creating no script element', () => {
    const { container } = render(
      <Markdown source={'Here you go:\n\n<script>alert(1)</script>'} />,
    );

    expect(container.querySelectorAll('script')).toHaveLength(0);
    // Visible, as text -- so a reader can see what the model actually said.
    expect(
      screen.getByText(/<script>alert\(1\)<\/script>/),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('<script>');
    expect(container.innerHTML).toContain('&lt;script&gt;');
  });

  it('renders an onerror image tag as text, creating no img and no event handler', () => {
    const { container } = render(
      <Markdown source={'<img src=x onerror="fetch(\'/api/ai/key\')">'} />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    // The tag is escaped text, not markup: `onerror` exists only as characters
    // on the page, attached to nothing.
    expect(container.innerHTML).toContain('&lt;img src=x onerror=');
    expect(container.innerHTML).not.toContain('<img');
    expect(
      [...container.querySelectorAll('*')].some((element) =>
        element.getAttributeNames().some((name) => name.startsWith('on')),
      ),
    ).toBe(false);
    expect(container.textContent).toContain('onerror');
  });

  it('never renders a javascript: link as an anchor', () => {
    const { container } = render(
      <Markdown source={'[click me](javascript:alert(document.domain))'} />,
    );

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('javascript:');
    // The label survives as plain text: no dead control, no hidden target.
    expect(screen.getByText('click me')).toBeInTheDocument();
  });

  it('never renders a data: URL link, including one carrying HTML', () => {
    const { container } = render(
      <Markdown
        source={
          '[report](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'
        }
      />,
    );

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('data:');
  });

  it('never renders a Markdown image as an <img>, so no remote asset is fetched', () => {
    // Also covers the `onerror` vector at its source: there is no element to
    // attach a handler to, and no request to a model-chosen host. An image on a
    // *trusted* host is still only ever a link, never an `<img>`.
    const { container } = render(
      <Markdown
        source={'![a diagram](https://circleci.com/docs/_images/track.png)'}
      />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(
      'https://circleci.com/docs/_images/track.png',
    );
    expect(anchor?.textContent).toBe('a diagram');
  });

  it('renders no anchor at all for an image on an untrusted host', () => {
    // The tracking-pixel case: `evil.example` is neither fetched (never an
    // `<img>`) nor offered as a click (issue #187). The alt text survives, and
    // the host is named as text so nothing is hidden.
    const { container } = render(
      <Markdown source={'![a diagram](https://evil.example/track.png)'} />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('track.png');
    expect(container.textContent).toContain('a diagram');
    expect(container.textContent).toContain('not linked: evil.example');
  });

  it('gives every rendered link target="_blank" and rel="noopener noreferrer"', () => {
    const { container } = render(
      <Markdown
        source={
          '[docs](https://circleci.com/docs/) and https://circleci.com/docs/reference/configuration-reference/'
        }
      />,
    );

    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
      expect(anchor.getAttribute('href')).toMatch(/^https:\/\//);
    }
  });

  it('does not linkify a scheme smuggled with a tab, or any non-http scheme in an autolink', () => {
    const { container } = render(
      <Markdown source={'<java\tscript:alert(1)> and <vbscript:msgbox(1)>'} />,
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('renders no anchor for a relative target, which would point at this app’s own host API', () => {
    const { container } = render(
      <Markdown source={'[fetch the key](/api/ai/key)'} />,
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('/api/ai/key');
  });

  it('links a trusted host in the reply body and refuses an untrusted one, in the same reply', () => {
    // Issue #187, at the level a browser would act on: one anchor, to CircleCI;
    // the Slack link the owner reported is text with its destination named, and
    // its URL appears in no attribute anywhere.
    const { container } = render(
      <Markdown
        source={[
          'See [the docs](https://circleci.com/docs/reference/configuration-reference/)',
          'and [our Slack](https://app.slack.com/client/T0/C0), and',
          '[the orb wiki](https://github.com/CircleCI-Public/slack-orb/wiki),',
          'and [this repo](https://github.com/someone/random).',
        ].join('\n')}
      />,
    );

    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      'https://circleci.com/docs/reference/configuration-reference/',
      'https://github.com/CircleCI-Public/slack-orb/wiki',
    ]);
    expect(container.innerHTML).not.toContain('app.slack.com/client');
    expect(container.innerHTML).not.toContain('someone/random');
    // Both refusals are visible rather than silent -- the label survives and the
    // host is stated.
    expect(container.textContent).toContain('our Slack');
    expect(container.textContent).toContain('not linked: app.slack.com');
    expect(container.textContent).toContain('this repo');
    expect(container.textContent).toContain('not linked: github.com');
  });

  it('does not repeat the host when a bare URL already shows it', () => {
    const { container } = render(
      <Markdown source={'see https://app.slack.com/client/T0/C0 for more'} />,
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain(
      'https://app.slack.com/client/T0/C0',
    );
    expect(container.textContent).toContain('(not linked)');
    expect(container.textContent).not.toContain('not linked: app.slack.com');
  });

  it('renders no HTML for an entity-encoded or angle-bracket-heavy payload', () => {
    const { container } = render(
      <Markdown
        source={'&lt;script&gt;alert(1)&lt;/script&gt; <<>> <b>bold?</b>'}
      />,
    );
    expect(container.querySelectorAll('script,b')).toHaveLength(0);
    // The literal entity text is shown as the model wrote it, not decoded into
    // markup.
    expect(container.textContent).toContain('&lt;script&gt;');
  });
});

describe('Markdown: rendering', () => {
  it('renders bold, inline code, headings and lists as real elements', () => {
    const { container } = render(
      <Markdown
        source={[
          '## Caching',
          '',
          'Use **save_cache** with a `key`:',
          '',
          '- first',
          '- second',
        ].join('\n')}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Caching' }),
    ).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('save_cache');
    expect(container.querySelector('code')?.textContent).toBe('key');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    // The literal Markdown punctuation is gone -- the actual defect in #156.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('## ');
  });

  it('renders a fenced YAML block verbatim, highlighted, inside one <pre>', () => {
    const yaml =
      'jobs:\n  build: # a comment\n    docker:\n      - image: cimg/base';
    const { container } = render(
      <Markdown source={'Try:\n\n```yaml\n' + yaml + '\n```'} />,
    );

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // Verbatim: the block is displayed, never re-serialized.
    expect(pre?.textContent).toBe(yaml);
    // Highlighted by the same tokenizer the YAML editor uses, so at least one
    // span carries a colour.
    const coloured = [...container.querySelectorAll('pre span')].filter(
      (span) => (span as HTMLElement).style.color !== '',
    );
    expect(coloured.length).toBeGreaterThan(0);
  });

  it('scrolls a long code line inside its own block, never adding a vertical scroll region', () => {
    // Issue #88: no new nested scroll regions. A code block may scroll
    // horizontally -- the same rule `GuideBlocks.tsx` follows -- and nothing
    // here may set an overflow on the Y axis.
    const { container } = render(
      <Markdown source={'```sh\n' + 'echo '.repeat(200) + 'done\n```'} />,
    );
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.className).not.toContain('overflow-y');
    expect(pre?.className).not.toContain('overflow-auto');
  });

  it('renders a pipe table as a table', () => {
    const { container } = render(
      <Markdown
        source={['| Key | Meaning |', '| --- | --- |', '| a | b |'].join('\n')}
      />,
    );
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
    // The scroll, if any, is on the table's own wrapper.
    expect(
      container.querySelector('table')?.parentElement?.className,
    ).toContain('overflow-x-auto');
  });

  it('renders an empty source as nothing at all', () => {
    const { container } = render(<Markdown source="" />);
    expect(container.textContent).toBe('');
  });
});

// The syntax-highlighting palettes' own contrast proof, `toHighlightSegments`'s
// unit tests, and `highlightLanguageFor`'s language-mapping tests all moved to
// `~/lib/highlight/codeHighlight.test.ts` when that module was extracted
// (issue #291) so `GuideBlocks.tsx` could reuse it -- they test the shared
// module's own contract, not anything specific to Markdown rendering.
