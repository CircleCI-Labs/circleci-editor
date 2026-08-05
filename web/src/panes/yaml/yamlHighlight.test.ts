import { describe, expect, it } from 'vitest';

import { type Rgb, AA_NORMAL_TEXT, contrastRatio } from '~/lib/color/contrast';

import {
  YAML_COMMENT_CLASS,
  YAML_DARK_COLORS,
  YAML_LIGHT_COLORS,
  YAML_PROPERTY_CLASS,
  YAML_PUNCTUATION_CLASS,
  YAML_SCALAR_CLASS,
  YAML_STRING_CLASS,
  computeYamlHighlightMarks,
  yamlHighlightTheme,
  yamlSyntaxHighlighting,
  type YamlClassName,
} from './yamlHighlight';

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function markAt(doc: string, from: number, to: number) {
  return computeYamlHighlightMarks(doc).find(
    (m) => m.from === from && m.to === to,
  );
}

function textOfClass(doc: string, className: string): string[] {
  return computeYamlHighlightMarks(doc)
    .filter((m) => m.className === className)
    .map((m) => doc.slice(m.from, m.to));
}

describe('computeYamlHighlightMarks', () => {
  const sample = [
    '# a comment',
    'version: 2.1',
    'jobs:',
    '  build:',
    '    docker:',
    '      - image: cimg/node:20.1',
    '    steps:',
    '      - checkout',
    '      - run:',
    '          name: "Install deps"',
    '          command: npm ci',
    '    parameters:',
    '      flag:',
    '        type: boolean',
    '        default: true',
    '      nothing: null',
    '      neg: -12.5',
    '      "quoted key": value',
  ].join('\n');

  it('marks unquoted keys as property tokens covering the key text only', () => {
    const mark = markAt(
      sample,
      sample.indexOf('version'),
      sample.indexOf('version') + 'version'.length,
    );
    expect(mark?.className).toBe(YAML_PROPERTY_CLASS);
  });

  it('marks quoted keys as property tokens (not string tokens)', () => {
    const from = sample.indexOf('"quoted key"');
    const to = from + '"quoted key"'.length;
    const mark = markAt(sample, from, to);
    expect(mark?.className).toBe(YAML_PROPERTY_CLASS);
  });

  it('marks quoted scalar values as string tokens', () => {
    const from = sample.indexOf('"Install deps"');
    const to = from + '"Install deps"'.length;
    const mark = markAt(sample, from, to);
    expect(mark?.className).toBe(YAML_STRING_CLASS);
  });

  it('marks plain unquoted scalar values as string tokens', () => {
    expect(textOfClass(sample, YAML_STRING_CLASS)).toEqual(
      expect.arrayContaining(['cimg/node:20.1', 'checkout', 'npm ci', 'value']),
    );
  });

  it('marks booleans, null, and numbers (including negative floats) as scalar tokens, distinct from strings', () => {
    expect(textOfClass(sample, YAML_SCALAR_CLASS)).toEqual(
      expect.arrayContaining(['2.1', 'true', 'null', '-12.5']),
    );
  });

  it('marks comments as comment tokens', () => {
    const mark = markAt(sample, 0, '# a comment'.length);
    expect(mark?.className).toBe(YAML_COMMENT_CLASS);
  });

  it('marks structural punctuation (colons, dashes) as punctuation tokens', () => {
    const colonIndex = sample.indexOf(':');
    const mark = markAt(sample, colonIndex, colonIndex + 1);
    expect(mark?.className).toBe(YAML_PUNCTUATION_CLASS);
  });

  it('does not double-mark a key and its inner literal/quoted-literal', () => {
    const marks = computeYamlHighlightMarks(sample);
    const versionFrom = sample.indexOf('version');
    const overlapping = marks.filter(
      (m) => m.from <= versionFrom && m.to >= versionFrom + 'version'.length,
    );
    expect(overlapping).toHaveLength(1);
  });

  it('handles flow collections, anchors, aliases, and tags without throwing', () => {
    const doc = [
      'flow: {a: 1, b: [1, 2, 3]}',
      'anchored: &anchor value',
      'aliased: *anchor',
      'tagged: !!str 123',
    ].join('\n');
    expect(() => computeYamlHighlightMarks(doc)).not.toThrow();
    expect(textOfClass(doc, YAML_PROPERTY_CLASS)).toEqual(
      expect.arrayContaining([
        'flow',
        'anchored',
        'aliased',
        'tagged',
        '&anchor',
        '*anchor',
        '!!str',
      ]),
    );
  });

  it('treats block literal (|) content as string tokens', () => {
    const doc = 'multi: |\n  line one\n  line two\n';
    expect(textOfClass(doc, YAML_STRING_CLASS).join('\n')).toContain(
      'line one',
    );
  });

  it('produces no zero-width marks', () => {
    const marks = computeYamlHighlightMarks(sample);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.to).toBeGreaterThanOrEqual(mark.from);
    }
  });

  it('produces marks in non-decreasing start-position order', () => {
    const marks = computeYamlHighlightMarks(sample);
    const froms = marks.map((m) => m.from);
    const sortedFroms = [...froms].sort((a, b) => a - b);
    expect(froms).toEqual(sortedFroms);
  });
});

describe('theme-aware syntax colours (issue #52)', () => {
  it('builds a CodeMirror extension for either resolved theme without throwing', () => {
    expect(() => yamlHighlightTheme('dark')).not.toThrow();
    expect(() => yamlHighlightTheme('light')).not.toThrow();
    expect(() => yamlSyntaxHighlighting('dark')).not.toThrow();
    expect(() => yamlSyntaxHighlighting('light')).not.toThrow();
  });

  it('returns a two-element extension array (colours + the decoration plugin) for both themes', () => {
    expect(yamlSyntaxHighlighting('dark')).toHaveLength(2);
    expect(yamlSyntaxHighlighting('light')).toHaveLength(2);
  });

  it('gives every token class a distinct light colour from its dark one -- a real second palette, not a passthrough', () => {
    for (const key of Object.keys(YAML_DARK_COLORS) as YamlClassName[]) {
      expect(YAML_LIGHT_COLORS[key]).toBeDefined();
      expect(YAML_LIGHT_COLORS[key]).not.toBe(YAML_DARK_COLORS[key]);
    }
  });

  // The light editor background this pane actually uses is white (see
  // YamlPane.tsx's editor-chrome comment) -- these are the same AA claims
  // made in yamlHighlight.ts's own comments, checked directly rather than
  // taken on faith.
  const LIGHT_EDITOR_BG = hexToRgb('#ffffff');

  const cases: [YamlClassName, string][] = [
    [YAML_PROPERTY_CLASS, 'property/key'],
    [YAML_SCALAR_CLASS, 'scalar (number/bool/null)'],
    [YAML_COMMENT_CLASS, 'comment'],
    [YAML_STRING_CLASS, 'string (reuses the plain editor foreground)'],
    [YAML_PUNCTUATION_CLASS, 'punctuation'],
  ];

  it.each(cases)(
    'light "%s" (%s) clears AA normal-text contrast (4.5:1) on the white editor background',
    (className) => {
      const ratio = contrastRatio(
        hexToRgb(YAML_LIGHT_COLORS[className]),
        LIGHT_EDITOR_BG,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );
});
