import type { Document } from 'yaml';
import { create } from 'zustand';

import { cloneDocument, parseConfig } from '~/lib/yaml/documentUtils';
import { serializeMinimalDiff } from '~/lib/yaml/spliceSerialize';
import {
  getConfig,
  getConfigFiles,
  getMeta,
  postValidate,
  putConfig,
} from '~/lib/rpc/client';
import type { ConfigFileInfo, Meta, ValidateErrorItem } from '~/lib/rpc/client';
import { usePolicyStore } from '~/state/policyStore';

export type AppStatus = 'loading' | 'ready' | 'saving' | 'error';

/** The DAG pane's LR/TB toggle, using elk's own direction vocabulary directly. */
export type DagDirection = 'RIGHT' | 'DOWN';

/**
 * The validation status machine for M4's front end.
 *
 * - `idle`: no validation attempted yet (fresh load, or the text currently
 *   has a local YAML parse error -- see `revalidate`).
 * - `checking`: a `POST /api/validate` request is in flight.
 * - `valid` / `invalid`: the API actually ran and returned a result.
 * - `unavailable`: the API could not be reached because this host has no
 *   `CIRCLE_TOKEN` -- deliberately distinct from `invalid` so the UI never
 *   conflates "we don't know" with "this is broken".
 * - `error`: the request itself failed (network/transport/non-2xx), which
 *   is also distinct from `invalid` -- the config's validity is still
 *   unknown, not confirmed bad.
 * - `not-a-config`: the open file is not, structurally, a CircleCI config
 *   at all (issue #135's classifier said so; see `ConfigFileInfo.isConfig`).
 *   `revalidate` never calls `POST /api/validate` for one -- issue #145:
 *   compiling a goss/Compose/tooling YAML file against the CircleCI schema
 *   produces errors that are noise about a file that was never a config to
 *   begin with, and sending its contents to CircleCI for that is pointless.
 *   Distinct from every other state, including `invalid`: this file is not
 *   an invalid config, it *isn't a config*, and `ValidationBadge` must say
 *   that rather than the softened "Not independently valid" issue #106
 *   already has for a continuation config.
 * - `unauthorized`: this host has a token, and CircleCI rejected it
 *   (HTTP 401). Deliberately distinct from both `unavailable` (no token
 *   configured at all -- the fix is to add one) and `error` (below --
 *   CircleCI could not be reached at all, so nothing said "no"). A rejected
 *   token and an unreachable API demand opposite actions from the user
 *   (replace the token vs. wait and retry), so they cannot share a state.
 *   See issue #224.
 * - `error`: the request itself failed (network/transport/non-2xx other
 *   than an unauthorized token), which is also distinct from `invalid` --
 *   the config's validity is still unknown, not confirmed bad -- and from
 *   `unauthorized`, because this is the one state where CircleCI's own
 *   health, not the user's credentials, is the likely cause.
 */
export type ValidationState =
  | 'idle'
  | 'checking'
  | 'valid'
  | 'invalid'
  | 'unavailable'
  | 'unauthorized'
  | 'error'
  | 'not-a-config';

export interface ValidationInfo {
  state: ValidationState;
  errors: ValidateErrorItem[];
  reason?: string;
  outputYaml?: string;
}

/**
 * One inactive file's full editing state, snapshotted when the user
 * switches away from it (issue #106) so switching back restores it
 * exactly -- including undo history and the workflow/node it had
 * selected -- rather than re-reading the file from disk and losing
 * whatever wasn't saved.
 *
 * This is the "one `Document` per file, with per-file dirty state" answer
 * to the issue's own open question, implemented as a cache of every field
 * that already lived at the top level of `AppState` for the single
 * document this store used to hold. Deliberately shaped identically to
 * that top-level slice (not a subset) so `switchFile` can snapshot/restore
 * by spreading, with no per-field translation to keep in sync by hand.
 */
