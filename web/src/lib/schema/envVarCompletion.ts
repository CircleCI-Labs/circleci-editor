/**
 * Completes `$NAME` references to this project's environment variables inside
 * a `run` step's command (issue #105).
 *
 * ## Why a completion and not a palette card
 *
 * The owner's own reasoning for leaving environment variables out of the
 * draggable palette was that there is nothing to drop them onto -- they are
 * referenced as `$NAME` inside the *text* of a shell command, which is not a
 * drop target. But the moment you actually need the name is the moment you are
 * typing that command, and that is what this provides. The palette's Project
 * section is the browsable list; this is the working affordance.
 *
 * ## Why a second, separate completion source
 *
 * `YamlPane` used to register exactly one source, and this deliberately makes
 * it two. Two reasons, both structural rather than convenient:
 *
 * 1. `circleciCompletionSource` returns `null` outright when the cursor is
 *    inside an opaque scalar (`isInsideOpaqueScalar`), and `command: |` -- a
 *    block literal -- is the *normal* way a run command is written. Folding
 *    this in would mean either narrowing that guard for everyone or special-
 *    casing before it; a separate source simply is not subject to it.
 * 2. It has nothing to do with the JSON Schema, and is available before (and
 *    regardless of whether) the schema fetch succeeds. `autocompletion`'s
 *    `override` accepts N sources and merges their results, so this composes
 *    without touching the schema source at all.
 *
 * ## Where the names come from
 *
 * `projectContextStore`, read synchronously via `getState()` rather than a
 * hook -- a CodeMirror completion source is not a React component. It never
 * triggers a fetch of its own: `YamlPane` asks the store to load once on
 * mount, and until that resolves this source proposes nothing, which is the
 * same "silently unavailable" degradation the schema source already has.
 *
 * ## Context variables (issue #23)
 *
 * This module used to offer *project* variables only: context variables are
 * fetched per context, on demand, only for a context the user has opened in
 * the palette, so completing them here would have made the list depend on
 * where someone had clicked earlier in the session -- inconsistent
 * completions are worse than absent ones. `createContextVarCompletionSource`
 * below resolves that by fetching on demand *itself*, scoped to the one job
 * whose `run` command is being typed rather than to whatever the palette
 * happens to have open, which sidesteps the inconsistency instead of
 * accepting it. See that function's own doc comment.
 */
import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { isPair, isScalar, parseDocument, visit, type Document } from 'yaml';

import { contextsForJob } from '~/lib/contexts/referencedContexts';
import { useProjectContextStore } from '~/state/projectContextStore';

/**
 * The keys whose scalar value is treated as shell text worth completing
 * `$NAME` inside: `command:` (a `run` step's long form) and `run:` (its
 * shorthand, `- run: make build`).
 */
const SHELL_TEXT_KEYS = new Set(['command', 'run']);

/** What `locateShellText` learns about a position inside a `command:`/`run:` scalar. */
interface ShellTextLocation {
  /** The document `locateShellText` already parsed, so a caller doesn't have to parse `text` a second time to walk it further (issue #23's context lookup does exactly that). */
  doc: Document;
  /**
   * The enclosing `jobs.<name>` job, or `null` for a `command:`/`run:` scalar
   * that is not written under one -- a reusable `commands:` body, most
   * often. `null` here is a real, common case, not a failure: a reusable
   * command has no job of its own to look up contexts for, only the job
   * that eventually calls it does, and by the time this scalar is being
   * typed that call site may not even exist yet.
   */
  jobName: string | null;
}

/**
 * Parses `text` once and, if `pos` falls inside the scalar value of a
 * `command:`/`run:` key, reports it -- otherwise `null`, including for a
 * document that does not parse.
 *
 * Uses `yaml`'s own parser and real node ranges rather than pattern-matching
 * the buffer. That matters specifically because of block literals: the naive
 * approach -- walk backwards for the nearest less-indented line and read its
 * key -- gets the wrong answer for any indented shell construct, since
 * `echo $FOO` nested inside an `if ... then` block finds the `if` line first,
 * not the `command: |` line. A parsed node's range has no such ambiguity.
 *
 * `jobName` is read from the same tree walk that finds the scalar, on the
 * same "ancestry, keys only" technique `findAliasSites` already uses to build
 * its own dotted path (`~/lib/yaml/documentUtils.ts`): the ordered list of
 * every enclosing `Pair`'s key. A scalar written at `jobs.<name>.steps...`
 * reads `['jobs', <name>, 'steps', ...]` there, so `keys[0] === 'jobs'` names
 * the job at `keys[1]` and anything else (a `commands:` body, an executor's
 * own field, ...) does not start with `jobs` and resolves to `null`.
 */
