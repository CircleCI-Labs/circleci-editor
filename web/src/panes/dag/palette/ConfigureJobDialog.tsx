/**
 * The "how do we configure it, what's the name of the job" dialog (issue
 * #71's own framing) that opens whenever an executor from the palette is
 * dropped on the canvas, or its card is clicked -- the one point where the
 * two halves of "drop an executor, get a job" (see
 * `configMutations.addJobFromExecutor`) are collected before they're
 * written as a single undoable mutation.
 *
 * Mirrors `ParamsDialog.tsx`'s Radix Dialog conventions (overlay, centered
 * content, header/body/footer) rather than inventing a second dialog shape
 * in this app.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '~/design/components/Button';
import { ResourceClassField } from '~/design/components/ResourceClassField';
import { XcodeVersionField } from '~/design/components/XcodeVersionField';
import type { DockerAuthSpec } from '~/lib/mutations/configMutations';
import {
  environmentsByIds,
  resolveInitialResourceClass,
} from '~/lib/resourceClasses/resourceClassOptions';
import { useResourceClasses } from '~/lib/resourceClasses/useResourceClasses';
import { useXcodeVersions } from '~/lib/xcodeVersions/useXcodeVersions';
import { resolveInitialXcodeVersion } from '~/lib/xcodeVersions/xcodeVersionOptions';

import {
  DockerAuthFields,
  EMPTY_DOCKER_AUTH_FIELDS,
  resolveDockerAuthSpec,
  type DockerAuthFieldsValue,
} from './DockerAuthFields';
import { DockerImagePicker } from './DockerImagePicker';
import { MachineImagePicker } from './MachineImagePicker';
import type { BuiltinExecutorDef } from './paletteExecutors';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** What `ConfigureJobDialog` is configuring -- one dropped/clicked palette executor, however it was sourced. `defaultJobName` is computed by the caller (`generateUniqueJobName`) so this component doesn't need `dagUtils` or the store's job-name list itself. */
export type PendingExecutorItem =
  | { source: 'builtin'; def: BuiltinExecutorDef; defaultJobName: string }
  | { source: 'local'; executorName: string; defaultJobName: string }
  | {
      source: 'orb';
      orbRef: string;
      executorName: string;
      defaultJobName: string;
    };

export interface ConfigureJobSubmitValues {
  jobName: string;
  image?: string;
  resourceClass?: string;
  /** Set iff the user checked "Save as a reusable executor" -- only offered for a `builtin` item. */
  saveAsExecutorName?: string;
  /**
   * Registry auth for a `docker` builtin item, omitted whenever the user
   * left "Registry authentication" at "None" (issue #77, part 2) -- see
   * `DockerAuthFields.tsx` for why the password/secret fields it can carry
   * are always an environment-variable reference, never a literal secret.
   */
  dockerAuth?: DockerAuthSpec;
}

/** `true` iff `name` is legal as both a YAML plain-scalar map key and (for `saveAsExecutorName`) an executor name -- word characters, hyphens, dots; CircleCI job/executor names in practice are always this shape, and rejecting anything else up front avoids handing `configMutations` a name that would round-trip oddly quoted. */
function isValidName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

function nameError(
  name: string,
  existingNames: readonly string[],
  label: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return `${label} is required.`;
  if (!isValidName(trimmed)) {
    return `${label} can only contain letters, digits, "-", "_", and ".".`;
  }
  if (existingNames.includes(trimmed)) return `"${trimmed}" already exists.`;
  return null;
}

