/**
 * The app-bar control for choosing a colour theme (issue #52). Modelled on
 * the same "row of toggle buttons in a `role=group`" shape `DagPane`'s
 * `PresetSwitcher` and `SourceCompiledToggle` already use for their own
 * three-and-two-way choices, so this reads as consistent chrome rather than
 * a one-off widget -- and on the real CircleCI app's own theme control
 * (as CircleCI's production web UI does), which offers the
 * same three states: an explicit Light or Dark, or System (deferring to
 * `prefers-color-scheme`, see `~/state/themeStore`).
 */
import { useThemeStore, type ThemePreference } from '~/state/themeStore';

const OPTIONS: { value: ThemePreference; label: string; glyph: string }[] = [
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
  { value: 'system', label: 'System', glyph: '◐' },
];

export function ThemeToggle() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-xs"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={preference === option.value}
          aria-label={option.label}
          title={`${option.label} theme`}
          onClick={() => setPreference(option.value)}
          className={`rounded px-2 py-0.5 ${
            preference === option.value
              ? 'bg-cc-accent text-cc-on-accent'
              : 'text-cc-text-muted hover:text-cc-text'
          }`}
        >
          <span aria-hidden="true">{option.glyph}</span>
        </button>
      ))}
    </div>
  );
}