interface DocSnapshot {
  doc: Document | null;
  text: string;
  savedText: string;
  parseError: string | null;
  isDirty: boolean;
  undoStack: string[];
  redoStack: string[];
  canUndo: boolean;
  canRedo: boolean;
  validation: ValidationInfo;
  editError: string | null;
  selectedWorkflow: string | null;
  selectedNodeId: string | null;
  /** See `AppState`'s own field of the same name. */
  workflowSelected: boolean;
}

const AUTOSAVE_DELAY_MS = 1200;
const VALIDATE_DEBOUNCE_MS = 800;
/** Bounds the undo/redo history so it can't grow without limit over a long session. */
const MAX_HISTORY = 50;
/**
 * How long a gap between `setText` calls has to be before the next one
 * starts a *new* undo entry. While gaps are shorter than this, consecutive
 * keystrokes are coalesced into the single entry that was pushed at the
 * start of the burst -- see `setText`.
 */
const TYPING_COALESCE_MS = 500;

const IDLE_VALIDATION: ValidationInfo = { state: 'idle', errors: [] };

interface AppState {
  meta: Meta | null;
  /**
   * Absolute path of the currently *open* file -- not necessarily the
   * host's primary resolved config any more (issue #106: any file in the
   * indexed `.circleci` directory can be open). Every field below it
   * (`doc`, `text`, `isDirty`, `undoStack`, `validation`, ...) describes
   * that open file specifically; switching files (`switchFile`) swaps all
   * of them at once. Compare against `meta.configPath` (fixed for the
   * whole session -- `meta` is only ever loaded once, at startup) to tell
   * whether the open file is the one the host resolved at startup, which
   * is what the validation badge's asymmetry note keys off of.
   */
  configPath: string;
  /**
   * Every `.yml`/`.yaml` file found in the same directory as the primary
   * config (from `GET /api/config-files`), landed once for both issue
   * #106 (the file switcher reads this to render its list) and issue #102
   * (the AI pane's directory-context assembler reads it to know what else
   * exists). Never includes file contents -- see `~/lib/ai/context.ts` for
   * where those get fetched, on demand, within a token budget.
   */
  files: ConfigFileInfo[];
  /** Set when the last `loadFiles()` attempt failed and had to fall back to a single-entry list built from `configPath`/`text` alone. Surfaced so the switcher can explain why it only shows one file instead of failing silently. */
  filesError: string | null;
  /**
   * Snapshots of every file that has been open in this session other than
   * the currently active one -- see `DocSnapshot`. The active file's own
   * state lives in this object's top-level fields, not in here; a
   * snapshot is written only at the moment `switchFile` leaves a file, and
   * read back the moment it returns to it.
   */
  docCache: Record<string, DocSnapshot>;
  /**
   * The parsed YAML AST -- the single source of truth for every visual
   * pane. It is intentionally *not* derived from `text` on every render:
   * while `text` has a parse error, `doc` keeps pointing at the last good
   * parse so the DAG/inspector panes keep working instead of blanking out.
   */
  doc: Document | null;
  /** The current editor text. Kept in sync with `doc` after every structural mutation. */
  text: string;
  /** The last text successfully written to disk. `isDirty` is `text !== savedText`. */
  savedText: string;
  /** Set when `text` doesn't parse. `doc` is left pointing at the last good parse. */
  parseError: string | null;
  isDirty: boolean;
  status: AppStatus;
  error: string | null;
  autosave: boolean;
  /** The workflow selected in the DAG pane; persisted here so it survives re-renders. */
  selectedWorkflow: string | null;
  /** The DAG pane's layout direction; persisted here for the same reason. */
  dagDirection: DagDirection;
  /** The DAG node (graph-node id, i.e. alias) selected in the DAG/inspector panes, if any. */
  selectedNodeId: string | null;
  /**
   * Whether the *workflow itself* -- not any job in it -- is the thing the
   * inspector is showing (issue #288: `when`/`unless`, `triggers:`/
   * `schedule:`, `max_auto_reruns`). Mutually exclusive with `selectedNodeId`
   * by construction: `selectNode` always clears this, and `selectWorkflowEntity`
   * always clears `selectedNodeId`, so the inspector never has to decide which
   * one wins -- at most one of the two is ever true/non-null at a time.
   *
   * Deliberately not folded into `selectedNodeId` as a sentinel value (e.g.
   * `''`): every existing reader of `selectedNodeId` treats "truthy string" as
   * "a real node id" and looks it up in the graph, and a sentinel would need
   * every one of them re-audited to special-case it rather than just failing
   * the lookup silently. A second boolean costs one field and no call site.
   */
  workflowSelected: boolean;
  validation: ValidationInfo;
  /**
   * Text snapshots from *before* each edit, most-recent last, bounded to
   * `MAX_HISTORY`. `undo()` pops from here and pushes the current text onto
   * `redoStack`; `redo()` does the reverse. Kept as plain text (not `Document`
   * clones) because that's what both `mutate()` and `setText()` already
   * produce, and re-parsing on undo/redo is cheap.
   */
  undoStack: string[];
  redoStack: string[];
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Set when a mutation-layer function threw (e.g. "would create a cycle").
   * The document is left exactly as it was before the attempted edit --
   * this is purely a surfaced message, never a broken/partial state.
   */
  editError: string | null;
  clearEditError: () => void;
  load: () => Promise<void>;
  /**
   * Refreshes `files` from `GET /api/config-files`. Called once by `load`,
   * and safe to call again later (e.g. after a save, in case a file was
   * created or removed on disk out-of-band). Never throws and never sets
   * `status`/`error` -- a directory-listing failure degrades to a
   * single-entry list built from whatever file is already open, per this
   * issue's own requirement that the editor keeps working with exactly the
   * one file it always could, even if the switcher can't populate itself.
   */
  loadFiles: () => Promise<void>;
  /**
   * Opens `path` as the active document -- issue #106's file switcher.
   * Snapshots the file being left (see `DocSnapshot`) so its undo history,
   * dirty text, and validation are restored byte-for-byte on returning to
   * it, then either restores an already-open file's snapshot or fetches it
   * fresh from disk. A no-op if `path` is already active. Never discards
   * unsaved edits: this is the "per-file document" answer to the issue's
   * own open question, not "block switching while dirty".
   */
  switchFile: (path: string) => Promise<void>;
  /**
   * Called by the text editor on every keystroke. Never rejects on bad YAML
   * -- see `parseError`. Pushes an undo entry only once per ~500ms quiet
   * period (see `TYPING_COALESCE_MS`) so a burst of typing becomes one undo
   * step, not one per keystroke.
   */
  setText: (text: string) => void;
  /**
   * The only way visual panes may change the config. Clones `doc`, applies
   * `fn` to the clone, and re-derives `text` from `clone.toString()` --
   * never by re-serializing through a plain JS object, which is what loses
   * comments and formatting. `label` names the edit for future undo/redo
   * history; not yet consumed. Always pushes its own undo entry (mutations
   * are discrete user actions, e.g. a button click, never coalesced like
   * typing). If `fn` throws (the mutation layer rejects the edit, e.g. a
   * cycle), the clone is discarded, `doc`/`text` are left untouched, and the
   * thrown message is surfaced via `editError`.
   */
  mutate: (fn: (doc: Document) => void, label?: string) => void;
  save: () => Promise<void>;
  toggleAutosave: () => void;
  setSelectedWorkflow: (name: string) => void;
  setDagDirection: (direction: DagDirection) => void;
  /**
   * Selects a DAG node (or, `id === null`, clears the selection down to
   * nothing) -- always clears `workflowSelected` too, so selecting a job
   * never leaves the workflow-level inspector body showing underneath it,
   * and clearing down to nothing means *nothing*, not "the workflow". See
   * `selectWorkflowEntity` for the one action that sets `workflowSelected`.
   */
  selectNode: (id: string | null) => void;
  /**
   * Selects the *workflow itself* for the inspector (issue #288) -- clears
   * `selectedNodeId` the same way `selectNode` clears this, so the two stay
   * mutually exclusive from both directions. Two ways in call this: clicking
   * empty DAG canvas (`DagPane`'s `handlePaneClick`), and clicking a
   * `WorkflowTabs` tab that is already the active one (a deliberate second
   * click on a tab that just switching workflows doesn't consume).
   */
  selectWorkflowEntity: () => void;
  /** Restores the previous text snapshot from `undoStack`. A no-op when `canUndo` is false. Does not itself push a new undo entry. */
  undo: () => void;
  /** Restores the next text snapshot from `redoStack`. A no-op when `canRedo` is false. Does not itself push a new undo entry. */
  redo: () => void;
  /**
   * Debounced (~800ms) trigger for `POST /api/validate`. Called after
   * `load()` and on every `setText`/`mutate`; each call cancels any
   * previously-scheduled request so rapid typing produces at most one
   * request ~800ms after the text settles, not one per keystroke. A
   * request sequence number guards against an in-flight response landing
   * after a newer one has already been scheduled or resolved.
   */
  revalidate: () => void;
}

