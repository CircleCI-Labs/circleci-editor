/**
 * Turns a config-policy decision into the same `Diagnostic` list the YAML
 * pane, the DAG pane and the editor's line marks already know how to render
 * (issue #215, on top of #163's machinery).
 *
 * ## What a policy violation gives us, and what it doesn't
 *
 * A violation is `{rule, reason}` and nothing else. `rule` is a Rego rule
 * name; `reason` is prose a policy *author* wrote, in whatever words they
 * chose. There is no line, no path, no structured target -- CircleCI's
 * decision endpoint has no field for one, verified against the live API
 * (see internal/circleci/policy_test.go's captured responses).
 *
 * That makes locating a violation a fundamentally weaker problem than
 * locating a compile error, and #163's rule applies unchanged: **a location
 * is shown only when it is provable, otherwise the UI says the location is
 * unknown.** A reason mentioning "test" must not light up the job called
 * `test` on the strength of an English word appearing in a sentence.
 *
 * So a target is extracted only when all of these hold:
 *
 *  1. The reason contains a candidate token -- either quoted (`'x'`, `"x"`,
 *     `` `x` ``) or identifier-shaped (containing `/`, `@`, `:`, `_`, `-` or
 *     `.`, which ordinary prose words do not). A bare lower-case English
 *     word is never a candidate, however exactly it matches.
 *  2. That token is *exactly* one of the names the open document itself
 *     declares -- a job key, an executor key, or an orb reference. The
 *     candidate set is closed and comes from the document, never from a
 *     guess, exactly as `suggestions.ts` requires of a fix.
 *  3. Precisely one distinct entity matches across the whole reason.
 *     Ambiguity is declined rather than resolved arbitrarily.
 *
 * Everything else keeps `location: undefined` and `target: undefined`, which
 * the strip renders as "location unknown" and which puts no highlight on any
 * DAG node. For a security control that is the only acceptable default: a
 * violation pointed at the wrong line is worse than one pointed nowhere.
 *
 * ## Reuse, not a parallel universe
 *
 * The emitted targets are the *existing* `DiagnosticTarget` kinds, so
 * `locateTarget` resolves them and `matchesNode` highlights them with no
 * policy-specific code in either: a job maps to the `schemaPath`
 * `{path: ['jobs'], key: name}` (which locates the job's own key line *and*
 * marks its DAG node), and an orb maps to the `orb` kind (which locates the
 * `orbs:` entry and marks nodes invoking it).
 */
import { isMap, isScalar, type Document } from 'yaml';

import { getNode } from '~/lib/yaml/documentUtils';
import {
  hasRules,
  policyViolations,
  type PolicyDecision,
  type PolicyViolation,
} from '~/state/policyStore';

import type { Diagnostic, DiagnosticTarget } from './diagnostics';
import { locateTarget } from './locate';

/**
 * What `buildPolicyDiagnostics` needs. A narrow structural type rather than
 * the stores themselves, for the same reason `DiagnosticsSource` is one: it
 * keeps this pure and callable from a `useMemo` in any pane.
 */
export interface PolicyDiagnosticsSource {
  decision: PolicyDecision | null;
  doc: Document | null;
  text: string;
  /**
   * Whether the decision still describes `text` (see
   * `isPolicyDecisionStale`). A stale decision yields no diagnostics at
   * all: its violations were about text that has since changed, so neither
   * their lines nor the nodes they name can be trusted. The strip says the
   * verdict is stale instead -- which is information, where a violation
   * pinned to a line that has moved is not.
   */
  stale: boolean;
}

/** The characters that make a token a reference rather than an English word. */
const IDENTIFIER_SHAPED = /[/@:_.-]/;

/** `'x'`, `"x"` and `` `x` `` -- an author quoting a name they mean literally. */
const QUOTED_RE = /'([^']+)'|"([^"]+)"|`([^`]+)`/g;

