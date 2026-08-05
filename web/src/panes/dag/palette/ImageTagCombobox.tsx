/**
 * The `cimg/*` tag control (issue #213): a type-to-filter combobox over the tags
 * Docker Hub has published for the selected convenience image.
 *
 * ## What this replaced
 *
 * A wrapped row of `<button>`s, one per tag (issue #77). That works for a handful
 * and degrades badly beyond it -- the owner's words: "I don't think the buttons
 * will scale, especially if there's thousands of different versions of those
 * images. I think it might look really wonky." A `cimg` repo genuinely publishes
 * hundreds of tags, and the buttons only looked survivable because the host
 * previously served eight of them.
 *
 * ## Why the host now serves two lists
 *
 * The buttons could get away with eight tags because eight *ranked* tags are a
 * recommendation, and a recommendation is all a row of buttons can be. A combobox
 * is a search box, and searching eight collapsed representatives is worse than
 * useless: someone who knows they want `20.11.2` would type it and be told nothing
 * matches, because ranking folds `20.11.0`, `20.11.2` and `20.11.0-browsers` into
 * one entry. So `GET /api/docker-tags` now carries both -- `tags`, the ranked
 * handful, and `allTags`, everything version-shaped it saw.
 *
 * "Everything it saw" is bounded, not literal: `allTags` is up to
 * `internal/dockerhub`'s own `maxTagsFetch` (five Docker Hub pages, 500 tags --
 * issue #243), not this repo's entire published history, and this control never
 * claims otherwise -- `TagsStatusNote` below states the actual count, not "all" or
 * "hundreds". A count shorter than that bound because Docker Hub cut the fetch off
 * partway (rate limiting, most likely) is disclosed too, via `state.truncated`,
 * rather than presented as if it were the honest, deliberate kind of short list.
 *
 * Both are used, and the distinction is visible: the ranked tags appear first
 * under a "Recommended" heading, the rest under "All published tags". That is how
 * issue #77's best-practice framing survives the control change instead of being
 * dropped with the buttons -- the recommendation is still made, it is just no
 * longer the *only* thing reachable.
 *
 * ## `latest` and the other mutable tags
 *
 * Never offered, in either group: `versionGroupKey` drops any tag without a
 * leading version number, so `latest`, `current` and `edge` are absent by
 * construction. That is upstream's own advice -- "Avoid using mutable tags like
 * `latest` or `1`... Mutable tags often lead to unexpected changes in your job
 * environment" (`using-docker.adoc`) -- so offering one would be this editor
 * recommending against the documentation it ships.
 *
 * Typing one still works, because the field is free text and refusing a legal
 * value would be worse. What happens instead is that the field says why it is a
 * bad idea, with a link to the paragraph that says so. Warning at the moment
 * someone does the thing is the only place a warning is worth anything; a warning
 * next to an option nobody picked is decoration.
 *
 * ## Offline
 *
 * `fetchCimgTags` resolves to `{ source: 'unavailable' }` rather than rejecting,
 * so this renders an empty option list and an explanation, never an empty dropdown
 * presented as the answer. Free text keeps working with no network and no token --
 * which is the only reason this control is allowed to depend on Docker Hub at all.
 */
import { Combobox, type ComboboxOption } from '~/design/components/Combobox';
import { DocsLink } from '~/design/components/DocsLink';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import type { CimgTagsState } from '~/lib/schema/imageTags';

const RECOMMENDED_GROUP = 'Recommended';
const ALL_GROUP = 'All published tags';

/**
 * The tag CircleCI's own documentation names when it tells users not to pin a
 * mutable one. Recognised for the *warning*, not for filtering: the host never
 * offers a non-version tag at all (see the module doc comment), so this only ever
 * fires against something the user typed.
 *
 * Exactly `latest`, and deliberately no wider. Two near-misses are worth naming,
 * because both are tempting and both would make this warning worse than nothing:
 *
 *  - `current` and `edge` are not the same thing. They are the moving tags
 *    CircleCI *documents* as the intended way to address several image families
 *    (see `images.ts`'s provenance comment on `MACHINE_IMAGES`), and
 *    `cimg/base:current` is this editor's own Docker default -- issue #203
 *    reviewed it and said so explicitly. A warning that fired on the default the
 *    app itself writes would be incoherent, and would train people to ignore it.
 *  - A bare major like `cimg/postgres:14` genuinely does move, and upstream's
 *    paragraph does name `1` alongside `latest`. It is left out anyway: pinning a
 *    major is a common, deliberate, defensible choice, and a warning that fires on
 *    a deliberate choice is noise. `latest` is the case where someone almost
 *    certainly did not mean it.
 */
const MUTABLE_TAGS = new Set(['latest']);

export function isMutableTag(tag: string): boolean {
  return MUTABLE_TAGS.has(tag.trim().toLowerCase());
}

/**
 * The options to offer, ranked-first then everything else, with the current value
 * hoisted to the front of its group so it is visible without scrolling.
 *
 * Ordering rules, in priority order:
 *
 *  1. The tag currently set, if it is a published one. "Where am I?" is the first
 *     question a picker has to answer, and an unsorted list of hundreds answers it
 *     last.
 *  2. The ranked tags, newest-first, under "Recommended" -- the host's own
 *     ordering (`RankVersionTags`), which is newest-first because Docker Hub's tag
 *     listing is.
 *  3. Everything else, newest-first, under "All published tags" -- again the
 *     host's own ordering, not re-sorted here.
 *
 * Nothing is sorted alphabetically anywhere. `20.11` sorting between `2.1` and
 * `3.0` is exactly the wrong answer for version tags, and the newest-first order
 * Docker Hub already returns is both meaningful and free.
 */
