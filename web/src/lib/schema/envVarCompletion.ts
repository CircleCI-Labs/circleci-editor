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
 * Only *project* variables are offered, not context variables. Context
 * variables are only fetched for a context the user has actually opened in
 * the palette, so offering them here would make the completion list depend on
 * where someone had clicked earlier in the session -- inconsistent
 * completions are worse than absent ones. See the PR description for the
 * follow-up.
 */
import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { isPair, isScalar, parseDocument, visit } from 'yaml';

import { useProjectContextStore } from '~/state/projectContextStore';

/**
 * The keys whose scalar value is treated as shell text worth completing
 * `$NAME` inside: `command:` (a `run` step's long form) and `run:` (its
 * shorthand, `- run: make build`).
 */
const SHELL_TEXT_KEYS = new Set(['command', 'run']);

/**
 * Reports whether `pos` falls inside the scalar value of a `command:`/`run:`
 * key.
 *
 * Uses `yaml`'s own parser and real node ranges rather than pattern-matching
 * the buffer. That matters specifically because of block literals: the naive
 * approach -- walk backwards for the nearest less-indented line and read its
 * key -- gets the wrong answer for any indented shell construct, since
 * `echo $FOO` nested inside an `if ... then` block finds the `if` line first,
 * not the `command: |` line. A parsed node's range has no such ambiguity.
 *
 * Returns false (rather than throwing) for a document that does not parse.
 */
function isInsideShellText(text: string, pos: number): boolean {
  let inside = false;

  try {
    const doc = parseDocument(text);
    visit(doc, {
      Scalar(_key, node, path) {
        if (inside) return visit.BREAK;
        if (!node.range) return;
        const [start, , end] = node.range;
        if (pos < start || pos > end) return;

        const parent = path[path.length - 1];
        if (
          isPair(parent) &&
          isScalar(parent.key) &&
          typeof parent.key.value === 'string' &&
          SHELL_TEXT_KEYS.has(parent.key.value) &&
          // Only the *value* side -- the cursor sitting in the key `command`
          // itself is a key completion, which is the schema source's job.
          parent.value === node
        ) {
          inside = true;
          return visit.BREAK;
        }
        return;
      },
    });
  } catch {
    return false;
  }

  return inside;
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