function locateShellText(text: string, pos: number): ShellTextLocation | null {
  let result: ShellTextLocation | null = null;

  try {
    const doc = parseDocument(text);
    visit(doc, {
      Scalar(_key, node, path) {
        if (result) return visit.BREAK;
        if (!node.range) return;
        const [start, , end] = node.range;
        if (pos < start || pos > end) return;

        const parent = path[path.length - 1];
        if (
          !isPair(parent) ||
          !isScalar(parent.key) ||
          typeof parent.key.value !== 'string' ||
          !SHELL_TEXT_KEYS.has(parent.key.value) ||
          // Only the *value* side -- the cursor sitting in the key `command`
          // itself is a key completion, which is the schema source's job.
          parent.value !== node
        ) {
          return;
        }

        const keys = path
          .filter(isPair)
          .map((pair) => (isScalar(pair.key) ? pair.key.value : undefined));
        result = {
          doc,
          jobName:
            keys[0] === 'jobs' && typeof keys[1] === 'string' ? keys[1] : null,
        };
        return visit.BREAK;
      },
    });
  } catch {
    return null;
  }

  return result;
}

/** Reports whether `pos` falls inside the scalar value of a `command:`/`run:` key. See `locateShellText`. */
function isInsideShellText(text: string, pos: number): boolean {
  return locateShellText(text, pos) !== null;
}

/**
 * Locates the `$`-prefixed reference the cursor is currently inside, or
 * `null` when there isn't one.
 *
 * Requiring an explicit `$` is what keeps this from popping a completion list
 * on every character of a shell script -- the sigil is the user's own signal
 * that they are about to name a variable. `${NAME}` is supported alongside
 * `$NAME` because both are ordinary shell.
 *
 * `from` is the offset of the `$` itself, deliberately *not* the `from` a
 * `CursorContext` would give (the start of the whole scalar value): replacing
 * a scalar's entire text with a variable name would delete the command.
 */
function findDollarReference(
  text: string,
  pos: number,
): { from: number; prefix: string; braced: boolean } | null {
  let cursor = pos;
  while (cursor > 0 && /[A-Za-z0-9_]/.test(text[cursor - 1] ?? '')) {
    cursor--;
  }

  const braced = text[cursor - 1] === '{' && text[cursor - 2] === '$';
  const plain = text[cursor - 1] === '$';
  if (!braced && !plain) return null;

  const from = braced ? cursor - 2 : cursor - 1;
  // `$$` is not a variable reference (it's the shell's own PID), and a `$`
  // escaped as `\$` is deliberately literal.
  if (text[from - 1] === '$' || text[from - 1] === '\\') return null;

  return { from, prefix: text.slice(cursor, pos), braced };
}

/**
 * A CodeMirror completion source offering this project's environment variable
 * names wherever a `$` reference is being typed inside a run command.
 *
 * Returns `null` -- not an empty result -- whenever it has nothing to say, so
 * it never suppresses another source's proposals at the same position.
 */
export function createEnvVarCompletionSource() {
  return function envVarCompletionSource(
    context: CompletionContext,
  ): CompletionResult | null {
    const names = useProjectContextStore
      .getState()
      .projectVariables.map((variable) => variable.name);
    if (names.length === 0) return null;

    const text = context.state.doc.toString();
    const reference = findDollarReference(text, context.pos);
    if (!reference) return null;
    if (!isInsideShellText(text, context.pos)) return null;

    return {
      from: reference.from,
      to: context.pos,
      options: names.map((name) => ({
        label: reference.braced ? `\${${name}}` : `$${name}`,
        type: 'variable',
        detail: 'project env var',
        // Names only -- CircleCI does not return project variable values, so
        // there is deliberately nothing value-shaped to show here.
        info: `Set on this CircleCI project. Its value is injected at run time; it is never available to this editor.`,
      })),
    };
  };
}

/**
 * One `$NAME` completion's provenance: the context(s) among this job's
 * *own* attached contexts (see `contextsForJob`) that hold a variable of
 * that name.
 *
 * A `Set`, not a single name, because two different contexts attached to
 * the same job may both define a variable of the same name -- CircleCI lets
 * the later one in `context: [a, b]` win, but this editor cannot see which
 * one a run will pick without running it, so it names every context that
 * could be the source rather than guessing.
 */
type ContextVariableProviders = Map<string, Set<string>>;

