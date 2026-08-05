/**
 * The machine (Linux/Windows/GPU VM) executor's image field (issue #77,
 * part 4): "same treatment" as the Docker picker -- a browsable list of
 * `MACHINE_IMAGES` families with descriptions, rather than a bare text
 * input for `machine: image:`.
 *
 * The family/tag list itself stays fully static/offline by construction --
 * `images.ts`'s own provenance comment already explains why only the small,
 * CircleCI-documented set of "moving" tags
 * (`current`/`edge`/`previous`/`stable`) is offered at all, and this picker
 * does not change that. What issue #305 adds on top, once
 * `useMachineOfferings` has a live catalog:
 *
 *  - **Compatibility**: when `resourceClass` is known and the live catalog
 *    covers it, families it does not offer for that class are hidden --
 *    unless the config's current value names one, in which case it stays
 *    visible (never silently dropped) alongside a note explaining why.
 *    Mirrors `ResourceClassField`'s own "narrow, but never hide the current
 *    value" rule, at a lighter weight (no architecture axis here).
 *  - **Deprecation**: a tag CircleCI's catalog lists as deprecated gets a
 *    badge, the same way a "Recommended" tag already does.
 *  - **A manual refresh**, next to the existing docs link, following issue
 *    #285's convention (ghost button, disabled while a fetch is in
 *    flight) -- there was deliberately no button here before this issue:
 *    a hand-curated literal with nothing to refresh from only just became a
 *    cache with something real to ask.
 *
 * When the catalog is unavailable (offline, or nothing ever fetched), this
 * picker falls back to the full, unfiltered `MACHINE_IMAGES` literal and
 * says so -- the same floor as before, unchanged.
 */
import { useId, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
import { Tooltip } from '~/design/components/Tooltip';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  familiesForResourceClass,
  isDeprecatedMachineImage,
} from '~/lib/machineOfferings/compatibility';
import {
  refreshMachineOfferings,
  useMachineOfferings,
} from '~/lib/machineOfferings/useMachineOfferings';
import { MACHINE_IMAGES } from '~/lib/schema/images';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

const rowClassName = (selected: boolean) =>
  `flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs text-cc-text ${
    selected
      ? 'border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)]'
      : 'border-cc-border-interactive bg-cc-panel-raised hover:border-cc-accent'
  }`;

/**
 * What each moving tag means -- this project's own paraphrase of the
 * current/edge/previous/stable framing `images.ts`'s own provenance
 * comment already describes, not a verbatim CircleCI quote. `current` and
 * `default` are marked recommended below because they are the tag
 * `images.ts` itself documents as "the intended way to reference" a
 * family absent a specific reason to pin `edge`/`previous`/`stable`
 * instead -- see that file for the citation this is built on.
 */
const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  current: 'The supported, default build for this family.',
  edge: 'The newest available build -- may include less-tested changes.',
  default: 'The default build for this family.',
  previous: 'The prior stable release, kept available for compatibility.',
  stable:
    'Held steady for longer than "current", for workloads that want fewer moving parts.',
};

const RECOMMENDED_TAGS = new Set(['current', 'default']);

/** Parses `value` as a `<family>[:<tag>]` string, or `null` if `family` isn't a known `MACHINE_IMAGES` entry. */
function parseMachineValue(
  value: string,
): { familyName: string; tag: string } | null {
  const colonIdx = value.indexOf(':');
  const familyName = colonIdx === -1 ? value : value.slice(0, colonIdx);
  const tag = colonIdx === -1 ? '' : value.slice(colonIdx + 1);
  return MACHINE_IMAGES.some((img) => img.name === familyName)
    ? { familyName, tag }
    : null;
}

