/**
 * Persisted light/dark theme preference (issue #52), following the same
 * versioned-localStorage pattern as `./layoutStore`: an explicit user
 * choice always wins and survives reloads; absent one, `'system'` defers
 * to the OS/browser's `prefers-color-scheme`, live-updating if that
 * changes while the app is open (e.g. the OS switches at sunset).
 *
 * The DOM wiring -- setting `data-theme` on `<html>` -- mirrors CircleCI's
 * own theme mechanism: CircleCI's internal design system keys every colour
 * token off `[data-theme='light']`/`[data-theme='dark']`, and
 * CircleCI's production web UI
 * is what sets that attribute at runtime. This store always resolves to a
 * *concrete* `'light'`/`'dark'` value before touching the DOM -- `'system'`
 * itself is never written as the attribute -- so `styles.css` only ever has
 * to know about two themes, not three preference states.
 *
 * The very first paint is handled separately, by an inline script in
 * `index.html` that duplicates this module's read-and-resolve logic (see
 * the comment there for why it can't just import this file). Keep the two
 * in sync if the storage key, schema, or resolution rule ever changes.
 */
import { create } from 'zustand';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_SCHEMA_VERSION = 1;
export const THEME_STORAGE_KEY = 'vce.theme';
const SCHEMA_VERSION = THEME_SCHEMA_VERSION;
const STORAGE_KEY = THEME_STORAGE_KEY;

interface PersistedTheme {
  schemaVersion: number;
  preference: ThemePreference;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isPersistedTheme(value: unknown): value is PersistedTheme {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    isThemePreference(candidate.preference)
  );
}

/**
 * Reads the persisted preference, falling back to `'system'` for a first
 * run, unparseable JSON, a schema-version mismatch, an unrecognised value,
 * or an environment where `localStorage` throws (private browsing,
 * disabled storage, a non-browser test environment). Never throws.
 */
export function readPersistedThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 'system';
    const parsed: unknown = JSON.parse(raw);
    return isPersistedTheme(parsed) ? parsed.preference : 'system';
  } catch {
    return 'system';
  }
}

export function writePersistedThemePreference(
  preference: ThemePreference,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, preference }),
    );
  } catch {
    // The choice still applies for the rest of this session even if it can't persist.
  }
}

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * `window.matchMedia` doesn't exist in jsdom (this project's Vitest
 * environment) -- guarded the same way `DagPane`'s `FitViewOnContainerResize`
 * guards a missing `ResizeObserver`, so unit tests deterministically resolve
 * `'system'` to `'light'` rather than throwing.
 */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return false;
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/**
 * Applies the resolved theme to the DOM -- the single place that actually
 * touches `document.documentElement`, so every caller (the store's own
 * `setPreference`, the system-preference change listener below) goes
 * through the same code path.
 */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved);
}

interface ThemeState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const preference = readPersistedThemePreference();
  const resolvedTheme = resolveTheme(preference);
  // Applied eagerly at store creation, not from a React effect, so the
  // attribute is correct as of the moment this module is first imported.
  // In practice this is redundant with the inline bootstrap script in
  // `index.html` (which already set it before this module even loaded,
  // avoiding a flash of the wrong theme) -- but this store becomes the one
  // source of truth from here on, e.g. once `setPreference` is called.
  applyResolvedTheme(resolvedTheme);

  // Live-updates `resolvedTheme` if the OS/browser preference changes while
  // `'system'` is the active preference (e.g. the OS switches at sunset) --
  // without this, only reloading the app would pick up the change. Guarded
  // the same way `systemPrefersDark` is, for the same jsdom gap.
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    media.addEventListener('change', (event) => {
      if (get().preference !== 'system') return;
      const nextResolved: ResolvedTheme = event.matches ? 'dark' : 'light';
      applyResolvedTheme(nextResolved);
      set({ resolvedTheme: nextResolved });
    });
  }

  return {
    preference,
    resolvedTheme,
    setPreference: (nextPreference) => {
      const nextResolved = resolveTheme(nextPreference);
      writePersistedThemePreference(nextPreference);
      applyResolvedTheme(nextResolved);
      set({ preference: nextPreference, resolvedTheme: nextResolved });
    },
  };
});
