/**
 * The one syntax-highlighting vocabulary this app renders code with outside a
 * live CodeMirror instance -- shared by the AI chat transcript's fenced code
 * blocks (`~/lib/markdown/Markdown`) and the reference pane's vendored guide
 * code samples (`~/panes/docs/GuideBlocks`, issue #291).
 *
 * `computeYamlHighlightMarks` (`~/panes/yaml/yamlHighlight`) and
 * `computeShellHighlightMarks` (`~/panes/inspector/shellHighlight`) are pure
 * functions over a string, so this reuses the *exact* tokenizers and the
 * *exact* (contrast-measured) colour palettes the YAML editor and the
 * inspector's command field paint with a live CodeMirror instance, without
 * mounting one. That is deliberate, not incidental: a second highlighting
 * vocabulary with different colours for the same language would be worse
 * than none -- a `run:` block must look the same wherever it appears. See
 * those two modules for where the palettes come from and how their AA
 * contrast was measured.
 *
 * Only YAML and shell are recognised. Anything else -- `json`, `python`, no
 * declared language at all -- renders as plain monospace text: a
 * wrongly-highlighted block reads as authoritative and misleads, so guessing
 * a grammar is strictly worse than showing none (issue #291).
 */
import { useMemo, type ReactNode } from 'react';

import {
  computeShellHighlightMarks,
  SHELL_COMMENT_CLASS,
  SHELL_DARK_COLORS,
  SHELL_LIGHT_COLORS,
} from '~/panes/inspector/shellHighlight';
import {
  computeYamlHighlightMarks,
  YAML_COMMENT_CLASS,
  YAML_DARK_COLORS,
  YAML_LIGHT_COLORS,
} from '~/panes/yaml/yamlHighlight';
import { useThemeStore, type ResolvedTheme } from '~/state/themeStore';

/** The languages this renderer can highlight. */
export type HighlightLanguage = 'yaml' | 'shell';

/**
 * Maps a declared language onto the one this module knows how to highlight,
 * or `undefined` when it doesn't -- including when no language was declared
 * at all. Deliberately narrow, and deliberately never guesses: see the module
 * comment above.
 */
export function highlightLanguageFor(
  language: string | undefined,
): HighlightLanguage | undefined {
  switch (language) {
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
    case 'console':
      return 'shell';
    default:
      return undefined;
  }
}

export interface HighlightSegment {
  text: string;
  className?: string;
}

/**
 * Turns a document plus its highlight marks into a flat list of segments.
 *
 * The tokenizers can emit nested marks (a `string` inside a shell `quote`, for
 * instance), which a CodeMirror `RangeSet` handles natively but a flat list of
 * `<span>`s cannot. Outermost wins: any mark starting before the previous one
 * ended is dropped, which keeps the output non-overlapping and deterministic.
 */
export function toHighlightSegments(
  doc: string,
  marks: { from: number; to: number; className: string }[],
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (const mark of marks) {
    if (mark.from < cursor || mark.to <= mark.from) continue;
    if (mark.from > cursor)
      segments.push({ text: doc.slice(cursor, mark.from) });
    segments.push({
      text: doc.slice(mark.from, mark.to),
      className: mark.className,
    });
    cursor = mark.to;
  }
  if (cursor < doc.length) segments.push({ text: doc.slice(cursor) });
  return segments;
}

/** The static colours for one theme, keyed by the highlighter class names both tokenizers emit. */
function colorsFor(theme: ResolvedTheme): Record<string, string> {
  return theme === 'dark'
    ? { ...YAML_DARK_COLORS, ...SHELL_DARK_COLORS }
    : { ...YAML_LIGHT_COLORS, ...SHELL_LIGHT_COLORS };
}

const ITALIC_CLASSES = new Set<string>([
  YAML_COMMENT_CLASS,
  SHELL_COMMENT_CLASS,
]);

/**
 * Renders `text` as a flat run of `<span>`s, coloured per
 * `highlightLanguageFor(language)`'s tokenizer -- or as one plain, unstyled
 * span when the language is absent or unsupported.
 *
 * Callers own the surrounding `<pre>`/`<code>` (background, border, caption):
 * this only ever returns inline content, so each surface keeps its own
 * chrome. Both current callers put it inside a `<pre className="overflow-x-
 * auto ...">` and nothing else -- no vertical scroll region is introduced
 * here or by them (issue #88).
 *
 * The palettes this draws from (`YAML_DARK_COLORS` etc.) are only
 * contrast-measured against `--color-cc-panel` (`Markdown.test.tsx`'s
 * "code-block syntax colours" suite) -- so a caller must paint its `<pre>`
 * on that token, not `-panel-raised`: two of the shell palette's own colours
 * fall a hair under AA (4.37:1, 4.47:1) against `-panel-raised` in light
 * mode.
 */
export function HighlightedCode({
  text,
  language,
}: {
  text: string;
  language?: string;
}): ReactNode {
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const highlightLanguage = highlightLanguageFor(language);

  const segments = useMemo(() => {
    if (highlightLanguage === undefined) return [{ text }];
    const marks =
      highlightLanguage === 'yaml'
        ? computeYamlHighlightMarks(text)
        : computeShellHighlightMarks(text);
    return toHighlightSegments(text, marks);
  }, [text, highlightLanguage]);

  const colors = colorsFor(resolvedTheme);

  return (
    <>
      {segments.map((segment, index) =>
        segment.className === undefined ? (
          // Segments are a positional, immutable rendering of one code
          // block; there is no stable identity to key on.
          // eslint-disable-next-line react/no-array-index-key
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            style={{
              color: colors[segment.className],
              ...(ITALIC_CLASSES.has(segment.className)
                ? { fontStyle: 'italic' }
                : {}),
            }}
          >
            {segment.text}
          </span>
        ),
      )}
    </>
  );
}
