/**
 * The palette's Contexts section (issue #105): the CircleCI contexts this
 * project's organization has, offered as draggable cards that append
 * themselves to a workflow job entry's `context:`.
 *
 * Master/detail rather than a stack (#29): selecting a context replaces
 * the list with its detail instead of pushing a second scroll region under
 * it. Drilling in is also what fetches that context's variables -- listing
 * them all up front would be one request per context for data nobody asked
 * to see, and it means secret metadata is only ever fetched for a context the
 * user explicitly opened.
 *
 * ## On values
 *
 * The owner's request was to see "the names and also the values that the
 * contexts hold". The values half is not possible: CircleCI's API does not
 * return context secret values, deliberately. What it does return is a
 * four-character `truncated_value` preview, which this section shows and
 * labels unmistakably as a preview -- it distinguishes `AWS_ROLE` from
 * `AWS_ROLE_ARN` and confirms a context is populated rather than empty, which
 * is most of the practical question behind "what does this context actually
 * do". It is never presented as a value, and there is no affordance here that
 * implies a full value could be revealed, because none can.
 */
import { useEffect } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
import {
  guardsAgainstUnversionedConfig,
  restrictionCertainty,
  RESTRICTION_PRESENTATION,
} from '~/lib/contexts/usability';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  contextListCoverage,
  useProjectContextStore,
} from '~/state/projectContextStore';

import { JobPicker } from '~/panes/orbs/OrbBrowser';
import { ContextRestrictionList } from './ContextRestrictionList';
import { PaletteCard } from './PaletteCard';
import { setPaletteContextDragPayload } from './paletteContexts';
import { ProjectContextWarnings } from './ProjectContextWarnings';

/** A short, explanatory card -- never a spinner, never a retry -- for a state retrying cannot fix. */
function ExplanationCard({
  headline,
  children,
}: {
  headline: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-cc-border-strong bg-cc-panel-raised p-3 text-xs text-cc-text-muted">
      <p className="mb-1 font-medium text-cc-text">{headline}</p>
      <p>{children}</p>
    </div>
  );
}

