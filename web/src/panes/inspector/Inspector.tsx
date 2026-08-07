import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { Document } from 'yaml';

import {
  quietControlClassName,
  raisedControlClassName,
} from '~/design/controlAffordance';
import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { ParametersEditor } from '~/design/components/ParametersEditor';
import { ReferenceImpactList } from '~/design/components/ReferenceImpactList';
import { ResourceClassField } from '~/design/components/ResourceClassField';
import { XcodeVersionField } from '~/design/components/XcodeVersionField';
import { DOCS_LINKS, stepDocsUrl } from '~/lib/docs/docsLinks';
import type {
  GraphNode,
  WorkflowEntryFilterGroup,
  WorkflowEntryFilters,
} from '~/lib/graph/buildGraph';
import {
  resolveJobExecutor,
  type ResolvedExecutor,
} from '~/lib/graph/resolveExecutor';
import {
  getIn,
  getJobNames,
  getWorkflowJobEntries,
  getWorkflowNames,
  listKeys,
} from '~/lib/yaml/documentUtils';
import {
  addStep,
  addWorkflowEntryStep,
  addWorkflowJobEntryContext,
  BARE_STRING_STEP_KEYS,
  moveStep,
  moveWorkflowEntryStep,
  removeRequire,
  removeStep,
  removeWorkflowEntryStep,
  removeWorkflowJobEntryContext,
  renameJob,
  setExecutorField,
  setExecutorImage,
  setJobField,
  setStepField,
  setWorkflowEntryStepField,
  setWorkflowEntryStepFieldValue,
  setWorkflowJobEntryAlias,
  setWorkflowJobEntryOption,
  setWorkflowJobEntryParameter,
  unsetJobField,
  type WorkflowEntryStepsKey,
} from '~/lib/mutations/configMutations';
import {
  describeRenameImpact,
  findJobReferences,
  renameNeedsConfirmation,
} from '~/lib/mutations/jobReferences';
import {
  isDraggingOrbKind,
  readOrbDragPayload,
  type OrbDragPayload,
} from '~/lib/orbs/dragPayload';
import {
  isDraggingPaletteStep,
  readPaletteStepDragPayload,
} from '~/panes/dag/palette/paletteSteps';
import type { OrbParameter } from '~/lib/orbs/types';
import type {
  CircleciSchema,
  StepFieldSchema,
} from '~/lib/schema/circleciSchema';
import { KNOWN_STEP_KEYS } from '~/lib/schema/stepKeywords';
import { useCircleciSchema } from '~/lib/schema/useCircleciSchema';
import { buildEditorTheme } from '~/panes/yaml/editorTheme';
import { useAppStore } from '~/state/appStore';
import { useConfirmStore } from '~/state/confirmStore';
import { useProjectContextStore } from '~/state/projectContextStore';
import { useThemeStore } from '~/state/themeStore';

import { CollapsibleSection } from './CollapsibleSection';
import { ContextField } from './ContextField';
import {
  defaultSectionOpen,
  type InspectorSectionKey,
} from './inspectorSections';
import { shellSyntaxHighlighting } from './shellHighlight';
import {
  captureStepDropFrame,
  gapForPointer,
  reorderTargetForGap,
  SLOT_HEIGHT_FALLBACK,
  type StepDropFrame,
} from './stepDropFrame';
import { WorkflowInspectorBody } from './WorkflowInspector';
import {
  missingRequiredParams,
  useOrbElementParameters,
  type OrbElementParamsState,
} from './useOrbElementParameters';

/** Handles a drop of an orb command at `index` in `jobName`'s steps -- see `useOrbInsertion.dropOnSteps`. */
type OrbCommandDropHandler = (
  jobName: string,
  index: number,
  payload: OrbDragPayload,
) => void;

/** Handles a drop of a palette step (issue #71) at `index` in `jobName`'s steps -- see `usePaletteInsertion.dropStepOnSteps`. */
type PaletteStepDropHandler = (
  jobName: string,
  index: number,
  stepKey: string,
) => void;

/**
 * Issue #21's pre-steps/post-steps counterpart of `OrbCommandDropHandler`/
 * `PaletteStepDropHandler` above. A workflow entry's `pre-steps:`/
 * `post-steps:` needs `workflowName`+`nodeId`+`key` to address, not a
 * `jobName` -- the same reason `buildEntryStepsRoot` takes that triple
 * instead of a job name -- so these are their own types rather than a
 * `jobName` these call sites don't have. See `useOrbInsertion.dropOnEntrySteps`
 * / `usePaletteInsertion.dropStepOnEntrySteps`.
 */
type OrbCommandEntryDropHandler = (
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  index: number,
  payload: OrbDragPayload,
) => void;

/** The palette-step analogue of `OrbCommandEntryDropHandler`. */
type PaletteStepEntryDropHandler = (
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  index: number,
  stepKey: string,
) => void;

/**
 * `StepsSection`'s own drop-handler shape -- pre-bound to whichever list it
 * is rooted at. The job body's own `steps:` call site binds `jobName`
 * (closing over `onDropOrbCommand`/`onDropPaletteStep` above);
 * `WorkflowEntryOptionsSection`'s pre-steps/post-steps call sites bind
 * `workflowName`+`nodeId`+`key` instead (closing over
 * `onDropOrbCommandOnEntrySteps`/`onDropPaletteStepOnEntrySteps`). Binding at
 * the call site, rather than threading an address through `StepsSection`
 * itself, is what lets one component serve both without knowing which kind
 * of list it is.
 */
type StepsSectionOrbDropHandler = (
  index: number,
  payload: OrbDragPayload,
) => void;
type StepsSectionPaletteDropHandler = (index: number, stepKey: string) => void;

/** Signature every mutation call in this file goes through -- `useAppStore`'s `mutate`. */
/**
 * Exported so `WorkflowInspector.tsx` (issue #288's workflow-level editor,
 * a sibling body this pane renders in place of a job's own -- see
 * `InspectorProps.workflowSelected`) can share the exact same mutate
 * signature rather than declaring a second, structurally-identical type
 * that would drift the moment one of the two changed.
 */
export type MutateFn = (fn: (doc: Document) => void) => void;

interface InspectorProps {
  doc: Document | null;
  workflowName: string | undefined;
  /** The currently selected graph node, or `null` when nothing is selected. */
  node: GraphNode | null;
  /**
   * Whether the *workflow itself* -- not `node` -- is the thing selected
   * (issue #288). Ignored when `node` is non-null: a job selection always
   * wins the inspector body, which is `appStore`'s own mutual-exclusivity
   * guarantee (`selectNode` always clears `workflowSelected`) rendered
   * defensively here too, so this component's behaviour doesn't depend on
   * the caller upholding that invariant perfectly.
   */
  workflowSelected?: boolean;
  /** Opens the DAG pane's "remove from workflow / delete job" confirm popover for this node. */
  onRequestDelete: (nodeId: string) => void;
  /** When true, the Name field autofocuses on mount -- see `DagPane`'s "Add job" flow. */
  autoFocusName: boolean;
  /**
   * Handles a drop of an orb command onto the steps list below, at a
   * specific index -- the second of M5's two command drop targets (the
   * other being a job node in the DAG canvas, which always appends).
   * Optional purely so this component doesn't need a no-op stub in tests
   * that don't exercise drag-and-drop. Only wired up for a job's own body
   * steps; `onDropOrbCommandOnEntrySteps` below is the pre-steps/post-steps
   * counterpart.
   */
  onDropOrbCommand?: OrbCommandDropHandler;
  /**
   * Handles a drop of a palette step (issue #71) onto the steps list below,
   * at a specific index -- the inspector-side counterpart of a palette step
   * dropped on a job node in the DAG canvas (`usePaletteInsertion`'s own
   * module doc). Same optionality rationale as `onDropOrbCommand`: no-op
   * stub needed in tests that don't exercise this drag-and-drop path.
   */
  onDropPaletteStep?: PaletteStepDropHandler;
  /**
   * Issue #21: the pre-steps/post-steps counterpart of `onDropOrbCommand`.
   * Pre-steps and post-steps are rendered by the same `StepsSection` as a
   * job's own body -- reorder-by-drag and the keyboard move buttons already
   * worked there, but nothing wired a *new* command dropped in from the
   * palette/orb browser to an actual mutation, so the lists looked
   * draggable and silently refused it. See
   * `WorkflowEntryOptionsSection`, which binds this to each of pre-steps
   * and post-steps in turn.
   */
  onDropOrbCommandOnEntrySteps?: OrbCommandEntryDropHandler;
  /** The palette-step analogue of `onDropOrbCommandOnEntrySteps`. */
  onDropPaletteStepOnEntrySteps?: PaletteStepEntryDropHandler;
}

/**
 * Banner for a rejected edit. Exported so the DAG pane can render it too:
 * refusals often come from canvas actions (an invalid drop, a would-be cycle)
 * and the inspector is only mounted when a job is selected, so it cannot be
 * the only place this message can appear.
 */
export function EditErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-3 flex items-start justify-between gap-2 rounded-md border border-cc-danger/40 bg-[color-mix(in_srgb,var(--color-cc-danger)_12%,transparent)] px-3 py-2 text-xs text-cc-danger"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0 rounded px-1 text-cc-danger hover:bg-cc-danger/20"
      >
        &times;
      </button>
    </div>
  );
}

/** Exported for the same reason `inputClassName`/`TagListEditor` are -- `WorkflowInspector.tsx`'s `max_auto_reruns` field wraps the same label+input+error shape every other field in this pane already uses. */
export function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-2xs text-cc-danger">{error}</p> : null}
    </div>
  );
}

/** Exported for the same reason `MutateFn` is -- `WorkflowInspector.tsx`'s text fields (cron, `matches:` pattern/value, ...) match every other field in this pane rather than inventing their own class string. */
export const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/**
 * The `<h4>` section label every subsection of this pane already used
 * (`Executor`, `Requires`, `Context`, `Filters`, ...), factored out once
 * issue #78 gave it a second, optional job: hosting that section's own
 * `DocsLink`, in exactly the same spot, everywhere it appears. Kept as the
 * one place a section heading is rendered so a future section gets the
 * docs-link affordance for free by using this instead of a bespoke `<h4>`.
 */
function SectionHeading({
  docsLink,
  children,
}: {
  docsLink?: { label: string; url: string };
  children: ReactNode;
}) {
  // The link is a *sibling* of the `<h4>`, not nested inside it: a nested
  // `<a>` with its own `aria-label` gets folded into the heading's own
  // computed accessible name (confirmed empirically -- it turned
  // `getByRole('heading', { name: 'Context' })` from an exact match into
  // "Context Contexts (opens CircleCI docs in a new tab)"), which would
  // make every section heading in this pane announce its docs link's own
  // label as part of the section's name. Keeping them as siblings under one
  // flex row gives the identical visual result with the heading's name
  // staying exactly its own text.
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <h4 className="text-2xs font-semibold uppercase tracking-wide text-cc-text-muted">
        {children}
      </h4>
      {docsLink ? <DocsLink label={docsLink.label} url={docsLink.url} /> : null}
    </div>
  );
}

/**
 * Step kinds this module knows how to identify and label distinctly (issue
 * #28, extended by #48): `known` covers every CircleCI built-in this pane
 * has a schema-driven field editor for (`run`, `checkout`, `save_cache`,
 * ...; see `KNOWN_STEP_KEYS` below) -- `rawValue` is that step's own raw
 * value (a string for `run`'s shorthand, `undefined` for a bare top-level
 * string step like `- checkout`, otherwise the value map), which
 * `StepFieldsSection` reads directly rather than this module pre-extracting
 * individual fields, since the whole point of #48 is that *every* field a
 * step's schema defines should be editable, not just whichever ones this
 * describer happens to enumerate; an orb command (`<alias>/<command>`),
 * shown as alias + command name with its currently-set parameters listed
 * beneath; `when`/`unless`, rendered as a group around its own nested steps
 * rather than an opaque blob; `command` for a reference to a
 * locally-defined custom command (`commands:` in this same config), whose
 * currently-set parameters are editable the same generic way; a bare
 * reference to some other custom command with no params; and `unknown` for
 * anything that isn't valid step syntax at all (not a string, not a
 * single-key map) -- shown honestly rather than silently, and never
 * touched by any mutation this pane performs.
 *
 * Every map-shaped variant keeps the underlying single map key as
 * `fullKey` so callers can address this step's own parameters/fields
 * (`[...path, fullKey, paramName]`) without re-deriving it.
 */
type StepDescriptor =
  | {
      tag: 'known';
      fullKey: string;
      label: string;
      /** This step's raw value under `fullKey`: a string for `run`'s shorthand, `undefined` for a bare top-level string step, otherwise the value map (possibly with fields this pane's schema doesn't recognize -- see `StepFieldsSection`). */
      rawValue: unknown;
      /** Only set for `run`, whose scalar shorthand (`- run: "npm test"`) doubles as this field. */
      shorthandField?: string;
    }
  | {
      tag: 'orbCommand';
      fullKey: string;
      orbAlias: string;
      commandName: string;
      params: Array<[string, unknown]>;
    }
  | {
      tag: 'group';
      fullKey: 'when' | 'unless';
      condition: string;
      steps: unknown[];
    }
  | { tag: 'command'; fullKey: string; params: Array<[string, unknown]> }
  | { tag: 'bare'; name: string }
  | { tag: 'unknown'; reason: string };

/**
 * CircleCI's own step keywords this pane has a schema-driven field editor
 * for (issue #48) -- everything `internal/schema/schema.json`'s
 * `definitions.step` enumerates except `run`/`checkout`/`when`/`unless`
 * (each handled by their own branch in `describeStep`, since none of them
 * fits the "single-key map of plain fields" shape uniformly: `run`/
 * `checkout` also accept a bare-string/shorthand form, `when`/`unless` are
 * a nested-steps group, not a field form, at all). Anything map-shaped that
 * isn't one of these, isn't `run`/`checkout`/`when`/`unless`, and doesn't
 * look like `<orb-alias>/<command>` is treated as a reference to a
 * locally-defined custom command.
 */
// `KNOWN_STEP_KEYS` itself now lives in `~/lib/schema/stepKeywords.ts` --
// factored out (not just re-exported) so the palette's Steps section
// (`paletteSteps.ts`, issue #71) can import it without creating a circular
// dependency between this file and the DAG pane's palette (this file
// separately imports palette drag-payload helpers, below).

/**
 * This config's `orbs:` map as a plain alias-to-reference record.
 *
 * Only string values are kept. An `orbs:` entry can legally be an inline orb
 * *definition* (a map, for a config that declares an orb rather than importing
 * one), which has no reference to resolve and no source to fetch -- so it is
 * omitted rather than stringified into a name no registry knows.
 */
function readOrbAliases(doc: Document | null): Record<string, string> {
  const raw = doc ? getIn(doc, ['orbs']) : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const aliases: Record<string, string> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') aliases[alias] = value;
  }
  return aliases;
}

/** `store_artifacts` -> `Store artifacts`, etc. -- used when a known step has no more specific detail to show. */
function humanizeBuiltinKey(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function summarizeCondition(condition: unknown): string {
  if (typeof condition === 'string') return condition;
  if (condition === undefined) return '(no condition)';
  try {
    return JSON.stringify(condition);
  } catch {
    return String(condition);
  }
}

/** The first string-valued field among a known step's usual "main" options, for its one-line summary -- unaffected by whether the step's value is fully populated or still mostly unset. */
function builtinDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of ['path', 'destination', 'root', 'at', 'key', 'name']) {
    if (typeof v[key] === 'string') return v[key];
  }
  return null;
}

/**
 * The row label for a `known`-tagged step, exactly mirroring what the
 * pre-#48 `checkout`/`run`/`builtin` tags each computed on their own --
 * kept as one function now that a single tag covers all of them.
 */
function knownStepLabel(fullKey: string, value: unknown): string {
  if (fullKey === 'checkout') return 'checkout';
  if (fullKey === 'run') {
    if (typeof value === 'string') return value || 'run';
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const name = typeof v.name === 'string' ? v.name : undefined;
      const command = typeof v.command === 'string' ? v.command : undefined;
      return name ?? command ?? 'run';
    }
    return 'run';
  }
  return builtinDetail(value) ?? humanizeBuiltinKey(fullKey);
}

