/**
 * Read-only project authoring metadata (issue #105): the contexts this
 * project's organization has, the names of the project's environment
 * variables, and the handful of project settings that change how a config
 * behaves.
 *
 * Deliberately a separate store from `appStore`, for the same reason
 * `orbStore` is: none of this is config state, none of it goes through
 * `mutate()`, and none of it is ever written back. Everything here answers
 * "what may I reference from this config", which is authoring information --
 * as distinct from run history, which stays out of scope (issue #105).
 *
 * The one thing this store feeds *into* the config is a context name dragged
 * onto a workflow job entry, and that edit goes through `appStore.mutate()`
 * and `addWorkflowJobEntryContext` like every other edit.
 */
import { create } from 'zustand';

import {
  restrictionCertainty,
  type RestrictionCertainty,
} from '~/lib/contexts/usability';
import {
  getContextVariables,
  getProjectContext,
  type ContextRestrictionDetail,
  type ContextSummary,
  type ContextUsability,
  type ContextVariableSummary,
  type ProjectContextWarning,
  type ProjectSettingsSummary,
  type ProjectSummary,
  type ProjectVariableSummary,
} from '~/lib/rpc/client';

/**
 * The project-metadata state machine.
 *
 * - `idle`: nothing fetched yet.
 * - `loading`: a `GET /api/project-context` is in flight.
 * - `ready`: the host answered, and `available` was true.
 * - `unavailable`: the host cannot answer at all -- no `CIRCLE_TOKEN`, or a
 *   config that is not part of a CircleCI project. Distinct from `ready`
 *   with zero contexts, because "there is no way to look this up" and "this
 *   org has no contexts" need completely different messaging, and showing
 *   the latter for the former would be a lie. Carries `reason`.
 * - `error`: the request itself failed (network/transport/non-2xx), which is
 *   the only state where a retry button makes sense.
 */
export type ProjectContextState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error';

/** Per-context detail: variable names, previews, and whether we may use it. */
export interface ContextDetail {
  variables: ContextVariableSummary[];
  usability: ContextUsability;
  restrictionSummary: string;
  /**
   * Each restriction individually (issue #251), or `null` when the restrictions
   * call failed.
   *
   * `null` is carried through rather than normalised to `[]` on purpose: an empty
   * list means "checked, and there are none", which is the one thing that may be
   * rendered as unrestricted. Collapsing the two here would make every consumer
   * downstream unable to tell them apart — the exact failure #251 forbids.
   */
  restrictions: ContextRestrictionDetail[] | null;
  /** Whether the host had a project ID to compare project restrictions against. */
  projectIdentified: boolean;
  warnings: ProjectContextWarning[];
}

/**
 * A context was just added to a job, and there is something the editor knows
 * about it that the author should see (issue #251).
 *
 * ## Why a notice and not a refusal
 *
 * The owner's instinct was to consider blocking the drag, and then thought
 * better of it out loud: *"I guess maybe we should warn, maybe not restrict"*.
 * That is the right call, and this store is where it is honoured. Our knowledge
 * is genuinely incomplete — `unevaluable` is a real state, group membership is
 * unresolvable from here, and the restrictions call can simply fail — so
 * refusing an edit on the strength of a guess would block legitimate work with
 * no way around it. The context goes in; the editor says what it knows.
 *
 * Raised only for the states that have something to say: a context that is
 * unrestricted, or one this project is explicitly allowed to use, produces
 * nothing at all. Silence has to keep meaning "nothing to report", or the notice
 * becomes furniture.
 */
export interface ContextRestrictionNotice {
  /** The context that was added. */
  contextName: string;
  /** The workflow entry it was added to, when the caller knows which. */
  entryId?: string;
  /** What is actually known — the notice's whole point is that these read differently. */
  certainty: RestrictionCertainty;
  /** The restrictions behind it, empty when they could not be read. */
  restrictions: ContextRestrictionDetail[];
  /** The context's settings page in the CircleCI web UI, when one could be built. */
  webUrl?: string;
}

