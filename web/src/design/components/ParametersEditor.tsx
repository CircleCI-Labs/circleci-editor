/**
 * The editor for one `parameters:` block -- issue #250. One component, two
 * mount points:
 *
 *  - the palette's Parameters section, for the config's **top-level**
 *    `parameters:` (pipeline parameters);
 *  - the inspector's "Declared parameters" section, for the selected job's
 *    **own** `parameters:`.
 *
 * Those are different namespaces with different type sets and different
 * reference syntax (see `parameterReferences.ts`), but they are the same *form*:
 * a list of named definitions, each with a type, an optional default, an
 * optional description, and for `enum` a list of values. Writing that form twice
 * would guarantee the two drifted -- and the drift would be invisible, because
 * no user sees both at once. So the shape lives here and the scope is a prop,
 * exactly the reasoning that put `ReferenceImpactList` in this directory rather
 * than in whichever pane happened to need it first.
 *
 * ## Why it lives in `design/components`
 *
 * It is shared by two panes and owned by neither, which is what this directory
 * is for (`ReferenceImpactList`, `ResourceClassField`, `XcodeVersionField` are
 * all domain-aware for the same reason). It takes `mutate` rather than reaching
 * for `useAppStore` itself, matching how every inspector section receives it.
 *
 * ## The type control is closed, with no escape hatch
 *
 * Deliberately a bare `<select>` over the schema's own enum, and deliberately
 * *not* `PresetSelectField`: that component's whole point is an "Other..."
 * option for a value CircleCI supports before our snapshot knows about it, and
 * there is no such value here. `type:` is validated against a closed enum by the
 * compiler; a free-text type is not a config that might work, it is a config
 * that certainly will not. The options come from `useCircleciSchema` rather than
 * a literal in this file, and when that fetch has failed there are no options
 * and adding a parameter is disabled -- offering `string` as a guess would be
 * inventing a type, which issue #250 rules out in as many words.
 *
 * ## Nothing here is a drag source
 *
 * The rows are `<li>`s containing form controls, not `PaletteCard` buttons, and
 * the palette section says so in prose. A parameter has no single drop target:
 * it is referenced by *writing text* (`<< parameters.name >>`) inside an
 * arbitrary field, so "drag it onto a job" has no one meaning (the original
 * read-only section's doc comment made this argument and it is still right --
 * what was wrong was concluding the section should therefore do nothing).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { Document } from 'yaml';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { ReferenceImpactList } from '~/design/components/ReferenceImpactList';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  addParameter,
  listParameters,
  removeParameter,
  removeParameterEnumValues,
  renameParameter,
  setParameterDefault,
  setParameterDescription,
  setParameterEnumValues,
  setParameterType,
  validateParameterName,
  type ParameterSummary,
} from '~/lib/mutations/parameterMutations';
import {
  describeParameterDeleteImpact,
  describeParameterRenameImpact,
  findParameterReferences,
  parameterRenameNeedsConfirmation,
  referenceExpression,
  type ParameterScope,
} from '~/lib/mutations/parameterReferences';
import { useCircleciSchema } from '~/lib/schema/useCircleciSchema';
import { useConfirmStore } from '~/state/confirmStore';

/** Signature every mutation call here goes through -- `useAppStore`'s `mutate`, same as `Inspector`'s own `MutateFn`. */
type MutateFn = (fn: (doc: Document) => void) => void;

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1 text-2xs text-cc-text outline-none focus-visible:border-cc-accent';

const labelClassName = 'mb-0.5 block text-2xs text-cc-text-faint';

/** The `<select>` value standing for "no type chosen yet" in the add form. Not a legal type, so it cannot collide with one. */
const NO_TYPE = '';

/** The `<select>` value standing for "no default set". Not a legal default for any type we render a select for (`boolean`, `enum`), both of whose values are non-empty strings. */
const NO_DEFAULT = '__unset__';

/**
 * Types whose `default:` is a structured value (a step list, an executor
 * reference) rather than a scalar. Element scope only. This editor shows the
 * default read-only for these and points at the YAML pane, rather than
 * flattening a step list into a text box -- an editor that round-trips a
 * structured value through a string is how comments and nesting get destroyed.
 */
