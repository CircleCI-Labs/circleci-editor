/**
 * Persisted "don't ask me again" preferences for the confirmation prompts
 * that precede a destructive-or-surprising edit (issue #12).
 *
 * Renaming a job rewrites lines in places the user isn't looking at, so it
 * prompts with a concrete list of what will change. That prompt is exactly
 * right the first time and pure noise on the fortieth of a bulk cleanup, so it
 * can be turned off.
 *
 * **Suppressing the prompt never changes the edit.** The reconciliation the
 * prompt describes happens either way; the preference only controls whether
 * the user is shown the description first. Anything that made "don't ask
 * again" also mean "don't reconcile" would be a data-loss bug wearing a
 * preference's clothes.
 *
 * Deliberately a separate store from `appStore` -- like `layoutStore`, this is
 * UI chrome that never touches the config document, so toggling it must not
 * look like an edit to undo/redo or the dirty indicator. Persistence is
 * hand-rolled in the same shape `layoutStore` uses (rather than a zustand
 * `persist` middleware) so the fallback for a corrupt or schema-mismatched
 * value stays explicit and unit-testable without driving React.
 */
import { create } from 'zustand';

/**
 * Bumping this discards previously-saved preferences rather than trying to
 * interpret them -- the same escape hatch `LAYOUT_SCHEMA_VERSION` provides.
 * Falling back to "ask" is always the safe direction: a returning user gets
 * one prompt they could have suppressed, never a suppressed prompt they
 * wanted.
 */
export const CONFIRM_SCHEMA_VERSION = 1;
export const CONFIRM_STORAGE_KEY = 'vce.confirm-prefs';

/**
 * Every prompt that can be suppressed, and deliberately not the DAG pane's
 * delete popover: that popover is a *chooser* between two genuinely different
 * intents ("remove from this workflow" vs. "delete the job definition"), not a
 * yes/no confirmation, so there is no single action suppressing it could safely
 * perform. It gained issue #12's impact list, but no checkbox. Kept as a list
 * rather than a bare boolean so a second suppressible prompt (or a settings
 * pane listing them) doesn't need a storage-schema change -- which is exactly
 * what `renameParameter` (issue #250) turned out to be.
 *
 * Adding a kind needs no `CONFIRM_SCHEMA_VERSION` bump: a previously-saved
 * `["renameJob"]` is still a valid subset of this list, so an existing user's
 * choice survives and the new prompt starts out *asking*, which is the safe
 * direction.
 */
export const CONFIRM_KINDS = ['renameJob', 'renameParameter'] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

export interface PersistedConfirmPrefs {
  schemaVersion: number;
  /** Kinds the user has chosen not to be asked about again. */
  suppressed: ConfirmKind[];
}

export function buildDefaultConfirmPrefs(): PersistedConfirmPrefs {
  return { schemaVersion: CONFIRM_SCHEMA_VERSION, suppressed: [] };
}

function isConfirmKindArray(value: unknown): value is ConfirmKind[] {
  return (
    Array.isArray(value) &&
    value.every((entry) =>
      (CONFIRM_KINDS as readonly string[]).includes(entry as string),
    )
  );
}

/**
 * Rejects outright (rather than salvaging part of it) anything that isn't an
 * object, doesn't match `CONFIRM_SCHEMA_VERSION` exactly, or has a
 * `suppressed` list containing a kind this build doesn't recognise. A `false`
 * here always means "fall back to asking about everything".
 */
function isPersistedConfirmPrefs(
  value: unknown,
): value is PersistedConfirmPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== CONFIRM_SCHEMA_VERSION) return false;
  return isConfirmKindArray(candidate.suppressed);
}

/** Never throws: a first run, unparseable JSON, a schema mismatch, or a `localStorage` that itself throws all land on the defaults. */
export function readPersistedConfirmPrefs(): PersistedConfirmPrefs {
  try {
    const raw = window.localStorage.getItem(CONFIRM_STORAGE_KEY);
    if (raw === null) return buildDefaultConfirmPrefs();
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedConfirmPrefs(parsed)) return buildDefaultConfirmPrefs();
    return parsed;
  } catch {
    return buildDefaultConfirmPrefs();
  }
}

export function writePersistedConfirmPrefs(state: PersistedConfirmPrefs): void {
  try {
    window.localStorage.setItem(CONFIRM_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The choice still holds for the rest of this session even if it can't
    // survive a reload.
  }
}

interface ConfirmState {
  suppressed: ConfirmKind[];
  /** True when `kind`'s prompt should be skipped -- the edit itself is unaffected either way. */
  isSuppressed: (kind: ConfirmKind) => boolean;
  /** Records "don't ask me again" for `kind`. Idempotent. */
  suppress: (kind: ConfirmKind) => void;
  /** Undoes `suppress` -- there is no UI for this yet; it exists so the preference is not a one-way door for tests or a future settings pane. */
  unsuppress: (kind: ConfirmKind) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => {
  const initial = readPersistedConfirmPrefs();

  return {
    suppressed: initial.suppressed,

    isSuppressed: (kind) => get().suppressed.includes(kind),

    suppress: (kind) =>
      set((state) => {
        if (state.suppressed.includes(kind)) return {};
        const suppressed = [...state.suppressed, kind];
        writePersistedConfirmPrefs({
          schemaVersion: CONFIRM_SCHEMA_VERSION,
          suppressed,
        });
        return { suppressed };
      }),

    unsuppress: (kind) =>
      set((state) => {
        if (!state.suppressed.includes(kind)) return {};
        const suppressed = state.suppressed.filter(
          (candidate) => candidate !== kind,
        );
        writePersistedConfirmPrefs({
          schemaVersion: CONFIRM_SCHEMA_VERSION,
          suppressed,
        });
        return { suppressed };
      }),
  };
});
