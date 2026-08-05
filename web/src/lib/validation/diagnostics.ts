/**
 * Turns whatever validation actually produced -- CircleCI's
 * `compile-config-with-defaults` errors, or this app's own offline checks --
 * into one uniform `Diagnostic` list that the YAML pane, the DAG pane and
 * the "Fix with AI" button can all render without any of them having to
 * re-derive meaning from prose.
 *
 * ## Why the shape of the input matters
 *
 * `POST /api/validate` hands back `errors: [{message}, ...]`, and it is
 * tempting to read that as "one error per entry". It is not: CircleCI
 * returns **one entry per line of a multi-line report**. That was verified
 * against the live API (see `diagnostics.test.ts`, whose fixtures are
 * copy-pasted verbatim from real responses), and it is why the old
 * flat `<li>` per entry rendered a single misspelled key as twenty-odd
 * bullet points. Every grouping rule below exists because a real response
 * needed it:
 *
 *   - `ERROR IN CONFIG FILE:` opens a JSON-Schema report whose remaining
 *     lines are `[#/path] ...` / `N. ...` / `|   ...` continuations.
 *   - `Error calling workflow: 'x'` / `Error calling job: 'y'` are *context
 *     prefixes*: they precede the line that says what actually went wrong,
 *     and on their own they name no fault at all.
 *   - `Unable to parse YAML` opens a libyaml report -- the only place
 *     CircleCI ever quotes a line number.
 *   - Everything else is a standalone one-line report.
 *
 * ## Locations
 *
 * CircleCI compile errors are **not** reliably line-addressable, so this
 * module never guesses. A `Diagnostic` gets a location in exactly two
 * ways, and says which:
 *
 *   - `basis: 'reported'` -- CircleCI itself quoted `line N, column M`
 *     (only ever in the `Unable to parse YAML` report).
 *   - `basis: 'resolved'` -- the message named an entity (`executor named
 *     nope`, a `[#/jobs/build/docker/0]` schema path, an orb reference) and
 *     `locate.ts` found that exact name at exactly that place in the
 *     document AST.
 *
 * When neither applies the diagnostic keeps `location: undefined`, and the
 * UI is required to say the location is unknown rather than drop the error
 * or point at a line it invented.
 *
 * ## Provenance
 *
 * `source` is load-bearing, not decoration. With no `CIRCLE_TOKEN` the host
 * cannot compile anything (`internal/host/validate.go` answers
 * `available: false`), so the diagnostics on screen come from this app's own
 * offline checks instead (`build.ts`'s `localDiagnostics`). Those must never
 * be presented as something CircleCI said -- see `describeSource`.
 */
import type { PathSegment } from '~/lib/yaml/documentUtils';

/**
 * Where a diagnostic came from. Three genuinely different authorities, and
 * telling them apart is a correctness requirement rather than a nicety (see
 * `describeSource`):
 *
 *  - `circleci` -- CircleCI's config compiler said the config is invalid.
 *  - `local` -- this app's own offline checks, which are strictly weaker.
 *  - `policy` -- CircleCI's config-policy engine (issue #215). A *different
 *    axis*, not a stronger or weaker version of the first: a config that
 *    compiles can still violate a policy, and a policy violation is not a
 *    statement that the config is invalid.
 */
export type DiagnosticSource = 'circleci' | 'local' | 'policy';

export type DiagnosticSeverity = 'error' | 'warning';

/**
 * The config entity a diagnostic is about, when one can be extracted
 * mechanically from the message. Used for two things: resolving a location
 * (`locate.ts`) and deciding which DAG node to mark (`matchesNode`).
 *
 * Deliberately absent whenever extraction would mean guessing -- a target
 * this module is unsure of is worse than none, because both consumers treat
 * it as fact.
 */
