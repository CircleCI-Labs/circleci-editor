import { autocompletion } from '@codemirror/autocomplete';
import { yaml } from '@codemirror/lang-yaml';
import * as RadixSwitch from '@radix-ui/react-switch';
import CodeMirror, {
  type EditorView,
  type Extension,
} from '@uiw/react-codemirror';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DiffView } from '~/design/components/DiffView';
import { Panel } from '~/design/components/Panel';
import { PolicyBadge } from '~/design/components/PolicyBadge';
import { Tooltip } from '~/design/components/Tooltip';
import { ValidationBadge } from '~/design/components/ValidationBadge';
import { countChangedLines, type DiffLine, unifiedDiff } from '~/lib/yaml/diff';
import { getSchema } from '~/lib/rpc/client';
import {
  type CircleciSchema,
  parseCircleciSchema,
} from '~/lib/schema/circleciSchema';
import { createCircleciCompletionSource } from '~/lib/schema/completion';
import { createEnvVarCompletionSource } from '~/lib/schema/envVarCompletion';
import { buildDiagnostics } from '~/lib/validation/build';
import { primeXcodeVersions } from '~/lib/xcodeVersions/useXcodeVersions';
import { diagnosticHeadline } from '~/lib/validation/diagnostics';
import { usePolicyDiagnostics } from '~/lib/validation/usePolicyDiagnostics';
import { useAiStore } from '~/state/aiStore';
import { useAppStore, type ValidationInfo } from '~/state/appStore';
import { useProjectContextStore } from '~/state/projectContextStore';
import { useThemeStore } from '~/state/themeStore';

import { DiagnosticsStrip } from './DiagnosticsStrip';
import { RunControl, RunStrip } from './RunStrip';
import {
  diagnosticLineHighlight,
  goToLine,
  type DiagnosticMark,
} from './diagnosticLines';
import { buildEditorTheme } from './editorTheme';
import { SaveDialog } from './SaveDialog';
import { reopenCompletionOnDelete } from './reopenCompletionOnDelete';
import { yamlSyntaxHighlighting } from './yamlHighlight';

function basename(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : path;
}

type PaneView = 'source' | 'compiled' | 'diff';

/**
 * Issue #53: `POST /api/validate` already returns the fully-compiled config
 * (orbs resolved, defaults applied -- see `outputYaml` in
 * `internal/circleci/compile.go`) and the frontend used to just discard it.
 * This toggle -- modelled on `PresetSwitcher` for the same
 * "segmented control" look -- surfaces it, with the always-
 * editable source one click away.
 *
 * Issue #287 adds the third segment, Diff, for the same reason: a diff of
 * the working buffer against disk already existed twice over (the Save
 * dialog, the AI pane's approval dialog) but only as a step inside someone
 * else's flow. This is "which view of the config" the same way Source and
 * Compiled already are, so it joins them here rather than becoming a new
 * dialog, a new pane, or a fourth thing to find. See `DiffConfigView` below
 * for the render side.
 */
/** The hover half of `quietControlClassName` (issue #183), without the resting
 * border and radius its two segments already carry themselves -- see the
 * comment on the buttons below. `hover:border-cc-border-interactive`, not
 * `-border-strong` (issue #200): this hover boundary is how the inactive
 * segment says "you can click me", and `-border-strong` only measures
 * 1.4:1 against this control's `-panel-raised` fill in light mode -- short
 * of 1.4.11's 3:1 floor for an interactive boundary. */
const SEGMENT_INACTIVE =
  'text-cc-text-muted hover:border-cc-border-interactive hover:bg-cc-panel-raised hover:text-cc-text';

