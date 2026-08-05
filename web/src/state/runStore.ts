/**
 * The one-shot unversioned run (issue #194): starting the config in front of
 * you on CircleCI without committing it, and then getting out of the way.
 *
 * ## Nothing here is automatic, and the bar is higher than anywhere else
 *
 * `policyStore` already establishes "user-initiated, never debounced" for a
 * store that posts the config to CircleCI. This one goes further, because a
 * policy check that fires by accident costs a round trip while a run that fires
 * by accident costs money, appears in the whole organization's dashboard, and
 * may deploy something. So:
 *
 *  - `trigger` is called from exactly one place, `RunDialog`'s confirm button,
 *    and takes the branch it is confirming as an argument. It cannot be reached
 *    from an effect, a save, or a validation.
 *  - `checkAvailability` is the only thing that runs on its own, and it starts
 *    no builds -- it reads two settings so the UI can decide whether to offer a
 *    button at all.
 *  - There is no retry, no backoff and no "run again" convenience. Every run is
 *    a fresh, separately-confirmed decision.
 *
 * ## Why the result is this thin
 *
 * `lastRun` holds a pipeline number, a link and CircleCI's word for the state
 * at the instant of creation. It is never refreshed and there is nothing here
 * to refresh it with. This app draws a firm line here: *rendering* observation
 * stays out of scope, while the *assistant* consulting run data for diagnosis
 * is in scope, through CircleCI's own MCP server. A polling loop in this store
 * would be the first half of a runs dashboard -- exactly what this editor's
 * author/verify/launch scope excludes -- so the store stops at "a pipeline
 * exists, here is where to look at it".
 *
 * ## The states
 *
 *  - `idle`        -- nothing attempted. Not a failure.
 *  - `triggering`  -- a run is in flight. The dialog stays open and disabled;
 *                     a double-press must not buy two pipelines.
 *  - `triggered`   -- CircleCI created a pipeline. `lastRun` describes it.
 *  - `refused`     -- the host settled on "no run happened, and here is why".
 *                     Not an error. `reason` is the host's words.
 *  - `error`       -- the request failed. This is the *only* state where this
 *                     editor cannot say whether a pipeline was created, and it
 *                     is worded that way rather than as "it did not run".
 */
import { create } from 'zustand';

import {
  getRunAvailability,
  postRun,
  type RunAvailabilityResponse,
  type RunAvailabilityStatus,
  type RunConfigVerification,
} from '~/lib/rpc/client';

export type RunState =
  | 'idle'
  | 'triggering'
  | 'triggered'
  | 'refused'
  | 'error';

export type RunAvailabilityState = 'idle' | 'checking' | 'loaded' | 'error';

/** What a run produced. Created once, never updated -- see the store's doc comment. */
export interface RunResult {
  pipelineNumber: number | null;
  pipelineId: string | null;
  /** CircleCI's word at the moment of creation. Not live. */
  state: string | null;
  /** Absent for a project with no name-addressed URL form: render the number as text. */
  webUrl: string | null;
  projectSlug: string | null;
  branch: string | null;
  /** The exact config text that was run, so a later edit can be shown as "not what ran". */
  ranText: string;
  /**
   * Whether the host could prove the pipeline is running `ranText`.
   *
   * `mismatch` means CircleCI ignored the submitted config and ran the
   * committed one -- the failure that would otherwise look like a success.
   */
  configVerified: RunConfigVerification;
}

interface RunStoreState {
  state: RunState;
  /** Why no run happened, verbatim from the host. Set for `refused` and `error`. */
  reason: string | null;
  /** The availability state behind a refusal, so the UI words it from the same six-way vocabulary. */
  refusedStatus: RunAvailabilityStatus | null;
  lastRun: RunResult | null;

  availabilityState: RunAvailabilityState;
  availability: RunAvailabilityResponse | null;
  /** Why availability itself could not be read -- a transport failure, not a "no". */
  availabilityError: string | null;

  /**
   * Reads whether a run can be offered. Starts nothing and spends nothing;
   * safe to call on mount and on demand.
   */
  checkAvailability: () => Promise<void>;

  /**
   * Starts one pipeline with `text` on `branch`.
   *
   * Called from exactly one place, after an explicit confirmation that named
   * the project, the branch and which config. `branch` is passed in rather than
   * read from `availability` here so that the value the user confirmed is the
   * value that travels -- the host rejects the run if it disagrees with the
   * branch it would target.
   */
  trigger: (text: string, branch: string) => Promise<void>;

