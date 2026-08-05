/**
 * The `docs` pane: two mutually-exclusive *surfaces* sharing one `PaneId`
 * slot (issue #306), switched by a plain, unpersisted `useState` rather than
 * anything in `layout/`.
 *
 * **Reference** -- Keys and Guides, documentation that does not depend on
 * which project this checkout belongs to. **Project** -- the project record,
 * its policies and its caches: what is true about *this* project right now.
 * The owner's own framing is why they split: *"If you have policies, you have
 * projects, you have caches now. Maybe we split it out into a different pane
 * and leave Reference as actual documentation -- keys and guides and stuff
 * like that."*
 *
 * ## Why a shared slot, not a sixth `PaneId`
 *
 * #226 priced a sixth pane at the default preset's minimum width going from
 * 916px to 1196px (measured against a 1024px window it no longer fits) plus a
 * forced `LAYOUT_SCHEMA_VERSION` bump -- `isCompleteLayoutTree`
 * (`state/layoutStore.ts`) requires a persisted custom tree's pane set to be
 * *exactly* `PANE_IDS`, so any new `PaneId` invalidates every user's saved
 * custom layout the moment it exists, regardless of whether the new pane
 * starts collapsed. That bump is exactly what #248 and #285 avoided by
 * growing this pane's *tab strip* instead, and issue #306 asks the identical
 * question again now that the strip is at five tabs and a sixth surface is
 * needed: re-measured, both costs are unchanged -- still a real pane, still
 * that bump.
 *
 * A shared slot pays neither cost: `layout/types.ts`, `layout/constants.ts`
 * and `layout/presets.ts` are untouched by this change, so `PANE_IDS`,
 * `MIN_PANE_PX` and `LAYOUT_SCHEMA_VERSION` all stay exactly as they were.
 * What moved is entirely inside this one pane's own render: a `surface` state
 * value picks which of two tab groups shows, each group unchanged from what
 * it already was as a tab (`ReferenceTab`/`ProjectTab` below). The `docs`
 * `PaneId` itself, its floor, its label for the collapsed strip and the Move
 * menu ("Reference" -- unchanged, matching the precedent `yaml`'s pane label
 * already set: `PaneSlot`'s chrome names the *slot*, not whatever a pane is
 * currently showing inside it) are exactly what they were before this issue.
 *
 * ## Keys (issue #83) and Guides (issue #104, widened by #176)
 *
 * **Keys** browses the vendored config JSON Schema (`internal/schema`,
 * Apache-2.0) -- the exact keys, steps and enum values this editor validates
 * against. It cannot drift from what the editor enforces, because it *is*
 * what the editor enforces.
 *
 * **Guides** renders CircleCI's own prose -- twenty config-adjacent pages,
 * chosen by the owner's rule that a page belongs here if it describes
 * something you *type in the config file* -- parsed from the AsciiDoc source
 * of `circleci/circleci-docs` by the Go host (`internal/guides`) into a block
 * model this app draws with its own components. That repository has no
 * licence file; use here rests on an explicit grant from this project's
 * owner, a CircleCI employee -- see CONTRIBUTING.md's third-party
 * attributions. The `<iframe>` route remains impossible regardless
 * (`X-Frame-Options: SAMEORIGIN`, verified).
 *
 * Two further pages in that list are **this project's own** documentation
 * about this editor, not CircleCI's. They are marked as such
 * wherever they appear, because a reader who mistook them for official
 * documentation would draw wrong conclusions about CircleCI -- particularly
 * since their whole point is to be blunt about what CircleCI's APIs do not
 * expose.
 *
 * ### Why both, and how they compose
 *
 * The owner asked for the guides *and* had complained that the schema-derived
 * list "dumps keys" -- so shipping the guides as a second, competing reference
 * would have been the wrong answer. They are joined instead:
 *
 *  - The **schema stays the index.** It is the complete, machine-checkable list
 *    of what is accepted, and it is the thing the editor validates against.
 *  - The **guides supply the explanation.** Selecting a key shows the schema's
 *    shape (types, enums, required-ness) *and* the matching section of the
 *    official configuration reference, with one click through to the full
 *    section. Nobody maintains a key-to-anchor table: the join is discovered
 *    from the guides' own headings (see `findSectionForKey`).
 *  - Where the two agree by *silence*, the pane says so. A top-level key with
 *    no schema description and no section in the configuration reference is
 *    orb-authoring metadata (`display`, `examples`, `experimental`) and is
 *    labelled and sectioned as such, which is the direct fix for the report
 *    that opened issue #104.
 *
 * Neither half needs a `CIRCLE_TOKEN`, and neither needs the network: the
 * schema and the guides' AsciiDoc are both embedded in the binary. The guides
 * *may* be newer than the binary (a seven-day background refresh), and if
 * that refresh has never run or has failed,
 * the pane shows the vendored copy and says so. If the host cannot parse even
 * that, the pane explains why and links out to the live pages -- never a blank
 * pane, never a spinner that does not resolve.
 *
 * ## Project, Policies, Caches -- see each view's own doc comment
 *
 * `ProjectReferenceView` (#248), `PolicyRulesView` (#215/#247) and
 * `CachesView` (#285) are unmoved and unmodified by this issue -- only which
 * tab strip they hang off changed. Their own doc comments still hold: the
 * identity states from #149/#150 (absent/present/malformed), #251's
 * policy certainty model, and #285's honest per-cache statements (including
 * the deliberate "none" for machine images) all cross into the `project`
 * surface exactly as they were.
 */