function SourceCompiledToggle({
  value,
  onChange,
}: {
  value: PaneView;
  onChange: (view: PaneView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Config view"
      className="flex items-center gap-0.5 rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-xs"
    >
      {/* Issue #183: the *inactive* segment had no hover state at all -- it was
          plain muted text inside the group's pill, so the only clickable-looking
          thing in this control was whichever segment was already *selected*. It
          now takes the same quiet-control treatment as `Button`'s `ghost`
          variant: a boundary and a raised fill on hover.

          Spelled out rather than composed from `quietControlClassName` on
          purpose. Both segments need the transparent resting border (otherwise
          the inactive one is 2px larger and the pair visibly jumps when you
          toggle), and that constant's `rounded-sm` would collide with this
          control's own `rounded` -- two radius utilities on one element, with
          the winner decided by stylesheet order rather than by intent. */}
      <button
        type="button"
        aria-pressed={value === 'source'}
        onClick={() => onChange('source')}
        title="Your editable config source"
        className={`rounded border border-transparent px-2 py-0.5 transition-colors ${value === 'source' ? 'bg-cc-accent text-cc-on-accent' : SEGMENT_INACTIVE}`}
      >
        Source
      </button>
      <button
        type="button"
        aria-pressed={value === 'compiled'}
        onClick={() => onChange('compiled')}
        title="The fully-expanded config CircleCI actually runs (orbs resolved, defaults applied)"
        className={`rounded border border-transparent px-2 py-0.5 transition-colors ${value === 'compiled' ? 'bg-cc-accent text-cc-on-accent' : SEGMENT_INACTIVE}`}
      >
        Compiled
      </button>
      {/* Issue #287: "Diff", not "Diff vs disk" or similar -- the header
          badge (below, next to `Valid`/`Unsaved`) is where the comparison
          target gets spelled out; a three-word tab label is exactly the
          kind of thing #248 had to claw back padding to avoid at a 260px
          pane width, and this control has less room than that tab strip
          did (it shares its header row with the autosave switch, Run and
          Save). */}
      <button
        type="button"
        aria-pressed={value === 'diff'}
        onClick={() => onChange('diff')}
        title="What you've changed in this file, compared to what's on disk"
        className={`rounded border border-transparent px-2 py-0.5 transition-colors ${value === 'diff' ? 'bg-cc-accent text-cc-on-accent' : SEGMENT_INACTIVE}`}
      >
        Diff
      </button>
    </div>
  );
}

/** A centered explanatory message standing in for the read-only editor,
 * used by `CompiledConfigView` for every state that isn't "here's the
 * compiled YAML". */
function CompiledMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-cc-text-muted">
      {children}
    </div>
  );
}

/**
 * The compiled-config side of the Source/Compiled toggle. `validation`'s
 * `available` (does this host have a CIRCLE_TOKEN at all) is deliberately
 * kept distinct from `valid` (did the compiler accept *this* config) here,
 * exactly as `internal/host/validate.go`'s own doc comment insists callers
 * must: "unavailable" and "invalid" get different, honest messages rather
 * than both collapsing into a blank pane or a generic error.
 */
