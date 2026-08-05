import { beforeEach, describe, expect, it } from 'vitest';

import {
  THEME_SCHEMA_VERSION,
  THEME_STORAGE_KEY,
  readPersistedThemePreference,
  resolveTheme,
  useThemeStore,
  writePersistedThemePreference,
} from './themeStore';

function resetStoreToDefaults(): void {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  useThemeStore.setState({
    preference: 'system',
    resolvedTheme: resolveTheme('system'),
  });
}

describe('themeStore', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  describe('readPersistedThemePreference', () => {
    it("defaults to 'system' when nothing has been persisted yet", () => {
      expect(readPersistedThemePreference()).toBe('system');
    });

    it('round-trips an explicit preference through localStorage', () => {
      writePersistedThemePreference('dark');
      expect(readPersistedThemePreference()).toBe('dark');

      writePersistedThemePreference('light');
      expect(readPersistedThemePreference()).toBe('light');
    });

    it('falls back to system for unparseable JSON', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, '{not json');
      expect(readPersistedThemePreference()).toBe('system');
    });

    it('falls back to system for a schema-version mismatch', () => {
      window.localStorage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify({
          schemaVersion: THEME_SCHEMA_VERSION + 1,
          preference: 'dark',
        }),
      );
      expect(readPersistedThemePreference()).toBe('system');
    });

    it('falls back to system for an unrecognised preference value', () => {
      window.localStorage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify({
          schemaVersion: THEME_SCHEMA_VERSION,
          preference: 'sepia',
        }),
      );
      expect(readPersistedThemePreference()).toBe('system');
    });
  });

  describe('resolveTheme', () => {
    it('resolves explicit preferences to themselves', () => {
      expect(resolveTheme('light')).toBe('light');
      expect(resolveTheme('dark')).toBe('dark');
    });

    it("resolves 'system' to 'light' in this jsdom test environment, which has no matchMedia", () => {
      // Mirrors DagPane's own ResizeObserver guard: jsdom doesn't implement
      // matchMedia, so `systemPrefersDark()` deterministically reads as
      // false rather than throwing.
      expect(resolveTheme('system')).toBe('light');
    });
  });

  describe('useThemeStore', () => {
    it("defaults to the 'system' preference", () => {
      expect(useThemeStore.getState().preference).toBe('system');
    });

    it('setPreference updates both preference and resolvedTheme, and persists the choice', () => {
      const { setPreference } = useThemeStore.getState();

      setPreference('dark');
      expect(useThemeStore.getState().preference).toBe('dark');
      expect(useThemeStore.getState().resolvedTheme).toBe('dark');
      expect(readPersistedThemePreference()).toBe('dark');

      setPreference('light');
      expect(useThemeStore.getState().preference).toBe('light');
      expect(useThemeStore.getState().resolvedTheme).toBe('light');
      expect(readPersistedThemePreference()).toBe('light');
    });

    it('setPreference reflects the resolved theme onto <html data-theme>', () => {
      useThemeStore.getState().setPreference('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      useThemeStore.getState().setPreference('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });
});
