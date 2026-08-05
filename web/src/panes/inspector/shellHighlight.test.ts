import { describe, expect, it } from 'vitest';

import { type Rgb, AA_NORMAL_TEXT, contrastRatio } from '~/lib/color/contrast';

import {
  SHELL_COMMENT_CLASS,
  SHELL_DARK_COLORS,
  SHELL_KEYWORD_CLASS,
  SHELL_LIGHT_COLORS,
  SHELL_NUMBER_CLASS,
  SHELL_PUNCTUATION_CLASS,
  SHELL_STRING_CLASS,
  SHELL_VARIABLE_CLASS,
  computeShellHighlightMarks,
  shellHighlightTheme,
  shellSyntaxHighlighting,
  type ShellClassName,
} from './shellHighlight';

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function textOfClass(doc: string, className: string): string[] {
  return computeShellHighlightMarks(doc)
    .filter((m) => m.className === className)
    .map((m) => doc.slice(m.from, m.to));
}

describe('computeShellHighlightMarks', () => {
  const sample = [
    '#!/bin/bash',
    '# Run the test suite.',
    'echo "Building $CIRCLE_PROJECT_REPONAME"',
    'if [ -n "$FOO" ]; then',
    '  export RETRIES=3',
    "  echo 'literal $NOTVAR'",
    'fi',
  ].join('\n');

  it('marks the shebang line the same as a comment (both informational, not code)', () => {
    expect(textOfClass(sample, SHELL_COMMENT_CLASS)).toEqual(
      expect.arrayContaining(['#!/bin/bash', '# Run the test suite.']),
    );
  });

  it('marks shell keywords (if/then/fi/export) as keyword tokens', () => {
    expect(textOfClass(sample, SHELL_KEYWORD_CLASS)).toEqual(
      expect.arrayContaining(['if', 'then', 'fi', 'export']),
    );
  });

  it('marks single-quoted strings (no interpolation) as one string token', () => {
    expect(textOfClass(sample, SHELL_STRING_CLASS)).toContain(
      "'literal $NOTVAR'",
    );
  });

  it("marks a double-quoted string's literal text as string tokens, distinct from the $VAR it interpolates", () => {
    // Unlike a single-quoted string, a double-quoted one with a `$VAR`
    // inside it tokenizes as separate fragments (opening-quote-plus-text,
    // the variable, the closing quote) -- real shell semantics (the
    // variable *is* expanded inside double quotes, unlike single), and
    // exactly why this pane's variable class exists as a distinct token
    // family rather than folding into string.
    const stringFragments = textOfClass(sample, SHELL_STRING_CLASS).join('');
    expect(stringFragments).toContain('"Building ');
    expect(textOfClass(sample, SHELL_VARIABLE_CLASS)).toContain(
      '$CIRCLE_PROJECT_REPONAME',
    );
  });

  it('marks a numeric literal as a number token', () => {
    expect(textOfClass(sample, SHELL_NUMBER_CLASS)).toContain('3');
  });

  it('marks variable references and assignment targets as variable tokens', () => {
    const doc = 'FOO=bar\necho "$FOO"\n';
    expect(textOfClass(doc, SHELL_VARIABLE_CLASS).join(' ')).toContain('FOO');
  });

  it('marks command substitution ($(...)) as a string-family token, not left unstyled', () => {
    const doc = 'RESULT=$(git rev-parse --short HEAD)\n';
    const marks = computeShellHighlightMarks(doc);
    const covering = marks.find(
      (m) => m.from <= doc.indexOf('$(') && m.to >= doc.indexOf(')') + 1,
    );
    expect(covering?.className).toBe(SHELL_STRING_CLASS);
  });

  it('marks command flags as punctuation tokens', () => {
    const doc = 'set -euo pipefail\n';
    expect(textOfClass(doc, SHELL_PUNCTUATION_CLASS)).toContain('-euo');
  });

  it('does not throw on heredocs, arrays, and command chaining', () => {
    const doc = [
      "cat <<'EOF' > notes.txt",
      'anything here, even : yaml-looking punctuation',
      'EOF',
      'arr=(1 2 3)',
      'build && echo ok || echo fail',
    ].join('\n');
    expect(() => computeShellHighlightMarks(doc)).not.toThrow();
  });

  it('produces no zero-width marks', () => {
    const marks = computeShellHighlightMarks(sample);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.to).toBeGreaterThanOrEqual(mark.from);
    }
  });

  it('produces marks in non-decreasing start-position order', () => {
    const marks = computeShellHighlightMarks(sample);
    const froms = marks.map((m) => m.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
  });
});

describe('theme-aware shell syntax colours (issue #86)', () => {
  it('builds a CodeMirror extension for either resolved theme without throwing', () => {
    expect(() => shellHighlightTheme('dark')).not.toThrow();
    expect(() => shellHighlightTheme('light')).not.toThrow();
    expect(() => shellSyntaxHighlighting('dark')).not.toThrow();
    expect(() => shellSyntaxHighlighting('light')).not.toThrow();
  });

  it('returns a two-element extension array (colours + the decoration plugin) for both themes', () => {
    expect(shellSyntaxHighlighting('dark')).toHaveLength(2);
    expect(shellSyntaxHighlighting('light')).toHaveLength(2);
  });

  it('gives every token class a distinct light colour from its dark one -- a real second palette, not a passthrough', () => {
    for (const key of Object.keys(SHELL_DARK_COLORS) as ShellClassName[]) {
      expect(SHELL_LIGHT_COLORS[key]).toBeDefined();
      expect(SHELL_LIGHT_COLORS[key]).not.toBe(SHELL_DARK_COLORS[key]);
    }
  });

  // Same shared editor background as `../yaml/editorTheme.ts` (see that
  // module's own comment) -- `CommandField` in `Inspector.tsx` wires that
  // theme in alongside this one, so these are the actual backgrounds this
  // text renders against, not an arbitrary stand-in.
  const DARK_EDITOR_BG = hexToRgb('#1c273a');
  const LIGHT_EDITOR_BG = hexToRgb('#ffffff');

  const cases: [ShellClassName, string][] = [
    [SHELL_KEYWORD_CLASS, 'keyword'],
    [SHELL_STRING_CLASS, 'string'],
    [SHELL_COMMENT_CLASS, 'comment'],
    [SHELL_NUMBER_CLASS, 'number'],
    [SHELL_VARIABLE_CLASS, 'variable'],
    [SHELL_PUNCTUATION_CLASS, 'punctuation'],
  ];

  it.each(cases)(
    'dark "%s" (%s) clears AA normal-text contrast (4.5:1) on the dark editor background',
    (className) => {
      const ratio = contrastRatio(
        hexToRgb(SHELL_DARK_COLORS[className]),
        DARK_EDITOR_BG,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );

  it.each(cases)(
    'light "%s" (%s) clears AA normal-text contrast (4.5:1) on the white editor background',
    (className) => {
      const ratio = contrastRatio(
        hexToRgb(SHELL_LIGHT_COLORS[className]),
        LIGHT_EDITOR_BG,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );
});