interface ProjectContextStoreState {
  state: ProjectContextState;
  reason: string | null;
  error: string | null;

  projectSlug: string | null;
  project: ProjectSummary | null;
  settings: ProjectSettingsSummary | null;
  contexts: ContextSummary[];
  projectVariables: ProjectVariableSummary[];
  /** Partial failures from the last successful load -- see `ProjectContextResponse.warnings`. */
  warnings: ProjectContextWarning[];

  /** The context whose detail is open, or null while browsing the list (master/detail, per issue #29). */
  selectedContextId: string | null;
  /** Fetched context details, keyed by context ID, so re-opening one is instant. */
  details: Record<string, ContextDetail>;
  loadingContextId: string | null;

  /** The restriction notice raised by the last context added to a job, or null. */
  restrictionNotice: ContextRestrictionNotice | null;

  /**
   * Loads the project metadata. A no-op when a load is already in flight or
   * has already succeeded, unless `refresh` is true -- which also bypasses
   * the host's cache, because this data is edited in the CircleCI web UI and
   * "I just added that context" is the exact moment someone reaches for
   * refresh.
   */
  load: (refresh?: boolean) => Promise<void>;
  /** Opens one context's detail, fetching its variables if not already cached. */
  selectContext: (contextId: string) => Promise<void>;
  /** Returns to the context list. */
  clearSelectedContext: () => void;

  /**
   * Fetches one context's detail without opening it, reusing what is already
   * cached. The read-only half of `selectContext`, for callers that need to
   * *know* something about a context rather than to show it.
   */
  ensureContextDetail: (contextId: string) => Promise<ContextDetail | null>;

  /**
   * Records that `contextName` was just added to a job, and raises a
   * `restrictionNotice` if there is anything worth saying about it.
   *
   * Deliberately asynchronous and deliberately *after* the edit. The mutation
   * that adds `context:` is synchronous and must stay that way — it is a
   * surgical splice into the live YAML (#170 fixed the array-rebuild bug there),
   * and making it wait on a network call would be both a regression and a way to
   * lose an edit. So the context goes in first, unconditionally, and the notice
   * arrives when the answer does.
   *
   * A context this editor has never heard of raises nothing: with no id there are
   * no restrictions to fetch, and the inspector's own field already flags a name
   * that is not in the fetched list.
   */
  noteContextAdded: (contextName: string, entryId?: string) => Promise<void>;

  /** Dismisses the restriction notice. */
  dismissRestrictionNotice: () => void;
}

/**
 * Bumped on every `load` call so a slow in-flight response cannot overwrite
 * the results of a newer one -- the same guard `orbStore.search` uses.
 */
let loadSeq = 0;

