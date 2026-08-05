/**
 * Which inspector sections the user has explicitly opened or closed
 * (issue #219), following the same versioned-localStorage pattern as
 * `./layoutStore` -- and the same one `./themeStore`, `./nodePositionStore`
 * and `panes/ai/composerSize.ts` already copy. Not a second mechanism: one
 * `vce.*` key holding versioned JSON, validated on read, falling back to the
 * default for a first run, unparseable JSON, a schema mismatch, or a
 * `localStorage` that throws.
 *
 * # Why only *explicit* choices are stored
 *
 * The interesting design decision here is what this store deliberately does
 * *not* hold: a boolean per section. Issue #219 asks for
 * "collapsed unless it has content" as the general default rule, and that
 * rule is a function of the *document*, not of stored state -- a section that
 * was empty yesterday and has three post-steps today should open on its own,
 * without the user having to remember they once closed it while it was empty.
 *
 * So a key is written only when the user actually toggles a `<details>`, and
 * an absent key means "no opinion -- ask the content rule"
 * (`defaultSectionOpen` in `panes/inspector/inspectorSections.ts`). That makes
 * the two halves compose in the way that matches how people use this pane:
 * the content rule handles every section you have never touched, and an
 * explicit choice pins the ones you have. It also means the stored object
 * stays small and legible (usually empty), rather than a full snapshot of
 * every section's state that has to be migrated whenever a section is added
 * or renamed -- a new section simply has no key yet, which is already a
 * meaningful, correct value.
 *
 * Keyed by section *kind* (`'steps'`, `'post-steps'`, ...), not per job: the
 * preference being expressed is "I don't care about post-steps", which is
 * about how you work rather than about one job. Per-job state would also grow
 * without bound across a config's lifetime and would need a story for a
 * renamed job, for no benefit anyone asked for.
 */
import { create } from 'zustand';

export const INSPECTOR_SECTIONS_SCHEMA_VERSION = 1;
export const INSPECTOR_SECTIONS_STORAGE_KEY = 'vce.inspectorSections';
const SCHEMA_VERSION = INSPECTOR_SECTIONS_SCHEMA_VERSION;
const STORAGE_KEY = INSPECTOR_SECTIONS_STORAGE_KEY;

/**
 * A section's stable identity in storage. Deliberately a plain `string`
 * rather than a union of today's section ids: this store is written to by
 * `CollapsibleSection`, which is generic over whatever sections the inspector
 * happens to have, and an unrecognised key read back from storage is
 * harmless (it describes a section that no longer exists, and nothing looks
 * it up). Constraining the type here would buy nothing and would make adding
 * a section a two-file change.
 */
export type InspectorSectionId = string;

/** The user's explicit open/closed choices. A missing key means "no explicit choice" -- see the module comment. */
export type InspectorSectionChoices = Readonly<Record<string, boolean>>;

interface PersistedInspectorSections {
  schemaVersion: number;
  /** Only sections the user has actually toggled. */
  open: Record<string, boolean>;
}

function isRecordOfBooleans(value: unknown): value is Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'boolean');
}

function isPersistedInspectorSections(
  value: unknown,
): value is PersistedInspectorSections {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    isRecordOfBooleans(candidate.open)
  );
}

/**
 * Reads the persisted choices, falling back to "no explicit choices at all"
 * (so every section follows the content rule) for a first run, unparseable
 * JSON, a schema-version mismatch, a wrong-shaped value, or an environment
 * where `localStorage` throws. Never throws.
 */
export function readPersistedSectionChoices(): InspectorSectionChoices {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return isPersistedInspectorSections(parsed) ? parsed.open : {};
  } catch {
    return {};
  }
}

export function writePersistedSectionChoices(
  open: InspectorSectionChoices,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, open }),
    );
  } catch {
    // Collapsing still works for the rest of this session even if it can't persist.
  }
}

interface InspectorSectionState {
  /** Only the sections the user has explicitly toggled -- see the module comment. */
  open: InspectorSectionChoices;
  /** Records an explicit choice for `id`. */
  setSectionOpen: (id: InspectorSectionId, isOpen: boolean) => void;
  /**
   * Drops every explicit choice, handing all sections back to the content
   * rule. Not currently reachable from the UI; exported because it is the
   * one operation a "reset this pane" affordance would need, and because it
   * keeps the store's own tests from having to reach into `localStorage`.
   */
  resetSectionChoices: () => void;
}

export const useInspectorSectionStore = create<InspectorSectionState>(
  (set, get) => ({
    open: readPersistedSectionChoices(),
    setSectionOpen: (id, isOpen) => {
      const next = { ...get().open, [id]: isOpen };
      writePersistedSectionChoices(next);
      set({ open: next });
    },
    resetSectionChoices: () => {
      writePersistedSectionChoices({});
      set({ open: {} });
    },
  }),
);
