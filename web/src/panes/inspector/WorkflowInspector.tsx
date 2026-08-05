/**
 * The workflow-level inspector body (issue #288).
 *
 * The DAG and inspector were, until this issue, built entirely around
 * *workflow entries* -- select a job, edit that entry (`Inspector.tsx`'s own
 * `node`-shaped body). Nothing reached the workflow's own top-level keys:
 * `when`/`unless` (conditional execution, very often gated on a
 * `<< pipeline.parameters.* >>` value -- the consuming half of issue #250's
 * editable pipeline parameters, without which a declared parameter is only
 * half a feature), `triggers:`/`schedule:` (including its own `cron` and
 * `filters`), and `max_auto_reruns`.
 *
 * # Where this is reached from, and why (owner's placement decision)
 *
 * Selecting the *workflow itself* puts it here, in the inspector, the same
 * way selecting a job does -- the inspector is already "edit the selected
 * thing", so this adds no new mental model. Two ways in, both wired up in
 * `DagPane.tsx`: clicking empty canvas (`handlePaneClick`), and clicking a
 * `WorkflowTabs` tab that is already the active one. Rejected alternatives,
 * on the record so they aren't relitigated: the DAG pane header (#158/#225
 * already establish that pane furniture is the binding width constraint
 * there) and the Reference pane's Project tab (wrong -- #248 made that
 * pane deliberately read-only).
 *
 * # `jobs:` ordering is deliberately absent
 *
 * The DAG canvas already edits a workflow's `jobs:` list indirectly (drag,
 * `requires:`, add/remove job). Duplicating that here would be a second,
 * competing way to do the same thing, which is exactly what issue #288's own
 * scope note rules out.
 *
 * # Surgical mutations only
 *
 * Every write here goes through `setWorkflowField`/`unsetWorkflowField`/
 * `addWorkflowTrigger`/`removeWorkflowTrigger` (`configMutations.ts`), which
 * are themselves thin wrappers over `documentUtils.setIn`/`deleteIn` -- the
 * same surgical-edit machinery `setJobField`/`unsetJobField` already use, so
 * this body inherits their comment/formatting-preservation guarantees rather
 * than needing new ones (see `roundtrip.test.ts`'s "workflow-level field
 * mutations" suite).
 */
import { useState, type ReactNode } from 'react';
import type { Document } from 'yaml';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DOCS_LINKS, stepDocsUrl } from '~/lib/docs/docsLinks';
import { getIn } from '~/lib/yaml/documentUtils';
import {
  addWorkflowTrigger,
  removeWorkflowTrigger,
  setWorkflowField,
  unsetWorkflowField,
} from '~/lib/mutations/configMutations';
import { validateCron, type CronCheck } from '~/lib/validation/cron';

import { CollapsibleSection } from './CollapsibleSection';
import {
  Field,
  inputClassName,
  TagListEditor,
  type MutateFn,
} from './Inspector';
import { defaultSectionOpen } from './inspectorSections';

// ---------------------------------------------------------------------------
// when: / unless: -- a string or a structured `logic` value (issue #288)
// ---------------------------------------------------------------------------

/**
 * The vendored schema's `definitions.logic`: a leaf (string/number/boolean,
 * very often `<< pipeline.parameters.* >>`), or a single-key map naming one
 * of five operators. `'other'` covers a shape this editor doesn't build --
 * a multi-key map, a `matches` missing a field -- which is shown read-only
 * rather than guessed at, per the issue's own "don't rewrite one shape into
 * another" constraint.
 */
type LogicKind = 'value' | 'and' | 'or' | 'not' | 'equal' | 'matches' | 'other';

const LOGIC_OPERATOR_KEYS = ['and', 'or', 'not', 'equal', 'matches'] as const;

function classifyLogic(value: unknown): LogicKind {
  if (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return 'value';
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) {
      const [key] = keys;
      if ((LOGIC_OPERATOR_KEYS as readonly string[]).includes(key ?? '')) {
        return key as LogicKind;
      }
    }
  }
  return 'other';
}

