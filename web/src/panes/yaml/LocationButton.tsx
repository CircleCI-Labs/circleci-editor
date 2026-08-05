/**
 * "Where is this?" for one diagnostic, in the two forms it can honestly take:
 * a jump target, or the words "location unknown".
 *
 * Extracted from `DiagnosticsStrip` when config-policy violations arrived
 * (issue #215) so both strips answer the question identically. That matters
 * more than the saved lines: the "unknown" branch is a requirement from #163
 * -- a finding this app cannot place must be shown as unplaced rather than
 * dropped or pinned to a guessed line -- and one implementation cannot drift
 * from itself.
 */
import type { Diagnostic } from '~/lib/validation/diagnostics';

/** The default explanation, written for a compile error. */
const COMPILE_UNKNOWN_TITLE =
  "This error doesn't name a line, and the name it does mention couldn't be matched to a single place in your config -- so there is no line to jump to. The message above is complete.";

export function LocationButton({
  diagnostic,
  onGoToLine,
  unknownTitle = COMPILE_UNKNOWN_TITLE,
}: {
  diagnostic: Diagnostic;
  onGoToLine: (line: number, column: number) => void;
  /** Overrides the hover explanation for the unplaced case, for sources whose reason for having no line differs. */
  unknownTitle?: string;
}) {
  const location = diagnostic.location;
  if (!location) {
    return (
      <span
        className="shrink-0 text-2xs text-cc-text-faint"
        title={unknownTitle}
      >
        Location unknown
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onGoToLine(location.line, location.column)}
      title={
        location.basis === 'reported'
          ? 'The validator quoted this position itself. Jump the cursor there.'
          : 'Resolved by finding the name from the error in your config. Jump the cursor there.'
      }
      className="shrink-0 rounded border border-cc-border-interactive px-1.5 py-0.5 font-mono text-2xs text-cc-text-muted hover:border-cc-accent hover:text-cc-text"
    >
      line {location.line}
      {location.basis === 'resolved' ? '*' : ''}
    </button>
  );
}
