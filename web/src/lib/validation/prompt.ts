/**
 * Composes the prompt the "Fix with AI" button drops into the AI pane's
 * message box.
 *
 * Three things this deliberately does *not* do:
 *
 *  - **It does not send.** The button seeds the composer; the user reads it
 *    and presses Send. That is the whole point of the affordance -- the
 *    owner asked for a button that "puts a prompt down in the chat", not one
 *    that talks to a model on its own.
 *  - **It does not apply anything.** Whatever the model replies with still
 *    goes through the AI pane's existing approval-gated action flow, which is
 *    the only path from a model to this document.
 *  - **It does not re-paste the whole config.** The host already puts the
 *    open file's full text, its job/workflow names and the current
 *    validation errors into the system prompt (see `buildSystemPrompt` in
 *    `internal/host/ai.go`). Repeating all of it here would double the
 *    request for no added information; what the model is missing is *which*
 *    of those errors the user is asking about and where it lands, which is
 *    exactly what this adds.
 */
import type { Diagnostic, DiagnosticTarget } from './diagnostics';
import { describeSource } from './diagnostics';

/** How many lines of context either side of a resolved location to quote. Enough to see the enclosing block without turning the prompt into a second copy of the file. */
const CONTEXT_LINES = 6;

/**
 * What kind of problem this is, in one sentence, plus the one instruction that
 * aims retrieval at the right subject (issue #210).
 *
 * The owner's report is the specification: for `Cannot find circleci/slack@4.12.5
 * in the orb registry`, the docs server's top source was Slack's **Block Kit
 * builder** — a page about composing Slack messages. Retrieval ran over a prompt
 * containing the word "slack" and answered the question that word suggests, which
 * is not the question the user asked.
 *
 * So the prompt now names the *class* of the error before quoting it. That
 * classification is not new and is not guessed: `diagnostics.ts` already extracts
 * a `DiagnosticTarget` mechanically from the compiler's own message, and refuses
 * to when extraction would mean guessing (#163) — which is exactly the
 * property that makes it safe to put words in the user's mouth here. A diagnostic
 * with no target adds nothing, and the prompt reads as it did before.
 *
 * The "look at X, not Y" phrasing is deliberate and narrow: it is a statement
 * about **which documentation is relevant**, not a hint about the fix. Telling a
 * model what the answer probably is would undo the reason this prompt is seeded
 * rather than sent.
 */
function describeClass(target: DiagnosticTarget): string[] {
  switch (target.kind) {
    case 'orb':
      return [
        `Problem type: an orb reference under \`orbs:\` that the registry could not resolve — namespace, orb name or version.`,
        `Please treat this as a question about **CircleCI orbs**: how an orb is declared, and how its version is pinned. It is not a question about the third-party service the orb integrates with, whose own documentation is not relevant here.`,
      ];
    case 'executor':
      return [
        `Problem type: a job's \`executor:\` names an executor that has no definition in this config.`,
        `Please treat this as a question about **CircleCI reusable config** — the \`executors:\` key and how a job refers to one.`,
      ];
    case 'command':
      return [
        `Problem type: a step names a command that has no definition — either a misspelled built-in step, or an undefined local or orb command.`,
        `Please treat this as a question about **CircleCI steps and reusable commands**.`,
      ];
    case 'workflowJob':
      return [
        `Problem type: a workflow lists a job that has no definition under \`jobs:\`.`,
        `Please treat this as a question about **how workflows reference jobs** in a CircleCI config.`,
      ];
    case 'requires':
      return [
        `Problem type: a \`requires:\` entry names an id that nothing in the workflow provides.`,
        `Please treat this as a question about **job dependencies in CircleCI workflows** (\`requires\`).`,
      ];
    case 'schemaPath':
      return [
        `Problem type: a schema violation at a concrete path in this config — a key that is not permitted where it appears, or one that is missing.`,
        `Please treat this as a question about the **CircleCI configuration reference** for that part of the file.`,
      ];
  }
}

/** The `line: text` excerpt around `line`, with the offending line marked so the model doesn't have to count. */
function excerpt(text: string, line: number): string[] {
  const lines = text.split('\n');
  const from = Math.max(1, line - CONTEXT_LINES);
  const to = Math.min(lines.length, line + CONTEXT_LINES);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const marker = n === line ? '>' : ' ';
    out.push(`${marker} ${n} | ${lines[n - 1] ?? ''}`);
  }
  return out;
}

export interface FixPromptInput {
  diagnostic: Diagnostic;
  /** The editor's current text -- the same bytes the location's line number counts against. */
  text: string;
  /** Absolute path of the open file, for the model to name it back unambiguously. */
  configPath: string;
  /**
   * The orb's published versions, when the diagnostic is about an orb and the
   * registry has been asked (issue #210). Facts, not suggestions: the list comes
   * from the orb cache via `GET /api/orbs/source`, which is the same lookup the
   * validation strip already makes for its own version suggestion (#128/#89).
   *
   * They go in the prompt rather than being turned into a URL, because a
   * per-version registry URL is a shape this app has not verified -- see
   * `lib/ai/deterministicSources`'s header. A model that is told the real
   * versions does not have to invent one, which is the whole point.
   */
  orbVersions?: { versions?: readonly string[]; latestVersion?: string };
}

