/**
 * The object palette (issue #71): replaces the old "Add job"/"Orbs"
 * buttons with one persistent, always-reachable entry point onto the DAG
 * pane, organized as three collapsible sections -- Executors, Steps, Orbs
 * (the existing `OrbBrowser`, folded in rather than kept as a separate
 * panel).
 *
 * Native `<details>`/`<summary>`, not a hand-rolled accordion: this mirrors
 * `OrbBrowser.tsx`'s own already-collapsible groups (`ElementSection`,
 * `groupByNamespace`'s namespace groups) exactly, and it's also cheap on
 * width -- a closed section costs one summary row, not its full content's
 * height. Issue #88 promoted this component's host from a fixed 320px
 * column wedged inside `DagPane` (see that file's own history for the
 * width tradeoff that used to justify keeping sections mostly closed) to
 * its own resizable pane (`PalettePane.tsx`), so the accordion today is
 * about not showing five sections' worth of content at once more than it
 * is about a hard width budget -- but the effect on scroll-region count is
 * the same either way: a closed section is zero additional scrollable
 * height inside this one column, which is still the only thing that
 * scrolls here (see the render below). Executors opens by default -- issue
 * #71 frames it as *the* primary way to start a job ("these are the
 * executors you can click and drag"); Steps and Orbs start closed.
 *
 * Orb-provided executors are deliberately not pre-enumerated in the
 * Executors section above: unlike built-in kinds and this document's own
 * `executors:` block, there is no fixed list of "every orb executor" to
 * show without already knowing which orbs to ask. They're reached by
 * searching an orb in this same panel's Orbs section and using its
 * executor's "New job" action (see `OrbBrowser`'s
 * `onCreateJobFromExecutor`), which opens the identical configure dialog.
 */
import type { Document } from 'yaml';

import { disclosureSummaryClassName } from '~/design/controlAffordance';
import type { OrbElement } from '~/lib/orbs/types';
import { OrbBrowser } from '~/panes/orbs/OrbBrowser';

import { DuplicationSuggestions } from './DuplicationSuggestions';
import { PaletteCommandSection } from './PaletteCommandSection';
import { PaletteContextSection } from './PaletteContextSection';
import { PaletteExecutorSection } from './PaletteExecutorSection';
import { PaletteParameterSection } from './PaletteParameterSection';
import { PaletteStepSection } from './PaletteStepSection';
import type { PaletteExecutorPayload } from './paletteExecutors';
import { RecommendationsSection } from './RecommendationsSection';

/**
 * Issue #183: every one of this palette's section headers is a `<details>`
 * toggle that was styled exactly like the app's non-interactive uppercase meta
 * labels (`text-2xs font-semibold uppercase text-cc-text-faint`, used for
 * inert group headings in `Inspector`, `DocsPane`, `DisclosureMenu`) -- the
 * ambiguity the owner's rule is about, in the pane with the most of them.
 * `disclosureSummaryClassName` keeps the type identical and adds the shared
 * hover boundary/fill, so a header now reads as a control at the moment a
 * pointer reaches it. Kept as a local alias so all seven `<summary>` elements
 * below still read from one name, and so this file's own rationale sits next to
 * them rather than only in the design layer.
 */
const summaryClassName = disclosureSummaryClassName;

