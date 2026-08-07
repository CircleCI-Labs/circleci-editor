/**
 * The "Guides" half of the reference pane (issue #104, widened by #176): a
 * browsable view of twenty of CircleCI's config-adjacent documentation pages
 * plus two pages this project wrote about this editor, rendered from the block
 * model the Go host parses out of their AsciiDoc source (`internal/guides`).
 *
 * Layout mirrors the Keys half deliberately -- a nav list on the left, the
 * selected thing on the right -- so switching between them doesn't relearn the
 * pane. Level-2 sections are the nav's top level and level-3 sections are
 * indented under them, matching how the live docs page reads.
 *
 * # Why the guide picker is a `<select>` and not a row of buttons
 *
 * It was a row of buttons while there were three guides. At twenty-two that row
 * wraps into a block taller than the content it introduces, which is exactly the
 * "the guide list becomes a wall" failure issue #176 asked to avoid. Three ways
 * out were available and two were rejected:
 *
 *  - *A scrollable button rail.* Rejected outright. Issue #88 records
 *    the repeated complaint about nested scrolling in this pane; the section nav
 *    below already scrolls, and a second scroll region beside it is the thing
 *    users have objected to twice.
 *  - *A disclosure menu*, like the app bar's. Workable, but it is a custom
 *    widget to keep accessible for a list whose only job is single selection.
 *  - *One grouped `<select>`.* Constant height at any page count, no new scroll
 *    region, and keyboard and screen-reader behaviour that is the platform's
 *    rather than ours. Groups come from the host (`Guide.category`) and name the
 *    *editor feature* that raises the question -- Workflows, Orbs, Executors --
 *    rather than CircleCI's own content tree.
 *
 * # Whose words these are
 *
 * The pane serves two kinds of page and must never blur them. CircleCI's pages
 * are marked as theirs and link out to circleci.com; this project's two pages
 * carry a distinct badge, say in their own prose that they are about the tool,
 * and link to this repository -- there is no circleci.com URL for them, and
 * inventing one would be a 404 under a claim of authorship. See `GuideOrigin`.
 *
 * Everything about staleness is stated, never implied: the footer says which
 * upstream commit the text came from and when, whether an update check is in
 * flight, and whether the last one failed. The content is complete in every one
 * of those states -- a refresh only ever *replaces* a good copy -- so none of
 * them is a loading or error state.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Spinner } from '~/design/components/Spinner';
import { Tooltip } from '~/design/components/Tooltip';
import { groupGuidesByCategory, searchGuides } from '~/lib/guides/guides';
import type { Guide, GuideProvenance } from '~/lib/guides/types';

import { BlockList, type GuideRenderContext } from './GuideBlocks';

/** Formats an ISO 8601 timestamp as a plain date, or '' if absent/unparseable. */
function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** The GitHub URL for one commit, so the SHA becomes clickable rather than decorative (issue #286). */
function commitURL(repo: string, commit: string): string {
  return `https://github.com/${repo}/commit/${commit}`;
}

/**
 * The provenance footer. Worth the space: this pane shows text this project
 * did not write, cached for up to a week, so "where is this from and how old is
 * it" has to be answerable without reading the source.
 *
 * Issue #286: a bare commit hash answers "which exact bytes" but not "is this
 * current?" -- and this pane cannot answer that second question at all (it has
 * no way to know whether upstream has moved on since). So it says what it *can*
 * verify -- the ref this was resolved from, the commit, and when it was pinned
 * -- and deliberately never says "latest" or "current": doing so would be a
 * claim this pane cannot back up, and this pane's "degrade honestly" rule
 * extends to not overstating freshness just as much as to not hiding
 * staleness.
 */
function ProvenanceFooter({
  provenance,
  guide,
  onRefresh,
}: {
  provenance: GuideProvenance;
  guide: Guide | undefined;
  /**
   * Issue #285: the manual "check now" affordance, styled and named like the
   * palette Contexts section's own `Refresh` (and the orb browser's).
   * Omitted entirely for one of this project's own editor pages (`isEditorDoc`
   * below) -- there is nothing upstream to check for those, so a button that
   * would always no-op is worse than no button.
   */
  onRefresh: () => void;
}) {
  const committed = formatDate(provenance.committedAt);
  const shortCommit = provenance.commit.slice(0, 7);
  const detail = [
    provenance.repo,
    provenance.ref ? `@${provenance.ref}` : '',
    shortCommit ? ` · ${shortCommit}` : '',
    committed ? ` · pinned ${committed}` : '',
  ].join('');

  // Our own pages are not vendored, are not refreshed, and are not CircleCI's,
  // so none of the upstream provenance describes them. Reporting a
  // circleci-docs commit under a page this project wrote would be the exact
  // confusion the origin split exists to prevent.
  const isEditorDoc = guide?.origin === 'editor';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-cc-border px-3 py-2 text-2xs">
      {isEditorDoc ? (
        <Tooltip content="Written and maintained in this editor's own repository, under its MIT licence. It ships inside this binary and is never fetched, so it changes only when the editor does. It is not CircleCI documentation.">
          <span tabIndex={0} className="text-cc-text-faint">
            About this editor · ships with this build
          </span>
        </Tooltip>
      ) : (
        <>
          <Tooltip
            content={`Rendered from the AsciiDoc source of ${provenance.repo}${
              provenance.ref ? `, from its ${provenance.ref} branch` : ''
            }, ${
              provenance.source === 'vendored'
                ? 'as vendored into this binary'
                : 'refreshed from upstream'
            }${committed ? `, pinned to a commit dated ${committed}` : ''}. This says how old the pinned copy is -- not whether upstream has changed since. Used with the permission of CircleCI.`}
          >
            <span tabIndex={0} className="text-cc-text-faint">
              {detail}
            </span>
          </Tooltip>
          {provenance.commit ? (
            <a
              href={commitURL(provenance.repo, provenance.commit)}
              target="_blank"
              rel="noreferrer"
              className="text-cc-accent hover:underline"
            >
              View commit ↗
            </a>
          ) : null}
        </>
      )}
      {provenance.refreshing && !isEditorDoc ? (
        <Badge tone="neutral">Checking for updates</Badge>
      ) : null}
      {provenance.error && !isEditorDoc ? (
        <Tooltip content={provenance.error}>
          <span tabIndex={0}>
            <Badge tone="warning">Last update check failed</Badge>
          </span>
        </Tooltip>
      ) : null}
      {/*
        Issue #285: the owner's own question -- "is there a refresh button
        that would cause it to pull in new stuff?" -- answered directly next
        to the provenance it's about, rather than only in the badge tooltip
        above. Absent for one of this project's own editor pages: there is no
        upstream copy of those to check.
      */}
      {!isEditorDoc ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={provenance.refreshing}
          title={
            provenance.refreshing
              ? 'Checking circleci/circleci-docs for an update'
              : 'Check circleci/circleci-docs for an update now, instead of waiting for the next automatic check'
          }
        >
          {provenance.refreshing ? (
            <span className="flex items-center gap-1.5">
              <Spinner size={12} label="Checking" />
              Checking…
            </span>
          ) : (
            'Refresh'
          )}
        </Button>
      ) : null}
      {guide ? (
        <a
          href={guide.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-cc-accent hover:underline"
        >
          {isEditorDoc
            ? 'View the source of this page ↗'
            : 'Read on circleci.com ↗'}
        </a>
      ) : null}
    </div>
  );
}

