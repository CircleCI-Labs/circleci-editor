/**
 * The AI pane's propose-a-change protocol (issue #92).
 *
 * This is the single most important file the AI pane has, because it is
 * what stands between "the assistant said something" and "the config
 * actually changed". The assistant never writes YAML text, and the host
 * never applies anything on its behalf (see `internal/host/ai.go`'s own
 * doc comment) -- the model is instructed (via the system prompt built in
 * that same file, `actionSchemaPrompt`, which this module's shape must stay
 * in sync with) to end a reply proposing a change with one fenced
 * ` ```action ` code block containing a single JSON object matching
 * `ProposedAction` below. `extractAction` finds and validates that block;
 * `applyAction` maps it onto exactly one existing, already-tested
 * `configMutations.ts` function.
 *
 * Every action here is deliberately a thin, literal wrapper around a
 * function `configMutations.ts` already exports for the human-driven visual
 * editor -- never a new, AI-only code path -- so a proposed action can never
 * do anything a person clicking around the DAG/inspector couldn't already
 * do, and it always goes through the same surgical AST mutation (never
 * regenerating the document) that every other edit in this app
 * does. `AiPane` never calls `mutate()` directly with the result: it clones
 * the document, applies the action to the clone, diffs clone against the
 * live document with the same `unifiedDiff` the Save dialog uses, and only
 * commits via `useAppStore.mutate()` once the user approves that diff (see
 * `ProposeChangeDialog.tsx`).
 */
import type { Document } from 'yaml';

import {
  addJob,
  addOrb,
  addRequire,
  addStep,
  addWorkflow,
  addWorkflowJobEntry,
  deleteJob,
  renameJob,
} from '~/lib/mutations/configMutations';

export type ProposedAction =
  | { type: 'addJob'; name: string; image?: string; workflowName?: string }
  | { type: 'addWorkflow'; name: string }
  | { type: 'addStep'; job: string; step: unknown; index?: number }
  | {
      type: 'addWorkflowJobEntry';
      workflow: string;
      job: string;
      requires?: string[];
      alias?: string;
    }
  | { type: 'addRequire'; workflow: string; target: string; source: string }
  | { type: 'addOrb'; alias: string; ref: string }
  | { type: 'renameJob'; from: string; to: string }
  | { type: 'deleteJob'; name: string };

/** Every `ProposedAction.type` value, kept as one array so validation and the "unknown type" error message can't drift apart. */
const ACTION_TYPES: ProposedAction['type'][] = [
  'addJob',
  'addWorkflow',
  'addStep',
  'addWorkflowJobEntry',
  'addRequire',
  'addOrb',
  'renameJob',
  'deleteJob',
];

/** Matches a single fenced ```action code block. `s` flag so `.` spans newlines; only the first match is ever used -- the system prompt asks for exactly one action per reply. */
const ACTION_BLOCK_RE = /```action\s*\n([\s\S]*?)\n?```/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

/**
 * Validates that `value` (already-parsed JSON) matches one of
 * `ProposedAction`'s shapes, returning `undefined` if it doesn't. Every
 * field the corresponding `configMutations.ts` function requires is
 * checked here -- a structurally invalid action is rejected before it ever
 * reaches `applyAction`, which is allowed to assume its input is valid.
 */
