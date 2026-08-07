/**
 * Issue #292's second wave of palette recommendations, alongside (never
 * inside) `DuplicationSuggestions.tsx` -- deliberately its own file and its
 * own dismissal state, rather than an addition to that already-established
 * component. `DuplicationSuggestions` is issue #79's own shipped feature
 * (and already covers this issue's first approved candidate, "repeated
 * step sequences -> a reusable command"); keeping it untouched means this
 * work is purely additive to the palette's existing surface -- one new
 * import and one new render line in `Palette.tsx` -- which matters because
 * #285 is concurrently touching this same pane for an unrelated reason
 * (refresh affordances). Two independent files can both change without
 * either one's diff touching a line the other did.
 *
 * Five detectors feed this component, each read-only and pure
 * (`~/lib/graph/detect*`), each rendered as its own small dismissible card
 * in the same idiom `DuplicationSuggestions` established: never a modal,
 * never blocking, silent when a detector has nothing to say. Every card's
 * prose follows the format issue #292 pulled from
 * CircleCI Field Engineering's own config-review methodology -- "consider doing
 * {specific recommendation} because {specific reason} which will lead to
 * {specific outcome}", built from this config's own names and values, never
 * a generic "consider using X" -- and never promises a specific amount of
 * change (that manual's own explicit rule).
 *
 * A lightweight severity label (`SeverityBadge`) mirrors that same
 * methodology's major/minor split: cross-job or cross-workflow is "major",
 * a single job (or something as low-impact as one version bump) is
 * "minor". It is one small muted word, not a colored chip -- these are
 * suggestions, not diagnostics, and must never visually compete with the
 * validation/policy/graph problem surfaces that own real errors.
 *
 * Three of the five cards can act on the document (bump an orb version,
 * extract an image tag to a parameter, add a cache fallback key); the
 * matrix candidate is information only -- see `detectMatrixCandidates.ts`'s
 * own doc comment for why that one recommendation deliberately has no
 * "do it for me" button. The fifth, resource-utilisation right-sizing
 * (issue #307, reversing #292's own earlier rejection -- see
 * `detectResourceUtilization.ts`), is *conditionally* actionable: it only
 * offers a "move to X" button once `resourceClassCatalog.ts` (issue #8) has
 * confirmed X is a real class one size up or down from the job's current
 * one, ranked from CircleCI's own vendored resource tables -- never from
 * issue #305's offerings cache, which carries no size information at all
 * (see that module's own doc comment). When the tables cannot say -- an
 * unrecognised class, or the response not having loaded yet -- this still
 * renders as information only, like the matrix candidate, for the same
 * reason: a button that might not work is worse than no button.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { Document } from 'yaml';

import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  findMissingCacheFallbacks,
  type MissingCacheFallbackGroup,
} from '~/lib/graph/detectCacheFallback';
import {
  findMatrixCandidates,
  type MatrixCandidateGroup,
} from '~/lib/graph/detectMatrixCandidates';
import {
  findOutdatedOrbs,
  type OutdatedOrbGroup,
} from '~/lib/graph/detectOutdatedOrbs';
import {
  findRepeatedImageTags,
  type RepeatedImageTagGroup,
} from '~/lib/graph/detectRepeatedImageTags';
import {
  findResourceUtilizationFindings,
  LOW_CPU_THRESHOLD_PCT,
  type UtilizationFinding,
} from '~/lib/graph/detectResourceUtilization';
import { addCacheFallbackKey } from '~/lib/mutations/cacheFallbackMutations';
import { extractImageTagToParameter } from '~/lib/mutations/imageParameterMutations';
import { bumpOrbVersion } from '~/lib/mutations/orbBumpMutation';
import { setResourceClass } from '~/lib/mutations/resourceClassMutations';
import { createResourceClassCatalog } from '~/lib/resourceClasses/resourceClassCatalog';
import { useResourceClasses } from '~/lib/resourceClasses/useResourceClasses';
import type { UsageStatus } from '~/lib/rpc/client';
import { listKeys } from '~/lib/yaml/documentUtils';
import { useOrbStore } from '~/state/orbStore';
import {
  USAGE_WINDOW_OPTIONS,
  useUsageStore,
  type UsageWindowDays,
} from '~/state/usageStore';

import { generateUniqueName } from '../dagUtils';

type MutateFn = (fn: (doc: Document) => void) => void;

function SeverityBadge({ level }: { level: 'major' | 'minor' }) {
  return (
    <span className="shrink-0 rounded px-1 py-0.5 text-2xs uppercase tracking-wide text-cc-text-faint">
      {level === 'major' ? 'Cross-job' : 'Single job'}
    </span>
  );
}

/** The shared card shell every suggestion below uses -- same shape as `DuplicationSuggestions.tsx`'s own `SuggestionCard`, kept as an independent copy rather than an import so the two files never need to agree on a shared prop contract (see this module's doc comment on why they're independent at all). */
function RecommendationCard({
  severity,
  title,
  body,
  example,
  docsLink,
  onDismiss,
  action,
}: {
  severity: 'major' | 'minor';
  title: string;
  body: string;
  example?: string;
  docsLink: { label: string; url: string };
  onDismiss: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-cc-border-strong bg-cc-panel-raised p-2">
      <div className="mb-1 flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-2xs font-medium text-cc-text">
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <SeverityBadge level={severity} />
          <button
            type="button"
            aria-label="Dismiss this suggestion"
            onClick={onDismiss}
            className="rounded px-1 text-cc-text-muted hover:bg-cc-danger/20 hover:text-cc-danger"
          >
            &times;
          </button>
        </div>
      </div>
      <p className="mb-1 text-2xs text-cc-text-muted">
        {body} <DocsLink label={docsLink.label} url={docsLink.url} />
      </p>
      {example ? (
        <p className="mb-1.5 rounded bg-cc-panel px-1.5 py-1 font-mono text-2xs text-cc-text-faint">
          {example}
        </p>
      ) : null}
      {action}
    </div>
  );
}

