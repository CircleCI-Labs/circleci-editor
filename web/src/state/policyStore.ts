/**
 * The config-policy decision (issue #215): what CircleCI's policy engine
 * says about the open config, kept strictly apart from what the config
 * compiler says about it.
 *
 * ## Why this is not part of `appStore.validation`
 *
 * Compile-validity and policy standing are independent axes. A config can
 * compile perfectly and hard-fail a policy; a config that does not compile
 * never reaches a policy at all. Folding them into one "is this OK" light
 * would make both unreadable -- so this is its own store, its own state
 * machine and its own strip in the UI, and nothing here ever sets or reads a
 * validation state.
 *
 * ## Why this now runs in the background (issue #247)
 *
 * #215 shipped this as a button: "checking" was something the user asked
 * for, because a check posts the config to CircleCI and that felt like it
 * needed asking first. The owner's steer overturned that:
 *
 * > *"It'd be nice to kind of do that in the background for the user... to
 * > make sure it compiles and passes the policy violation, without the user
 * > having to recheck."*
 *
 * So `evaluateInBackground` is called from `appStore.revalidate`'s own
 * debounce -- the same 800ms settling window compile-validation already
 * waits for, not a second one -- and there is no button left that calls
 * `check` directly. Three things stay true about it regardless:
 *
 *  - **It is still a second outbound flow.** Validation posts the config too,
 *    but to a different endpoint for a different purpose; both are stated in
 *    this editor's own docs page, which is where a
 *    background flow's disclosure belongs now that there is no button to
 *    carry it.
 *  - **It never gates or delays the compile result.** The two axes are
 *    answered independently -- whichever call returns first is shown first --
 *    so this store's `check` and `appStore`'s `postValidate` are two
 *    unrelated promises, not a chain.
 *  - **It skips a request that would tell it nothing new.** `checkedText`
 *    and `pendingText` (below) let `evaluateInBackground` decline to re-ask a
 *    question this store already has an answer for, or already has in
 *    flight -- see its own doc comment.
 *
 * `check` itself is unchanged and still exported: it is the primitive
 * `evaluateInBackground` wraps, and this module's own tests still exercise it
 * directly to pin the state machine below without also pinning the dedupe
 * rule on top of it.
 *
 * ## The states, and why there are this many
 *
 * The single most important requirement of this feature is that "no
 * violations" and "we could not check" never look alike -- a false all-clear
 * on a security control is worse than no control. That rules out any state
 * machine that can reach "nothing to report" from a failure. So:
 *
 *  - `idle`     -- never asked. Not a verdict.
 *  - `checking` -- in flight. Any previous decision is kept on screen,
 *                  marked as belonging to the text it was made against.
 *  - `decided`  -- the engine answered. `decision.status` carries which of
 *                  the four answers it gave; `PASS`, `SOFT_FAIL` and
 *                  `HARD_FAIL` are three distinct renderings and `ERROR` is
 *                  a fourth that is emphatically not a pass.
 *  - `unavailable` -- the host reached a settled "cannot check" (no token, no
 *                  org, a plan without policies, an unparseable config).
 *                  `reason` is the host's own words.
 *  - `error`    -- the request failed, possibly transiently. Retryable.
 *
 * `checkedText` is the exact text the last decision was made against, so a
 * decision can be shown as *stale* the moment the user types -- a verdict
 * about a config that no longer exists is the third way to mislead someone,
 * after the two above.
 */
import { create } from 'zustand';

import {
  postPolicyDecide,
  type PolicyDecisionResponse,
} from '~/lib/rpc/client';

export type PolicyCheckState =
  | 'idle'
  | 'checking'
  | 'decided'
  | 'unavailable'
  | 'error';

/** The four answers CircleCI's policy engine can give. */
export type PolicyStatus = 'PASS' | 'SOFT_FAIL' | 'HARD_FAIL' | 'ERROR';

const STATUSES: readonly string[] = ['PASS', 'SOFT_FAIL', 'HARD_FAIL', 'ERROR'];

/**
 * A decision the engine actually returned, narrowed so the UI cannot render
 * a status this build does not model. The host already refuses to report an
 * unrecognised status as a verdict; this is the same guard on this side of
 * the wire, because both halves have to hold for the guarantee to mean
 * anything.
 */
export interface PolicyDecision {
  status: PolicyStatus;
  /** Every rule evaluated, fired or not. Empty means the org has none enabled -- see `hasRules`. */
  enabledRules: string[];
  hardFailures: PolicyViolation[];
  softFailures: PolicyViolation[];
  /** The engine's own explanation, on some `ERROR` decisions. */
  decisionReason?: string;
  orgSlug?: string;
  policyContext?: string;
  /** The `data.meta` keys the host could supply. Empty is meaningful -- see `PolicyDecisionResponse`. */
  metadataSent: string[];
}

export interface PolicyViolation {
  rule: string;
  reason: string;
  /** Which list it came from. `hard` blocks a pipeline on CircleCI; `soft` does not. */
  kind: 'hard' | 'soft';
}