/** Trailing/leading punctuation a token picks up from a sentence. */
const TRIM_PUNCTUATION = /^[([{'"`]+|[)\]}'"`.,;:!?]+$/g;

/**
 * One entity the open document declares, and the target that points at it.
 * Assembled once per build, from the document only.
 */
interface Candidate {
  /** The exact text that must appear in a reason for this to match. */
  name: string;
  /** A stable identity, so two candidates for the same entity don't read as ambiguity. */
  key: string;
  target: DiagnosticTarget;
}

/** Every map key at `path`, or `[]` when there is no map there. */
function mapKeys(doc: Document, path: string[]): string[] {
  const node = getNode(doc, path);
  if (!isMap(node)) return [];
  return node.items
    .filter((pair) => isScalar(pair.key))
    .map((pair) => String((pair.key as { value: unknown }).value));
}

/**
 * The closed candidate set: the jobs, executors and orbs this document
 * declares. Nothing else -- notably not workflow names (a policy naming one
 * has no single line to point at) and not Docker images (which are values
 * rather than declarations, and which `DiagnosticTarget` has no kind for; a
 * violation about an image therefore reports its location as unknown, which
 * is true).
 */
export function documentCandidates(doc: Document | null): Candidate[] {
  if (!doc) return [];
  const candidates: Candidate[] = [];

  for (const job of mapKeys(doc, ['jobs'])) {
    candidates.push({
      name: job,
      key: `job:${job}`,
      // The job's own *key* within `jobs:` -- the line a human reads as
      // "this job", rather than the first line of its body. `matchesNode`
      // treats this form as naming that job, so the DAG node lights up from
      // the same target with no policy-specific code in either module.
      target: { kind: 'schemaPath', path: ['jobs'], key: job },
    });
  }

  for (const executor of mapKeys(doc, ['executors'])) {
    candidates.push({
      name: executor,
      key: `executor:${executor}`,
      // No DAG node corresponds to an executor, so this locates a line and
      // marks nothing -- which is the truth, not a gap.
      target: { kind: 'schemaPath', path: ['executors'], key: executor },
    });
  }

  const orbs = getNode(doc, ['orbs']);
  if (isMap(orbs)) {
    for (const pair of orbs.items) {
      if (!isScalar(pair.key) || !isScalar(pair.value)) continue;
      const alias = String(pair.key.value);
      const ref = String(pair.value.value);
      const at = ref.lastIndexOf('@');
      const target: DiagnosticTarget = {
        kind: 'orb',
        ref,
        orbName: at > 0 ? ref.slice(0, at) : ref,
        version: at > 0 ? ref.slice(at + 1) : '',
      };
      // Both spellings a policy author might quote: the full reference
      // (`circleci/aws-cli@5.2.0`) and the local alias (`aws-cli`). Both
      // resolve to the same entity, hence the shared key -- quoting one and
      // mentioning the other is not ambiguity.
      candidates.push({ name: ref, key: `orb:${ref}`, target });
      if (alias !== ref) {
        candidates.push({ name: alias, key: `orb:${ref}`, target });
      }
    }
  }

  return candidates;
}

/**
 * The tokens from `reason` that are allowed to be matched against the
 * document: every quoted span, plus every bare word that is
 * identifier-shaped. Exported for its tests, which are the record of what
 * this deliberately refuses to consider.
 */
export function reasonCandidateTokens(reason: string): string[] {
  const tokens: string[] = [];

  for (const match of reason.matchAll(QUOTED_RE)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    if (quoted) tokens.push(quoted);
  }

  for (const word of reason.split(/\s+/)) {
    const trimmed = word.replace(TRIM_PUNCTUATION, '');
    if (trimmed === '') continue;
    if (!IDENTIFIER_SHAPED.test(trimmed)) continue;
    tokens.push(trimmed);
  }

  return tokens;
}

/**
 * The one entity `reason` unambiguously names, or `undefined`.
 *
 * "Unambiguously" is the whole job: two different entities named in one
 * reason means there is no single place to point at, and this returns
 * nothing rather than picking the first.
 */
export function targetForViolation(
  reason: string,
  candidates: Candidate[],
): DiagnosticTarget | undefined {
  if (candidates.length === 0) return undefined;

  const tokens = reasonCandidateTokens(reason);
  if (tokens.length === 0) return undefined;

  const hits = new Map<string, DiagnosticTarget>();
  for (const token of tokens) {
    for (const candidate of candidates) {
      if (candidate.name !== token) continue;
      hits.set(candidate.key, candidate.target);
    }
  }

  if (hits.size !== 1) return undefined;
  return [...hits.values()][0];
}

/**
 * The list every consumer renders. Blocking violations first (they are what
 * would refuse a pipeline), then non-blocking ones, in the order the engine
 * reported them.
 */
export function buildPolicyDiagnostics(
  source: PolicyDiagnosticsSource,
): Diagnostic[] {
  const { decision, doc, text, stale } = source;
  if (!decision || stale) return [];

  const candidates = documentCandidates(doc);

  return policyViolations(decision).map((violation, index) => {
    const target = targetForViolation(violation.reason, candidates);
    return {
      id: `policy-${violation.kind}-${index}`,
      source: 'policy' as const,
      // A hard failure blocks a pipeline on CircleCI; a soft one does not.
      // That is exactly the error/warning distinction this UI already has,
      // so it maps onto it rather than inventing a third severity.
      severity:
        violation.kind === 'hard' ? ('error' as const) : ('warning' as const),
      // The policy author's own words, never reworded and never truncated.
      title: violation.reason,
      detail: [],
      context: [],
      location: locateTarget(doc, text, target),
      target,
      policyRule: { name: violation.rule, blocking: violation.kind === 'hard' },
    };
  });
}

/**
 * Whether a decision is worth telling the user about beyond its headline
 * verdict: a decision with no enabled rules had nothing to check, and its
 * silence says nothing about the config.
 */
export function decisionHasSomethingToSay(
  decision: PolicyDecision | null,
): boolean {
  return hasRules(decision) || policyViolations(decision).length > 0;
}

/** Re-exported so consumers of this module don't need the store's shape too. */
export type { PolicyViolation };