function MatrixSuggestionCard({
  group,
  onDismiss,
}: {
  group: MatrixCandidateGroup;
  onDismiss: () => void;
}) {
  const paramList = group.paramNames.join(', ');
  const example = group.combos
    .map((combo) =>
      group.paramNames
        .map((name) => `${name}: ${String(combo[name])}`)
        .join(', '),
    )
    .join(' | ');

  return (
    <RecommendationCard
      severity="major"
      title={`"${group.jobName}" is invoked ${group.entryIds.length} times in workflow "${group.workflowName}" with different ${paramList}`}
      body={`Consider replacing these ${group.entryIds.length} entries with a single matrix: block on "${group.jobName}" because CircleCI expands a matrix into the same set of jobs automatically, which means a new ${paramList} value becomes one line in the parameter list instead of a whole new copy of the entry.`}
      example={`Example from this workflow: ${example}`}
      docsLink={DOCS_LINKS.guides.matrixJobs}
      onDismiss={onDismiss}
    />
  );
}

function OutdatedOrbSuggestionCard({
  group,
  mutate,
  onDismiss,
}: {
  group: OutdatedOrbGroup;
  mutate: MutateFn;
  onDismiss: () => void;
}) {
  const fromRef = `${group.orbName}@${group.pinnedVersion}`;
  const toRef = `${group.orbName}@${group.latestVersion}`;

  return (
    <RecommendationCard
      severity="minor"
      title={`${fromRef} is behind the registry's latest (${group.latestVersion})`}
      body={`This is information, not a problem -- plenty of teams pin an orb version deliberately. Consider bumping to ${group.latestVersion} when convenient because it picks up whatever fixes and step changes this orb published since ${group.pinnedVersion}, which mainly matters if you're chasing something specific it added.`}
      docsLink={DOCS_LINKS.orbs.versioning}
      onDismiss={onDismiss}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            mutate((doc) => bumpOrbVersion(doc, group.alias, fromRef, toRef));
            onDismiss();
          }}
        >
          Update to {group.latestVersion}
        </Button>
      }
    />
  );
}