/** Renders `createContextVarCompletionSource`'s per-variable info line, naming the context(s) it actually came from. */
function contextVariableInfo(contextNames: Set<string>): string {
  const names = [...contextNames];
  const where =
    names.length === 1
      ? `the "${names[0]}" context`
      : `contexts ${names.map((name) => `"${name}"`).join(', ')}`;
  // Mirrors the project-variable source's own info line below, plus naming
  // *which* context: with more than one context attached to a job, "this
  // context" would not say which of them actually defines the name.
  return `Set in ${where}, which this job attaches. Its value is injected at run time; it is never available to this editor.`;
}

/**
 * A CodeMirror completion source offering the names of variables held by the
 * contexts *this job* attaches, wherever a `$` reference is being typed
 * inside one of its `run` commands (issue #23).
 *
 * ## Scoping to this job, not the organization
 *
 * `contextsForJob` -- not the store's full `contexts` list -- decides which
 * contexts are even candidates. Every context the organization has would be
 * available before this job actually asked for any of them, and offering
 * one of those looks exactly like offering one the job *does* attach: the
 * completion popup has no way to mark "this would need one more edit to
 * config first." Issue #23 is explicit that this is worse than offering
 * nothing, so scoping happens before a single network request is made, not
 * as a filter on the result.
 *
 * ## Absent, not partial, with no token
 *
 * Resolving a context name to variable names needs two things this source
 * cannot get without a token: the organization's context list (to turn the
 * job's `context: [deploy-prod]` into an id) and that context's own variable
 * listing. `store.state !== 'ready'` covers every reason either might be
 * missing -- no token, still loading, the request failed -- and this source
 * returns `null` for all of them alike, exactly the "silently unavailable"
 * degradation `createEnvVarCompletionSource` already has for project
 * variables. What tells a user *why* nothing appeared is not this popup --
 * it is the palette's Contexts section and the inspector's context field,
 * both of which already say "no token" in so many words (`ContextField`'s
 * own coverage line, `ProjectContextWarnings`) rather than "this job has no
 * contexts". A missing-credential state and an empty-context state must
 * never render alike, and the existing surfaces already keep that promise;
 * this source's job is only to stay out of the way rather than to repeat it.
 *
 * ## Why this may fetch, not just read the store
 *
 * Unlike project variables (loaded once, up front, by `YamlPane`), a
 * context's variables are fetched lazily -- only once the palette's detail
 * view for that context has been opened (see `projectContextStore`'s own
 * doc comment on why: it is secret *metadata*, and fetching it for every
 * context up front would ask CircleCI for data nobody requested). Typing a
 * `$` inside a job that attaches a context nobody has opened yet is a
 * perfectly normal way to use this editor, so this source primes the fetch
 * itself via `ensureContextDetail` (which is idempotent and shares its cache
 * with the palette) rather than only ever completing what happens to be
 * warm already -- the inconsistency-by-click-history problem this module's
 * own doc comment describes, solved by not depending on prior clicks at
 * all.
 *
 * Returns `null` -- not an empty result -- whenever it has nothing to say,
 * for the same reason `createEnvVarCompletionSource` does.
 */
export function createContextVarCompletionSource() {
  return async function contextVarCompletionSource(
    context: CompletionContext,
  ): Promise<CompletionResult | null> {
    const text = context.state.doc.toString();
    const reference = findDollarReference(text, context.pos);
    if (!reference) return null;

    const located = locateShellText(text, context.pos);
    if (!located || located.jobName === null) return null;

    const store = useProjectContextStore.getState();
    if (store.state !== 'ready') return null;

    const attachedNames = contextsForJob(located.doc, located.jobName);
    if (attachedNames.length === 0) return null;

    const attachedContexts = store.contexts.filter((candidate) =>
      attachedNames.includes(candidate.name),
    );
    if (attachedContexts.length === 0) return null;

    const details = await Promise.all(
      attachedContexts.map((candidate) =>
        store.ensureContextDetail(candidate.id),
      ),
    );

    const providers: ContextVariableProviders = new Map();
    attachedContexts.forEach((attachedContext, index) => {
      for (const variable of details[index]?.variables ?? []) {
        const contextNames = providers.get(variable.name) ?? new Set<string>();
        contextNames.add(attachedContext.name);
        providers.set(variable.name, contextNames);
      }
    });
    if (providers.size === 0) return null;

    return {
      from: reference.from,
      to: context.pos,
      options: [...providers.entries()].map(([name, contextNames]) => ({
        label: reference.braced ? `\${${name}}` : `$${name}`,
        type: 'variable',
        detail: 'context env var',
        // Names only -- see `ContextVariableSummary`'s own doc comment:
        // CircleCI does not return context variable values through any API,
        // and this editor must never ask for, cache, or display one.
        info: contextVariableInfo(contextNames),
      })),
    };
  };
}
