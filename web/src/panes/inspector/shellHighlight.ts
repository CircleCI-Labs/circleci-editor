import { shell } from '@codemirror/legacy-modes/mode/shell';
import { StreamLanguage } from '@codemirror/language';
import {
  Decoration,
  Prec,
  type DecorationSet,
  EditorView,
  RangeSetBuilder,
  ViewPlugin,
  type ViewUpdate,
} from '@uiw/react-codemirror';

import type { ResolvedTheme } from '~/state/themeStore';

/**
 * Issue #86 part 2: `run.command` is shell, not YAML, and beefy commands
 * are common -- this gives it real syntax highlighting (plus line numbers,
 * wired in `Inspector.tsx`'s `CommandField`) instead of flat monospace
 * text.
 *
 * --- Why `@codemirror/legacy-modes`, and why this walks a tree instead of
 *     a `HighlightStyle` ---
 *
 * There is no `@codemirror/lang-shell` (unlike YAML's real Lezer grammar,
 * `@codemirror/lang-yaml`) -- shell's own grammar is contextual enough
 * (heredocs, nested quoting, `$(...)` command substitution) that no
 * maintained Lezer package exists for it. `@codemirror/legacy-modes` ships
 * CodeMirror 5-style hand-written stream tokenizers, including `mode/shell`,
 * wrapped for CM6 via `@codemirror/language`'s `StreamLanguage`. Bundle
 * cost: each mode is its own ES module (`@codemirror/legacy-modes/mode/
 * shell.js`, ~4.5KB unminified, no shared runtime beyond `StreamLanguage`
 * itself); importing only that subpath -- not `@codemirror/legacy-modes`'s
 * barrel, which re-exports every language it ships (Python, PHP, Ruby, ...,
 * ~2MB unpacked) -- means Vite/Rollup's tree-shaking only bundles the one
 * mode actually imported. Measured via `pnpm -C web build` (before/after
 * this change, same commit otherwise): the `codemirror` chunk grew from
 * 433.53 kB to 443.70 kB raw (142.43 kB to 146.03 kB gzip, +3.60 kB), and
 * the app's own `index` chunk (where this module itself lands) grew from
 * 252.17 kB to 253.85 kB raw (78.20 kB to 78.95 kB gzip, +0.75 kB) -- a
 * ~4.35 kB gzip total, nowhere near the whole package's ~2MB unpacked size.
 *
 * `StreamLanguage.define(shell).parser` still produces a real, walkable
 * Lezer-shaped `Tree` (confirmed empirically, the same way
 * `../yaml/yamlHighlight.ts`'s own module comment confirms `@lezer/yaml`'s
 * node set: see `shellHighlight.test.ts`) -- `StreamLanguage` maps each
 * CM5-style token string the shell tokenizer returns (`"keyword"`,
 * `"string"`, `"comment"`, `"variable"`, ...) onto a `@lezer/highlight` tag,
 * and each resulting tree node's `type.name` is that tag's own dotted
 * string form (e.g. `"variableName.definition"`, `"string.special"`). That
 * means this can walk the tree and hand-classify by name exactly like
 * `yamlHighlight.ts` does for `@lezer/yaml` -- without needing
 * `@codemirror/language`'s `HighlightStyle`/`syntaxHighlighting` or
 * `@lezer/highlight`'s `tags` object at all, so this doesn't reintroduce
 * `yamlHighlight.ts`'s own documented precedence trap (`basicSetup`'s
 * default `syntaxHighlighting` painting invisible text): there is no
 * competing highlighter here to lose to, only this module's own
 * `Decoration.mark` spans, exactly as YAML's already are.
 */

const NODE_NAME_TO_CLASS: Record<string, string> = {
  keyword: 'cm-sh-keyword',
  string: 'cm-sh-string',
  quote: 'cm-sh-string', // `$(...)` command substitution -- see this module's own doc comment.
  comment: 'cm-sh-comment',
  meta: 'cm-sh-comment', // The `#!/bin/bash` shebang line.
  number: 'cm-sh-number',
  variableName: 'cm-sh-variable',
  attributeName: 'cm-sh-punctuation', // Command flags (`-euo`, `-eq`, ...).
  operator: 'cm-sh-punctuation',
};

export const SHELL_KEYWORD_CLASS = 'cm-sh-keyword' as const;
export const SHELL_STRING_CLASS = 'cm-sh-string' as const;
export const SHELL_COMMENT_CLASS = 'cm-sh-comment' as const;
export const SHELL_NUMBER_CLASS = 'cm-sh-number' as const;
export const SHELL_VARIABLE_CLASS = 'cm-sh-variable' as const;
export const SHELL_PUNCTUATION_CLASS = 'cm-sh-punctuation' as const;

export type ShellClassName =
  | typeof SHELL_KEYWORD_CLASS
  | typeof SHELL_STRING_CLASS
  | typeof SHELL_COMMENT_CLASS
  | typeof SHELL_NUMBER_CLASS
  | typeof SHELL_VARIABLE_CLASS
  | typeof SHELL_PUNCTUATION_CLASS;