function ImageTagSuggestionCard({
  group,
  existingNames,
  mutate,
  onDismiss,
}: {
  group: RepeatedImageTagGroup;
  existingNames: readonly string[];
  mutate: MutateFn;
  onDismiss: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(() =>
    generateUniqueName('image-tag', existingNames),
  );
  const trimmed = name.trim();
  const problem =
    trimmed.length === 0
      ? 'A parameter name is required.'
      : existingNames.includes(trimmed)
        ? `"${trimmed}" already exists.`
        : null;

  const owners = group.locations.map((l) => l.owner).join(', ');

  return (
    <RecommendationCard
      severity="major"
      title={`${group.locations.length} places pin the exact image "${group.image}"`}
      body={`Consider extracting "${group.image}" into a pipeline parameter because every one of these ${group.locations.length} spots (${owners}) would then read from one declaration, which means bumping the image later is a single default: edit instead of one per job.`}
      docsLink={DOCS_LINKS.guides.pipelineVariables}
      onDismiss={onDismiss}
      action={
        <div className="flex items-center gap-1.5">
          <label htmlFor={nameId} className="sr-only">
            New parameter name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border border-cc-border-strong bg-cc-panel px-2 py-1 text-2xs font-mono text-cc-text outline-none focus-visible:border-cc-accent"
            aria-invalid={problem ? true : undefined}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={problem !== null}
            onClick={() => {
              mutate((doc) =>
                extractImageTagToParameter(
                  doc,
                  group.locations.map((l) => l.path),
                  group.image,
                  trimmed,
                ),
              );
              onDismiss();
            }}
          >
            Extract
          </Button>
        </div>
      }
    />
  );
}

function CacheFallbackSuggestionCard({
  group,
  mutate,
  onDismiss,
}: {
  group: MissingCacheFallbackGroup;
  mutate: MutateFn;
  onDismiss: () => void;
}) {
  const [fallback, setFallback] = useState(group.suggestedFallback);
  const fallbackId = useId();

  return (
    <RecommendationCard
      severity="minor"
      title={`restore_cache in "${group.jobName}" has one key and no fallback`}
      body={`Consider adding a fallback key alongside "${group.originalKey}" because CircleCI only uses a key's checksum portion for an exact match, so a fallback prefix like this lets the job restore the closest earlier cache instead of starting from nothing when the checksum changes.`}
      docsLink={DOCS_LINKS.guides.caching}
      onDismiss={onDismiss}
      action={
        <div className="flex items-center gap-1.5">
          <label htmlFor={fallbackId} className="sr-only">
            Fallback key
          </label>
          <input
            id={fallbackId}
            value={fallback}
            onChange={(event) => setFallback(event.target.value)}
            className="w-full rounded-md border border-cc-border-strong bg-cc-panel px-2 py-1 text-2xs font-mono text-cc-text outline-none focus-visible:border-cc-accent"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={fallback.trim().length === 0}
            onClick={() => {
              mutate((doc) =>
                addCacheFallbackKey(
                  doc,
                  group.jobName,
                  group.stepIndex,
                  fallback.trim(),
                ),
              );
              onDismiss();
            }}
          >
            Add fallback key
          </Button>
        </div>
      }
    />
  );
}

/**
 * The right-sizing card for one `UtilizationFinding` (issue #307). Its two
 * kinds are worded differently on purpose (see `detectResourceUtilization.ts`'s
 * own doc comment on why they are separate claims): `'low-cpu'` hedges --
 * an I/O-bound job can look identical and would be no faster on a smaller
 * class -- while `'high-ram'` is framed as a real risk (an OOM-adjacent run
 * is closer to an outright failure than to a cost question), never merged
 * into one "right-size" sentence. Neither ever states or implies a specific
 * credit saving; `runs`/`windowDays` are always said out loud, per issue
 * #307's own sample-size requirement.
 *
 * The action button only appears once `finding.suggestedClass` is populated
 * -- i.e. once issue #305's offerings cache has confirmed that class
 * actually exists for this job's platform. Until #305 lands, no call site
 * populates it (see `RecommendationsSection`'s own `useMemo` below), so
 * every card here renders as information only, like `MatrixSuggestionCard`.
 */
function UtilizationSuggestionCard({
  finding,
  mutate,
  onDismiss,
}: {
  finding: UtilizationFinding;
  mutate: MutateFn;
  onDismiss: () => void;
}) {
  const jobRef = `"${finding.jobName}"`;
  const window = `${finding.runs} runs over the last ${finding.windowDays} days`;

  const title =
    finding.kind === 'low-cpu'
      ? `${jobRef} averaged ${finding.metricPct.toFixed(0)}% median CPU on ${finding.resourceClass}`
      : `${jobRef} peaked at ${finding.metricPct.toFixed(0)}% RAM on ${finding.resourceClass}`;

  // Naming a class (once `finding.suggestedClass` is populated) is phrased as
  // what utilisation *suggests*, never as an instruction to move -- issue #8's
  // own explicit rule. Resource-class access depends on the org's CircleCI
  // plan and its Cloud/Server tier, which this component has no way to know,
  // so a suggestion that happened to name a class the reader cannot actually
  // select would be a confident wrong answer -- worse than the unnamed form
  // below it falls back to when no catalog match exists. The plan-dependence
  // sentence is only added when a class *is* named; the unnamed branches
  // already make no claim about availability to hedge.
  const body =
    finding.kind === 'low-cpu'
      ? finding.suggestedClass
        ? `${jobRef} stayed under ${LOW_CPU_THRESHOLD_PCT}% median CPU across ${window} on ${finding.resourceClass}, and utilisation suggests \`${finding.suggestedClass}\` would be enough -- though an I/O-bound job can look the same way and would be no faster on a smaller class, so check what it's actually waiting on before assuming this one is oversized. Whether \`${finding.suggestedClass}\` is actually available depends on your CircleCI plan and Cloud/Server tier, so this names a target to check, not an instruction.`
        : `Consider a smaller resource class for ${jobRef} because it stayed under ${LOW_CPU_THRESHOLD_PCT}% median CPU across ${window} on ${finding.resourceClass}, which suggests it isn't using the compute it's paying for -- though an I/O-bound job can look the same way and would be no faster on a smaller class, so check what it's actually waiting on before assuming this one is oversized.`
      : finding.suggestedClass
        ? `${jobRef}'s worst run reached ${finding.metricPct.toFixed(0)}% RAM utilisation across ${window} on ${finding.resourceClass}, which is close to the ceiling -- a run that close is more likely to fail outright with an out-of-memory error than to simply be inefficient. Utilisation suggests \`${finding.suggestedClass}\` would give it headroom, though whether it's actually available depends on your CircleCI plan and Cloud/Server tier, so this names a target to check, not an instruction.`
        : `Consider a resource class with more memory for ${jobRef} because its worst run reached ${finding.metricPct.toFixed(0)}% RAM utilisation across ${window} on ${finding.resourceClass}, which is close to the ceiling -- a run that close is more likely to fail outright with an out-of-memory error than to simply be inefficient.`;

  return (
    <RecommendationCard
      severity="minor"
      title={title}
      body={body}
      docsLink={DOCS_LINKS.executors.resourceClass}
      onDismiss={onDismiss}
      action={
        finding.suggestedClass ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              mutate((doc) =>
                setResourceClass(doc, finding.jobName, finding.suggestedClass!),
              );
              onDismiss();
            }}
          >
            Move to {finding.suggestedClass}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * The manual "check now" affordance issue #285 established for every other
 * cache, plus the configurable window issue #307 itself asks for -- shown
 * once, above every `UtilizationSuggestionCard`, rather than repeated per
 * card. `windowDays`/`onWindowDaysChange` are the `useUsageStore` values
 * directly; a change re-fetches with the new window (see
 * `usageStore.setWindowDays`).
 */
function UtilizationHeader({
  status,
  windowDays,
  onWindowDaysChange,
  onRefresh,
}: {
  status: UsageStatus | null;
  windowDays: UsageWindowDays;
  onWindowDaysChange: (days: UsageWindowDays) => void;
  onRefresh: () => void;
}) {
  const warming = status?.warming ?? false;

  return (
    <div className="flex items-center justify-between gap-2 px-0.5 text-2xs text-cc-text-faint">
      <span>
        Resource-class suggestions below are from usage data over the last{' '}
        <select
          aria-label="Usage data window"
          value={windowDays}
          onChange={(event) =>
            onWindowDaysChange(Number(event.target.value) as UsageWindowDays)
          }
          className="rounded border border-cc-border-strong bg-cc-panel px-1 py-0.5 text-2xs text-cc-text"
        >
          {USAGE_WINDOW_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {days} days
            </option>
          ))}
        </select>{' '}
        -- see the Caches tab for what that downloads and why.
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        disabled={warming}
        title={
          warming
            ? 'Re-checking usage data -- this can take a while for a large organisation'
            : 'Fetch the latest usage data now, instead of waiting for the next automatic check'
        }
      >
        {warming ? (
          <span className="flex items-center gap-1.5">
            <Spinner size={12} label="Refreshing" />
            Refreshing…
          </span>
        ) : (
          'Refresh'
        )}
      </Button>
    </div>
  );
}

