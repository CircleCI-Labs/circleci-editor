import { yamlLanguage } from '@codemirror/lang-yaml';
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
 * CircleCI's real CodeMirror syntax colours (recovered from
 * CircleCI's production web UI /
 * `codeMirrorTheme.ts`), mapped onto the actual node names the
 * `@lezer/yaml` grammar produces.
 *
 * --- Why this isn't `HighlightStyle.define([...])` + `syntaxHighlighting(...)` ---
 *
 * The idiomatic way to do this is a `@lezer/highlight` `tags`-keyed
 * `HighlightStyle` wired through `@codemirror/language`'s
 * `syntaxHighlighting()`. Both of those packages are only *transitive*
 * dependencies here (of `@codemirror/lang-yaml` / `@uiw/react-codemirror`),
 * not direct dependencies of `web/package.json`. Under pnpm's default
 * (non-hoisted) node_modules layout, a package's transitive dependencies
 * are only resolvable from *inside that package* -- not from application
 * code -- so `import { tags } from '@lezer/highlight'` and
 * `import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'`
 * both fail to resolve from this file. Verified empirically: running either
 * import through `vitest` (which uses Vite's resolver) throws
 * "Failed to resolve import ... Does the file exist?"; `node -e
 * "require.resolve('@lezer/highlight')"` from `web/` throws
 * `MODULE_NOT_FOUND`. This styling pass is not permitted to edit
 * `package.json`, so adding them as direct dependencies isn't an option
 * here -- that's the recommended follow-up (see the pass report).
 *
 * Instead, this walks the *real* `@lezer/yaml` parse tree ourselves, via
 * `yamlLanguage.parser` (reachable because `@codemirror/lang-yaml` *is* a
 * direct dependency already), and hand-applies CSS classes. The mapping
 * below was produced empirically, not guessed: see
 * `yamlHighlight.test.ts`, which parses representative CircleCI-shaped YAML
 * (plain/quoted/block-literal scalars, comments, block + flow collections,
 * anchors/aliases/tags) and asserts on `tree.cursor()` node names. The
 * grammar's real node set turned out to be:
 *
 *   Stream, Document, BlockMapping, BlockSequence, FlowMapping,
 *   FlowSequence, Pair, Item, Key, Literal, QuotedLiteral, Comment,
 *   Anchored, Anchor, Alias, Tagged, Tag, BlockLiteral,
 *   BlockLiteralHeader, BlockLiteralContent, plus punctuation leaves
 *   ':' '-' ',' '{' '}' '[' ']'.
 *
 * Notably, `@lezer/yaml` does *not* give numbers/booleans/null their own
 * node type the way e.g. `@lezer/json` does -- a bare `true`, `3`, or
 * `null` all parse as a plain `Literal`, indistinguishable from a plain
 * unquoted string like `cimg/node:20.1`, at the tree level. We recover
 * that distinction the same way CircleCI's own grammar-agnostic themes do:
 * by pattern-matching the literal's text.
 *
 * Also notable: a mapping key is always a `Key` node whose *only* child is
 * either a `Literal` or `QuotedLiteral` covering the exact same
 * `[from, to)` range (e.g. an unquoted `build:` produces `Key [33-38]`
 * wrapping `Literal [33-38]`, byte-for-byte identical range; a quoted
 * `"quoted key":` produces `Key [332-344]` wrapping `QuotedLiteral
 * [332-344]`). So we style whole `Key` nodes directly and skip descending
 * into their children, rather than double-marking the same span.
 */

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_OR_NULL_RE =
  /^(?:true|false|null|~|True|False|Null|TRUE|FALSE|NULL)$/;

// `as const`: keeps these as string *literal* types (not widened to plain
// `string`), so `YamlClassName` below is a closed union rather than just
// `string` -- that's what lets `Record<YamlClassName, string>` (the colour
// maps further down) be indexed without `noUncheckedIndexedAccess` treating
// every lookup as possibly `undefined`.
export const YAML_PROPERTY_CLASS = 'cm-yaml-property' as const;
export const YAML_STRING_CLASS = 'cm-yaml-string' as const;
export const YAML_SCALAR_CLASS = 'cm-yaml-scalar' as const;
export const YAML_COMMENT_CLASS = 'cm-yaml-comment' as const;
export const YAML_PUNCTUATION_CLASS = 'cm-yaml-punctuation' as const;

export type YamlClassName =
  | typeof YAML_PROPERTY_CLASS
  | typeof YAML_STRING_CLASS
  | typeof YAML_SCALAR_CLASS
  | typeof YAML_COMMENT_CLASS
  | typeof YAML_PUNCTUATION_CLASS;

// Leaf punctuation node names @lezer/yaml emits as their own tokens.
const PUNCTUATION_NODE_NAMES = new Set([':', '-', ',', '{', '}', '[', ']']);

function classifyLiteralText(text: string): string {
  return BOOLEAN_OR_NULL_RE.test(text) || NUMBER_RE.test(text)
    ? YAML_SCALAR_CLASS
    : YAML_STRING_CLASS;
}

export interface YamlHighlightMark {
  from: number;
  to: number;
  className: string;
}

/**
 * Walks the real `@lezer/yaml` parse tree for `doc` and returns the flat
 * list of highlight marks it produced. Exported (in addition to
 * `buildYamlDecorations`) so tests can assert on plain data without
 * needing a live `EditorView`.
 */
export function computeYamlHighlightMarks(doc: string): YamlHighlightMark[] {
  const tree = yamlLanguage.parser.parse(doc);
  const marks: YamlHighlightMark[] = [];

  tree.iterate({
    enter(node) {
      const name = node.type.name;

      if (
        name === 'Key' ||
        name === 'Tag' ||
        name === 'Anchor' ||
        name === 'Alias'
      ) {
        marks.push({
          from: node.from,
          to: node.to,
          className: YAML_PROPERTY_CLASS,
        });
        return false;
      }
      if (name === 'Comment') {
        marks.push({
          from: node.from,
          to: node.to,
          className: YAML_COMMENT_CLASS,
        });
        return false;
      }
      if (name === 'QuotedLiteral' || name === 'BlockLiteralContent') {
        marks.push({
          from: node.from,
          to: node.to,
          className: YAML_STRING_CLASS,
        });
        return false;
      }
      if (name === 'Literal') {
        const text = doc.slice(node.from, node.to);
        marks.push({
          from: node.from,
          to: node.to,
          className: classifyLiteralText(text),
        });
        return false;
      }
      if (name === 'BlockLiteralHeader' || PUNCTUATION_NODE_NAMES.has(name)) {
        marks.push({
          from: node.from,
          to: node.to,
          className: YAML_PUNCTUATION_CLASS,
        });
        return false;
      }
      return true;
    },
  });

  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  return marks;
}

export function buildYamlDecorations(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const mark of computeYamlHighlightMarks(doc)) {
    if (mark.from === mark.to) continue;
    builder.add(mark.from, mark.to, Decoration.mark({ class: mark.className }));
  }
  return builder.finish();
}

