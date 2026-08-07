/**
 * The spell-check-style squiggle issue #9 asks for: an inline underline on
 * the exact span a diagnostic's location resolved to, not just a tint on the
 * line it lives on.
 *
 * This is deliberately a second, additive decoration alongside
 * `diagnosticLines.ts`'s whole-line tint (issue #148), not a replacement for
 * it. The two answer different questions: the line tint says "something on
 * this line is wrong" (and is the only thing that still applies when a
 * located node is a whole map or sequence, which has no single "word" to
 * underline), while this draws attention to the specific token the compiler
 * actually named -- an orb reference, a step name, the one map key that
 * isn't permitted. Underlining the whole line for that case would both look
 * wrong (every character squiggled, including the ones that are fine) and
 * be a strictly worse version of the tint that already exists.
 *
 * The hard requirement (issue #9's own framing, and #163 before it): an
 * underline on the wrong span is worse than no underline at all, because it
 * sends the user to correct code. This module only ever draws from
 * `DiagnosticLocation.endLine`/`endColumn` -- fields populated in
 * `locate.ts`'s `locateNode` only when a real document node was found and
 * measured. A diagnostic with no `location`, or a `'reported'` location (a
 * bare point from a YAML parse error, never a span), contributes no mark
 * here; `YamlPane` never even attempts to build one for it.
 *
 * Severity is distinguished by more than colour alone (WCAG 1.4.1, and this
 * project's own contrast-audit standard -- see `e2e/contrast.spec.ts`): an
 * error's squiggle is wavy, a warning's is dashed, so the two remain
 * distinguishable to a colour-blind reader even before the hue registers.
 * Hovering either still surfaces the diagnostic's own words via `title`, the
 * same accessibility fallback `diagnosticLines.ts` already relies on for its
 * line tint -- an underline (of either style) is never the *only* way to
 * learn what is wrong, just the way to learn *where*.
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

export interface UnderlineMark {
  /** 1-based, inclusive -- where the squiggle starts. */
  line: number;
  column: number;
  /** 1-based, exclusive, on the same line as `line` -- see `DiagnosticLocation.endColumn`. */
  endColumn: number;
  severity: 'error' | 'warning';
  /** True for the diagnostic the strip is currently showing -- drawn a shade stronger, mirroring `diagnosticLines.ts`'s `primary` mark. */
  primary: boolean;
  /** The span's `title`, so a mouse-hover (and, per this module's doc comment, not just colour) explains the squiggle. */
  message: string;
}

/** `line`/`column` (both 1-based) to a document offset, clamped into range -- the same clamping `goToLine` already applies, so a stale location (resolved against text since edited) degrades to "somewhere valid" instead of throwing. */
function clampOffset(state: EditorState, line: number, column: number): number {
  const clampedLine = Math.max(1, Math.min(line, state.doc.lines));
  const target = state.doc.line(clampedLine);
  return Math.min(target.from + Math.max(0, column - 1), target.to);
}

function buildDecorations(
  state: EditorState,
  marks: readonly UnderlineMark[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  const ranges = marks
    .map((mark) => ({
      from: clampOffset(state, mark.line, mark.column),
      to: clampOffset(state, mark.line, mark.endColumn),
      mark,
    }))
    // A location clamped against a document the user has since shortened can
    // collapse to an empty span -- `Decoration.mark` requires `from < to`, so
    // this has to be filtered before the builder ever sees it rather than
    // left to throw.
    .filter(({ from, to }) => to > from)
    // `RangeSetBuilder` requires ranges added in ascending (from, to) order
    // -- the same convention `diagnosticLines.ts` and `yamlHighlight.ts`
    // already follow for their own builders.
    .sort((a, b) => a.from - b.from || a.to - b.to);

  for (const { from, to, mark } of ranges) {
    builder.add(
      from,
      to,
      Decoration.mark({
        class: `vce-diagnostic-underline vce-diagnostic-underline--${mark.severity}${
          mark.primary ? ' vce-diagnostic-underline--primary' : ''
        }`,
        attributes: { title: mark.message },
      }),
    );
  }
  return builder.finish();
}

/**
 * An extension underlining `marks`' spans. Rebuilt (by `YamlPane` recreating
 * its `extensions` array whenever the mark set changes) the same way
 * `diagnosticLineHighlight` already is -- see that module's own doc comment
 * for why this is a whole-new-extension swap rather than an imperative
 * update call.
 */
export function diagnosticUnderline(
  marks: readonly UnderlineMark[],
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, marks);
      }

      update(update: ViewUpdate) {
        // Only the document can move an offset; the mark set itself changing
        // arrives as a whole new extension, not as an update -- same
        // reasoning as `diagnosticLineHighlight`.
        if (update.docChanged) {
          this.decorations = buildDecorations(update.state, marks);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