/** A step's underlying YAML shape is one of: a bare string, or a single-key map. */
function describeStep(raw: unknown): StepDescriptor {
  if (typeof raw === 'string') {
    if (raw === 'checkout' || BARE_STRING_STEP_KEYS.has(raw)) {
      return {
        tag: 'known',
        fullKey: raw,
        label: knownStepLabel(raw, undefined),
        rawValue: undefined,
      };
    }
    // A bare `- <alias>/<command>` is the *same step* as `- <alias>/<command>:
    // {...}` with no parameters set, and it is exactly what `snippets.stepEntry`
    // writes when an orb command is inserted without any. Issue #252: only the
    // map form was recognised as an orb command, so the string form fell through
    // to `bare` -- which has no parameters, therefore no details, therefore no
    // disclosure and no editing at all. That is the reported symptom ("I don't
    // get any edit ability") in one line: a command inserted with no parameters
    // could never be given any.
    if (raw.includes('/')) {
      const slash = raw.indexOf('/');
      return {
        tag: 'orbCommand',
        fullKey: raw,
        orbAlias: raw.slice(0, slash),
        commandName: raw.slice(slash + 1),
        params: [],
      };
    }
    return { tag: 'bare', name: raw };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      tag: 'unknown',
      reason:
        'This step is not valid CircleCI syntax -- expected a string or a single-key map. Shown as-is; edit the YAML directly to fix it.',
    };
  }

  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1) {
    return {
      tag: 'unknown',
      reason:
        keys.length === 0
          ? 'This step is an empty map, which is not valid CircleCI syntax. Edit the YAML directly.'
          : `This step has ${keys.length} top-level keys ("${keys.join('", "')}"), but a valid CircleCI step is always a single-key map. Shown as-is -- nothing here has been dropped; edit the YAML directly.`,
    };
  }
  const fullKey = keys[0]!;
  const value = (raw as Record<string, unknown>)[fullKey];

  if (fullKey === 'run') {
    return {
      tag: 'known',
      fullKey,
      label: knownStepLabel(fullKey, value),
      rawValue: value,
      shorthandField: 'command',
    };
  }

  if (fullKey === 'when' || fullKey === 'unless') {
    const v =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const nestedSteps = Array.isArray(v.steps) ? v.steps : [];
    return {
      tag: 'group',
      fullKey,
      condition: summarizeCondition(v.condition),
      steps: nestedSteps,
    };
  }

  if (fullKey.includes('/')) {
    const slash = fullKey.indexOf('/');
    const params: Array<[string, unknown]> =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [];
    return {
      tag: 'orbCommand',
      fullKey,
      orbAlias: fullKey.slice(0, slash),
      commandName: fullKey.slice(slash + 1),
      params,
    };
  }

  if (fullKey === 'checkout' || KNOWN_STEP_KEYS.has(fullKey)) {
    return {
      tag: 'known',
      fullKey,
      label: knownStepLabel(fullKey, value),
      rawValue: value,
    };
  }

  const params: Array<[string, unknown]> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
      : [];
  return { tag: 'command', fullKey, params };
}

/** The step-kind badge shown at the front of a row -- short by design so a long label/command can't push it wide. */
function badgeTextFor(descriptor: StepDescriptor): string {
  switch (descriptor.tag) {
    case 'known':
      return descriptor.fullKey;
    case 'orbCommand':
      return descriptor.orbAlias;
    case 'group':
      return descriptor.fullKey;
    case 'command':
      return 'command';
    case 'bare':
      return 'command';
    case 'unknown':
      return 'step';
  }
}

/** The row's main (truncatable) label. */
function labelTextFor(descriptor: StepDescriptor): string {
  switch (descriptor.tag) {
    case 'known':
      return descriptor.label;
    case 'orbCommand':
      return descriptor.commandName;
    case 'group':
      return descriptor.condition;
    case 'command':
      return descriptor.fullKey;
    case 'bare':
      return descriptor.name;
    case 'unknown':
      return '(unrecognized)';
  }
}

/** The parameters to list (collapsed by default) beneath the row, if any -- `known` steps get their own schema-driven `StepFieldsSection` instead (issue #48), not this generic list. */
function paramsFor(descriptor: StepDescriptor): Array<[string, unknown]> {
  return descriptor.tag === 'orbCommand' || descriptor.tag === 'command'
    ? descriptor.params
    : [];
}

/**
 * One editable parameter value. A boolean renders as a checkbox (committed
 * immediately); an enum (`enumValues` given) as a `<select>`; a string or
 * number as a text field (committed on blur, same pattern as the rest of
 * this file's fields); anything else (a list, a nested map, `null`) is
 * shown read-only -- editing structured parameter values is out of scope
 * here, but seeing them beats hiding them.
 */
function ParamField({
  label,
  value,
  enumValues,
  onCommit,
}: {
  label: string;
  value: unknown;
  /** When given, renders a `<select>` over these values instead of a free-text input (an orb/job `enum` parameter). */
  enumValues?: string[];
  onCommit: (next: string | number | boolean) => void;
}) {
  const fieldId = useId();
  const isEditableScalar =
    typeof value === 'string' || typeof value === 'number';
  const [draft, setDraft] = useState(isEditableScalar ? String(value) : '');

  if (typeof value === 'boolean') {
    return (
      <label className="flex min-w-0 items-center gap-1.5 text-2xs text-cc-text">
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => onCommit(event.target.checked)}
          className="h-3.5 w-3.5 shrink-0 accent-cc-accent"
        />
        <span className="min-w-0 truncate font-mono" title={label}>
          {label}
        </span>
      </label>
    );
  }

  if (enumValues && enumValues.length > 0 && typeof value === 'string') {
    return (
      <div className="min-w-0">
        <label
          htmlFor={fieldId}
          className="mb-0.5 block truncate font-mono text-2xs text-cc-text-faint"
          title={label}
        >
          {label}
        </label>
        <select
          id={fieldId}
          value={value}
          onChange={(event) => onCommit(event.target.value)}
          className={`${inputClassName} font-mono`}
        >
          {/* Only shown when the field is genuinely unset (issue #48's
              per-step-type editors seed an optional enum field with `''`
              rather than fabricating a value it was never written with) --
              every pre-existing caller of this component always passes a
              real value (an orb/job parameter's own default), so this
              option never appears for them. */}
          {value === '' ? <option value="">Not set</option> : null}
          {enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (isEditableScalar) {
    const commit = () => {
      if (typeof value === 'number') {
        const parsed = Number(draft);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setDraft(String(value));
        return;
      }
      if (draft !== value) onCommit(draft);
    };
    return (
      <div className="min-w-0">
        <label
          htmlFor={fieldId}
          className="mb-0.5 block truncate font-mono text-2xs text-cc-text-faint"
          title={label}
        >
          {label}
        </label>
        <input
          id={fieldId}
          type={typeof value === 'number' ? 'number' : 'text'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className={`${inputClassName} font-mono`}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p
        className="mb-0.5 truncate font-mono text-2xs text-cc-text-faint"
        title={label}
      >
        {label}
      </p>
      <p
        className="truncate rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1 text-2xs text-cc-text-muted"
        title={JSON.stringify(value)}
      >
        {value === null || value === undefined ? '—' : JSON.stringify(value)}
      </p>
    </div>
  );
}

/**
 * Everything a step list needs to mutate itself, abstracted away from
 * *where* that list actually lives in the document. `jobs.<name>.steps`
 * (a job's own body) and a workflow entry's `pre-steps:`/`post-steps:`
 * (issue #37) are both just "a list of steps you can add to/remove
 * from/reorder/edit the parameters of" -- this is what lets `StepsSection`/
 * `StepRow`/`ParamsEditor` below be written once and rooted at either.
 */
interface StepsRoot {
  steps: unknown[];
  add: (step: unknown) => void;
  remove: (index: number) => void;
  move: (fromIndex: number, toIndex: number) => void;
  /** `path` is relative to the steps array itself, e.g. `[index, fullKey, paramName]`. */
  setField: (path: (string | number)[], value: unknown) => void;
  /**
   * Sets (or, `value === undefined`, removes) one top-level field of the
   * step at `relPath` -- relative to this root's own steps array, same
   * convention as `StepRow`'s own `pathPrefix` (`[index]` at top level,
   * `[index, 'when', 'steps', nestedIndex]` inside a group) -- converting
   * between that step's bare-string/shorthand and single-key-map shapes as
   * needed (issue #48; see `configMutations.setStepField`). `shorthandField`
   * only applies to `run`.
   */
  setStepField: (
    relPath: (string | number)[],
    stepKey: string,
    fieldName: string,
    value: unknown,
    shorthandField?: string,
  ) => void;
}

/** A `StepsRoot` over a job's own `steps:`. */
function buildJobStepsRoot(
  doc: Document,
  jobName: string,
  mutate: MutateFn,
): StepsRoot {
  const stepsRaw = getIn(doc, ['jobs', jobName, 'steps']);
  const steps = Array.isArray(stepsRaw) ? stepsRaw : [];
  return {
    steps,
    add: (step) => mutate((d) => addStep(d, jobName, step)),
    remove: (index) => mutate((d) => removeStep(d, jobName, index)),
    move: (fromIndex, toIndex) =>
      mutate((d) => moveStep(d, jobName, fromIndex, toIndex)),
    setField: (path, value) =>
      mutate((d) => setJobField(d, jobName, path, value)),
    setStepField: (relPath, stepKey, fieldName, value, shorthandField) =>
      mutate((d) =>
        setStepField(
          d,
          ['jobs', jobName, 'steps', ...relPath],
          stepKey,
          fieldName,
          value,
          shorthandField,
        ),
      ),
  };
}

/** A `StepsRoot` over one workflow entry's `pre-steps:`/`post-steps:` (issue #37). */
function buildEntryStepsRoot(
  workflowName: string,
  nodeId: string,
  key: WorkflowEntryStepsKey,
  steps: unknown[],
  mutate: MutateFn,
): StepsRoot {
  return {
    steps,
    add: (step) =>
      mutate((d) => addWorkflowEntryStep(d, workflowName, nodeId, key, step)),
    remove: (index) =>
      mutate((d) =>
        removeWorkflowEntryStep(d, workflowName, nodeId, key, index),
      ),
    move: (fromIndex, toIndex) =>
      mutate((d) =>
        moveWorkflowEntryStep(d, workflowName, nodeId, key, fromIndex, toIndex),
      ),
    setField: (path, value) =>
      mutate((d) =>
        setWorkflowEntryStepField(d, workflowName, nodeId, key, path, value),
      ),
    setStepField: (relPath, stepKey, fieldName, value, shorthandField) =>
      mutate((d) =>
        setWorkflowEntryStepFieldValue(
          d,
          workflowName,
          nodeId,
          key,
          relPath,
          stepKey,
          fieldName,
          value,
          shorthandField,
        ),
      ),
  };
}

/**
 * One `run.command`, edited as a small CodeMirror instance rather than a
 * plain `<textarea>` -- a shell command is code, and the app already ships
 * CodeMirror 6 for the YAML pane itself (`YamlPane.tsx`), so reaching for a
 * plain textarea here would be a visible downgrade for exactly the field
 * issue #48 calls out as needing multiline editing.
 *
 * Issue #86: this used to render CodeMirror's default *light* theme
 * unconditionally (no `theme="none"`, no chrome extension at all), which in
 * dark mode painted an invisible white-on-white editor -- this app's own
 * dark-mode `--color-cc-text` cascaded onto `.cm-content`'s inherited
 * colour, on top of that default theme's own white `.cm-content`
 * background, and nothing here ever overrode either half. Fixed by sharing
 * `../yaml/editorTheme.ts`'s `buildEditorTheme` (the same chrome
 * `YamlPane.tsx` already uses, extracted there for exactly this reuse)
 * instead of writing a second one, plus real shell syntax highlighting and
 * line numbers (`./shellHighlight.ts` -- see its own module comment for why
 * a stream-tokenizer-backed language, not a textarea-with-colours hack, and
 * for the bundle-cost accounting). `basicSetup.syntaxHighlighting: false`
 * for the same documented reason `YamlPane.tsx` turns it off: this field
 * supplies its own `Decoration`-based highlighter, and letting `basicSetup`
 * install its default one alongside it is the precedence trap
 * `yamlHighlight.ts` warns about, not a hypothetical one.
 */
function CommandField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const fieldId = useId();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      buildEditorTheme(resolvedTheme),
      ...shellSyntaxHighlighting(resolvedTheme),
    ],
    [resolvedTheme],
  );

  return (
    <div
      className="min-w-0"
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    >
      <label
        id={fieldId}
        className="mb-0.5 block truncate font-mono text-2xs text-cc-text-faint"
        title={label}
      >
        {label}
      </label>
      <div className="overflow-hidden rounded-md border border-cc-border-interactive">
        <CodeMirror
          value={draft}
          onChange={setDraft}
          theme="none"
          minHeight="4.5rem"
          extensions={extensions}
          aria-label={label}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            autocompletion: false,
            // See this component's own doc comment: this field supplies its
            // own syntax-highlighting decorations via `shellSyntaxHighlighting`
            // above, so `basicSetup`'s default highlighter must stay off.
            syntaxHighlighting: false,
          }}
          style={{ fontSize: '12px' }}
        />
      </div>
    </div>
  );
}

/** One editable array-of-strings field (`save_cache.paths`, `restore_cache.keys`, `persist_to_workspace.paths`, `add_ssh_keys.fingerprints`, ...) -- a thin `TagListEditor` wrapper so it can be selected alongside every other field-type widget in `StepFieldsSection` by `StepFieldSchema.type` alone. */
function ArrayField({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <TagListEditor
      label={label}
      values={values}
      placeholder="value"
      onAdd={(v) => onChange([...values, v])}
      onRemove={(v) => onChange(values.filter((x) => x !== v))}
    />
  );
}

/**
 * One editable key/value-pairs field -- so far only `run.environment`.
 * Mirrors `TagListEditor`'s pill-list look, but for `name=value` pairs
 * rather than bare strings; like `FiltersSection`/`ContextSection`
 * elsewhere in this file, every add/remove rewrites the whole map rather
 * than touching one entry's live node in place -- the same "whole
 * structured sub-field is one value" convention this pane already uses for
 * every other multi-part field, not a new one introduced for this.
 */
function EnvironmentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [keyDraft, setKeyDraft] = useState('');
  const [valueDraft, setValueDraft] = useState('');
  const entries = Object.entries(value);
  const keyId = useId();
  const valueId = useId();

  const commitAdd = useCallback(() => {
    const trimmedKey = keyDraft.trim();
    if (!trimmedKey) return;
    onChange({ ...value, [trimmedKey]: valueDraft });
    setKeyDraft('');
    setValueDraft('');
  }, [keyDraft, onChange, value, valueDraft]);

  return (
    <div className="mb-2">
      <p className="mb-1 block text-2xs font-medium text-cc-text-muted">
        {label}
      </p>
      {entries.length > 0 ? (
        <ul className="mb-1.5 space-y-1">
          {entries.map(([key, v]) => (
            <li
              key={key}
              className="flex items-center gap-1.5 rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1 text-2xs font-mono text-cc-text"
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={`${key}=${String(v)}`}
              >
                {key}={String(v)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${key}`}
                onClick={() => {
                  const next = { ...value };
                  delete next[key];
                  onChange(next);
                }}
                className="shrink-0 rounded px-1 text-cc-text-muted hover:bg-cc-danger/20 hover:text-cc-danger"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-1.5">
        <label htmlFor={keyId} className="sr-only">
          {label} variable name
        </label>
        <input
          id={keyId}
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="NAME"
          className={`${inputClassName} font-mono`}
        />
        <label htmlFor={valueId} className="sr-only">
          {label} value
        </label>
        <input
          id={valueId}
          value={valueDraft}
          onChange={(event) => setValueDraft(event.target.value)}
          placeholder="value"
          className={`${inputClassName} font-mono`}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={commitAdd}
          disabled={!keyDraft.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * One `run`/`checkout`/`save_cache`/etc. step's own editable fields, driven
 * by `fieldSchemas` (`stepFieldSchemas[fullKey]` from the vendored JSON
 * Schema -- issue #48) rather than a hand-maintained per-keyword form, so
 * every field CircleCI itself accepts is offered, not just whichever ones
 * happen to already be set. `rawValue`/`shorthandField` come straight off
 * the step's `StepDescriptor` (see its own doc comment): a bare-string step
 * (`rawValue === undefined`) or `run`'s scalar shorthand shows every field
 * as unset except `shorthandField` (seeded from the shorthand string
 * itself) -- setting *any* field is what promotes the step to full map
 * form (`configMutations.setStepField`), never merely expanding this
 * section to look at it.
 *
 * Any key present on the step's own raw value that isn't in `fieldSchemas`
 * -- a schema version skew, or a field this extractor doesn't yet cover --
 * is still shown and still editable, via the same generic `ParamField` the
 * rest of this pane already uses for parameters it has no dedicated widget
 * for (issue #48 requirement: never hide or drop a value this pane doesn't
 * have a form for).
 */
function StepFieldsSection({
  fullKey,
  rawValue,
  shorthandField,
  fieldSchemas,
  schemaLoaded,
  onSetField,
}: {
  fullKey: string;
  rawValue: unknown;
  shorthandField?: string;
  fieldSchemas: StepFieldSchema[];
  /** `false` while `/api/schema` is still being fetched (see `useCircleciSchema`) -- distinguishes "nothing to show yet" from "this keyword genuinely has no schema-known fields" (e.g. the legacy `deploy` step, absent from the schema entirely). */
  schemaLoaded: boolean;
  onSetField: (fieldName: string, value: unknown) => void;
}) {
  const values: Record<string, unknown> =
    rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
      ? (rawValue as Record<string, unknown>)
      : {};
  if (shorthandField !== undefined && typeof rawValue === 'string') {
    // `values` is a fresh `{}` in this branch (the ternary above only
    // reuses `rawValue` itself when it's already an object) -- safe to
    // seed in place, this never touches the live document.
    values[shorthandField] = rawValue;
  }

  const knownNames = new Set(fieldSchemas.map((field) => field.name));
  const extraEntries = Object.entries(values).filter(
    ([key]) => !knownNames.has(key),
  );
  // Issue #78: "the schema already gives us the keyword, so the mapping to
  // a docs anchor is mechanical" -- `undefined` for a custom/orb command,
  // which has no CircleCI-authored docs page to point at.
  const docsUrl = stepDocsUrl(fullKey);

  if (!schemaLoaded) {
    return (
      <p className="flex items-center justify-between gap-2 border-t border-cc-border px-2 py-1.5 pl-6 text-2xs text-cc-text-faint">
        Loading fields&hellip;
        {docsUrl ? (
          <DocsLink label={`"${fullKey}" step reference`} url={docsUrl} />
        ) : null}
      </p>
    );
  }
  if (fieldSchemas.length === 0 && extraEntries.length === 0) {
    return (
      <p className="flex items-center justify-between gap-2 border-t border-cc-border px-2 py-1.5 pl-6 text-2xs text-cc-text-faint">
        <span>
          This pane doesn&rsquo;t recognize any fields for &ldquo;{fullKey}
          &rdquo; -- edit the YAML directly.
        </span>
        {docsUrl ? (
          <DocsLink label={`"${fullKey}" step reference`} url={docsUrl} />
        ) : null}
      </p>
    );
  }

  const commitOptional = (field: StepFieldSchema, next: string) => {
    onSetField(field.name, next === '' && !field.required ? undefined : next);
  };

  return (
    <div className="space-y-1.5 border-t border-cc-border px-2 py-1.5 pl-6">
      {docsUrl ? (
        <div className="flex justify-end">
          <DocsLink label={`"${fullKey}" step reference`} url={docsUrl} />
        </div>
      ) : null}
      {fieldSchemas.map((field) => {
        const current = values[field.name];

        if (field.type === 'array') {
          const arr = Array.isArray(current)
            ? current.filter((v): v is string => typeof v === 'string')
            : [];
          return (
            <ArrayField
              key={field.name}
              label={field.name}
              values={arr}
              onChange={(next) =>
                onSetField(field.name, next.length > 0 ? next : undefined)
              }
            />
          );
        }

        if (field.type === 'map') {
          const map =
            current && typeof current === 'object' && !Array.isArray(current)
              ? (current as Record<string, unknown>)
              : {};
          return (
            <EnvironmentField
              key={field.name}
              label={field.name}
              value={map}
              onChange={(next) =>
                onSetField(
                  field.name,
                  Object.keys(next).length > 0 ? next : undefined,
                )
              }
            />
          );
        }

        if (fullKey === 'run' && field.name === 'command') {
          return (
            <CommandField
              key={field.name}
              label={field.name}
              value={typeof current === 'string' ? current : ''}
              onCommit={(next) => commitOptional(field, next)}
            />
          );
        }

        if (field.type === 'boolean') {
          return (
            <ParamField
              key={field.name}
              label={field.name}
              value={typeof current === 'boolean' ? current : false}
              onCommit={(next) =>
                onSetField(field.name, next === true ? true : undefined)
              }
            />
          );
        }

        // string / enum / integer -- `ParamField` already renders the
        // right control (a `<select>` for `enumValues`, `type="number"`
        // for an already-numeric value, text otherwise) and treats `''` as
        // "not written yet" as long as this section only ever calls it
        // with an actual string/number, never `undefined`.
        return (
          <ParamField
            key={field.name}
            label={field.name}
            value={current ?? ''}
            enumValues={field.enumValues}
            onCommit={(next) => commitOptional(field, String(next))}
          />
        );
      })}

      {extraEntries.length > 0 ? (
        <div className="space-y-1.5 border-t border-cc-border pt-1.5">
          <p className="text-2xs text-cc-text-faint">
            {fieldSchemas.length > 0
              ? `Other field${extraEntries.length > 1 ? 's' : ''} this pane doesn't have a form for -- shown as raw values, never dropped:`
              : `This pane doesn't recognize "${fullKey}"'s fields -- shown as raw values, never dropped:`}
          </p>
          {extraEntries.map(([key, value]) => (
            <ParamField
              key={key}
              label={key}
              value={value}
              onCommit={(next) => onSetField(key, next)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The expanded parameter list for one custom-command step, editable via `root.setField`. */
function ParamsEditor({
  paramsPath,
  params,
  root,
}: {
  paramsPath: (string | number)[];
  params: Array<[string, unknown]>;
  root: StepsRoot;
}) {
  return (
    <div className="space-y-1.5 border-t border-cc-border px-2 py-1.5 pl-6">
      {params.map(([key, value]) => (
        <ParamField
          key={key}
          label={key}
          value={value}
          onCommit={(next) => root.setField([...paramsPath, key], next)}
        />
      ))}
    </div>
  );
}

/**
 * One declared-but-unset orb-command parameter: what it is, and one click to
 * start setting it.
 *
 * Why a button rather than an editable field seeded with the parameter's
 * default, which is what `InvocationParamsSection` does for an orb *job*: a
 * seeded field cannot say whether the value shown is written in the config or
 * merely what the orb would do anyway, and for a *required* parameter that
 * distinction is the entire point — required means there is no default, so a
 * field showing `0` or an empty box would be showing a value that does not
 * exist. It is also the only shape that works for every parameter type:
 * `ParamField` commits a number only when it *differs* from what is displayed,
 * so a required `integer` seeded with `0` could never be committed as `0` at
 * all, and a `boolean` seeded with `false` could never be committed as `false`.
 * One click writes the key, after which it edits like any other.
 */
function UnsetParamRow({
  param,
  onSet,
}: {
  param: OrbParameter;
  onSet: () => void;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-0.5 flex min-w-0 items-baseline gap-1">
        <span
          className="min-w-0 truncate font-mono text-2xs text-cc-text-faint"
          title={param.name}
        >
          {param.name}
        </span>
        {param.required ? (
          <span className="shrink-0 text-2xs text-cc-danger">required</span>
        ) : null}
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={`min-w-0 flex-1 truncate text-2xs ${
            param.required ? 'text-cc-danger' : 'text-cc-text-muted'
          }`}
        >
          {param.required
            ? 'Not set — this step is incomplete until it is.'
            : `Not set${
                param.default === undefined
                  ? ''
                  : ` — the orb's default (${JSON.stringify(param.default)}) applies`
              }.`}
        </span>
        {/* Named per parameter, not just "Set": several of these can be on
            screen at once (a 42-parameter orb job is the case that prompted
            #252), and a column of identically-labelled buttons is unusable
            from a screen reader and ambiguous from anywhere. */}
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Set ${param.name}`}
          onClick={onSet}
        >
          Set
        </Button>
      </div>
    </div>
  );
}

/**
 * The expanded parameter editor for an orb-command step, driven by the orb's own
 * declared parameters rather than only by whatever the step already happens to
 * set (issue #252).
 *
 * The pre-#252 editor could only edit keys already present in the config, which
 * meant the common case — a command inserted with no parameters, or with only its
 * required ones — offered no way to reach anything else, and a command written as
 * a bare string offered no editor at all. The orb source is already fetched and
 * parsed for the orb browser (#89/#128); this reuses it, so a call site lists the
 * same parameters the browser does.
 *
 * Two rules about what is shown:
 *
 *  - **Every declared parameter is listed, in declaration order**, set or not, so
 *    "what can I pass here" is answerable without leaving the pane.
 *  - **Nothing already written is ever hidden.** A key set in the config that the
 *    orb does not declare stays editable, and is labelled as undeclared rather
 *    than dropped — the orb may be pinned to a version that has since renamed it,
 *    and silently omitting it would make this pane a worse view of the file than
 *    the file.
 *
 * When the orb's source cannot be resolved (no token, an alias this config does
 * not import, a command the pinned version does not have), this degrades to the
 * old set-keys-only editor plus the reason. It never claims a command has no
 * parameters because the lookup failed.
 */
function OrbCommandParamsEditor({
  descriptor,
  pathPrefix,
  root,
  paramsState,
}: {
  descriptor: Extract<StepDescriptor, { tag: 'orbCommand' }>;
  pathPrefix: (string | number)[];
  root: StepsRoot;
  paramsState: OrbElementParamsState;
}) {
  const setValues = new Map(descriptor.params);
  const commit = (name: string, value: unknown) =>
    root.setStepField(pathPrefix, descriptor.fullKey, name, value);

  const declared = paramsState.status === 'ready' ? paramsState.params : [];
  const declaredNames = new Set(declared.map((param) => param.name));
  const undeclared = descriptor.params.filter(
    ([key]) => !declaredNames.has(key),
  );

  return (
    <div className="space-y-2 border-t border-cc-border px-2 py-1.5 pl-6">
      {paramsState.status === 'loading' ? (
        <p className="text-2xs text-cc-text-faint">
          Loading this command&rsquo;s parameters from the orb&hellip;
        </p>
      ) : null}

      {paramsState.status === 'unavailable' ? (
        <p className="text-2xs text-cc-text-muted">
          {paramsState.message} Only the parameters this step already sets can
          be edited here.
        </p>
      ) : null}

      {declared.map((param) =>
        setValues.has(param.name) ? (
          <ParamField
            key={param.name}
            label={param.required ? `${param.name} (required)` : param.name}
            value={setValues.get(param.name)}
            enumValues={param.enumValues}
            onCommit={(next) => commit(param.name, next)}
          />
        ) : (
          <UnsetParamRow
            key={param.name}
            param={param}
            onSet={() =>
              commit(
                param.name,
                param.default ??
                  emptyValueForType(param.type, param.enumValues),
              )
            }
          />
        ),
      )}

      {undeclared.length > 0 ? (
        <>
          {paramsState.status === 'ready' ? (
            <p className="text-2xs text-cc-text-faint">
              Set here but not declared by this version of the orb:
            </p>
          ) : null}
          {undeclared.map(([key, value]) => (
            <ParamField
              key={key}
              label={key}
              value={value}
              onCommit={(next) => commit(key, next)}
            />
          ))}
        </>
      ) : null}

      {paramsState.status === 'ready' &&
      declared.length === 0 &&
      undeclared.length === 0 ? (
        <p className="text-2xs text-cc-text-muted">
          This command declares no parameters.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The gap that opens in the step list where the dragged thing will land
 * (issue #249 part 1) -- a real `<li>` in the flow, so the rows below it are
 * displaced and you can see them move out of the way.
 *
 * This replaces #218's 2px `StepInsertionLine`, on the owner's verdict that a
 * marker is not enough: *"As I'm clicking and dragging, you can see the elements
 * kind of move out of the way, so you actually understand where you're putting
 * it in between... Right now I click and drag, and yes I see a little plus
 * button indicating I can drop there, but it doesn't really show me where I'm
 * actually putting it in the list."* The difference is "you may drop here"
 * versus "here is what you will get".
 *
 * #218 had a reason for keeping its line *out* of the flow -- displacing the
 * rows moves the row under the pointer out from under it and the target
 * oscillates between two gaps. `stepDropFrame.ts` is the answer to that, and its
 * module comment is the place it is explained: the gap index is a pure function
 * of the pointer against geometry frozen before anything moved, so displacement
 * is not an input and cannot feed back. Nothing here needs to be careful about
 * it.
 *
 * `pointer-events-none` so the slot can never become a `dragleave` source of
 * its own; the region below handles every drag event for this list anyway.
 *
 * `aria-hidden`, and no live region announcing the landing index: this is a
 * pointer-only affordance, and the accessible path to reordering is the row's
 * own Move up/Move down buttons (which is #249 part 2's reason for keeping
 * them). Announcing a drag no keyboard user can start would be noise.
 */
function StepDropSlot({ height }: { height: number }) {
  return (
    <li
      aria-hidden="true"
      data-testid="step-drop-slot"
      style={{ height }}
      className="pointer-events-none rounded-md border border-dashed border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)]"
    />
  );
}

/**
 * One of the row's two reorder arrows. Issue #249 part 2: *"the arrows -- I
 * think just colour it up a little bit more"*, reversing an earlier plan to
 * retire them once drag was obvious. They stay because they are the only
 * always-visible sign that a step can be reordered at all; drag is discoverable
 * from a grab cursor and a tooltip, which is to say barely.
 *
 * The treatment is `raisedControlClassName` -- see that constant for why the
 * pane-header look #217 landed on could not be copied literally onto a raised
 * row. Three things about the shape:
 *
 * - **Two separately-bordered buttons, side by side**, which is what that pane
 *   header is: `Move` and `Collapse` are two adjacent `chromeControlClassName`
 *   buttons in one row. Making this a single segmented pill would have been a
 *   *different* control from the one #249 points at as the reference.
 * - **`gap-0.5` between them, inside the row's own `gap-1.5`**, so the pair
 *   reads as one unit and stays visibly separate from Remove. #249 is explicit
 *   that the arrows "must not ... crowd the row", and this row already holds a
 *   chevron, a keyword badge, a label and Remove in 280px.
 * - **`size-4` (16px), exactly the row's own 1rem line box**, so the arrows gain
 *   a boundary and real contrast *without making any row taller*. #218 shrank
 *   these rows deliberately -- this list is one of the two scroll regions this
 *   inspector still has -- and #249 says not to regress step row type size here.
 *
 * The glyphs stay text (`&uarr;`/`&darr;`), not icons: `DocsLink` records that
 * this app has no icon-asset convention and that introducing one for a single
 * feature would be a second visual language. `font-semibold` is what gives them
 * weight instead.
 */
const stepArrowClassName = `${raisedControlClassName} inline-flex size-4 shrink-0 items-center justify-center text-2xs font-semibold leading-none disabled:opacity-60`;

/** Everything a top-level step row needs for reordering (arrows, keyboard and drag) and removal -- absent for nested (`when`/`unless`) steps, which aren't addressable by the index-based mutation helpers. */
interface StepRowControls {
  index: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  /** True while this row is the one being dragged, so it can be dimmed. */
  isDragging: boolean;
}

/**
 * One step row. Renders itself recursively for a `when`/`unless` group's
 * nested steps (with `controls` omitted, since move/remove only address a
 * root's top-level steps list), so a conditional group shows its contents
 * inline instead of as an opaque blob.
 *
 * `min-w-0`/`truncate` on the badge and label -- not just `flex-1` on the
 * label -- is the actual fix for issue #28: a `shrink-0` flex child with no
 * width cap (the old kind label) can grow to its full text width and push
 * the fixed-width reorder/remove controls out of the row entirely, which
 * for a long orb command name shoved them past the inspector's right edge.
 */
function StepRow({
  raw,
  pathPrefix,
  pathKey,
  root,
  schema,
  orbAliases,
  expandedKeys,
  onToggleExpand,
  controls,
}: {
  raw: unknown;
  /** Path to this step's own array slot from the root's steps array, e.g. `[2]` or `[2, 'when', 'steps', 0]`. */
  pathPrefix: (string | number)[];
  /** Stable string key for this row's expand/collapse state -- mirrors `pathPrefix` but as a plain string usable in a `Set`. */
  pathKey: string;
  root: StepsRoot;
  /** `null` while `/api/schema` is still loading -- see `useCircleciSchema`; passed through to `StepFieldsSection` for a `known` step. */
  schema: CircleciSchema | null;
  /** This config's `orbs:` map, alias to reference -- what turns an `<alias>/<command>` step into a resolvable orb element (issue #252). */
  orbAliases: Record<string, string>;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  controls?: StepRowControls;
}) {
  const descriptor = describeStep(raw);
  const expanded = expandedKeys.has(pathKey);
  const params = paramsFor(descriptor);

  // Called unconditionally, with empty arguments for every step that isn't an
  // orb command -- see `useOrbElementParameters`, which settles into `'idle'`
  // and fetches nothing for those. A step row cannot know whether it is an orb
  // command until `describeStep` has run, so a conditional hook is not an
  // option here.
  const isOrbCommand = descriptor.tag === 'orbCommand';
  const orbAlias = isOrbCommand ? descriptor.orbAlias : '';
  const orbCommandName = isOrbCommand ? descriptor.commandName : '';
  const orbParams = useOrbElementParameters(
    orbAlias,
    orbAliases[orbAlias] ?? '',
    orbCommandName,
    'command',
  );

  const setParamNames = useMemo(
    () => new Set(params.map(([key]) => key)),
    [params],
  );
  // A required parameter with no value is an invalid config, so the row says so
  // rather than looking like any other step (issue #252). This is the flag half
  // of "prompt at drop time or flag the step until set" -- `useOrbInsertion`
  // already prompts on insertion, but nothing prompted for a command that
  // arrived by hand-editing the YAML, or whose orb later added a required
  // parameter to a version this config is now pinned to.
  const missingRequired =
    orbParams.status === 'ready'
      ? missingRequiredParams(orbParams.params, setParamNames)
      : [];

  // An orb command is always expandable now, even with nothing set: its
  // parameters come from the orb rather than from the step, so "this step sets
  // nothing" is no longer the same claim as "there is nothing to set".
  const hasDetails =
    descriptor.tag === 'group' ||
    descriptor.tag === 'known' ||
    descriptor.tag === 'unknown' ||
    isOrbCommand ||
    params.length > 0;
  const badge = badgeTextFor(descriptor);
  const label = labelTextFor(descriptor);
  const paramsFullKey =
    descriptor.tag === 'command' ? descriptor.fullKey : null;

  return (
    <li
      // Issue #249: the `dragover`/`dragleave`/`drop` handlers this row used to
      // carry are gone, replaced by one region handler around the whole list --
      // see `StepsSection`'s `onRegionDragOver`. `dragstart`/`dragend` stay here
      // because they are about *this* row being picked up.
      data-step-row={controls ? '' : undefined}
      draggable={Boolean(controls)}
      onDragStart={controls?.onDragStart}
      onDragEnd={controls?.onDragEnd}
      // Issue #218's keyboard equivalent for drag-reordering. Attached to the
      // row but *without* `tabIndex`, so it adds no tab stop of its own: the
      // handler still fires for a key pressed while focus is on any control
      // inside the row (the disclosure chevron, the move arrows, Remove),
      // which is exactly the ergonomics wanted -- tab to a step, Alt+Arrow to
      // move it -- while a `tabIndex` here would insert an extra stop per
      // step in front of every one of those controls.
      onKeyDown={
        controls
          ? (event) => {
              if (!event.altKey || event.metaKey || event.ctrlKey) return;
              if (event.key === 'ArrowUp' && !controls.moveUpDisabled) {
                event.preventDefault();
                controls.onMoveUp();
              } else if (
                event.key === 'ArrowDown' &&
                !controls.moveDownDisabled
              ) {
                event.preventDefault();
                controls.onMoveDown();
              }
            }
          : undefined
      }
      className={`relative min-w-0 rounded-md border border-cc-border-interactive bg-cc-panel-raised ${
        controls ? 'cursor-grab active:cursor-grabbing' : ''
      } ${controls?.isDragging ? 'opacity-50' : ''}`}
      title={
        controls
          ? 'Drag to reorder (or Alt+Up/Alt+Down), or drop a step here to insert it at that point'
          : undefined
      }
    >
      {/*
        Issue #87 part 2: the chevron used to be the *only* disclosure
        target -- clicking anywhere else on the row (the badge, the label,
        empty space) did nothing, which read as broken since the row looks
        clickable. Now the whole row toggles expand/collapse; the chevron
        button below still does too, but calls `stopPropagation` so this
        `onClick` doesn't *also* fire and cancel it back out via a second
        toggle. The reorder/remove buttons stop propagation for the same
        reason, but in their case specifically so clicking them performs
        their own action *instead of* toggling the row -- per the issue,
        "stopPropagation on those, not on the row".
      */}
      <div
        className={`flex min-w-0 items-center gap-1.5 px-2 py-1 ${hasDetails ? 'cursor-pointer' : ''}`}
        onClick={hasDetails ? () => onToggleExpand(pathKey) : undefined}
      >
        {hasDetails ? (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label || badge}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(pathKey);
            }}
            // Sized like the reorder arrows (`stepArrowClassName`), and 11px for
            // the same reason the badge beside it is: an unsized glyph here
            // inherited the document's 16px, whose ~24px line box -- not
            // anything else in the row -- was what made every expandable step
            // row 34px tall. It stays *quiet*, though, with no resting boundary:
            // it is the disclosure, not the control #249 asked to promote.
            className={`${quietControlClassName} inline-flex size-4 shrink-0 items-center justify-center text-2xs leading-none text-cc-text-muted`}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        {/* No `title` here: for `checkout` (and other kinds where the badge repeats the
            label) it would collide with the label span's own `title` below. The badge is
            short by construction (an orb alias, or one of a small fixed set of keywords),
            so `truncate` is a defensive cap, not something that needs its own tooltip.

            `text-2xs` is issue #218 part 1 -- the reported "really giant text lettering
            ... says the checkout step in giant letters 'checkout', and gets cut off".
            `.vce-dag-kind-label` (styles.css) sets colour, uppercase and letter-spacing
            but deliberately *no* font-size, because its other two call sites in
            `JobNode.tsx` each pair it with `text-2xs` explicitly. This one didn't, so the
            badge inherited the document's own 16px -- `text-base`, the top of the app's
            12/14/16/20/24 scale (styles.css's `@theme` comment) and body-copy size -- for
            what is a meta badge sitting next to an 11px label in the same row. Measured on
            the real running app before this change: `getComputedStyle(badge).fontSize ===
            '16px'`, `checkout` rendering 93px wide inside a `max-w-[40%]` cap of ~104px in
            a 280px inspector, i.e. one keyword away from truncating and already truncating
            for the longer ones (`persist_to_workspace`, `setup_remote_docker`).

            11px, not the DAG node's 14px: 14px is the DAG node's *primary label* (a job's name,
            the most important text on that canvas), and the counterpart of that here is
            this row's own label span below -- also 11px, and unchanged. This span is the
            counterpart of `JobNode`'s trailing kind badges, which are `text-2xs`. So this
            matches the same element in the same role, and it makes rows shorter rather
            than taller, which matters because this list is one of the two scroll regions
            this inspector still has. */}
        <span className="vce-dag-kind-label max-w-[40%] shrink truncate text-2xs">
          {badge}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-2xs text-cc-text"
          title={label || badge}
        >
          {label}
        </span>
        {/* `shrink`/`truncate`/`min-w-0` for the same reason every other child
            of this row has them (issue #28): a fixed-width sibling with no cap
            can push the reorder/remove controls past the inspector's right
            edge. This one only ever appears in the broken case, but "rare" is
            not "never". */}
        {missingRequired.length > 0 ? (
          <span
            data-testid="step-required-unset"
            className="min-w-0 shrink truncate rounded-sm bg-cc-danger/15 px-1 text-2xs font-medium text-cc-danger"
            title={`${
              missingRequired.length === 1
                ? 'Required parameter'
                : 'Required parameters'
            } not set: ${missingRequired
              .map((param) => param.name)
              .join(
                ', ',
              )}. A required parameter with no value is not a valid config; expand this step to set ${missingRequired.length === 1 ? 'it' : 'them'}.`}
          >
            {missingRequired.length === 1
              ? `${missingRequired[0]!.name} unset`
              : `${missingRequired.length} unset`}
          </span>
        ) : null}
        {controls ? (
          <>
            {/* See `stepArrowClassName`: the pair is one visual unit at
                `gap-0.5`, kept clear of Remove by the row's own `gap-1.5`. */}
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label={`Move step ${controls.index + 1} up`}
                title={`Move step ${controls.index + 1} up`}
                disabled={controls.moveUpDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  controls.onMoveUp();
                }}
                className={stepArrowClassName}
              >
                &uarr;
              </button>
              <button
                type="button"
                aria-label={`Move step ${controls.index + 1} down`}
                title={`Move step ${controls.index + 1} down`}
                disabled={controls.moveDownDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  controls.onMoveDown();
                }}
                className={stepArrowClassName}
              >
                &darr;
              </button>
            </span>
            <button
              type="button"
              aria-label={`Remove step ${controls.index + 1}`}
              onClick={(event) => {
                event.stopPropagation();
                controls.onRemove();
              }}
              // Same 16px box and 11px glyph as the arrows -- it was the other
              // unsized 16px glyph holding these rows at 34px -- but no resting
              // boundary. #249 asked for the *arrows* to gain presence; giving
              // the destructive control the same promotion would have made
              // "remove this step" the loudest thing in a step row, and its
              // danger colour already says it is a control.
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-2xs leading-none text-cc-danger transition-colors hover:bg-cc-danger/20"
            >
              &times;
            </button>
          </>
        ) : null}
      </div>

      {expanded && descriptor.tag === 'group' ? (
        <div className="min-w-0 border-t border-cc-border px-2 py-1.5 pl-4">
          {stepDocsUrl(descriptor.fullKey) ? (
            <div className="mb-1.5 flex justify-end">
              <DocsLink
                label="The when/unless step"
                url={stepDocsUrl(descriptor.fullKey)!}
              />
            </div>
          ) : null}
          {descriptor.steps.length === 0 ? (
            <p className="text-2xs text-cc-text-faint">No steps.</p>
          ) : (
            <ul className="space-y-1">
              {descriptor.steps.map((nestedRaw, nestedIndex) => (
                <StepRow
                  // eslint-disable-next-line react/no-array-index-key -- nested steps have no stable id either; see the top-level map below.
                  key={nestedIndex}
                  raw={nestedRaw}
                  pathPrefix={[
                    ...pathPrefix,
                    descriptor.fullKey,
                    'steps',
                    nestedIndex,
                  ]}
                  pathKey={`${pathKey}.${nestedIndex}`}
                  root={root}
                  schema={schema}
                  orbAliases={orbAliases}
                  expandedKeys={expandedKeys}
                  onToggleExpand={onToggleExpand}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {expanded && descriptor.tag === 'known' ? (
        <StepFieldsSection
          fullKey={descriptor.fullKey}
          rawValue={descriptor.rawValue}
          shorthandField={descriptor.shorthandField}
          fieldSchemas={schema?.stepFieldSchemas[descriptor.fullKey] ?? []}
          schemaLoaded={schema !== null}
          onSetField={(fieldName, value) =>
            root.setStepField(
              pathPrefix,
              descriptor.fullKey,
              fieldName,
              value,
              descriptor.shorthandField,
            )
          }
        />
      ) : null}

      {expanded && descriptor.tag === 'unknown' ? (
        <p className="border-t border-cc-border px-2 py-1.5 pl-6 text-2xs text-cc-text-muted">
          {descriptor.reason}
        </p>
      ) : null}

      {expanded && descriptor.tag === 'orbCommand' ? (
        <OrbCommandParamsEditor
          descriptor={descriptor}
          pathPrefix={pathPrefix}
          root={root}
          paramsState={orbParams}
        />
      ) : null}

      {expanded && paramsFullKey && params.length > 0 ? (
        <ParamsEditor
          paramsPath={[...pathPrefix, paramsFullKey]}
          params={params}
          root={root}
        />
      ) : null}
    </li>
  );
}

/** The top-level step rows of one list, in document order -- `StepRow` marks its own `<li>` with `data-step-row`, so this never picks up the drop slot or a nested `when`/`unless` row. */
function stepRowElements(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>(':scope > [data-step-row]'),
  );
}

function StepsSection({
  root,
  schema,
  orbAliases,
  sectionKey,
  title = 'Steps',
  onDropOrbCommand,
  onDropPaletteStep,
}: {
  root: StepsRoot;
  /** `null` while `/api/schema` is still loading -- threaded down to every `StepRow` (issue #48). */
  schema: CircleciSchema | null;
  /** This config's `orbs:` map, alias to reference -- threaded down to every `StepRow` so an orb-command step can resolve its own parameters (issue #252). */
  orbAliases: Record<string, string>;
  /** This section's collapse-state identity (issue #219) -- see `inspectorSections.ts`. */
  sectionKey: InspectorSectionKey;
  /** "Steps" for a job body, "Pre-steps"/"Post-steps" for a workflow entry (issue #37). */
  title?: string;
  /**
   * Already bound to whichever list this is (see `StepsSectionOrbDropHandler`'s
   * own comment) -- this component never needs to know whether it is rooted at
   * a job body or a workflow entry's pre/post-steps, only that dropping a
   * command/step means "insert at this gap".
   */
  onDropOrbCommand?: StepsSectionOrbDropHandler;
  /** Issue #71: the same drop target also accepts a palette step card. */
  onDropPaletteStep?: StepsSectionPaletteDropHandler;
}) {
  const steps = root.steps;
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  // Which *gap* the pending drop would insert at: `0` above the first step,
  // `steps.length` below the last, and `n` between steps `n-1` and `n`.
  // `null` when nothing is being dragged over this list. Issue #218 part 3
  // moved this from an index-of-a-row to an index-of-a-gap, which is what
  // lets the affordance address the position after the final row -- see
  // `StepDropSlot` and `stepDropFrame.ts`.
  const [dropGap, setDropGap] = useState<number | null>(null);
  // ...mirrored in a ref, so `drop` can read the gap the user was actually
  // shown without depending on a re-render having landed first. `dragover` is a
  // continuous-priority event in React 18, so in practice the state is always
  // committed long before the eventual `drop` -- but "the step lands in the gap
  // that was on screen" is the guarantee this whole feature makes, and it should
  // not rest on scheduling.
  const dropGapRef = useRef<number | null>(null);
  // The frozen geometry this drag's gap indices are computed from, and the
  // height of the gap it opens. Captured on the first `dragover` and held for
  // the whole drag -- `stepDropFrame.ts`'s module comment is why.
  const dropFrame = useRef<StepDropFrame | null>(null);
  const [slotHeight, setSlotHeight] = useState(SLOT_HEIGHT_FALLBACK);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Which rows (keyed by `StepRow`'s `pathKey`) currently show their
  // expanded parameters/nested-steps. Collapsed (absent) by default.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  // The index of the step currently being drag-reordered, if any. State
  // rather than the plain ref this used to be: issue #218 dims the dragged
  // row, so the value now drives rendering and a ref would leave the row
  // undimmed until some unrelated re-render happened to pick it up.
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  // ...and a ref alongside it, read by the `dragover`/`drop` handlers. Those
  // fire between renders during a drag and must see the value set by *this*
  // drag's `dragstart`, not whatever the last committed render closed over.
  const draggedStepIndex = useRef<number | null>(null);
  const nameId = useId();
  const commandId = useId();

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Whether this list can accept whatever is currently being dragged, and the
   * refusal when it cannot.
   *
   * Refusing means *not* calling `preventDefault()` (which is what accepting a
   * drop is, in the HTML5 DnD model) plus setting `dropEffect = 'none'`
   * explicitly, so the browser paints a no-drop cursor rather than an
   * ambiguous one. That is #87's own documented pattern, lifted verbatim from
   * `JobNode.tsx`/`DagPane.tsx` -- and the `dropEffect` half is new here: this
   * list used to refuse only by omission, so dragging e.g. an orb *executor*
   * over the steps list gave the correct outcome (nothing) via a cursor that
   * never said so. The refusal still happens before release either way, which
   * is the constraint that matters.
   */
  const acceptDrag = useCallback(
    (event: DragEvent<HTMLElement>): boolean => {
      const isOrbCommand =
        Boolean(onDropOrbCommand) &&
        isDraggingOrbKind(event.dataTransfer, 'command');
      const isPaletteStep =
        Boolean(onDropPaletteStep) && isDraggingPaletteStep(event.dataTransfer);
      const isStepReorder = draggedStepIndex.current !== null;
      if (!isOrbCommand && !isPaletteStep && !isStepReorder) {
        event.dataTransfer.dropEffect = 'none';
        return false;
      }
      return true;
    },
    [onDropOrbCommand, onDropPaletteStep],
  );

  /** Shows (or clears) the gap, keeping the ref mirror in step. */
  const showDropGap = useCallback((gap: number | null) => {
    dropGapRef.current = gap;
    setDropGap(gap);
  }, []);

  /** Ends the pending drop: no gap, and the next drag measures its own frame. */
  const clearDropGap = useCallback(() => {
    dropFrame.current = null;
    showDropGap(null);
  }, [showDropGap]);

  /**
   * The frozen geometry for this drag, measuring it if this is the first event
   * of the drag to need it. Called while no gap is open -- which is true of the
   * first `dragover`, and of a `drop` that arrives without one -- so what it
   * measures is the undisplaced list, the only frame worth freezing.
   *
   * Lazily, rather than on `dragstart`, because a palette card or an orb command
   * starts its drag in another pane entirely and this list never sees a
   * `dragstart` for it.
   */
  const ensureDropFrame = useCallback((region: HTMLElement): StepDropFrame => {
    if (!dropFrame.current) {
      const frame = captureStepDropFrame(
        region,
        listRef.current ? stepRowElements(listRef.current) : [],
      );
      dropFrame.current = frame;
      setSlotHeight(frame.slotHeight);
    }
    return dropFrame.current;
  }, []);

  /**
   * `dragover` **and `dragenter`** for the whole steps area -- the rows, the gap
   * itself, the empty state and the Add form, all under one handler (issue
   * #249).
   *
   * Issue #218 had a handler per row plus two fixed-gap targets, which was the
   * right shape for an affordance drawn out of flow and the wrong one for a
   * reflow. Two reasons, both about the pointer ending up somewhere no handler
   * covers:
   *
   * - Opening a real gap moves rows. A row that slides out from under the
   *   pointer fires `dragleave` with no matching `dragover`, and #218's
   *   `onDragLeave` had to guess (from the gap index) whether that meant "gone"
   *   or "moved next door". With one region there is nothing to guess: the
   *   pointer is inside it or it isn't.
   * - The gap `<li>` and the space beside the Add form belong to no row, so
   *   under the old shape the indicator blinked out whenever the pointer entered
   *   the very slot it had just opened.
   *
   * The gap itself comes from `stepDropFrame.ts` -- frozen geometry, so this
   * handler is idempotent for a still pointer and cannot oscillate.
   *
   * **`dragenter` has to accept the drop as well as `dragover`**, and #249 is
   * where that stopped being pedantry about the HTML5 model and became a real
   * defect. Chromium re-runs its hit test when the DOM changes under a
   * stationary drag pointer -- which is precisely what a reflow does -- and
   * fires `dragenter` on the newly-hit element plus `dragleave` on the old one.
   * Until something *cancels* one of those, there is no current drop target, so
   * a release in that window produces `dragend` and **no `drop` at all**: the
   * gesture silently does nothing. Measured on the real running app while
   * writing this, logging every drag event of one Playwright drag:
   *
   * ```
   * dragover  y=454 gap=2      <- last pointer move
   * dragenter y=454 gap=3      <- the reflow, hit-testing a new element
   * dragleave y=454
   * dragleave y=454
   * dragend   y=454            <- released here; no `drop` was ever delivered
   * ```
   *
   * The mouse never moved between the reflow and the release. With `dragenter`
   * accepting, the same gesture delivers `drop` and reorders the step -- which
   * is what the two real-mouse tests in `e2e/inspector-sections-steps.spec.ts`
   * now guard.
   */
  const onRegionDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // #85/#87: refuse before release, and *before* opening any gap -- "never
      // open a gap that then rejects the item" (#249). `acceptDrag` sets
      // `dropEffect = 'none'` and leaves the event un-prevented on refusal.
      if (!acceptDrag(event)) return;
      event.preventDefault();
      const region = regionRef.current;
      if (!region) return;
      showDropGap(
        gapForPointer(
          ensureDropFrame(region),
          region.getBoundingClientRect().top,
          event.clientY,
        ),
      );
    },
    [acceptDrag, ensureDropFrame, showDropGap],
  );

  /**
   * `dragleave` for the region. `dragleave` bubbles, so moving between two
   * elements *inside* the region fires one here too -- and clearing the gap on
   * those is what made #218's per-row version blink on every boundary crossing,
   * which it had to work around by guessing from gap indices.
   *
   * Two signals, in order of exactness:
   *
   * 1. `relatedTarget`, which the HTML drag-and-drop model defines for
   *    `dragleave` as "the new target element". When it is there it answers the
   *    question exactly -- the drag has left only if what it entered is not in
   *    here -- so it decides on its own.
   * 2. The pointer coordinate, when `relatedTarget` is `null`: the drag left for
   *    something outside the document, or for a browser that did not populate
   *    it. Guessing "left" there would blink the gap on an internal move;
   *    guessing "stayed" would strand an open gap, which matters more than it
   *    looks, because `dragend` fires on the *source* element and a palette card
   *    or orb command's source is in another pane entirely -- this section would
   *    never hear about the drag ending.
   */
  const onRegionDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const entered = event.relatedTarget;
      const stillInside =
        entered instanceof Node
          ? event.currentTarget.contains(entered)
          : event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom;
      if (!stillInside) clearDropGap();
    },
    [clearDropGap],
  );

  /**
   * The one drop handler, parameterised by gap. `gap` is used directly for the
   * two "bring something new in" payloads (a gap index *is* an insertion
   * index) and translated for a reorder -- see `reorderTargetForGap`.
   */
  const dropAtGap = useCallback(
    (gap: number) => (event: DragEvent<HTMLElement>) => {
      clearDropGap();
      const orbPayload = onDropOrbCommand
        ? readOrbDragPayload(event.dataTransfer, 'command')
        : undefined;
      if (orbPayload) {
        event.preventDefault();
        onDropOrbCommand?.(gap, orbPayload);
        return;
      }
      const stepPayload = onDropPaletteStep
        ? readPaletteStepDragPayload(event.dataTransfer)
        : undefined;
      if (stepPayload) {
        event.preventDefault();
        onDropPaletteStep?.(gap, stepPayload.stepKey);
        return;
      }
      const fromIndex = draggedStepIndex.current;
      draggedStepIndex.current = null;
      setDraggedIndex(null);
      if (fromIndex === null) return;
      const to = reorderTargetForGap(fromIndex, gap);
      if (to === null) return;
      event.preventDefault();
      root.move(fromIndex, to);
    },
    [clearDropGap, onDropOrbCommand, onDropPaletteStep, root],
  );

  /**
   * `drop` on the region. Uses **the gap that was on screen**, not a fresh
   * derivation from the release coordinate.
   *
   * This inverts #218's choice, which re-derived from the pointer on the
   * grounds that "the pointer's position is the ground truth". That was right
   * when the affordance was a 2px line: a line is a hint, and a hint one
   * `dragover` stale is harmless. A gap is a *commitment* -- the rows have
   * already moved to show you the outcome -- so if the two could ever disagree,
   * the one the user was looking at has to win.
   *
   * In fact they cannot disagree, because both are `gapForPointer` over the same
   * frozen frame and `drop`'s coordinate is the last `dragover`'s. Reading the
   * shown value is simply the version that stays correct if that ever stops
   * being true.
   */
  const onRegionDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const region = regionRef.current;
      // The fallback covers a `drop` arriving with no gap on screen -- no
      // preceding accepted `dragover`, or one whose gap was cleared. It measures
      // its own frame if there isn't one, which is correct precisely because
      // there is no gap open to have displaced anything.
      const gap =
        dropGapRef.current ??
        (region
          ? gapForPointer(
              ensureDropFrame(region),
              region.getBoundingClientRect().top,
              event.clientY,
            )
          : 0);
      dropAtGap(gap)(event);
    },
    [dropAtGap, ensureDropFrame],
  );

  const handleAdd = useCallback(() => {
    const command = newCommand.trim();
    if (!command) return;
    const name = newName.trim();
    const step = name ? { run: { name, command } } : { run: command };
    root.add(step);
    setNewName('');
    setNewCommand('');
  }, [newCommand, newName, root]);

  return (
    <CollapsibleSection
      id={sectionKey}
      title={title}
      // Issue #19: a per-step-type link has existed since issue #78
      // (`StepFieldsSection`'s own `stepDocsUrl`), but only once a step is
      // both present and expanded -- there was nothing to click for "what is
      // a step, generally" before that. `pre-steps`/`post-steps` link to
      // their own documented section, not `steps`'s (see `DOCS_LINKS.jobs`'s
      // own doc comment for why those are not the same anchor).
      docsLink={
        sectionKey === 'steps'
          ? DOCS_LINKS.jobs.steps
          : DOCS_LINKS.jobs.prePostSteps
      }
      contentCount={steps.length}
      defaultOpen={defaultSectionOpen(sectionKey, steps.length > 0)}
    >
      {/*
        Issue #249: one drop region around the whole list -- rows, gap, empty
        state and Add form. See `onRegionDragOver` for why a reflowing gap cannot
        be driven from per-row handlers, and `stepDropFrame.ts` for why it does
        not thrash.

        No `overflow`, no height of its own: this is a plain wrapper, so the
        inspector still has exactly one scroll region (#88) even while a
        gap is open and the list is one row taller than the pane.
      */}
      <div
        ref={regionRef}
        data-testid="step-drop-region"
        // Both, deliberately -- see `onRegionDragOver` for the measured reason
        // `dragenter` cannot be left out once the list reflows.
        onDragEnter={onRegionDragOver}
        onDragOver={onRegionDragOver}
        onDragLeave={onRegionDragLeave}
        onDrop={onRegionDrop}
        className="min-w-0"
      >
        {steps.length === 0 ? (
          // An empty list has no rows to displace, so the empty state *is* the
          // gap: it takes the slot's own dashed-accent treatment and grows to a
          // row's height, which is the only honest way to say "it will land
          // here" when there is no "between" to point at. It carries the slot's
          // test id for the same reason -- one affordance, three boundary cases
          // (#249: "unambiguous ... before the first row, after the last, and
          // into an empty list").
          //
          // That it accepts a drop at all is #218's: before that, an empty
          // list's only target was the Add form below it, so dropping onto the
          // words "No steps yet." did nothing, silently.
          <p
            data-testid={dropGap === 0 ? 'step-drop-slot' : undefined}
            style={dropGap === 0 ? { minHeight: slotHeight } : undefined}
            className={`mb-2 flex items-center rounded-md border border-dashed p-2 text-xs ${
              dropGap === 0
                ? 'border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)] text-cc-text'
                : 'border-transparent text-cc-text-faint'
            }`}
          >
            No {title.toLowerCase()} yet.
          </p>
        ) : (
          <ul ref={listRef} className="mb-2 min-w-0 space-y-1">
            {steps.map((raw, index) => (
              // A fragment, so the gap is a real sibling `<li>` of the rows --
              // in the flow, displacing everything below it, which is the whole
              // point of #249 part 1. `space-y-1` still works: fragments add no
              // DOM node, so the `<ul>`'s children are exactly its `<li>`s.
              // eslint-disable-next-line react/no-array-index-key -- steps have no stable id; index *is* their identity (move/remove are index-based)
              <Fragment key={index}>
                {dropGap === index ? (
                  <StepDropSlot height={slotHeight} />
                ) : null}
                <StepRow
                  raw={raw}
                  pathPrefix={[index]}
                  pathKey={String(index)}
                  root={root}
                  schema={schema}
                  orbAliases={orbAliases}
                  expandedKeys={expandedKeys}
                  onToggleExpand={toggleExpand}
                  controls={{
                    index,
                    onMoveUp: () => root.move(index, index - 1),
                    onMoveDown: () => root.move(index, index + 1),
                    onRemove: () => root.remove(index),
                    moveUpDisabled: index === 0,
                    moveDownDisabled: index === steps.length - 1,
                    onDragStart: (event) => {
                      draggedStepIndex.current = index;
                      setDraggedIndex(index);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', String(index));
                    },
                    onDragEnd: () => {
                      draggedStepIndex.current = null;
                      setDraggedIndex(null);
                      clearDropGap();
                    },
                    isDragging: draggedIndex === index,
                  }}
                />
              </Fragment>
            ))}
            {/* The gap after the final row -- the position #218's row-indexed
                targets had no way to name at all. */}
            {dropGap === steps.length ? (
              <StepDropSlot height={slotHeight} />
            ) : null}
          </ul>
        )}

        <div
          className={`rounded-md border border-dashed p-2 ${
            dropGap === steps.length
              ? 'border-cc-accent'
              : 'border-cc-border-interactive'
          }`}
          title="Drop a step here to add it as the last step"
        >
          <p className="mb-1.5 text-2xs font-medium text-cc-text-muted">
            Add a run step
          </p>
          <label htmlFor={nameId} className="sr-only">
            Step name (optional)
          </label>
          <input
            id={nameId}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Name (optional)"
            className={`${inputClassName} mb-1.5`}
          />
          <label htmlFor={commandId} className="sr-only">
            Shell command
          </label>
          <textarea
            id={commandId}
            value={newCommand}
            onChange={(event) => setNewCommand(event.target.value)}
            placeholder="Shell command"
            rows={2}
            className={`${inputClassName} mb-1.5 resize-none font-mono`}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={handleAdd}
            disabled={!newCommand.trim()}
          >
            Add step
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  );
}

function RequiresSection({
  node,
  workflowName,
  mutate,
}: {
  node: GraphNode;
  workflowName: string | undefined;
  mutate: MutateFn;
}) {
  return (
    <CollapsibleSection
      id="requires"
      title="Requires"
      docsLink={DOCS_LINKS.workflows.requires}
      contentCount={node.requires.length}
      defaultOpen={defaultSectionOpen('requires', node.requires.length > 0)}
    >
      {node.requires.length === 0 ? (
        <p className="text-xs text-cc-text-faint">
          No dependencies -- this job runs immediately.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {node.requires.map((requiredId) => (
            <li
              key={requiredId}
              className="flex items-center gap-1 rounded-full border border-cc-border-strong bg-cc-panel-raised px-2 py-0.5 text-2xs font-mono text-cc-text"
            >
              {requiredId}
              <button
                type="button"
                aria-label={`Remove requirement on ${requiredId}`}
                onClick={() =>
                  workflowName &&
                  mutate((d) =>
                    removeRequire(d, workflowName, node.id, requiredId),
                  )
                }
                className="rounded-full px-1 text-cc-text-muted hover:bg-cc-danger/20 hover:text-cc-danger"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

/**
 * One tag-pill list editor -- shared shape for `context:`, and each of
 * `filters.branches`/`filters.tags`'s `only`/`ignore` (issue #37). Mirrors
 * `RequiresSection`'s pill rendering so every "list of strings" field in
 * this pane looks and behaves the same way.
 *
 * Exported so `WorkflowInspector.tsx` can reuse it for a schedule trigger's
 * own `filters.branches` `only`/`ignore` (issue #288) -- the same "list of
 * branch patterns" shape `FiltersSection` below already renders, just
 * rooted at a trigger instead of a workflow entry.
 */
export function TagListEditor({
  label,
  values,
  placeholder,
  onAdd,
  onRemove,
}: {
  label: string;
  values: string[];
  placeholder: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const fieldId = useId();

  const commitAdd = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft('');
  }, [draft, onAdd]);

  return (
    <div className="mb-2">
      <label
        htmlFor={fieldId}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        {label}
      </label>
      {values.length > 0 ? (
        <ul className="mb-1.5 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1 rounded-full border border-cc-border-strong bg-cc-panel-raised px-2 py-0.5 text-2xs font-mono text-cc-text"
            >
              {value}
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${value}`}
                onClick={() => onRemove(value)}
                className="rounded-full px-1 text-cc-text-muted hover:bg-cc-danger/20 hover:text-cc-danger"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-1.5">
        <input
          id={fieldId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitAdd();
            }
          }}
          placeholder={placeholder}
          className={`${inputClassName} font-mono`}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={commitAdd}
          disabled={!draft.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * The `context:` section (issue #152).
 *
 * Two things changed here, and they are related. The editor is now a combobox
 * backed by the real context list (see `ContextField`), and the edits are now
 * surgical: `addWorkflowJobEntryContext`/`removeWorkflowJobEntryContext` splice
 * one item in or out of the live `context:` sequence, where this section used to
 * hand `setWorkflowJobEntryOption` a rebuilt array -- which replaced the whole
 * sequence and took any comment on the items already there with it.
 * Adding a context from the palette had always been surgical; adding the same
 * context from the inspector was not, which is the sort of inconsistency that
 * only shows up as a lost comment in someone's diff.
 */
function ContextSection({
  context,
  workflowName,
  nodeId,
  mutate,
}: {
  context: string[];
  workflowName: string;
  nodeId: string;
  mutate: MutateFn;
}) {
  return (
    <CollapsibleSection
      id="context"
      title="Context"
      docsLink={DOCS_LINKS.workflows.contexts}
      contentCount={context.length}
      defaultOpen={defaultSectionOpen('context', context.length > 0)}
    >
      <ContextField
        values={context}
        onAdd={(name) => {
          mutate((d) =>
            addWorkflowJobEntryContext(d, workflowName, nodeId, name),
          );
          // Issue #251: the same restriction notice the palette's drag raises,
          // from the other affordance that adds a context. Two ways in must not
          // mean two different amounts of warning -- and this is the path where a
          // name can be typed from memory, which is exactly when "that context
          // is restricted to other projects" is worth hearing. After the
          // mutation, never in place of it.
          void useProjectContextStore.getState().noteContextAdded(name, nodeId);
        }}
        onRemove={(name) =>
          mutate((d) =>
            removeWorkflowJobEntryContext(d, workflowName, nodeId, name),
          )
        }
      />
    </CollapsibleSection>
  );
}

interface FiltersDraft {
  branchesOnly: string[];
  branchesIgnore: string[];
  tagsOnly: string[];
  tagsIgnore: string[];
}

/** Rebuilds a `WorkflowEntryFilters` value (or `undefined`, once nothing is set) from the four lists `FiltersSection` edits. */
function buildFiltersValue(
  draft: FiltersDraft,
): WorkflowEntryFilters | undefined {
  const branches: WorkflowEntryFilterGroup = {};
  if (draft.branchesOnly.length > 0) branches.only = draft.branchesOnly;
  if (draft.branchesIgnore.length > 0) branches.ignore = draft.branchesIgnore;
  const tags: WorkflowEntryFilterGroup = {};
  if (draft.tagsOnly.length > 0) tags.only = draft.tagsOnly;
  if (draft.tagsIgnore.length > 0) tags.ignore = draft.tagsIgnore;

  const result: WorkflowEntryFilters = {};
  if (Object.keys(branches).length > 0) result.branches = branches;
  if (Object.keys(tags).length > 0) result.tags = tags;
  return Object.keys(result).length > 0 ? result : undefined;
}

function FiltersSection({
  filters,
  onChange,
}: {
  filters: WorkflowEntryFilters | undefined;
  onChange: (next: WorkflowEntryFilters | undefined) => void;
}) {
  const draft: FiltersDraft = {
    branchesOnly: filters?.branches?.only ?? [],
    branchesIgnore: filters?.branches?.ignore ?? [],
    tagsOnly: filters?.tags?.only ?? [],
    tagsIgnore: filters?.tags?.ignore ?? [],
  };
  const commit = (next: FiltersDraft) => onChange(buildFiltersValue(next));
  // Four independent lists, so the summary-row signal is "how many filter
  // rules are set", not "is `filters:` present" -- a `filters:` block that
  // exists but is empty is not configuration worth flagging, and a section
  // holding six branch patterns should say six rather than one.
  const ruleCount =
    draft.branchesOnly.length +
    draft.branchesIgnore.length +
    draft.tagsOnly.length +
    draft.tagsIgnore.length;

  return (
    <CollapsibleSection
      id="filters"
      title="Filters"
      docsLink={DOCS_LINKS.workflows.filters}
      contentCount={ruleCount}
      defaultOpen={defaultSectionOpen('filters', ruleCount > 0)}
    >
      <TagListEditor
        label="Branches -- only"
        values={draft.branchesOnly}
        placeholder="main"
        onAdd={(v) =>
          commit({ ...draft, branchesOnly: [...draft.branchesOnly, v] })
        }
        onRemove={(v) =>
          commit({
            ...draft,
            branchesOnly: draft.branchesOnly.filter((x) => x !== v),
          })
        }
      />
      <TagListEditor
        label="Branches -- ignore"
        values={draft.branchesIgnore}
        placeholder="wip-*"
        onAdd={(v) =>
          commit({ ...draft, branchesIgnore: [...draft.branchesIgnore, v] })
        }
        onRemove={(v) =>
          commit({
            ...draft,
            branchesIgnore: draft.branchesIgnore.filter((x) => x !== v),
          })
        }
      />
      <TagListEditor
        label="Tags -- only"
        values={draft.tagsOnly}
        placeholder="v1.0.0"
        onAdd={(v) => commit({ ...draft, tagsOnly: [...draft.tagsOnly, v] })}
        onRemove={(v) =>
          commit({ ...draft, tagsOnly: draft.tagsOnly.filter((x) => x !== v) })
        }
      />
      <TagListEditor
        label="Tags -- ignore"
        values={draft.tagsIgnore}
        placeholder="nightly"
        onAdd={(v) =>
          commit({ ...draft, tagsIgnore: [...draft.tagsIgnore, v] })
        }
        onRemove={(v) =>
          commit({
            ...draft,
            tagsIgnore: draft.tagsIgnore.filter((x) => x !== v),
          })
        }
      />
    </CollapsibleSection>
  );
}

/** One parameter this pane knows how to render/edit, whichever schema it came from (an orb element's own parameters, or a local job's declared `parameters:`). */
interface InvocationParamSpec {
  name: string;
  type: string;
  default?: unknown;
  enumValues?: string[];
}

/** The empty value a freshly-added, not-yet-set parameter of `type` should show, mirroring `snippets.ts#defaultParamValues`'s per-type defaults. */
function emptyValueForType(type: string, enumValues?: string[]): unknown {
  switch (type) {
    case 'boolean':
      return false;
    case 'integer':
      return 0;
    case 'enum':
      return enumValues?.[0] ?? '';
    case 'steps':
      return [];
    default:
      return '';
  }
}

/** Renders one editable field per `params` entry, seeded from `values[name]` (falling back to the parameter's own default, then an empty value for its type). Shared by the orb-job and local-parameterized-job invocation editors below. */
function InvocationParamsSection({
  title,
  params,
  values,
  onCommit,
}: {
  title: string;
  params: InvocationParamSpec[];
  values: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
}) {
  if (params.length === 0) return null;
  return (
    // Never rendered empty (the guard above), so the content rule always
    // opens this -- it is collapsible for the user's sake, not the default's.
    <CollapsibleSection
      id="params"
      title={title}
      docsLink={DOCS_LINKS.reusableConfig.parameters}
      contentCount={params.length}
      defaultOpen={defaultSectionOpen('params', true)}
    >
      <div className="space-y-2">
        {params.map((param) => {
          const current =
            values[param.name] ??
            param.default ??
            emptyValueForType(param.type, param.enumValues);
          return (
            <ParamField
              key={param.name}
              label={param.name}
              value={current}
              enumValues={param.enumValues}
              onCommit={(next) => onCommit(param.name, next)}
            />
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

/** Reads a local job's own declared `parameters:` schema (name/type/default/enum) into the shared `InvocationParamSpec` shape -- the local-job counterpart of an orb element's `OrbParameter[]`. */
function readJobDeclaredParameters(
  doc: Document,
  jobName: string,
): InvocationParamSpec[] {
  const raw = getIn(doc, ['jobs', jobName, 'parameters']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const specs: InvocationParamSpec[] = [];
  for (const [name, rawDef] of Object.entries(raw as Record<string, unknown>)) {
    if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) {
      specs.push({ name, type: 'string' });
      continue;
    }
    const def = rawDef as Record<string, unknown>;
    const type = typeof def.type === 'string' ? def.type : 'string';
    const enumValues =
      type === 'enum' && Array.isArray(def.enum)
        ? def.enum.map((v) => String(v))
        : undefined;
    specs.push({ name, type, default: def.default, enumValues });
  }
  return specs;
}

/** A parameterized local job's own invocation-parameter editor at the call site (issue #37). Rendered only when the job actually declares `parameters:`. */
function LocalJobParamsSection({
  doc,
  node,
  workflowName,
  mutate,
}: {
  doc: Document;
  node: GraphNode;
  workflowName: string;
  mutate: MutateFn;
}) {
  const params = readJobDeclaredParameters(doc, node.jobName);
  return (
    <InvocationParamsSection
      title="Job parameters"
      params={params}
      values={node.entryOptions.parameters}
      onCommit={(name, value) =>
        mutate((d) =>
          setWorkflowJobEntryParameter(d, workflowName, node.id, name, value),
        )
      }
    />
  );
}

/**
 * The selected job's own `parameters:` **declaration** -- issue #250's job
 * scope.
 *
 * This is the sibling of `LocalJobParamsSection` directly above, and the
 * distinction between the two is the whole reason this section needed a
 * different name rather than being folded into that one:
 *
 *  - **`LocalJobParamsSection` ("Job parameters")** edits the *values* this
 *    workflow entry passes -- `workflows.<w>.jobs[i].<job>.<param>`. It exists
 *    only because the job declares parameters, and disappears when it doesn't.
 *  - **this section ("Declared parameters")** edits the *declaration* --
 *    `jobs.<job>.parameters` -- the name, type, default, description and `enum:`
 *    values. It is what makes the parameters a job has editable at all, which
 *    before issue #250 nothing did at either scope.
 *
 * It lives with the rest of the *job body* (executor, steps), above the
 * workflow-entry sections, because that is what it edits. Rendered only when the
 * job body is editable for the same reason `ExecutorSection` is: an orb job's
 * declaration lives inside the orb, and an approval entry has no definition.
 *
 * No new pane and no restructuring: issue #248 is parked, so job parameters are
 * made editable *where a job is already edited* rather than in a new home whose
 * layout that issue may still decide differently.
 */
function DeclaredParametersSection({
  doc,
  jobName,
  mutate,
}: {
  doc: Document;
  jobName: string;
  mutate: MutateFn;
}) {
  const declared = listKeys(doc, ['jobs', jobName, 'parameters']);
  return (
    <CollapsibleSection
      id="declared-params"
      title="Declared parameters"
      docsLink={DOCS_LINKS.guides.pipelineVariables}
      contentCount={declared.length}
      defaultOpen={defaultSectionOpen('declared-params', declared.length > 0)}
    >
      <ParametersEditor
        doc={doc}
        scope={{ kind: 'job', jobName }}
        mutate={mutate}
      />
    </CollapsibleSection>
  );
}

/**
 * An orb job's own invocation-parameter editor at the call site (issue
 * #37), driven by the orb's own schema via `useOrbElementParameters` -- which
 * fetches through `useOrbStore.loadOrb`, the same store/rpc the orb browser
 * pane uses, rather than adding a second fetch path, and deliberately doesn't
 * touch `selectedOrb`/`loadingOrb`/`error` so inspecting a job never hijacks
 * whatever the orb browser panel currently shows (see `loadOrb`'s doc comment).
 *
 * `Inspector` renders this immediately below the read-only note rather than at
 * the end of the workflow-entry options -- see the comment at that call site,
 * and issue #252.
 */
function OrbJobParamsSection({
  doc,
  node,
  workflowName,
  mutate,
}: {
  doc: Document;
  node: GraphNode;
  workflowName: string;
  mutate: MutateFn;
}) {
  const orbAlias = node.orbRef ?? '';
  const orbJobName = node.jobName.includes('/')
    ? node.jobName.slice(node.jobName.indexOf('/') + 1)
    : node.jobName;
  const orbRefValue = orbAlias
    ? String(getIn(doc, ['orbs', orbAlias]) ?? '')
    : '';
  const state = useOrbElementParameters(
    orbAlias,
    orbRefValue,
    orbJobName,
    'job',
  );

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <p className="mb-4 text-xs text-cc-text-faint">
        Loading orb parameters&hellip;
      </p>
    );
  }
  if (state.status === 'unavailable') {
    return <p className="mb-4 text-xs text-cc-text-muted">{state.message}</p>;
  }

  return (
    <InvocationParamsSection
      title="Orb job parameters"
      params={state.params.map((p) => ({
        name: p.name,
        type: p.type,
        default: p.default,
        enumValues: p.enumValues,
      }))}
      values={node.entryOptions.parameters}
      onCommit={(name, value) =>
        mutate((d) =>
          setWorkflowJobEntryParameter(d, workflowName, node.id, name, value),
        )
      }
    />
  );
}

/**
 * Every plain, workflow-level option a workflow job entry accepts on top of
 * `name`/`requires` (which have their own dedicated sections/fields) --
 * context, filters, pre-steps and post-steps. Rendered unconditionally for
 * *every* node kind (issue #37): a job's/orb's/approval's usage in this
 * workflow is ordinary, editable config regardless of whether -- or where --
 * its definition lives.
 *
 * Invocation parameters used to be the last thing this component rendered, and
 * no longer live here at all: their position differs by node kind and is now
 * `Inspector`'s to choose. For an orb job they are the *primary* editable
 * content and belong where the job body would be (issue #252 -- see
 * `jobBodyReadOnlyNote`); for a local job the body is right there above, so its
 * call-site parameters stay in their old slot at the end of these options.
 * Encoding that as a position in the parent, rather than as a flag passed in
 * here, keeps one component from having two layouts.
 */
function WorkflowEntryOptionsSection({
  node,
  workflowName,
  mutate,
  schema,
  orbAliases,
  onDropOrbCommandOnEntrySteps,
  onDropPaletteStepOnEntrySteps,
}: {
  node: GraphNode;
  workflowName: string;
  mutate: MutateFn;
  /** `null` while `/api/schema` is still loading -- threaded down to `StepsSection` for Pre-steps/Post-steps (issue #48). */
  schema: CircleciSchema | null;
  /** This config's `orbs:` map -- threaded down so an orb command in a pre/post-step resolves its parameters too (issue #252). */
  orbAliases: Record<string, string>;
  /** Issue #21: see `InspectorProps`'s own doc comment on this pair. */
  onDropOrbCommandOnEntrySteps?: OrbCommandEntryDropHandler;
  onDropPaletteStepOnEntrySteps?: PaletteStepEntryDropHandler;
}) {
  const preStepsRoot = buildEntryStepsRoot(
    workflowName,
    node.id,
    'pre-steps',
    node.entryOptions.preSteps,
    mutate,
  );
  const postStepsRoot = buildEntryStepsRoot(
    workflowName,
    node.id,
    'post-steps',
    node.entryOptions.postSteps,
    mutate,
  );

  return (
    <>
      <ContextSection
        context={node.entryOptions.context}
        workflowName={workflowName}
        nodeId={node.id}
        mutate={mutate}
      />
      <FiltersSection
        filters={node.entryOptions.filters}
        onChange={(next) =>
          mutate((d) =>
            setWorkflowJobEntryOption(
              d,
              workflowName,
              node.id,
              'filters',
              next,
            ),
          )
        }
      />
      <StepsSection
        root={preStepsRoot}
        schema={schema}
        orbAliases={orbAliases}
        sectionKey="pre-steps"
        title="Pre-steps"
        onDropOrbCommand={
          onDropOrbCommandOnEntrySteps
            ? (index, payload) =>
                onDropOrbCommandOnEntrySteps(
                  workflowName,
                  node.id,
                  'pre-steps',
                  index,
                  payload,
                )
            : undefined
        }
        onDropPaletteStep={
          onDropPaletteStepOnEntrySteps
            ? (index, stepKey) =>
                onDropPaletteStepOnEntrySteps(
                  workflowName,
                  node.id,
                  'pre-steps',
                  index,
                  stepKey,
                )
            : undefined
        }
      />
      <StepsSection
        root={postStepsRoot}
        schema={schema}
        orbAliases={orbAliases}
        sectionKey="post-steps"
        title="Post-steps"
        onDropOrbCommand={
          onDropOrbCommandOnEntrySteps
            ? (index, payload) =>
                onDropOrbCommandOnEntrySteps(
                  workflowName,
                  node.id,
                  'post-steps',
                  index,
                  payload,
                )
            : undefined
        }
        onDropPaletteStep={
          onDropPaletteStepOnEntrySteps
            ? (index, stepKey) =>
                onDropPaletteStepOnEntrySteps(
                  workflowName,
                  node.id,
                  'post-steps',
                  index,
                  stepKey,
                )
            : undefined
        }
      />
    </>
  );
}

/** How many workflow entries (across every workflow) point at `jobName` -- used to warn before renaming a shared job definition (issue #36). */
function countJobReferences(doc: Document, jobName: string): number {
  let count = 0;
  for (const workflowName of getWorkflowNames(doc)) {
    for (const entry of getWorkflowJobEntries(doc, workflowName)) {
      if (entry.jobName === jobName) count += 1;
    }
  }
  return count;
}

/**
 * Renames the *job definition* `jobs.<jobName>` itself (via `renameJob`,
 * which updates every reference across every workflow). Unmistakably
 * labelled "Job name" -- as opposed to the `AliasField` below, which edits
 * only this one entry's own `name:` -- and warns when more than one
 * workflow entry shares this definition, since renaming it here updates
 * all of them at once (issue #36).
 *
 * Issue #12 turns that warning into a real prompt when the rename would
 * actually reach beyond the definition: it lists the exact sites that will be
 * rewritten (and the ones deliberately left alone -- see
 * `describeRenameImpact` on the `name:` alias rules) before anything is
 * touched. "Don't ask again" persists via `confirmStore` and only suppresses
 * the *prompt*; the reconciliation is identical either way, and the whole
 * reconciliation is one `mutate` call, so it undoes as one step.
 */
function JobRenameField({
  doc,
  jobName,
  mutate,
  autoFocusName,
  fieldId,
}: {
  doc: Document;
  jobName: string;
  mutate: MutateFn;
  autoFocusName: boolean;
  fieldId: string;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(jobName);
  const [nameError, setNameError] = useState<string | null>(null);
  /** The name awaiting confirmation, or `null` when no prompt is open. */
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const suppressed = useConfirmStore((s) => s.suppressed);
  const suppress = useConfirmStore((s) => s.suppress);

  const applyRename = useCallback(
    (newName: string) => {
      // A single `mutate` for the whole reconciliation: the `jobs:` key, every
      // workflow entry, every `requires:` mention. One undo step, not one per
      // site (issue #12).
      mutate((d) => renameJob(d, jobName, newName));
      setPendingRename(null);
    },
    [jobName, mutate],
  );

  const commitName = useCallback(() => {
    const trimmed = nameDraft.trim();
    if (trimmed === jobName) {
      setNameError(null);
      return;
    }
    if (trimmed.length === 0) {
      setNameError('Job name cannot be empty.');
      return;
    }
    if (getJobNames(doc).includes(trimmed)) {
      setNameError(`A job named "${trimmed}" already exists.`);
      return;
    }
    setNameError(null);

    // Prompt only for references the user can't see from here -- see
    // `renameNeedsConfirmation` for exactly which those are and why the
    // single-visible-entry case deliberately isn't one of them.
    const refs = findJobReferences(doc, jobName);
    if (!renameNeedsConfirmation(refs) || suppressed.includes('renameJob')) {
      applyRename(trimmed);
      return;
    }
    setPendingRename(trimmed);
  }, [applyRename, doc, jobName, nameDraft, suppressed]);

  const cancelRename = useCallback(() => {
    setPendingRename(null);
    setNameDraft(jobName);
    nameInputRef.current?.focus();
  }, [jobName]);

  const referenceCount = countJobReferences(doc, jobName);

  return (
    <Field label="Job name" htmlFor={fieldId} error={nameError}>
      <input
        id={fieldId}
        ref={nameInputRef}
        value={nameDraft}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            nameInputRef.current?.blur();
          }
        }}
        autoFocus={autoFocusName}
        className={inputClassName}
        aria-invalid={nameError ? true : undefined}
      />
      {referenceCount > 1 ? (
        <p className="mt-1 text-2xs text-cc-warning">
          {referenceCount} workflow entries use this job definition -- renaming
          it updates all of them.
        </p>
      ) : null}
      {pendingRename !== null ? (
        <RenameJobConfirm
          doc={doc}
          jobName={jobName}
          newName={pendingRename}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) suppress('renameJob');
            applyRename(pendingRename);
          }}
          onCancel={cancelRename}
        />
      ) : null}
    </Field>
  );
}

/**
 * The rename prompt itself (issue #12). Renders the enumerated impact rather
 * than a generic "are you sure?", because the whole problem being fixed is
 * that a rename quietly rewrites lines in panes the user isn't looking at --
 * the value here is in naming *which* lines, not in adding a speed bump.
 *
 * Deliberately inline in the field rather than a modal: the rename is an
 * inline field edit, and a modal over the whole app for a one-line change
 * reads as far more alarming than the edit warrants.
 */
function RenameJobConfirm({
  doc,
  jobName,
  newName,
  onConfirm,
  onCancel,
}: {
  doc: Document;
  jobName: string;
  newName: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const impact = useMemo(
    () => describeRenameImpact(doc, jobName, newName),
    [doc, jobName, newName],
  );

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Rename "${jobName}" to "${newName}"?`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mt-2 rounded-md border border-cc-border-strong bg-cc-panel-raised p-2 outline-none"
    >
      <ReferenceImpactList impact={impact} />
      <label className="mt-2 flex items-center gap-2 text-2xs text-cc-text-muted">
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(event) => setDontAskAgain(event.target.checked)}
        />
        Don&apos;t ask again (references are still updated either way)
      </label>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onConfirm(dontAskAgain)}
        >
          Rename
        </Button>
      </div>
    </div>
  );
}

/** The read-only "Job" row shown instead of `JobRenameField` when the entry's definition can't be edited here (an orb job, or a job name with no local definition). */
function JobReadOnlyRow({ jobName }: { jobName: string }) {
  const fieldId = useId();
  return (
    <Field label="Job" htmlFor={fieldId}>
      <p
        id={fieldId}
        className="truncate rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5 text-xs font-mono text-cc-text-muted"
        title={jobName}
      >
        {jobName}
      </p>
    </Field>
  );
}

/**
 * This entry's own `name:` alias -- separate from, and independent of,
 * `JobRenameField`/`JobReadOnlyRow` above (issue #36). Setting or clearing
 * it never touches the job definition it points at, nor any *other* entry
 * aliasing the same job.
 */
function AliasField({
  workflowName,
  node,
  mutate,
}: {
  workflowName: string;
  node: GraphNode;
  mutate: MutateFn;
}) {
  const fieldId = useId();
  const currentAlias = node.id === node.jobName ? '' : node.id;
  const [draft, setDraft] = useState(currentAlias);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === currentAlias) return;
    mutate((d) =>
      setWorkflowJobEntryAlias(d, workflowName, node.id, trimmed || undefined),
    );
  }, [currentAlias, draft, mutate, node.id, workflowName]);

  return (
    <Field label="Alias" htmlFor={fieldId}>
      <input
        id={fieldId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        placeholder={node.jobName}
        className={inputClassName}
      />
      <p className="mt-1 text-2xs text-cc-text-faint">
        This entry&rsquo;s own name in the workflow -- what other entries&rsquo;
        &ldquo;Requires&rdquo; reference. Leave blank to use the job name.
      </p>
    </Field>
  );
}

/** The "Job" + "Alias" identity fields, rendered for every node kind except approval (whose own map key isn't a reference to any shared definition worth exposing as "Job" -- see module doc). */
function JobIdentitySection({
  doc,
  node,
  workflowName,
  canEditJobBody,
  mutate,
  autoFocusName,
}: {
  doc: Document;
  node: GraphNode;
  workflowName: string;
  canEditJobBody: boolean;
  mutate: MutateFn;
  autoFocusName: boolean;
}) {
  const jobFieldId = useId();
  return (
    <>
      {node.kind === 'approval' ? null : canEditJobBody ? (
        <JobRenameField
          doc={doc}
          jobName={node.jobName}
          mutate={mutate}
          autoFocusName={autoFocusName}
          fieldId={jobFieldId}
        />
      ) : (
        <JobReadOnlyRow jobName={node.jobName} />
      )}
      <AliasField workflowName={workflowName} node={node} mutate={mutate} />
    </>
  );
}

/**
 * What genuinely cannot be edited in this pane when `canEditJobBody` is false --
 * specific about *why* (definition lives elsewhere) and that usage below is
 * still editable (issue #37).
 *
 * ## Why the orb sentence leads with what you *can* do (issue #252)
 *
 * The previous wording opened with the immutable half — "its definition (steps,
 * executor) lives inside the orb, not in this config, so there is nothing to
 * edit above" — and the owner working through `cci-labs/act` read it, concluded
 * there was nothing to do, and nearly stopped:
 *
 * > *"I think I just got confused with the text where it says the job is
 * > provided by the act orb, its definition, steps, executor are inside the orb
 * > and not in the config, so therefore you do not edit them above. But you
 * > have parameters, so I don't know."*
 *
 * Every clause of that sentence was true. It was still the wrong sentence: what
 * the reader needed first is that **the parameters they pass are editable, and
 * are the entire reason to use the orb**. So this now states the editable half
 * first and in the imperative, and keeps the immutable definition as the
 * *explanation for a specific absence* — why no steps are listed — which is the
 * only job that half was ever doing.
 *
 * The wording is half the fix; the other half is layout. The parameters section
 * used to render below Context, Filters, Pre-steps and Post-steps, which is what
 * made "maybe I do if you scroll down" a necessary discovery. `Inspector` now
 * renders it immediately after this note, where the job body would have been.
 */
function jobBodyReadOnlyNote(node: GraphNode): string {
  if (node.kind === 'approval') {
    return 'This is a manual approval step. Approval steps have no job definition -- there is nothing to edit here beyond its place in the workflow graph. Its usage below (alias, requires, context, filters) is still ordinary editable config.';
  }
  if (node.kind === 'orb') {
    return `Set this job's parameters below -- along with its context, filters, pre/post-steps and requires. Those are how you configure an orb job, and they are ordinary editable config. What you cannot change here is the job's definition: ${node.jobName}'s steps and executor live inside the "${node.orbRef}" orb rather than in this file, which is why no steps are listed above.`;
  }
  return `"${node.jobName}" is not defined under jobs: in this config, so there's no job body to edit here. Add a job with that name, or point this entry at an existing one. Its usage in this workflow, below, is still editable.`;
}

/**
 * One resource-class `<select>` (+ "Custom..." escape hatch) -- factored out of
 * the executor UI below since it's needed in up to three places: a
 * locally-defined executor, a per-job override, and a shared executor's own
 * definition.
 *
 * ## Why the full list lives here (issue #153)
 *
 * The palette's Project section used to render every resource class as a flat
 * wall of chips. The owner challenged that -- "how is that helpful?" -- and was
 * right: a list of every resource class is not project metadata, and it was not
 * scoped to what their project can use (no API exposes that; five candidate
 * endpoints 404'd). So the data moved to the one moment it is
 * actually wanted: choosing a resource class. Same reasoning that made project
 * env var *names* completions inside `run` rather than a browsable list.
 *
 * ## Where the options come from, and why not the schema (issues #159, #181)
 *
 * #159 widened this control from five hardcoded Docker values to the config JSON
 * Schema's whole `resource_class` enum. That was a real improvement over the
 * literals, and it is not the right source. **The tables win, and the schema is
 * no longer consulted for this field.**
 *
 * The two answer different questions. The schema says what is *syntactically
 * valid* -- one flat enum with no notion of which executor a class belongs to,
 * so it will happily offer `windows.2xlarge` for a `docker` job and
 * `macos.m1.medium.gen1` long after CircleCI stopped documenting it. CircleCI's
 * resource tables say what *exists*, per execution environment, with the vCPU and
 * RAM figures and the architecture. For a control whose job is "help me pick a
 * machine", that is the question being asked. The schema stays the source for
 * everything it is better at -- key completion, step field shapes, the reference
 * pane's key browser -- and this is the one field where it is not.
 *
 * So the options come from `GET /api/resource-classes` and are rendered by the
 * shared `ResourceClassField`, which is also what `ConfigureJobDialog` renders:
 * before this, creating a job and editing one offered two different lists.
 * Grouping by executor environment is what makes the tables usable here at all,
 * and it is why this passes a `kind` -- a flat 40-item list would have been a
 * regression dressed as more information.
 *
 * Neither source is a statement about entitlement, and the note under the select
 * still says so -- now naming the docs rather than the schema, since that is
 * where the list comes from. No CircleCI API exposes what a given project's plan
 * may use (five candidates 404'd), so the tables are the only authority
 * available.
 */
function ResourceClassSelect({
  id,
  kind,
  value,
  onChange,
  ariaLabel,
}: {
  id: string;
  /**
   * The executor kind whose resource tables to offer. `'unknown'` -- a job with
   * no executor at all yet -- is treated as `docker`, matching
   * `LocalExecutorFields`, which creates a docker executor for that case.
   */
  kind: ResolvedExecutor['kind'];
  value: string;
  onChange: (next: string) => void;
  /**
   * An explicit accessible name, for a usage where the visible `<label
   * htmlFor>` (via the surrounding `Field`) can't reliably point at *this*
   * particular select -- `InheritedResourceClassField` renders this
   * alongside a read-only current-value span under the same "Resource
   * class" label, so the label's `htmlFor` can only ever match one of them.
   */
  ariaLabel?: string;
}) {
  return (
    <ResourceClassField
      id={id}
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      scope={{ kind: kind === 'unknown' ? 'docker' : kind }}
      allowUnset
    />
  );
}

/**
 * The executor fields for a job that defines its executor inline (`docker`/
 * `machine`/`macos` directly on the job), or defines none at all yet -- the
 * fully-local, fully-editable case. Handles all three executor kinds (issue
 * #27), where the original inspector only ever read `docker[0].image`.
 */
function LocalExecutorFields({
  resolved,
  jobName,
  mutate,
}: {
  resolved: ResolvedExecutor;
  jobName: string;
  mutate: MutateFn;
}) {
  const imageFieldId = useId();
  const resourceClassFieldId = useId();
  const [imageDraft, setImageDraft] = useState(resolved.image ?? '');
  // A job with no executor at all yet (source: 'none', kind: 'unknown')
  // gets the same docker-creating UX a freshly-created job already has.
  const kind = resolved.kind === 'unknown' ? 'docker' : resolved.kind;

  if (kind === 'machine') {
    return (
      <section className="mb-4">
        <SectionHeading docsLink={DOCS_LINKS.executors.machine}>
          Executor (machine)
        </SectionHeading>
        <Field label="Machine image" htmlFor={imageFieldId}>
          <input
            id={imageFieldId}
            value={imageDraft}
            onChange={(event) => setImageDraft(event.target.value)}
            onBlur={() => {
              const trimmed = imageDraft.trim();
              if (trimmed !== (resolved.image ?? '')) {
                mutate((d) =>
                  setJobField(d, jobName, ['machine', 'image'], trimmed),
                );
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder="ubuntu-2404:current"
            className={`${inputClassName} font-mono`}
          />
        </Field>
        <label className="mb-3 flex items-center gap-1.5 text-xs text-cc-text">
          <input
            type="checkbox"
            checked={Boolean(resolved.dockerLayerCaching)}
            onChange={(event) =>
              mutate((d) =>
                setJobField(
                  d,
                  jobName,
                  ['machine', 'docker_layer_caching'],
                  event.target.checked,
                ),
              )
            }
            className="h-3.5 w-3.5 accent-cc-accent"
          />
          Docker Layer Caching
        </label>
        <Field label="Resource class" htmlFor={resourceClassFieldId}>
          <ResourceClassSelect
            id={resourceClassFieldId}
            kind={kind}
            value={resolved.resourceClass ?? ''}
            onChange={(value) =>
              mutate((d) => setJobField(d, jobName, ['resource_class'], value))
            }
          />
        </Field>
      </section>
    );
  }

  if (kind === 'macos') {
    return (
      <section className="mb-4">
        <SectionHeading docsLink={DOCS_LINKS.executors.macos}>
          Executor (macOS)
        </SectionHeading>
        <Field label="Xcode version" htmlFor={imageFieldId}>
          {/* Was a free-text input placeheld with `15.3.0` -- a version CircleCI
              does not offer (issue #203), so the placeholder was itself a
              suggestion to write something unsupported. Now the same control the
              palette dialog uses, over the versions upstream's own table lists,
              with free text still available for one published since our snapshot.
              Commits on blur (`customCommit`'s default), so a typed version is one
              mutation and one undo entry rather than one per keystroke. */}
          <XcodeVersionField
            id={imageFieldId}
            value={resolved.image ?? ''}
            onChange={(next) =>
              mutate((d) => setJobField(d, jobName, ['macos', 'xcode'], next))
            }
          />
        </Field>
        <Field label="Resource class" htmlFor={resourceClassFieldId}>
          <ResourceClassSelect
            id={resourceClassFieldId}
            kind={kind}
            value={resolved.resourceClass ?? ''}
            onChange={(value) =>
              mutate((d) => setJobField(d, jobName, ['resource_class'], value))
            }
          />
        </Field>
      </section>
    );
  }

  // docker -- including a job with no executor at all yet.
  return (
    <section className="mb-4">
      <SectionHeading docsLink={DOCS_LINKS.executors.docker}>
        Executor
      </SectionHeading>
      <Field label="Docker image" htmlFor={imageFieldId}>
        <input
          id={imageFieldId}
          value={imageDraft}
          onChange={(event) => setImageDraft(event.target.value)}
          onBlur={() => {
            const trimmed = imageDraft.trim();
            if (trimmed !== (resolved.image ?? '')) {
              mutate((d) => setExecutorImage(d, jobName, trimmed));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          placeholder="cimg/base:current"
          className={`${inputClassName} font-mono`}
        />
      </Field>
      {resolved.serviceImages.length > 0 ? (
        <p className="mb-2 text-2xs text-cc-text-faint">
          +{resolved.serviceImages.length} service container
          {resolved.serviceImages.length > 1 ? 's' : ''} (
          {resolved.serviceImages.join(', ')}) -- not editable here.
        </p>
      ) : null}
      <Field label="Resource class" htmlFor={resourceClassFieldId}>
        <ResourceClassSelect
          id={resourceClassFieldId}
          kind={kind}
          value={resolved.resourceClass ?? ''}
          onChange={(value) =>
            mutate((d) => setJobField(d, jobName, ['resource_class'], value))
          }
        />
      </Field>
    </section>
  );
}

/**
 * The resource-class field for a job that runs on a *named* executor
 * (`resolved.source === 'executor'/'orb'`, or references one that isn't
 * defined). Presents editing as a deliberate choice between "override for
 * this job" (shadows the executor for this job alone, via `setJobField`)
 * and "edit the executor" (changes every job that uses it, via
 * `setExecutorField`) -- issue #27's requirement that neither happens by
 * accident.
 */
function InheritedResourceClassField({
  jobName,
  resolved,
  mutate,
}: {
  jobName: string;
  resolved: ResolvedExecutor;
  mutate: MutateFn;
}) {
  const fieldId = useId();
  const isOverridden = resolved.jobOverrides.includes('resource_class');
  const [mode, setMode] = useState<'view' | 'override' | 'edit-executor'>(
    'view',
  );
  const canEditExecutor =
    resolved.source === 'executor' && resolved.name !== undefined;

  if (isOverridden) {
    return (
      <Field label="Resource class" htmlFor={fieldId}>
        <div className="mb-1.5">
          <Badge tone="info">Overridden for this job</Badge>
        </div>
        <ResourceClassSelect
          id={fieldId}
          kind={resolved.kind}
          ariaLabel="Resource class"
          value={resolved.resourceClass ?? ''}
          onChange={(value) =>
            mutate((d) => setJobField(d, jobName, ['resource_class'], value))
          }
        />
        <Button
          size="sm"
          variant="ghost"
          className="mt-1.5"
          onClick={() =>
            mutate((d) => unsetJobField(d, jobName, ['resource_class']))
          }
        >
          Revert to inherited
        </Button>
      </Field>
    );
  }

  return (
    <Field label="Resource class" htmlFor={fieldId}>
      <div className="mb-1.5 flex items-center gap-2">
        <span id={fieldId} className="font-mono text-xs text-cc-text">
          {resolved.resourceClass ?? 'Not set'}
        </span>
        <Badge tone="neutral">
          {resolved.name ? `Inherited from "${resolved.name}"` : 'Inherited'}
        </Badge>
      </div>
      {mode === 'view' ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setMode('override')}
          >
            Override for this job
          </Button>
          {canEditExecutor ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMode('edit-executor')}
            >
              Edit the executor
            </Button>
          ) : null}
        </div>
      ) : mode === 'override' ? (
        <ResourceClassSelect
          id={`${fieldId}-override`}
          kind={resolved.kind}
          ariaLabel="Resource class"
          value=""
          onChange={(value) => {
            mutate((d) => setJobField(d, jobName, ['resource_class'], value));
            setMode('view');
          }}
        />
      ) : (
        <ResourceClassSelect
          id={`${fieldId}-executor`}
          kind={resolved.kind}
          ariaLabel="Resource class"
          value={resolved.resourceClass ?? ''}
          onChange={(value) => {
            if (resolved.name) {
              mutate((d) =>
                setExecutorField(d, resolved.name!, ['resource_class'], value),
              );
            }
            setMode('view');
          }}
        />
      )}
    </Field>
  );
}

/**
 * A short, honest description of where this job's executor comes from,
 * when it isn't the job's own -- `null` when it is (nothing to explain).
 * Written as a value-returning function over `resolved.source` with a
 * `default` fallback (rather than an exhaustive switch) on purpose: another
 * agent may extend `ResolvedExecutor.source` with a third provenance
 * ("inherited via a YAML anchor") later, and this must keep rendering
 * something sensible for it without a redesign here.
 */
function executorSourceNote(resolved: ResolvedExecutor): string | null {
  if (resolved.source === 'job') return null;
  if (resolved.source === 'executor') {
    return `Inherited from executor "${resolved.name}" (executors:). To change its image, edit the executor directly -- it affects every job that uses it.`;
  }
  if (resolved.source === 'orb') {
    return `This job uses the orb-provided executor "${resolved.name}" -- its image and resource class are defined inside that orb and can't be resolved here.`;
  }
  if (resolved.source === 'none' && resolved.name) {
    return `This job references executor "${resolved.name}", which isn't defined under executors: in this config.`;
  }
  if (resolved.source === 'none') return null;
  return `Inherited (source: "${String(resolved.source)}").`;
}

/** The executor section for a job whose executor is (or was meant to be) a *named* one -- inherited, orb-provided, or dangling. */
function InheritedExecutorFields({
  jobName,
  resolved,
  mutate,
}: {
  jobName: string;
  resolved: ResolvedExecutor;
  mutate: MutateFn;
}) {
  const imageFieldId = useId();
  const note = executorSourceNote(resolved);

  return (
    <section className="mb-4">
      <SectionHeading docsLink={DOCS_LINKS.reusableConfig.executors}>
        Executor
      </SectionHeading>
      {note ? (
        <p className="mb-2 rounded-md border border-cc-border-strong bg-cc-panel-raised p-2 text-2xs text-cc-text-muted">
          {note}
        </p>
      ) : null}
      <Field label="Image" htmlFor={imageFieldId}>
        <p
          id={imageFieldId}
          className="truncate rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5 font-mono text-xs text-cc-text-muted"
        >
          {resolved.unresolvable
            ? 'Defined inside the orb -- not resolvable here.'
            : resolved.image
              ? `${resolved.image}${
                  resolved.serviceImages.length > 0
                    ? ` (+${resolved.serviceImages.length} service container${resolved.serviceImages.length > 1 ? 's' : ''})`
                    : ''
                }`
              : '—'}
        </p>
      </Field>
      {resolved.kind === 'machine' &&
      resolved.dockerLayerCaching !== undefined ? (
        <p className="mb-3 text-2xs text-cc-text-muted">
          Docker Layer Caching:{' '}
          {resolved.dockerLayerCaching ? 'enabled' : 'disabled'} (set on the
          executor)
        </p>
      ) : null}
      <InheritedResourceClassField
        jobName={jobName}
        resolved={resolved}
        mutate={mutate}
      />
    </section>
  );
}

/**
 * Consumes `resolveJobExecutor` (issue #27 -- previously nothing did, so a
 * job on a named executor showed an empty image and "Resource class: Not
 * set" even though the executor plainly defines one) to show the job's
 * *effective* executor, clearly marked as inherited when it comes from a
 * named executor, an orb, or a dangling reference, and edited accordingly.
 */
function ExecutorSection({
  doc,
  jobName,
  mutate,
}: {
  doc: Document;
  jobName: string;
  mutate: MutateFn;
}) {
  const resolved = resolveJobExecutor(doc, jobName);
  const isLocal =
    resolved.source === 'job' ||
    (resolved.source === 'none' && resolved.name === undefined);
  return isLocal ? (
    <LocalExecutorFields
      resolved={resolved}
      jobName={jobName}
      mutate={mutate}
    />
  ) : (
    <InheritedExecutorFields
      jobName={jobName}
      resolved={resolved}
      mutate={mutate}
    />
  );
}

/**
 * The right-hand drawer for `DagPane`: shows and edits the job behind the
 * currently selected graph node. Rendered with `key={node.id}` from the
 * parent so switching selection is a clean remount rather than a pile of
 * reset effects for every draft field.
 */
export function Inspector({
  doc,
  workflowName,
  node,
  workflowSelected = false,
  onRequestDelete,
  autoFocusName,
  onDropOrbCommand,
  onDropPaletteStep,
  onDropOrbCommandOnEntrySteps,
  onDropPaletteStepOnEntrySteps,
}: InspectorProps) {
  const mutate = useAppStore((state) => state.mutate);
  const editError = useAppStore((state) => state.editError);
  const clearEditError = useAppStore((state) => state.clearEditError);
  // Fetched once per app session (see `useCircleciSchema`'s own doc
  // comment) -- `null` here just means "not loaded yet", which every
  // consumer downstream (`StepFieldsSection`, ultimately) already renders a
  // clear "loading fields" state for rather than treating as an error.
  const schema = useCircleciSchema();

  // Alias -> orb reference, read once per render and handed to every steps
  // list, so an `<alias>/<command>` step can resolve which orb it belongs to
  // and therefore what parameters it accepts (issue #252).
  const orbAliases = useMemo(() => readOrbAliases(doc), [doc]);

  // Splits the old single "can this be edited at all" flag into two (issue
  // #37): `canEditJobBody` -- steps/image/resource class, genuinely
  // local-definition-only -- and "everything else" (alias, requires,
  // context, filters, pre/post-steps, invocation parameters), which is
  // ordinary editable workflow config for *every* node kind and is
  // rendered unconditionally below.
  const canEditJobBody = node?.kind === 'job' && node.isDefined;

  // Issue #288: the workflow-level body is rendered instead of a job's own
  // whenever a job isn't selected but the workflow itself is -- see
  // `InspectorProps.workflowSelected`'s own doc comment for why `node`
  // always wins when both happen to be set. Computed once, up front, as a
  // plain `if`/`else` chain building `body` rather than a nested JSX
  // ternary: the job-body branch below reads `node`'s fields directly
  // (`node.kind`, `node.jobName`, ...), and only real control flow -- not a
  // conditional expression -- lets TypeScript narrow `node` to non-null
  // there without every one of those reads needing its own `!`.
  const showWorkflowBody = !node && workflowSelected;

  let body: ReactNode;
  if (!doc || !workflowName || (!node && !showWorkflowBody)) {
    body = (
      <p className="text-xs text-cc-text-muted">
        Select a job in the graph, or click empty canvas (or a workflow tab
        that's already active) to inspect the workflow itself.
      </p>
    );
  } else if (showWorkflowBody) {
    body = (
      <WorkflowInspectorBody
        doc={doc}
        workflowName={workflowName}
        mutate={mutate}
      />
    );
  } else if (node) {
    body = (
      <>
        <div className="mb-3 flex items-center gap-1.5">
          <Badge tone={node.kind === 'job' ? 'neutral' : 'warning'}>
            {node.kind}
          </Badge>
          {!node.isDefined ? <Badge tone="warning">undefined</Badge> : null}
          {node.matrix ? (
            <Badge tone="neutral">
              {/* Issue #284: this node is one of `matrixGroupSize` expanded instances of the same matrix entry -- see `JobNode.tsx`'s own "×N" badge for the canvas equivalent. */}
              matrix
              {node.matrixGroupSize ? ` (1 of ${node.matrixGroupSize})` : ''}
            </Badge>
          ) : null}
        </div>

        <JobIdentitySection
          doc={doc}
          node={node}
          workflowName={workflowName}
          canEditJobBody={canEditJobBody}
          mutate={mutate}
          autoFocusName={autoFocusName}
        />

        {!canEditJobBody ? (
          <p className="mb-4 flex items-start justify-between gap-2 rounded-md border border-cc-border-strong bg-cc-panel-raised p-2.5 text-xs text-cc-text-muted">
            <span>{jobBodyReadOnlyNote(node)}</span>
            {node.kind === 'approval' ? (
              <DocsLink
                label={DOCS_LINKS.workflows.approval.label}
                url={DOCS_LINKS.workflows.approval.url}
              />
            ) : null}
          </p>
        ) : (
          <>
            <ExecutorSection doc={doc} jobName={node.jobName} mutate={mutate} />
            <StepsSection
              root={buildJobStepsRoot(doc, node.jobName, mutate)}
              schema={schema}
              orbAliases={orbAliases}
              sectionKey="steps"
              title="Steps"
              onDropOrbCommand={
                onDropOrbCommand
                  ? (index, payload) =>
                      onDropOrbCommand(node.jobName, index, payload)
                  : undefined
              }
              onDropPaletteStep={
                onDropPaletteStep
                  ? (index, stepKey) =>
                      onDropPaletteStep(node.jobName, index, stepKey)
                  : undefined
              }
            />
            <DeclaredParametersSection
              doc={doc}
              jobName={node.jobName}
              mutate={mutate}
            />
          </>
        )}

        {/*
          Issue #252: an orb job's parameters render *here*, immediately
          below the note that explains why there are no steps to edit --
          taking the slot the job body occupies for a local job, because
          for an orb job they are the equivalent thing: the content you
          came to this pane to change.

          They used to be second-to-last, below Context, Filters,
          Pre-steps and Post-steps, which is what made the owner's "maybe
          I do if you scroll down" a necessary discovery rather than an
          obvious one. Rewording the note (see `jobBodyReadOnlyNote`)
          without moving this would have fixed the sentence and left the
          scroll.
        */}
        {node.kind === 'orb' ? (
          <OrbJobParamsSection
            doc={doc}
            node={node}
            workflowName={workflowName}
            mutate={mutate}
          />
        ) : null}

        <WorkflowEntryOptionsSection
          node={node}
          workflowName={workflowName}
          mutate={mutate}
          schema={schema}
          orbAliases={orbAliases}
          onDropOrbCommandOnEntrySteps={onDropOrbCommandOnEntrySteps}
          onDropPaletteStepOnEntrySteps={onDropPaletteStepOnEntrySteps}
        />

        {/*
          A local job's own call-site parameters keep their old position at
          the end of the workflow-entry options: unlike an orb job, its
          body is right there above, so nothing is hidden by leaving these
          last, and moving them would be a change #252 did not ask for.
        */}
        {node.kind === 'job' && node.isDefined ? (
          <LocalJobParamsSection
            doc={doc}
            node={node}
            workflowName={workflowName}
            mutate={mutate}
          />
        ) : null}
        <RequiresSection
          node={node}
          workflowName={workflowName}
          mutate={mutate}
        />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-cc-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-cc-text-muted">
          Inspector
        </h3>
        {node ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRequestDelete(node.id)}
            aria-label={`Remove "${node.alias}" from the graph`}
          >
            Remove
          </Button>
        ) : null}
      </div>

      {/*
        `overflow-x-hidden` is a deliberate safety net on top of the
        per-row `min-w-0`/`truncate` fix (see `StepRow`): if some future
        row type is missed by that audit, this clips it instead of letting
        it spill past the panel's right edge the way issue #28's orb steps
        did.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3">
        {editError ? (
          <EditErrorBanner message={editError} onDismiss={clearEditError} />
        ) : null}
        {body}
      </div>
    </div>
  );
}
