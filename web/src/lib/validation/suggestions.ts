/**
 * Concrete one-click fixes for diagnostics -- and, just as importantly, the
 * decision *not* to offer one.
 *
 * ## The rule this module is built around
 *
 * A wrong suggestion in a config editor is worse than no suggestion: it
 * costs a red pipeline and the user's trust in every other suggestion after
 * it. So a fix is offered only when **both** of these hold:
 *
 *  1. The replacement comes from a *closed candidate set* that is either
 *     enumerated by CircleCI itself in the very error being fixed (the
 *     `Permitted keys:` block; the orb registry's published version list),
 *     enumerated by the open document (its own `jobs:`, `executors:`,
 *     `commands:`, or a workflow's own entry aliases), or -- the one
 *     exception, for the one diagnostic that is itself self-sourced --
 *     `topLevelKeys.ts`'s known top-level keys (issue #5). That list is this
 *     app's own reading of the schema and docs, not something CircleCI
 *     confirmed, but the diagnostic it fixes already says so (`describeSource`
 *     labels it "Local check", never "CircleCI compiler"), so the button
 *     riding on it is no less honest than the warning it's attached to.
 *     Nothing here is ever invented outright, and nothing is ever recalled
 *     from a schema this app hasn't actually vendored.
 *  2. Exactly one candidate is a near match (see `nearestUnique`). A tie is
 *     a declined suggestion, not a coin flip.
 *
 * ## What is deliberately declined, and why
 *
 *  - **The rest of a JSON-Schema report.** `0 subschemas matched instead of
 *    one`, `expected type: String, found: Mapping`, and `required key [type]
 *    not found` are artefacts of the schema's `oneOf` over "a job" and "a
 *    string reference to a job": a misspelled `steps:` produces all three,
 *    and *acting* on the last one would add `type:` to a job that never
 *    wanted it. Only `extraneous key [k] is not permitted` -- which comes
 *    with CircleCI's own list of what was permitted -- is actionable.
 *  - **Orb name near-matches.** `circleci/nodee@5.2.0` is unresolvable, but
 *    "the closest published orb name" can silently swap in a *different
 *    vendor's* orb with different jobs and different parameters. Only the
 *    *version* is corrected, and only against the real published list for
 *    the orb the user actually named.
 *  - **Cycles and unreachable-job errors.** `At least one job in the
 *    workflow must have no dependencies.` has many correct fixes and no
 *    mechanical one: which edge to cut is a design decision.
 *  - **A missing/unsupported `version:`.** `version: 2.1` is usually right,
 *    but the key governs how the entire file is interpreted, and a config
 *    with no `version` at all may be a 2.0 config. Not ours to choose.
 *  - **Orb-qualified command names** (`slack/notifyy`). Correcting them
 *    would mean enumerating an orb's commands, which needs the network and a
 *    token -- and getting it wrong writes a step that doesn't exist.
 *
 * Everything declined here is still *surfaced*, with its full message, and
 * still reachable by the "Fix with AI" button. Declining a suggestion means
 * declining to guess, not hiding the problem.
 */
import { isMap, isScalar, type Document } from 'yaml';

import { removeRequire } from '~/lib/mutations/configMutations';
import {
  getNode,
  listKeys,
  renameKey,
  type PathSegment,
} from '~/lib/yaml/documentUtils';

import type { Diagnostic, ExtraneousKeyFinding } from './diagnostics';
import { editDistance, nearestUnique } from './editDistance';
import { findRequiresItemNodes, findStepNode, workflowEntries } from './locate';
import { KNOWN_TOP_LEVEL_KEYS } from './topLevelKeys';

// Re-exported for callers that reach these through this module -- the
// distance check used to live here (`stpes` -> `steps`) before issue #5
// needed the identical logic one level up (`workflow` -> `workflows`) and it
// moved to `editDistance.ts` so the two modules don't import each other (see
// that module's doc comment).
export { editDistance, nearestUnique };

/**
 * Built-in step names, taken from `internal/schema/schema.json`'s
 * `definitions.step` (the object branch's `properties`, plus the
 * `when`/`unless` branch). Hard-coded rather than read from `GET /api/schema`
 * because this must work with no network at all, and because a *shorter*
 * candidate list can only cause a suggestion to be declined, never to be
 * wrong.
 */
const BUILTIN_STEPS = [
  'add_ssh_keys',
  'attach_workspace',
  'checkout',
  'persist_to_workspace',
  'restore_cache',
  'run',
  'save_cache',
  'setup_remote_docker',
  'store_artifacts',
  'store_test_results',
  'unless',
  'when',
];