export function validateAction(value: unknown): ProposedAction | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  const type = value.type;
  if (!ACTION_TYPES.includes(type as ProposedAction['type'])) return undefined;

  switch (type) {
    case 'addJob':
      if (!isNonEmptyString(value.name)) return undefined;
      if (value.image !== undefined && typeof value.image !== 'string')
        return undefined;
      if (
        value.workflowName !== undefined &&
        typeof value.workflowName !== 'string'
      )
        return undefined;
      return {
        type: 'addJob',
        name: value.name,
        image: value.image as string | undefined,
        workflowName: value.workflowName as string | undefined,
      };

    case 'addWorkflow':
      if (!isNonEmptyString(value.name)) return undefined;
      return { type: 'addWorkflow', name: value.name };

    case 'addStep':
      if (!isNonEmptyString(value.job)) return undefined;
      if (value.step === undefined) return undefined;
      if (value.index !== undefined && typeof value.index !== 'number')
        return undefined;
      return {
        type: 'addStep',
        job: value.job,
        step: value.step,
        index: value.index as number | undefined,
      };

    case 'addWorkflowJobEntry':
      if (!isNonEmptyString(value.workflow) || !isNonEmptyString(value.job))
        return undefined;
      if (value.requires !== undefined && !isStringArray(value.requires))
        return undefined;
      if (value.alias !== undefined && typeof value.alias !== 'string')
        return undefined;
      return {
        type: 'addWorkflowJobEntry',
        workflow: value.workflow,
        job: value.job,
        requires: value.requires as string[] | undefined,
        alias: value.alias as string | undefined,
      };

    case 'addRequire':
      if (
        !isNonEmptyString(value.workflow) ||
        !isNonEmptyString(value.target) ||
        !isNonEmptyString(value.source)
      ) {
        return undefined;
      }
      return {
        type: 'addRequire',
        workflow: value.workflow,
        target: value.target,
        source: value.source,
      };

    case 'addOrb':
      if (!isNonEmptyString(value.alias) || !isNonEmptyString(value.ref))
        return undefined;
      return { type: 'addOrb', alias: value.alias, ref: value.ref };

    case 'renameJob':
      if (!isNonEmptyString(value.from) || !isNonEmptyString(value.to))
        return undefined;
      return { type: 'renameJob', from: value.from, to: value.to };

    case 'deleteJob':
      if (!isNonEmptyString(value.name)) return undefined;
      return { type: 'deleteJob', name: value.name };

    default:
      return undefined;
  }
}

/**
 * Finds the first fenced ```action block in `text` and validates it,
 * returning `undefined` if there is none or it doesn't parse as JSON or
 * doesn't match `ProposedAction`'s shape -- all three are "no action
 * proposed", not an error the chat UI needs to surface differently, since a
 * reply with no action block is the normal case for a plain question.
 */
export function extractAction(text: string): ProposedAction | undefined {
  const match = ACTION_BLOCK_RE.exec(text);
  if (!match?.[1]) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  return validateAction(parsed);
}

/** Removes the fenced ```action block (if any) from `text`, for rendering the assistant's prose without also showing the raw JSON it ends with. */
export function stripActionBlock(text: string): string {
  return text.replace(ACTION_BLOCK_RE, '').trim();
}

/**
 * A short, human-readable summary of what an action does, shown as the
 * approval dialog's headline -- e.g. "Add job \"lint\"". Kept separate from
 * any diff text: the diff shows *exactly* what changed, this just orients
 * the reader before they read it.
 */
export function describeAction(action: ProposedAction): string {
  switch (action.type) {
    case 'addJob':
      return `Add job "${action.name}"${action.workflowName ? ` to workflow "${action.workflowName}"` : ''}`;
    case 'addWorkflow':
      return `Add workflow "${action.name}"`;
    case 'addStep':
      return `Add a step to job "${action.job}"`;
    case 'addWorkflowJobEntry':
      return `Add job "${action.job}" to workflow "${action.workflow}"`;
    case 'addRequire':
      return `Make "${action.target}" require "${action.source}" in workflow "${action.workflow}"`;
    case 'addOrb':
      return `Import orb "${action.ref}" as "${action.alias}"`;
    case 'renameJob':
      return `Rename job "${action.from}" to "${action.to}"`;
    case 'deleteJob':
      return `Delete job "${action.name}"`;
  }
}

/**
 * Applies `action` to `doc` in place, by calling exactly the
 * `configMutations.ts` function a human performing the same edit through
 * the visual editor would trigger. Throws exactly the way those functions
 * do (e.g. "job already exists", "would create a cycle") -- callers should
 * treat that the same as `useAppStore.mutate()` does: discard the clone,
 * surface the message, apply nothing.
 */
export function applyAction(doc: Document, action: ProposedAction): void {
  switch (action.type) {
    case 'addJob':
      addJob(doc, {
        name: action.name,
        image: action.image,
        workflowName: action.workflowName,
      });
      return;
    case 'addWorkflow':
      addWorkflow(doc, action.name);
      return;
    case 'addStep':
      addStep(doc, action.job, action.step, action.index);
      return;
    case 'addWorkflowJobEntry':
      addWorkflowJobEntry(doc, action.workflow, action.job, {
        requires: action.requires,
        alias: action.alias,
      });
      return;
    case 'addRequire':
      addRequire(doc, action.workflow, action.target, action.source);
      return;
    case 'addOrb':
      addOrb(doc, action.alias, action.ref);
      return;
    case 'renameJob':
      renameJob(doc, action.from, action.to);
      return;
    case 'deleteJob':
      deleteJob(doc, action.name);
      return;
  }
}