/** `'true'`/`'false'` become a boolean, a bare integer becomes a number, anything else stays a string -- mirrors how this pane's other leaf fields (`ParamField`) already coerce free text back to a typed value. */
function coerceLogicLeaf(text: string): string | number | boolean {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function logicLeafText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/** One `and:`/`or:`/`equal:` operand list -- each item is itself a full `LogicValueEditor`, so a nested `and`-of-`or` renders correctly instead of only one level deep. */
function LogicListEditor({
  items,
  onChange,
  addLabel,
}: {
  items: unknown[];
  onChange: (next: unknown[]) => void;
  addLabel: string;
}) {
  return (
    <div className="ml-3 space-y-2 border-l border-cc-border pl-3">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <LogicValueEditor
              value={item}
              onChange={(next) => {
                const copy = [...items];
                copy[index] = next;
                onChange(copy);
              }}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove condition ${index + 1}`}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
          >
            &times;
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onChange([...items, ''])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * The leaf case's own text field, split out from `LogicValueEditor` so its
 * `useState` (the commit-on-blur draft, same pattern as every other text
 * field in this pane) is only ever mounted -- never conditionally called --
 * for as long as `kind === 'value'`. `LogicValueEditor` swaps which
 * component renders as `kind` changes, which is ordinary conditional
 * rendering; giving the hook to *this* component instead of calling it
 * inside a branch of `LogicValueEditor` itself is what keeps that swap from
 * being a rules-of-hooks violation.
 */
function LogicLeafField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [draft, setDraft] = useState(logicLeafText(value));
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== logicLeafText(value)) onChange(coerceLogicLeaf(draft));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      placeholder="<< pipeline.parameters.deploy >>"
      aria-label="Condition value"
      className={`${inputClassName} font-mono`}
    />
  );
}

/**
 * One `logic` value, recursively. The `<select>` at the top switches which
 * *shape* is being built -- a leaf value, or one of the five operators --
 * and is a deliberate, explicit user action: it is the only thing in this
 * component that ever changes a value's shape, since silently rewriting a
 * string into a map (or back) on an unrelated render is exactly what the
 * issue's "don't rewrite one into the other" rules out. Selecting the shape
 * already in the document is a no-op (`onChange` is not called), so opening
 * this editor on an existing condition never touches it until the user
 * actually edits something.
 */
function LogicValueEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const kind = classifyLogic(value);

  const kindSelect = (
    <select
      aria-label="Condition type"
      value={kind === 'other' ? 'other' : kind}
      onChange={(event) => {
        const next = event.target.value as LogicKind;
        if (next === kind) return;
        switch (next) {
          case 'value':
            onChange('');
            break;
          case 'and':
          case 'or':
          case 'equal':
            onChange({ [next]: [''] });
            break;
          case 'not':
            onChange({ not: '' });
            break;
          case 'matches':
            onChange({ matches: { pattern: '', value: '' } });
            break;
          case 'other':
            break;
        }
      }}
      className={`${inputClassName} mb-1.5 font-mono`}
    >
      <option value="value">Value</option>
      <option value="and">and (all of)</option>
      <option value="or">or (any of)</option>
      <option value="not">not</option>
      <option value="equal">equal</option>
      <option value="matches">matches (regex)</option>
      {kind === 'other' ? <option value="other">Unrecognized</option> : null}
    </select>
  );

  if (kind === 'value') {
    return (
      <div>
        {kindSelect}
        <LogicLeafField value={value} onChange={onChange} />
      </div>
    );
  }

  if (kind === 'and' || kind === 'or' || kind === 'equal') {
    const items = Array.isArray((value as Record<string, unknown>)[kind])
      ? ((value as Record<string, unknown>)[kind] as unknown[])
      : [];
    return (
      <div>
        {kindSelect}
        <LogicListEditor
          items={items}
          onChange={(next) => onChange({ [kind]: next })}
          addLabel={kind === 'equal' ? 'Add value to compare' : 'Add condition'}
        />
      </div>
    );
  }

  if (kind === 'not') {
    const inner = (value as Record<string, unknown>).not;
    return (
      <div>
        {kindSelect}
        <div className="ml-3 border-l border-cc-border pl-3">
          <LogicValueEditor
            value={inner}
            onChange={(next) => onChange({ not: next })}
          />
        </div>
      </div>
    );
  }

  if (kind === 'matches') {
    const inner =
      value && typeof value === 'object'
        ? ((value as Record<string, unknown>).matches as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const pattern = typeof inner?.pattern === 'string' ? inner.pattern : '';
    const patternValue = typeof inner?.value === 'string' ? inner.value : '';
    return (
      <div className="space-y-1.5">
        {kindSelect}
        <input
          value={pattern}
          onChange={(event) =>
            onChange({
              matches: { pattern: event.target.value, value: patternValue },
            })
          }
          placeholder="pattern, e.g. ^main$"
          aria-label="Matches pattern"
          className={`${inputClassName} font-mono`}
        />
        <input
          value={patternValue}
          onChange={(event) =>
            onChange({
              matches: { pattern, value: event.target.value },
            })
          }
          placeholder="value to test, e.g. << pipeline.git.branch >>"
          aria-label="Matches value"
          className={`${inputClassName} font-mono`}
        />
      </div>
    );
  }

  // 'other': a shape this editor doesn't build (a multi-key map, a
  // malformed `matches`, ...). Shown as raw JSON and left untouched unless
  // the user deliberately picks a different shape from the select above --
  // never silently coerced into one on render.
  return (
    <div>
      {kindSelect}
      <p className="rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5 text-2xs text-cc-text-muted">
        This pane doesn&rsquo;t have a form for this condition&rsquo;s shape --
        shown as written, never rewritten:{' '}
        <span className="font-mono">{JSON.stringify(value)}</span>. Edit the
        YAML directly, or pick a type above to replace it.
      </p>
    </div>
  );
}

/** `when`/`unless` are mutually exclusive per the schema (a workflow with both fails to compile) -- this reads whichever is actually present, preferring `when` if a malformed config somehow has both, and says so rather than silently picking one. */
function WorkflowConditionSection({
  doc,
  workflowName,
  mutate,
}: {
  doc: Document;
  workflowName: string;
  mutate: MutateFn;
}) {
  const whenValue = getIn(doc, ['workflows', workflowName, 'when']);
  const unlessValue = getIn(doc, ['workflows', workflowName, 'unless']);
  const hasWhen = whenValue !== undefined;
  const hasUnless = unlessValue !== undefined;
  const activeKey: 'when' | 'unless' | null = hasWhen
    ? 'when'
    : hasUnless
      ? 'unless'
      : null;
  const activeValue = activeKey === 'when' ? whenValue : unlessValue;

  const setCondition = (key: 'when' | 'unless', value: unknown) =>
    mutate((d) => setWorkflowField(d, workflowName, [key], value));
  const clearCondition = (key: 'when' | 'unless') =>
    mutate((d) => unsetWorkflowField(d, workflowName, [key]));

  const whenUnlessDocsLink = stepDocsUrl('when');

  return (
    <CollapsibleSection
      id="workflow-condition"
      title="Condition"
      docsLink={
        whenUnlessDocsLink
          ? { label: 'The when/unless step', url: whenUnlessDocsLink }
          : undefined
      }
      contentCount={activeKey ? 1 : 0}
      defaultOpen={defaultSectionOpen('workflow-condition', activeKey !== null)}
    >
      {hasWhen && hasUnless ? (
        <p
          role="alert"
          className="mb-2 rounded-md border border-cc-danger/40 bg-[color-mix(in_srgb,var(--color-cc-danger)_12%,transparent)] px-2 py-1.5 text-2xs text-cc-danger"
        >
          Both &ldquo;when&rdquo; and &ldquo;unless&rdquo; are set on this
          workflow. CircleCI does not allow both at once, and this config will
          fail to compile until one is removed.
        </p>
      ) : null}

      {activeKey === null ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCondition('when', '')}
          >
            Add &ldquo;when&rdquo;
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCondition('unless', '')}
          >
            Add &ldquo;unless&rdquo;
          </Button>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-2xs text-cc-text-muted">
            This workflow only runs {activeKey === 'when' ? 'when' : 'unless'}{' '}
            this condition is true -- checked when the pipeline compiles, before
            any job runs.
          </p>
          <LogicValueEditor
            value={activeValue}
            onChange={(next) => setCondition(activeKey, next)}
          />
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => clearCondition(activeKey)}
          >
            Remove &ldquo;{activeKey}&rdquo;
          </Button>
        </div>
      )}
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// triggers: / schedule: / cron / filters (issue #288)
// ---------------------------------------------------------------------------

/**
 * A cron field's warning/error banner, following the same certainty model
 * used elsewhere in this app:
 * `'invalid'` (confidently wrong) is danger-toned, `'unknown'` (this checker
 * can't evaluate it -- a pipeline value, a name it doesn't resolve) is a
 * neutral/warning tone that says so explicitly rather than reading like a
 * second flavour of wrong. `'valid'` renders nothing -- confirmation noise
 * on every keystroke of a correct cron would train people to stop reading
 * the banner at all.
 */
function CronCheckNote({ check }: { check: CronCheck }) {
  if (check.state === 'valid') return null;
  const isInvalid = check.state === 'invalid';
  return (
    <p
      role={isInvalid ? 'alert' : 'status'}
      className={
        isInvalid
          ? 'mt-1 text-2xs text-cc-danger'
          : 'mt-1 text-2xs text-cc-text-muted'
      }
    >
      {isInvalid ? 'Malformed cron: ' : "Can't verify this cron: "}
      {check.reason}
    </p>
  );
}

/** One trigger's `schedule.cron` -- commit-on-blur like every other text field in this pane, but checked on every keystroke (via `draft`) since `validateCron` is synchronous and local. */
function CronField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const check = validateCron(draft);
  return (
    <div className="mb-2">
      <label className="mb-0.5 block text-2xs font-medium text-cc-text-muted">
        cron
      </label>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        placeholder="0 0 * * *"
        aria-label="cron"
        className={`${inputClassName} font-mono`}
      />
      <CronCheckNote check={check} />
    </div>
  );
}

interface TriggerBranchesDraft {
  only: string[];
  ignore: string[];
}

function readTriggerBranches(
  doc: Document,
  path: (string | number)[],
): TriggerBranchesDraft {
  const only = getIn(doc, [...path, 'only']);
  const ignore = getIn(doc, [...path, 'ignore']);
  return {
    only: Array.isArray(only)
      ? only.filter((v): v is string => typeof v === 'string')
      : [],
    ignore: Array.isArray(ignore)
      ? ignore.filter((v): v is string => typeof v === 'string')
      : [],
  };
}

/** One `- schedule:` trigger: its `cron`, and its own `filters.branches` (the schema defines no `tags:` for a schedule trigger -- unlike a workflow entry's filters, which have both). */
function TriggerRow({
  doc,
  workflowName,
  index,
  mutate,
  onRemove,
}: {
  doc: Document;
  workflowName: string;
  index: number;
  mutate: MutateFn;
  onRemove: () => void;
}) {
  const cron = getIn(doc, [
    'workflows',
    workflowName,
    'triggers',
    index,
    'schedule',
    'cron',
  ]);
  const branchesPath = [
    'workflows',
    workflowName,
    'triggers',
    index,
    'schedule',
    'filters',
    'branches',
  ] as (string | number)[];
  const branches = readTriggerBranches(doc, branchesPath);

  const commitBranches = (next: TriggerBranchesDraft) => {
    mutate((d) => {
      const value: Record<string, string[]> = {};
      if (next.only.length > 0) value.only = next.only;
      if (next.ignore.length > 0) value.ignore = next.ignore;
      if (Object.keys(value).length > 0) {
        setWorkflowField(
          d,
          workflowName,
          ['triggers', index, 'schedule', 'filters', 'branches'],
          value,
        );
      } else {
        unsetWorkflowField(d, workflowName, [
          'triggers',
          index,
          'schedule',
          'filters',
        ]);
      }
    });
  };

  return (
    <div className="mb-3 rounded-md border border-cc-border-strong p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-cc-text-muted">
          Schedule trigger {index + 1}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove schedule trigger ${index + 1}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <CronField
        value={typeof cron === 'string' ? cron : ''}
        onCommit={(next) =>
          mutate((d) =>
            setWorkflowField(
              d,
              workflowName,
              ['triggers', index, 'schedule', 'cron'],
              next,
            ),
          )
        }
      />
      <TagListEditor
        label="Branches -- only"
        values={branches.only}
        placeholder="main"
        onAdd={(v) =>
          commitBranches({ ...branches, only: [...branches.only, v] })
        }
        onRemove={(v) =>
          commitBranches({
            ...branches,
            only: branches.only.filter((x) => x !== v),
          })
        }
      />
      <TagListEditor
        label="Branches -- ignore"
        values={branches.ignore}
        placeholder="wip-*"
        onAdd={(v) =>
          commitBranches({ ...branches, ignore: [...branches.ignore, v] })
        }
        onRemove={(v) =>
          commitBranches({
            ...branches,
            ignore: branches.ignore.filter((x) => x !== v),
          })
        }
      />
    </div>
  );
}

function WorkflowTriggersSection({
  doc,
  workflowName,
  mutate,
}: {
  doc: Document;
  workflowName: string;
  mutate: MutateFn;
}) {
  const triggersRaw = getIn(doc, ['workflows', workflowName, 'triggers']);
  const count = Array.isArray(triggersRaw) ? triggersRaw.length : 0;

  return (
    <CollapsibleSection
      id="workflow-triggers"
      title="Triggers"
      docsLink={DOCS_LINKS.workflows.triggers}
      contentCount={count}
      defaultOpen={defaultSectionOpen('workflow-triggers', count > 0)}
    >
      {Array.from({ length: count }, (_, index) => (
        <TriggerRow
          key={index}
          doc={doc}
          workflowName={workflowName}
          index={index}
          mutate={mutate}
          onRemove={() =>
            mutate((d) => removeWorkflowTrigger(d, workflowName, index))
          }
        />
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => mutate((d) => addWorkflowTrigger(d, workflowName))}
      >
        Add a schedule trigger
      </Button>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// max_auto_reruns
// ---------------------------------------------------------------------------

function MaxAutoRerunsField({
  doc,
  workflowName,
  mutate,
}: {
  doc: Document;
  workflowName: string;
  mutate: MutateFn;
}) {
  const raw = getIn(doc, ['workflows', workflowName, 'max_auto_reruns']);
  const value = typeof raw === 'number' ? raw : undefined;
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));

  const commit = () => {
    if (draft.trim() === '') {
      if (value !== undefined) {
        mutate((d) => unsetWorkflowField(d, workflowName, ['max_auto_reruns']));
      }
      return;
    }
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    if (parsed !== value) {
      mutate((d) =>
        setWorkflowField(d, workflowName, ['max_auto_reruns'], parsed),
      );
    }
  };

  return (
    <Field label="max_auto_reruns" htmlFor="workflow-max-auto-reruns">
      <input
        id="workflow-max-auto-reruns"
        type="number"
        min={1}
        max={5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        placeholder="not set"
        className={`${inputClassName} font-mono`}
      />
      <p className="mt-1 text-2xs text-cc-text-faint">
        How many times this workflow automatically reruns itself after a
        failure, 1-5. Leave blank for CircleCI&rsquo;s default (no automatic
        rerun).
      </p>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// The body itself
// ---------------------------------------------------------------------------

export function WorkflowInspectorBody({
  doc,
  workflowName,
  mutate,
}: {
  doc: Document;
  workflowName: string;
  mutate: MutateFn;
}): ReactNode {
  return (
    <>
      <div className="mb-3 flex items-center gap-1.5">
        <Badge tone="neutral">workflow</Badge>
      </div>
      <p
        className="mb-4 truncate font-mono text-sm text-cc-text"
        title={workflowName}
      >
        {workflowName}
      </p>

      <WorkflowConditionSection
        doc={doc}
        workflowName={workflowName}
        mutate={mutate}
      />
      <WorkflowTriggersSection
        doc={doc}
        workflowName={workflowName}
        mutate={mutate}
      />
      <MaxAutoRerunsField
        doc={doc}
        workflowName={workflowName}
        mutate={mutate}
      />
    </>
  );
}
