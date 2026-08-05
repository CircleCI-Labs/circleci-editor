import { EditorView } from '@uiw/react-codemirror';

import type { ResolvedTheme } from '~/state/themeStore';

/**
 * CircleCI's real CodeMirror chrome colours for dark mode (recovered from
 * CircleCI's production web UI /
 * `codeMirrorTheme.ts`): a dark navy editor surface, independent of the
 * app's own panel background, plus matching text/gutter/active-line
 * colours. That component never ships a light-mode variant (issue #52's
 * light half, below, has no ground truth to recover -- see
 * `./yamlHighlight`'s own comment on the same gap for its syntax colours).
 *
 * Factored out of `YamlPane.tsx` (issue #86) so `Inspector.tsx`'s
 * `run.command` editor -- a second, independent CodeMirror instance -- can
 * share this exact chrome instead of hardcoding its own palette (or, as
 * happened before this fix, not theming itself at all: it rendered
 * CodeMirror's default *light* theme unconditionally, which in dark mode
 * put white `.cm-content` text, inherited from this app's own dark-mode
 * `--color-cc-text`, on top of that default theme's white editor
 * background -- an invisible, literal white-on-white pair. Syntax
 * colouring itself is deliberately not part of this shared chrome (each
 * caller's own language has its own palette -- YAML's lives in
 * `./yamlHighlight`, shell's in `../inspector/shellHighlight`); this file
 * supplies only the theme-independent editor surface both share, wired in
 * via `theme="none"` on `<CodeMirror>` so this is the only thing
 * controlling non-syntax styling.
 */
export function buildEditorTheme(theme: ResolvedTheme) {
  const isDark = theme === 'dark';
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: isDark ? '#1c273a' : '#ffffff',
      },
      '.cm-content': {
        fontFamily: 'var(--font-mono)',
        // Light foreground reuses Compass core's light `--text-color-
        // primary` (`--color-neutral-900`, the same real token this app's
        // `:root[data-theme="light"]` block uses for `--color-cc-text`),
        // for the same "no ground truth for this specific editor, so
        // borrow the closest real Compass value" reasoning as the bg below.
        caretColor: isDark ? '#ededed' : '#161f2e',
        color: isDark ? '#ededed' : '#161f2e',
      },
      '.cm-gutters': {
        backgroundColor: isDark ? '#1c273a' : '#ffffff',
        // Dark: the ground-truth gutter colour (#6b7280) only measures
        // 3.10:1 against the ground-truth editor bg (#1c273a) -- below the
        // 4.5:1 AA floor for normal text (one of the failures a previous
        // styling pass fixed). Lightened along the same hue to #8b94a6,
        // which measures 4.92:1, comfortably clearing AA.
        // Light: #4e5a6a (Compass core light `--color-neutral-400`, its
        // light "content tertiary" neutral) measures 7.01:1 on white.
        color: isDark ? '#8b94a6' : '#4e5a6a',
        border: 'none',
      },
      '.cm-activeLine': {
        backgroundColor: isDark ? '#2a3a5a22' : 'rgba(26, 102, 247, 0.06)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: isDark ? '#2a3a5a22' : 'rgba(26, 102, 247, 0.08)',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto' },
      // Switching the CodeMirror `theme` prop from `"dark"`/`"light"` to
      // `"none"` (so our own colours in this file and in each caller's own
      // syntax-highlighting module are the only source of truth) drops
      // @uiw's bundled `oneDarkTheme`/default light theme, either of which
      // used to supply a visible selection/cursor colour. `@codemirror/view`'s
      // own base theme still colours these for a matching `dark` flag (see
      // `&dark .cm-cursor` / `&light .cm-cursor` in its source), but the dark
      // focused-selection variant (`#233`) reads as nearly invisible against
      // our navy `#1c273a` background, so both themes override it explicitly
      // here with a tint of their own accent colour instead.
      '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
        {
          backgroundColor: isDark
            ? 'rgba(169, 201, 252, 0.25)'
            : 'rgba(26, 102, 247, 0.18)',
        },
    },
    { dark: isDark },
  );
}
