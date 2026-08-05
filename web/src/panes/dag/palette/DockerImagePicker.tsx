/**
 * The Docker executor's image field (issue #77): a browsable picker over
 * CircleCI's `cimg/*` convenience images -- description, live version
 * tags, and known variant suffixes -- with a "custom image" mode that
 * surfaces the real registry-auth fields (`DockerAuthFields.tsx`) instead
 * of a bare text input.
 *
 * The underlying `image` value stays the single plain string
 * `ConfigureJobDialog` already threads through (`value`/`onChange`) --
 * every row/control here is an assistive shortcut that writes into that same
 * value, never a second source of truth. Typing directly into the text
 * field below the picker has always worked and keeps working exactly as
 * before, with no token and no network required -- see
 * `ImageTagCombobox`'s own graceful-degradation handling of `fetchCimgTags`
 * failing.
 *
 * ## The tag control (issue #213)
 *
 * The version tags used to be a wrapped row of buttons, one per tag. They are now
 * a type-to-filter combobox -- `ImageTagCombobox`, which is where the reasoning
 * about ordering, the surviving best-practice framing and the `latest` warning
 * lives. The variant suffixes below it stay buttons on purpose: there are at most
 * three of them, they are *toggles* rather than a list to search, and turning three
 * toggles into a fourth dropdown would be the "wall of controls" problem in
 * miniature.
 */