/**
 * One offered fix. `apply` is a surgical mutation of the live `Document`,
 * run inside `appStore.mutate` -- which clones, splices only the changed
 * range back into the existing text, and records exactly one undo
 * entry. Nothing here ever re-emits the document or touches text directly,
 * so comments, blank lines and hand-formatting outside the edited range are
 * untouched.
 */
export interface Suggestion {
  id: string;
  /** Imperative, and specific enough to audit without opening the diff: "Rename `stpes` to `steps`". */
  label: string;
  /**
   * Where the candidate came from. Shown to the user, because a suggestion
   * whose provenance is invisible has to be trusted blindly -- and this one
   * is meant to be checkable.
   */
  rationale: string;
  /** Undo-history label handed to `appStore.mutate`. */
  mutationLabel: string;
  apply: (doc: Document) => void;
  /**
   * Set on a fix that changes what the pipeline *does* rather than
   * correcting a typo (today: dropping a dependency). Rendered as a
   * secondary action with the consequence spelled out.
   */
  changesBehavior?: boolean;
}

/** Renames a live scalar in place, so any comment attached to it survives -- the same technique `documentUtils.renameKey` uses, applied to a sequence item. */
function renameScalarNode(node: unknown, to: string): void {
  if (!isScalar(node)) throw new Error(STALE);
  node.value = to;
}

function keysAt(doc: Document, path: PathSegment[]): string[] {
  return listKeys(doc, path);
}

/**
 * Thrown by every `apply` when the node it was written for is no longer where
 * it was. This matters because `appStore.mutate` runs `apply` against a
 * *clone* of a document that may itself be several keystrokes newer than the
 * one the suggestion was derived from -- so each `apply` re-finds its target
 * in the document it is handed rather than closing over a live node from the
 * document that produced the suggestion. Closing over the node would edit the
 * wrong document: the mutation would land on the store's current `doc` while
 * the clone (the one that becomes the new text) went unchanged, silently
 * doing nothing.
 *
 * `mutate` catches this, discards the clone, and surfaces the message through
 * `editError` -- the same path any other refused edit takes.
 */
const STALE =
  'That fix no longer applies -- the config has changed since this suggestion was worked out. Re-check the error and try again.';

/** `extraneous key [k]` -> rename to the permitted key it was almost certainly meant to be. CircleCI supplied the candidate list itself. */
function suggestForExtraneousKey(
  doc: Document,
  finding: ExtraneousKeyFinding,
  index: number,
): Suggestion[] {
  if (finding.permitted.length === 0) return [];
  const replacement = nearestUnique(finding.key, finding.permitted);
  if (!replacement) return [];
  // Don't offer a rename that would collide with a key already there: the
  // mutation would refuse it anyway, and offering a button that can't work
  // is its own kind of wrong answer.
  if (keysAt(doc, finding.path).includes(replacement)) return [];

  const path = finding.path;
  return [
    {
      id: `extraneous-key-${index}`,
      label: `Rename "${finding.key}" to "${replacement}"`,
      rationale: `CircleCI listed the keys permitted here, and "${replacement}" is the only one within a typo's distance of "${finding.key}".`,
      mutationLabel: `Rename ${finding.key} to ${replacement}`,
      apply: (target) => {
        if (!renameKey(target, path, finding.key, replacement)) {
          throw new Error(STALE);
        }
      },
    },
  ];
}

/**
 * Issue #5: a rename for the one diagnostic this app raises about its own
 * suspicion rather than something CircleCI said. The rationale is worded
 * accordingly -- "this editor's own check" rather than "CircleCI listed" --
 * because `suggestForExtraneousKey`'s rationale above would be a false claim
 * of provenance here: there is no compiler report this candidate was read
 * out of.
 */
function suggestForTopLevelKeyTypo(doc: Document, key: string): Suggestion[] {
  const replacement = nearestUnique(key, KNOWN_TOP_LEVEL_KEYS);
  if (!replacement) return [];
  // Same collision guard as the extraneous-key case: a document that already
  // has both `workflow:` and `workflows:` would have the rename refused by
  // `renameKey` anyway, and a button that can't work is its own kind of
  // wrong answer.
  if (keysAt(doc, []).includes(replacement)) return [];

  return [
    {
      id: 'top-level-key-typo',
      label: `Rename "${key}" to "${replacement}"`,
      rationale: `"${replacement}" is this editor's only known top-level CircleCI config key within a typo's distance of "${key}" -- CircleCI's compiler did not flag "${key}" itself; this is this editor's own suspicion, not something it confirmed.`,
      mutationLabel: `Rename ${key} to ${replacement}`,
      apply: (target) => {
        if (!renameKey(target, [], key, replacement)) {
          throw new Error(STALE);
        }
      },
    },
  ];
}

