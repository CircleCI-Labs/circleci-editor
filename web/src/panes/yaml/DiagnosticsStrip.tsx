/**
 * Issue #148's answer to "the config is invalid and nothing told me": a
 * strip pinned under the YAML editor that names what is wrong, where, and
 * what can be done about it -- without the user having to switch to the
 * compiled view to find out anything went wrong at all.
 *
 * ## Why this is a navigator, not a list
 *
 * The thing it replaces was a `<ul>` of every `errors[]` entry inside a
 * `max-h-32 overflow-y-auto` box. That was wrong twice over: CircleCI
 * returns one entry *per line of a report* (see `lib/validation/diagnostics`),
 * so a single misspelled key rendered as twenty-odd bullets; and a bounded
 * scrolling box inside a pane is exactly the "there's 5 different scroll
 * bars" complaint #88 was about.
 *
 * So: one diagnostic at a time, with Previous/Next. Fixed height regardless
 * of how much the compiler said, no scroll region in the default state, and
 * the act of stepping through errors is the same act as jumping the cursor
 * to each one. The full, verbatim compiler output is one keystroke away
 * behind a disclosure -- never dropped, just not the default.
 *
 * ## Honesty rules this component is responsible for
 *
 *  - Every diagnostic is labelled with where it came from. A local check is
 *    never presented as something CircleCI said.
 *  - A location is shown only when one exists, tagged with how it was
 *    arrived at. When there isn't one it says so, in words, rather than
 *    quietly offering no jump target.
 *  - "No reliable automatic fix" is a real, stated outcome -- see
 *    `suggestions.ts` for what is deliberately declined and why.
 *  - Nothing is rendered at all for a config with no findings. A valid
 *    config gets no permanent warning furniture.
 */
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { useFixWithAi } from '~/lib/ai/useFixWithAi';
import { getOrbSource } from '~/lib/rpc/client';
import type { DiagnosticsResult } from '~/lib/validation/build';
import { describeSource } from '~/lib/validation/diagnostics';
import {
  orbVersionSuggestion,
  suggestionsFor,
  type Suggestion,
} from '~/lib/validation/suggestions';
import { useAppStore } from '~/state/appStore';

import { LocationButton } from './LocationButton';

function SuggestionRow({
  suggestion,
  onApply,
}: {
  suggestion: Suggestion;
  onApply: (suggestion: Suggestion) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <Button
        size="sm"
        variant={suggestion.changesBehavior ? 'ghost' : 'secondary'}
        onClick={() => onApply(suggestion)}
      >
        {suggestion.label}
      </Button>
      {/* The rationale is not decoration: it is how a user checks a
          suggestion instead of trusting it. */}
      <p className="min-w-0 flex-1 pt-1 text-2xs leading-relaxed text-cc-text-faint">
        {suggestion.rationale}
      </p>
    </div>
  );
}

interface DiagnosticsStripProps {
  result: DiagnosticsResult;
  /**
   * Which diagnostic is showing. Owned by `YamlPane` rather than by this
   * component because the editor's own line marks need to know which one is
   * "current" in order to highlight it differently -- one source of truth
   * for that, not two that can disagree.
   */
  index: number;
  onIndexChange: (index: number) => void;
  /** Moves the editor cursor. Provided by `YamlPane`, which owns the CodeMirror view. */
  onGoToLine: (line: number, column: number) => void;
}