/** The one `Language` this whole module wraps -- built once, not per keystroke. */
const shellLanguage = StreamLanguage.define(shell);

export interface ShellHighlightMark {
  from: number;
  to: number;
  className: string;
}

/**
 * Walks the real (stream-tokenizer-backed) shell parse tree for `doc` and
 * returns the flat list of highlight marks it produced. `node.type.name` is
 * always the tag's dotted string form (e.g. `"variableName.definition"`) --
 * classified by its first segment (`.split('.')[0]`) so every variant of a
 * tag family (`variableName.standard`/`variableName.definition`,
 * `string`/`string.special`) maps to the one class each family gets here,
 * without this module having to enumerate every dotted variant the
 * tokenizer might emit.
 */
export function computeShellHighlightMarks(doc: string): ShellHighlightMark[] {
  const tree = shellLanguage.parser.parse(doc);
  const marks: ShellHighlightMark[] = [];

  tree.iterate({
    enter(node) {
      const base = node.type.name.split('.')[0]!;
      const className = NODE_NAME_TO_CLASS[base];
      if (className) marks.push({ from: node.from, to: node.to, className });
    },
  });

  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  return marks;
}

export function buildShellDecorations(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const mark of computeShellHighlightMarks(doc)) {
    if (mark.from === mark.to) continue;
    builder.add(mark.from, mark.to, Decoration.mark({ class: mark.className }));
  }
  return builder.finish();
}

/**
 * Dark-mode shell syntax colours, chosen (not recovered -- unlike
 * `yamlHighlight.ts`'s YAML palette, there is no ground-truth CircleCI
 * shell-highlighting theme to borrow from) for AA contrast against
 * `../yaml/editorTheme.ts`'s shared dark editor background (`#1c273a`).
 * Measured in `shellHighlight.test.ts`, the same way as YAML's own claims.
 */
// Exported for `shellHighlight.test.ts` only, so the AA claims above are
// asserted on directly instead of taken on faith.
export const SHELL_DARK_COLORS: Record<ShellClassName, string> = {
  [SHELL_KEYWORD_CLASS]: '#c586c0',
  [SHELL_STRING_CLASS]: '#98c379',
  [SHELL_COMMENT_CLASS]: '#959595',
  [SHELL_NUMBER_CLASS]: '#d19a66',
  [SHELL_VARIABLE_CLASS]: '#7fb4e0',
  [SHELL_PUNCTUATION_CLASS]: '#b0b8c4',
};

/** Light-mode counterpart, re-picked (same hue per class as dark) for AA on the shared white editor background. */
export const SHELL_LIGHT_COLORS: Record<ShellClassName, string> = {
  [SHELL_KEYWORD_CLASS]: '#9333a4',
  [SHELL_STRING_CLASS]: '#1a7f37',
  [SHELL_COMMENT_CLASS]: '#6a6a6a',
  [SHELL_NUMBER_CLASS]: '#a15c00',
  [SHELL_VARIABLE_CLASS]: '#0b5fa5',
  [SHELL_PUNCTUATION_CLASS]: '#3c4656',
};

/**
 * `Prec.highest`, not `EditorView.baseTheme`, for the same reason as
 * `yamlHighlight.ts`'s `yamlHighlightTheme` -- see that function's own doc
 * comment for the regression this avoids repeating.
 */
export function shellHighlightTheme(theme: ResolvedTheme) {
  const colors = theme === 'dark' ? SHELL_DARK_COLORS : SHELL_LIGHT_COLORS;
  return Prec.highest(
    EditorView.theme(
      {
        [`.${SHELL_KEYWORD_CLASS}`]: { color: colors[SHELL_KEYWORD_CLASS] },
        [`.${SHELL_STRING_CLASS}`]: { color: colors[SHELL_STRING_CLASS] },
        [`.${SHELL_COMMENT_CLASS}`]: {
          color: colors[SHELL_COMMENT_CLASS],
          fontStyle: 'italic',
        },
        [`.${SHELL_NUMBER_CLASS}`]: { color: colors[SHELL_NUMBER_CLASS] },
        [`.${SHELL_VARIABLE_CLASS}`]: { color: colors[SHELL_VARIABLE_CLASS] },
        [`.${SHELL_PUNCTUATION_CLASS}`]: {
          color: colors[SHELL_PUNCTUATION_CLASS],
        },
      },
      { dark: theme === 'dark' },
    ),
  );
}

export const shellSyntaxHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildShellDecorations(view.state.doc.toString());
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildShellDecorations(update.state.doc.toString());
      }
    }
  },
  { decorations: (instance) => instance.decorations },
);

/** The full extension: colours (for `theme`) plus the tree-driven decoration source. */
export function shellSyntaxHighlighting(theme: ResolvedTheme) {
  return [shellHighlightTheme(theme), shellSyntaxHighlightPlugin];
}
