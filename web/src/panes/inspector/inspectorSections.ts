/**
 * Which inspector sections start open (issue #219).
 *
 * Kept out of `Inspector.tsx` and out of `CollapsibleSection.tsx` on purpose:
 * the issue says "sensible defaults matter more than the mechanism", and a
 * defaults *rule* is the kind of thing that should be readable and testable on
 * its own rather than spread across seven call sites' JSX.
 *
 * # The rule
 *
 * **Open iff the section has content**, with one exception (below). This is
 * the general form issue #219 asks to consider rather than a fixed list of
 * sections to collapse, and it is the right generalisation of the owner's own
 * named candidates: pre-steps and post-steps are "empty in most jobs", which
 * is a fact about content, not a fact about those two sections. Filters,
 * Requires and Context are empty just as often and get the same treatment for
 * free; a section added later gets it without touching this file.
 *
 * Stated the other way round, which is how it reads in the pane: **a section
 * you can see is a section that has something in it.** Everything a job
 * actually configures is visible on selecting it, and everything it doesn't is
 * one labelled row you can open. That is the crowding fix -- measured on the
 * default preset at 280px, the inspector's content is 1784px tall for a job
 * whose Pre-steps, Post-steps and Filters are all empty, and those three
 * sections are 668px (37%) of it.
 *
 * # The exception: Steps
 *
 * `Steps` is always open, the way `Executors` is the palette's own always-open
 * section. Two reasons, and the second is the load-bearing one:
 *
 * 1. It is what the inspector is *for*. A job's steps are the thing being
 *    edited in the surgical-edit workflow this pane exists to serve, and
 *    opening the pane onto a closed row saying "STEPS 3" would be a worse
 *    first frame than the crowding being fixed.
 * 2. **Collapsing an empty Steps section hides the only way to fill it.** The
 *    "Add a run step" form lives inside the section, so the content rule
 *    applied naively would close Steps exactly when a job has none -- the one
 *    case where you certainly came here to add one. The same argument does
 *    *not* rescue Pre-steps/Post-steps: their Add forms are equally inside
 *    them, but a job with no pre-steps is the normal, healthy case rather than
 *    a broken one, and one click to reach a form you rarely want is the trade
 *    #219 is explicitly asking for.
 *
 * Note that "always open" here means "open absent an explicit choice", not
 * "cannot be closed". A user who closes Steps has it stay closed -- see
 * `state/inspectorSectionStore.ts` for why an explicit choice outranks this
 * rule rather than being overridden by it.
 *
 * # Job identity is not a section
 *
 * The name/alias fields and the kind badges are deliberately not collapsible
 * and are not listed here. They are how you know *which* node you selected;
 * a collapsed one would leave the pane unable to answer the question it is
 * opened to answer. They are 174px of the 1784px total and none of it is
 * ever empty.
 */

/**
 * Every collapsible section's storage id. These strings are persisted (see
 * `state/inspectorSectionStore.ts`), so renaming one silently discards that
 * section's saved choice -- harmless, but it means the ids are deliberately
 * decoupled from the display titles, which are free to change.
 */
export type InspectorSectionKey =
  | 'executor'
  | 'steps'
  | 'context'
  | 'filters'
  | 'pre-steps'
  | 'post-steps'
  | 'requires'
  | 'params'
  /**
   * The selected job's own `parameters:` *declaration* (issue #250) -- distinct
   * from `params`, which is the workflow entry's invocation *values*. Both can
   * be present at once for a parameterized job, which is why they are two ids
   * rather than one: collapsing "what this job declares" would otherwise also
   * collapse "what this entry passes", and vice versa.
   *
   * Follows the content rule with no exception: a job that declares no
   * parameters opens as one labelled row, which is the normal case and exactly
   * what the rule is for. Unlike Steps, closing it empty hides nothing you came
   * here for -- most jobs have none, and the Add form is one click away.
   */
  | 'declared-params'
  /**
   * The selected *workflow*'s own `when`/`unless` condition (issue #288) --
   * distinct from a job's `filters:`/`context:`, which stay scoped to a
   * workflow *entry*. Follows the content rule with no exception, same
   * reasoning as `declared-params`: most workflows have no condition at
   * all, and the "add when/unless" affordance is one click away inside it.
   */
  | 'workflow-condition'
  /** The selected workflow's own `triggers:` (issue #288) -- same "open iff it has one" treatment as `workflow-condition`. */
  | 'workflow-triggers';

/** Sections that open by default regardless of whether they have content -- see the module comment. */
const ALWAYS_OPEN: ReadonlySet<InspectorSectionKey> = new Set(['steps']);

/**
 * Whether `section` starts open for a job whose corresponding content is
 * `hasContent`. Pure, and the only place the rule lives.
 *
 * `hasContent` is the caller's own answer rather than something derived here:
 * "has content" means something different per section (a non-empty steps
 * list, a `context:` with at least one name, a `filters:` block that exists at
 * all), and the caller is already holding the value it would be re-derived
 * from.
 */
export function defaultSectionOpen(
  section: InspectorSectionKey,
  hasContent: boolean,
): boolean {
  return ALWAYS_OPEN.has(section) || hasContent;
}