export type DiagnosticTarget =
  /** An orb reference under `orbs:` that the registry could not resolve. `ref` is the full `namespace/orb@version`. */
  | { kind: 'orb'; ref: string; orbName: string; version: string }
  /** A workflow job entry naming a job with no definition. */
  | { kind: 'workflowJob'; workflow?: string; jobName: string }
  /** A `requires:` entry naming an id nothing in the workflow provides. */
  | {
      kind: 'requires';
      workflow?: string;
      /** The alias of the entry whose `requires:` is wrong. */
      fromAlias: string;
      /** The unresolvable id it names. */
      missingId: string;
    }
  /** A job's `executor:` naming an executor with no definition. */
  | { kind: 'executor'; job?: string; name: string }
  /** A step naming a command with no definition (a misspelled built-in step, or an undefined local/orb command). */
  | { kind: 'command'; job?: string; fromCommand?: string; name: string }
  /** A JSON-Schema violation at a concrete path. `key` is set for `extraneous key [k]`, where the offending map key itself is the thing to point at. */
  | { kind: 'schemaPath'; path: PathSegment[]; key?: string };

export interface DiagnosticLocation {
  /** 1-based, matching how CodeMirror and every error message in the world count lines. */
  line: number;
  /** 1-based. */
  column: number;
  /** See this module's doc comment: how we came to believe this location. Never invented. */
  basis: 'reported' | 'resolved';
}

/**
 * One thing wrong with the config, at the granularity a human would count
 * them -- not at the granularity the wire format happens to use.
 */
export interface Diagnostic {
  /** Stable within one validation result, so React keys and "which one am I looking at" survive a re-render. */
  id: string;
  source: DiagnosticSource;
  severity: DiagnosticSeverity;
  /** The one-line headline. Always CircleCI's (or a local check's) own words -- never rewritten. */
  title: string;
  /**
   * The remaining lines of the report, verbatim and in order, or `[]` for a
   * one-line report. Kept whole even when most of it is JSON-Schema `oneOf`
   * noise: dropping lines we don't understand is how a user ends up unable
   * to see what the compiler actually said.
   */
  detail: string[];
  /** `Error calling workflow: 'main'`-style prefixes that scoped this error, outermost first. */
  context: DiagnosticContext[];
  location?: DiagnosticLocation;
  target?: DiagnosticTarget;
  /**
   * The `extraneous key [k] is not permitted` findings CircleCI printed in
   * this report, each with its own `Permitted keys:` list. Carried on the
   * diagnostic (rather than re-derived) because that list is the *only*
   * justification `suggestions.ts` has for proposing a key rename -- it is
   * CircleCI's own enumeration of what belongs there, not ours.
   */
  extraneousKeys?: ExtraneousKeyFinding[];
  /**
   * The config-policy rule this violation came from, set only when `source`
   * is `policy`. Carried rather than folded into `title` because the rule
   * name and the policy's reason answer different questions -- "which
   * control fired" and "what it wants" -- and issue #215 requires both to be
   * visible. `blocking` mirrors which list the engine put it in: a blocking
   * violation is what would refuse a pipeline on CircleCI.
   */
  policyRule?: { name: string; blocking: boolean };
}

export interface DiagnosticContext {
  kind: 'workflow' | 'job' | 'command';
  name: string;
}

/** An `extraneous key [k] is not permitted` finding plus the permitted-key list CircleCI printed under it. The one schema violation with a mechanically justifiable fix -- see `suggestions.ts`. */
export interface ExtraneousKeyFinding {
  path: PathSegment[];
  key: string;
  /** Verbatim from the report's own `Permitted keys:` block. Empty when CircleCI didn't print one. */
  permitted: string[];
}

/**
 * How to describe where a diagnostic came from, in words that cannot be
 * mistaken for the other source. The distinction is a correctness
 * requirement, not a nicety: with no token nothing was compiled, and
 * labelling a local check as a compile error would have this app assert
 * something CircleCI never said.
 */
export function describeSource(source: DiagnosticSource): string {
  switch (source) {
    case 'circleci':
      return 'CircleCI compiler';
    case 'policy':
      // Named for the control, not for the verdict: "CircleCI compiler" and
      // "CircleCI config policies" have to be unmistakable at a glance,
      // because one is saying the config is broken and the other is saying
      // it is not allowed.
      return 'CircleCI config policies';
    case 'local':
      return 'Local check';
  }
}