/**
 * Derives the fixes worth offering for one diagnostic. Returns `[]` -- which
 * the UI renders as "no reliable automatic fix" rather than hiding the error
 * -- for everything this module declines; see its doc comment for the list.
 */
export function suggestionsFor(
  diagnostic: Diagnostic,
  doc: Document | null,
): Suggestion[] {
  if (!doc) return [];
  const target = diagnostic.target;
  if (!target) return [];

  switch (target.kind) {
    case 'schemaPath': {
      // Issue #5's top-level near-miss check produces a `schemaPath` target
      // too (`path: []`, `key` set), but it never carries `extraneousKeys` --
      // there is no compiler report to have read one from, since the whole
      // point of that diagnostic is that CircleCI's compiler didn't say
      // anything. `diagnostic.source` is the reliable way to tell the two
      // apart rather than inferring it from an absent field.
      if (diagnostic.source === 'local' && target.key !== undefined) {
        return suggestForTopLevelKeyTypo(doc, target.key);
      }
      // The findings are re-read from the diagnostic rather than recomputed:
      // `extraneousKeys` is what CircleCI actually printed for this report.
      const findings = diagnostic.extraneousKeys ?? [];
      return findings.flatMap((finding, index) =>
        suggestForExtraneousKey(doc, finding, index),
      );
    }

    case 'requires': {
      const hits = findRequiresItemNodes(
        doc,
        target.workflow,
        target.fromAlias,
        target.missingId,
      );
      // Ambiguous or absent: the id isn't written exactly once where the
      // compiler said it was, so there is no single node to edit.
      if (hits.length !== 1) return [];

      const workflow = target.workflow;
      if (workflow === undefined) return [];
      // The candidate set is precisely what CircleCI compared against: the
      // *other* entries' aliases in this workflow. (The message even says
      // so: "which is the name of 0 other jobs in workflow 'main'".)
      const aliases = [...workflowEntries(doc, workflow)]
        .map((entry) => entry.alias)
        .filter((alias) => alias !== target.fromAlias);
      const replacement = nearestUnique(target.missingId, aliases);

      const suggestions: Suggestion[] = [];
      if (replacement !== undefined) {
        suggestions.push({
          id: 'requires-rename',
          label: `Change requires: "${target.missingId}" to "${replacement}"`,
          rationale: `"${replacement}" is the only job in workflow "${workflow}" within a typo's distance of "${target.missingId}".`,
          mutationLabel: `Fix requires: ${target.missingId} -> ${replacement}`,
          apply: (docToEdit) => {
            const live = findRequiresItemNodes(
              docToEdit,
              workflow,
              target.fromAlias,
              target.missingId,
            );
            if (live.length !== 1) throw new Error(STALE);
            renameScalarNode(live[0], replacement);
          },
        });
      }
      // Offered whether or not there was a near match: a `requires:` left
      // behind by a job that was deleted has no near match by construction,
      // and dropping it is then the only mechanical fix there is. Flagged
      // `changesBehavior` because it removes an ordering constraint rather
      // than correcting a name.
      suggestions.push({
        id: 'requires-remove',
        label: `Remove "${target.missingId}" from ${target.fromAlias}'s requires:`,
        rationale: `Nothing in workflow "${workflow}" provides "${target.missingId}". Removing the dependency clears the error, but ${target.fromAlias} will no longer wait for anything it named here.`,
        mutationLabel: `Remove requires: ${target.missingId}`,
        changesBehavior: true,
        apply: (target2) =>
          removeRequire(target2, workflow, target.fromAlias, target.missingId),
      });
      return suggestions;
    }

    case 'executor': {
      if (target.job === undefined) return [];
      const declared = keysAt(doc, ['executors']);
      const replacement = nearestUnique(target.name, declared);
      if (replacement === undefined) return [];
      const job = target.job;
      return [
        {
          id: 'executor-rename',
          label: `Use executor "${replacement}"`,
          rationale: `This config declares ${declared.length} executor${declared.length === 1 ? '' : 's'}, and "${replacement}" is the only one within a typo's distance of "${target.name}".`,
          mutationLabel: `Fix executor: ${target.name} -> ${replacement}`,
          apply: (docToEdit) => {
            const executor = getNode(docToEdit, ['jobs', job, 'executor']);
            if (isScalar(executor)) {
              renameScalarNode(executor, replacement);
              return;
            }
            if (isMap(executor)) {
              const namePair = executor.items.find(
                (pair) =>
                  isScalar(pair.key) && String(pair.key.value) === 'name',
              );
              renameScalarNode(namePair?.value, replacement);
              return;
            }
            throw new Error(STALE);
          },
        },
      ];
    }

    case 'command': {
      // An orb-qualified name needs the orb's own command list to correct --
      // see this module's doc comment on why that is declined.
      if (target.name.includes('/')) return [];
      const owner: PathSegment[] | undefined =
        target.job !== undefined
          ? ['jobs', target.job, 'steps']
          : target.fromCommand !== undefined
            ? ['commands', target.fromCommand, 'steps']
            : undefined;
      if (!owner) return [];
      const stepsPath = owner;
      if (!findStepNode(getNode(doc, stepsPath), target.name)) return [];

      const candidates = [...BUILTIN_STEPS, ...keysAt(doc, ['commands'])];
      const replacement = nearestUnique(target.name, candidates);
      if (replacement === undefined) return [];
      return [
        {
          id: 'command-rename',
          label: `Rename step "${target.name}" to "${replacement}"`,
          rationale: BUILTIN_STEPS.includes(replacement)
            ? `"${replacement}" is a built-in CircleCI step, and the only name within a typo's distance of "${target.name}".`
            : `"${replacement}" is a command this config declares, and the only name within a typo's distance of "${target.name}".`,
          mutationLabel: `Fix step: ${target.name} -> ${replacement}`,
          apply: (docToEdit) => {
            const live = findStepNode(
              getNode(docToEdit, stepsPath),
              target.name,
            );
            if (!live) throw new Error(STALE);
            renameScalarNode(live, replacement);
          },
        },
      ];
    }

    case 'workflowJob': {
      const workflow = target.workflow;
      if (workflow === undefined) return [];
      const entries = [...workflowEntries(doc, workflow)].filter(
        (entry) => entry.jobName === target.jobName,
      );
      if (entries.length !== 1) return [];

      const declared = keysAt(doc, ['jobs']);
      const replacement = nearestUnique(target.jobName, declared);
      if (replacement === undefined) return [];
      return [
        {
          id: 'workflow-job-rename',
          label: `Change "${target.jobName}" to "${replacement}"`,
          rationale: `"${replacement}" is the only job defined under jobs: within a typo's distance of "${target.jobName}".`,
          mutationLabel: `Fix workflow job: ${target.jobName} -> ${replacement}`,
          apply: (docToEdit) => {
            const live = [...workflowEntries(docToEdit, workflow)].filter(
              (candidate) => candidate.jobName === target.jobName,
            );
            if (live.length !== 1) throw new Error(STALE);
            renameScalarNode(live[0]?.keyNode, replacement);
          },
        },
      ];
    }

    case 'orb':
      // Version correction needs the registry's published version list, so
      // it is derived asynchronously -- see `orbVersionSuggestion`. Nothing
      // offline can be justified here.
      return [];
  }
}