/**
 * The colour half of the mapping -- CircleCI's real CodeMirror syntax
 * palette for dark mode (see `YAML_LIGHT_COLORS` below for light).
 *
 * CircleCI's production web UI never ships a light-mode variant of this
 * editor at all (`CodeMirrorEditor.tsx` always passes its one
 * `circleciDarkTheme`) -- so unlike the dark values, which are recovered
 * ground truth, `YAML_LIGHT_COLORS` is derived, not sourced: same
 * per-token hue as dark, lightness/saturation re-picked for AA on a white
 * editor background instead of dark navy, and measured (see
 * `YamlPane.tsx`'s light editor-chrome comment for the shared background
 * these are measured against). `YAML_STRING_CLASS` and
 * `YAML_PUNCTUATION_CLASS` intentionally stay close to the plain
 * foreground colour in both palettes, matching how dark's `#ffffff`
 * (string) and `#ededed` (punctuation) are themselves barely distinguishable
 * from `YamlPane.tsx`'s `#ededed` editor foreground -- i.e. "not specially
 * coloured" is the dark-mode convention being preserved, not a light-mode
 * invention.
 */
// Exported for `yamlHighlight.test.ts` only, so the AA claims in the
// comments above can be asserted on directly instead of taken on faith.
export const YAML_DARK_COLORS: Record<YamlClassName, string> = {
  [YAML_PROPERTY_CLASS]: '#FFF38D',
  [YAML_STRING_CLASS]: '#ffffff',
  [YAML_SCALAR_CLASS]: '#B5CEA8',
  [YAML_COMMENT_CLASS]: '#959595',
  [YAML_PUNCTUATION_CLASS]: '#ededed',
};