import { useId, useMemo, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Panel } from '~/design/components/Panel';
import { Spinner } from '~/design/components/Spinner';
import { Tooltip } from '~/design/components/Tooltip';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  CONFIGURATION_REFERENCE_ID,
  documentedKeys,
  findGuide,
  findSectionForKey,
  sectionSummary,
} from '~/lib/guides/guides';
import type { Guide, GuideLink } from '~/lib/guides/types';
import { useGuides } from '~/lib/guides/useGuides';
import { useCircleciSchema } from '~/lib/schema/useCircleciSchema';

import {
  buildDocsSections,
  filterDocsSections,
  type DocsEntry,
} from './buildDocsSections';
import { CachesView } from './CachesView';
import { GuideView } from './GuideView';
import { PolicyRulesView } from './PolicyRulesView';
import { ProjectReferenceView } from './ProjectReferenceView';

/**
 * The two surfaces this pane's single `PaneId` slot switches between (issue
 * #306) -- see this module's own doc comment for why a shared slot rather
 * than a sixth pane.
 */
type Surface = 'reference' | 'project';

/** Reference's own tabs: documentation, unrelated to which project this
 * checkout belongs to. Unchanged content from before #306 -- only ever
 * shown together, never beside Project/Policies/Caches. */
type ReferenceTab = 'keys' | 'guides';

/** The new surface's own tabs: "what is true about this project right now"
 * (issue #306's own phrase) -- the project record, its policies, its
 * caches. */
type ProjectTab = 'project' | 'policies' | 'caches';

/**
 * Every tab this pane can show, across both surfaces. Kept as one flat union
 * (rather than two disjoint ones threaded separately through the badge/
 * content logic below) because most of that logic -- the header badge, the
 * content switch -- only ever needs "which of these five", never "which
 * surface".
 *
 * ## The extension point (issue #248, amended by #306)
 *
 * This is a plain union, not a plugin registry, and that is a deliberate,
 * minimal choice: the pane grew from two tabs to five without one (`'policies'`
 * issue #215, `'project'` issue #248, `'caches'` issue #285), and splitting
 * five into two groups of two and three (this issue) needed no new mechanism
 * either -- just two tuple arrays where the tab strip used to map over one,
 * each rendered only while its own surface is active. Adding a *sixth tab*
 * still means touching exactly three spots, all in this file:
 *
 *  1. Add the id here (to `ReferenceTab` or `ProjectTab`, whichever surface it
 *     belongs to).
 *  2. Add `[id, label]` to that surface's own tuple array below.
 *  3. Add a `tab === id ? (...)` branch to the content switch further down.
 *
 * Each tab owns its own content component and its own data source -- this
 * file only ever renders one, switches between them, and holds the search/
 * selection state `'keys'` needs. A tab's content never reaches into
 * another tab's state.
 */
type Tab = ReferenceTab | ProjectTab;

const REFERENCE_TABS: readonly (readonly [ReferenceTab, string])[] = [
  ['keys', 'Keys'],
  ['guides', 'Guides'],
];

const PROJECT_TABS: readonly (readonly [ProjectTab, string])[] = [
  ['project', 'Project'],
  ['policies', 'Policies'],
  ['caches', 'Caches'],
];

const SURFACE_LABEL: Record<Surface, string> = {
  reference: 'Reference',
  project: 'Project',
};

/** A stable empty array, so "no guides yet" doesn't invalidate memoisation on every render. */
const EMPTY_GUIDES: readonly Guide[] = [];

