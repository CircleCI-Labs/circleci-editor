/**
 * Typed client for the host's local JSON API. Dependency-free (plain
 * fetch) and unit-testable in isolation.
 */
import type { GuidesResponse } from '~/lib/guides/types';
import type { MachineOfferingsResponse } from '~/lib/machineOfferings/types';
import type { ResourceClassesResponse } from '~/lib/resourceClasses/types';
import type { XcodeVersionsResponse } from '~/lib/xcodeVersions/types';

export interface Meta {
  version: string;
  configPath: string;
  configExists: boolean;
  configFound: boolean;
  projectSlug: string;
  hasToken: boolean;
  host: string;
  cwd: string;
  /**
   * This launch's per-launch CSRF token (see `internal/host/csrf.go`), which
   * `getMeta` stashes for `request` to attach to every subsequent
   * state-changing call -- see `CSRF_TOKEN_HEADER`. Any page other than the
   * one this host actually served can trigger this GET but cannot read its
   * response body (no CORS header here permits that), so exposing it here
   * costs nothing: only this page ever gets to read it.
   */
  csrfToken: string;
  /**
   * Deep link to this project in the CircleCI web UI (issue #149), built by
   * the host from the CLI-injected environment alone -- so it needs no token
   * and costs no request, and is present even when everything under
   * `/api/project-context` is unavailable.
   *
   * Absent when there is no project slug, or when the VCS type is one whose
   * web URL cannot be derived from a slug (GitLab and GitHub App projects are
   * addressed by ID). Absent means "show the identity without a link", never
   * "there is no project".
   *
   * Superseded by `ProjectSummary.webUrl` once the project record has loaded:
   * this one is built from an *assumed* VCS type, that one from the slug
   * CircleCI reports. See issue #182.
   */
  projectWebUrl?: string;

  /**
   * Deep link to this project's *organization* in the CircleCI web UI (issue
   * #20), built the same way and available on the same terms as
   * `projectWebUrl` above: from the CLI-injected environment alone, no token
   * and no request needed.
   *
   * The top bar shows "<organization>/<project>" as one label linking only to
   * the project; this is what lets the organization half be its own link
   * instead.
   *
   * Absent when there is no organization slug, or when the VCS type is one
   * whose organization page this host still cannot address (see
   * `overviewRouteVCS` on the host side). Absent means "show the
   * organization's name without a link", never "there is no organization".
   *
   * Superseded by `ProjectSummary.organizationWebUrl` once the project record
   * has loaded, on the same terms `projectWebUrl` is superseded by
   * `ProjectSummary.webUrl`: that one is built from CircleCI's own
   * `organizationSlug`, this one from an assumed VCS type.
   */
  orgWebUrl?: string;

  /**
   * The branch to show, and where it came from (issue #214).
   *
   * Two sources can disagree: `CIRCLE_BRANCH` from the CLI-injected
   * environment, and the working tree's own `HEAD`. The host prefers the
   * checkout -- the user is editing *this* tree, so a stale injected value
   * would be worse than none -- and reports `branchSource` plus the raw
   * `envBranch` so the UI can say which one it is showing when they differ,
   * rather than silently picking.
   *
   * All three absent means neither source had anything: an ordinary state for
   * a config edited outside a checkout, or a detached `HEAD`.
   */
  branch?: string;
  branchSource?: 'checkout' | 'environment';
  envBranch?: string;

  /**
   * The `origin` git remote: a browsable repository URL, its
   * `<owner>/<repo>` path, and the host serving it. Absent when there is no
   * usable remote, or when its host is not one whose web layout the host is
   * willing to assume (the same "no link beats a broken link" rule
   * `projectWebUrl` follows).
   *
   * **Not authoritative about the project's identity.** Issue #198 documented
   * the trap: a remote can be stale after a repository rename, so this is
   * where the checkout pushes, while `/api/project-context` is what CircleCI
   * calls the project. Never render this in place of the project record's own
   * name.
   */
  repoWebUrl?: string;
  repoName?: string;
  repoHost?: string;

  /**
   * Which source `projectSlug` came from: `binding` for
   * `.circleci/info.yml`, `environment` for the CIRCLE_* variables the CLI
   * injected. Absent when there is no slug at all.
   *
   * Issue #198: the binding wins, because a git-remote-derived slug goes
   * permanently stale the moment a repository is renamed while a recorded
   * binding does not. Reported rather than merely applied, so the UI can say
   * where the identity came from instead of presenting two rather different
   * confidences identically.
   */
  projectSlugSource?: 'binding' | 'environment';

  /**
   * What `.circleci/info.yml` said, or why it said nothing. Always present:
   * `status: 'absent'` is an answer, and a missing key could not be told apart
   * from "the host did not look".
   */
  projectBinding: ProjectBindingInfo;
}

/**
 * `.circleci/info.yml`: the file `circleci project link` writes to record which
 * CircleCI project a checkout belongs to (issue #198).
 *
 * The editor **never writes this file**, and no UI may offer to. It is committed
 * alongside `.circleci/config.yml`, so creating or changing it is a change to the
 * user's repository rather than a local preference; the only remedy this app
 * offers is to suggest the command that owns it.
 */
export interface ProjectBindingInfo {
  /**
   * Three states, and they must never render identically:
   *
   * - `absent`: no such file. The ordinary case — most checkouts have never been
   *   linked — and never an error.
   * - `present`: read, and it names a project.
   * - `malformed`: a file exists and the host could not use it. The project
   *   shown is then the CLI-injected fallback rather than the user's own
   *   recorded answer, which is a materially weaker claim and has to look like
   *   one.
   */
  status: 'absent' | 'present' | 'malformed';
  /** Where the host looked, present even when nothing was there. */
  path?: string;
  /** The recorded project slug. Superseded by `ProjectSummary.slug` once CircleCI's own record arrives. */
  slug?: string;
  projectName?: string;
  organizationName?: string;
  /** The host's sentence naming why a file that exists could not be used. Present only for `malformed`. */
  problem?: string;
  /** The host's own prose for this binding, shown verbatim so the two sides cannot disagree about what the file is — the rule `configReason` already follows. */
  description: string;
  /**
   * True when the binding and the CLI-injected environment name different
   * projects — issue #198's symptom seen from the inside, since a renamed
   * repository leaves the remote-derived environment naming a repository that no
   * longer exists under that name. The binding wins; `environmentSlug` carries
   * the loser so both can be named rather than one silently discarded.
   */
  disagreesWithEnvironment?: boolean;
  environmentSlug?: string;
}

export interface ConfigPayload {
  path: string;
  contents: string;
  exists: boolean;
}

export interface SaveResult {
  path: string;
  bytes: number;
}

/** One problem reported by the CircleCI compiler for a submitted config. */
export interface ValidateErrorItem {
  message: string;
}

/**
 * The JSON shape returned by `POST /api/validate`. Callers must check
 * `available` before interpreting `valid`/`errors`/`outputYaml`.
 * `available: false` means validation could not be attempted at all, and
 * `source` says which of two different reasons that is -- they call for
 * opposite fixes, so they must not be conflated (issue #224):
 *
 *   - `source: "unavailable"`: this host has no `CIRCLE_TOKEN` configured.
 *     The fix is to add one.
 *   - `source: "unauthorized"`: this host has a token and CircleCI rejected
 *     it (HTTP 401). The fix is to replace it -- and this is deliberately
 *     *not* the same thing as CircleCI being unreachable, even though both
 *     used to surface as an identical `ApiError`.
 *
 * Either way, this is not the same thing as an invalid config, and must
 * never be presented to the user as one. A transport failure, or any other
 * non-2xx this host cannot classify this specifically, still surfaces as a
 * non-2xx response (`ApiError`) rather than through this shape.
 */
export interface ValidateResponse {
  available: boolean;
  source: string;
  valid: boolean;
  errors?: ValidateErrorItem[];
  outputYaml?: string;
  reason?: string;
  /**
   * Set when the compile went ahead without something that can change its
   * verdict -- today, only a missing organization, which leaves private orbs
   * and allow-listed URL orbs unresolvable (issue #67). Only ever present
   * alongside `valid: false`, and it does not soften that verdict: it states
   * the limits of the check that produced it, so an error naming an orb can
   * be read for what it is rather than as proof the config is wrong.
   */
  caveat?: string;
}

interface ErrorEnvelope {
  error: {
    message: string;
  };
}

/** Thrown for any non-2xx response from the host API. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return typeof (error as Record<string, unknown>).message === 'string';
}

/**
 * The header `request` attaches `csrfToken` to on every state-changing call
 * -- a header, never a body field or query parameter, because the point of
 * this whole mechanism (see `internal/host/csrf.go`) is that a forged
 * cross-site `<form>` submission cannot set one. Must match the Go host's
 * own `CSRFTokenHeader` constant exactly, or every mutating call this client
 * makes would be refused.
 */
const CSRF_TOKEN_HEADER = 'X-CircleCI-Editor-CSRF-Token';

/**
 * This launch's CSRF token, learned from `Meta.csrfToken` the one time
 * `getMeta` is called during `appStore`'s `load()` -- before which nothing
 * in this app makes a state-changing call, so there is no window where a
 * mutating request could go out without it. Module-level rather than
 * threaded through every call site: every function below already reads
 * from a single running editor session, and only ever needs the *current*
 * launch's token, never a caller-chosen one.
 */
