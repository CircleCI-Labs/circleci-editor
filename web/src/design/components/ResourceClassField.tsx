/**
 * The one resource-class control in this app (issue #181): an optional
 * architecture filter, a `<select>` grouped by CircleCI's own resource tables,
 * and free text for a class newer than our documentation snapshot.
 *
 * Shared rather than duplicated because there are two call sites that must not
 * disagree -- `ConfigureJobDialog` (choosing a class as a job is created) and the
 * inspector's executor fields (changing one afterwards). Before this they were
 * two different controls offering two different lists: five hardcoded values per
 * palette card, and the config schema's full flat enum. A user who created a job
 * with one and edited it with the other saw two answers to the same question.
 *
 * It lives beside `ReferenceImpactList` and `ValidationBadge` for the same
 * reason those do: a domain component two panes both render. The select, the
 * "Other..." escape hatch and the free-text commit timing are
 * `PresetSelectField`, shared with the macOS Xcode field so that two controls
 * sitting beside each other in the same dialog are the same control (issue #213).
 *
 * ## What it offers, and what it says about it
 *
 * The classes come from `GET /api/resource-classes`, which the host derives from
 * the resource tables vendored from CircleCI's own documentation -- see
 * `internal/guides/resourceclasses.go`. Three things follow from that and are
 * visible in the UI:
 *
 *  - The option groups are labelled in CircleCI's words ("x86", "x86 (gen2)",
 *    "Arm VM execution environment"), because they *are* CircleCI's headings.
 *  - The caveat under the field names the docs as the source. It is the same
 *    caveat issue #153 introduced, updated: the tables say which classes exist,
 *    not which ones a given organization's plan may use, and no CircleCI API
 *    exposes the latter (five candidates 404'd -- issue #143).
 *  - When the host could not read the tables it says so, in place, rather than
 *    presenting a possibly-dated list as current.
 *
 * ## Architecture narrows; it never writes
 *
 * There is no `architecture:` key in a CircleCI config -- `resource_class:
 * arm.medium` is how the architecture is spelled. So the control is a filter and
 * is labelled as one, it sits above the field it filters rather than beside it as
 * a peer, and it appears only where there is genuinely more than one
 * architecture to choose between (Docker and `machine`; not macOS, Windows or
 * GPU, whose offered classes carry no architecture distinction). See
 * `~/lib/resourceClasses/resourceClassOptions`, where all of that is decided
 * from the data and unit-tested without a render.
 *
 * ## When the filter invalidates the selection (issue #212)
 *
 * The filter used to exempt the current class from itself, so choosing "Arm" left
 * `medium` -- an x86 class -- listed *and selected* under a control that says it
 * filters. The owner's report is exactly that: the control says it is filtering
 * and the field says otherwise.
 *
 * Now the list narrows completely, and the invalidated selection is handled
 * visibly and only on request:
 *
 *  - The select drops to its "Not set" position, so it never displays a class
 *    that is absent from the list under it.
 *  - A notice names the class the config actually has and says it is not in the
 *    chosen architecture. The value is not hidden; it is called out, which is a
 *    better way of not losing sight of it than leaving it in a list it does not
 *    belong to.
 *  - Where the tables offer an equivalent (`medium` -> `arm.medium`) a button
 *    switches to it. **Choosing an architecture writes nothing.** Only that
 *    button does, and in the inspector it is one surgical, undoable mutation.
 *    Silently rewriting someone's `resource_class` because they touched a filter
 *    would be worse than the confusion it fixes.
 *  - Where there is no equivalent -- `small`, `medium+` and `2xlarge+` have no
 *    Arm counterpart -- the notice says so rather than offering the nearest size,
 *    which would hand the job a different machine than it asked for.
 *  - After a switch the notice says what changed, so the mutation is not
 *    something the user has to infer from the select's new value.
 *
 * The filter still *opens* unfiltered. Pre-filtering to the current value's
 * architecture was the obvious thing and the wrong one: a job on `medium` would
 * open on an x86-only list, and "the Docker Arm classes don't look like they're
 * there" is the report issue #181 was filed on. Narrowing is opt-in, so every
 * class the executor offers is one scroll away by default.
 */
import { useId, useState } from 'react';

import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import {
  CUSTOM_PRESET_OPTION,
  PresetSelectField,
  presetControlClassName,
  type PresetGroup,
} from '~/design/components/PresetSelectField';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  ANY_ARCHITECTURE,
  architectureAxis,
  classTitle,
  environmentsByIds,
  environmentsForKind,
  equivalentClassInArchitecture,
  isClassInArchitecture,
  resourceClassGroups,
  type ResourceClassGroup,
} from '~/lib/resourceClasses/resourceClassOptions';
import type { ResourceClassEnvironment } from '~/lib/resourceClasses/types';
import { useResourceClasses } from '~/lib/resourceClasses/useResourceClasses';