function CompiledConfigView({
  validation,
  parseError,
  extensions,
}: {
  validation: ValidationInfo;
  parseError: string | null;
  extensions: Extension[];
}) {
  if (parseError) {
    return (
      <CompiledMessage>
        Fix the YAML parse error in Source view to see the compiled config.
      </CompiledMessage>
    );
  }

  // `outputYaml` is only ever populated alongside `state: 'valid'` (see
  // `revalidate` in `state/appStore.ts`) -- except while a *new* validation
  // request is in flight (`state: 'checking'`), which spreads the previous
  // result forward rather than clearing it, so the last-known-good compiled
  // output stays visible (with a "Revalidating" note) instead of the pane
  // blanking out on every keystroke.
  if (validation.outputYaml !== undefined) {
    return (
      <div className="relative h-full w-full">
        {/* Issue #201: this inner `p-2` box, not the outer `relative h-full
            w-full` above, is what carries the padding -- the "Revalidating"
            banner below is `absolute inset-x-0 top-0` against the *outer*
            div specifically so it keeps spanning edge to edge, unindented by
            this padding. See the source editor's own wrapper (just below in
            this file) for the matching treatment and the full rationale:
            `className="h-full"` on `<CodeMirror>` is the actual fix (its own
            wrapper defaulted to `height: auto`, the same shape of bug
            documented there); the border/rounded/padding around it is
            issue #185's "the compiled code area reads as a distinct block"
            effect, reproduced on purpose in both views now that bounding the
            height would otherwise remove it by accident. */}
        <div className="h-full w-full p-2">
          <CodeMirror
            value={validation.outputYaml}
            height="100%"
            theme="none"
            readOnly
            extensions={extensions}
            aria-label="Compiled CircleCI config (read-only)"
            className="h-full overflow-hidden rounded-md border border-cc-border"
          />
        </div>
        {validation.state === 'checking' ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-0 border-b border-cc-border-strong bg-cc-panel/90 px-3 py-1 text-2xs text-cc-text-muted"
          >
            Revalidating -- showing the last compiled result while it re-checks
            your edits.
          </div>
        ) : null}
      </div>
    );
  }

  switch (validation.state) {
    case 'unavailable':
      return (
        <CompiledMessage>
          Compiled view unavailable
          {validation.reason ? `: ${validation.reason}` : '.'}
        </CompiledMessage>
      );
    case 'invalid':
      return (
        <CompiledMessage>
          This config doesn&apos;t compile yet -- fix the compiler errors below,
          then switch back here.
        </CompiledMessage>
      );
    case 'error':
      return (
        <CompiledMessage>
          Compiled view unavailable -- the validation request failed
          {validation.reason ? `: ${validation.reason}` : '.'}
        </CompiledMessage>
      );
    case 'checking':
      return <CompiledMessage>Validating…</CompiledMessage>;
    case 'idle':
    default:
      return (
        <CompiledMessage>
          The compiled config will appear here once validation runs.
        </CompiledMessage>
      );
  }
}

/**
 * The diff side of the pane's view toggle (issue #287): the working buffer
 * against `savedText` -- the exact same two strings, and the exact same
 * `unifiedDiff` + `DiffView` pair, that `SaveDialog` already diffs before
 * writing to disk and `ProposeChangeDialog` already diffs before applying an
 * AI-proposed edit to the live document. This is that same comparison
 * surfaced as its own view instead of a step inside either of those flows --
 * "what have I changed?", answerable without opening a dialog first.
 *
 * Deliberately independent of `parseError`/`validation`: a unified text diff
 * needs neither a successful parse nor a successful compile, so switching to
 * Diff while the source is invalid YAML still shows exactly what changed
 * (which is often the fastest way to spot the typo that broke it).
 *
 * "No changes" is a state, not a blank pane (per the issue's own framing) --
 * `DiffView`'s `emptyMessage` already renders that centred and in words, so
 * there is nothing extra to add here for it.
 */
function DiffConfigView({ lines }: { lines: DiffLine[] }) {
  return (
    // The testid scopes queries in `YamlPane.test.tsx` to this view's own
    // content -- the hidden source `<textarea>` mounted alongside it (see
    // the `hidden` comment above) can otherwise share a substring with a
    // diff line's text and make an unscoped `getByText` ambiguous.
    <div data-testid="yaml-diff-view" className="h-full w-full p-2">
      {/* One scroll region, per the source/compiled views' own pattern
          above (issue #201) and #88 generally: this bordered box, not
          `DiffView`'s internal `overflow-x-auto` (kept for a genuinely
          too-wide single line, same as `SaveDialog`'s), is what actually
          grows past the pane and needs to scroll -- so it is the one that
          gets `overflow-auto` and a clamped `h-full`, exactly like
          `.cm-editor`'s wrapper above does for the source and compiled
          `CodeMirror` instances. */}
      <div className="h-full overflow-auto rounded-md border border-cc-border">
        <DiffView
          lines={lines}
          emptyMessage="No changes -- this file matches what's on disk."
        />
      </div>
    </div>
  );
}