let csrfToken: string | undefined;

/** Whether method is one `request` attaches the CSRF token to -- every method but GET/HEAD, mirroring the Go host's own `isUnsafeMethod`. */
function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(isUnsafeMethod(method) && csrfToken
        ? { [CSRF_TOKEN_HEADER]: csrfToken }
        : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const message = isErrorEnvelope(body)
      ? body.error.message
      : `Request to ${path} failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return body as T;
}

export async function getMeta(): Promise<Meta> {
  const meta = await request<Meta>('/api/meta');
  // Stashed for every subsequent mutating call -- see csrfToken's own doc
  // comment for why this is the one place that needs to do this.
  csrfToken = meta.csrfToken;
  return meta;
}

/**
 * Fetches a config file's contents. `path` (absolute) selects a file other
 * than the host's primary resolved config -- issue #106's file switcher --
 * and is validated host-side against the indexed `.circleci` directory
 * (`internal/host/configdir.go`'s `resolveIndexedPath`) before anything is
 * read, so a caller cannot use this to reach outside it even by mistake.
 */
export function getConfig(path?: string): Promise<ConfigPayload> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  return request<ConfigPayload>(`/api/config${qs}`);
}

/** Writes `contents` to `path` (defaulting to the host's primary config when omitted), applying the same host-side directory boundary `getConfig` does. */
export function putConfig(
  contents: string,
  path?: string,
): Promise<SaveResult> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  return request<SaveResult>(`/api/config${qs}`, {
    method: 'PUT',
    body: JSON.stringify({ contents }),
  });
}

/** One file found in the indexed `.circleci` directory -- see `getConfigFiles`. */
export interface ConfigFileInfo {
  path: string;
  relPath: string;
  size: number;
  /** Whether this is the one file the host resolved at startup (or via `--config`) -- the file every pre-#106 API already treated as "the" config. */
  isPrimary: boolean;
  /** Present only when `getConfigFiles(true)` was called and the file was not larger than the host's per-file cap. */
  contents?: string;
  /** True iff contents were requested but this file exceeded the host's per-file cap -- so "no `contents`" can be told apart from "empty file". */
  omitted?: boolean;
  /**
   * Whether the host judged this file to structurally *be* a CircleCI
   * config (issue #135). A `.circleci` directory routinely holds YAML that
   * isn't one -- the reported case was goss's `goss.yaml`, whose top-level
   * `command:` block is one character away from CircleCI's `commands:`.
   *
   * Classified by the host, never re-derived here. Non-configs are still
   * listed (and still openable): the switcher hides them behind a reveal
   * rather than dropping them, so a misclassified real config costs one
   * click instead of becoming invisible.
   */
  isConfig: boolean;
  /** The host's own human-readable reason for `isConfig` ("Declares version: 2.1.", "No CircleCI structure: ..."), shown verbatim so this UI can never disagree with the host about why. */
  configReason: string;
  /**
   * What this file is *for*, when it is not a config but the host recognises it
   * anyway — today only `projectBinding`, for `.circleci/info.yml`.
   *
   * Issue #198's item 4: the classifier is right that a binding is not a
   * CircleCI config, but leaving it at that listed a *meaningful* file among
   * unexplained other YAML. A named file is not unexplained.
   *
   * Layered on top of `isConfig` rather than overriding it: a named non-config
   * is still hidden behind the switcher's reveal, so the editor never offers to
   * open a project binding as though it were a config.
   */
  knownRole?: 'projectBinding';
  /** The host's own prose for `knownRole`, shown in place of `configReason`. */
  knownRoleSummary?: string;
}

/** The JSON shape returned by `GET /api/config-files` (issues #106 and #102's shared directory index). */
export interface ConfigFilesResponse {
  dir: string;
  primaryPath: string;
  files: ConfigFileInfo[];
}

/**
 * Lists every `.yml`/`.yaml` file in the directory containing the open
 * config (normally `.circleci/`), landed once and used by both issue #106
 * (the file switcher) and issue #102 (the AI pane's directory context).
 * Pass `withContents: true` to have the host inline each file's text in
 * the same round trip -- used only by the AI context assembler, which
 * needs every sibling file's content to build its token-bounded context.
 */
export function getConfigFiles(
  withContents = false,
): Promise<ConfigFilesResponse> {
  const qs = withContents ? '?contents=1' : '';
  return request<ConfigFilesResponse>(`/api/config-files${qs}`);
}

/** Submits `contents` to the host's config-validation endpoint. See `ValidateResponse` for how to read the result. */
export function postValidate(contents: string): Promise<ValidateResponse> {
  return request<ValidateResponse>('/api/validate', {
    method: 'POST',
    body: JSON.stringify({ contents }),
  });
}

/** One config-policy rule that fired, with the policy author's own words. */
export interface PolicyViolationItem {
  /** The Rego rule name, e.g. `use_official_docker_image`. */
  rule: string;
  /** The reason the policy printed. Rendered verbatim -- it is the only actionable part. */
  reason: string;
}

/**
 * The JSON shape returned by `POST /api/policy/decide` (issue #215).
 *
 * Read it the way `internal/host/policy.go` documents, because a policy
 * decision is a security control and the three outcomes must never blur:
 *
 *  - `available: true` -- the engine answered. `status` is `PASS`,
 *    `SOFT_FAIL`, `HARD_FAIL` or `ERROR`, and `enabledRules` says what was
 *    evaluated. **A `PASS` with an empty `enabledRules` means the
 *    organization has no enabled rules**, which is not the same statement as
 *    "this config satisfies your policies".
 *  - `available: false` (still HTTP 200) -- no decision was reached and
 *    retrying now will not change that: no token, no organization, a plan
 *    without config policies, a config the engine could not parse, or a
 *    status this editor cannot interpret. `reason` says which.
 *  - a thrown `ApiError` -- no decision was reached for a reason that may be
 *    transient (a rejected token, rate limiting, a CircleCI server error, an
 *    unreachable network).
 *
 * The last two are both "we could not check". Rendering either as "no
 * violations" is the one failure this feature exists to avoid.
 *
 * Orthogonal to all three: `available: true` still splits into "checked
 * against source plus the compiled config" and "checked against source
 * only" (`compiledConfigIncluded`, issue #25). Both are real decisions --
 * neither is "we could not check" -- but only the first is the document
 * CircleCI itself evaluates at pipeline-trigger time, so a `PASS` with
 * `compiledConfigIncluded: false` is not the same statement as a `PASS`
 * with it `true`.
 */
export interface PolicyDecisionResponse {
  available: boolean;
  source: string;
  reason?: string;
  /** `PASS` | `SOFT_FAIL` | `HARD_FAIL` | `ERROR`, present only when `available`. */
  status?: string;
  /** Every rule evaluated, whether or not it fired. */
  enabledRules?: string[];
  /** Blocking violations: on CircleCI these refuse the pipeline. */
  hardFailures?: PolicyViolationItem[];
  /** Non-blocking violations: flagged, but a pipeline still runs. */
  softFailures?: PolicyViolationItem[];
  /** The engine's own explanation, which some `ERROR` decisions carry. Distinct from `reason`, which is the *host* saying it has no decision at all. */
  decisionReason?: string;
  /** Whose policies were consulted, and which bundle. */
  orgSlug?: string;
  policyContext?: string;
  /**
   * The `data.meta` keys the host was able to supply (`project_id`,
   * `vcs.branch`). Empty means none: a rule scoped to a project or a branch
   * does not fire without them, so its silence here is not evidence that it
   * would be silent on CircleCI. The UI says so.
   */
  metadataSent?: string[];
  /**
   * Whether `status` above was decided against the same document CircleCI
   * itself evaluates at pipeline-trigger time -- source plus a `_compiled_`
   * key holding the config after 2.1->2.0 compilation (issue #25) -- or
   * against the source alone. `false` means a rule written against
   * `input._compiled_` may not have fired here even though it would on
   * CircleCI, which is a fact about *this check*, not about the config, and
   * must be shown alongside the verdict rather than left to a log line.
   */
  compiledConfigIncluded?: boolean;
  /** Why the compiled config was left out. Set only when `compiledConfigIncluded` is false. */
  compiledConfigReason?: string;
}

/**
 * Sends `contents` to CircleCI's config-policy engine, via the host, and
 * returns the decision.
 *
 * **This posts the config to CircleCI**, which is a different outbound flow
 * from validation and is stated as such in the UI and in this editor's own
 * "What leaves your machine" guide. It runs only because the user asked for
 * it -- see `policyStore`, which has no debounce and no automatic trigger.
 * Nothing here can write policies: the host implements no counterpart to
 * `circleci policy push`.
 */
export function postPolicyDecide(
  contents: string,
): Promise<PolicyDecisionResponse> {
  return request<PolicyDecisionResponse>('/api/policy/decide', {
    method: 'POST',
    body: JSON.stringify({ contents }),
  });
}

/**
 * Whether this project can run the open config on CircleCI *without
 * committing it*, and why not when it cannot.
 *
 * Six states, and a client must switch on all six. The two that must never
 * render alike are `organization-disabled`/`project-disabled` ("CircleCI will
 * refuse this") and `unknown` ("we could not find out") -- issue #194's central
 * degradation requirement. There is no boolean to collapse this into,
 * deliberately: a boolean would have to pick a side for `unknown`, and either
 * choice is a lie.
 */
export type RunAvailabilityStatus =
  | 'available'
  | 'organization-disabled'
  | 'project-disabled'
  | 'no-token'
  | 'no-project'
  | 'unknown'
  /**
   * Both gates are on, but the host cannot establish which of CircleCI's two
   * trigger endpoints would actually *honour* an inline config here.
   *
   * Its own state because it is the one refusal that prevents a wrong
   * *success*: on some project types the newer endpoint accepts an inline
   * config, answers 201, and runs the committed config instead. Silent-ignore
   * is undetectable before the money is spent, so uncertainty about the route
   * has to mean "no".
   */
  | 'unroutable';

/** Which endpoint carries the inline config. */
export type RunConfigRoute = 'legacy' | 'pipeline-run' | 'unknown';

/**
 * Whether the host confirmed, by reading the pipeline's own config back, that
 * the pipeline is running the config that was submitted.
 *
 * `mismatch` is the wrong-green case this exists to catch, and `unverified` is
 * neither a pass nor a failure -- the config is stored asynchronously, so "we
 * could not check yet" is a real answer.
 */
export type RunConfigVerification = 'confirmed' | 'mismatch' | 'unverified';

/**
 * The precondition report for a one-shot unversioned run.
 *
 * Everything here is answerable before anything has run, which is what keeps it
 * on the authoring side of this app's scope. Nothing here describes a run.
 */
export interface RunAvailabilityResponse {
  status: RunAvailabilityStatus;
  /** The host's own prose for `status`, rendered verbatim. Always present, including when a run *is* available. */
  reason: string;
  /** Exactly what a run would target. Quote these in a confirmation rather than re-deriving them. */
  projectSlug?: string;
  branch?: string;
  /** `checkout` for the working tree's own HEAD, `environment` for `CIRCLE_BRANCH`. */
  branchSource?: string;
  /**
   * The project's default branch, when known.
   *
   * Absent is **"we do not know"**, never "this is not the default branch". A
   * client that treats absence as the latter would silently drop the stronger
   * confirmation on exactly the branch that most needs it.
   */
  defaultBranch?: string;
  /**
   * Whether the project uses dynamic config.
   *
   * A caveat, not a gate. CircleCI's docs say unversioned config is disabled
   * for dynamic-config projects, but that could not be verified against the
   * live API, so the host reports it and the UI warns rather than refusing a
   * run that may well work.
   */
  dynamicConfig?: boolean;
  /** Which endpoint would carry the config. Useful when a run surprises someone. */
  configRoute?: RunConfigRoute;
  /**
   * Where `projectSlug` came from -- `binding` for `.circleci/info.yml`,
   * `environment` for the CLI-injected slug.
   */
  identitySource?: string;
  /** What the injected environment claimed, carried even when the binding won. */
  environmentSlug?: string;
  /**
   * `.circleci/info.yml` and the environment name different projects.
   *
   * The run follows the same binding-wins precedence used elsewhere -- this flag exists so
   * the confirmation can *say* that rather than let the one surface that spends
   * money be the only one that quietly picked a side.
   */
  identityDisagrees?: boolean;
}

/**
 * The result of asking CircleCI to run a config that is not in the repository.
 *
 * `triggered: false` at HTTP 200 is a *refusal*, not an error and not a run --
 * the same tri-state convention `PolicyDecisionResponse` documents. A thrown
 * `ApiError` is the third case, and the only one where this editor cannot say
 * whether a pipeline was created.
 *
 * Note what is absent: nothing to poll, no job list, no progress. This
 * product's scope permits the *assistant* to consult run data for diagnosis
 * while still forbidding this product from rendering an observation UI, so
 * the whole intended use of this response is a deep link.
 */
export interface RunResponse {
  triggered: boolean;
  /** Why no run happened. Present when `triggered` is false. */
  reason?: string;
  /** The availability state behind a refusal, so a client renders it from the same six-way vocabulary. */
  status?: RunAvailabilityStatus;
  pipelineId?: string;
  pipelineNumber?: number;
  /** CircleCI's word for the pipeline at the instant it was created. Never refreshed; say so if you show it. */
  state?: string;
  /**
   * The CircleCI web UI URL for the new pipeline.
   *
   * Absent for a project whose VCS type is not name-addressed: render
   * the pipeline number as plain text rather than a link that cannot work.
   */
  webUrl?: string;
  /** What was actually triggered, echoed back, so a client can prove the run went where the confirmation said. */
  projectSlug?: string;
  branch?: string;
  configRoute?: RunConfigRoute;
  /**
   * Whether the pipeline is provably running the submitted config.
   *
   * A client **must** render `mismatch` as a failure of the whole point of the
   * feature, not as a footnote: the pipeline will go green while testing a
   * config the user never wrote.
   */
  configVerified?: RunConfigVerification;
}

/** Asks the host whether a one-shot unversioned run can be offered, and against what. */
export function getRunAvailability(): Promise<RunAvailabilityResponse> {
  return request<RunAvailabilityResponse>('/api/run/availability');
}

/**
 * Runs `contents` on CircleCI, on `branch`, without committing it.
 *
 * **This is the only call in this client that spends the user's money.** It
 * starts a real pipeline, on a real branch, visible to the whole organization
 * in the CircleCI dashboard. It must only ever be reached from an explicit,
 * confirmed user action that named the project, the branch and which config --
 * never from an effect, a debounce, a save, or a validation. See `runStore`,
 * which has no automatic path to it, and `RunDialog`, which is its only caller.
 *
 * `branch` is required and is echoed back by the host, which refuses the run
 * outright if it does not match the branch it would have targeted. That is what
 * stops a confirmation dialog from being decorative.
 */
export function postRun(
  contents: string,
  branch: string,
  parameters?: Record<string, unknown>,
): Promise<RunResponse> {
  return request<RunResponse>('/api/run', {
    method: 'POST',
    body: JSON.stringify({ contents, branch, parameters }),
  });
}

/**
 * Why the orb list looks the way it does — the host's own classification, not
 * something to re-derive from the counts.
 *
 * It exists because before issue #257 there was no answer available at all:
 * `internal/orbs.Cache` recorded a failure reason, the status payload had
 * nowhere to put it, and so a list that was empty because the registry call
 * failed arrived byte-for-byte identical to a list that was empty because there
 * are no orbs. Rendering those two the same way is the honest-degradation rule
 * broken — the same rule the context four-state model (#105) and the
 * three-state project binding (#198) exist to keep.
 *
 * - `'never-fetched'` — no orbs, nothing in flight, no failure recorded.
 * - `'fetching'` — no orbs yet, and a crawl is running. Waiting is the answer.
 * - `'empty'` — a fetch completed and the registry genuinely reported no orbs.
 *   Normal on a CircleCI Server installation, whose registry is private to the
 *   installation and seeded one orb at a time by an admin (issue #256).
 * - `'failed'` — no orbs, and `reason` says why.
 * - `'stale'` — orbs that are usable but not current: either the last refresh
 *   failed (`reason` set) or the listing is past `refreshWindowHours`. Served
 *   and labelled, because an old registry listing is still a real one.
 * - `'ready'` — orbs, fetched inside the window, no recorded failure.
 */
export type OrbCacheState =
  | 'never-fetched'
  | 'fetching'
  | 'empty'
  | 'failed'
  | 'stale'
  | 'ready';

/** The orb registry cache's current warm-up progress, as reported alongside every search result. */
export interface OrbSearchStatus {
  ready: boolean;
  complete: boolean;
  count: number;
  warming: boolean;
  /**
   * How many of `count` are certified, and how many are private -- the two
   * facts a search can be filtered on (see `OrbSearchFilter`).
   *
   * `privateCount` is the load-bearing one. Zero private orbs cached means
   * "nothing private turned up in what this host's token was shown while
   * crawling", which is emphatically *not* the same claim as "your
   * organizations have no private orbs", and the UI must not let an empty
   * list imply the second (issue #151).
   */
  certifiedCount: number;
  privateCount: number;

  /**
   * Which of the six states above this cache is in. Always sent by the host;
   * optional here only so a response from an older host (or a fixture written
   * before #257) doesn't have to be treated as malformed -- callers fall back
   * to saying they don't know, which is the honest answer in that case.
   */
  state?: OrbCacheState;

  /**
   * The classified reason the most recent refresh failed, or absent when there
   * is none.
   *
   * Safe to render verbatim: the host puts this through
   * `describeUpstreamError`, which discloses an HTTP status code and never the
   * upstream response body. Do not concatenate it with a guess about
   * the cause -- it is the whole of what is known.
   */
  reason?: string;

  /** When the current listing was fetched (RFC 3339), absent when nothing complete ever has been. */
  fetchedAt?: string;

  /** The listing is real but past `refreshWindowHours`. Can be true alongside a `reason`; both are worth saying. */
  stale?: boolean;

  /** What `stale` is measured against, so a "this is old" message can name the window instead of just asserting it. */
  refreshWindowHours?: number;

  /**
   * This host is configured against something other than circleci.com
   * (`CIRCLE_HOST`). It changes what an *empty* registry most likely means and
   * therefore what is honest to say about one: on CircleCI Server an empty orb
   * registry is the ordinary starting state, since the installation's registry
   * is seeded per-orb by an admin, whereas on cloud it would be a surprise.
   */
  selfHosted?: boolean;
}

/**
 * Which slice of the registry a search was scoped to.
 *
 * There is deliberately no `'partner'`. The orb registry's own filter is not
 * backed by the CircleCI API at all -- the developer hub queries an Algolia
 * index carrying `is_partner`, and no CircleCI API this host can call exposes
 * partner status in any form (verified against the live v3 and
 * graphql-unstable APIs -- see `internal/orbs.Filter`, which records exactly
 * what was probed). The host rejects an unrecognised filter with a 400 rather
 * than answering an unfiltered search, so a `'partner'` value invented here
 * would fail loudly rather than mislabel anything.
 */
export type OrbSearchFilter = 'all' | 'certified' | 'private';

/**
 * What one search request matched, as distinct from what the cache holds
 * (`OrbSearchStatus`).
 *
 * `matched` vs `matchedUnfiltered` is how the UI answers "is a filter the
 * reason this list is short?" -- the difference between them is exactly what
 * the active filter is hiding. `scopeSize` separately distinguishes "your
 * query matched none of your private orbs" from "no private orbs were found
 * at all", which look identical in an empty list and mean different things.
 */
export interface OrbSearchMatch {
  filter: OrbSearchFilter;
  /** Matches within the filter's scope, counted before `limit` truncated the results. */
  matched: number;
  /** The same count with the filter removed; equal to `matched` for `'all'`. */
  matchedUnfiltered: number;
  /** Cached packages in the filter's scope at all, regardless of the query. */
  scopeSize: number;
}

/** One orb package matching a search query. */
export interface OrbSearchResult {
  name: string;
  private: boolean;
  certified: boolean;
  /**
   * Whether this orb opted in to registry listing. Distinct from
   * `private`: an orb can be public yet unlisted (resolved only because it
   * matched by exact name), or private yet listed within its own org.
   */
  listed: boolean;
  /** Empty for a reserved orb name with no published version. */
  latestVersion: string;
  /** Newest-first (the host, not this client, sorts these). */
  versions: string[];
  matchedOn: string;
}

/**
 * The JSON shape returned by `GET /api/orbs/search`. Same `available`
 * convention as `ValidateResponse`: `available: false` means the host has
 * no `CIRCLE_TOKEN` and search could not be attempted at all -- which must
 * never be presented as "no orbs matched". `results` is already ranked by
 * the host (certified orbs first); callers must render it in that order,
 * not re-sort it, or the ranking the server worked out would be undone.
 */
export interface OrbSearchResponse {
  available: boolean;
  source?: string;
  reason?: string;
  status?: OrbSearchStatus;
  /** Omitted exactly when `status` is -- nothing was searched, so there is nothing to count. */
  match?: OrbSearchMatch;
  results?: OrbSearchResult[];
}

/**
 * The JSON shape returned by `GET /api/orbs/source`. Same `available`
 * convention again; when `available` is true, `source` holds the orb
 * version's raw YAML text, otherwise it holds the literal string
 * `"unavailable"` and `reason` explains why.
 *
 * `versions`/`latestVersion` (issue #89's version picker) are this orb's
 * *complete* version history, not whatever `searchOrbs` happened to carry:
 * the host resolves this endpoint via a live, single-name lookup, which
 * the real CircleCI API answers with every version, unlike the crawled
 * cache `searchOrbs` ranks against (see the host's own
 * `orbsSourceResponse` doc comment for why those two legitimately
 * disagree). Present whenever `available` is true, regardless of which
 * `version` was requested -- switching to an older version must not
 * narrow this back down to just that one.
 */
export interface OrbSourceResponse {
  available: boolean;
  name?: string;
  version?: string;
  source: string;
  reason?: string;
  versions?: string[];
  latestVersion?: string;
}

/**
 * Searches the host's locally cached orb registry for `query`, capped at
 * `limit` results (the host itself clamps this to 100) and optionally scoped
 * to one `filter` (see `OrbSearchFilter`). Ranking (certified orbs first, then
 * by match quality) happens server-side -- see `OrbSearchResponse`'s doc
 * comment for why callers must not re-sort.
 *
 * `filter` is only sent when it narrows anything: `'all'` is the host's own
 * default, and omitting it keeps the request URL (and every existing test's
 * expectation of it) unchanged for the unfiltered case.
 *
 * `refresh` (issue #285) triggers the cache's manual "check now" re-crawl
 * (`orbs.Cache.Refresh`) before this search runs -- the counterpart to
 * `getProjectContext`'s own `refresh` for the palette's Contexts section. It
 * only ever *triggers* the crawl; a full re-crawl can take minutes, so this
 * request still answers immediately with whatever is cached (`status.warming`
 * says the crawl is now running), not with the crawl's eventual result.
 */
export function searchOrbs(
  query: string,
  limit?: number,
  filter?: OrbSearchFilter,
  refresh = false,
): Promise<OrbSearchResponse> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (limit !== undefined) params.set('limit', String(limit));
  if (filter !== undefined && filter !== 'all') params.set('filter', filter);
  if (refresh) params.set('refresh', '1');
  const qs = params.toString();
  return request<OrbSearchResponse>(`/api/orbs/search${qs ? `?${qs}` : ''}`);
}

/** Fetches one orb version's raw YAML source. `version` defaults to the orb's latest published version when omitted. */
export function getOrbSource(
  name: string,
  version?: string,
): Promise<OrbSourceResponse> {
  const params = new URLSearchParams({ name });
  if (version) params.set('version', version);
  return request<OrbSourceResponse>(`/api/orbs/source?${params.toString()}`);
}

/**
 * Fetches the vendored CircleCI configuration JSON Schema from
 * `GET /api/schema`, used to drive YAML autocompletion (issue #32).
 * Returned as `unknown` rather than a typed shape -- this client only ever
 * hands it to `parseCircleciSchema` (`~/lib/schema/circleciSchema`), which
 * is responsible for safely navigating an otherwise-untyped JSON Schema
 * document. Requires no token and is available on every host (see the
 * endpoint's own doc comment in `internal/host/schema.go`), so unlike
 * every other function here there is no `available`/`reason` envelope to
 * check.
 */
export function getSchema(): Promise<unknown> {
  return request<unknown>('/api/schema');
}

/**
 * Fetches CircleCI's three prose configuration guides -- the configuration
 * reference, reusable config and dynamic config -- from `GET /api/guides`
 * (issue #104), already parsed by the Go host into the block model in
 * `~/lib/guides/types`.
 *
 * Typed, unlike `getSchema`, because the host owns the parse and the shape is
 * this project's own (`internal/guides/model.go`); nothing here has to walk
 * untyped third-party JSON.
 *
 * Requires no token. Unlike `getSchema` it carries an `available`/`reason`
 * envelope -- but not for network or auth reasons: the guides are embedded in
 * the binary, so `available: false` means the host could not parse its own
 * snapshot. `provenance` says which upstream commit the text came from and
 * whether a background refresh is in flight or last failed; the content is
 * always complete regardless, so `refreshing` must never be rendered as a
 * loading state. See that endpoint's doc comment in `internal/host/guides.go`.
 *
 * `refresh` (issue #285) triggers the cache's manual "check now" fetch
 * (`guides.Cache.Refresh`) before this request answers -- unlike the orbs
 * cache's own `refresh`, this one is small enough that a *triggered* check
 * often finishes within this same round trip when nothing has changed
 * upstream, but callers must still treat `provenance.refreshing` as
 * authoritative rather than assuming that.
 */
export function getGuides(refresh = false): Promise<GuidesResponse> {
  return request<GuidesResponse>(`/api/guides${refresh ? '?refresh=1' : ''}`);
}

/**
 * Fetches the resource classes each executor environment offers, from
 * `GET /api/resource-classes` (issue #181) -- derived by the host from
 * CircleCI's own vendored resource tables rather than hardcoded in this app,
 * which is what stops the list drifting from the platform.
 *
 * Its own request rather than a field on `getGuides`: that payload is ~500 KB of
 * parsed prose, and opening a "New job" dialog should not pull the documentation
 * corpus to populate a dropdown. Its own request rather than part of `getSchema`
 * too, for the opposite reason -- the schema is immutable for a process's
 * lifetime and cached for a day, whereas this can change under a background docs
 * refresh.
 *
 * Requires no token. `derived: false` means the classes came from the snapshot
 * embedded in the running release rather than the documentation the host is
 * serving, and the field showing them has to say so. See that endpoint's doc
 * comment in `internal/host/resourceclasses.go`.
 */
export function getResourceClasses(): Promise<ResourceClassesResponse> {
  return request<ResourceClassesResponse>('/api/resource-classes');
}

/**
 * Fetches the Xcode versions the macOS executor accepts, from
 * `GET /api/xcode-versions` (issue #211) -- derived by the host from CircleCI's
 * own vendored supported-Xcode table.
 *
 * A sibling of `getResourceClasses` rather than a field on it: two independent
 * consumers want this and not the resource tables (the macOS executor field and
 * the YAML pane's `xcode:` completion), and the resource-class consumers want the
 * tables and not this.
 *
 * Requires no token. `derived: false` means the versions came from the snapshot
 * embedded in the running release rather than the documentation the host is
 * serving, and the field showing them has to say so.
 */
export function getXcodeVersions(): Promise<XcodeVersionsResponse> {
  return request<XcodeVersionsResponse>('/api/xcode-versions');
}

/**
 * Fetches CircleCI's live machine-image catalog from
 * `GET /api/machine-offerings` (issue #305): which images are offered for
 * which resource class (the compatibility mapping the picker uses to filter
 * itself), and which images CircleCI has deprecated.
 *
 * Requires no token -- the upstream endpoint answers unauthenticated,
 * consistent with #160 making orb browsing tokenless. `available: false`
 * means no catalog has ever been fetched and the caller should fall back to
 * `images.ts`'s hand-curated `MACHINE_IMAGES` literal, still the offline
 * floor it has always been; see `MachineOfferingsResponse`'s own doc comment
 * for the rest of the honest-degradation states.
 *
 * `refresh` (issue #285) bypasses the host's 24h cache, for the picker's own
 * manual "check now" affordance -- like `getDockerTags`, this is a single
 * small request, so the refreshed result is what this call itself returns.
 */
export function getMachineOfferings(
  refresh = false,
): Promise<MachineOfferingsResponse> {
  return request<MachineOfferingsResponse>(
    `/api/machine-offerings${refresh ? '?refresh=1' : ''}`,
  );
}

/**
 * Which of the honest-degradation states `GET /api/usage`'s cache is in --
 * mirrors `OrbCacheState` (issue #257's own model, reused rather than
 * reinvented for issue #307):
 *
 * - `'never-fetched'` -- nothing held, nothing in flight, no failure yet.
 * - `'fetching'` -- a warm cycle (cold start, delta, or a manual refresh) is
 *   running. Waiting is the right answer.
 * - `'empty'` -- a warm cycle completed and genuinely found nothing in the
 *   window (e.g. a brand-new organization with no runs yet).
 * - `'failed'` -- nothing held, and `reason` says why. Usage export may
 *   require organization-admin access (unverified); a 403 here degrades to
 *   this state rather than looking broken, the same shape `policy/decide`
 *   (#247) uses.
 * - `'stale'` -- data held, but either the last warm failed (`reason` set)
 *   or the covered range has fallen behind the last complete UTC day.
 *   Served and labelled, never withheld.
 * - `'ready'` -- data held, covering through the last complete UTC day, no
 *   recorded failure.
 */
export type UsageCacheState =
  | 'never-fetched'
  | 'fetching'
  | 'empty'
  | 'failed'
  | 'stale'
  | 'ready';

/** The usage cache's current warm-up progress, as reported alongside every `GET /api/usage` response. */
export interface UsageStatus {
  ready: boolean;
  warming: boolean;
  state: UsageCacheState;
  /** Safe to render verbatim -- see `OrbSearchStatus.reason`'s own doc comment for why. */
  reason?: string;
  /** The currently configured retention/fetch window, one of 7, 14, or 30. */
  windowDays: number;
  /**
   * The UTC calendar-day range this cache currently holds data for, both
   * RFC 3339, both inclusive -- `coveredThrough` is the *last complete day*
   * covered, deliberately never today: a window ending today would include
   * jobs that may still be running, whose utilisation and credits are not
   * yet final. Both absent when nothing is held yet.
   */
  coveredFrom?: string;
  coveredThrough?: string;
  /** When the most recent successful warm cycle finished. Absent until the first one completes. */
  fetchedAt?: string;
  /** The covered range has fallen behind the last complete UTC day. Can be true alongside `reason`; both are worth saying. */
  stale?: boolean;
}

/**
 * One job's rolled-up CPU/RAM utilisation and credit spend over the cache's
 * current window, for the current project only -- see `UsageResponse`'s own
 * doc comment for why every other project's rows never reach this client at
 * all, even though fetching them was unavoidable server-side.
 *
 * `runs` is the sample size: how many individual job runs contributed
 * usable (both CPU and RAM profiled) data. Any suggestion built from this
 * must say `runs` and the window out loud, and say nothing at all when
 * `runs` is too small to mean anything -- that judgement belongs to the
 * detector that reads this, not to this client.
 */
export interface UsageJobSummary {
  jobName: string;
  resourceClass: string;
  executor: string;
  operatingSystem: string;
  runs: number;
  avgMedianCpuPct: number;
  avgMaxCpuPct: number;
  maxMaxCpuPct: number;
  avgMedianRamPct: number;
  avgMaxRamPct: number;
  maxMaxRamPct: number;
  computeCredits: number;
  totalCredits: number;
}

/**
 * The JSON shape returned by `GET /api/usage` (issue #307).
 *
 * `available: false` means this host could never answer at all -- no token,
 * or no organization slug it could resolve, both checked once at startup
 * (see `internal/host`'s `usageUnavailableReason`) -- and is otherwise
 * always `true`; `status`/`jobs` report the cache's honest (possibly empty,
 * possibly stale, possibly failed) state instead of pretending unavailable
 * covers those too.
 *
 * `jobs` is always scoped server-side to the project this host is currently
 * running against (`CIRCLE_PROJECT_ID`) -- producing it required an
 * org-wide export (there is no project filter on the Usage API, confirmed
 * live), but this response never forwards another project's rows to the
 * browser. Absent (not just empty) whenever this host could not determine
 * which project to scope to, which is different from "no usage data for
 * this project" and must be worded differently.
 */
export interface UsageResponse {
  available: boolean;
  reason?: string;
  status?: UsageStatus;
  jobs?: UsageJobSummary[];
}

/**
 * Fetches the current project's slice of the host's background-warmed Usage
 * Export summary. This never itself triggers a fetch of org-wide data -- the
 * cache warms in the background from the moment this host starts (issue
 * #307's own design brief: "do it in the background... keep things
 * cached") -- it only ever reads whatever that cache currently holds.
 *
 * `refresh` (the same manual "check now" affordance issue #285 established
 * for every other cache) triggers a warm cycle before this request answers,
 * the same non-blocking way `searchOrbs`'s own `refresh` does: a usage
 * export is an async job that can take a while for a large organization
 * over a wide window, so this still answers immediately with whatever is
 * cached, not with the new cycle's eventual result.
 *
 * `windowDays`, when given, changes the cache's configured retention/fetch
 * window (one of 7, 14, or 30 -- an invalid value is rejected with a 400).
 * The browser is where this setting is persisted (`localStorage`, the same
 * convention `themeStore.ts` uses) -- pass the stored value on every call
 * rather than assuming the host remembers it across restarts.
 */
export function getUsage(opts?: {
  refresh?: boolean;
  windowDays?: number;
}): Promise<UsageResponse> {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set('window', String(opts.windowDays));
  } else if (opts?.refresh) {
    params.set('refresh', '1');
  }
  const qs = params.toString();
  return request<UsageResponse>(`/api/usage${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// AI pane (issue #92)
// ---------------------------------------------------------------------------

/**
 * Where the key a provider is using right now actually comes from -- see the
 * host's `keystore.KeySource` (issue #7). `'environment'` and `'store'` both
 * mean `configured: true`; the distinction is *why*, which is exactly what
 * `configured` alone could not say, and the reason a Remove click could
 * report success while changing nothing (a stored key that was never there
 * to begin with, because an environment variable was the real source).
 */
export type AiKeySource = 'environment' | 'store' | 'none';

/** One provider's status, as reported by `GET /api/ai/status`. Never carries a key -- see the host's own `aiProviderStatusPayload` doc comment. */
export interface AiProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  /** The model this provider will use if invoked right now. Never hardcode a model name in a component -- always read it from here. */
  model: string;
  /** See `AiKeySource`. */
  source: AiKeySource;
  /** The environment variable checked for this provider, populated whether or not it is actually set (see `keystore.KeyEnvVar`) -- not a secret, so always safe to show. */
  envVar: string;
  /**
   * True exactly when a key is genuinely stored but `source` is
   * `'environment'`: the environment variable is overriding it. This is the
   * one state where "Remove" still does something real (there is a stored
   * key to delete) but must not be presented as "the key is now gone" --
   * `envVar` will still supply one afterwards. See issue #7.
   */
  storedKeyShadowed: boolean;
}

/** Where the host persists provider keys, surfaced so the UI can always answer "where is my key, and how do I remove it". */
export interface AiKeyStorage {
  backend: 'keychain' | 'file';
  location: string;
}

/**
 * CircleCI's own hosted MCP server (issue #11) -- read-only tools (pipeline
 * status, workflow/job detail, logs, artifacts, test results) the assistant
 * may call directly, with no BYO configuration step: it authenticates with
 * the same CircleCI API token the CLI plugin injects for every other
 * CircleCI-backed feature in this app, so `available` is simply whether
 * that token exists in this process. `reason` is populated exactly when
 * `available` is `false` -- there is no "configured but currently broken"
 * state to distinguish for this server the way the docs server's grounding
 * can be (see `AiChatResponse.groundingReason`), so the pane can render
 * `reason` unconditionally whenever `available` is `false`.
 */
export interface AiCircleCIStatus {
  available: boolean;
  reason?: string;
}

/** The JSON shape returned by `GET /api/ai/status`. */
export interface AiStatusResponse {
  providers: AiProviderStatus[];
  storage: AiKeyStorage;
  circleCI: AiCircleCIStatus;
}

export function getAiStatus(): Promise<AiStatusResponse> {
  return request<AiStatusResponse>('/api/ai/status');
}

/**
 * The JSON shape returned by both `PUT` and `DELETE /api/ai/key`. Never
 * contains the key itself.
 *
 * Carries the same `source`/`envVar`/`storedKeyShadowed` triple as
 * `AiProviderStatus`, and for the same reason (issue #7): a `DELETE` used to
 * hardcode `configured: false` regardless of whether an environment variable
 * was still supplying a key, so the pane's Remove button could report
 * success while nothing about the *effective* key had changed. Reading these
 * back from the response lets the caller update its state honestly without
 * a second round trip to `GET /api/ai/status`.
 */
export interface AiKeyResponse {
  provider: string;
  configured: boolean;
  storage: AiKeyStorage;
  source: AiKeySource;
  envVar: string;
  storedKeyShadowed: boolean;
}

/** Stores `key` for `provider` via the host (which persists it in the OS keychain or a 0600 file -- see `AiKeyStorage`). The key is sent once, over this one request, and never appears in the response. */
export function putAiKey(
  provider: string,
  key: string,
): Promise<AiKeyResponse> {
  return request<AiKeyResponse>('/api/ai/key', {
    method: 'PUT',
    body: JSON.stringify({ provider, key }),
  });
}

/** Removes the stored key for `provider`. */
export function deleteAiKey(provider: string): Promise<AiKeyResponse> {
  return request<AiKeyResponse>(
    `/api/ai/key?provider=${encodeURIComponent(provider)}`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * The JSON shape returned by `GET`, `PUT` and `DELETE /api/ai/mcp` --
 * issue #111/#103's documentation-search MCP server, bring-your-own-URL the
 * same way a provider key is BYO (see `AiKeyStorage`). `url` is not a secret
 * (it's the address of a server, not a credential), which is why it is safe to
 * echo back.
 *
 * No token, and no `hasToken` either. Authenticating is OAuth-only since issue
 * #70, and whether that succeeded is `AiMcpOAuthStatus`'s question -- a second
 * answer here could only agree with it or contradict it.
 */
export interface AiMcpStatus {
  configured: boolean;
  url?: string;
}

/** Reads this app's one optional documentation-search MCP server configuration. */
export function getAiMcpStatus(): Promise<AiMcpStatus> {
  return request<AiMcpStatus>('/api/ai/mcp');
}

/**
 * Stores `url` as this app's documentation-search MCP server. Authenticating to
 * it is a separate, interactive step (`startAiMcpOAuth`); there is no token to
 * pass here -- see the host's `aiMCPPutRequest` doc comment for why that field
 * went away.
 */
export function putAiMcp(url: string): Promise<AiMcpStatus> {
  return request<AiMcpStatus>('/api/ai/mcp', {
    method: 'PUT',
    body: JSON.stringify({ url }),
  });
}

/** Removes the stored documentation-search MCP server configuration entirely. */
export function deleteAiMcp(): Promise<AiMcpStatus> {
  return request<AiMcpStatus>('/api/ai/mcp', { method: 'DELETE' });
}

/**
 * Non-secret description of a stored MCP OAuth token. `hasRefreshToken` is
 * the load-bearing field: `false` means the server issued nothing renewable,
 * so this session will end and need another interactive sign-in -- and the UI
 * says so, rather than letting the user discover it as a surprise prompt
 * later (issue #103).
 */
export interface AiMcpOAuthTokenInfo {
  hasRefreshToken: boolean;
  /** RFC 3339; absent when the server stated no lifetime at all. */
  expiresAt?: string;
  lifetimeSeconds?: number;
  scope?: string;
}

/**
 * The JSON shape returned by `GET`/`DELETE /api/ai/mcp/oauth` and
 * `POST /api/ai/mcp/oauth/start` -- the interactive sign-in to a
 * docs-grounding MCP server (issue #103).
 *
 * There is deliberately no field here capable of holding a token: the host
 * performs the OAuth flow, holds the access and refresh tokens, and refreshes
 * them itself. Same rule as the provider key, applied to a credential
 * this app now mints rather than one the user pastes.
 *
 * `authorizationUrl` is the exception that proves it -- safe for page
 * JavaScript because it carries only a client id, a `state`, and a PKCE
 * *challenge*. The verifier, the one value that would let anyone else redeem
 * the resulting code, never leaves the host.
 */
export interface AiMcpOAuthStatus {
  /** In-process flow state. `idle` also covers "a credential from a previous run is already stored" -- read `authorized` for that. */
  state: 'idle' | 'pending' | 'authorized' | 'failed';
  message?: string;
  authorized: boolean;
  resource?: string;
  token?: AiMcpOAuthTokenInfo;
  authorizationUrl?: string;
}

/** Reads the current docs-grounding MCP sign-in status. */
export function getAiMcpOAuthStatus(): Promise<AiMcpOAuthStatus> {
  return request<AiMcpOAuthStatus>('/api/ai/mcp/oauth');
}

/**
 * Begins an interactive sign-in: the host discovers the server's
 * authorization server, registers itself dynamically, and returns the URL the
 * browser must visit. `url` may be omitted to sign in to whichever MCP server
 * is already configured.
 *
 * Resolves as soon as there is a URL to open -- the browser round trip
 * happens afterwards -- so callers poll `getAiMcpOAuthStatus` for the outcome
 * rather than awaiting a request held open while a human types a password.
 */
export function startAiMcpOAuth(url?: string): Promise<AiMcpOAuthStatus> {
  return request<AiMcpOAuthStatus>('/api/ai/mcp/oauth/start', {
    method: 'POST',
    body: JSON.stringify(url ? { url } : {}),
  });
}

/** Forgets the stored docs-grounding MCP sign-in (and cancels one in progress). */
export function deleteAiMcpOAuth(): Promise<AiMcpOAuthStatus> {
  return request<AiMcpOAuthStatus>('/api/ai/mcp/oauth', { method: 'DELETE' });
}

export type AiMessageRole = 'user' | 'assistant';

export interface AiChatMessage {
  role: AiMessageRole;
  content: string;
}

/**
 * The repo-aware context sent alongside a chat request -- assembled
 * entirely from state the app already has loaded (see
 * `~/lib/ai/context.ts`), never by the host reading the filesystem. This is
 * what makes "never send the whole repo silently" true by construction:
 * there is no code path here that could expand into more than the one open
 * config file plus its already-parsed job/workflow names and validation
 * errors.
 */
/** One sibling file sent as read-only context alongside the open config -- issue #102. */
export interface AiChatContextFile {
  path: string;
  text: string;
}

/** One sibling file found but *not* sent (e.g. over the token budget) -- named explicitly so the model never has to guess whether it was forgotten or deliberately left out. */
export interface AiChatSkippedFile {
  path: string;
  reason: string;
}

/**
 * One config-policy violation sent as context (issue #247 item 6). `rule`
 * and `reason` are CircleCI's own words, carried verbatim -- the same pair
 * `PolicyRulesView` shows and never rewords. `blocking` mirrors which list the
 * engine put it in, exactly as `Diagnostic.policyRule` does.
 *
 * Rule text is org configuration -- it may name internal services, teams or
 * standards -- so sending it to a user-supplied AI provider is a new
 * outbound flow of org data, disclosed in this editor's own docs page
 * exactly as posting the config for evaluation already is.
 */
export interface AiChatPolicyViolation {
  rule: string;
  reason: string;
  blocking: boolean;
}

export interface AiChatContext {
  configPath: string;
  configText: string;
  jobNames: string[];
  workflowNames: string[];
  validationErrors: string[];
  /** Read-only content of other files in the same directory (issue #102), bounded by a token budget -- see `~/lib/ai/context.ts`. */
  otherFiles: AiChatContextFile[];
  /** Files found in the directory but left out of `otherFiles`, with why. */
  skippedFiles: AiChatSkippedFile[];
  /** The config-policy engine's current, non-stale failing rules -- see `AiChatPolicyViolation`. Empty when none are known, exactly like `validationErrors`. */
  policyViolations: AiChatPolicyViolation[];
}

/**
 * One citation in an `AiChatResponse` (issue #156).
 *
 * `title` is the *real* page or section title where the host could resolve one
 * from the vendored docs AsciiDoc, and absent otherwise -- deliberately not
 * filled in with the URL, so the frontend can tell "this page is called X" from
 * "nobody knows what this page is called" and label the row accordingly (see
 * `~/lib/ai/sources`). Nothing about it involves fetching the URL; see
 * `internal/guides/citations.go` for why not.
 */
export interface AiChatSource {
  url: string;
  title?: string;
}

/**
 * The JSON shape returned by `POST /api/ai/chat`. Same `available`
 * convention as `ValidateResponse`: `available: false` means the request
 * could not be attempted at all (no key configured for the requested
 * provider) -- never render that as the assistant having nothing to say.
 * A provider-side auth or transport failure instead surfaces as a
 * non-2xx response (`ApiError`), exactly like `postValidate`.
 */
export interface AiChatResponse {
  available: boolean;
  reason?: string;
  content?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Links the provider's MCP tool calls turned up (issue #103's "citations
   * in replies"), independent of whatever the model's own reply text says.
   * Always absent when no docs MCP server is configured, or when one is
   * configured but the model didn't call it for this particular reply.
   *
   * Normalized by the host before it gets here (issue #156): image assets
   * remapped to the page that shows them, other assets dropped, duplicates
   * collapsed, and a `title` attached where the vendored docs snapshot could
   * resolve one offline.
   */
  sources?: AiChatSource[];
  /**
   * Whether a docs-grounding MCP server was actually attached to this
   * request. Issue #103 requires the assistant to *say* when it is answering
   * without docs backing; a badge rendered from this flag is strictly more
   * reliable than asking the model to remember to mention it -- it cannot be
   * forgotten mid-reply and cannot be hallucinated.
   */
  grounded?: boolean;
  /**
   * Set only in the case worth being loud about: a docs server *is*
   * configured but could not be used for this reply (the sign-in expired,
   * was revoked, or the server stopped recognising this app's registration).
   * The dangerous state is a user believing grounding is on while answers
   * have quietly gone back to being recalled from training data.
   */
  groundingReason?: string;
  /**
   * Whether this reply had issue #11's CircleCI MCP tools available --
   * independent of `grounded`, which is about the unrelated docs server.
   * `false` means no CircleCI API token was available in this environment;
   * `circleCIReason` names that. See `AiCircleCIStatus` for why, unlike
   * `groundingReason`, this reason is not reserved for a rarer "configured
   * but broken" case.
   */
  circleCIAvailable?: boolean;
  circleCIReason?: string;
}

/** Sends `messages` (plus `context`) to `provider` via the host's proxy. The host holds the provider key; this call never sends or receives one. */
export function postAiChat(
  provider: string,
  messages: AiChatMessage[],
  context: AiChatContext,
): Promise<AiChatResponse> {
  return request<AiChatResponse>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ provider, messages, context }),
  });
}

/**
 * The JSON shape returned by `GET /api/docker-tags` (issue #77). Same
 * `available` convention as `OrbSearchResponse`, but for a different
 * reason: `available: false` here never means "no token" (Docker Hub's tag
 * API needs none) -- it means the host couldn't reach Docker Hub *and* has
 * never successfully cached this image's tags before, i.e. genuinely
 * offline on the very first request. Callers must fall back to
 * `~/lib/schema/images.ts`'s vendored variant list at that point, not
 * retry in a loop.
 */
export interface DockerTagsResponse {
  available: boolean;
  reason?: string;
  /** Ranked, newest-first version tags (see `internal/dockerhub.RankVersionTags`); present iff `available`. What the picker *recommends*. */
  tags?: string[];
  /**
   * Every version-shaped tag on the page the host fetched (see
   * `internal/dockerhub.VersionTags`) -- a superset of `tags`, newest-first, and
   * what the picker's type-to-filter searches (issue #213).
   *
   * May be absent for an entry the host cached before this field existed, in
   * which case callers fall back to `tags` -- see `imageTags.ts`.
   */
  allTags?: string[];
  /**
   * True iff `tags`/`allTags` are known to be shorter than Docker Hub
   * actually has for this image, because the host's fetch was cut short
   * (rate limiting, most likely -- see `internal/dockerhub.Page`'s doc
   * comment) rather than genuinely running out of pages. Never true merely
   * because the host's own pagination bound was reached with more tags left
   * on Docker Hub -- that is a deliberate limit, not a degradation, and
   * `tags.length`/`allTags.length` already say honestly how many were
   * offered without a caveat for it. Absent (falsy) on an entry cached
   * before this field existed, which reads the same as "not known to be
   * truncated" -- the correct degrade, not a lie.
   */
  truncated?: boolean;
  /** Explains `truncated`, e.g. naming the HTTP status Docker Hub returned partway through. Present iff `truncated`. */
  truncatedReason?: string;
  /** ISO 8601; when this data was actually fetched from Docker Hub -- may be well in the past for a cache hit. */
  fetchedAt?: string;
  /** True iff this response required a live Docker Hub round trip just now, false for a cache hit. */
  live?: boolean;
}

/**
 * Fetches recent version tags for the `cimg/<name>` convenience image
 * `name` (e.g. `"node"`, not `"cimg/node"`) via the Go host, which in turn
 * talks to Docker Hub -- never called directly from the browser (CORS, and
 * see `internal/dockerhub`'s package doc comment for the fuller
 * rationale). Requires no CircleCI token and no `available` gating on one;
 * it can still report `available: false` for network reasons -- see
 * `DockerTagsResponse`.
 *
 * `refresh` (issue #285) bypasses the host's 12h cache for this one image
 * (`dockerhub.Cache.Refresh`), for the picker's own manual "check now"
 * affordance. Unlike orbs/guides this is a single small request, so the
 * refreshed result is what this call itself returns -- there is nothing
 * further to poll for.
 */
export function getDockerTags(
  name: string,
  refresh = false,
): Promise<DockerTagsResponse> {
  const params = new URLSearchParams({ image: name });
  if (refresh) params.set('refresh', '1');
  return request<DockerTagsResponse>(`/api/docker-tags?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Read-only project authoring metadata (issue #105)
// ---------------------------------------------------------------------------

/**
 * The subset of a CircleCI project record worth knowing while authoring a
 * config.
 *
 * `slug`, `organizationSlug` and `vcsProvider` are CircleCI's own values, in
 * CircleCI's own canonical spelling (`gh/example-org/flaky-todo-list`, not
 * `github/...`). Once this record exists it -- not `Meta.projectSlug`, which is
 * assembled from injected environment variables -- is what the project is
 * called. See issue #182.
 */
export interface ProjectSummary {
  name: string;
  slug: string;
  organizationName: string;
  organizationSlug: string;
  vcsProvider: string;
  defaultBranch: string;
  /**
   * This project's *overview* page in the CircleCI web UI, built host-side
   * from `slug` above (issue #214 moved it there from the pipelines page: the
   * overview is a hub you can navigate onward from).
   *
   * Present for a standalone (GitLab / GitHub App) project too, as of issue
   * #20: its canonical slug is `circleci/<org-id>/<project-id>`, and that
   * route's shape was verified live against a real one -- the opaque IDs
   * simply occupy the segments a name would. Absent is now the rarer case: a
   * slug this host still could not turn into a URL. Render the identity as
   * plain text then, and do **not** fall back to `Meta.projectWebUrl` -- that
   * URL is derived from an assumed VCS type and would point at a page shaped
   * for a different kind of project.
   */
  webUrl?: string;

  /**
   * This project's *settings* page in the CircleCI web UI (issue #248) --
   * the other half of the link pair the owner asked for: "links to the
   * projects and maybe links to the settings, so people can easily click
   * them and go to the UI to edit things." Built host-side the same way as
   * `webUrl`, from the same slug, one path segment different -- see
   * `Environment.ProjectSettingsWebURLForSlug`.
   *
   * Same emptiness contract as `webUrl`: absent means no page this host has
   * verified how to address, render plain text. Unlike `webUrl`, this one was
   * **not** extended to standalone projects by issue #20 -- that route's shape
   * was never itself checked against a live one, only the overview and
   * organization-pipelines routes were.
   */
  settingsUrl?: string;

  /**
   * This project's *organization* overview in the CircleCI web UI (issue
   * #20's second item), built host-side from `organizationSlug` above. Same
   * emptiness contract as `webUrl`: absent means this host still cannot
   * address the organization's page, render its name as plain text.
   *
   * Supersedes `Meta.orgWebUrl` once this record exists, on the same terms
   * `webUrl` supersedes `Meta.projectWebUrl`.
   */
  organizationWebUrl?: string;
}

/** The project settings that change how a config behaves. */
export interface ProjectSettingsSummary {
  /** Whether setup workflows / dynamic config are enabled -- a `setup: true` config is only meaningful when this is on. */
  dynamicConfig: boolean;
  /** Whether the project accepts an out-of-band config, which the editor's own one-shot run relies on. */
  unversionedConfig: boolean;
  oss: boolean;
  buildForkPrs: boolean;
  passSecretsToForkPrs: boolean;
}

/** One context available to the project's organization. Variables are fetched separately, on demand. */
export interface ContextSummary {
  id: string;
  name: string;
  /**
   * Deep link to this context's own settings page in the CircleCI web UI --
   * where a restriction is actually changed, which this editor deliberately
   * cannot do (issue #251).
   *
   * Absent when the host could not build one (no organization slug resolved).
   * Render the context's name as plain text then, never a dead link.
   */
  webUrl?: string;
}

/** One project-level environment variable. Name-only, deliberately: see `getProjectContext`. */
export interface ProjectVariableSummary {
  name: string;
}

/**
 * Which part of the aggregate `/api/project-context` request failed. Keyed
 * off rather than matched on prose, because two features depend on knowing
 * *specifically* which part: the top bar (issue #149) may only say "couldn't
 * reach CircleCI" when the `project` lookup failed, and the inspector's
 * context field (issue #152) may only call a typed name unrecognised when the
 * context list is known to be complete.
 */
export type ProjectContextWarningKind =
  | 'project'
  | 'settings'
  | 'organization'
  | 'contexts'
  | 'projectVariables'
  | 'contextVariables'
  | 'restrictions'
  /**
   * `.circleci/info.yml` exists and the host could not use it (issue #198).
   * Its own kind because it is not an upstream failure at all: nothing was
   * asked of CircleCI, the *local* file that decides what to ask is broken, and
   * the fix is in the repository rather than in a token or a network.
   */
  | 'projectBinding';

/**
 * One partial failure: which part failed, the host's diagnosis, and what the
 * user consequently cannot see.
 *
 * Structured rather than a sentence (which is what issue #105 shipped) for the
 * reason issue #150 gives: the owner saw "could not load project details, this
 * API request did not succeed" *alongside* a complete list of contexts, and had
 * no way to judge whether the warning mattered. `consequences` is the field
 * that answers that, and `kind` is what lets a degraded-but-working section
 * render differently from a broken one.
 *
 * `detail` may name an HTTP status code and the project slug that was tried.
 * It never carries an upstream response *body* -- see the host's
 * `describeUpstreamError`.
 */
export interface ProjectContextWarning {
  kind: ProjectContextWarningKind;
  /** One short sentence naming what could not be loaded. */
  headline: string;
  /** The diagnosis: the classified reason, with a status code where there is one. */
  detail?: string;
  /** What is missing from the editor as a result, in plain terms. */
  consequences?: string[];
  /**
   * What to do about it, when there is anything to suggest (issue #198).
   * Distinct from `consequences` on purpose: one says what you are missing, the
   * other how to stop missing it, and #150's report was of a message that
   * answered neither.
   *
   * Populated with the CircleCI CLI's own wording where the remedy is a CLI
   * command, so that a user who searches for the sentence finds the CLI's
   * documentation rather than this app's.
   */
  suggestions?: string[];
  /**
   * Other repository names visible to this token, in the same organization
   * and on the same VCS as the slug that just 404'd (issue #20). Populated
   * only for `kind === 'project'` on a 404.
   *
   * The host deliberately does not decide *which* of these, if any, is a near
   * miss of the slug that failed -- that reasoning already exists, in
   * `nearestUnique` (`~/lib/validation/editDistance`), which `suggestions.ts`
   * uses for exactly this "within a typo's distance of exactly one candidate"
   * judgment about a misspelled config key. See `projectNearMiss`, which
   * applies it here.
   *
   * Never wider than "other projects this token can see in this
   * organization", so a candidate here is, by construction, one the user can
   * see. Absent either because there is no such project, or because the
   * lookup itself failed -- both must render as "no suggestion", never as "we
   * checked, and there is definitely no near miss".
   */
  candidates?: string[];
}

/**
 * The JSON shape returned by `GET /api/project-context`. Same `available`
 * convention as `OrbSearchResponse`: `available: false` (with a `reason`)
 * means the host cannot answer at all -- no `CIRCLE_TOKEN`, or a config that
 * is not part of a CircleCI project -- and must never be rendered as "this
 * project has no contexts".
 *
 * `warnings` is separate, and means something different: the request
 * succeeded and some of it is here, but a part failed. Listing an
 * organization's contexts needs permission that listing a project's own
 * variables does not, so an ordinary token can legitimately get some
 * sections and be refused others.
 */
export interface ProjectContextResponse {
  available: boolean;
  reason?: string;
  projectSlug?: string;
  project?: ProjectSummary;
  settings?: ProjectSettingsSummary;
  contexts: ContextSummary[];
  projectVariables: ProjectVariableSummary[];
  warnings?: ProjectContextWarning[];
}

/**
 * One variable held by a context: its name, and CircleCI's own
 * four-character preview of the value.
 *
 * `truncatedValue` is **not a value** and no UI may present it as one. Full
 * context values are not retrievable through any CircleCI API, by design;
 * this preview is the entire extent of what the platform discloses. It is
 * useful for telling `AWS_ROLE` from `AWS_ROLE_ARN` and for confirming a
 * context is populated rather than empty. Empty means the API returned no
 * preview, which must render as "no preview" rather than as an empty secret.
 */
export interface ContextVariableSummary {
  name: string;
  truncatedValue: string;
}

/** Whether this project may actually use a given context. `unknown` is a real answer, not a placeholder -- group restrictions are not evaluable from the host. */
export type ContextUsability =
  | 'unrestricted'
  | 'allowed'
  | 'other-projects-only'
  | 'unknown';

/**
 * What kind of thing limits a context (issue #251).
 *
 * All three named kinds were observed on the live v2 API. `other` is the host's
 * normalisation of a `restriction_type` it has never seen -- carried, with its
 * raw spelling, rather than dropped: `expression` was itself exactly this case
 * until someone looked.
 */
export type ContextRestrictionKind =
  | 'project'
  | 'group'
  | 'expression'
  | 'other';

/**
 * One restriction on a context: what limits it and, where CircleCI named it,
 * which one.
 *
 * ## There is deliberately no ID here
 *
 * The host strips every project and group UUID at its own boundary. Issue #251's
 * rule is that a restriction which cannot be resolved to a name must say *what
 * it is* rather than show an opaque ID, and the surest way to hold a UI to that
 * is to give it no ID to show. A UUID is not sensitive; it is simply not an
 * answer to "restricted how?", and rendering one looks like an answer.
 *
 * An expression is the exception, and proves the rule: `expression` carries
 * CircleCI's own rule text verbatim, because that *is* the human-readable
 * account of the restriction.
 */
export interface ContextRestrictionDetail {
  kind: ContextRestrictionKind;
  /**
   * CircleCI's own name for the restricted project or group. Absent when the
   * API returned none -- which happens for real, including for project
   * restrictions -- and which must render as "a project this editor cannot
   * name", never as no restriction.
   */
  name?: string;
  /** The rule, for `kind: 'expression'`: e.g. `not (pipeline.config_source starts-with "api")`. */
  expression?: string;
  /** True only for the project restriction that names *this* project. A positive assertion, never a guess. */
  thisProject?: boolean;
  /** CircleCI's own `restriction_type` when `kind` is `'other'`, so a UI can name it. */
  rawType?: string;
}

/** The JSON shape returned by `GET /api/project-context/variables`. */
export interface ContextVariablesResponse {
  available: boolean;
  reason?: string;
  contextId?: string;
  variables: ContextVariableSummary[];
  usability?: ContextUsability;
  /** A short description of the restrictions behind `usability`, e.g. "restricted to 1 group and 1 expression". */
  restrictionSummary?: string;
  /**
   * The detail behind `usability` (issue #251).
   *
   * **An empty array and an absent key mean opposite things.** `[]` is "the
   * restrictions call succeeded and this context has none" -- the one statement
   * that may be rendered as unrestricted. Absent (or `null`) is "the call
   * failed", and arrives with a `restrictions` warning. Conflating them is the
   * failure that costs a red pipeline, so treat the key's presence as the
   * signal and never default it to `[]`.
   */
  restrictions?: ContextRestrictionDetail[] | null;
  /**
   * Whether the host had a project ID to compare against the project
   * restrictions at all.
   *
   * `usability: 'unknown'` has three causes and they must not read identically:
   * a restriction this editor cannot evaluate, a restrictions call that failed,
   * and -- this flag being false -- restrictions it could have evaluated against
   * a project it could not identify. Only the last is about our own footing, and
   * it is the only one the user can do something about.
   */
  projectIdentified?: boolean;
  warnings?: ProjectContextWarning[];
}

/**
 * Fetches the read-only project metadata behind issue #105: which contexts
 * the organization has, what this project's environment variables are
 * called, and the handful of project settings that change how a config
 * behaves.
 *
 * Strictly read-only -- there is deliberately no write counterpart.
 * Environment variable *values* are never returned, for
 * either project variables or contexts: see `ContextVariableSummary`.
 *
 * `refresh` bypasses the host's short cache, for the palette's manual
 * refresh -- this data is edited in the CircleCI web UI, so a user who has
 * just added a context should not have to wait out a TTL.
 */
export function getProjectContext(
  refresh = false,
): Promise<ProjectContextResponse> {
  return request<ProjectContextResponse>(
    `/api/project-context${refresh ? '?refresh=1' : ''}`,
  );
}

/**
 * Fetches one context's variable names and truncated previews, plus whether
 * this project may use it.
 *
 * Split from `getProjectContext` on the same master/detail reasoning as the
 * orb browser: fetching every context's variables up front would be
 * one request per context for data nobody asked to see, and it means secret
 * metadata is only ever fetched for a context the user explicitly opened.
 */
export function getContextVariables(
  contextId: string,
): Promise<ContextVariablesResponse> {
  return request<ContextVariablesResponse>(
    `/api/project-context/variables?contextId=${encodeURIComponent(contextId)}`,
  );
}