// Debounce timer lives outside React/zustand state on purpose: it is not
// something we ever want to trigger a re-render, and it must survive across
// store updates without being reset by React's render cycle.
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

function clearAutosaveTimer(): void {
  if (autosaveTimer !== undefined) {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }
}

// Tracks whether we're inside an active "typing burst" for undo coalescing
// (see `TYPING_COALESCE_MS`). Lives outside zustand state for the same
// reason `autosaveTimer` does: starting/stopping it must never itself
// trigger a re-render, and it must survive across store updates.
let typingBurstTimer: ReturnType<typeof setTimeout> | undefined;

function clearTypingBurstTimer(): void {
  if (typingBurstTimer !== undefined) {
    clearTimeout(typingBurstTimer);
    typingBurstTimer = undefined;
  }
}

// Same rationale as `autosaveTimer`: lives outside zustand state so
// scheduling/canceling it never itself triggers a re-render.
let validateTimer: ReturnType<typeof setTimeout> | undefined;
// Incremented on every `revalidate()` call. A response is only applied if
// it still matches the sequence number captured when its request started,
// so a slow, superseded request can never clobber a newer result.
let validateSeq = 0;

function clearValidateTimer(): void {
  if (validateTimer !== undefined) {
    clearTimeout(validateTimer);
    validateTimer = undefined;
  }
}