/**
 * The one suggestion that needs the network: an orb reference whose
 * *version* doesn't exist. Built from the registry's own published version
 * list for the orb the user named, which is why it is a fact rather than a
 * guess. Returns `undefined` unless the orb resolves, the requested version
 * is genuinely absent from its published list, and a latest version exists.
 *
 * The orb *name* is never corrected -- see this module's doc comment.
 */
export function orbVersionSuggestion(
  ref: string,
  orbName: string,
  version: string,
  published: { versions?: string[]; latestVersion?: string },
): Suggestion | undefined {
  const latest = published.latestVersion;
  if (!latest) return undefined;
  const versions = published.versions ?? [];
  if (versions.includes(version)) return undefined;
  if (latest === version) return undefined;
  const replacement = `${orbName}@${latest}`;

  return {
    id: 'orb-version',
    label: `Use ${replacement}`,
    rationale: `The registry has no ${version} for ${orbName}; ${latest} is its latest published version. The orb name itself is left exactly as you wrote it.`,
    mutationLabel: `Fix orb version: ${ref} -> ${replacement}`,
    apply: (doc) => {
      const orbs = getNode(doc, ['orbs']);
      if (!isMap(orbs)) throw new Error(STALE);
      const pair = orbs.items.find(
        (item) => isScalar(item.value) && String(item.value.value) === ref,
      );
      renameScalarNode(pair?.value, replacement);
    },
  };
}