/** How many published versions to quote. Newest-first, so this is the useful end of the list; the whole history of a popular orb is hundreds of tags and would swamp the prompt. */
const QUOTED_ORB_VERSIONS = 8;

/**
 * Builds the seeded prompt. Written in the first person, as the user, because
 * that is who will be sending it -- and phrased so the model is told plainly
 * what this app knows and what it doesn't:
 *
 *  - the error's provenance, in the same honest terms the UI uses (a local
 *    check is never described as something CircleCI said);
 *  - the location, or explicitly that this app could not place it, so the
 *    model doesn't assume a line it wasn't given;
 *  - that a minimal, comment-preserving edit is wanted -- because the user
 *    will be shown it as a diff, and a wholesale rewrite is unreviewable;
 *  - **what kind of problem this is** (issue #210), from the classification
 *    `diagnostics.ts` already performs, so that a docs search runs over "an orb
 *    reference that does not resolve" rather than over whatever product name the
 *    orb happens to integrate with. See `describeClass`.
 *
 * It still does not send. The button seeds the composer, the user reads it, and
 * pressing Send is a separate act -- #163's end-to-end test asserts zero
 * `/api/ai/chat` requests on this path, and nothing here changes that.
 */
export function buildFixPrompt({
  diagnostic,
  text,
  configPath,
  orbVersions,
}: FixPromptInput): string {
  const lines: string[] = [];

  // Issue #247: a policy violation is not a validation failure -- a soft
  // failure in particular does not stop this config from running -- so the
  // opening line must not claim it does.
  lines.push(
    diagnostic.source === 'policy'
      ? `My CircleCI config was flagged by an organization config policy and I'd like help making it comply.`
      : `My CircleCI config is failing validation and I'd like help fixing it.`,
  );
  lines.push('');
  lines.push(`File: ${configPath || 'the open config'}`);
  lines.push(`Reported by: ${describeSource(diagnostic.source)}`);

  // Issue #247: a policy violation names the rule that fired, separately
  // from the reason -- "which control" and "what it wants" answer different
  // questions, and both belong here exactly as they do in the Policies tab
  // (PolicyRulesView, in the Project pane since issue #306).
  if (diagnostic.policyRule) {
    lines.push(
      `Policy rule: ${diagnostic.policyRule.name} (${
        diagnostic.policyRule.blocking
          ? 'blocking -- would refuse a pipeline on CircleCI'
          : 'non-blocking -- recorded but does not refuse a pipeline'
      })`,
    );
  }

  if (diagnostic.source === 'local') {
    lines.push(
      `Note: this came from this editor's own offline checks, not from CircleCI's compiler -- there is no CircleCI API token configured here, so the config has not actually been compiled.`,
    );
  }

  for (const context of diagnostic.context) {
    lines.push(`In ${context.kind}: ${context.name}`);
  }

  if (diagnostic.location) {
    lines.push(
      `Location: line ${diagnostic.location.line}, column ${diagnostic.location.column}` +
        (diagnostic.location.basis === 'reported'
          ? ' (quoted by the validator itself)'
          : ' (resolved by matching the name in the error against the config)'),
    );
  } else {
    lines.push(
      `Location: unknown -- this error does not name a line, and the editor could not place it in the file. Please work out where it applies.`,
    );
  }

  // Before the error text, not after it: the class is what a reader (and a
  // retrieval query built from this prompt) should meet first. Issue #210.
  if (diagnostic.target) {
    lines.push('');
    lines.push(...describeClass(diagnostic.target));
  }

  lines.push('');
  lines.push(diagnostic.source === 'policy' ? 'Policy message:' : 'Error:');
  lines.push('```');
  lines.push(diagnostic.title);
  for (const detail of diagnostic.detail) lines.push(detail);
  lines.push('```');

  // Facts about the orb, from the registry, so a version does not have to be
  // guessed at either end (#210). Only ever what we were actually told: no
  // versions means no line, not an empty promise.
  if (diagnostic.target?.kind === 'orb') {
    const published = orbVersions?.versions ?? [];
    const latest = orbVersions?.latestVersion;
    if (published.length > 0 || latest) {
      lines.push('');
      lines.push(
        `What this editor already knows about ${diagnostic.target.orbName} from the orb registry:`,
      );
      if (latest) lines.push(`- latest published version: ${latest}`);
      if (published.length > 0) {
        const quoted = published.slice(0, QUOTED_ORB_VERSIONS);
        lines.push(
          `- published versions (newest first): ${quoted.join(', ')}${
            published.length > quoted.length
              ? `, and ${published.length - quoted.length} older`
              : ''
          }`,
        );
      }
      lines.push(
        `Please use one of those versions rather than inventing one, and say if the version I asked for was never published.`,
      );
    }
  }

  if (diagnostic.location) {
    lines.push('');
    lines.push('The surrounding config:');
    lines.push('```');
    lines.push(...excerpt(text, diagnostic.location.line));
    lines.push('```');
  }

  lines.push('');
  lines.push(
    'Please explain what is wrong and propose the smallest edit that fixes it. Change only what the error requires -- keep my comments, key order and formatting everywhere else. If there is more than one reasonable fix, say so and let me choose rather than picking one.',
  );

  return lines.join('\n');
}
