import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './parseMarkdown';

/**
 * The link-safety gate itself -- scheme (issues #156/#168) and host (issue
 * #187) -- lives in `./safeUrl`, where it is tested adversarially against
 * look-alike domains. What is tested here is how this parser *acts* on its
 * verdicts, which differs by verdict on purpose: an unusable scheme leaves plain
 * text with the target dropped entirely, while a real URL on an untrusted host
 * becomes a `blockedLink` that still says where it pointed.
 */

describe('parseMarkdown blocks', () => {
  it('parses paragraphs, keeping single newlines as hard breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'one' },
          { kind: 'break' },
          { kind: 'text', text: 'two' },
        ],
      },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'three' }] },
    ]);
  });

  it('parses ATX headings up to level six', () => {
    const blocks = parseMarkdown('# One\n\n### Three\n\n####### Seven hashes');
    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 1,
      spans: [{ kind: 'text', text: 'One' }],
    });
    expect(blocks[1]).toEqual({
      kind: 'heading',
      level: 3,
      spans: [{ kind: 'text', text: 'Three' }],
    });
    // Seven hashes is not a heading in CommonMark; it stays text.
    expect(blocks[2]?.kind).toBe('paragraph');
  });

  it('parses a fenced code block with its language, verbatim', () => {
    const source = [
      'Add this:',
      '',
      '```yaml',
      'jobs:',
      '  build:',
      '    docker:',
      '      - image: cimg/node:20.11',
      '```',
      '',
      'Then commit.',
    ].join('\n');

    const blocks = parseMarkdown(source);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({
      kind: 'code',
      language: 'yaml',
      text: 'jobs:\n  build:\n    docker:\n      - image: cimg/node:20.11',
    });
  });

  it('never re-emits YAML: the code block text is the model’s bytes unchanged', () => {
    // The project-wide invariant: nothing in this app regenerates
    // YAML. A code fence is displayed, not parsed and re-serialized.
    const yaml = 'a:  1\n\n\nb:   "keep   spacing"   # trailing comment  ';
    const blocks = parseMarkdown('```yaml\n' + yaml + '\n```');
    expect(blocks[0]).toEqual({ kind: 'code', language: 'yaml', text: yaml });
  });

  it('treats an unterminated fence as code to the end of the reply', () => {
    // A truncated reply (token limit, timeout) is far more useful as code than
    // as one long paragraph.
    const blocks = parseMarkdown('```yaml\njobs:\n  build:');
    expect(blocks).toEqual([
      { kind: 'code', language: 'yaml', text: 'jobs:\n  build:' },
    ]);
  });

  it('leaves an ```action fence as a code block rather than dropping it', () => {
    // Belt and braces: ChatMessageView strips the action block before this
    // parser ever sees it, but if one did arrive it must be visible, never
    // silently swallowed.
    const blocks = parseMarkdown('```action\n{"type":"addJob"}\n```');
    expect(blocks[0]).toEqual({
      kind: 'code',
      language: 'action',
      text: '{"type":"addJob"}',
    });
  });

  it('parses bullet and ordered lists, including nesting', () => {
    const blocks = parseMarkdown(
      ['- first', '- second', '  - nested', '', '1. one', '2. two'].join('\n'),
    );

    expect(blocks).toHaveLength(2);
    const bullets = blocks[0]!;
    expect(bullets.kind).toBe('list');
    if (bullets.kind !== 'list') throw new Error('expected a list');
    expect(bullets.ordered).toBe(false);
    expect(bullets.items).toHaveLength(2);
    expect(bullets.items[1]).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'second' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'paragraph', spans: [{ kind: 'text', text: 'nested' }] }],
        ],
      },
    ]);

    const ordered = blocks[1]!;
    if (ordered.kind !== 'list') throw new Error('expected a list');
    expect(ordered.ordered).toBe(true);
    expect(ordered.items).toHaveLength(2);
  });

  it('parses a block quote and a thematic break', () => {
    expect(parseMarkdown('> quoted\n\n---')).toEqual([
      {
        kind: 'quote',
        blocks: [
          { kind: 'paragraph', spans: [{ kind: 'text', text: 'quoted' }] },
        ],
      },
      { kind: 'rule' },
    ]);
  });

  it('parses a pipe table, and only when a delimiter row says so', () => {
    const table = parseMarkdown(
      ['| Key | Meaning |', '| --- | --- |', '| `docker` | An executor |'].join(
        '\n',
      ),
    );
    expect(table[0]).toEqual({
      kind: 'table',
      header: [
        [{ kind: 'text', text: 'Key' }],
        [{ kind: 'text', text: 'Meaning' }],
      ],
      rows: [
        [
          [{ kind: 'code', text: 'docker' }],
          [{ kind: 'text', text: 'An executor' }],
        ],
      ],
    });

    // Prose that merely contains a pipe is prose.
    expect(parseMarkdown('run: a | b')[0]?.kind).toBe('paragraph');
  });
});