const STRUCTURED_DEFAULT_TYPES = new Set(['steps', 'executor']);

function scopeNoun(scope: ParameterScope): string {
  return scope.kind === 'pipeline' ? 'pipeline parameter' : 'parameter';
}

/**
 * Renders and edits `scope`'s `parameters:`.
 *
 * `doc` may be `null` (no config parsed yet), in which case there is nothing to
 * read and nothing to write, and the section says so rather than offering an
 * add form whose submit would be swallowed by `mutate`'s parse-error guard.
 */
export function ParametersEditor({
  doc,
  scope,
  mutate,
}: {
  doc: Document | null;
  scope: ParameterScope;
  mutate: MutateFn;
}) {
  const schema = useCircleciSchema();

  // Deliberately not memoized. `scope` is a fresh object literal at every call
  // site, so a `useMemo` keyed on it would recompute every render anyway -- and
  // one keyed on its fields instead would need a lint suppression to say so.
  // Both reads are a walk over one small map; the honest version is the cheap
  // one here.
  const parameters = doc ? listParameters(doc, scope) : [];
  const typeOptions = (
    scope.kind === 'pipeline'
      ? (schema?.pipelineParameterTypeValues ?? [])
      : (schema?.elementParameterTypeValues ?? [])
  ).map((item) => item.label);

  if (!doc) {
    return (
      <p className="text-2xs text-cc-text-faint">
        No config loaded, so there are no parameters to show.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {parameters.length === 0 ? (
        <p className="text-2xs text-cc-text-faint">
          {scope.kind === 'pipeline'
            ? 'No pipeline parameters yet. One lets a single config serve several call sites -- an API trigger versus a manual run -- without duplicating jobs.'
            : 'This job declares no parameters of its own yet. One lets the same job definition run several ways, with the value supplied at each workflow entry.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {parameters.map((parameter) => (
            <ParameterRow
              key={parameter.name}
              doc={doc}
              scope={scope}
              parameter={parameter}
              typeOptions={typeOptions}
              mutate={mutate}
            />
          ))}
        </ul>
      )}

      <AddParameterForm
        scope={scope}
        typeOptions={typeOptions}
        schemaLoaded={schema !== null}
        mutate={mutate}
      />
    </div>
  );
}

/**
 * One parameter's own fields. Every control commits the way the inspector's
 * fields do -- text on blur or Enter, selects and checkboxes immediately --
 * because each commit is one `mutate` call and therefore one undo entry, and a
 * per-keystroke undo entry for a description would make undo useless.
 */