export function YamlPane() {
  const text = useAppStore((state) => state.text);
  const savedText = useAppStore((state) => state.savedText);
  const configPath = useAppStore((state) => state.configPath);
  const meta = useAppStore((state) => state.meta);
  const isDirty = useAppStore((state) => state.isDirty);
  const parseError = useAppStore((state) => state.parseError);
  const status = useAppStore((state) => state.status);
  const autosave = useAppStore((state) => state.autosave);
  const validation = useAppStore((state) => state.validation);
  const setText = useAppStore((state) => state.setText);
  const toggleAutosave = useAppStore((state) => state.toggleAutosave);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

  // Issue #148: the strip below and the editor's own line marks must agree on
  // which problem is "current", so the index lives here, above both.
  const [diagnosticIndex, setDiagnosticIndex] = useState(0);
  // The live CodeMirror view, captured so the strip's "line N" buttons can
  // move the cursor. A ref, not state: nothing re-renders when it lands.
  const viewRef = useRef<EditorView | null>(null);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [circleciSchema, setCircleciSchema] = useState<CircleciSchema | null>(
    null,
  );
  // Issue #53: which side of the Source/Compiled toggle is showing.
  // Pane-local, not persisted -- switching presets or reloading always
  // lands back on the editable source, which is the pane's primary job.
  const [view, setView] = useState<PaneView>('source');

  // Fetched once per pane mount from the host's static /api/schema (see
  // internal/host/schema.go) -- it never changes within a running build,
  // so there is nothing to re-fetch or invalidate. A failure here (e.g. an
  // ancient host binary predating this endpoint) is deliberately silent:
  // the editor is fully usable without schema-aware completions, so it
  // just falls back to none rather than surfacing an error banner over
  // something this non-critical.
  useEffect(() => {
    let cancelled = false;
    getSchema()
      .then((raw) => {
        if (!cancelled) setCircleciSchema(parseCircleciSchema(raw));
      })
      .catch(() => {
        // Schema-aware completions simply stay unavailable; see above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Issue #105: asks for the project's environment variable *names* so
  // `$NAME` completions work in a run command without the user having to open
  // the palette's Project section first. `load` is idempotent (and the host
  // caches briefly), so this and the palette's own call cost one request
  // between them. It never rejects out of here -- with no CircleCI token the
  // store settles on `unavailable` and the completion source proposes nothing,
  // exactly like the schema source above when its fetch fails.
  useEffect(() => {
    void useProjectContextStore.getState().load();
  }, []);

  // Issue #211: the same shape again, for the `xcode:` completion.
  // `primeXcodeVersions` is idempotent and shares one module-cached request with
  // the macOS executor field, so this costs nothing when the palette has already
  // opened that field and one request when it has not. It never rejects out of
  // here -- the synchronous accessor simply stays `undefined` and the completion
  // source proposes nothing, which is the only honest answer for a list of
  // supported versions this app has not managed to read.
  useEffect(() => {
    primeXcodeVersions();
  }, []);

  // Issue #148: one derivation of "what is wrong with this config right now",
  // shared by the strip under the editor and the line marks inside it. Pure
  // and cheap (it re-reads the already-parsed document, never the network),
  // so deriving it here rather than storing it keeps it impossible for the
  // two surfaces to disagree.
  const doc = useAppStore((state) => state.doc);
  const diagnosticsResult = useMemo(
    () => buildDiagnostics({ doc, text, parseError, validation }),
    [doc, text, parseError, validation],
  );

  // Issue #215: the policy axis, kept out of `diagnosticsResult` on purpose.
  // Folding these in would give the strip above a single error count that
  // conflates "this config does not compile" with "this config is not
  // allowed" -- two different problems with two different fixes.
  const policyDiagnostics = usePolicyDiagnostics();

  // Clamp the selection back into range whenever the problem set shrinks --
  // typically because the user just fixed the one they were looking at.
  const diagnosticCount = diagnosticsResult.diagnostics.length;
  useEffect(() => {
    setDiagnosticIndex((current) =>
      diagnosticCount === 0 ? 0 : Math.min(current, diagnosticCount - 1),
    );
  }, [diagnosticCount]);

  const diagnosticMarks = useMemo<DiagnosticMark[]>(
    () => [
      ...diagnosticsResult.diagnostics.flatMap((diagnostic, index) =>
        diagnostic.location
          ? [
              {
                line: diagnostic.location.line,
                severity: diagnostic.severity,
                primary: index === diagnosticIndex,
                message: diagnostic.title,
              },
            ]
          : [],
      ),
      // Issue #215: a located policy violation tints its line too, but never
      // as the *primary* mark -- the strip's Prev/Next walks compile
      // diagnostics, and pretending a policy violation is "the one you're
      // looking at" there would be a claim about the wrong strip. The hover
      // text names the rule, so a tint that isn't a compile error is
      // identifiable as such without clicking anything.
      ...policyDiagnostics.flatMap((diagnostic) =>
        diagnostic.location
          ? [
              {
                line: diagnostic.location.line,
                severity: diagnostic.severity,
                primary: false,
                message: diagnosticHeadline(diagnostic),
              },
            ]
          : [],
      ),
    ],
    [diagnosticsResult, diagnosticIndex, policyDiagnostics],
  );

  const handleGoToLine = useCallback((line: number, column: number) => {
    const view = viewRef.current;
    if (view) goToLine(view, line, column);
  }, []);

  const extensions = useMemo(() => {
    // `override` replaces, rather than adds to, CodeMirror's default
    // completion lookup -- see yamlHighlight.ts's precedence-warning comment
    // for the sibling bug this avoids repeating: basicSetup's own
    // `autocompletion: true` default is turned off below for the same reason
    // its `syntaxHighlighting` default is, so there is never a *default*
    // source (or a second Tab/Ctrl-Space keymap) fighting these.
    //
    // Two sources are registered, deliberately -- this used to be one, and
    // said so. `override` merges N sources' results, and the env-var source
    // (issue #105) has to be its own rather than a branch of the schema
    // source: `circleciCompletionSource` returns null inside an opaque
    // scalar, and `command: |` -- a block literal -- is exactly where `$NAME`
    // completions are wanted. See `envVarCompletion.ts`'s own doc comment.
    //
    // Either source may contribute nothing, and that is a normal state: before
    // the schema has loaded the first proposes nothing, and with no CircleCI
    // token the second proposes nothing. The extension is registered
    // regardless, so keybindings are stable from first render.
    const source = [
      ...(circleciSchema
        ? [createCircleciCompletionSource(circleciSchema)]
        : []),
      createEnvVarCompletionSource(),
    ];
    return [
      yaml(),
      buildEditorTheme(resolvedTheme),
      ...yamlSyntaxHighlighting(resolvedTheme),
      autocompletion({ override: source, activateOnTyping: true }),
      // `activateOnTyping` covers typing but not deleting, which is how you
      // edit a value you already have -- see this module's own doc comment.
      reopenCompletionOnDelete(),
      // Issue #148: tints the lines validation could actually place an error
      // on. Rebuilt when the mark set changes -- the same "recreate the
      // extension array" pattern this memo already uses for the theme.
      diagnosticLineHighlight(diagnosticMarks),
    ];
  }, [circleciSchema, resolvedTheme, diagnosticMarks]);

  // The compiled view's own extension set: syntax highlighting for
  // readability, but deliberately no completion source -- `readOnly` on
  // `<CodeMirror>` already blocks edits, so there is nothing for
  // autocomplete to ever trigger on.
  // Themed on `resolvedTheme` exactly like the source view's extensions
  // above: the compiled view is read-only, but it is not theme-exempt, and a
  // hardcoded palette here would leave it dark while the rest of the app
  // switched to light. (This call site is where the compiled-view work and
  // the light/dark work met: `editorTheme` used to be a module-level const
  // and is now `buildEditorTheme(theme)`, which git merged cleanly into two
  // separate hunks but left semantically inconsistent.)
  const compiledExtensions = useMemo<Extension[]>(
    () => [
      yaml(),
      buildEditorTheme(resolvedTheme),
      ...yamlSyntaxHighlighting(resolvedTheme),
    ],
    [resolvedTheme],
  );

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
    },
    [setText],
  );

  const isSaving = status === 'saving';
  const fileLabel = configPath ? basename(configPath) : 'config.yml';
  // Same "is the open file the primary one" comparison the app bar makes
  // (issue #106) -- kept in sync there rather than duplicated logic, since
  // both badges must never disagree about the same file.
  const isPrimaryOpen = meta ? configPath === meta.configPath : true;

  // Issue #287: the same `unifiedDiff(savedText, text, ...)` call
  // `SaveDialog` makes before a save and `ProposeChangeDialog` makes before
  // applying an AI edit -- guarded behind `view === 'diff'` so a large
  // config doesn't pay for a diff it isn't showing on every keystroke (the
  // diagnostics/policy work above this line runs unconditionally because it
  // has to feed both views' line marks; this has no such reason to).
  const diffLines = useMemo(
    () => (view === 'diff' ? unifiedDiff(savedText, text, fileLabel) : []),
    [view, savedText, text, fileLabel],
  );
  // The badge's own "how big is this diff" summary -- computed alongside
  // `diffLines` from the exact same `countChangedLines` helper
  // `SaveDialog`/`ProposeChangeDialog` already use for the same purpose.
  const diffSummary = useMemo(() => {
    const { additions, deletions } = countChangedLines(diffLines);
    if (additions === 0 && deletions === 0) return 'no changes';
    const parts: string[] = [];
    if (additions > 0) parts.push(`+${additions}`);
    if (deletions > 0) parts.push(`-${deletions}`);
    return parts.join(' ');
  }, [diffLines]);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-cc-text-muted">
            {fileLabel}
          </span>
          {parseError ? (
            <Badge tone="danger">Invalid YAML</Badge>
          ) : isDirty ? (
            <Badge tone="warning">Unsaved</Badge>
          ) : (
            <Badge tone="success">Saved</Badge>
          )}
          {/* Rendered only once the local YAML parses -- a parse error already
              has its own "Invalid YAML" badge above, and revalidate() itself
              skips the API call in that case, so there's nothing to add here. */}
          <ValidationBadge
            state={validation.state}
            reason={validation.reason}
            softenInvalid={!isPrimaryOpen}
          />
          {/* Issue #247: the config-policy verdict, beside `Valid` rather than
              in a strip of its own -- see PolicyBadge's own doc comment for
              why it moved and what it still has to say with less room. */}
          <PolicyBadge text={text} hasParseError={parseError !== null} />
          {/* A reminder of *which* view is showing, since "Invalid YAML"/
              "Unsaved"/"Saved" above all describe the source, not whatever
              is currently on screen -- without this, switching to Compiled
              looked identical to the source badges just being stale. */}
          {view === 'compiled' ? (
            <Badge tone="info">Compiled (read-only)</Badge>
          ) : null}
          {/* Issue #287: names the comparison (against disk, not against the
              last-approved AI edit or anything else a reader might guess)
              and, because this view exists specifically to let a skeptical
              user confirm a change is as small as this app claims, states
              the size of it right where the mode itself is announced --
              the same +/- count `SaveDialog` and `ProposeChangeDialog`
              compute via `countChangedLines`, from this same `diffLines`. */}
          {view === 'diff' ? (
            <Badge tone="info">Diff vs. disk ({diffSummary})</Badge>
          ) : null}
        </span>
      }
      headerExtra={
        <>
          <SourceCompiledToggle value={view} onChange={setView} />
          <Tooltip content="Automatically save changes ~1.2s after you stop typing, without a confirmation dialog">
            <label className="flex items-center gap-1.5 text-xs text-cc-text-muted">
              <RadixSwitch.Root
                checked={autosave}
                onCheckedChange={toggleAutosave}
                className="relative h-4 w-7 rounded-full bg-cc-border-interactive outline-none data-[state=checked]:bg-cc-accent"
                aria-label="Toggle autosave"
              >
                <RadixSwitch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-cc-text transition-transform duration-150 data-[state=checked]:translate-x-[14px]" />
              </RadixSwitch.Root>
              Autosave
            </label>
          </Tooltip>
          {/* Issue #194. In the header rather than in a strip of its own,
              because this pane has a measured vertical budget and a third strip
              cost the editor its clickable area -- see RunStrip's own doc
              comment. The header is already a flex-wrap row with slack, so in
              the steady state this costs no new row. */}
          <RunControl
            filename={fileLabel}
            blockedReason={
              parseError
                ? `This file doesn’t parse locally (${parseError}), so there is nothing worth paying CircleCI to run yet.`
                : undefined
            }
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!isDirty || isSaving}
            onClick={() => setSaveDialogOpen(true)}
            aria-label="Review and save config"
          >
            Save
          </Button>
        </>
      }
      contentClassName="p-0"
    >
      <div className="flex h-full w-full flex-col">
        <div className="relative min-h-0 flex-1">
          {/* `hidden`, not a conditional unmount, on the source editor's own
              wrapper -- same reasoning as `PaneSlot`'s collapsed panes: the
              cursor/scroll position in a large config must survive
              round-tripping through Compiled (or, issue #287, Diff) and
              back, which an unmount would silently reset. Neither the
              compiled view nor the diff view has equivalent state worth
              preserving (their content is only ever freshly derived), so
              each is mounted only on demand instead. */}
          <div hidden={view !== 'source'} className="h-full w-full p-2">
            <CodeMirror
              value={text}
              height="100%"
              theme="none"
              // `h-full` on `@uiw/react-codemirror`'s own wrapper div is
              // load-bearing, not tidiness. That wrapper defaulted to
              // `height: auto`, so `height="100%"` on `.cm-editor` resolved
              // against an auto-height parent -- i.e. against its own content
              // -- and a 30-line config produced a 790px editor inside a
              // 210px flex slot. `.cm-editor` is `position: relative`, so the
              // overflow painted *over* everything below it in this pane:
              // measured on the real app, the diagnostics strip was fully
              // covered and its buttons unclickable (Playwright reported
              // `.cm-line` intercepting the pointer). Constraining the wrapper
              // makes `.cm-scroller` scroll internally, which is where a long
              // config's scrollbar belongs anyway.
              //
              // `rounded-md border border-cc-border overflow-hidden`, plus
              // the parent's new `p-2` (issue #201): the compiled view's
              // owner-praised "distinct block" look, given to *both* views on
              // purpose now, at the same `Panel`-outline treatment
              // (`design/components/Panel.tsx`'s own `border-cc-border`) this
              // app already uses for a card. Decorative, not interactive, so
              // it stays on `-border` rather than issue #200's
              // `-border-interactive` -- 1.4.11 doesn't reach it.
              className="h-full overflow-hidden rounded-md border border-cc-border"
              extensions={extensions}
              onChange={handleChange}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                // basicSetup otherwise installs CodeMirror's defaultHighlightStyle,
                // whose generated token spans render *inside* the decoration spans
                // from ./yamlHighlight and therefore win on the text itself. That
                // painted YAML keys in its light-theme blue (#0000cc) against this
                // pane's dark navy background -- measured at 1:1 contrast, i.e.
                // invisible. Our own colours are the only ones that should apply.
                syntaxHighlighting: false,
                // Same story as syntaxHighlighting above, one level up: this
                // pane supplies its own single `autocompletion(...)` extension
                // (see the `extensions` useMemo) with the schema-aware source
                // as its only `override`. Leaving basicSetup's default
                // `autocompletion: true` on as well would register a *second*
                // completion source and a second Tab/Ctrl-Space keymap
                // fighting the first one.
                autocompletion: false,
              }}
              aria-label="YAML config editor"
            />
          </div>
          {view === 'compiled' ? (
            <CompiledConfigView
              validation={validation}
              parseError={parseError}
              extensions={compiledExtensions}
            />
          ) : null}
          {/* Issue #287: mounted only while selected, same as Compiled just
              above and for the same reason -- there is no cursor/scroll
              state in a derived diff worth preserving across a round trip. */}
          {view === 'diff' ? <DiffConfigView lines={diffLines} /> : null}
          {parseError ? (
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-cc-danger/40 bg-cc-panel/95 px-4 py-2 text-xs text-cc-danger"
            >
              <span className="font-semibold">Invalid YAML:</span> {parseError}.
              Your text is unchanged -- fix the syntax to resume editing
              visually.
            </div>
          ) : null}
        </div>

        {/* Issue #148: replaces the flat `<ul>` of raw `errors[]` entries this
            pane used to render (which mistook CircleCI's one-line-per-entry
            report format for one-error-per-entry, and put it in a bounded
            scroll box). Shown in *both* views deliberately: an error is
            equally relevant whether the user is looking at their source or at
            the compiled output. */}
        <DiagnosticsStrip
          result={diagnosticsResult}
          index={diagnosticIndex}
          onIndexChange={setDiagnosticIndex}
          onGoToLine={handleGoToLine}
        />

        {/* Issue #247: the config-policy verdict lives in the badge row above
            (`PolicyBadge`), and the full rule, its reason and the "Fix with
            AI" action live in the reference pane's Policies tab
            (`PolicyRulesView`) at the owner's explicit direction -- not a
            strip, a modal or an expanding panel in the editor. This pane
            still tints a located violation's line and rings its DAG node
            (via `policyDiagnostics` feeding `diagnosticMarks` below), which
            is a pointer rather than the detail itself. */}

        {/* Issue #194: the third and most expensive question about a config --
            does it actually *work* -- under the two free ones. Its own strip,
            because this is the only control in the app that spends the
            user's money, so it must not share a verdict, a tone or a button
            with anything that does not. See RunStrip's own doc comment. */}
        <RunStrip
          text={text}
          blockedReason={
            parseError
              ? `This file doesn’t parse locally (${parseError}), so there is nothing worth paying CircleCI to run yet.`
              : undefined
          }
          onAskAssistant={(prompt) => {
            // Issue #148's rule: the composer is seeded and never sent. Seeding
            // costs no tokens and needs no key, and `seedPrompt` kicks the
            // provider status load itself so the AI pane can say honestly
            // whether it is configured.
            useAiStore.getState().seedPrompt(prompt);
          }}
        />

        {/* A transport-level failure is not a statement about the config, so
            it keeps its own line rather than being dressed up as a
            diagnostic. `DiagnosticsStrip` may be showing local findings
            alongside it -- see `buildDiagnostics`' `localOnly` state. */}
        {!parseError && validation.state === 'error' && validation.reason ? (
          // Issue #185: the chrome plane, same as the diagnostics strip it sits
          // directly beneath. See `styles.css`'s surface-role table.
          <div className="shrink-0 border-t border-cc-danger/40 bg-cc-bg px-3 py-2 text-xs text-cc-danger">
            <span className="font-semibold">
              Couldn&apos;t reach CircleCI to validate:
            </span>{' '}
            {validation.reason}
          </div>
        ) : null}
      </div>

      <SaveDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        filename={fileLabel}
      />
    </Panel>
  );
}