/**
 * The guide picker: one grouped `<select>`, full width.
 *
 * No badge here, on purpose. Whose documentation is on screen is stated in three
 * places already — the pane header's badge, which `DocsPane` switches on the
 * selected guide's origin; this view's footer; and the page's own opening prose —
 * and a fourth marker beside the control would only compete with the select for
 * horizontal space. That space is scarce: in the `Columns` preset the reference
 * pane is narrow enough that a badge here truncates the guide's own title to a
 * few characters, which costs the reader more than the redundancy buys.
 */
function GuidePicker({
  guides,
  guide,
  onSelect,
}: {
  guides: readonly Guide[];
  guide: Guide;
  onSelect: (guideId: string) => void;
}) {
  const selectId = useId();
  const categories = useMemo(() => groupGuidesByCategory(guides), [guides]);

  return (
    <div className="flex shrink-0 items-center border-b border-cc-border px-2 py-2">
      <label htmlFor={selectId} className="sr-only">
        Choose a guide
      </label>
      <select
        id={selectId}
        value={guide.id}
        onChange={(event) => onSelect(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent"
      >
        {categories.map((category) => (
          <optgroup key={category.title} label={category.title}>
            {category.guides.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export interface GuideViewProps {
  guides: readonly Guide[];
  provenance: GuideProvenance;
  /** The guide to show; the caller owns this so a key's "read the full section" link can switch guides. */
  guideId: string;
  onGuideChange: (guideId: string) => void;
  /** The section to show, or `null` for the guide's own lead/overview. */
  sectionId: string | null;
  onSectionChange: (sectionId: string | null) => void;
  /** Issue #285's manual "check now" affordance -- see `ProvenanceFooter`. */
  onRefresh: () => void;
}

export function GuideView({
  guides,
  provenance,
  guideId,
  onGuideChange,
  sectionId,
  onSectionChange,
  onRefresh,
}: GuideViewProps) {
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  const guide = useMemo(
    () => guides.find((candidate) => candidate.id === guideId) ?? guides[0],
    [guides, guideId],
  );

  // Issue #19: a mid-section anchor -- one `Guide.anchors` maps to the
  // *enclosing* section rather than to itself, because that is the most
  // precise thing the section-only navigation this pane shipped with could
  // resolve. The block carrying that exact anchor as its own DOM `id`
  // already exists (`GuideBlocks.tsx`'s `BlockNode`); what was missing is
  // scrolling to it once the section it lives in is on screen.
  //
  // A ref, not state: it is written and read within one synchronous
  // navigation (see `navigateToSection`) and must never itself cause a
  // render -- only `navTick` does that, deliberately, so the effect below
  // has one unambiguous trigger regardless of whether `sectionId` itself
  // changed (clicking a ref whose target lives in the section already on
  // screen must still scroll, even though `onSectionChange` is then called
  // with the id already showing and therefore causes no prop change at all).
  const pendingAnchorRef = useRef<string | null>(null);
  const [navTick, setNavTick] = useState(0);

  /**
   * Every navigation this view initiates goes through here, including a
   * plain section-list click (`anchor` omitted): that is what guarantees
   * `pendingAnchorRef` never holds a stale value left over from a previous
   * `ref` click by the time the effect below reads it.
   */
  const navigateToSection = useCallback(
    (id: string | null, anchor?: string) => {
      pendingAnchorRef.current = anchor ?? null;
      setNavTick((n) => n + 1);
      onSectionChange(id);
    },
    [onSectionChange],
  );

  // Search spans *every* guide, not just the selected one: someone typing
  // "path filtering" doesn't know (and shouldn't have to) that it lives in the
  // dynamic-config page rather than the configuration reference. That matters
  // more at twenty-two guides than it did at three -- the picker's categories
  // help a reader who knows what they are looking for, and search is the path
  // for a reader who does not. Each result names its guide, so a hit is never
  // ambiguous about which page it came from.
  const results = useMemo(() => searchGuides(guides, query), [guides, query]);

  const selectedSection = useMemo(
    () => guide?.sections.find((section) => section.id === sectionId) ?? null,
    [guide, sectionId],
  );

  // Scroll the reading column back to the top when the selection changes;
  // without this, jumping to a short section from halfway down a long one
  // leaves the reader looking at blank space. Assigning `scrollTop` rather
  // than calling `scrollTo`, because jsdom implements the former and not the
  // latter -- and a component that throws under test is a component whose
  // behaviour cannot be asserted.
  //
  // Declared *before* the anchor-scroll effect below, on purpose: both can
  // fire in the same commit (a `ref` click that also changes section), and
  // React runs a component's own effects in declaration order. This one must
  // land first -- reset to the top -- so the anchor-scroll effect's own
  // `scrollIntoView` is the one that has the last word, not the other way
  // around.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [guideId, sectionId]);

  // Issue #19's actual scroll: keyed on `navTick`, not on `sectionId`,
  // because the case that matters most -- a `ref` whose target is a heading
  // already inside the section on screen -- calls `onSectionChange` with the
  // id it was already given, which the parent's own state bails out of
  // re-rendering, so `sectionId` here never changes at all. `navTick` always
  // does, on every navigation this view initiates, so it is the one signal
  // this effect can rely on. One-shot: reading the ref clears it, so a
  // render this effect did not cause (a guide's `provenance` refreshing, for
  // instance) can never replay a stale scroll.
  useEffect(() => {
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (!anchor) return;
    const target = contentRef.current?.querySelector(`#${CSS.escape(anchor)}`);
    // jsdom does not implement scrollIntoView by default in every version
    // this repo has run against -- guarding its existence, rather than
    // wrapping in try/catch, keeps a genuinely missing anchor (upstream's
    // own broken cross-reference, or a section still mid-render) silent in
    // exactly the way `resolveRef` already treats an unresolvable target:
    // nothing happens, rather than an error surfacing where a scroll would
    // have been invisible anyway.
    target?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navTick is a nonce whose value is never read, only its identity change; contentRef is a ref.
  }, [navTick]);

  if (!guide) {
    return (
      <p className="p-4 text-center text-xs text-cc-text-faint">
        No guides are loaded.
      </p>
    );
  }

  const context: GuideRenderContext = {
    guide,
    onNavigate: (target, anchor) =>
      navigateToSection(target, anchor === target ? undefined : anchor),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GuidePicker
        guides={guides}
        guide={guide}
        onSelect={(nextGuideId) => {
          onGuideChange(nextGuideId);
          navigateToSection(null);
          setQuery('');
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex w-2/5 min-w-0 flex-col border-r border-cc-border">
          <div className="shrink-0 p-2">
            <label htmlFor="guide-search" className="sr-only">
              Search the documentation guides
            </label>
            <input
              id="guide-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search every guide…"
              className="w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none placeholder:text-cc-text-faint focus-visible:border-cc-accent"
            />
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
            data-testid="guide-nav"
          >
            {query.trim() !== '' ? (
              results.length === 0 ? (
                <p className="px-1 py-1 text-xs text-cc-text-faint">
                  No matches in any guide.
                </p>
              ) : (
                <ul>
                  {results.map((result) => (
                    <li key={`${result.guideId}:${result.section.id}`}>
                      <button
                        type="button"
                        onClick={() => {
                          onGuideChange(result.guideId);
                          navigateToSection(result.section.id);
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs text-cc-text-muted transition-colors hover:bg-cc-panel-raised hover:text-cc-text"
                      >
                        <span className="block truncate">
                          {result.section.title}
                        </span>
                        <span className="block truncate text-2xs text-cc-text-faint">
                          {result.guideTitle}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ul>
                <li>
                  <button
                    type="button"
                    onClick={() => navigateToSection(null)}
                    aria-pressed={sectionId === null}
                    className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors ${
                      sectionId === null
                        ? 'bg-[color-mix(in_srgb,var(--color-cc-accent)_18%,transparent)] text-cc-accent'
                        : 'text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text'
                    }`}
                  >
                    Overview
                  </button>
                </li>
                {guide.sections.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => navigateToSection(section.id)}
                      aria-pressed={section.id === sectionId}
                      className={`block w-full truncate rounded py-1 pr-2 text-left text-xs transition-colors ${
                        section.level >= 3 ? 'pl-5' : 'pl-2 font-medium'
                      } ${
                        section.id === sectionId
                          ? 'bg-[color-mix(in_srgb,var(--color-cc-accent)_18%,transparent)] text-cc-accent'
                          : 'text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text'
                      }`}
                    >
                      {section.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div
          ref={contentRef}
          className="min-w-0 flex-1 overflow-y-auto p-3"
          data-testid="guide-content"
        >
          {selectedSection ? (
            <article className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-semibold text-cc-text">
                {selectedSection.title}
              </h3>
              <BlockList blocks={selectedSection.blocks} context={context} />
            </article>
          ) : (
            <article className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-semibold text-cc-text">
                {guide.title}
              </h3>
              {guide.description ? (
                <p className="text-xs text-cc-text-faint">
                  {guide.description}
                </p>
              ) : null}
              <BlockList blocks={guide.lead} context={context} />
              {(guide.lead?.length ?? 0) === 0 ? (
                <p className="text-xs text-cc-text-faint">
                  Pick a section on the left.
                </p>
              ) : null}
            </article>
          )}
        </div>
      </div>

      <ProvenanceFooter
        provenance={provenance}
        guide={guide}
        onRefresh={onRefresh}
      />
    </div>
  );
}