export function tagOptions(
  state: CimgTagsState | undefined,
  currentTag: string,
): ComboboxOption[] {
  if (!state) return [];

  const ranked = state.tags;
  const rankedSet = new Set(ranked);
  const rest = state.allTags.filter((tag) => !rankedSet.has(tag));

  const inRanked = (tag: string) => rankedSet.has(tag);
  const hoist = (tags: readonly string[], group: string): ComboboxOption[] => {
    const hoisted =
      currentTag && tags.includes(currentTag)
        ? [currentTag, ...tags.filter((tag) => tag !== currentTag)]
        : [...tags];
    return hoisted.map((tag) => ({
      value: tag,
      group,
      hint:
        tag === currentTag
          ? 'current'
          : group === RECOMMENDED_GROUP && tag === ranked[0]
            ? 'newest'
            : undefined,
      title:
        tag === ranked[0]
          ? "Most recently published on Docker Hub -- CircleCI does not officially recommend a specific version; this is this project's own recency ranking."
          : undefined,
    }));
  };

  const options = [
    ...hoist(ranked, RECOMMENDED_GROUP),
    ...hoist(rest, ALL_GROUP),
  ];

  // A tag the config already has that Docker Hub's page did not carry (an older
  // release, or a tag published since the cache was filled) is still shown, at
  // the very top, in its own honest group. The alternative is a picker that
  // silently disagrees with the file open next to it.
  if (currentTag && !inRanked(currentTag) && !rest.includes(currentTag)) {
    options.unshift({
      value: currentTag,
      group: 'Currently set',
      hint: 'current',
      title:
        "This tag is not on the page of tags Docker Hub returned. It may be older than that page, or newer than this app's cached copy -- it is not necessarily wrong.",
    });
  }

  return options;
}

/**
 * Substring, case-insensitive. Deliberately not a prefix match, unlike the Xcode
 * field's: a tag carries variant suffixes people search by, so typing `browsers`
 * to find `20.11.0-browsers` has to work.
 */
function matchesTagQuery(option: ComboboxOption, query: string): boolean {
  return option.value.toLowerCase().includes(query.trim().toLowerCase());
}

/** Live/cached/unavailable freshness, spelled out rather than implying every list is fresh -- see `imageTags.ts`'s doc comment on `CimgTagsState.source`. */
function TagsStatusNote({
  state,
  count,
}: {
  state: CimgTagsState | undefined;
  count: number;
}) {
  if (!state) {
    return (
      <p className="mt-1 text-2xs text-cc-text-faint">
        Looking up published versions on Docker Hub&hellip;
      </p>
    );
  }
  if (state.source === 'unavailable') {
    return (
      <p className="mt-1 text-2xs text-cc-text-faint">
        Couldn&rsquo;t reach Docker Hub for a version list (offline, or no
        cached copy yet) &mdash; type a tag above, or use the variant suffixes
        below.
      </p>
    );
  }
  if (count === 0) {
    return (
      <p className="mt-1 text-2xs text-cc-text-faint">
        No version tags found for this image &mdash; type one above.
      </p>
    );
  }
  return (
    <p className="mt-1 text-2xs text-cc-text-faint">
      {count} version tag{count === 1 ? '' : 's'}, newest first.{' '}
      {state.source === 'live'
        ? 'Fetched just now from Docker Hub.'
        : 'From a previous Docker Hub fetch (cached).'}{' '}
      Any tag is accepted as typed.
      {state.truncated ? (
        <>
          {' '}
          <span className="text-cc-warning">
            This list may be shorter than what Docker Hub actually has
            {state.truncatedReason ? ` (${state.truncatedReason})` : ''} &mdash;
            an older tag you know the name of can still be typed above.
          </span>
        </>
      ) : null}
    </p>
  );
}

export function ImageTagCombobox({
  id,
  imageName,
  tag,
  tagsState,
  onChange,
}: {
  id: string;
  /** The bare `cimg` repo name, e.g. `node` -- for the listbox's accessible name. */
  imageName: string;
  /** The tag currently in the image value, or `''` when none has been typed yet. */
  tag: string;
  /** The live-tag lookup, or `undefined` while it is in flight. */
  tagsState: CimgTagsState | undefined;
  /** Called with the new tag. Never called with an empty string. */
  onChange: (tag: string) => void;
}) {
  const options = tagOptions(tagsState, tag);
  const mutable = isMutableTag(tag);

  return (
    <Combobox
      id={id}
      value={tag}
      onCommit={onChange}
      options={options}
      filter={matchesTagQuery}
      listLabel={`Published cimg/${imageName} tags`}
      ariaLabel="Image tag"
      placeholder={
        options.length > 0 ? 'Type to filter, or enter any tag' : 'tag'
      }
    >
      {mutable ? (
        <p className="mt-1 text-2xs text-cc-warning">
          <span className="font-mono">{tag.trim()}</span> is a mutable tag.
          CircleCI recommends pinning a precise version instead &mdash; a
          mutable tag can change your job environment without any change to this
          file.{' '}
          <DocsLink {...DOCS_LINKS.images.mutableTags} className="text-2xs" />
        </p>
      ) : null}
      <TagsStatusNote state={tagsState} count={options.length} />
    </Combobox>
  );
}