/**
 * Re-exported under its historical name. The value is `PresetSelectField`'s now
 * that the escape hatch is shared, but both existing call sites and their tests
 * refer to it by this name, and renaming a sentinel to celebrate a refactor is
 * churn.
 */
export const CUSTOM_RESOURCE_CLASS_OPTION = CUSTOM_PRESET_OPTION;

/**
 * Which tables to offer. Exactly one of these is given.
 *
 *  - `environmentIds` -- the specific upstream tables a palette card draws on,
 *    named in `paletteExecutors.ts`. The Windows card offers Windows classes and
 *    not every `machine` class, because that is the card the user picked.
 *  - `kind` -- every table for an executor key, for the inspector, which knows
 *    a job is `machine` but has no reliable way to know whether the user means
 *    Windows, GPU, Arm or plain Linux (the image is a hint, not a fact). Showing
 *    all six `machine` tables, each under its own heading, tells the truth;
 *    guessing one would not.
 */
export type ResourceClassScope =
  | { environmentIds: readonly string[]; kind?: never }
  | { kind: 'docker' | 'machine' | 'macos'; environmentIds?: never };

function scopedEnvironments(
  environments: readonly ResourceClassEnvironment[],
  scope: ResourceClassScope,
): ResourceClassEnvironment[] {
  return scope.environmentIds
    ? environmentsByIds(environments, scope.environmentIds)
    : environmentsForKind(environments, scope.kind);
}

/** `ResourceClassGroup`s as `PresetSelectField` wants them, with the tables' own specs as each option's `title`. */
function toPresetGroups(groups: readonly ResourceClassGroup[]): PresetGroup[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    options: group.classes.map((resourceClass) => ({
      value: resourceClass.name,
      title: classTitle(resourceClass),
    })),
  }));
}