function ParameterRow({
  doc,
  scope,
  parameter,
  typeOptions,
  mutate,
}: {
  doc: Document;
  scope: ParameterScope;
  parameter: ParameterSummary;
  typeOptions: string[];
  mutate: MutateFn;
}) {
  const fieldPrefix = useId();
  const { name } = parameter;
  const expression = referenceExpression(scope, name);

  const [pendingRemove, setPendingRemove] = useState(false);

  // A shared anchor's definition is not this editor's to rewrite: an edit here
  // would silently change every other parameter aliasing it. Shown, explained,
  // and left to the YAML pane -- the same call `documentUtils` makes for a
  // merge-inherited field elsewhere.
  if (parameter.shared) {
    return (
      <li className="rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-cc-text">
            {name}
          </span>
          <Badge tone="warning">shared</Badge>
        </div>
        <p className="mt-1 text-2xs text-cc-text-faint">
          This definition is a YAML anchor or alias, so it is shared with
          something else in the file. Editing it here would change every user of
          it at once; edit it in the YAML pane instead.
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <NameField
            doc={doc}
            scope={scope}
            name={name}
            fieldId={`${fieldPrefix}-name`}
            mutate={mutate}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${scopeNoun(scope)} ${name}`}
          onClick={() => setPendingRemove(true)}
        >
          Remove
        </Button>
      </div>

      <p className="mt-1 font-mono text-2xs text-cc-text-faint">
        {`<< ${expression} >>`}
      </p>

      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <label className={labelClassName} htmlFor={`${fieldPrefix}-type`}>
            Type
          </label>
          <select
            id={`${fieldPrefix}-type`}
            aria-label={`Type of ${name}`}
            value={parameter.type ?? NO_TYPE}
            onChange={(event) =>
              mutate((d) =>
                setParameterType(d, scope, name, event.target.value),
              )
            }
            className={`${inputClassName} font-mono`}
          >
            {/* Only offered when the config genuinely has no `type:` -- so the
                control shows the truth rather than defaulting the display to
                `string`, and so choosing a type is the only move available. */}
            {parameter.type === undefined ? (
              <option value={NO_TYPE} disabled>
                Not set
              </option>
            ) : null}
            {typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {/* A type the schema does not enumerate is still shown rather than
                silently swapped for one that is -- the config says what it
                says. */}
            {parameter.type !== undefined &&
            !typeOptions.includes(parameter.type) ? (
              <option value={parameter.type}>
                {`${parameter.type} (not a known type)`}
              </option>
            ) : null}
          </select>
        </div>

        <DefaultField
          scope={scope}
          parameter={parameter}
          fieldId={`${fieldPrefix}-default`}
          mutate={mutate}
        />
      </div>

      <div className="mt-1.5">
        <label
          className={labelClassName}
          htmlFor={`${fieldPrefix}-description`}
        >
          Description
        </label>
        <TextCommitField
          id={`${fieldPrefix}-description`}
          ariaLabel={`Description of ${name}`}
          value={parameter.description ?? ''}
          placeholder="Optional"
          onCommit={(next) =>
            mutate((d) =>
              setParameterDescription(
                d,
                scope,
                name,
                next === '' ? undefined : next,
              ),
            )
          }
        />
      </div>

      {parameter.type === 'enum' || parameter.enumValues.length > 0 ? (
        <EnumValuesField
          scope={scope}
          parameter={parameter}
          fieldId={`${fieldPrefix}-enum`}
          mutate={mutate}
        />
      ) : null}

      {scope.kind === 'pipeline' && !parameter.hasDefault ? (
        <p className="mt-1.5 text-2xs text-cc-warning">
          A pipeline parameter needs a{' '}
          <span className="font-mono">default:</span> -- CircleCI requires one,
          because a trigger may not supply a value. Nothing has been written for
          you; set one above.
        </p>
      ) : null}

      {pendingRemove ? (
        <RemoveParameterConfirm
          doc={doc}
          scope={scope}
          name={name}
          onConfirm={() => {
            mutate((d) => removeParameter(d, scope, name));
            setPendingRemove(false);
          }}
          onCancel={() => setPendingRemove(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * The name field, and therefore the rename. Prompts with the enumerated impact
 * before touching anything when the parameter is referenced anywhere -- which,
 * unlike a job name, is *always* somewhere the user cannot see from here.
 *
 * The whole reconciliation is one `renameParameter` call inside one `mutate`, so
 * a rename touching N sites is one undo step (issue #250, matching issue #12's
 * guarantee for jobs).
 */
function NameField({
  doc,
  scope,
  name,
  fieldId,
  mutate,
}: {
  doc: Document;
  scope: ParameterScope;
  name: string;
  fieldId: string;
  mutate: MutateFn;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const suppressed = useConfirmStore((s) => s.suppressed);
  const suppress = useConfirmStore((s) => s.suppress);

  // A rename replaces this row's key, so React remounts the row with the new
  // name; a *rejected* rename leaves the old one. Either way the draft has to
  // follow the document rather than the last thing typed.
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const apply = (newName: string) => {
    mutate((d) => renameParameter(d, scope, name, newName));
    setPending(null);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === name) {
      setError(null);
      return;
    }
    const invalid = validateParameterName(trimmed);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    // Prompt only when there is something the user cannot see from here -- which
    // for a parameter is every reference, since they live inside the text of
    // fields in other panes entirely.
    const refs = findParameterReferences(doc, scope, name);
    if (
      !parameterRenameNeedsConfirmation(refs) ||
      suppressed.includes('renameParameter')
    ) {
      apply(trimmed);
      return;
    }
    setPending(trimmed);
  };

  return (
    <>
      <label className={labelClassName} htmlFor={fieldId}>
        Name
      </label>
      <input
        id={fieldId}
        ref={inputRef}
        aria-label={`Name of ${name}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            inputRef.current?.blur();
          }
        }}
        className={`${inputClassName} font-mono`}
        aria-invalid={error ? true : undefined}
      />
      {error ? <p className="mt-1 text-2xs text-cc-danger">{error}</p> : null}
      {pending !== null ? (
        <RenameParameterConfirm
          doc={doc}
          scope={scope}
          name={name}
          newName={pending}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) suppress('renameParameter');
            apply(pending);
          }}
          onCancel={() => {
            setPending(null);
            setDraft(name);
            inputRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The `default:` control, shaped by the declared type -- and in every shape,
 * able to express "not set" and never starting out as anything else.
 *
 * That last part is the constraint doing the work: `boolean` renders as a
 * three-option select (Not set / true / false) rather than a checkbox, because a
 * checkbox has no third state and would show `false` for a parameter with no
 * default at all -- and one blur later would have written it.
 */
function DefaultField({
  scope,
  parameter,
  fieldId,
  mutate,
}: {
  scope: ParameterScope;
  parameter: ParameterSummary;
  fieldId: string;
  mutate: MutateFn;
}) {
  const { name, type } = parameter;
  const commit = (value: unknown) =>
    mutate((d) => setParameterDefault(d, scope, name, value));

  const label = (
    <label className={labelClassName} htmlFor={fieldId}>
      Default
    </label>
  );

  if (type !== undefined && STRUCTURED_DEFAULT_TYPES.has(type)) {
    return (
      <div>
        {label}
        <p
          id={fieldId}
          className="rounded-md border border-cc-border bg-cc-panel px-2 py-1 text-2xs text-cc-text-faint"
        >
          {parameter.hasDefault
            ? `A ${type} default is structured -- edit it in the YAML pane.`
            : 'Not set'}
        </p>
      </div>
    );
  }

  if (type === 'boolean') {
    const current = parameter.hasDefault
      ? String(parameter.default === true)
      : NO_DEFAULT;
    return (
      <div>
        {label}
        <select
          id={fieldId}
          aria-label={`Default of ${name}`}
          value={current}
          onChange={(event) =>
            commit(
              event.target.value === NO_DEFAULT
                ? undefined
                : event.target.value === 'true',
            )
          }
          className={`${inputClassName} font-mono`}
        >
          <option value={NO_DEFAULT}>Not set</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>
    );
  }

  if (type === 'enum') {
    const current = parameter.hasDefault
      ? String(parameter.default)
      : NO_DEFAULT;
    return (
      <div>
        {label}
        <select
          id={fieldId}
          aria-label={`Default of ${name}`}
          value={current}
          onChange={(event) =>
            commit(
              event.target.value === NO_DEFAULT
                ? undefined
                : event.target.value,
            )
          }
          className={`${inputClassName} font-mono`}
        >
          <option value={NO_DEFAULT}>Not set</option>
          {parameter.enumValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
          {/* A default outside the declared values is invalid config, and shown
              as such rather than quietly replaced. */}
          {current !== NO_DEFAULT && !parameter.enumValues.includes(current) ? (
            <option value={current}>{`${current} (not in enum:)`}</option>
          ) : null}
        </select>
      </div>
    );
  }

  const isInteger = type === 'integer';
  return (
    <div>
      {label}
      <TextCommitField
        id={fieldId}
        ariaLabel={`Default of ${name}`}
        value={parameter.hasDefault ? String(parameter.default ?? '') : ''}
        placeholder="Not set"
        inputMode={isInteger ? 'numeric' : undefined}
        onCommit={(next) => {
          if (next === '') {
            commit(undefined);
            return;
          }
          if (!isInteger) {
            commit(next);
            return;
          }
          const parsed = Number(next);
          if (!Number.isInteger(parsed)) {
            // Refused rather than coerced: writing `0` for "abc" would be
            // inventing a default. `mutate`'s own error channel surfaces this.
            mutate(() => {
              throw new Error(
                `"${next}" is not an integer, so it cannot be ${name}'s default.`,
              );
            });
            return;
          }
          commit(parsed);
        }}
      />
    </div>
  );
}

/**
 * The `enum:` value list, and the answer to issue #250's "a type change away
 * from `enum` has to do something sensible with them rather than silently
 * dropping data".
 *
 * It stays rendered when the type is no longer `enum` but values are still
 * present, saying they are now inert and offering one button to discard them.
 * The type change itself never touches them (see `setParameterType`), so no
 * dropdown change can lose a list.
 */
function EnumValuesField({
  scope,
  parameter,
  fieldId,
  mutate,
}: {
  scope: ParameterScope;
  parameter: ParameterSummary;
  fieldId: string;
  mutate: MutateFn;
}) {
  const { name, enumValues } = parameter;
  const [draft, setDraft] = useState('');
  const inert = parameter.type !== 'enum';

  const addValue = () => {
    const trimmed = draft.trim();
    if (trimmed === '' || enumValues.includes(trimmed)) return;
    mutate((d) =>
      setParameterEnumValues(d, scope, name, [...enumValues, trimmed]),
    );
    setDraft('');
  };

  return (
    <div className="mt-1.5">
      <label className={labelClassName} htmlFor={fieldId}>
        Allowed values
      </label>
      {enumValues.length > 0 ? (
        <ul className="mb-1 flex flex-wrap gap-1">
          {enumValues.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1 rounded border border-cc-border bg-cc-panel px-1 font-mono text-2xs text-cc-text"
            >
              {value}
              <button
                type="button"
                aria-label={`Remove allowed value ${value} from ${name}`}
                onClick={() =>
                  mutate((d) =>
                    setParameterEnumValues(
                      d,
                      scope,
                      name,
                      enumValues.filter((candidate) => candidate !== value),
                    ),
                  )
                }
                className="text-cc-text-faint hover:text-cc-danger"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-1">
        <input
          id={fieldId}
          aria-label={`Add an allowed value to ${name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addValue();
            }
          }}
          placeholder="value"
          className={`${inputClassName} font-mono`}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Add the allowed value typed for ${name}`}
          onClick={addValue}
        >
          Add
        </Button>
      </div>
      {inert ? (
        <div className="mt-1 text-2xs text-cc-warning">
          <p>
            {`${name} is now type ${parameter.type ?? 'unset'}, so these values no longer constrain anything. They were kept rather than deleted with the type change -- discard them when you are sure.`}
          </p>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Discard the unused allowed values of ${name}`}
            onClick={() =>
              mutate((d) => removeParameterEnumValues(d, scope, name))
            }
          >
            Discard them
          </Button>
        </div>
      ) : enumValues.length === 0 ? (
        <p className="mt-1 text-2xs text-cc-warning">
          An <span className="font-mono">enum</span> parameter needs at least
          one allowed value. None has been invented for you.
        </p>
      ) : null}
    </div>
  );
}

/** The add form. Its type select starts on "Choose a type", and Add stays disabled until one is picked -- the editor never picks a type on the user's behalf. */
function AddParameterForm({
  scope,
  typeOptions,
  schemaLoaded,
  mutate,
}: {
  scope: ParameterScope;
  typeOptions: string[];
  schemaLoaded: boolean;
  mutate: MutateFn;
}) {
  const fieldPrefix = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<string>(NO_TYPE);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    const invalid = validateParameterName(trimmed);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (type === NO_TYPE) {
      setError('Choose a type.');
      return;
    }
    setError(null);
    // Only `name` and `type` are written. No default, no description, no enum
    // values -- each of those is a decision the user makes next, in the row that
    // just appeared, and writing a placeholder for any of them would be exactly
    // the invention issue #250 forbids.
    mutate((d) => addParameter(d, scope, trimmed, { type }));
    setName('');
    setType(NO_TYPE);
  };

  const canAdd = typeOptions.length > 0;

  return (
    <div className="rounded-md border border-dashed border-cc-border-strong px-2 py-1.5">
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
        {`Add a ${scopeNoun(scope)}`}
      </p>
      <div className="flex items-end gap-1">
        <div className="min-w-0 flex-1">
          <label className={labelClassName} htmlFor={`${fieldPrefix}-name`}>
            Name
          </label>
          <input
            id={`${fieldPrefix}-name`}
            // Explicit, and explicitly *not* just "Name": every row above has a
            // "Name" label too, so a bare one would leave several controls
            // sharing an accessible name -- ambiguous for a screen reader
            // reading the section, and ambiguous for a test.
            aria-label={`Name of the new ${scopeNoun(scope)}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="deploy-env"
            className={`${inputClassName} font-mono`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <label className={labelClassName} htmlFor={`${fieldPrefix}-type`}>
            Type
          </label>
          <select
            id={`${fieldPrefix}-type`}
            aria-label={`Type of the new ${scopeNoun(scope)}`}
            value={type}
            onChange={(event) => setType(event.target.value)}
            className={`${inputClassName} font-mono`}
          >
            <option value={NO_TYPE}>Choose a type</option>
            {typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Add ${scopeNoun(scope)}`}
          onClick={submit}
          disabled={!canAdd}
          title={
            canAdd
              ? undefined
              : 'The config schema has not loaded, so the valid types are not known yet.'
          }
        >
          Add
        </Button>
      </div>
      {error ? <p className="mt-1 text-2xs text-cc-danger">{error}</p> : null}
      {!canAdd && schemaLoaded ? (
        <p className="mt-1 text-2xs text-cc-warning">
          The config schema could not be read, so the valid parameter types are
          not known. Nothing is guessed here -- add the parameter in the YAML
          pane, or retry once the editor can reach its host.
        </p>
      ) : null}
      <p className="mt-1 flex items-center gap-1 text-2xs text-cc-text-faint">
        {scope.kind === 'pipeline'
          ? 'Supplied when a pipeline is triggered.'
          : 'Supplied at each workflow entry that runs this job.'}
        <DocsLink
          label={DOCS_LINKS.guides.pipelineVariables.label}
          url={DOCS_LINKS.guides.pipelineVariables.url}
        />
      </p>
    </div>
  );
}

/** A text input that reports its value on blur or Enter, never per keystroke -- each report is a YAML mutation and an undo entry. */
function TextCommitField({
  id,
  ariaLabel,
  value,
  placeholder,
  inputMode,
  onCommit,
}: {
  id: string;
  ariaLabel: string;
  value: string;
  placeholder?: string;
  inputMode?: 'numeric';
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <input
      id={id}
      ref={inputRef}
      aria-label={ariaLabel}
      value={draft}
      inputMode={inputMode}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value) onCommit(trimmed);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          inputRef.current?.blur();
        }
      }}
      placeholder={placeholder}
      className={`${inputClassName} font-mono`}
    />
  );
}

/**
 * The rename prompt. Inline in the row rather than a modal, for the reason
 * `RenameJobConfirm` is: the rename is an inline field edit, and a modal over
 * the whole app for a one-line change reads as more alarming than the edit
 * warrants.
 */
function RenameParameterConfirm({
  doc,
  scope,
  name,
  newName,
  onConfirm,
  onCancel,
}: {
  doc: Document;
  scope: ParameterScope;
  name: string;
  newName: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const impact = describeParameterRenameImpact(doc, scope, name, newName);
  const blocked = impact.blockers.length > 0;

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Rename "${name}" to "${newName}"?`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mt-2 rounded-md border border-cc-border-strong bg-cc-panel p-2 outline-none"
    >
      <ReferenceImpactList impact={impact} />
      {blocked ? null : (
        <label className="mt-2 flex items-center gap-2 text-2xs text-cc-text-muted">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
            className="h-3.5 w-3.5 shrink-0 accent-cc-accent"
          />
          Don&apos;t ask again (references are still updated either way)
        </label>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={blocked}
          onClick={() => onConfirm(dontAskAgain)}
        >
          Rename
        </Button>
      </div>
    </div>
  );
}

/**
 * The remove prompt. Unsuppressible, unlike the rename: removing a parameter
 * *cannot* be fully reconciled -- the references to it are left pointing at
 * nothing on purpose (see `describeParameterDeleteImpact`) -- so the list of
 * what will break is the whole value of the prompt, and a "don't ask again" here
 * would be a switch for hiding it.
 */
function RemoveParameterConfirm({
  doc,
  scope,
  name,
  onConfirm,
  onCancel,
}: {
  doc: Document;
  scope: ParameterScope;
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const impact = describeParameterDeleteImpact(doc, scope, name);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Remove "${name}"?`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mt-2 rounded-md border border-cc-border-strong bg-cc-panel p-2 outline-none"
    >
      <ReferenceImpactList impact={impact} />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm}>
          Remove
        </Button>
      </div>
    </div>
  );
}
