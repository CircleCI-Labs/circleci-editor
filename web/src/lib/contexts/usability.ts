/**
 * How a context's restrictions are presented, in one place, so every part of
 * the app that answers "can this project use that context, and why not?"
 * answers it in the same words.
 *
 * ## Why this lives in one module
 *
 * The four-state model was built for issue #105's palette: a context can
 * be `unrestricted`, `allowed` here, restricted to `other-projects-only`, or
 * restricted in a way this host cannot evaluate (`unknown`, because group
 * membership is not visible from here). The rule that makes it worth having is
 * that *"I cannot tell" is a real answer and must not be flattened into "no"*.
 *
 * Issue #194 gave that model a second consumer with much higher stakes. The
 * palette's badge warns you while you are typing; the run confirmation's warns
 * you while you are about to spend money on a pipeline that will compile
 * perfectly and then fail when the job starts. Two copies of this table would
 * eventually disagree, and the copy that drifted would be the one telling
 * someone a restricted context was fine. So it is one table, imported by both.
 *
 * ## What issue #251 changed: `unknown` was three answers wearing one coat
 *
 * The host's four states are still the four states. What they could not express
 * is *why* it cannot tell, and there are three quite different reasons:
 *
 *  1. The context carries a restriction nobody could evaluate from here — an org
 *     group (membership is not visible) or an expression (it is a rule about a
 *     pipeline that does not exist yet).
 *  2. The restrictions were fetched fine and this editor could not work out
 *     *which project it is standing in*, so it had nothing to compare them to.
 *  3. The restrictions call itself failed, so nothing was checked at all.
 *
 * Those got one sentence between them, and it named a cause — "an organization
 * group" — that was simply untrue in cases 2 and 3. A warning that reads the
 * same whether we know something or know nothing is a warning users learn to
 * dismiss, which is the failure #179 avoided with the unsaved-changes prompt.
 * So the presentation is keyed off a *derived* six-state certainty rather than
 * off `usability` directly, and every state says which of the three it is.
 *
 * The `Record`s are total over their unions deliberately: a new state cannot be
 * added without giving it a tone, a label, a sentence, and an answer to "do we
 * actually know this?".
 */
import type { BadgeTone } from '~/design/components/Badge';
import type {
  ContextRestrictionDetail,
  ContextUsability,
} from '~/lib/rpc/client';

/**
 * What this editor actually knows about one context's usability here.
 *
 * Derived from the host's `usability`, the presence of the restriction list, and
 * whether the host could identify this project — see `restrictionCertainty`.
 *
 * - `unrestricted` — checked: there are no restrictions.
 * - `allowed` — checked: a project restriction names this project.
 * - `refused` — checked: this context is restricted to other projects, and this
 *   is not one of them. **Certain**, not inferred: a project restriction's value
 *   is always a project UUID, so "none of these is us" is a fact.
 * - `unevaluable` — checked, and unanswerable from here: a group or expression
 *   restriction. The restriction is shown; the verdict is withheld.
 * - `project-unknown` — checked, and this editor does not know which CircleCI
 *   project this config belongs to, so it has nothing to compare against.
 * - `check-failed` — the restrictions call failed. **Nothing was checked**, which
 *   is not the same as nothing being there. Named for the failure rather than
 *   "unchecked" because the run dialog already uses that word for a context whose
 *   restrictions were never *asked* for, and the two must not read alike either.
 */
export type RestrictionCertainty =
  | 'unrestricted'
  | 'allowed'
  | 'refused'
  | 'unevaluable'
  | 'project-unknown'
  | 'check-failed';

/** The restriction facts a certainty is derived from — the host's own fields, narrowed. */
export interface RestrictionState {
  usability: ContextUsability;
  /**
   * The restriction list, or `null`/`undefined` when the restrictions call
   * failed. The distinction is load-bearing: `[]` is "there are none" and absent
   * is "we could not look". Never default one to the other.
   */
  restrictions?: ContextRestrictionDetail[] | null;
  /** Whether the host had a project ID to compare project restrictions against. */
  projectIdentified?: boolean;
}

/**
 * Classifies what is actually known about a context's usability.
 *
 * Order matters. "We could not check" is decided first and from the *shape* of
 * the response rather than from its `usability` value, because a failed check
 * also reports `unknown` — and a failed check has to be sayable even when the
 * host is older or newer than this client.
 */
export function restrictionCertainty(
  state: RestrictionState,
): RestrictionCertainty {
  if (state.restrictions == null) return 'check-failed';

  switch (state.usability) {
    case 'unrestricted':
      return 'unrestricted';
    case 'allowed':
      return 'allowed';
    case 'other-projects-only':
      return 'refused';
    case 'unknown':
      // A project restriction we could have evaluated, against a project we
      // could not name, is a different problem from a group we can never
      // evaluate -- and the only one of the two the user can fix.
      return state.projectIdentified === false &&
        state.restrictions.some((r) => r.kind === 'project')
        ? 'project-unknown'
        : 'unevaluable';
  }
}