describe('parseInline', () => {
  it('parses strong, emphasis and code', () => {
    expect(parseInline('**bold** and *italic* and `code`')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'italic' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
    ]);
  });

  it('does not read underscores inside an identifier as emphasis', () => {
    // `save_cache`/`restore_cache` are everywhere in this domain; reading them
    // as emphasis would mangle most replies about caching.
    expect(parseInline('use save_cache and restore_cache today')).toEqual([
      { kind: 'text', text: 'use save_cache and restore_cache today' },
    ]);
  });

  it('keeps markup inside a code span literal', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { kind: 'code', text: '**not bold**' },
    ]);
  });

  it('linkifies a safe link, an autolink and a bare URL', () => {
    expect(parseInline('[docs](https://circleci.com/docs/)')).toEqual([
      {
        kind: 'link',
        href: 'https://circleci.com/docs/',
        children: [{ kind: 'text', text: 'docs' }],
      },
    ]);
    expect(parseInline('<https://circleci.com/docs/>')[0]).toMatchObject({
      kind: 'link',
      href: 'https://circleci.com/docs/',
    });
    expect(parseInline('see https://circleci.com/docs/x.')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        href: 'https://circleci.com/docs/x',
        children: [{ kind: 'text', text: 'https://circleci.com/docs/x' }],
      },
      // The full stop is punctuation, not part of the URL.
      { kind: 'text', text: '.' },
    ]);
  });

  it('degrades an unsafe link to its own label, with no href anywhere', () => {
    expect(parseInline('[click me](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'click me' },
    ]);
    expect(
      parseInline('[x](data:text/html,<script>alert(1)</script>)'),
    ).toEqual([{ kind: 'text', text: 'x' }]);
    // A relative target too: it would resolve against this app's own origin,
    // which is the localhost host API.
    expect(parseInline('[key](/api/ai/key)')).toEqual([
      { kind: 'text', text: 'key' },
    ]);
  });

  it('turns a link to an untrusted host into a blockedLink that carries no href', () => {
    // Issue #187: a model can put a link anywhere, so the host allowlist applies
    // in the reply body, not just in the Sources footer. The label survives and
    // the destination host is named -- silently dropping it would hide that the
    // answer pointed somewhere.
    expect(
      parseInline('[join us](https://app.slack.com/client/T0/C0)'),
    ).toEqual([
      {
        kind: 'blockedLink',
        hostname: 'app.slack.com',
        children: [{ kind: 'text', text: 'join us' }],
      },
    ]);
    // A look-alike domain is a host rejection like any other -- and nothing in
    // the inline it produces could ever become an `href`.
    const spans = parseInline(
      '[docs](https://circleci.com.evil.example/docs/)',
    );
    expect(spans).toEqual([
      {
        kind: 'blockedLink',
        hostname: 'circleci.com.evil.example',
        children: [{ kind: 'text', text: 'docs' }],
      },
    ]);
    expect(JSON.stringify(spans)).not.toContain('href');
    // A bare URL to an untrusted host keeps its own text, unlinked.
    expect(parseInline('see https://evil.example/x')[1]).toMatchObject({
      kind: 'blockedLink',
      hostname: 'evil.example',
    });
  });

  it('renders an image as a link, never as an <img>, and drops an unsafe one', () => {
    expect(parseInline('![A diagram](https://circleci.com/x.png)')).toEqual([
      {
        kind: 'link',
        href: 'https://circleci.com/x.png',
        children: [{ kind: 'text', text: 'A diagram' }],
      },
    ]);
    expect(parseInline('![boom](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'boom' },
    ]);
  });

  it('never nests a link inside a link', () => {
    // A URL written inside a link's own label must not become a second,
    // nested anchor: `<a>` inside `<a>` is invalid markup and an ambiguous
    // click target. The text survives; the inner link does not.
    const spans = parseInline(
      '[visit https://evil.example/ now](https://circleci.com/docs/)',
    );
    expect(spans).toEqual([
      {
        kind: 'link',
        href: 'https://circleci.com/docs/',
        children: [{ kind: 'text', text: 'visit https://evil.example/ now' }],
      },
    ]);
  });

  it('treats raw HTML as text, with no tag structure at all', () => {
    expect(parseInline('<script>alert(1)</script>')).toEqual([
      { kind: 'text', text: '<script>alert(1)</script>' },
    ]);
    expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([
      { kind: 'text', text: '<img src=x onerror="alert(1)">' },
    ]);
  });
});