export function ResourceClassField({
  id,
  value,
  onChange,
  scope,
  fallbackClasses = [],
  allowUnset = false,
  customCommit = 'blur',
  ariaLabel,
}: {
  id: string;
  /** The current `resource_class` value, or `''` when the config sets none. */
  value: string;
  /** Called with the new value. Never called with `CUSTOM_RESOURCE_CLASS_OPTION` or an empty string. */
  onChange: (next: string) => void;
  scope: ResourceClassScope;
  /**
   * Classes to offer when the host returned none at all -- in practice just the
   * one the caller already knows (a palette card's own default). Deliberately
   * not a retyped copy of CircleCI's tables: the host already falls back to the
   * tables embedded in its own binary, so the only way to get here is the host
   * being unreachable, and a second list maintained for that would be a second
   * thing to drift. Free text covers the rest.
   */
  fallbackClasses?: readonly string[];
  /** Offers a "Not set" option, for the inspector, where a job legitimately has no `resource_class`. */
  allowUnset?: boolean;
  /** See `PresetSelectField`'s own `customCommit` -- this is passed straight through. */
  customCommit?: 'blur' | 'change';
  /**
   * An explicit accessible name, for a usage where the visible `<label htmlFor>`
   * can't reliably point at *this* select -- the inspector renders one of these
   * alongside a read-only inherited value under a single "Resource class" label.
   */
  ariaLabel?: string;
}) {
  const response = useResourceClasses();
  const architectureId = useId();

  // `?? []` rather than trusting the field: this control renders inside a
  // dialog and inside the inspector, and neither should throw because a host
  // (or a test double) answered with a payload missing a key.
  const environments = scopedEnvironments(response?.environments ?? [], scope);
  const axis = architectureAxis(environments);

  // Opens unfiltered, always -- see the module doc comment.
  const [architecture, setArchitecture] = useState(ANY_ARCHITECTURE);
  /**
   * The class this field switched away from, remembered only so the notice can
   * say what happened. Not state the config depends on: cleared as soon as the
   * architecture changes again, and nothing reads it but that one sentence.
   */
  const [switchedFrom, setSwitchedFrom] = useState<string | null>(null);

  const groups = resourceClassGroups(environments, architecture);
  // Only meaningful once real groups have arrived. While the response is in
  // flight every class looks out-of-architecture, and warning about that would
  // be a flash of a wrong answer.
  const filtered = architecture !== ANY_ARCHITECTURE && groups.length > 0;
  const selectionInvalid =
    filtered && !isClassInArchitecture(environments, value, architecture);
  const equivalent = selectionInvalid
    ? equivalentClassInArchitecture(environments, value, architecture)
    : undefined;

  const architectureLabel =
    axis.find((choice) => choice.value === architecture)?.label ?? architecture;

  return (
    <>
      {axis.length > 0 ? (
        <div className="mb-2">
          <label
            htmlFor={architectureId}
            className="mb-1 block text-2xs font-medium text-cc-text-muted"
          >
            Architecture
          </label>
          <select
            id={architectureId}
            value={architecture}
            onChange={(event) => {
              setArchitecture(event.target.value);
              // A new choice makes any previous "changed X to Y" sentence stale.
              setSwitchedFrom(null);
            }}
            className={presetControlClassName}
          >
            {axis.map((choice) => (
              <option key={choice.value || 'any'} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {/* Said plainly, because the honest answer to "what does this write?"
              is "nothing". CircleCI encodes the architecture in the class name,
              so a control that looked like a second field would be a lie about
              the config file. */}
          <p className="mt-1 text-2xs text-cc-text-faint">
            Filters the list below. CircleCI has no{' '}
            <span className="font-mono">architecture</span> key &mdash; it is
            part of the resource class name.
          </p>
        </div>
      ) : null}

      <PresetSelectField
        id={id}
        ariaLabel={ariaLabel}
        // The value is deliberately withheld from the select while it sits
        // outside the filtered list: a `<select>` can only show what it lists,
        // and the alternative -- an option present in the list but not in the
        // chosen architecture -- is precisely issue #212's bug. The value is
        // named in the notice below, so it is called out rather than hidden.
        value={selectionInvalid ? '' : value}
        onChange={(next) => {
          setSwitchedFrom(null);
          onChange(next);
        }}
        groups={toPresetGroups(groups)}
        fallbackValues={fallbackClasses}
        // While the selection is invalid the select has to be able to sit on
        // "Not set" even in a usage that would not otherwise offer it.
        allowUnset={allowUnset || selectionInvalid}
        customCommit={customCommit}
        customLabel="Custom resource class"
        customPlaceholder="e.g. arm.medium"
      >
        {selectionInvalid ? (
          <div
            // A status region rather than an alert: this is the consequence of
            // something the user just did deliberately, not an interruption.
            role="status"
            className="mt-1.5 rounded-md border border-cc-warning/40 bg-cc-panel-raised p-1.5"
          >
            <p className="text-2xs text-cc-text">
              This job uses{' '}
              <span className="font-mono text-cc-warning">{value}</span>, which
              is not {architectureLabel} &mdash; nothing in your config has
              changed.
            </p>
            {equivalent ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSwitchedFrom(value);
                    onChange(equivalent.name);
                  }}
                >
                  Switch to {equivalent.name}
                </Button>
                <span className="text-2xs text-cc-text-faint">
                  {equivalent.spec
                    ? `${equivalent.spec} -- one undoable change.`
                    : 'One undoable change.'}
                </span>
              </div>
            ) : (
              /* No nearest-size guess: `medium+` has no Arm counterpart, and
                 answering `arm.medium` would hand the job a different machine
                 than the one it asked for. */
              <p className="mt-1 text-2xs text-cc-text-faint">
                CircleCI&rsquo;s tables list no {architectureLabel} equivalent
                of <span className="font-mono">{value}</span>. Pick a class
                above, or set the filter back to{' '}
                <span className="italic">Any architecture</span>.
              </p>
            )}
          </div>
        ) : null}

        {switchedFrom && !selectionInvalid ? (
          <p role="status" className="mt-1 text-2xs text-cc-text-muted">
            Changed <span className="font-mono">{switchedFrom}</span> to{' '}
            <span className="font-mono">{value}</span>. Undo reverts it.
          </p>
        ) : null}

        {/* Two sentences, one caveat each, and neither is optional. The first is
            issue #153's, updated to name its real source now that it has one. The
            second only appears when the list is not the current documentation's,
            because an unqualified stale list is the failure this whole change is
            about. */}
        <p className="mt-1 text-2xs text-cc-text-faint">
          From{' '}
          {/* Visible link text rather than this app's default icon-only
              affordance: the sentence needs to name its source anyway, so
              wrapping the words it already says costs nothing and gives the link
              an accessible name that isn't a near-duplicate of the field's own
              label. */}
          <DocsLink {...DOCS_LINKS.executors.resourceClass}>
            CircleCI&rsquo;s resource-class tables
          </DocsLink>
          , not your plan &mdash; an organization on a smaller plan may not have
          access to all of these.
        </p>
        {response && !response.derived ? (
          <p className="mt-1 text-2xs text-cc-warning">{response.reason}</p>
        ) : null}
      </PresetSelectField>
    </>
  );
}