interface PolicyStoreState {
  state: PolicyCheckState;
  /** Why no decision could be reached, verbatim from the host. Set for `unavailable` and `error`. */
  reason: string | null;
  decision: PolicyDecision | null;
  /**
   * The exact config text the current `decision` was made against, or null
   * when there is no decision. Compare it with the editor's text to know
   * whether the verdict still applies -- see `isPolicyDecisionStale`.
   */
  checkedText: string | null;
  /**
   * The exact text a request currently in flight was asked about, or null
   * when nothing is in flight. Distinct from `checkedText`, which only ever
   * names text a decision was *reached* for: this is what is being asked
   * about *right now*, which is what `evaluateInBackground` compares against
   * to avoid asking the same question twice while the first answer is still
   * outstanding.
   */
  pendingText: string | null;

  /** Runs a check against `text` unconditionally. The primitive `evaluateInBackground` wraps; kept directly callable for this module's own tests. */
  check: (text: string) => Promise<void>;
  /**
   * Issue #247: the entry point `appStore.revalidate`'s debounce calls.
   * Declines to ask a question this store already has an answer for
   * (`text === checkedText`) or already has in flight
   * (`text === pendingText`) -- a network call per keystroke-batch to a
   * third party is exactly the cost the issue asks this guard against. Every
   * other caller (`reset`, a file switch) is unaffected: this only ever
   * *skips* a `check` that would have been redundant, never suppresses one
   * that would tell this store something new.
   */
  evaluateInBackground: (text: string) => void;
  /** Drops any decision, for a file switch: a verdict about another file is not a verdict about this one. */
  reset: () => void;
}

/**
 * Module-level, deliberately outside the store: a sequence number only
 * decides which response is allowed to land, and bumping it must not
 * re-render anything. Same idiom as `appStore.revalidate`'s `validateSeq`.
 */
let checkSeq = 0;

export const usePolicyStore = create<PolicyStoreState>((set, get) => ({
  state: 'idle',
  reason: null,
  decision: null,
  checkedText: null,
  pendingText: null,

  check: async (text: string) => {
    const seq = ++checkSeq;
    set({ state: 'checking', pendingText: text });

    try {
      const response = await postPolicyDecide(text);
      if (seq !== checkSeq) return;

      const decision = toDecision(response);
      if (!decision) {
        // Either the host said it could not check, or it answered
        // something this build cannot interpret. Both are "no verdict",
        // and both keep the reason rather than inventing one.
        set({
          state: 'unavailable',
          reason:
            response.reason ??
            'CircleCI returned a policy decision this editor could not interpret.',
          decision: null,
          checkedText: null,
          pendingText: null,
        });
        return;
      }

      set({
        state: 'decided',
        reason: null,
        decision,
        checkedText: text,
        pendingText: null,
      });
    } catch (error) {
      if (seq !== checkSeq) return;
      set({
        state: 'error',
        reason: error instanceof Error ? error.message : String(error),
        // The previous decision is dropped rather than left standing: it
        // was about text that may no longer be on screen, and a failed
        // re-check is exactly when a stale verdict is most misleading.
        decision: null,
        checkedText: null,
        pendingText: null,
      });
    }
  },

  evaluateInBackground: (text: string) => {
    const state = get();
    if (text === state.checkedText) return;
    if (text === state.pendingText) return;
    void get().check(text);
  },

  reset: () => {
    // Bumped so an in-flight response for the old file cannot land on the
    // new one.
    checkSeq++;
    set({
      state: 'idle',
      reason: null,
      decision: null,
      checkedText: null,
      pendingText: null,
    });
  },
}));

/**
 * Narrows a host response to a `PolicyDecision`, or `undefined` when it does
 * not carry one. Never fills a gap in: an absent `enabledRules` stays empty,
 * because empty is a fact the UI reports rather than a default it hides.
 */
export function toDecision(
  response: PolicyDecisionResponse,
): PolicyDecision | undefined {
  if (!response.available) return undefined;
  if (!response.status || !STATUSES.includes(response.status)) return undefined;

  return {
    status: response.status as PolicyStatus,
    enabledRules: response.enabledRules ?? [],
    hardFailures: (response.hardFailures ?? []).map((violation) => ({
      ...violation,
      kind: 'hard' as const,
    })),
    softFailures: (response.softFailures ?? []).map((violation) => ({
      ...violation,
      kind: 'soft' as const,
    })),
    decisionReason: response.decisionReason,
    orgSlug: response.orgSlug,
    policyContext: response.policyContext,
    metadataSent: response.metadataSent ?? [],
  };
}

/** Every violation in reporting order, blocking ones first. */
export function policyViolations(
  decision: PolicyDecision | null,
): PolicyViolation[] {
  if (!decision) return [];
  return [...decision.hardFailures, ...decision.softFailures];
}

/**
 * Does the current decision still describe the text on screen?
 *
 * A decision about an older revision is not a decision about this one, and
 * saying so is cheaper than being wrong: the strip demotes a stale verdict
 * to "checked an earlier version" rather than continuing to show a green
 * pass over edited text.
 */
export function isPolicyDecisionStale(
  state: Pick<PolicyStoreState, 'decision' | 'checkedText'>,
  text: string,
): boolean {
  if (!state.decision || state.checkedText === null) return false;
  return state.checkedText !== text;
}

/**
 * Did the organization have anything to check against? A `PASS` from an
 * empty bundle is a true statement about the request and a false one about
 * the config's compliance, so this is what the UI branches on before it uses
 * the word "pass".
 */
export function hasRules(decision: PolicyDecision | null): boolean {
  return (decision?.enabledRules.length ?? 0) > 0;
}
