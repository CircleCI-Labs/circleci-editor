import { describe, expect, it } from 'vitest';

import { AA_NORMAL_TEXT, contrastRatio, type Rgb } from '~/lib/color/contrast';
import {
  SHELL_DARK_COLORS,
  SHELL_LIGHT_COLORS,
} from '~/panes/inspector/shellHighlight';
import {
  YAML_DARK_COLORS,
  YAML_LIGHT_COLORS,
} from '~/panes/yaml/yamlHighlight';

import { highlightLanguageFor, toHighlightSegments } from './codeHighlight';

describe('highlightLanguageFor', () => {
  it('maps every YAML spelling this app declares to "yaml"', () => {
    expect(highlightLanguageFor('yaml')).toBe('yaml');
    expect(highlightLanguageFor('yml')).toBe('yaml');
  });

  it('maps every shell spelling this app declares to "shell"', () => {
    expect(highlightLanguageFor('sh')).toBe('shell');
    expect(highlightLanguageFor('bash')).toBe('shell');
    expect(highlightLanguageFor('zsh')).toBe('shell');
    expect(highlightLanguageFor('shell')).toBe('shell');
    expect(highlightLanguageFor('console')).toBe('shell');
  });

  it('never guesses: an unsupported or absent language is undefined, not a fallback grammar', () => {
    // Issue #291: a wrongly-highlighted block reads as authoritative and
    // misleads, so "we don't recognise this" must stay a distinct outcome
    // from "we recognise this as yaml/shell" -- never coerced to one of them.
    expect(highlightLanguageFor('json')).toBeUndefined();
    expect(highlightLanguageFor('python')).toBeUndefined();
    expect(highlightLanguageFor('javascript')).toBeUndefined();
    expect(highlightLanguageFor(undefined)).toBeUndefined();
    expect(highlightLanguageFor('')).toBeUndefined();
  });
});

describe('toHighlightSegments', () => {
  it('covers the whole document exactly once, in order', () => {
    const doc = 'key: value';
    const segments = toHighlightSegments(doc, [
      { from: 0, to: 3, className: 'cm-yaml-property' },
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe(doc);
  });

  it('flattens nested marks outermost-first rather than emitting overlaps', () => {
    // The shell tokenizer really does nest (a `string` inside a `quote`), and a
    // flat list of spans cannot represent an overlap.
    const doc = 'echo "$(date)"';
    const segments = toHighlightSegments(doc, [
      { from: 5, to: 14, className: 'cm-sh-string' },
      { from: 6, to: 13, className: 'cm-sh-variable' },
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe(doc);
    expect(
      segments.filter((segment) => segment.className !== undefined),
    ).toHaveLength(1);
  });
});

/**
 * The editor's syntax palettes were contrast-measured against the *editor's*
 * own background (`#1c273a` dark, white light -- see `yamlHighlight.ts` and
 * `shellHighlight.ts`). Every surface this module's `HighlightedCode` actually
 * gets painted on (the chat transcript's `--color-cc-panel`, and the
 * reference pane's guide code blocks, `GuideBlocks.tsx`, also on
 * `--color-cc-panel` as of issue #291) is different from that, so reusing
 * these colours is only legitimate if they still clear AA there. Measured
 * here rather than asserted in a comment, the same way those two modules
 * measure their own claims.
 *
 * `--color-cc-panel-raised` was tried and rejected for the guide code blocks
 * specifically because it does *not* clear AA in light mode: the shell
 * palette's `string` (#1a7f37) and `number` (#a15c00) colours measure
 * 4.37:1 and 4.47:1 against it (`rgb(236, 238, 242)`, `--color-neutral-30`),
 * both under the 4.5:1 floor -- which is exactly the kind of regression
 * issue #291 warns "code text on a code background is where contrast gets
 * forgotten". `--color-cc-panel` is the surface both callers are proven
 * against below.
 */
describe('code-block syntax colours on --color-cc-panel', () => {
  // Resolved from `src/styles.css`: `oklch(23.8% 0.032 260.4)` in dark mode,
  // which is rgb(22, 31, 46) -- and plain white in light mode.
  const DARK_PANEL: Rgb = { r: 22, g: 31, b: 46 };
  const LIGHT_PANEL: Rgb = { r: 255, g: 255, b: 255 };

  function rgbFromHex(hex: string): Rgb {
    const value = hex.replace('#', '');
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
    };
  }

  function belowAA(palette: Record<string, string>, background: Rgb): string[] {
    return Object.entries(palette)
      .map(([name, hex]) => ({
        name,
        hex,
        ratio: contrastRatio(rgbFromHex(hex), background),
      }))
      .filter(({ ratio }) => ratio < AA_NORMAL_TEXT)
      .map(({ name, hex, ratio }) => `${name} ${hex} = ${ratio.toFixed(2)}:1`);
  }

  it('clears AA for every dark-mode token colour', () => {
    // Measured: the tightest is the comment colour at 5.52:1 -- better than
    // the 5.01:1 the same colour scores on the editor's own background.
    expect(
      belowAA({ ...YAML_DARK_COLORS, ...SHELL_DARK_COLORS }, DARK_PANEL),
    ).toEqual([]);
  });

  it('clears AA for every light-mode token colour', () => {
    // Light mode is the identical surface (white), so these are the editor's
    // own measurements: tightest 5.08:1.
    expect(
      belowAA({ ...YAML_LIGHT_COLORS, ...SHELL_LIGHT_COLORS }, LIGHT_PANEL),
    ).toEqual([]);
  });
});