export function Palette({
  doc,
  mutate,
  localJobNames,
  activeWorkflowName,
  onActivateExecutor,
  onAddStepToJob,
  onAddCommandToJob,
  onExtractExecutor,
  onExtractCommand,
  onAddOrbJob,
  onAddOrbCommand,
  onAddOrbExecutor,
  onCreateJobFromOrbExecutor,
  workflowEntryIds,
  onAddContextToEntry,
}: {
  doc: Document | null;
  /**
   * `useAppStore`'s `mutate`, threaded down for the Parameters section (issue
   * #250) -- the one section here that edits the document *directly* rather
   * than through a named `on...` callback.
   *
   * Deliberately the raw mutator and not a fistful of `onAddParameter`/
   * `onRenameParameter`/`onSetParameterType`/... props: the parameters editor is
   * a form over one YAML block with eight or so distinct writes, and lifting
   * every one into this component's signature would put a wrapper in `DagPane`
   * for each, none of which would do anything but forward. Every inspector
   * section already takes `mutate` for exactly this reason (`MutateFn` there),
   * and the parameters editor is shared with the inspector, so it is the same
   * prop in both places.
   */
  mutate: (fn: (doc: Document) => void) => void;
  localJobNames: string[];
  activeWorkflowName: string | undefined;
  onActivateExecutor: (payload: PaletteExecutorPayload) => void;
  onAddStepToJob: (jobName: string, stepKey: string) => void;
  /** Issue #79: the Commands section's `JobPicker` "Add" -- inserts a reference to one of this config's own `commands:` entries. */
  onAddCommandToJob: (jobName: string, commandName: string) => void;
  /** Issue #79's highest-value item: accepting a `DuplicationSuggestions` card. */
  onExtractExecutor: (jobNames: string[], executorName: string) => void;
  onExtractCommand: (jobNames: string[], commandName: string) => void;
  onAddOrbJob: (orbRef: string, element: OrbElement) => void;
  onAddOrbCommand: (
    orbRef: string,
    element: OrbElement,
    jobName: string,
  ) => void;
  onAddOrbExecutor: (
    orbRef: string,
    element: OrbElement,
    jobName: string,
  ) => void;
  onCreateJobFromOrbExecutor: (orbRef: string, element: OrbElement) => void;
  /**
   * Issue #105: the active workflow's job-entry ids, which is what a context
   * attaches to -- `context:` is a key of the workflow *entry*, not of the job
   * definition, so this is deliberately not `localJobNames`.
   */
  workflowEntryIds: string[];
  onAddContextToEntry: (entryId: string, contextName: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/*
        Issue #79's highest-value item, shown unconditionally at the top
        (not inside a collapsible section, and rendering nothing at all
        when there's nothing to suggest -- see `DuplicationSuggestions`'s
        own doc comment) rather than tucked away where a real nudge could
        go unnoticed. Each card is independently dismissible and never
        blocks anything else in this pane.
      */}
      <DuplicationSuggestions
        doc={doc}
        onExtractExecutor={onExtractExecutor}
        onExtractCommand={onExtractCommand}
      />

      {/*
        Issue #292's second wave: matrix candidates, an orb behind its
        latest, a repeated image tag, and a restore_cache with no fallback
        key. Independent detectors and independent dismissal state from
        `DuplicationSuggestions` above -- see `RecommendationsSection`'s own
        doc comment -- but the same "render nothing when there's nothing to
        say" contract.
      */}
      <RecommendationsSection doc={doc} mutate={mutate} />

      <details open className="shrink-0">
        <summary className={summaryClassName}>Executors</summary>
        <div className="mt-2">
          <PaletteExecutorSection doc={doc} onActivate={onActivateExecutor} />
        </div>
      </details>

      <details className="shrink-0">
        <summary className={summaryClassName}>Steps</summary>
        <div className="mt-2">
          <PaletteStepSection
            localJobNames={localJobNames}
            onAddToJob={onAddStepToJob}
          />
        </div>
      </details>

      {/* Issue #79: "surface the config's own commands: and parameters: as
          palette objects alongside executors -- the archived editor had a
          section per definition type." Closed by default, same as Steps --
          Executors alone is issue #71's primary path, these are secondary. */}
      <details className="shrink-0">
        <summary className={summaryClassName}>Commands</summary>
        <div className="mt-2">
          <PaletteCommandSection
            doc={doc}
            localJobNames={localJobNames}
            onAddToJob={onAddCommandToJob}
          />
        </div>
      </details>

      <details className="shrink-0">
        <summary className={summaryClassName}>Parameters</summary>
        <div className="mt-2">
          <PaletteParameterSection doc={doc} mutate={mutate} />
        </div>
      </details>

      {/* Issue #105 added Contexts here; issue #248 removed the Project
          section that used to sit beside it. Contexts stays, deliberately,
          on the owner's own rule for what belongs in this panel: a context
          is genuinely draggable (it has exactly one place to go, a workflow
          entry's `context:`), while the old Project section -- a read-only
          record, settings and environment-variable names -- was not. That
          material now lives in the Project pane's own Project tab (issue
          #306 moved it, with Policies and Caches, off the reference pane's
          tab strip -- see `panes/docs/DocsPane.tsx`)
          (`panes/docs/ProjectReferenceView.tsx`); see that file's own doc
          comment for the reasoning. Closed by default, same as every
          section below Executors. */}
      <details className="shrink-0">
        <summary className={summaryClassName}>Contexts</summary>
        <div className="mt-2">
          <PaletteContextSection
            workflowEntryIds={workflowEntryIds}
            onAddContextToEntry={onAddContextToEntry}
          />
        </div>
      </details>

      <details className="min-h-0 flex-1">
        <summary className={summaryClassName}>Orbs</summary>
        {/* `OrbBrowser` manages its own internal scroll region; this wrapper
            just gives it the remaining height once expanded. */}
        <div className="mt-2 h-[28rem] min-h-0">
          <OrbBrowser
            localJobNames={localJobNames}
            activeWorkflowName={activeWorkflowName}
            onAddJob={onAddOrbJob}
            onAddCommand={onAddOrbCommand}
            onAddExecutor={onAddOrbExecutor}
            onCreateJobFromExecutor={onCreateJobFromOrbExecutor}
          />
        </div>
      </details>
    </div>
  );
}
