/**
 * Assembles the single `Diagnostic` list every pane renders, from whichever
 * validation actually ran.
 *
 * There are two independent sources, and which one is in play is a fact
 * about the *host*, not a preference:
 *
 *  - **CircleCI's compiler**, when this host has a `CIRCLE_TOKEN` and
 *    `POST /api/validate` returned a real result. These are the only
 *    diagnostics that may be attributed to CircleCI.
 *  - **This app's own offline checks**, otherwise -- no token, a failed
 *    request, or an outright network outage. `buildWorkflowGraph` already
 *    finds unknown `requires:` targets, references to undefined jobs and
 *    dependency cycles from the source document alone, with no network at
 *    all; this module simply presents them through the same UI, labelled as
 *    local checks so nothing on screen ever claims CircleCI said something
 *    it didn't (see `describeSource`).
 *
 * The local checks are strictly weaker than the compiler's: a config they
 * are happy with may still fail to compile. `DiagnosticsResult.state`
 * carries that distinction through to the UI so "we found nothing wrong"
 * is never rendered as "this config is valid".
 *
 * One local check is an exception to that "strictly weaker" rule, and runs
 * even when the compiler *did* return a real result of `valid`: issue #5's
 * top-level near-miss check (`topLevelKeyTypos`). It has to, because the bug
 * it exists for is a config the compiler is genuinely happy with -- CircleCI
 * never checks a top-level key against anything, so `workflow:` in place of
 * `workflows:` is not a case the compiler disagrees with this app about, it
 * is a case the compiler has no opinion on at all. `state` still says
 * `valid` in that case (CircleCI's verdict is not this app's to overrule --
 * see this file's honest-degradation rule above), but `diagnostics` carries
 * the warning anyway, labelled `local` so it is never mistaken for something
 * CircleCI said.
 */
import type { Document } from 'yaml';

import { buildWorkflowGraph, listWorkflows } from '~/lib/graph/buildGraph';
import type { ValidateErrorItem } from '~/lib/rpc/client';

import {
  groupCompileErrors,
  type Diagnostic,
  type DiagnosticSource,
} from './diagnostics';
import { locateTarget } from './locate';
import { topLevelKeyTypos } from './topLevelKeys';

/**
 * The slice of `appStore` this module needs -- a narrow structural type
 * rather than `AppState` itself, same rationale as `lib/ai/context.ts`'s
 * `AiContextSource`: it keeps this pure and trivially testable with a plain
 * object, and it can't quietly widen.
 */
export interface DiagnosticsSource {
  doc: Document | null;
  text: string;
  parseError: string | null;
  validation: {
    state:
      | 'idle'
      | 'checking'
      | 'valid'
      | 'invalid'
      | 'unavailable'
      | 'unauthorized'
      | 'error'
      | 'not-a-config';
    errors: ValidateErrorItem[];
    reason?: string;
  };
}

/**
 * What the UI needs to describe the config's current standing honestly.
 *
 * `state` deliberately distinguishes five outcomes that a naive
 * "diagnostics.length > 0" would collapse into two:
 *
 *  - `valid`     -- CircleCI compiled it. The strongest statement available.
 *    Not a promise that `diagnostics` is empty, though: issue #5's top-level
 *    near-miss check runs even here, because it exists for exactly a config
 *    CircleCI is genuinely happy with (see `localDiagnostics`). A `valid`
 *    config with a `local`-sourced warning is not a contradiction --
 *    CircleCI never checked the thing the warning is about.
 *  - `invalid`   -- CircleCI refused it. `diagnostics` are its own words.
 *  - `checking`  -- a request is in flight; the previous verdict still stands.
 *  - `localOnly` -- nothing was compiled (no token / request failed), so
 *    `diagnostics` are local findings and silence means "nothing *we* can
 *    check is wrong", never "valid".
 *  - `unknown`   -- nothing has run yet, or the YAML doesn't parse (which has
 *    its own dedicated surfacing and must not be duplicated here).
 */
export type DiagnosticsState =
  | 'valid'
  | 'invalid'
  | 'checking'
  | 'localOnly'
  | 'unknown';