/**
 * The one line to show for a diagnostic where there is room for one line.
 *
 * For a policy violation that is `<rule>: <reason>`, because the reason on
 * its own does not say which control fired, and the rule name on its own
 * does not say what it wants. Everything else is its own title already --
 * CircleCI's compiler messages are self-describing and must not be
 * decorated.
 */
export function diagnosticHeadline(diagnostic: Diagnostic): string {
  if (diagnostic.policyRule) {
    return `${diagnostic.policyRule.name}: ${diagnostic.title}`;
  }
  return diagnostic.title;
}

// ---------------------------------------------------------------------------
// Grouping CircleCI's line-per-entry error array back into reports
// ---------------------------------------------------------------------------

const SCHEMA_BANNER = 'ERROR IN CONFIG FILE:';
const YAML_BANNER = 'Unable to parse YAML';

/** `Error calling workflow: 'main'` -- a scope prefix, never a fault of its own. */
const CONTEXT_RE = /^Error calling (workflow|job|command): '(.*)'$/;

/** A continuation line of the JSON-Schema report: a `[#/path]` finding, a `N.` numbered branch, a `|`-indented sub-branch, or an indented permitted-key bullet. */
const SCHEMA_CONTINUATION_RE = /^(\[#\/|\d+\.\s|\||\s)/;

/** `|   |   1. [#/jobs/build/docker/0] extraneous key [imag] is not permitted` */
const EXTRANEOUS_KEY_RE =
  /\[#(\/[^\]]*)?\]\s+extraneous key \[([^\]]+)\] is not permitted/;

/** A `Permitted keys:` bullet, at whatever `|`/space indentation the report used. */
const PERMITTED_BULLET_RE = /^[|\s]*-\s+(\S+)\s*$/;

/** The only place CircleCI quotes a position: ` in 'string', line 3, column 3:` */
const REPORTED_POSITION_RE = /^\s*in 'string', line (\d+), column (\d+):/;

const ORB_RE =
  /^Cannot find (\S+) in the orb registry\. Check that the namespace, orb name and version are correct\.$/;

const NO_DEFINITION_RE =
  /^Cannot find a definition for (job|executor|command) named (.+)$/;

const REQUIRES_RE =
  /^Job '(.*)' requires '(.*)', which is the name of \d+ other jobs? in workflow '(.*)'$/;

/** One grouped report, before locations are resolved against a document. */
export interface CompileReport {
  title: string;
  detail: string[];
  context: DiagnosticContext[];
  target?: DiagnosticTarget;
  reported?: { line: number; column: number };
  /** Present only for a `ERROR IN CONFIG FILE:` report. */
  extraneousKeys?: ExtraneousKeyFinding[];
}

/** `#/jobs/build/docker/0` -> `['jobs', 'build', 'docker', 0]`. Numeric segments become numbers so `getNode` indexes sequences rather than looking up a string key. */
export function parseSchemaPointer(pointer: string): PathSegment[] {
  return pointer
    .split('/')
    .filter((segment) => segment !== '' && segment !== '#')
    .map((segment) => {
      const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
    });
}

function collectPermittedKeys(lines: string[], startIndex: number): string[] {
  const permitted: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    const match = PERMITTED_BULLET_RE.exec(line);
    if (!match?.[1]) break;
    permitted.push(match[1]);
  }
  return permitted;
}

/**
 * Reads the `[#/path] extraneous key [k] is not permitted` findings, each
 * with the `Permitted keys:` list printed beneath it, out of a schema
 * report. These are the only schema violations with a fix this app is
 * willing to suggest -- see `suggestions.ts`'s own rationale for why the
 * surrounding `0 subschemas matched` / `required key [type] not found`
 * lines are deliberately left alone.
 */
export function readExtraneousKeys(lines: string[]): ExtraneousKeyFinding[] {
  const findings: ExtraneousKeyFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = EXTRANEOUS_KEY_RE.exec(line);
    if (!match) continue;
    const [, pointer, key] = match;
    if (!key) continue;
    // The `Permitted keys:` header is on the next line when present; the
    // bullets follow it. A report without one still yields a finding (with
    // no candidates), because "this key isn't allowed here" is worth
    // showing even when we can't propose the right key.
    const headerIndex = i + 1;
    const hasHeader =
      lines[headerIndex]?.trimStart().replace(/^[|\s]*/, '') ===
      'Permitted keys:';
    findings.push({
      path: parseSchemaPointer(pointer ?? ''),
      key,
      permitted: hasHeader ? collectPermittedKeys(lines, headerIndex + 1) : [],
    });
  }
  return findings;
}

function targetForMessage(
  message: string,
  context: DiagnosticContext[],
): DiagnosticTarget | undefined {
  const orb = ORB_RE.exec(message);
  if (orb?.[1]) {
    const ref = orb[1];
    const at = ref.lastIndexOf('@');
    return {
      kind: 'orb',
      ref,
      orbName: at > 0 ? ref.slice(0, at) : ref,
      version: at > 0 ? ref.slice(at + 1) : '',
    };
  }

  const requires = REQUIRES_RE.exec(message);
  if (requires) {
    const [, fromAlias, missingId, workflow] = requires;
    if (fromAlias !== undefined && missingId !== undefined) {
      return { kind: 'requires', workflow, fromAlias, missingId };
    }
  }

  const noDefinition = NO_DEFINITION_RE.exec(message);
  if (noDefinition) {
    const [, kind, name] = noDefinition;
    if (!name) return undefined;
    const workflow = context.find((c) => c.kind === 'workflow')?.name;
    const job = context.find((c) => c.kind === 'job')?.name;
    const fromCommand = context.find((c) => c.kind === 'command')?.name;
    if (kind === 'job') return { kind: 'workflowJob', workflow, jobName: name };
    if (kind === 'executor') return { kind: 'executor', job, name };
    return { kind: 'command', job, fromCommand, name };
  }

  return undefined;
}

/**
 * Groups CircleCI's flat, one-entry-per-line `errors` array back into the
 * multi-line reports it was printed as. See this module's doc comment for
 * where each rule comes from; every one of them is pinned by a fixture
 * captured from the live API.
 */
export function groupCompileErrors(messages: string[]): CompileReport[] {
  const reports: CompileReport[] = [];
  let context: DiagnosticContext[] = [];

  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
    if (raw === undefined) continue;
    const message = raw.replace(/\s+$/, '');
    if (message.trim() === '') continue;

    if (message === SCHEMA_BANNER) {
      const detail: string[] = [];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (next === undefined) break;
        if (next === SCHEMA_BANNER || next === YAML_BANNER) break;
        if (!SCHEMA_CONTINUATION_RE.test(next)) break;
        detail.push(next);
        j++;
      }
      const extraneousKeys = readExtraneousKeys(detail);
      // Prefer the first actionable finding as the headline: `0 subschemas
      // matched instead of one` is technically the first line, and it is
      // also completely useless to a human. The full report is still kept
      // verbatim in `detail`.
      const first = extraneousKeys[0];
      const title = first
        ? `Key "${first.key}" is not allowed ${describePointer(first.path)}`
        : (detail[0] ?? SCHEMA_BANNER);
      reports.push({
        title,
        detail,
        context,
        extraneousKeys,
        target: first
          ? { kind: 'schemaPath', path: first.path, key: first.key }
          : firstSchemaPathTarget(detail),
      });
      context = [];
      i = j - 1;
      continue;
    }

    if (message === YAML_BANNER) {
      // A YAML parse failure means nothing else was checked, so the rest of
      // the array belongs to this one report. This branch is close to
      // unreachable in practice -- `appStore.revalidate` skips the API
      // entirely while the local parse is failing -- but a config that
      // `yaml` accepts and libyaml rejects would land here, and dropping it
      // would be silently losing the only error there is.
      const detail = messages
        .slice(i + 1)
        .filter((line): line is string => line !== undefined);
      const position = detail
        .map((line) => REPORTED_POSITION_RE.exec(line))
        .find((match) => match !== null);
      reports.push({
        title: message,
        detail,
        context,
        reported:
          position?.[1] && position[2]
            ? { line: Number(position[1]), column: Number(position[2]) }
            : undefined,
      });
      break;
    }

    const contextMatch = CONTEXT_RE.exec(message);
    if (contextMatch) {
      const [, kind, name] = contextMatch;
      if (kind && name !== undefined) {
        context = [
          ...context,
          { kind: kind as DiagnosticContext['kind'], name },
        ];
      }
      continue;
    }

    reports.push({
      title: message,
      detail: [],
      context,
      target: targetForMessage(message, context),
    });
    context = [];
  }

  return reports;
}

