/**
 * Renders the partial failures of `GET /api/project-context` (issue #150).
 *
 * ## Why this is a component and not a `<p>{warning}</p>` loop
 *
 * The owner's report was not "the message is wrong", it was *"I still see all
 * the contexts, so I can't tell whether this matters"*. Both are true at once
 * by design -- contexts are looked up by organization and survive a failed
 * project lookup -- and the old rendering (one undifferentiated amber line per
 * warning) gave no way to size that up. So each warning is shown as what it
 * actually is: the part that failed, the host's diagnosis, and a list of what
 * is consequently missing. A user who reads "the default branch and settings
 * are not shown" while looking at a full context list has their answer.
 *
 * `degraded` is the tone that follows from that. A section that is still doing
 * its main job renders these as a note, not as an alarm -- an amber block over
 * a working list is what made a working editor look broken.
 *
 * ## Suggestions (issue #198)
 *
 * A third list, kept visually distinct from the consequences above it, because
 * "what am I missing" and "what do I do" are different questions and #150's
 * original message answered neither. The host writes these -- in the CircleCI
 * CLI's own words where the remedy is a CLI command -- so nothing here rewords
 * advice it did not author.
 *
 * They render as plain text, deliberately. A command is not a button: running
 * `circleci project link` writes a file into the user's repository, which this
 * app must never do on their behalf, so the honest affordance is a sentence they
 * can read and choose to act on in their own terminal.
 */
import type { ProjectContextWarning } from '~/lib/rpc/client';

export function ProjectContextWarnings({
  warnings,
  /**
   * `true` when the section around these warnings is still showing real data
   * (contexts listed, variables listed). Chooses "some details are missing"
   * framing over "this failed" framing -- the distinction issue #150 asks for.
   */
  degraded = false,
}: {
  warnings: ProjectContextWarning[];
  degraded?: boolean;
}) {
  if (warnings.length === 0) return null;

  return (
    <ul className="space-y-1.5" aria-label="Project metadata warnings">
      {warnings.map((warning) => (
        <li
          key={`${warning.kind}:${warning.headline}`}
          className={`rounded-md border px-2 py-1.5 text-2xs ${
            degraded
              ? 'border-cc-border-strong bg-cc-panel-raised'
              : 'border-cc-warning/40 bg-cc-panel-raised'
          }`}
        >
          <p className="font-medium text-cc-warning">{warning.headline}</p>
          {warning.detail ? (
            <p className="mt-0.5 text-cc-text-muted">{warning.detail}</p>
          ) : null}
          {warning.consequences && warning.consequences.length > 0 ? (
            <>
              <p className="mt-1 text-cc-text-faint">
                What that means here
                {degraded ? ' — everything else still works' : ''}:
              </p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-cc-text-muted">
                {warning.consequences.map((consequence) => (
                  <li key={consequence}>{consequence}</li>
                ))}
              </ul>
            </>
          ) : null}
          {warning.suggestions && warning.suggestions.length > 0 ? (
            <>
              <p className="mt-1 text-cc-text-faint">What to do:</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-cc-text-muted">
                {warning.suggestions.map((suggestion) => (
                  <li key={suggestion}>{suggestion}</li>
                ))}
              </ul>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