export function MachineImagePicker({
  value,
  onChange,
  resourceClass,
}: {
  value: string;
  onChange: (value: string) => void;
  /**
   * The job's current `resource_class`, if known, used to filter the family
   * list by the live catalog's compatibility mapping (issue #305). Optional,
   * and harmless to omit: with no class to filter by, every family is shown,
   * exactly as before this issue.
   */
  resourceClass?: string;
}) {
  const parsed = parseMachineValue(value);
  const selectedFamily = parsed
    ? MACHINE_IMAGES.find((img) => img.name === parsed.familyName)
    : undefined;
  const inputId = useId();

  const offeringsState = useMachineOfferings();
  const [refreshing, setRefreshing] = useState(false);

  const compatibleFamilies = familiesForResourceClass(
    offeringsState,
    resourceClass ?? '',
  );
  // Narrows completely, except the config's own current value: hiding it
  // outright would be issue #212's bug replayed for a second control (see
  // `ResourceClassField`'s own reasoning, which this mirrors at a lighter
  // weight -- there is no architecture axis here to reopen unfiltered).
  const visibleImages = compatibleFamilies
    ? MACHINE_IMAGES.filter(
        (img) =>
          compatibleFamilies.has(img.name) || img.name === selectedFamily?.name,
      )
    : MACHINE_IMAGES;
  const selectionIncompatible =
    !!compatibleFamilies &&
    !!selectedFamily &&
    !compatibleFamilies.has(selectedFamily.name);

  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void refreshMachineOfferings().finally(() => setRefreshing(false));
  };

  const selectFamily = (name: string) => {
    const family = MACHINE_IMAGES.find((img) => img.name === name);
    const existing = parseMachineValue(value);
    const tag =
      existing?.familyName === name ? existing.tag : (family?.tags[0] ?? '');
    onChange(`${name}:${tag}`);
  };

  const selectTag = (tag: string) => {
    if (!selectedFamily) return;
    onChange(`${selectedFamily.name}:${tag}`);
  };

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-2xs font-medium text-cc-text-muted">
          VM image
        </span>
        <div className="flex items-center gap-2">
          {offeringsState?.available ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
              title={
                refreshing
                  ? 'Checking CircleCI for the current machine-image catalog'
                  : 'Check CircleCI for the current machine-image catalog now, instead of waiting for the next automatic check'
              }
            >
              {refreshing ? (
                <span className="flex items-center gap-1.5">
                  <Spinner size={12} label="Refreshing" />
                  Refreshing…
                </span>
              ) : (
                'Refresh'
              )}
            </Button>
          ) : null}
          <DocsLink {...DOCS_LINKS.images.machineTags} className="text-2xs" />
        </div>
      </div>

      <ul
        role="listbox"
        aria-label="Machine executor images"
        className="mb-2 max-h-36 space-y-1 overflow-y-auto rounded-md border border-cc-border-strong bg-cc-panel p-1.5"
      >
        {visibleImages.map((image) => (
          <li key={image.name}>
            <button
              type="button"
              role="option"
              aria-selected={image.name === selectedFamily?.name}
              onClick={() => selectFamily(image.name)}
              className={rowClassName(image.name === selectedFamily?.name)}
            >
              <span className="font-mono">{image.name}</span>
              <span className="text-2xs text-cc-text-muted">
                {image.description}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectionIncompatible ? (
        <p
          role="status"
          className="mb-2 rounded-md border border-cc-warning/40 bg-cc-panel-raised p-1.5 text-2xs text-cc-text"
        >
          CircleCI&rsquo;s current catalog does not offer{' '}
          <span className="font-mono text-cc-warning">
            {selectedFamily?.name}
          </span>{' '}
          for <span className="font-mono">{resourceClass}</span> -- nothing in
          your config has changed, and it is still shown above.
        </p>
      ) : null}

      {selectedFamily ? (
        <div className="mb-2 flex flex-wrap gap-1 rounded-md border border-cc-border-strong bg-cc-panel p-1.5">
          {selectedFamily.tags.map((tag) => {
            const image = `${selectedFamily.name}:${tag}`;
            const deprecated = isDeprecatedMachineImage(offeringsState, image);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={parsed?.tag === tag}
                title={TAG_DESCRIPTIONS[tag]}
                onClick={() => selectTag(tag)}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-2xs ${
                  parsed?.tag === tag
                    ? 'border-cc-accent text-cc-accent'
                    : 'border-cc-border-interactive text-cc-text-muted hover:border-cc-accent'
                }`}
              >
                {tag}
                {deprecated ? (
                  <Tooltip content="CircleCI's live catalog lists this exact image as deprecated.">
                    <span>
                      <Badge tone="warning">Deprecated</Badge>
                    </span>
                  </Tooltip>
                ) : RECOMMENDED_TAGS.has(tag) ? (
                  <Tooltip content="This is the tag CircleCI's own docs describe as the default/supported way to reference this image family.">
                    <span>
                      <Badge tone="success">Recommended</Badge>
                    </span>
                  </Tooltip>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {offeringsState && !offeringsState.available ? (
        <p className="mb-2 text-2xs text-cc-warning">
          {offeringsState.reason ??
            "Showing this app's built-in list -- CircleCI's live machine-image catalog is unavailable."}
        </p>
      ) : null}
      {offeringsState?.available && offeringsState.stale ? (
        <p className="mb-2 text-2xs text-cc-warning">
          Showing a machine-image catalog checked more than a day ago
          {offeringsState.reason ? ` -- ${offeringsState.reason}` : ''}.
        </p>
      ) : null}

      <label
        htmlFor={inputId}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        VM image
      </label>
      <input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClassName} font-mono`}
      />
    </div>
  );
}