export interface DiagnosticsResult {
  state: DiagnosticsState;
  /** The source everything in `diagnostics` came from. `null` when there are none. */
  source: DiagnosticSource | null;
  diagnostics: Diagnostic[];
  /** Why nothing could be compiled, when `state` is `localOnly` -- verbatim from the host or the failed request. */
  degradedReason?: string;
}

const EMPTY: DiagnosticsResult = {
  state: 'unknown',
  source: null,
  diagnostics: [],
};

/** Compile errors -> diagnostics, with locations resolved only where the document really holds what the message named. */
function fromCompileErrors(
  errors: ValidateErrorItem[],
  doc: Document | null,
  text: string,
): Diagnostic[] {
  return groupCompileErrors(errors.map((error) => error.message)).map(
    (report, index) => {
      // A position CircleCI quoted itself always wins over one we resolved:
      // it is the stronger claim, and it is the only one the user can check
      // against the message text.
      const location = report.reported
        ? {
            line: report.reported.line,
            column: report.reported.column,
            basis: 'reported' as const,
          }
        : locateTarget(doc, text, report.target);
      return {
        id: `cc-${index}`,
        source: 'circleci' as const,
        severity: 'error' as const,
        title: report.title,
        detail: report.detail,
        context: report.context,
        location,
        target: report.target,
        extraneousKeys: report.extraneousKeys,
      };
    },
  );
}

/**
 * Issue #5's top-level near-miss check, turned into diagnostics. Split out
 * from `localDiagnostics` below (which it also feeds into) because it is
 * called from one place that function is not: `buildDiagnostics`'s `valid`
 * branch. Every *other* local check is about workflow structure the compiler
 * itself validates too, so a real `valid` verdict makes them structurally
 * incapable of finding anything (see that branch's own comment) -- but this
 * one exists precisely because the compiler does not check the thing it
 * looks at, so a `valid` verdict says nothing about it either way.
 */
export function topLevelKeyDiagnostics(
  doc: Document | null,
  text: string,
): Diagnostic[] {
  if (!doc) return [];
  return topLevelKeyTypos(doc).map((typo, index) => {
    // `path: []` is the document root -- `locate.ts`'s `keyNodeAt` already
    // handles that generically (an empty path resolves to `doc.contents`
    // itself), so this reuses the existing `schemaPath` machinery rather
    // than inventing a new target kind for "a key at the top level".
    const target = { kind: 'schemaPath' as const, path: [], key: typo.key };
    return {
      id: `local-toplevel-${index}`,
      source: 'local' as const,
      severity: 'warning' as const,
      // No issue number in the words a user actually reads -- that belongs
      // in this file's comments, not in something rendered on screen.
      title: `Unrecognised top-level key "${typo.key}" -- within a typo's distance of only "${typo.replacement}". CircleCI's compiler does not check top-level keys, so it will not catch this either.`,
      detail: [],
      context: [],
      location: locateTarget(doc, text, target),
      target,
    };
  });
}

/**
 * The offline half: every workflow's structural problems, as
 * `buildWorkflowGraph` already computes them, plus `topLevelKeyDiagnostics`
 * (issue #5's check, which isn't about any workflow at all -- see its own
 * doc comment for why it's folded in here too). The workflow-structural
 * messages are the graph's own, verbatim; this does not reword them, and it
 * does not invent problems the graph doesn't report.
 */
export function localDiagnostics(
  doc: Document | null,
  text: string,
): Diagnostic[] {
  if (!doc) return [];
  const diagnostics: Diagnostic[] = topLevelKeyDiagnostics(doc, text);
  for (const workflow of listWorkflows(doc)) {
    const { problems } = buildWorkflowGraph(doc, workflow);
    problems.forEach((problem, index) => {
      const target = problem.danglingRequire
        ? {
            kind: 'requires' as const,
            workflow,
            fromAlias: problem.danglingRequire.fromAlias,
            missingId: problem.danglingRequire.missingId,
          }
        : problem.undefinedJob !== undefined
          ? {
              kind: 'workflowJob' as const,
              workflow,
              jobName: problem.undefinedJob,
            }
          : undefined;
      diagnostics.push({
        id: `local-${workflow}-${index}`,
        source: 'local',
        severity: problem.severity,
        title: problem.message,
        detail: [],
        context: [{ kind: 'workflow', name: workflow }],
        location: locateTarget(doc, text, target),
        target,
      });
    });
  }
  return diagnostics;
}