export interface RestrictionPresentation {
  tone: BadgeTone;
  /** The badge caption. Short enough to sit beside a context's name. */
  label: string;
  /** One line of what it means, and — where we do not know — of what we do not know. */
  note: string;
  /**
   * Whether the editor is asserting a fact or admitting a gap.
   *
   * The point of the flag is that a caller cannot accidentally give an uncertain
   * state the same voice as a certain one: an insertion warning phrased "CircleCI
   * will refuse this" is right for `refused` and a lie for `unevaluable`.
   */
  certain: boolean;
}

/** How each certainty is badged, and what it means in one line. */
export const RESTRICTION_PRESENTATION: Record<
  RestrictionCertainty,
  RestrictionPresentation
> = {
  unrestricted: {
    tone: 'neutral',
    label: 'Unrestricted',
    note: 'Checked: this context has no restrictions, so every project in this organization can use it.',
    certain: true,
  },
  allowed: {
    tone: 'success',
    label: 'Allowed here',
    note: 'Checked: this context is restricted, and this project is one of the projects it is restricted to.',
    certain: true,
  },
  refused: {
    tone: 'danger',
    label: 'Not allowed here',
    note: 'Checked: this context is restricted to other projects, and this project is not one of them. A job that asks for it will compile fine and then fail as unauthorized.',
    certain: true,
  },
  unevaluable: {
    tone: 'warning',
    label: 'Restricted — cannot tell',
    note: 'This context is restricted in a way this editor cannot evaluate before a run: organization group membership is not visible from here, and an expression is a rule about a pipeline that does not exist yet. It may well work — this is not a prediction that it will fail.',
    certain: false,
  },
  'project-unknown': {
    tone: 'warning',
    label: 'Restricted — project unknown',
    note: 'This context is restricted to specific projects, and this editor could not work out which CircleCI project this config belongs to, so it cannot tell whether this is one of them.',
    certain: false,
  },
  'check-failed': {
    tone: 'warning',
    label: 'Check failed',
    note: 'This editor could not read this context’s restrictions, so it does not know whether they exist. This is not the same as the context being unrestricted.',
    certain: false,
  },
};

/**
 * One line naming what a single restriction restricts the context *to*.
 *
 * The unnamed cases are the reason this function exists rather than a
 * `restriction.name ?? restriction.kind` at each call site. A project or group
 * restriction really can arrive with no name (verified against the live API: one
 * project restriction in a real organization has `"name": ""`), and the host
 * strips the UUID on purpose, so there is nothing to fall back to except an
 * honest sentence. "A project this editor cannot name" tells the reader the
 * restriction is real and that the gap is ours; a bare UUID tells them nothing
 * and looks like an answer.
 */
export function describeRestriction(
  restriction: ContextRestrictionDetail,
): string {
  switch (restriction.kind) {
    case 'project':
      if (restriction.thisProject) return 'This project';
      return restriction.name ?? 'A project this editor cannot name';
    case 'group':
      return restriction.name ?? 'A group this editor cannot name';
    case 'expression':
      // Returned as-is; callers render it in a monospaced face, because it is
      // code rather than prose.
      return restriction.expression ?? 'An expression this editor cannot read';
    case 'other':
      return restriction.rawType
        ? `A “${restriction.rawType}” restriction this editor does not understand`
        : 'A restriction of a kind this editor does not understand';
  }
}

/** The heading a group of restrictions of one kind sits under. */
export const RESTRICTION_KIND_HEADING: Record<
  ContextRestrictionDetail['kind'],
  string
> = {
  project: 'Restricted to these projects',
  group: 'Restricted to these organization groups',
  expression: 'Only when these expressions hold',
  other: 'Other restrictions',
};

/**
 * Whether any of a context's expression restrictions mentions
 * `pipeline.config_source` — the pipeline value that says where a run's config
 * came from.
 *
 * Why this is worth a function of its own: `pipeline.config_source` is the one
 * mitigation for the capability PR #255 shipped. An unversioned run gets the
 * same contexts a normal build on that branch would, which CircleCI's security
 * team describes as doing an end-run around context restrictions — and their own
 * note on the expression that guards against it is that *"you need to know to
 * use it"*. Nobody discovers it by looking at a context that does not have one.
 *
 * A substring match, deliberately, and it is enough: this decides whether to
 * *mention* a guard, never whether one is adequate. The expression language has
 * no other identifier this could collide with, and being wrong in the generous
 * direction means staying quiet about a context whose author clearly already
 * knows about the value.
 */
export function guardsAgainstUnversionedConfig(
  restrictions: ContextRestrictionDetail[],
): boolean {
  return restrictions.some(
    (restriction) =>
      restriction.kind === 'expression' &&
      (restriction.expression ?? '').includes('pipeline.config_source'),
  );
}