export function PaletteContextSection({
  workflowEntryIds,
  onAddContextToEntry,
}: {
  /**
   * The ids of the active workflow's job entries -- what a context actually
   * attaches to. Entry ids, not job names: the same job aliased twice in one
   * workflow is two entries that can carry different contexts.
   */
  workflowEntryIds: string[];
  onAddContextToEntry: (entryId: string, contextName: string) => void;
}) {
  const state = useProjectContextStore((s) => s.state);
  const reason = useProjectContextStore((s) => s.reason);
  const error = useProjectContextStore((s) => s.error);
  const contexts = useProjectContextStore((s) => s.contexts);
  const warnings = useProjectContextStore((s) => s.warnings);
  // Only for the `pipeline.config_source` note below: whether this project can
  // start a run from an uncommitted config at all.
  const settings = useProjectContextStore((s) => s.settings);
  const selectedContextId = useProjectContextStore((s) => s.selectedContextId);
  const details = useProjectContextStore((s) => s.details);
  const loadingContextId = useProjectContextStore((s) => s.loadingContextId);
  const load = useProjectContextStore((s) => s.load);
  const selectContext = useProjectContextStore((s) => s.selectContext);
  const clearSelectedContext = useProjectContextStore(
    (s) => s.clearSelectedContext,
  );

  // Loads once when this section first mounts. `load` is itself a no-op when
  // a load is in flight or already succeeded, so mounting this section and
  // the sibling project-info section (which does the same) costs one request
  // between them, not two.
  useEffect(() => {
    void load();
  }, [load]);

  const header = (
    <div className="flex items-start justify-between gap-2">
      <p className="flex items-center gap-1.5 text-2xs text-cc-text-faint">
        <span>Contexts available to this project’s organization.</span>
        <DocsLink
          label={DOCS_LINKS.workflows.contexts.label}
          url={DOCS_LINKS.workflows.contexts.url}
        />
      </p>
      {state === 'ready' ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(true)}
          title="Re-read contexts and project settings from CircleCI"
        >
          Refresh
        </Button>
      ) : null}
    </div>
  );

  if (state === 'idle' || state === 'loading') {
    return (
      <div className="space-y-1.5">
        {header}
        <div className="flex items-center gap-2 text-xs text-cc-text-muted">
          <Spinner size={14} label="Loading" />
          <span>Loading contexts…</span>
        </div>
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="space-y-1.5">
        {header}
        <ExplanationCard headline="Contexts need a CircleCI project and API token.">
          {reason ??
            'This host has no CircleCI API token, so contexts cannot be listed.'}
        </ExplanationCard>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-1.5">
        {header}
        <div className="rounded-md border border-cc-danger/40 bg-cc-panel-raised p-3 text-xs text-cc-text-muted">
          <p className="mb-1 font-medium text-cc-text">
            Couldn’t load this project’s contexts.
          </p>
          <p className="mb-2">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void load(true)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const coverage = contextListCoverage({ state, warnings });

  const selected = selectedContextId
    ? contexts.find((c) => c.id === selectedContextId)
    : undefined;

  // Detail view: the selected context's variables. Replaces the list rather
  // than stacking beneath it (#29).
  if (selected) {
    const detail = details[selected.id];
    const isLoading = loadingContextId === selected.id;
    const certainty = detail ? restrictionCertainty(detail) : undefined;
    const presentation = certainty
      ? RESTRICTION_PRESENTATION[certainty]
      : undefined;
    // Only ever a list that was actually read: `null` is the failed call, which
    // the warning below reports instead. See `ContextDetail.restrictions`.
    const restrictions = detail?.restrictions ?? [];

    return (
      <div className="space-y-1.5">
        {header}
        <button
          type="button"
          className="text-2xs text-cc-text-muted hover:text-cc-text"
          onClick={clearSelectedContext}
        >
          ← Back to contexts
        </button>

        <div className="flex items-center gap-2">
          <span
            className="truncate font-mono text-xs text-cc-text"
            title={selected.name}
          >
            {selected.name}
          </span>
          {presentation ? (
            <Badge tone={presentation.tone}>{presentation.label}</Badge>
          ) : null}
          {/*
            The link the owner asked for, next to the badge that raises the
            question: this is the one page that can change a restriction, which
            this editor deliberately cannot (no write path to contexts).
            Absent when the host could not build a URL, rather than dead.
          */}
          {selected.webUrl ? (
            <a
              href={selected.webUrl}
              target="_blank"
              rel="noreferrer"
              title="Open this context’s settings in the CircleCI web app"
              className="ml-auto shrink-0 rounded text-2xs text-cc-accent underline outline-none focus-visible:ring-1 focus-visible:ring-cc-accent"
            >
              Settings ↗
            </a>
          ) : null}
        </div>

        {detail && presentation ? (
          <p className="text-2xs text-cc-text-faint">
            {presentation.note}
            {detail.restrictionSummary ? ` (${detail.restrictionSummary})` : ''}
          </p>
        ) : null}

        {/*
          Issue #251's core: the restrictions themselves, named. Rendered only
          when they were read -- `restrictions` is `[]` both for "there are none"
          and (defensively) for the failed call, and the sentence above already
          distinguishes those, so an empty list simply renders nothing here.
        */}
        {restrictions.length > 0 ? (
          <ContextRestrictionList restrictions={restrictions} />
        ) : null}

        {/*
          The mitigation nobody finds by accident (issue #251, PR #255). An
          unversioned run -- this editor's own "run without committing" -- gets the
          same contexts a normal build on that branch would, and CircleCI's
          security team's note on the expression that guards against it is that
          "you need to know to use it". So it is mentioned exactly where it is
          actionable: a project that *can* start such a run, looking at a context
          whose restrictions do not mention `pipeline.config_source`.
        */}
        {settings?.unversionedConfig &&
        detail?.restrictions != null &&
        !guardsAgainstUnversionedConfig(detail.restrictions) ? (
          <p className="text-2xs text-cc-text-faint">
            This project allows runs from an uncommitted config, and none of
            this context’s restrictions mentions{' '}
            <span className="font-mono">pipeline.config_source</span> — so such
            a run receives this context. An expression restriction like{' '}
            <span className="font-mono">
              not (pipeline.config_source starts-with &quot;api&quot;)
            </span>{' '}
            is what refuses it.{' '}
            <DocsLink
              label={DOCS_LINKS.workflows.contextExpressionRestrictions.label}
              url={DOCS_LINKS.workflows.contextExpressionRestrictions.url}
            />
          </p>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-cc-text-muted">
            <Spinner size={14} label="Loading" />
            <span>Loading variables…</span>
          </div>
        ) : null}

        <ProjectContextWarnings
          warnings={detail?.warnings ?? []}
          degraded={(detail?.variables.length ?? 0) > 0}
        />

        {detail && !isLoading ? (
          detail.variables.length === 0 ? (
            <p className="text-2xs text-cc-text-faint">
              This context holds no environment variables, so adding it to a job
              would have no effect.
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {detail.variables.map((variable) => (
                  <li
                    key={variable.name}
                    className="flex items-center justify-between gap-2 rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5"
                  >
                    <span
                      className="truncate font-mono text-xs text-cc-text"
                      title={variable.name}
                    >
                      {variable.name}
                    </span>
                    {variable.truncatedValue ? (
                      <span
                        className="shrink-0 font-mono text-2xs text-cc-text-faint"
                        title={`CircleCI shows only these first few characters — the full value is never returned by the API`}
                      >
                        {variable.truncatedValue}…
                      </span>
                    ) : (
                      <span className="shrink-0 text-2xs text-cc-text-faint">
                        no preview
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {/*
                Stated plainly, right where the previews are, because the
                honest answer to "why can't I see the value" is a property of
                the platform rather than of this editor.
              */}
              <p className="text-2xs text-cc-text-faint">
                Those are CircleCI’s own truncated previews, not values. Context
                values are never returned by the CircleCI API, by design — the
                preview exists only to tell similarly-named variables apart.
              </p>
            </>
          )
        ) : null}

        <div className="rounded-md border border-cc-border-strong">
          <PaletteCard
            avatarSeed={selected.name}
            title={selected.name}
            badge="context"
            description="Drag onto a job in the graph to add it to that job’s context:"
            draggable
            onDragStart={(event) =>
              setPaletteContextDragPayload(event.dataTransfer, selected.name)
            }
          />
          <div className="border-t border-cc-border bg-cc-panel-raised px-2 py-1.5">
            <JobPicker
              jobNames={workflowEntryIds}
              onAdd={(entryId) => onAddContextToEntry(entryId, selected.name)}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {header}

      {/*
        Only the warnings this section is actually about. A failed *project*
        lookup has nothing to do with the context list -- contexts are
        organization-scoped and load independently -- and showing it here is
        what made a complete, working list look broken (issue #150). It is
        surfaced in the Project section and the top bar, which is where it
        belongs.
      */}
      <ProjectContextWarnings
        warnings={warnings.filter(
          (warning) =>
            warning.kind === 'contexts' || warning.kind === 'organization',
        )}
        degraded={contexts.length > 0}
      />

      {contexts.length === 0 ? (
        // "None exist" is only sayable when the listing actually succeeded:
        // with a failed listing the honest statement is the warning above,
        // and claiming the organization has no contexts would be the same
        // class of mistake as rendering `available: false` as an empty list.
        coverage === 'complete' ? (
          <p className="text-2xs text-cc-text-faint">
            This organization has no contexts. A context is a named set of
            environment variables shared across projects — create one in the
            CircleCI web UI and it will appear here.
          </p>
        ) : null
      ) : (
        <>
          <ul className="space-y-1.5">
            {contexts.map((context) => (
              <li
                key={context.id}
                className="overflow-hidden rounded-md border border-cc-border-strong"
              >
                <PaletteCard
                  avatarSeed={context.name}
                  title={context.name}
                  badge="context"
                  draggable
                  onDragStart={(event) =>
                    setPaletteContextDragPayload(
                      event.dataTransfer,
                      context.name,
                    )
                  }
                  onActivate={() => void selectContext(context.id)}
                />
              </li>
            ))}
          </ul>
          <p className="text-2xs text-cc-text-faint">
            Drag one onto a job in the graph, or click it to see which variables
            it holds and add it from there.
          </p>
        </>
      )}
    </div>
  );
}
