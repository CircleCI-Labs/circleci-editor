/**
 * The "fill in required parameters before I insert this" dialog. Opened by
 * `useOrbInsertion` only when the dropped/added element has at least one
 * *required* parameter -- an element with none inserts immediately (see
 * that hook), so this component only ever renders a non-empty form.
 *
 * Deliberately scoped to required parameters only, not the element's full
 * parameter list: required parameters are exactly the ones that determine
 * whether the inserted config is well-formed, which is the whole reason
 * this gate exists. Optional parameters already have a usable default (the
 * orb's own), and omitting them from the written config -- rather than
 * echoing a redundant copy of that default -- is the same philosophy
 * `snippets.ts#defaultParamValues` already applies; a user who wants to
 * override one can still do so afterwards in the YAML or the inspector.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixSwitch from '@radix-ui/react-switch';
import { useId, useState } from 'react';

import { Button } from '~/design/components/Button';
import { defaultParamValues } from '~/lib/orbs/snippets';
import type { OrbElement } from '~/lib/orbs/types';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** Parameter types whose value is required to be non-empty text before the form can submit. */
function isTextLike(type: OrbElement['parameters'][number]['type']): boolean {
  return (
    type === 'string' ||
    type === 'env_var_name' ||
    type === 'executor' ||
    type === 'steps'
  );
}

function ParamField({
  parameter,
  value,
  onChange,
}: {
  parameter: OrbElement['parameters'][number];
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const fieldId = useId();
  const labelId = useId();

  return (
    <div className="mb-3">
      <label
        id={labelId}
        htmlFor={fieldId}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        {parameter.name} <span className="text-cc-danger">*</span>
      </label>
      {parameter.description ? (
        <p className="mb-1 text-2xs text-cc-text-faint">
          {parameter.description}
        </p>
      ) : null}

      {parameter.type === 'boolean' ? (
        <RadixSwitch.Root
          id={fieldId}
          checked={Boolean(value)}
          onCheckedChange={onChange}
          className="relative h-4 w-7 rounded-full bg-cc-border-interactive outline-none data-[state=checked]:bg-cc-accent"
        >
          <RadixSwitch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-cc-text transition-transform duration-150 data-[state=checked]:translate-x-[14px]" />
        </RadixSwitch.Root>
      ) : parameter.type === 'integer' ? (
        <input
          id={fieldId}
          type="number"
          value={typeof value === 'number' ? value : 0}
          onChange={(event) => onChange(Number(event.target.value))}
          className={inputClassName}
        />
      ) : parameter.type === 'enum' ? (
        <select
          id={fieldId}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className={inputClassName}
        >
          {(parameter.enumValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            id={fieldId}
            type="text"
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
            className={`${inputClassName} font-mono`}
            aria-describedby={
              parameter.type === 'executor' || parameter.type === 'steps'
                ? `${fieldId}-note`
                : undefined
            }
          />
          {parameter.type === 'executor' || parameter.type === 'steps' ? (
            <p
              id={`${fieldId}-note`}
              className="mt-1 text-2xs text-cc-text-faint"
            >
              This is a complex ({parameter.type}) value -- a plain string may
              not be enough; edit the YAML directly for anything beyond a simple
              reference.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Renders when `element` is non-null. `onSubmit` receives the values for
 * every required parameter (pre-filled via `defaultParamValues`, then
 * edited by the user).
 */
export function ParamsDialog({
  element,
  onSubmit,
  onCancel,
}: {
  element: OrbElement | null;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const requiredParams = element?.parameters.filter((p) => p.required) ?? [];
  // Defensive gate matching `useOrbInsertion.beginInsertion`'s own "only
  // open when there's something required" rule: that hook never sets a
  // pending element with no required parameters, but this component
  // shouldn't rely on every caller getting that right.
  const effectiveElement = requiredParams.length > 0 ? element : null;
  return (
    <ParamsDialogInner
      key={effectiveElement?.name ?? 'none'}
      element={effectiveElement}
      requiredParams={requiredParams}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/** Split out so `key={element?.name}` above forces a fresh `values` init per element, without a reset effect. */
function ParamsDialogInner({
  element,
  requiredParams,
  onSubmit,
  onCancel,
}: {
  element: OrbElement | null;
  requiredParams: OrbElement['parameters'];
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    element ? defaultParamValues(element) : {},
  );
  const titleId = useId();

  const canSubmit = requiredParams.every((param) => {
    if (!isTextLike(param.type)) return true;
    return String(values[param.name] ?? '').trim().length > 0;
  });

  return (
    <RadixDialog.Root
      open={element !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <RadixDialog.Content
          aria-describedby={undefined}
          aria-labelledby={titleId}
          className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-cc-border-strong bg-cc-panel shadow-xl"
        >
          <div className="border-b border-cc-border px-4 py-3">
            <RadixDialog.Title
              id={titleId}
              className="text-sm font-semibold text-cc-text"
            >
              {element ? `Configure "${element.name}"` : 'Configure element'}
            </RadixDialog.Title>
            <p className="mt-0.5 text-2xs text-cc-text-muted">
              This element has required parameters -- fill them in before it's
              added.
            </p>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
            {requiredParams.map((param) => (
              <ParamField
                key={param.name}
                parameter={param}
                value={values[param.name]}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, [param.name]: value }))
                }
              />
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              onClick={() => onSubmit(values)}
            >
              Add
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