import { useEffect, useId, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
import { Tooltip } from '~/design/components/Tooltip';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { CIMG_IMAGES, CIMG_VARIANT_INFO } from '~/lib/schema/images';
import {
  fetchCimgTags,
  getCachedCimgTags,
  refreshCimgTags,
  type CimgTagsState,
} from '~/lib/schema/imageTags';

import { ImageTagCombobox } from './ImageTagCombobox';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

const rowClassName = (selected: boolean) =>
  `flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs text-cc-text ${
    selected
      ? 'border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)]'
      : 'border-cc-border-interactive bg-cc-panel-raised hover:border-cc-accent'
  }`;

/** Parses `value` as a `cimg/<name>[:<tag>]` string, or `null` if it isn't one -- used to decide the picker's initial mode and to keep the repo/tag selection in sync with whatever the (single, shared) text field currently holds. */
function parseCimgValue(
  value: string,
): { repoName: string; tag: string } | null {
  if (!value.startsWith('cimg/')) return null;
  const rest = value.slice('cimg/'.length);
  const colonIdx = rest.indexOf(':');
  const repoName = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
  const tag = colonIdx === -1 ? '' : rest.slice(colonIdx + 1);
  return CIMG_IMAGES.some((img) => img.name === repoName)
    ? { repoName, tag }
    : null;
}

export function DockerImagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const parsed = parseCimgValue(value);
  const [mode, setMode] = useState<'convenience' | 'custom'>(
    parsed ? 'convenience' : 'custom',
  );
  const repoName = mode === 'convenience' ? (parsed?.repoName ?? null) : null;

  const [tagsState, setTagsState] = useState<CimgTagsState | undefined>(() =>
    repoName ? getCachedCimgTags(repoName) : undefined,
  );
  // Issue #285: tracked locally (not part of `CimgTagsState`, which is a
  // *resolved* lookup and has no notion of "in flight") so the Refresh
  // button can disable itself and the status note can say "Checking…"
  // without waiting on `tagsState` itself to change.
  const [refreshingTags, setRefreshingTags] = useState(false);

  useEffect(() => {
    if (!repoName) {
      setTagsState(undefined);
      return;
    }
    const cached = getCachedCimgTags(repoName);
    setTagsState(cached);
    if (cached) return;

    let cancelled = false;
    void fetchCimgTags(repoName).then((state) => {
      if (!cancelled) setTagsState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [repoName]);

  // Reset per image, so switching to a different `cimg/*` repo never leaves
  // the previous one's "Checking…" state stuck on for a picker that no
  // longer shows it.
  useEffect(() => {
    setRefreshingTags(false);
  }, [repoName]);

  const refreshTags = () => {
    if (!repoName || refreshingTags) return;
    setRefreshingTags(true);
    void refreshCimgTags(repoName).then((state) => {
      setTagsState(state);
      setRefreshingTags(false);
    });
  };

  const inputId = useId();
  const tagFieldId = useId();

  const selectRepo = (name: string) => {
    const existing = parseCimgValue(value);
    const tag = existing?.repoName === name ? existing.tag : '';
    onChange(`cimg/${name}:${tag}`);
  };

  const selectTag = (tag: string) => {
    if (!repoName) return;
    onChange(`cimg/${repoName}:${tag}`);
  };

  const toggleVariant = (variant: string, variants: readonly string[]) => {
    if (!repoName || !parsed) return;
    const currentVariant = variants.find((v) => parsed.tag.endsWith(v));
    const baseTag = currentVariant
      ? parsed.tag.slice(0, -currentVariant.length)
      : parsed.tag;
    onChange(
      `cimg/${repoName}:${currentVariant === variant ? baseTag : `${baseTag}${variant}`}`,
    );
  };

  const selectedImage = repoName
    ? CIMG_IMAGES.find((img) => img.name === repoName)
    : undefined;
  const currentVariant = selectedImage?.variants.find((v) =>
    parsed?.tag.endsWith(v),
  );

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Image source">
          <button
            type="button"
            aria-pressed={mode === 'convenience'}
            onClick={() => setMode('convenience')}
            className={`rounded-md border px-2 py-1 text-2xs ${
              mode === 'convenience'
                ? 'border-cc-accent text-cc-accent'
                : 'border-cc-border-interactive text-cc-text-muted'
            }`}
          >
            Convenience image
          </button>
          <button
            type="button"
            aria-pressed={mode === 'custom'}
            onClick={() => setMode('custom')}
            className={`rounded-md border px-2 py-1 text-2xs ${
              mode === 'custom'
                ? 'border-cc-accent text-cc-accent'
                : 'border-cc-border-interactive text-cc-text-muted'
            }`}
          >
            Custom image
          </button>
        </div>
        <DocsLink
          {...DOCS_LINKS.images.dockerConvenience}
          className="text-2xs"
        />
      </div>

      {mode === 'convenience' ? (
        <ul
          role="listbox"
          aria-label="CircleCI convenience images"
          className="mb-2 max-h-36 space-y-1 overflow-y-auto rounded-md border border-cc-border-strong bg-cc-panel p-1.5"
        >
          {CIMG_IMAGES.map((image) => (
            <li key={image.name}>
              <button
                type="button"
                role="option"
                aria-selected={image.name === repoName}
                onClick={() => selectRepo(image.name)}
                className={rowClassName(image.name === repoName)}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="font-mono">cimg/{image.name}</span>
                  {image.name === 'base' ? (
                    <Tooltip content="CircleCI's own docs describe cimg/base as designed to serve as the base image for every other convenience image -- a reasonable general-purpose starting point.">
                      <span>
                        <Badge tone="info">General purpose</Badge>
                      </span>
                    </Tooltip>
                  ) : null}
                </span>
                <span className="text-2xs text-cc-text-muted">
                  {image.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {mode === 'convenience' && selectedImage ? (
        <div className="mb-2 rounded-md border border-cc-border-strong bg-cc-panel p-1.5">
          <div className="mb-1 flex items-center gap-1.5">
            <label
              htmlFor={tagFieldId}
              className="block text-2xs font-medium text-cc-text-muted"
            >
              Version tag
            </label>
            {/*
              Issue #285: the manual "check now" affordance, for a tag
              published to Docker Hub since the host's own 12h cache last
              looked. Styled like the palette Contexts/orb browser buttons so
              the three read as the same control across the app.
            */}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-5 px-1.5 text-2xs"
              onClick={refreshTags}
              disabled={refreshingTags}
              title={
                refreshingTags
                  ? `Checking Docker Hub for cimg/${selectedImage.name}'s tags`
                  : `Check Docker Hub for cimg/${selectedImage.name}'s tags now, instead of relying on the cached list`
              }
            >
              {refreshingTags ? (
                <span className="flex items-center gap-1">
                  <Spinner size={10} label="Checking" />
                  Checking…
                </span>
              ) : (
                'Refresh'
              )}
            </Button>
          </div>
          <ImageTagCombobox
            id={tagFieldId}
            imageName={selectedImage.name}
            tag={parsed?.tag ?? ''}
            tagsState={tagsState}
            onChange={selectTag}
          />
          {selectedImage.variants.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {selectedImage.variants.map((variant) => (
                <button
                  key={variant}
                  type="button"
                  aria-pressed={currentVariant === variant}
                  title={CIMG_VARIANT_INFO[variant]}
                  onClick={() => toggleVariant(variant, selectedImage.variants)}
                  className={`rounded-md border px-1.5 py-0.5 font-mono text-2xs ${
                    currentVariant === variant
                      ? 'border-cc-accent text-cc-accent'
                      : 'border-cc-border-interactive text-cc-text-muted hover:border-cc-accent'
                  }`}
                >
                  {variant}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <label
        htmlFor={inputId}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        Image
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