/**
 * Whether *anything* in this session is unsaved -- the open file or any
 * other file edited and switched away from (issue #177).
 *
 * `isDirty` alone would be the wrong question to ask before closing the
 * window, because switching files does not discard the file you left: its
 * unsaved text is preserved in `docCache` on purpose, so closing
 * the tab is the moment it would actually be lost.
 *
 * The active path is deliberately excluded from the `docCache` scan rather
 * than trusted from it. `switchFile` restores a cached file's state into the
 * top-level fields but leaves the cache entry in place, so
 * `docCache[configPath]` is a snapshot from whenever that file was last
 * *left* -- which may say `isDirty: true` about edits that have since been
 * saved. Believing it would produce the one failure mode the issue calls out
 * by name: a confirmation prompt on a clean document, which teaches people
 * to dismiss prompts. The top-level `isDirty` is the only current answer for
 * the open file.
 *
 * Exported as a plain function of state, not a hook, so it can be used as a
 * zustand selector (it returns a boolean, so it is referentially stable and
 * cannot cause a re-render loop) and asserted directly in tests.
 */
export function hasUnsavedChanges(state: AppState): boolean {
  if (state.isDirty) return true;
  return Object.entries(state.docCache).some(
    ([path, snapshot]) => path !== state.configPath && snapshot.isDirty,
  );
}