type Suggestion =
  | { kind: 'matrix'; key: string; group: MatrixCandidateGroup }
  | { kind: 'orb'; key: string; group: OutdatedOrbGroup }
  | { kind: 'image'; key: string; group: RepeatedImageTagGroup }
  | { kind: 'cache'; key: string; group: MissingCacheFallbackGroup }
  | { kind: 'utilization'; key: string; finding: UtilizationFinding };

export function RecommendationsSection({
  doc,
  mutate,
}: {
  doc: Document | null;
  mutate: MutateFn;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const orbVersionsCache = useOrbStore((s) => s.orbVersionsCache);

  // Reads whatever the host's background-warmed usage cache already holds
  // (issue #307); never itself the thing that triggers a fetch of org-wide
  // data -- see `useUsageStore`'s own doc comment. `ensureFetched` is a
  // no-op after the first call this session, so mounting this section
  // twice (e.g. switching workflows) never issues a second request.
  const usageJobs = useUsageStore((s) => s.jobs);
  const usageStatus = useUsageStore((s) => s.status);
  const ensureUsageFetched = useUsageStore((s) => s.ensureFetched);
  const refreshUsage = useUsageStore((s) => s.refresh);
  const usageWindowDays = useUsageStore((s) => s.windowDays);
  const setUsageWindowDays = useUsageStore((s) => s.setWindowDays);
  useEffect(() => {
    ensureUsageFetched();
  }, [ensureUsageFetched]);

  // `undefined` while the shared, session-cached `/api/resource-classes`
  // fetch is in flight (see `useResourceClasses`'s own doc comment) -- every
  // finding below still fires in that window, just with no `suggestedClass`,
  // the same honest-degradation path a table the host cannot parse takes.
  const resourceClasses = useResourceClasses();
  const resourceClassCatalog = useMemo(
    () =>
      resourceClasses
        ? createResourceClassCatalog(resourceClasses.environments)
        : undefined,
    [resourceClasses],
  );

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!doc) return [];
    return [
      ...findMatrixCandidates(doc).map(
        (group): Suggestion => ({
          kind: 'matrix',
          key: `matrix:${group.workflowName}:${group.jobName}:${group.entryIds.join(',')}`,
          group,
        }),
      ),
      ...findOutdatedOrbs(doc, orbVersionsCache).map(
        (group): Suggestion => ({
          kind: 'orb',
          key: `orb:${group.alias}`,
          group,
        }),
      ),
      ...findRepeatedImageTags(doc).map(
        (group): Suggestion => ({
          kind: 'image',
          key: `image:${group.image}`,
          group,
        }),
      ),
      ...findMissingCacheFallbacks(doc).map(
        (group): Suggestion => ({
          kind: 'cache',
          key: `cache:${group.jobName}:${group.stepIndex}`,
          group,
        }),
      ),
      // `resourceClassCatalog` (issue #8) is what lets a finding populate
      // `suggestedClass` at all -- see this component's own doc comment on
      // why that catalog is the vendored resource tables, ranked by their
      // own vCPU/RAM columns, and not issue #305's offerings cache.
      ...findResourceUtilizationFindings(
        doc,
        usageJobs,
        usageWindowDays,
        resourceClassCatalog,
      ).map(
        (finding): Suggestion => ({
          kind: 'utilization',
          key: `utilization:${finding.kind}:${finding.jobName}:${finding.resourceClass}`,
          finding,
        }),
      ),
    ];
  }, [doc, orbVersionsCache, usageJobs, usageWindowDays, resourceClassCatalog]);

  const visible = suggestions.filter((s) => !dismissed.has(s.key));
  if (!doc || visible.length === 0) return null;

  const existingParameterNames = listKeys(doc, ['parameters']);
  const dismiss = (key: string) =>
    setDismissed((prev) => new Set(prev).add(key));
  const hasUtilizationSuggestion = visible.some(
    (s) => s.kind === 'utilization',
  );

  return (
    <div
      className="space-y-2"
      role="region"
      aria-label="More config recommendations"
    >
      {hasUtilizationSuggestion ? (
        <UtilizationHeader
          status={usageStatus}
          windowDays={usageWindowDays}
          onWindowDaysChange={setUsageWindowDays}
          onRefresh={refreshUsage}
        />
      ) : null}
      {visible.map((s) => {
        switch (s.kind) {
          case 'matrix':
            return (
              <MatrixSuggestionCard
                key={s.key}
                group={s.group}
                onDismiss={() => dismiss(s.key)}
              />
            );
          case 'orb':
            return (
              <OutdatedOrbSuggestionCard
                key={s.key}
                group={s.group}
                mutate={mutate}
                onDismiss={() => dismiss(s.key)}
              />
            );
          case 'image':
            return (
              <ImageTagSuggestionCard
                key={s.key}
                group={s.group}
                existingNames={existingParameterNames}
                mutate={mutate}
                onDismiss={() => dismiss(s.key)}
              />
            );
          case 'cache':
            return (
              <CacheFallbackSuggestionCard
                key={s.key}
                group={s.group}
                mutate={mutate}
                onDismiss={() => dismiss(s.key)}
              />
            );
          case 'utilization':
            return (
              <UtilizationSuggestionCard
                key={s.key}
                finding={s.finding}
                mutate={mutate}
                onDismiss={() => dismiss(s.key)}
              />
            );
        }
      })}
    </div>
  );
}
