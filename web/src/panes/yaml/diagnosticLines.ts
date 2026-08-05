/**
 * Marks the lines a validation diagnostic could be placed on, inside the
 * YAML editor itself (issue #148: "display the error somewhere that's easy to
 * see when working with the source view").
 *
 * Only lines that were *resolved* get marked -- see
 * `lib/validation/diagnostics`' location rules. An error CircleCI didn't
 * place, and whose named entity this app couldn't find in the document, gets
 * no mark at all rather than a mark on a plausible-looking line.
 *
 * Line decorations, not a new gutter: adding a gutter shifts the whole
 * editor's content horizontally the moment the first error appears and back
 * again when it's fixed, which is a distracting reflow for a transient state.
 * A tinted line with a left edge marks the same thing without moving
 * anything.
 *
 * Every CodeMirror primitive here is imported from `@uiw/react-codemirror`
 * rather than from `@codemirror/view`/`@codemirror/state` directly -- see
 * `yamlHighlight.ts`'s own comment: those are transitive dependencies under
 * pnpm's non-hoisted layout and are not resolvable from application code.
 */
import {
  Decoration,
  EditorView,
  RangeSetBuilder,
  ViewPlugin,
  type DecorationSet,
  type EditorState,
  type Extension,
  type ViewUpdate,
} from '@uiw/react-codemirror';

export interface DiagnosticMark {
  /** 1-based, as every location in `lib/validation` is. */
  line: number;
  severity: 'error' | 'warning';
  /** True for the diagnostic the strip is currently showing, so "the one I'm looking at" is distinguishable from "also broken". */
  primary: boolean;
  /** Shown as the line's `title`, so hovering explains the tint. Keyboard users get the same text in the strip, which is the primary path. */
  message: string;
}

function buildDecorations(
  state: EditorState,
  marks: readonly DiagnosticMark[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  // Sorted and deduped: `RangeSetBuilder` requires ascending positions, and
  // two diagnostics resolving to the same line must not add two decorations
  // at the same offset.
  const ordered = [...marks]
    .filter((mark) => {
      if (mark.line < 1 || mark.line > state.doc.lines) return false;
      if (seen.has(mark.line)) return false;
      seen.add(mark.line);
      return true;
    })
    .sort((a, b) => a.line - b.line);

  for (const mark of ordered) {
    const line = state.doc.line(mark.line);
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: `vce-diagnostic-line vce-diagnostic-line--${mark.severity}${
          mark.primary ? ' vce-diagnostic-line--primary' : ''
        }`,
        attributes: { title: mark.message },
      }),
    );
  }
  return builder.finish();
}

/**
 * An extension marking `marks`' lines. Rebuilt (by `YamlPane` recreating its
 * `extensions` array) whenever the mark set changes, which is the same
 * mechanism the pane already uses for its theme and completion sources.
 */
export function diagnosticLineHighlight(
  marks: readonly DiagnosticMark[],
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, marks);
      }

      update(update: ViewUpdate) {
        // Only the document can move a line's offsets; the mark set itself
        // changing arrives as a whole new extension, not as an update.
        if (update.docChanged) {
          this.decorations = buildDecorations(update.state, marks);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * Puts the cursor at `line`/`column` (both 1-based) and scrolls it into
 * view, centred. Clamped to the document so a stale location -- an error
 * resolved against text the user has since shortened -- moves the cursor
 * somewhere valid instead of throwing.
 */
export function goToLine(view: EditorView, line: number, column: number): void {
  const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
  const target = view.state.doc.line(clampedLine);
  const pos = Math.min(target.from + Math.max(0, column - 1), target.to);
  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
}