export function DiagnosticsStrip({
  result,
  index,
  onIndexChange,
  onGoToLine,
}: DiagnosticsStripProps) {
  const doc = useAppStore((state) => state.doc);
  const text = useAppStore((state) => state.text);
  const configPath = useAppStore((state) => state.configPath);
  const mutate = useAppStore((state) => state.mutate);

  const [showFullOutput, setShowFullOutput] = useState(false);
  const {
    notice: aiNotice,
    setNotice: setAiNotice,
    run: runFixWithAi,
  } = useFixWithAi();
  const [asyncSuggestion, setAsyncSuggestion] = useState<Suggestion | null>(
    null,
  );
  /** What the registry said this orb's versions are, when the diagnostic is about one (#210). `null` until asked, or when the lookup was unavailable. */
  const [orbVersions, setOrbVersions] = useState<{
    versions?: readonly string[];
    latestVersion?: string;
  } | null>(null);

  const { diagnostics } = result;
  const count = diagnostics.length;

  // Keep the cursor within bounds as the user's edits change the error set:
  // fixing error #3 of 3 must land on #2, not on nothing.
  const safeIndex = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
  const current = diagnostics[safeIndex];

  useEffect(() => {
    setShowFullOutput(false);
    setAiNotice(null);
  }, [current?.id, current?.title, setAiNotice]);

  const suggestions = useMemo(
    () => (current ? suggestionsFor(current, doc) : []),
    [current, doc],
  );

  // The one suggestion that needs the registry: an orb whose *version*
  // doesn't exist. Deliberately additive and best-effort -- if the lookup is
  // unavailable (no token) or fails, the diagnostic simply has no suggestion,
  // exactly as if this code weren't here. Nothing else in this component
  // needs the network.
  const orbTarget =
    current?.target?.kind === 'orb' ? current.target : undefined;
  const orbRef = orbTarget?.ref;
  useEffect(() => {
    setAsyncSuggestion(null);
    setOrbVersions(null);
    if (!orbTarget || !orbRef) return;
    let cancelled = false;
    getOrbSource(orbTarget.orbName)
      .then((response) => {
        if (cancelled || !response.available) return;
        // Issue #210: the same response already carries the orb's full version
        // history, and until now this component used it for one suggestion and
        // threw the rest away. Kept, so "Fix with AI" can state the real
        // published versions as facts instead of leaving a model to guess -- see
        // `buildFixPrompt`'s `orbVersions`.
        setOrbVersions({
          ...(response.versions ? { versions: response.versions } : {}),
          ...(response.latestVersion
            ? { latestVersion: response.latestVersion }
            : {}),
        });
        setAsyncSuggestion(
          orbVersionSuggestion(
            orbRef,
            orbTarget.orbName,
            orbTarget.version,
            response,
          ) ?? null,
        );
      })
      .catch(() => {
        // No suggestion, no error banner: an unreachable registry is not a
        // problem with the user's config, and the compile error itself is
        // already on screen.
      });
    return () => {
      cancelled = true;
    };
    // `orbRef` identifies the target completely (name + version), so the
    // object identity of `orbTarget` is not worth re-running on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbRef]);

  const allSuggestions = useMemo(
    () => (asyncSuggestion ? [...suggestions, asyncSuggestion] : suggestions),
    [suggestions, asyncSuggestion],
  );

  if (count === 0 || !current) return null;

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = count - errorCount;

  const handleApply = (suggestion: Suggestion) => {
    // Straight through `appStore.mutate`: one clone, one splice of only the
    // changed range back into the existing text, one undo entry, and
    // the same `editError` surfacing every other edit in the app uses if the
    // mutation refuses. This is the only way a fix reaches the document.
    mutate(suggestion.apply, suggestion.mutationLabel);
  };

  const handleFixWithAi = () =>
    runFixWithAi({
      diagnostic: current,
      text,
      configPath,
      ...(orbVersions ? { orbVersions } : {}),
    });

  const sourceLabel = describeSource(current.source);

  return (
    <div
      data-testid="diagnostics-strip"
      role="region"
      aria-label="Config validation problems"
      // Issue #185: the chrome plane (`bg-cc-bg`), matching `WorkflowTabs` at
      // the other end of the same pane and `Panel`'s own header -- this strip
      // and the tabs were the two in-pane chrome surfaces that disagreed about
      // which token they used. See `styles.css`'s surface-role table.
      className="shrink-0 border-t border-cc-danger/40 bg-cc-bg px-3 py-2"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge tone={current.severity === 'error' ? 'danger' : 'warning'}>
          {sourceLabel}
        </Badge>
        <span
          className="text-2xs font-semibold uppercase tracking-wide text-cc-text-muted"
          data-testid="diagnostics-count"
        >
          {errorCount > 0
            ? `${errorCount} error${errorCount === 1 ? '' : 's'}`
            : ''}
          {errorCount > 0 && warningCount > 0 ? ', ' : ''}
          {warningCount > 0
            ? `${warningCount} warning${warningCount === 1 ? '' : 's'}`
            : ''}
        </span>
        {count > 1 ? (
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Previous problem"
              disabled={safeIndex === 0}
              onClick={() => onIndexChange(safeIndex - 1)}
            >
              &lsaquo; Prev
            </Button>
            <span className="text-2xs tabular-nums text-cc-text-faint">
              {safeIndex + 1} / {count}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Next problem"
              disabled={safeIndex === count - 1}
              onClick={() => onIndexChange(safeIndex + 1)}
            >
              Next &rsaquo;
            </Button>
          </span>
        ) : null}
        <span className="flex-1" />
        <LocationButton diagnostic={current} onGoToLine={onGoToLine} />
      </div>

      {/* The compiler's (or the local check's) own words, never reworded. */}
      <p
        className="break-words font-mono text-xs leading-relaxed text-cc-danger"
        data-testid="diagnostic-title"
      >
        {current.title}
      </p>

      {current.context.length > 0 ? (
        <p className="mt-0.5 text-2xs text-cc-text-faint">
          Reported while compiling{' '}
          {current.context
            .map((context) => `${context.kind} "${context.name}"`)
            .join(' → ')}
          .
        </p>
      ) : null}

      {allSuggestions.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {allSuggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              onApply={handleApply}
            />
          ))}
        </div>
      ) : (
        <p className="mt-1 text-2xs text-cc-text-faint">
          No automatic fix offered for this one -- there is no single correction
          this editor can be sure of. Fix it in the source, or ask the
          assistant.
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {current.detail.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showFullOutput}
            onClick={() => setShowFullOutput((open) => !open)}
          >
            {/* `sourceLabel` verbatim, never lower-cased: "circleci compiler
                output" reads as a typo, and the label is a proper noun in one
                of its two forms. */}
            {showFullOutput ? 'Hide' : 'Show'} full {sourceLabel} output (
            {current.detail.length} more line
            {current.detail.length === 1 ? '' : 's'})
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void handleFixWithAi()}
        >
          Fix with AI
        </Button>
        {aiNotice?.kind === 'seeded' ? (
          <span role="status" className="text-2xs text-cc-text-muted">
            Prompt added to the AI pane&apos;s message box. Review it there and
            press Send -- nothing has been sent, and no edit will be applied
            without your approval.
          </span>
        ) : null}
        {aiNotice?.kind === 'no-key' ? (
          <span role="status" className="text-2xs text-cc-warning">
            No AI provider key is configured, so there is nothing to send this
            to. Add one in the AI pane&apos;s Settings, then try again --
            everything else on this strip works without it.
          </span>
        ) : null}
        {aiNotice?.kind === 'status-error' ? (
          <span role="status" className="text-2xs text-cc-warning">
            Couldn&apos;t check whether an AI provider is configured:{' '}
            {aiNotice.message}
          </span>
        ) : null}
      </div>

      {showFullOutput ? (
        // The only scrolling region this strip can ever have, and only while
        // the user has explicitly asked for it (see this module's doc
        // comment on #88). Verbatim, in the order the compiler printed
        // it -- including the JSON-Schema `oneOf` lines this app declines to
        // act on, because "we didn't understand it" is not a reason to hide
        // what the compiler said.
        <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-cc-border bg-cc-panel px-2 py-1.5 font-mono text-2xs leading-relaxed text-cc-text-muted">
          {[current.title, ...current.detail].join('\n')}
        </pre>
      ) : null}

      {result.state === 'localOnly' ? (
        <p className="mt-1.5 text-2xs text-cc-text-faint">
          These are this editor&apos;s own offline checks. This config has not
          been compiled by CircleCI
          {result.degradedReason ? `: ${result.degradedReason}` : '.'} A config
          these checks are happy with can still fail to compile.
        </p>
      ) : null}
    </div>
  );
}