/**
 * The outbound links shown when nothing could be rendered at all. Resolved
 * through the canonical, non-redirecting table rather than written out
 * again here, so the live link check in `docsLinks.test.ts` covers them.
 */
const FALLBACK_LINKS: readonly GuideLink[] = [
  {
    id: 'configuration-reference',
    ...DOCS_LINKS.guides.configurationReference,
  },
  { id: 'reusing-config', ...DOCS_LINKS.guides.reusingConfig },
  { id: 'dynamic-config', ...DOCS_LINKS.guides.dynamicConfig },
];

const listItemClassName =
  'block w-full truncate rounded px-2 py-1 text-left font-mono text-xs transition-colors';

function EntryList({
  sections,
  selectedId,
  onSelect,
}: {
  sections: ReturnType<typeof buildDocsSections>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (sections.length === 0) {
    return <p className="px-2 py-1 text-xs text-cc-text-faint">No matches.</p>;
  }

  return (
    <>
      {sections.map((section) => (
        <div key={section.id} className="mb-3">
          <h3 className="px-1 py-1 text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
            {section.title}
          </h3>
          <ul>
            {section.entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-pressed={selectedId === entry.id}
                  className={`${listItemClassName} ${
                    selectedId === entry.id
                      ? 'bg-[color-mix(in_srgb,var(--color-cc-accent)_18%,transparent)] text-cc-accent'
                      : 'text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text'
                  }`}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * The right-hand detail view for whichever key is selected: the schema's
 * description and field table (already vetted for the inspector's own step
 * editors, so a step's fields never say anything here the inspector wouldn't
 * also let you edit), then -- the issue #104 half -- the matching section of
 * CircleCI's own configuration reference, summarised, with a way through to the
 * whole thing.
 */
function EntryDetail({
  entry,
  reference,
  onOpenGuideSection,
}: {
  entry: DocsEntry;
  reference: Guide | undefined;
  onOpenGuideSection: (guideId: string, sectionId: string) => void;
}) {
  const guideSection = useMemo(
    () =>
      entry.docKey ? findSectionForKey(reference, entry.docKey) : undefined,
    [reference, entry.docKey],
  );
  const summary = guideSection ? sectionSummary(guideSection) : '';

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div>
        <p className="font-mono text-sm font-semibold text-cc-text">
          {entry.label}
        </p>
        {entry.orbAuthoringOnly ? (
          // The fix for the `display` report: say what this key actually is,
          // rather than showing a bare word with no description at all.
          <p className="mt-1 text-xs text-cc-text-muted">
            An orb-authoring key. It is part of the official schema, but
            CircleCI&apos;s configuration reference does not document it and it
            is not something a project&apos;s{' '}
            <code className="font-mono">.circleci/config.yml</code> contains
            &mdash; it carries metadata for a published orb.
          </p>
        ) : entry.info ? (
          <p className="mt-1 whitespace-pre-wrap text-xs text-cc-text-muted">
            {entry.info}
          </p>
        ) : summary !== '' ? (
          // No schema description, but the guides have prose for this key:
          // show that, rather than "the schema has no description", which was
          // true but useless.
          <p className="mt-1 text-xs text-cc-text-muted">{summary}</p>
        ) : (
          <p className="mt-1 text-xs text-cc-text-faint">
            Neither the schema nor the configuration reference describes this
            key.
          </p>
        )}
      </div>

      {entry.fields && entry.fields.length > 0 ? (
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-cc-border text-2xs uppercase tracking-wide text-cc-text-faint">
              <th className="py-1 pr-2 font-semibold">Field</th>
              <th className="py-1 pr-2 font-semibold">Type</th>
              <th className="py-1 font-semibold">Required</th>
            </tr>
          </thead>
          <tbody>
            {entry.fields.map((field) => (
              <tr
                key={field.name}
                className="border-b border-cc-border/50 align-top"
              >
                <td className="py-1 pr-2 font-mono text-cc-text">
                  {field.name}
                </td>
                <td className="py-1 pr-2 text-cc-text-muted">
                  {field.type === 'enum' && field.enumValues
                    ? field.enumValues.join(' | ')
                    : field.type}
                </td>
                <td className="py-1 text-cc-text-muted">
                  {field.required ? 'Yes' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {guideSection && reference ? (
        <div className="border-t border-cc-border pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
            From the configuration reference
          </p>
          {entry.info && summary !== '' ? (
            <p className="mt-1 text-xs text-cc-text-muted">{summary}</p>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenGuideSection(reference.id, guideSection.id)}
            className="mt-1 text-2xs text-cc-accent hover:underline"
          >
            {`Read the full "${guideSection.title}" section →`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Shown when the host could not give us the guides at all: explains, and links out. */
function GuidesUnavailable({
  reason,
  links,
}: {
  reason: string | undefined;
  links: readonly GuideLink[];
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-cc-text">
        Built-in guides unavailable
      </p>
      <p className="max-w-sm text-xs text-cc-text-muted">
        {reason ?? 'The built-in documentation guides could not be loaded.'}{' '}
        Editing, validation and the Keys view are unaffected. You can read the
        same pages on circleci.com:
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="text-2xs text-cc-accent hover:underline"
          >
            {`${link.label} ↗`}
          </a>
        ))}
      </div>
    </div>
  );
}

export function DocsPane() {
  const schema = useCircleciSchema();
  const { response: guidesResponse, refresh: refreshGuides } = useGuides();
  // Issue #306: `surface` picks which of the two tab groups below is shown;
  // `referenceTab`/`projectTab` each remember their own surface's last
  // selection independently, so switching away and back doesn't reset it --
  // the same "remember where you were" a returning user gets from either
  // surface's own tab strip today. None of the three is persisted (matching
  // `tab`'s own pre-#306 behaviour): a "remember the last surface" feature
  // would have to go through `layout/state/layoutStore.ts` to survive a
  // reload, and that store is exactly what this issue keeps
  // `LAYOUT_SCHEMA_VERSION` out of by never routing surface/tab selection
  // through it at all.
  const [surface, setSurface] = useState<Surface>('reference');
  const [referenceTab, setReferenceTab] = useState<ReferenceTab>('keys');
  const [projectTab, setProjectTab] = useState<ProjectTab>('project');
  const tab: Tab = surface === 'reference' ? referenceTab : projectTab;
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guideId, setGuideId] = useState<string>(CONFIGURATION_REFERENCE_ID);
  const [guideSectionId, setGuideSectionId] = useState<string | null>(null);
  const searchId = useId();
  const tabsLabelId = useId();

  // Memoised off `guidesResponse` rather than a freshly-defaulted array: the
  // `?? []` literal is a new object every render, which would defeat every
  // `useMemo` downstream of it.
  const guides = useMemo(
    () => guidesResponse?.guides ?? EMPTY_GUIDES,
    [guidesResponse],
  );
  const reference = useMemo(
    () => findGuide(guides, CONFIGURATION_REFERENCE_ID),
    [guides],
  );
  // Passed into `buildDocsSections` so a key with neither a schema description
  // nor a section in the configuration reference can be sectioned as
  // orb-authoring metadata. Empty until the guides load, which leaves the Keys
  // view exactly as it was before -- under-labelling beats mislabelling.
  const documented = useMemo(() => documentedKeys(reference), [reference]);

  const sections = useMemo(
    () => (schema ? buildDocsSections(schema, documented) : []),
    [schema, documented],
  );
  const filtered = useMemo(
    () => filterDocsSections(sections, query),
    [sections, query],
  );
  const selectedEntry = useMemo(
    () =>
      sections
        .flatMap((section) => section.entries)
        .find((entry) => entry.id === selectedId) ?? null,
    [sections, selectedId],
  );

  const schemaLoading = schema === null;
  const guidesLoading = guidesResponse === undefined;
  // A genuinely empty schema (every fact table empty) only happens if
  // `GET /api/schema` itself failed as a request -- `useCircleciSchema` never
  // leaves this hook throwing or stuck; a failed fetch resolves to the
  // all-empty schema instead (see that module's doc comment). That endpoint
  // needs no token and touches no network, so this branch is not expected in
  // practice, but "no results for any search, ever" must still read as
  // "something's wrong" rather than silently looking like an exhaustive search
  // that came up empty.
  const schemaUnavailable = !schemaLoading && sections.length === 0;

  // The header badge says what the pane is currently showing, and it has to
  // track the *selected guide*, not just the tab. Two of the guides are this
  // project's own writing about this editor (issue #176), and leaving the badge
  // reading "CircleCI docs" over one of those would be a false attribution in
  // the one place a reader looks to check attribution. Distinct tone as well as
  // distinct text, so the difference survives being skimmed.
  const shownGuide = useMemo(
    () => findGuide(guides, guideId) ?? guides[0],
    [guides, guideId],
  );
  const badge = useMemo((): {
    label: string;
    tone: 'info' | 'warning';
    tooltip: string;
  } => {
    if (tab === 'keys') {
      return {
        label: 'Schema-generated · offline',
        tone: 'info',
        tooltip:
          'Generated from the vendored CircleCI configuration JSON Schema — the exact keys and shapes this editor validates against. Works fully offline, no token required.',
      };
    }
    if (tab === 'project') {
      return {
        label: 'Live project data',
        tone: 'warning',
        tooltip:
          'Fetched from the CircleCI API for the project this checkout belongs to. Needs a CIRCLE_TOKEN and a network request, unlike Keys and Guides — see the tab itself when either is unavailable.',
      };
    }
    if (tab === 'caches') {
      return {
        label: 'About this editor',
        tone: 'warning',
        tooltip:
          "This tab is this editor's own explanation of what it caches, written by this project -- not a CircleCI page.",
      };
    }
    if (shownGuide?.origin === 'editor') {
      return {
        label: 'About this editor',
        tone: 'warning',
        tooltip:
          "This page is about this editor and was written by this project, not by CircleCI. It ships inside this binary, is never fetched, and CircleCI has not reviewed it. Every other guide in this list is CircleCI's own documentation.",
      };
    }
    return {
      label: 'CircleCI docs · offline',
      tone: 'info',
      // Issue #285: the owner read "offline" here and asked, reasonably,
      // whether it meant "will never update" -- it doesn't, and this is
      // where that gets said plainly rather than left to be inferred from
      // the footer's own provenance line. "Offline" describes what this
      // badge has always meant (works with no network, no token): a
      // seven-day background check, and the "Refresh" button in the footer
      // below for sooner than that.
      tooltip:
        '"Offline" means this works with no network and no token -- not that it never updates. CircleCI\'s config-adjacent documentation, rendered from the AsciiDoc source of circleci/circleci-docs with CircleCI\'s permission, ships inside this binary and checks for an update in the background every seven days; the footer\'s "Refresh" button checks sooner.',
    };
  }, [tab, shownGuide]);

  // Reached from *both* surfaces: `EntryDetail` (Keys, already in
  // `reference`) and `PolicyRulesView` (Policies, in `project`) share this
  // one callback (see the content switch below), so a policy violation's
  // "read the full section" link has to be able to jump *into* `reference`
  // from `project`, not just change tabs within whichever surface happened
  // to trigger it -- otherwise clicking it from Policies would silently do
  // nothing visible (`guides` rendering behind the still-shown `project`
  // surface).
  function openGuideSection(nextGuideId: string, sectionId: string) {
    setGuideId(nextGuideId);
    setGuideSectionId(sectionId);
    setSurface('reference');
    setReferenceTab('guides');
  }

  const currentTabs: readonly (readonly [Tab, string])[] =
    surface === 'reference' ? REFERENCE_TABS : PROJECT_TABS;

  function selectTab(id: Tab) {
    if (surface === 'reference') setReferenceTab(id as ReferenceTab);
    else setProjectTab(id as ProjectTab);
  }

  return (
    <Panel
      title={SURFACE_LABEL[surface]}
      headerExtra={
        <Tooltip content={badge.tooltip}>
          <span tabIndex={0}>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        </Tooltip>
      }
      contentClassName="p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Issue #306: which of the two surfaces this slot is currently
            showing. Modelled on `PresetSwitcher`'s own "row of toggle
            buttons in a `role=group`" shape -- the same widget style this
            app already uses for "pick one of a small, fixed set of
            arrangements" (`layout/PresetSwitcher.tsx`, `DagPane`'s
            Source/Compiled toggle) -- rather than a second `tablist`, since
            these two are not two views of the same content the way the tab
            strip below is: they are the two panes the owner asked to split
            apart, and a screen reader should not hear them announced as
            more tabs of the one it's already in. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-cc-border px-2 py-1.5">
          <div
            role="group"
            aria-label="Reference pane view"
            className="flex items-center gap-0.5 rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-2xs"
          >
            {(['reference', 'project'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={surface === id}
                onClick={() => setSurface(id)}
                className={`rounded px-2 py-0.5 font-medium transition-colors ${
                  surface === id
                    ? 'bg-cc-accent text-cc-on-accent'
                    : 'text-cc-text-muted hover:text-cc-text'
                }`}
              >
                {SURFACE_LABEL[id]}
              </button>
            ))}
          </div>
        </div>
        <div
          // Issue #248 grew this strip from three tabs to four, and #285
          // again to five -- both measured against the pane's own 260px
          // floor (`MIN_PANE_PX.docs`) and tightened (`px-2`/`gap-0.5`, then
          // `px-1.5`) to keep fitting. Issue #306 pulled the strip back down
          // to at most three tabs per surface, which fits at this floor with
          // real room to spare (measured -- see the width-budget spec
          // below) -- padding is left at the #285 values rather than
          // loosened back up, since there is no defect to fix and no reason
          // to touch a number a future tab addition will have to re-measure
          // anyway.
          className="flex shrink-0 gap-0 border-b border-cc-border px-1.5 py-1.5"
          role="tablist"
          aria-labelledby={tabsLabelId}
        >
          <span id={tabsLabelId} className="sr-only">
            {SURFACE_LABEL[surface]} view
          </span>
          {currentTabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => selectTab(id)}
              className={`rounded px-1.5 py-1 text-2xs font-medium transition-colors ${
                tab === id
                  ? 'bg-cc-accent text-cc-on-accent'
                  : 'text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'keys' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {schemaLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner label="Loading reference" />
              </div>
            ) : schemaUnavailable ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-sm font-medium text-cc-text">
                  Reference unavailable
                </p>
                <p className="max-w-xs text-xs text-cc-text-muted">
                  This app&apos;s own local server didn&apos;t return the
                  vendored configuration schema. Editing and validation are
                  unaffected.
                </p>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1">
                <div className="flex w-1/2 min-w-0 flex-col border-r border-cc-border">
                  <div className="shrink-0 p-2">
                    <label htmlFor={searchId} className="sr-only">
                      Search the configuration reference
                    </label>
                    <input
                      id={searchId}
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search keys, steps, values…"
                      className="w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none placeholder:text-cc-text-faint focus-visible:border-cc-accent"
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    <EntryList
                      sections={filtered}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                    />
                  </div>
                </div>
                <div className="w-1/2 min-w-0">
                  {selectedEntry ? (
                    <EntryDetail
                      entry={selectedEntry}
                      reference={reference}
                      onOpenGuideSection={openGuideSection}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-cc-text-faint">
                      Select a key on the left to see what it accepts.
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Kept even though the Guides tab now renders these pages
                in-app: the Keys view must always offer a way out to the
                canonical page, including when the guides themselves could not
                be loaded. Resolved through `DOCS_LINKS` so the live link check
                covers them. */}
            <div className="flex shrink-0 flex-wrap gap-3 border-t border-cc-border px-3 py-2">
              {FALLBACK_LINKS.map((link) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-2xs text-cc-accent hover:underline"
                >
                  {`${link.label} ↗`}
                </a>
              ))}
            </div>
          </div>
        ) : tab === 'policies' ? (
          // Issue #215's "browsing policies" half, grown into the full
          // violation detail by #247's later steer ("having policies over
          // there would be really helpful"). It lives here rather than in
          // the palette: the palette lists things you *insert* into a
          // config and is already crowded (#178), while this pane is where
          // "what may I write" already lives -- and an organization's
          // enabled rules are exactly that.
          //
          // `onOpenGuideSection` is the same callback `EntryDetail` already
          // uses to cross into the Guides tab -- reused rather than
          // duplicated, so this view never grows a second navigation
          // mechanism of its own.
          <PolicyRulesView onOpenGuideSection={openGuideSection} />
        ) : tab === 'project' ? (
          // Issue #248: the project record, its settings, its environment
          // variable names, and links out to both in the CircleCI web UI --
          // moved here from the palette's old Project section (issue #105)
          // for the reason `ProjectReferenceView`'s own doc comment gives.
          <ProjectReferenceView />
        ) : tab === 'caches' ? (
          // Issue #285: the answer, in the product rather than only in an
          // issue, to "what refreshes recurringly and what doesn't" -- see
          // CachesView's own doc comment for the three separate times the
          // owner asked a version of that question.
          <CachesView />
        ) : guidesLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner label="Loading guides" />
          </div>
        ) : guidesResponse.available && guides.length > 0 ? (
          <GuideView
            guides={guides}
            provenance={guidesResponse.provenance}
            guideId={guideId}
            onGuideChange={setGuideId}
            sectionId={guideSectionId}
            onSectionChange={setGuideSectionId}
            onRefresh={refreshGuides}
          />
        ) : (
          <GuidesUnavailable
            reason={guidesResponse.reason}
            links={
              guidesResponse.links.length > 0
                ? guidesResponse.links
                : FALLBACK_LINKS
            }
          />
        )}
      </div>
    </Panel>
  );
}