/** `['jobs','build','docker',0]` -> `in jobs.build.docker[0]`, for a headline a human can read at a glance. */
export function describePointer(path: PathSegment[]): string {
  if (path.length === 0) return 'at the top level of this config';
  const dotted = path
    .map((segment) =>
      typeof segment === 'number' ? `[${segment}]` : `.${segment}`,
    )
    .join('')
    .replace(/^\./, '');
  return `in ${dotted}`;
}

/** Falls back to the first `[#/path]` a schema report mentions, so even an unrecognised violation can point somewhere real. */
function firstSchemaPathTarget(detail: string[]): DiagnosticTarget | undefined {
  for (const line of detail) {
    const match = /\[#(\/[^\]]*)\]/.exec(line);
    if (match?.[1]) {
      return { kind: 'schemaPath', path: parseSchemaPointer(match[1]) };
    }
  }
  return undefined;
}

/**
 * Does `diagnostic` implicate the DAG node `nodeId`/`jobName` in workflow
 * `workflow`? Answered from `target` only -- never by substring-matching a
 * job name against the message text, which would light up every node whose
 * name happened to appear in unrelated prose.
 */
export function matchesNode(
  diagnostic: Diagnostic,
  workflow: string,
  node: { id: string; jobName: string; orbRef?: string },
): boolean {
  const target = diagnostic.target;
  if (!target) return false;
  switch (target.kind) {
    case 'requires':
      if (target.workflow !== undefined && target.workflow !== workflow) {
        return false;
      }
      // Both ends: the entry whose `requires:` is wrong, and the hole it
      // points at (which `buildGraph` already synthesises as a `missing`
      // node, so it is a real, selectable node on the canvas).
      return node.id === target.fromAlias || node.id === target.missingId;
    case 'workflowJob':
      if (target.workflow !== undefined && target.workflow !== workflow) {
        return false;
      }
      return node.jobName === target.jobName || node.id === target.jobName;
    case 'executor':
    case 'command':
      return target.job !== undefined && node.jobName === target.job;
    case 'orb':
      // The orb alias, not the package name, is what a node's `orbRef`
      // holds -- and the alias is a local choice, so match on the package's
      // short name too rather than assuming `orbs: { node: circleci/node }`.
      return (
        node.orbRef !== undefined &&
        (target.orbName.endsWith(`/${node.orbRef}`) ||
          target.orbName === node.orbRef)
      );
    case 'schemaPath': {
      if (target.path[0] !== 'jobs') return false;
      if (node.jobName === target.path[1]) return true;
      // `{path: ['jobs'], key: 'build'}` -- the offending map *key* is the
      // job itself. Both a `[#/jobs] extraneous key [build]` schema finding
      // and a policy violation naming a job (issue #215, which points at the
      // key's own line rather than at the first line of the body) arrive in
      // this form, and in both the thing implicated is the job `build`.
      return target.path.length === 1 && target.key === node.jobName;
    }
  }
}

/** Every workflow a diagnostic can be attributed to, for the workflow tabs' error dots. */
export function diagnosticWorkflow(diagnostic: Diagnostic): string | undefined {
  const target = diagnostic.target;
  if (target?.kind === 'requires' || target?.kind === 'workflowJob') {
    if (target.workflow) return target.workflow;
  }
  if (target?.kind === 'schemaPath' && target.path[0] === 'workflows') {
    const name = target.path[1];
    if (typeof name === 'string') return name;
  }
  return diagnostic.context.find((c) => c.kind === 'workflow')?.name;
}