// Measured against the light editor background (#ffffff, see
// `YamlPane.tsx`): property 6.25:1, scalar 5.40:1, comment 5.41:1 --
// string/punctuation reuse the editor's own >4.5:1 foreground colour, so
// they're not re-measured here.
export const YAML_LIGHT_COLORS: Record<YamlClassName, string> = {
  [YAML_PROPERTY_CLASS]: '#7a5c00',
  [YAML_STRING_CLASS]: '#161f2e',
  [YAML_SCALAR_CLASS]: '#0f7a45',
  [YAML_COMMENT_CLASS]: '#6a6a6a', // reuses --color-cc-text-faint's light value
  [YAML_PUNCTUATION_CLASS]: '#2e3c52',
};

/**
 * This must be `EditorView.theme` at `Prec.highest`, not
 * `EditorView.baseTheme`. A base theme is deliberately the lowest-precedence
 * styling layer (it exists so extension authors can be overridden), so
 * CodeMirror's own defaultHighlightStyle won every token and rendered YAML
 * keys in its default light-theme blue (#0000cc) -- about 1:1 contrast
 * against this pane's dark navy background, i.e. invisible. Measured before
 * this was corrected; see `YamlPane.tsx`'s `basicSetup.syntaxHighlighting:
 * false` for the other half of that same fix (turning off the thing this
 * would otherwise have to out-rank).
 *
 * `theme` selects which of `YAML_DARK_COLORS`/`YAML_LIGHT_COLORS` this
 * instance paints and sets CodeMirror's own `{ dark }` flag to match --
 * callers (`YamlPane.tsx`) rebuild this whenever the resolved app theme
 * (issue #52) changes, the same way `yamlSyntaxHighlighting` below does.
 */
export function yamlHighlightTheme(theme: ResolvedTheme) {
  const colors = theme === 'dark' ? YAML_DARK_COLORS : YAML_LIGHT_COLORS;
  return Prec.highest(
    EditorView.theme(
      {
        [`.${YAML_PROPERTY_CLASS}`]: { color: colors[YAML_PROPERTY_CLASS] },
        [`.${YAML_STRING_CLASS}`]: { color: colors[YAML_STRING_CLASS] },
        [`.${YAML_SCALAR_CLASS}`]: { color: colors[YAML_SCALAR_CLASS] },
        [`.${YAML_COMMENT_CLASS}`]: {
          color: colors[YAML_COMMENT_CLASS],
          fontStyle: 'italic',
        },
        [`.${YAML_PUNCTUATION_CLASS}`]: {
          color: colors[YAML_PUNCTUATION_CLASS],
        },
      },
      { dark: theme === 'dark' },
    ),
  );
}

export const yamlSyntaxHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildYamlDecorations(view.state.doc.toString());
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildYamlDecorations(update.state.doc.toString());
      }
    }
  },
  { decorations: (instance) => instance.decorations },
);

/** The full extension: colours (for `theme`) plus the tree-driven decoration source. */
export function yamlSyntaxHighlighting(theme: ResolvedTheme) {
  return [yamlHighlightTheme(theme), yamlSyntaxHighlightPlugin];
}