function Field({
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

export function ConfigureJobDialog({
  item,
  existingJobNames,
  existingExecutorNames,
  onSubmit,
  onCancel,
}: {
  item: PendingExecutorItem | null;
  existingJobNames: readonly string[];
  existingExecutorNames: readonly string[];
  onSubmit: (values: ConfigureJobSubmitValues) => void;
  onCancel: () => void;
}) {
  return (
    <ConfigureJobDialogInner
      key={item ? `${item.source}:${item.defaultJobName}` : 'none'}
      item={item}
      existingJobNames={existingJobNames}
      existingExecutorNames={existingExecutorNames}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

function ConfigureJobDialogInner({
  item,
  existingJobNames,
  existingExecutorNames,
  onSubmit,
  onCancel,
}: {
  item: PendingExecutorItem | null;
  existingJobNames: readonly string[];
  existingExecutorNames: readonly string[];
  onSubmit: (values: ConfigureJobSubmitValues) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const jobNameId = useId();
  const imageId = useId();
  const resourceClassId = useId();
  const saveAsExecutorId = useId();
  const executorNameId = useId();

  const builtin = item?.source === 'builtin' ? item.def : null;

  const [jobName, setJobName] = useState(item?.defaultJobName ?? '');
  /**
   * `null` until the user touches the field, so a card whose `defaultImage` is
   * empty (macOS -- see `paletteExecutors.ts`) can have its initial value *derived*
   * from what the host offers, which arrives a tick after the dialog opens. The
   * same shape as `chosenResourceClass` below, and for the same reason: freezing
   * either at first render is how a value nobody chose ends up written to a file.
   */
  const [chosenImage, setChosenImage] = useState<string | null>(null);
  // `null` until the user picks one, so the preselected class stays *derived*
  // from whatever CircleCI's tables currently offer (see
  // `resolveInitialResourceClass`) instead of being frozen at first render --
  // the resource classes arrive from the host a tick after the dialog opens.
  const [chosenResourceClass, setChosenResourceClass] = useState<string | null>(
    null,
  );
  const [saveAsExecutor, setSaveAsExecutor] = useState(false);
  const [executorName, setExecutorName] = useState(
    item ? `${item.defaultJobName}-executor` : '',
  );
  const [dockerAuthFields, setDockerAuthFields] =
    useState<DockerAuthFieldsValue>(EMPTY_DOCKER_AUTH_FIELDS);

  const jobNameProblem = item
    ? nameError(jobName, existingJobNames, 'Job name')
    : null;

  // Module-cached, so this costs no extra request beyond the one the field
  // itself makes -- it is read here only to resolve the *initial* class, which
  // is this component's to submit rather than the field's to own.
  const resourceClasses = useResourceClasses();
  // Also module-cached, and also read here only to resolve the *initial* value,
  // which is this component's to submit rather than the field's to own. macOS is
  // the only card that needs it; the hook is called unconditionally because hooks
  // are, and it costs one shared request for the whole session either way.
  const xcodeVersions = useXcodeVersions();
  const resourceEnvironments = builtin
    ? environmentsByIds(
        resourceClasses?.environments ?? [],
        builtin.resourceEnvironmentIds,
      )
    : [];
  /**
   * What the image field shows: the user's choice, else the card's own literal,
   * else -- for macOS, whose card deliberately has none -- whatever CircleCI's
   * supported-Xcode table says a new job should get.
   */
  const effectiveImage =
    chosenImage ??
    (builtin?.defaultImage
      ? builtin.defaultImage
      : builtin?.mutationKind === 'macos'
        ? resolveInitialXcodeVersion(xcodeVersions)
        : '');
  const effectiveResourceClass =
    chosenResourceClass ??
    (builtin
      ? resolveInitialResourceClass(
          resourceEnvironments,
          builtin.defaultResourceClass,
        )
      : '');
  const executorNameProblem =
    builtin && saveAsExecutor
      ? nameError(executorName, existingExecutorNames, 'Executor name')
      : null;

  // Only ever meaningful for a docker builtin -- machine/macos ignore
  // dockerAuthFields entirely (they're never rendered for those kinds, see
  // the JSX below). `resolveDockerAuthSpec` returning null means the
  // current mode's fields aren't validly filled in yet (e.g. "Username &
  // password" chosen but the password field doesn't look like an
  // environment variable name) -- Create job stays disabled rather than
  // letting that submit as-is, per issue #77's "refuse to make the wrong
  // thing easy."
  const isDocker = builtin?.mutationKind === 'docker';
  const dockerAuthSpec = isDocker
    ? resolveDockerAuthSpec(dockerAuthFields)
    : null;
  const dockerAuthProblem = isDocker && dockerAuthSpec === null;

  /**
   * A macOS job with no Xcode version is not a job -- `macos:` requires `xcode:`,
   * and the mutation layer now refuses to invent one rather than writing the
   * unsupported `15.3.0` it used to (issue #203). Blocking submission here is what
   * keeps that refusal something no user ever sees: the button explains itself
   * instead of the mutation failing after the click.
   *
   * Only ever true for the brief tick before `GET /api/xcode-versions` answers, or
   * when the host is unreachable and the user has not typed a version.
   */
  const xcodeMissing =
    builtin?.mutationKind === 'macos' && effectiveImage.trim() === '';

  const canSubmit =
    item !== null &&
    jobNameProblem === null &&
    executorNameProblem === null &&
    !dockerAuthProblem &&
    !xcodeMissing;

  const title =
    item?.source === 'builtin'
      ? `New job: ${item.def.label}`
      : item?.source === 'local'
        ? `New job: ${item.executorName}`
        : item?.source === 'orb'
          ? `New job: ${item.executorName}`
          : 'New job';

  const handleSubmit = () => {
    if (!canSubmit || !item) return;
    onSubmit({
      jobName: jobName.trim(),
      image: builtin ? effectiveImage.trim() || undefined : undefined,
      resourceClass: builtin ? effectiveResourceClass || undefined : undefined,
      saveAsExecutorName:
        builtin && saveAsExecutor ? executorName.trim() : undefined,
      dockerAuth:
        dockerAuthSpec && dockerAuthSpec.kind !== 'none'
          ? dockerAuthSpec
          : undefined,
    });
  };

  return (
    <RadixDialog.Root
      open={item !== null}
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
              {title}
            </RadixDialog.Title>
            <p className="mt-0.5 text-2xs text-cc-text-muted">
              This creates the job and adds it to the workflow in one step.
            </p>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
            <Field label="Job name" htmlFor={jobNameId} error={jobNameProblem}>
              <input
                id={jobNameId}
                autoFocus
                value={jobName}
                onChange={(event) => setJobName(event.target.value)}
                className={`${inputClassName} font-mono`}
              />
            </Field>

            {item?.source === 'local' ? (
              <p className="mb-3 text-2xs text-cc-text-faint">
                Uses the existing{' '}
                <span className="font-mono">executor: {item.executorName}</span>{' '}
                -- image and resource class are defined there.
              </p>
            ) : null}
            {item?.source === 'orb' ? (
              <p className="mb-3 text-2xs text-cc-text-faint">
                Uses{' '}
                <span className="font-mono">executor: {item.executorName}</span>{' '}
                from the <span className="font-mono">{item.orbRef}</span> orb.
              </p>
            ) : null}

            {builtin ? (
              <>
                {builtin.mutationKind === 'docker' ? (
                  <DockerImagePicker
                    value={effectiveImage}
                    onChange={setChosenImage}
                  />
                ) : builtin.mutationKind === 'machine' ? (
                  <MachineImagePicker
                    value={effectiveImage}
                    onChange={setChosenImage}
                    resourceClass={effectiveResourceClass}
                  />
                ) : (
                  <Field
                    label={builtin.imageLabel}
                    htmlFor={imageId}
                    error={
                      xcodeMissing
                        ? 'Choose an Xcode version -- a macOS job cannot be written without one.'
                        : null
                    }
                  >
                    {/* Was a bare text input pre-filled with a version CircleCI
                        does not offer (issue #203). Now the same grouped
                        select-plus-free-text control as the resource-class field
                        below it, over the versions upstream's own table lists. */}
                    <XcodeVersionField
                      id={imageId}
                      value={effectiveImage}
                      onChange={setChosenImage}
                      // Nothing is written until "Create job", so a free-text
                      // version must be captured as it is typed -- clicking the
                      // button need not blur the field first.
                      customCommit="change"
                    />
                  </Field>
                )}

                {isDocker ? (
                  <DockerAuthFields
                    value={dockerAuthFields}
                    onChange={setDockerAuthFields}
                  />
                ) : null}

                <Field label="Resource class" htmlFor={resourceClassId}>
                  <ResourceClassField
                    id={resourceClassId}
                    value={effectiveResourceClass}
                    onChange={setChosenResourceClass}
                    scope={{ environmentIds: builtin.resourceEnvironmentIds }}
                    fallbackClasses={[builtin.defaultResourceClass]}
                    // Nothing is written until "Create job", so a free-text
                    // class must be captured as it is typed -- clicking the
                    // button need not blur the field first.
                    customCommit="change"
                  />
                </Field>

                <div className="mb-1 flex items-center gap-2">
                  <input
                    id={saveAsExecutorId}
                    type="checkbox"
                    checked={saveAsExecutor}
                    onChange={(event) =>
                      setSaveAsExecutor(event.target.checked)
                    }
                    className="h-3.5 w-3.5 accent-cc-accent"
                  />
                  <label
                    htmlFor={saveAsExecutorId}
                    className="text-2xs text-cc-text"
                  >
                    Save as a reusable executor in{' '}
                    <span className="font-mono">executors:</span>
                  </label>
                </div>
                <p className="mb-3 text-2xs text-cc-text-faint">
                  {saveAsExecutor
                    ? // Issue #79: "explain the payoff at the moment of
                      // choice" -- one clause on reuse, one on where it leads
                      // (an orb is built from exactly this kind of named,
                      // reusable definition), not just a restatement of what
                      // the checkbox does.
                      'Other jobs can reuse this named executor, and editing it later changes every job that references it -- the same reusable-config building block an orb is packaged from.'
                    : 'Off by default: the image/resource class are written directly on this job, matching how "Add job" already works. Turn this on to give the executor its own name so other jobs can reuse it -- the first step toward turning it into a shareable orb.'}
                </p>
                {saveAsExecutor ? (
                  <Field
                    label="Executor name"
                    htmlFor={executorNameId}
                    error={executorNameProblem}
                  >
                    <input
                      id={executorNameId}
                      value={executorName}
                      onChange={(event) => setExecutorName(event.target.value)}
                      className={`${inputClassName} font-mono`}
                    />
                  </Field>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              Create job
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
