/**
 * The app-bar control for choosing a layout preset (issue #30). Modelled
 * on the same "row of toggle buttons in a `role=group`" shape `DagPane`'s
 * `SourceCompiledToggle` already uses for Source/Compiled, so preset selection reads as
 * consistent with the rest of the app's chrome rather than inventing a
 * second widget style for the same kind of choice.
 *
 * Issue #121: a "Custom" pill joins the five named ones once the user has
 * rearranged any pane (`useLayoutStore`'s `custom` is non-`null`) --
 * absent until then, so a user who never touches the "Move" menu sees no
 * change here at all. Its own small "Reset" button is this feature's "way
 * back" hard requirement: reachable from the exact same control a user
 * already goes to when they want a different overall layout, not buried in
 * a per-pane menu they'd have to remember opening.
 *
 * Issue #154 added the `compact` form. This row is the single widest item in
 * the app bar -- 404px of the ~1060px the bar's fixed furniture needs at all
 * -- so on a narrow window it is the biggest thing that can be given back, and
 * giving it back is what buys the file switcher enough room to stay a row of
 * buttons instead of collapsing too. Unlike the file switcher, the choice here
 * is driven by an ordinary width threshold rather than a measurement, because
 * this control's content is *bounded*: five known labels plus an optional
 * sixth, so what it needs is a number that can be written down. See
 * `./appBar`.
 */
import { useLayoutStore } from '~/state/layoutStore';

import {
  DisclosureMenu,
  menuItemClassName,
  menuSectionClassName,
} from './DisclosureMenu';
import { PRESETS } from './presets';

const CUSTOM_LABEL = 'Custom';

function pillClassName(active: boolean): string {
  return `rounded px-2 py-0.5 transition-colors ${
    active
      ? 'bg-cc-accent text-cc-on-accent'
      : 'text-cc-text-muted hover:text-cc-text'
  }`;
}

export function PresetSwitcher({ compact = false }: { compact?: boolean }) {
  const activePreset = useLayoutStore((state) => state.activePreset);
  const setPreset = useLayoutStore((state) => state.setPreset);
  const hasCustom = useLayoutStore((state) => state.custom !== null);
  const activateCustom = useLayoutStore((state) => state.activateCustom);
  const resetCustomLayout = useLayoutStore((state) => state.resetCustomLayout);

  const activeLabel =
    activePreset === 'custom'
      ? CUSTOM_LABEL
      : (PRESETS.find((preset) => preset.id === activePreset)?.label ??
        CUSTOM_LABEL);

  if (compact) {
    return (
      <div
        role="group"
        aria-label="Pane layout"
        className="flex shrink-0 items-center rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-xs"
      >
        <DisclosureMenu
          menuLabel="Pane layout"
          // The visible text is the active preset's own label, which alone
          // wouldn't say what the button *is* -- so the accessible name keeps
          // it as a prefix and adds that.
          triggerLabel={`${activeLabel} — change the pane layout`}
          triggerTitle="Choose which panes are shown and how they're arranged"
          triggerClassName="max-w-[9rem] truncate rounded px-2 py-0.5 text-cc-text transition-colors hover:bg-cc-panel"
          triggerContent={activeLabel}
        >
          {(close) => (
            <>
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={activePreset === preset.id}
                  title={preset.description}
                  onClick={() => {
                    setPreset(preset.id);
                    close();
                  }}
                  className={`${menuItemClassName} ${
                    activePreset === preset.id
                      ? 'font-semibold text-cc-accent'
                      : ''
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              {hasCustom ? (
                <>
                  <div
                    className="my-1 border-t border-cc-border"
                    role="separator"
                  />
                  <div className={menuSectionClassName}>Your arrangement</div>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={activePreset === 'custom'}
                    title="Your own rearranged layout"
                    onClick={() => {
                      activateCustom();
                      close();
                    }}
                    className={`${menuItemClassName} ${
                      activePreset === 'custom'
                        ? 'font-semibold text-cc-accent'
                        : ''
                    }`}
                  >
                    {CUSTOM_LABEL}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Reset custom layout"
                    title="Discard the custom layout and return to its starting preset"
                    onClick={() => {
                      resetCustomLayout();
                      close();
                    }}
                    className={`${menuItemClassName} text-cc-text-muted`}
                  >
                    Reset
                  </button>
                </>
              ) : null}
            </>
          )}
        </DisclosureMenu>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Pane layout"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-xs"
    >
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={activePreset === preset.id}
          onClick={() => setPreset(preset.id)}
          title={preset.description}
          className={pillClassName(activePreset === preset.id)}
        >
          {preset.label}
        </button>
      ))}
      {hasCustom ? (
        <span className="ml-0.5 flex items-center gap-0.5 border-l border-cc-border pl-1">
          <button
            type="button"
            aria-pressed={activePreset === 'custom'}
            onClick={activateCustom}
            title="Your own rearranged layout"
            className={pillClassName(activePreset === 'custom')}
          >
            {CUSTOM_LABEL}
          </button>
          <button
            type="button"
            onClick={resetCustomLayout}
            title="Discard the custom layout and return to its starting preset"
            aria-label="Reset custom layout"
            className="rounded px-1.5 py-0.5 text-cc-text-faint transition-colors hover:bg-cc-panel hover:text-cc-text"
          >
            Reset
          </button>
        </span>
      ) : null}
    </div>
  );
}