/**
 * The one entry point panes use. Pure: given the same store slice it always
 * produces the same result, so it is safe to call from a `useMemo` in as
 * many components as need it.
 */
export function buildDiagnostics(source: DiagnosticsSource): DiagnosticsResult {
  const { doc, text, parseError, validation } = source;

  // A local YAML parse error already has its own dedicated, unmissable
  // surfacing in the YAML pane, and `revalidate` skips the API entirely
  // while it stands. Repeating it here would double-report the one error
  // the user can already see, and every structural check below would be
  // running against a stale document anyway.
  if (parseError) return EMPTY;

  switch (validation.state) {
    case 'valid': {
      // Issue #5: CircleCI's "valid" is not this app's cue to stop looking,
      // but only for the one check built to run alongside it.
      // `topLevelKeyDiagnostics` is deliberately narrower than the full
      // `localDiagnostics` used below for `invalid`/`localOnly`: workflow-
      // structural findings (`buildWorkflowGraph`'s dangling `requires:`,
      // undefined jobs) are exactly what CircleCI's own compiler checks too,
      // so running them against a config the compiler just approved could
      // only ever be a bug in *this app's* weaker heuristic -- never a real
      // second opinion worth surfacing, and never worth risking a false
      // "this valid config has a problem" over. The top-level check has no
      // such conflict: CircleCI does not check the thing it looks at, so its
      // silence is not a verdict this app would be contradicting.
      const diagnostics = topLevelKeyDiagnostics(doc, text);
      return {
        state: 'valid',
        source: diagnostics.length > 0 ? 'local' : null,
        diagnostics,
      };
    }

    case 'invalid': {
      const diagnostics = fromCompileErrors(validation.errors, doc, text);
      // An `invalid` verdict with no message we could group is still an
      // invalid verdict -- fall back to the local checks so the pane has
      // something true to show rather than an empty "invalid" strip.
      if (diagnostics.length === 0) {
        return {
          state: 'invalid',
          source: 'local',
          diagnostics: localDiagnostics(doc, text),
        };
      }
      return { state: 'invalid', source: 'circleci', diagnostics };
    }

    case 'checking': {
      // Keep whatever the last result said while a new request is in
      // flight: blanking the strip on every keystroke is how an error
      // becomes something the user has to chase.
      const previous = fromCompileErrors(validation.errors, doc, text);
      return {
        state: 'checking',
        source: previous.length > 0 ? 'circleci' : null,
        diagnostics: previous,
      };
    }

    // Issue #224: `unauthorized` (a rejected token) joins `unavailable`/
    // `error` here rather than getting its own branch. All three share the
    // one fact this switch cares about -- CircleCI's compiler did not
    // produce a verdict, for whatever reason -- so the same offline
    // fallback applies; *why* it didn't answer is `degradedReason`'s job,
    // not this state's.
    case 'unavailable':
    case 'unauthorized':
    case 'error': {
      const diagnostics = localDiagnostics(doc, text);
      return {
        state: 'localOnly',
        source: diagnostics.length > 0 ? 'local' : null,
        diagnostics,
        degradedReason: validation.reason,
      };
    }

    // Issue #145: a file that isn't a CircleCI config at all gets no
    // diagnostics of any kind, local or otherwise -- not `localOnly`. That
    // state's own footnote ("This config has not been compiled by
    // CircleCI... A config these checks are happy with can still fail to
    // compile") presumes a config, which is exactly what this file was
    // classified as not being. Running `localDiagnostics`' workflow checks
    // against it would also just be reasoning about a file's `workflows:`
    // that was never meant to have any -- see `revalidate`'s doc comment
    // for the same call made one layer up, about the network request this
    // mirrors.
    case 'not-a-config':
    case 'idle':
    default:
      return EMPTY;
  }
}

/** Errors first, then warnings; otherwise the order they were reported in, which for a compile report is the compiler's own order. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return 0;
  });
}