export const useAppStore = create<AppState>((set, get) => ({
  meta: null,
  configPath: '',
  files: [],
  filesError: null,
  docCache: {},
  doc: null,
  text: '',
  savedText: '',
  parseError: null,
  isDirty: false,
  status: 'loading',
  error: null,
  autosave: false,
  selectedWorkflow: null,
  dagDirection: 'RIGHT',
  selectedNodeId: null,
  workflowSelected: false,
  validation: IDLE_VALIDATION,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  editError: null,

  clearEditError: () => set({ editError: null }),

  load: async () => {
    clearAutosaveTimer();
    clearTypingBurstTimer();
    set({ status: 'loading', error: null });
    try {
      const [meta, config] = await Promise.all([getMeta(), getConfig()]);
      const { doc, error: parseError } = parseConfig(config.contents);
      set({
        meta,
        configPath: config.path,
        // A fresh load() starts a brand-new session: any file snapshotted
        // from a *previous* session (e.g. a hot reload during dev, or a
        // deliberate reload-and-retry after an error) is stale and must
        // not be silently restored in place of whatever is on disk now.
        docCache: {},
        doc,
        text: config.contents,
        savedText: config.contents,
        parseError,
        isDirty: false,
        status: 'ready',
        // A freshly loaded config starts a fresh editing session: no prior
        // edit should be undoable past this point.
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        editError: null,
        selectedNodeId: null,
        workflowSelected: false,
      });
      get().revalidate();
      await get().loadFiles();
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to load config',
      });
    }
  },

  loadFiles: async () => {
    try {
      const resp = await getConfigFiles();
      set({ files: resp.files, filesError: null });
    } catch (error) {
      // See this action's own doc comment: the switcher degrades to a
      // single entry rather than the whole app failing to load.
      const { configPath, text } = get();
      set({
        files: configPath
          ? [
              {
                path: configPath,
                relPath: configPath.split('/').pop() ?? configPath,
                size: text.length,
                isPrimary: true,
                // The open file is a config by definition of being open:
                // this fallback exists because the *listing* failed, which
                // is no reason to start doubting the file the editor is
                // already showing (see the host's own primary-file rule).
                isConfig: true,
                configReason: 'The config file this editor opened.',
              },
            ]
          : [],
        filesError:
          error instanceof Error
            ? error.message
            : 'Failed to list files in this directory',
      });
    }
  },

  switchFile: async (path: string) => {
    const state = get();
    if (path === state.configPath) return;

    clearAutosaveTimer();
    clearTypingBurstTimer();
    clearValidateTimer();
    // A policy decision is not part of `DocSnapshot` (issue #106 predates
    // #215/#247 and this store has no per-file policy cache), so the file
    // being left does not get its verdict restored on return, and the file
    // being opened must not show the file being left's. Reset rather than
    // leave it standing -- see `policyStore`'s own doc comment on "no
    // violations" vs. "we could not check" for why a leftover decision is
    // the wrong kind of wrong to risk here.
    usePolicyStore.getState().reset();

    // Snapshot the file we're leaving so its full state -- undo history,
    // unsaved text, whichever workflow/node it had selected -- comes back
    // exactly as left, the moment the user returns to it.
    const leaving: DocSnapshot = {
      doc: state.doc,
      text: state.text,
      savedText: state.savedText,
      parseError: state.parseError,
      isDirty: state.isDirty,
      undoStack: state.undoStack,
      redoStack: state.redoStack,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      validation: state.validation,
      editError: state.editError,
      selectedWorkflow: state.selectedWorkflow,
      selectedNodeId: state.selectedNodeId,
      workflowSelected: state.workflowSelected,
    };
    const docCache = state.configPath
      ? { ...state.docCache, [state.configPath]: leaving }
      : state.docCache;

    const cached = docCache[path];
    if (cached) {
      set({
        docCache,
        configPath: path,
        doc: cached.doc,
        text: cached.text,
        savedText: cached.savedText,
        parseError: cached.parseError,
        isDirty: cached.isDirty,
        undoStack: cached.undoStack,
        redoStack: cached.redoStack,
        canUndo: cached.canUndo,
        canRedo: cached.canRedo,
        validation: cached.validation,
        editError: cached.editError,
        selectedWorkflow: cached.selectedWorkflow,
        selectedNodeId: cached.selectedNodeId,
        workflowSelected: cached.workflowSelected,
        status: 'ready',
        error: null,
      });
      return;
    }

    // Never opened this session: read it fresh from disk. `docCache` is
    // still updated with the snapshot of the file being left even though
    // this branch doesn't use it for the incoming file, so that snapshot
    // isn't lost while the fetch below is in flight.
    set({ docCache, status: 'loading', error: null });
    try {
      const config = await getConfig(path);
      const { doc, error: parseError } = parseConfig(config.contents);
      set({
        configPath: config.path,
        doc,
        text: config.contents,
        savedText: config.contents,
        parseError,
        isDirty: false,
        status: 'ready',
        error: null,
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        editError: null,
        // A newly opened file has no prior selection of its own yet --
        // the DAG pane's own fallback (pick the first workflow) takes it
        // from here, which is "the DAG follows the open file" in practice.
        selectedWorkflow: null,
        selectedNodeId: null,
        workflowSelected: false,
      });
      get().revalidate();
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to open file',
      });
    }
  },

  setText: (text: string) => {
    const { savedText, autosave, text: prevText, undoStack } = get();
    const isDirty = text !== savedText;
    const { doc, error } = parseConfig(text);

    // Coalesce a burst of keystrokes into a single undo entry: only push
    // when no burst is currently in flight (i.e. this is the first
    // keystroke since the last ~500ms-quiet gap), and (re)start the timer
    // on every keystroke so the *next* push waits for another quiet gap.
    // The very first `setText` after e.g. `load()` also pushes -- that's
    // deliberate, it's what lets a user undo their first keystroke back to
    // the freshly loaded config.
    const startingNewBurst = typingBurstTimer === undefined;
    const historyPatch = startingNewBurst
      ? {
          undoStack: [...undoStack, prevText].slice(-MAX_HISTORY),
          redoStack: [],
          canUndo: true,
          canRedo: false,
        }
      : {};
    clearTypingBurstTimer();
    typingBurstTimer = setTimeout(() => {
      typingBurstTimer = undefined;
    }, TYPING_COALESCE_MS);

    if (error) {
      // Leave `doc` exactly as it was: the last good document keeps the
      // DAG/inspector panes usable while the user finishes typing.
      set({
        text,
        isDirty,
        parseError: error,
        editError: null,
        ...historyPatch,
      });
    } else {
      set({
        text,
        isDirty,
        parseError: null,
        doc,
        editError: null,
        ...historyPatch,
      });
    }

    clearAutosaveTimer();
    if (autosave && isDirty) {
      autosaveTimer = setTimeout(() => {
        void get().save();
      }, AUTOSAVE_DELAY_MS);
    }

    get().revalidate();
  },

  mutate: (fn, label) => {
    void label; // reserved for a future named-history display; not yet consumed.
    const { doc, parseError, savedText, autosave, text, undoStack } = get();
    if (!doc || parseError) {
      set({
        error:
          'Cannot apply that edit: the YAML has a parse error. Fix the syntax first.',
      });
      return;
    }

    // A mutate() call is always a discrete action (a button click, a drag
    // drop, a field commit on blur) -- never a per-keystroke event -- so it
    // always gets its own undo entry, and it ends any in-flight typing
    // burst so the *next* keystroke starts a fresh one instead of being
    // silently folded into whatever text preceded this mutation.
    clearTypingBurstTimer();

    const clone = cloneDocument(doc);
    try {
      fn(clone);
    } catch (err) {
      // Leave `doc`/`text` completely untouched -- the clone is discarded.
      set({
        editError:
          err instanceof Error
            ? err.message
            : 'That edit could not be applied.',
      });
      return;
    }

    // Re-serializing via `clone.toString()` alone re-emits the *entire*
    // document with `yaml`'s own indentation/spacing rules, which normalises
    // formatting in every region this edit didn't touch (issue #81, #39).
    // `serializeMinimalDiff` instead splices
    // only the changed node(s) into the previous text, falling back to the
    // naive behavior above if anything about that goes wrong -- so this can
    // only match or improve on it, never regress. `text` (not `doc`, which
    // may itself already be several splices removed from any text that was
    // ever handed to a parser) is re-parsed fresh here so its ranges are
    // guaranteed to correspond to the exact bytes being spliced.
    const { doc: oldDocForRanges } = parseConfig(text);
    const newText = oldDocForRanges
      ? serializeMinimalDiff(text, oldDocForRanges, clone)
      : clone.toString();
    const isDirty = newText !== savedText;
    set({
      doc: clone,
      text: newText,
      isDirty,
      parseError: null,
      error: null,
      editError: null,
      undoStack: [...undoStack, text].slice(-MAX_HISTORY),
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });

    clearAutosaveTimer();
    if (autosave && isDirty) {
      autosaveTimer = setTimeout(() => {
        void get().save();
      }, AUTOSAVE_DELAY_MS);
    }

    get().revalidate();
  },

  save: async () => {
    clearAutosaveTimer();
    const { text, isDirty, status, configPath, meta } = get();
    if (!isDirty || status === 'saving') {
      return;
    }
    set({ status: 'saving', error: null });
    try {
      // Writes to whichever file is currently open, never the host's
      // primary config by default any more -- issue #106's "mutations
      // apply to the open document only". Only sends an explicit `?path=`
      // when the open file differs from the one the host resolved at
      // startup (`meta.configPath`, fixed for the whole session -- see
      // appStore's own `configPath` doc comment): a session that never
      // calls `switchFile` produces the exact same `PUT /api/config`
      // request (no query string) it always has, rather than a new
      // `?path=...` shape every existing caller (including this app's own
      // e2e fixtures) would otherwise have to learn to match.
      const targetPath =
        meta && configPath !== meta.configPath ? configPath : undefined;
      await putConfig(text, targetPath);
      set({ savedText: text, isDirty: false, status: 'ready' });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to save config',
      });
    }
  },

  toggleAutosave: () => {
    set((state) => ({ autosave: !state.autosave }));
    const { autosave, isDirty } = get();
    clearAutosaveTimer();
    if (autosave && isDirty) {
      autosaveTimer = setTimeout(() => {
        void get().save();
      }, AUTOSAVE_DELAY_MS);
    }
  },

  setSelectedWorkflow: (name: string) => {
    set({ selectedWorkflow: name });
  },

  setDagDirection: (direction: DagDirection) => {
    set({ dagDirection: direction });
  },

  selectNode: (id: string | null) => {
    set({ selectedNodeId: id, workflowSelected: false });
  },

  selectWorkflowEntity: () => {
    set({ selectedNodeId: null, workflowSelected: true });
  },

  undo: () => {
    const { undoStack, redoStack, text, savedText, autosave } = get();
    const previous = undoStack[undoStack.length - 1];
    if (previous === undefined) return;

    // Restoring history must never itself be treated as a new edit: it
    // pops from `undoStack` and pushes onto `redoStack` directly, rather
    // than going through `mutate()`/`setText()`, which would push a fresh
    // undo entry for the very state we're restoring.
    clearTypingBurstTimer();
    const { doc, error: parseError } = parseConfig(previous);
    const isDirty = previous !== savedText;
    set({
      text: previous,
      doc,
      parseError,
      isDirty,
      editError: null,
      error: null,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, text].slice(-MAX_HISTORY),
      canUndo: undoStack.length - 1 > 0,
      canRedo: true,
    });

    clearAutosaveTimer();
    if (autosave && isDirty) {
      autosaveTimer = setTimeout(() => {
        void get().save();
      }, AUTOSAVE_DELAY_MS);
    }
    get().revalidate();
  },

  redo: () => {
    const { undoStack, redoStack, text, savedText, autosave } = get();
    const next = redoStack[redoStack.length - 1];
    if (next === undefined) return;

    clearTypingBurstTimer();
    const { doc, error: parseError } = parseConfig(next);
    const isDirty = next !== savedText;
    set({
      text: next,
      doc,
      parseError,
      isDirty,
      editError: null,
      error: null,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, text].slice(-MAX_HISTORY),
      canUndo: true,
      canRedo: redoStack.length - 1 > 0,
    });

    clearAutosaveTimer();
    if (autosave && isDirty) {
      autosaveTimer = setTimeout(() => {
        void get().save();
      }, AUTOSAVE_DELAY_MS);
    }
    get().revalidate();
  },

  revalidate: () => {
    clearValidateTimer();
    const { parseError, files, configPath } = get();

    // Issue #145: the host already classifies every indexed file
    // (`GET /api/config-files`'s `isConfig`/`configReason`, issue #135). A
    // file that isn't a config is never made valid or invalid by anything
    // typed into it, so this checks first and returns before either the
    // local-parse-error branch below or the debounced network call: no
    // `POST /api/validate` round trip for a file the host already said
    // isn't a CircleCI config at all, regardless of whether it happens to
    // parse as YAML right now. `files` is empty for a moment during the
    // very first load (loadFiles() has not resolved yet), which
    // `.find` simply fails to match -- correct, since the primary file
    // that first load() opens is a config by construction and validating
    // it normally is exactly right.
    const openFile = files.find((file) => file.path === configPath);
    if (openFile && !openFile.isConfig) {
      set({
        validation: {
          state: 'not-a-config',
          errors: [],
          reason: openFile.configReason,
        },
      });
      return;
    }

    if (parseError) {
      // The API would just re-derive the same problem we already know
      // about locally, so don't call it -- and don't leave a stale
      // checking/valid/invalid badge misrepresenting the current text.
      set({ validation: IDLE_VALIDATION });
      return;
    }

    validateTimer = setTimeout(() => {
      const seq = ++validateSeq;
      set({ validation: { ...get().validation, state: 'checking' } });

      const { text, parseError: parseErrorAtFire } = get();
      if (parseErrorAtFire) {
        set({ validation: IDLE_VALIDATION });
        return;
      }

      postValidate(text)
        .then((result) => {
          if (seq !== validateSeq) return; // superseded by a newer call
          if (!result.available) {
            // Two different reasons wear `available: false` (see
            // ValidateResponse): no token configured at all, versus a
            // token CircleCI actively refused. Issue #224 -- they call for
            // opposite fixes, so `source` decides which state this becomes
            // rather than both collapsing into `unavailable`.
            set({
              validation: {
                state:
                  result.source === 'unauthorized'
                    ? 'unauthorized'
                    : 'unavailable',
                errors: [],
                reason: result.reason,
              },
            });
            return;
          }
          if (result.valid) {
            set({
              validation: {
                state: 'valid',
                errors: [],
                outputYaml: result.outputYaml,
              },
            });
          } else {
            set({
              validation: { state: 'invalid', errors: result.errors ?? [] },
            });
          }
        })
        .catch((error: unknown) => {
          if (seq !== validateSeq) return; // superseded by a newer call
          set({
            validation: {
              state: 'error',
              errors: [],
              reason:
                error instanceof Error
                  ? error.message
                  : 'Validation request failed',
            },
          });
        });

      // Issue #247: config-policy evaluation rides this exact debounce --
      // "it'd be nice to do at the same time... without the user having to
      // recheck" -- rather than being a second timer or a button. Called
      // alongside `postValidate` above, not chained after it: the two are a
      // different axis each (compile-validity vs. policy standing) and
      // neither may gate or delay the other, so whichever answers first is
      // shown first. `evaluateInBackground` itself declines to fire when
      // `text` already has a decision or already has one in flight, so a
      // debounce that settles on text this store has already asked about
      // costs nothing extra.
      usePolicyStore.getState().evaluateInBackground(text);
    }, VALIDATE_DEBOUNCE_MS);
  },
}));
