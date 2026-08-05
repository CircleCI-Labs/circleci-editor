/**
 * What a context is actually restricted *to* (issue #251).
 *
 * ## The gap this fills
 *
 * The palette has badged contexts "restricted" since #105, and the owner's
 * report was that the badge is where it stops: *"some say restricted but don't
 * tell me what the restrictions are"*. The data was in hand the whole time —
 * `GET /api/v2/context/{id}/restrictions` names the projects and groups, and
 * carries expression rules verbatim — it was simply never rendered.
 *
 * ## Grouped by kind, because the kinds mean different things
 *
 * A project restriction is a list this editor can check itself. A group
 * restriction is a list it can read and never evaluate. An expression is a rule
 * about a pipeline that does not exist yet. Interleaving them in one flat list
 * would put three different epistemic states under one heading, which is the
 * same flattening avoided one level up.
 *
 * ## Names, and their absence
 *
 * A restriction with no name still gets a line, phrased as the gap it is (see
 * `describeRestriction`). The host strips every UUID at its boundary on purpose,
 * so there is nothing here to fall back to and nothing to accidentally render as
 * though an ID answered the question.
 */
import {
  describeRestriction,
  RESTRICTION_KIND_HEADING,
} from '~/lib/contexts/usability';
import type { ContextRestrictionDetail } from '~/lib/rpc/client';

/** The order the groups appear in: most evaluable first. */
const KIND_ORDER: ContextRestrictionDetail['kind'][] = [
  'project',
  'group',
  'expression',
  'other',
];

export function ContextRestrictionList({
  restrictions,
}: {
  /** Restrictions that were actually read. Never the failed case — see `ContextDetail.restrictions`. */
  restrictions: ContextRestrictionDetail[];
}) {
  if (restrictions.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {KIND_ORDER.map((kind) => {
        const group = restrictions.filter(
          (restriction) => restriction.kind === kind,
        );
        if (group.length === 0) return null;

        return (
          <div key={kind}>
            <p className="text-2xs text-cc-text-faint">
              {RESTRICTION_KIND_HEADING[kind]}:
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {group.map((restriction, index) => {
                const label = describeRestriction(restriction);
                const unnamed =
                  (restriction.kind === 'project' ||
                    restriction.kind === 'group') &&
                  !restriction.name;

                return (
                  <li
                    // Restriction ids never cross the host boundary (see
                    // `ContextRestrictionDetail`), so the key is the label plus
                    // its position -- two unnamed projects are two legitimate
                    // entries that would otherwise collide.
                    key={`${label}:${index}`}
                    className={
                      restriction.kind === 'expression'
                        ? 'break-words rounded border border-cc-border bg-cc-panel-raised px-1.5 py-1 font-mono text-2xs text-cc-text-muted'
                        : `text-2xs ${
                            unnamed
                              ? 'italic text-cc-text-faint'
                              : 'text-cc-text-muted'
                          }`
                    }
                  >
                    {restriction.kind === 'expression' ? null : '• '}
                    {label}
                    {restriction.thisProject ? (
                      <span className="ml-1 not-italic text-cc-success">
                        (that is this project)
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