export const useProjectContextStore = create<ProjectContextStoreState>(
  (set, get) => ({
    state: 'idle',
    reason: null,
    error: null,

    projectSlug: null,
    project: null,
    settings: null,
    contexts: [],
    projectVariables: [],
    warnings: [],

    selectedContextId: null,
    details: {},
    loadingContextId: null,
    restrictionNotice: null,

    load: async (refresh = false) => {
      const current = get();
      if (
        !refresh &&
        (current.state === 'loading' || current.state === 'ready')
      ) {
        return;
      }

      const seq = ++loadSeq;
      set({ state: 'loading', error: null, reason: null });

      try {
        const response = await getProjectContext(refresh);
        if (seq !== loadSeq) return;

        if (!response.available) {
          set({
            state: 'unavailable',
            reason: response.reason ?? null,
            project: null,
            settings: null,
            contexts: [],
            projectVariables: [],
            warnings: [],
            details: {},
            selectedContextId: null,
          });
          return;
        }

        set({
          state: 'ready',
          reason: null,
          error: null,
          projectSlug: response.projectSlug ?? null,
          project: response.project ?? null,
          settings: response.settings ?? null,
          // `?? []` on lists the host always sends: this store is the
          // boundary, and a payload that is missing one must degrade to an
          // empty list rather than crash a pane that (reasonably) maps over
          // it. Empty is still only *interpretable* as "there are none"
          // because `available` is true and no warning covers it.
          contexts: response.contexts ?? [],
          projectVariables: response.projectVariables ?? [],
          warnings: response.warnings ?? [],
          // A refresh must not leave stale detail behind: the variables in a
          // context are exactly the kind of thing that changed.
          details: refresh ? {} : get().details,
        });
      } catch (err) {
        if (seq !== loadSeq) return;
        set({
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    selectContext: async (contextId) => {
      set({ selectedContextId: contextId });
      await get().ensureContextDetail(contextId);
    },

    ensureContextDetail: async (contextId) => {
      const cached = get().details[contextId];
      if (cached) return cached;

      set({ loadingContextId: contextId });
      try {
        const response = await getContextVariables(contextId);
        // The user may have navigated away while this was in flight; the
        // fetched detail is still worth caching, just not worth showing.
        if (!response.available) {
          set((prev) => ({
            loadingContextId:
              prev.loadingContextId === contextId
                ? null
                : prev.loadingContextId,
            state: 'unavailable',
            reason: response.reason ?? null,
          }));
          return null;
        }

        const detail: ContextDetail = {
          variables: response.variables ?? [],
          usability: response.usability ?? 'unknown',
          restrictionSummary: response.restrictionSummary ?? '',
          // `?? null`, never `?? []`: a host that sent no list did not check,
          // and an empty list is the positive statement that there is nothing
          // to check. See `ContextDetail.restrictions`.
          restrictions: response.restrictions ?? null,
          projectIdentified: response.projectIdentified ?? false,
          warnings: response.warnings ?? [],
        };

        set((prev) => ({
          loadingContextId:
            prev.loadingContextId === contextId ? null : prev.loadingContextId,
          details: { ...prev.details, [contextId]: detail },
        }));
        return detail;
      } catch (err) {
        const detail: ContextDetail = {
          variables: [],
          usability: 'unknown',
          restrictionSummary: '',
          restrictions: null,
          projectIdentified: false,
          warnings: [
            {
              kind: 'contextVariables',
              headline: "This context's variables could not be loaded.",
              detail:
                err instanceof Error
                  ? `The request to this editor's own host failed: ${err.message}`
                  : undefined,
              consequences: [
                'The variable names this context holds are not shown.',
                'Whether this project may use this context was not checked either.',
              ],
            },
          ],
        };

        set((prev) => ({
          loadingContextId:
            prev.loadingContextId === contextId ? null : prev.loadingContextId,
          details: { ...prev.details, [contextId]: detail },
        }));
        return detail;
      }
    },

    clearSelectedContext: () => set({ selectedContextId: null }),

    noteContextAdded: async (contextName, entryId) => {
      const context = get().contexts.find(
        (candidate) => candidate.name === contextName,
      );
      // No id, nothing to ask. Not silence about a risk -- silence about a
      // context this editor has no record of at all, which the inspector's
      // combobox already marks as unrecognised.
      if (!context) return;

      const detail = await get().ensureContextDetail(context.id);
      if (!detail) return;

      const certainty = restrictionCertainty(detail);
      if (certainty === 'unrestricted' || certainty === 'allowed') {
        // Nothing to say. Clearing any previous notice matters as much as not
        // raising one: a stale warning about the *last* context, sitting over a
        // job that just received a perfectly fine one, is worse than no warning.
        set({ restrictionNotice: null });
        return;
      }

      set({
        restrictionNotice: {
          contextName,
          entryId,
          certainty,
          restrictions: detail.restrictions ?? [],
          webUrl: context.webUrl,
        },
      });
    },

    dismissRestrictionNotice: () => set({ restrictionNotice: null }),
  }),
);

/**
 * How much this editor knows about the organization's context list -- the
 * question issue #152's field has to answer before it dares tell anyone their
 * context name is unrecognised.
 *
 * - `complete`: the list was fetched in full. A name that isn't in it is worth
 *   flagging (still without asserting it is wrong -- see `KnownContextNames`).
 * - `partial`: the fetch succeeded overall but the context listing itself
 *   failed, or the owning organization couldn't be determined. Anything typed
 *   is unverifiable; say nothing.
 * - `unknown`: no token, not a CircleCI project, still loading, or the request
 *   failed outright. Also say nothing.
 */
export type ContextListCoverage = 'complete' | 'partial' | 'unknown';

/**
 * Whether the fetched context list can be trusted as the whole list.
 *
 * Deliberately a function of the store's state rather than a flag the host
 * sets: "the list is complete" is exactly "the response was available, and no
 * warning says the listing failed", and encoding that in one place keeps every
 * consumer from re-deriving it slightly differently.
 */
export function contextListCoverage(
  state: Pick<ProjectContextStoreState, 'state' | 'warnings'>,
): ContextListCoverage {
  if (state.state !== 'ready') return 'unknown';
  const listingFailed = state.warnings.some(
    (warning) => warning.kind === 'contexts' || warning.kind === 'organization',
  );
  return listingFailed ? 'partial' : 'complete';
}

/**
 * The project-lookup half of the store, for the top bar (issue #149), which
 * has to tell three states apart that are easy to render identically and mean
 * entirely different things:
 *
 * - `confirmed`: CircleCI returned this project's record.
 * - `absent`: CircleCI has no project at this slug (a 404 -- most often a
 *   repository that was never set up on CircleCI). *Not* an error on our side,
 *   and must not be shown as one.
 * - `unreachable`: something stopped us asking or answering -- no token, a
 *   network failure, a rate limit, a timeout.
 * - `unknown`: nothing has been fetched yet.
 */
export type ProjectLookupStatus =
  | 'confirmed'
  | 'absent'
  | 'unreachable'
  | 'unknown';

/** The project-lookup state, plus the host's own words for why, when there are any. */
export interface ProjectLookup {
  status: ProjectLookupStatus;
  /** The failing warning, when the lookup failed with one. */
  warning: ProjectContextWarning | null;
  /** Why the whole endpoint was unavailable (no token, not a CircleCI project). */
  reason: string | null;
}

/**
 * Classifies the project lookup. `absent` is keyed off the host's 404 wording
 * being distinguishable at all, which is what issue #150 fixed: before it,
 * every failure arrived as one sentence and this function could not have
 * existed.
 */
export function projectLookup(
  state: Pick<
    ProjectContextStoreState,
    'state' | 'warnings' | 'project' | 'reason'
  >,
): ProjectLookup {
  if (state.state === 'ready' && state.project) {
    return { status: 'confirmed', warning: null, reason: null };
  }

  // Only a `ready` response's warnings describe the current attempt: `error`
  // leaves the previous load's warnings in place, and reporting a stale one as
  // the reason would be its own small lie.
  const warning =
    (state.state === 'ready'
      ? state.warnings.find((candidate) => candidate.kind === 'project')
      : undefined) ?? null;

  if (warning) {
    // The host names the status code in `detail` precisely so a client can
    // tell "CircleCI says this project does not exist" from "we could not
    // ask". Matching on the code, not on prose: the code is the contract.
    const absent = warning.detail?.includes('HTTP 404') ?? false;
    return {
      status: absent ? 'absent' : 'unreachable',
      warning,
      reason: null,
    };
  }

  if (state.state === 'unavailable' || state.state === 'error') {
    return { status: 'unreachable', warning: null, reason: state.reason };
  }

  return { status: 'unknown', warning: null, reason: null };
}

/** Resets the store between tests. */
export function resetProjectContextStoreForTests(): void {
  loadSeq = 0;
  useProjectContextStore.setState({
    state: 'idle',
    reason: null,
    error: null,
    projectSlug: null,
    project: null,
    settings: null,
    contexts: [],
    projectVariables: [],
    warnings: [],
    selectedContextId: null,
    details: {},
    loadingContextId: null,
    restrictionNotice: null,
  });
}