  /** Drops a run result, for a file switch: a pipeline started from another file is not this file's. */
  reset: () => void;
}

/**
 * Module-level, deliberately outside the store, same idiom as
 * `policyStore.checkSeq`: a sequence number only decides which response may
 * land, and bumping it must not re-render anything.
 *
 * Note there is no equivalent for `trigger`. A trigger is not superseded by a
 * later one -- both pipelines exist -- so discarding the first response would
 * hide a pipeline the user is paying for. Concurrency is prevented instead, by
 * the dialog disabling itself while `state === 'triggering'`.
 */
let availabilitySeq = 0;

export const useRunStore = create<RunStoreState>((set, get) => ({
  state: 'idle',
  reason: null,
  refusedStatus: null,
  lastRun: null,

  availabilityState: 'idle',
  availability: null,
  availabilityError: null,

  checkAvailability: async () => {
    const seq = ++availabilitySeq;
    set({ availabilityState: 'checking' });

    try {
      const availability = await getRunAvailability();
      if (seq !== availabilitySeq) return;
      set({
        availabilityState: 'loaded',
        availability,
        availabilityError: null,
      });
    } catch (error) {
      if (seq !== availabilitySeq) return;
      // Kept apart from the host's own `unknown` status. Both mean "we could
      // not find out", but this one is retryable from here and that one has
      // already been retried, so the UI offers different next steps.
      set({
        availabilityState: 'error',
        availability: null,
        availabilityError:
          error instanceof Error ? error.message : String(error),
      });
    }
  },

  trigger: async (text: string, branch: string) => {
    // A second press while one is in flight must not buy a second pipeline.
    if (get().state === 'triggering') return;

    set({ state: 'triggering', reason: null, refusedStatus: null });

    try {
      const response = await postRun(text, branch);

      if (!response.triggered) {
        set({
          state: 'refused',
          reason:
            response.reason ??
            'CircleCI did not start a run, and the host gave no reason.',
          refusedStatus: response.status ?? null,
          lastRun: null,
        });
        // A refusal is very often a gate that changed under us, so the
        // precondition report is re-read rather than left stale.
        void get().checkAvailability();
        return;
      }

      set({
        state: 'triggered',
        reason: null,
        refusedStatus: null,
        lastRun: {
          pipelineNumber: response.pipelineNumber ?? null,
          pipelineId: response.pipelineId ?? null,
          state: response.state ?? null,
          webUrl: response.webUrl ?? null,
          projectSlug: response.projectSlug ?? null,
          branch: response.branch ?? null,
          ranText: text,
          // Defaults to the honest answer, never to "confirmed": a host that
          // sent no verdict has not verified anything.
          configVerified: response.configVerified ?? 'unverified',
        },
      });
    } catch (error) {
      set({
        state: 'error',
        reason: error instanceof Error ? error.message : String(error),
        refusedStatus: null,
        // Deliberately *not* cleared. If a previous run succeeded, its link
        // is still the link to a real pipeline, and dropping it because a
        // later attempt failed would take away the only record the user has.
        lastRun: get().lastRun,
      });
    }
  },

  reset: () => {
    availabilitySeq++;
    set({
      state: 'idle',
      reason: null,
      refusedStatus: null,
      lastRun: null,
      availabilityState: 'idle',
      availability: null,
      availabilityError: null,
    });
  },
}));

/**
 * Is the config on screen still the config that ran?
 *
 * The same staleness rule `isPolicyDecisionStale` applies to a verdict, applied
 * to a run: a pipeline number attached to text the user has since edited is
 * evidence about a config that no longer exists. Saying so is much cheaper than
 * letting someone read a green link as "the thing I'm looking at works".
 */
export function isRunResultStale(
  state: Pick<RunStoreState, 'lastRun'>,
  text: string,
): boolean {
  if (!state.lastRun) return false;
  return state.lastRun.ranText !== text;
}

/**
 * Would a run target the project's default branch?
 *
 * `false` when the default branch is not known, and that asymmetry is the
 * point: the caller uses this to decide whether to demand a stronger
 * confirmation, so it must only ever answer `true` on evidence. "We don't know
 * which branch is the default" is handled by the caller warning about it, not
 * by this function guessing.
 */
export function runTargetsDefaultBranch(
  availability: RunAvailabilityResponse | null,
): boolean {
  if (!availability?.branch || !availability.defaultBranch) return false;
  return availability.branch === availability.defaultBranch;
}

/** Resets the store between tests. Mirrors `resetProjectContextStoreForTests`. */
export function resetRunStoreForTests(): void {
  useRunStore.getState().reset();
}
