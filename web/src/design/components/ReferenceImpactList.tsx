import type { ReferenceImpact as Impact } from '~/lib/mutations/jobReferences';

/**
 * Renders a `ReferenceImpact` (see `~/lib/mutations/jobReferences.ts`): the
 * concrete list of what a job rename or delete will touch, plus the caveats
 * about what it deliberately won't, plus any reason the edit will be refused
 * outright.
 *
 * Shared by the rename prompt (inspector pane) and the delete prompt (DAG
 * pane) so the two can't drift into describing the same reconciliation
 * differently. Deliberately dumb: it takes already-composed sentences and
 * lays them out. All wording -- and the alias/no-auto-rewiring semantics
 * behind it -- lives in `jobReferences.ts`, next to the code that computes it
 * and the tests that pin it, rather than being assembled in JSX where it
 * could disagree with the mutation.
 */
export function ReferenceImpactList({
  impact,
  className = '',
}: {
  impact: Impact;
  className?: string;
}) {
  const hasBlockers = impact.blockers.length > 0;
  return (
    <div className={`text-xs ${className}`}>
      {hasBlockers ? (
        <div className="mb-2 rounded border border-cc-danger px-2 py-1.5 text-cc-danger">
          <p className="font-medium">
            This can&apos;t be done yet
            {impact.blockers.length > 1 ? ' -- two things are in the way' : ''}:
          </p>
          <ul className="mt-1 list-disc pl-4">
            {impact.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mb-1.5 font-medium text-cc-text">{impact.headline}</p>

      {impact.lines.length > 0 ? (
        <ul className="list-disc pl-4 text-cc-text-muted">
          {impact.lines.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {impact.notes.length > 0 ? (
        <ul className="mt-2 space-y-1 text-cc-warning">
          {impact.notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
