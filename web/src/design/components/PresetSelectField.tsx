/**
 * The control shape this app uses for "a value CircleCI enumerates, that must
 * still be writable before our documentation snapshot catches up": a `<select>`
 * grouped by the source's own headings, an "Other..." option that reveals a
 * free-text input, and a provenance line that says where the list came from and
 * admits when it is a fallback.
 *
 * Extracted for issue #213's actual requirement -- "these three fields should end
 * up feeling like one control pattern rather than three". Before this, the
 * resource-class field owned that shape and the macOS Xcode field was a bare text
 * input; adding a second grouped select beside it would have been the third
 * slightly-different version of the same idea in the same dialog.
 *
 * ## What lives here and what does not
 *
 * Here: option groups, the escape hatch, the "is the current value one of the
 * presets?" question, the commit timing, and the provenance line. All of it is
 * about the *control*.
 *
 * Not here: anything domain-specific. Which tables to read, what an architecture
 * filter means, whether a version is a pre-release -- those stay with the field
 * that knows them (`ResourceClassField`, `XcodeVersionField`), which passes groups
 * in and renders its own notices around this. A shared component that grew a
 * `mode: 'resourceClass' | 'xcode'` prop would be two components wearing one name.
 *
 * ## Why a native `<select>` and not the combobox
 *
 * The tag field (issue #213) is a combobox because a `cimg` repo publishes
 * hundreds of tags and type-to-filter is the only way to reach one. Resource
 * classes and Xcode versions are closed lists of roughly seven and ten, where a
 * native `<select>` is strictly better: the platform's own popup scrolls itself, is
 * keyboard- and screen-reader-accessible with no work here, positions itself
 * correctly at the bottom of a cramped inspector, and adds no nested scroll region
 * to a pane (issue #88). "One control pattern" means one *shape* -- preset
 * list, escape hatch, provenance -- not one widget for lists of six and lists of
 * six hundred.
 */
import { useId, useState, type ReactNode } from 'react';

/** The `<select>` value that reveals the free-text field. Not a legal value in any of the domains this serves, so it can never collide with one. */
export const CUSTOM_PRESET_OPTION = '__custom__';

export const presetControlClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** One option in a group: the value to write, plus what the source says about it. */
export interface PresetOption {
  value: string;
  /** Defaults to `value`; set it only when the two genuinely differ. */
  label?: string;
  /** `title` text, assembled by the calling field from its own source's columns. */
  title?: string;
}

/** One option group, labelled in the source's own words. */
export interface PresetGroup {
  id: string;
  label: string;
  options: PresetOption[];
}

export function PresetSelectField({
  id,
  value,
  onChange,
  groups,
  fallbackValues = [],
  allowUnset = false,
  customCommit = 'blur',
  customPlaceholder,
  customLabel,
  ariaLabel,
  children,
}: {
  id: string;
  /** The current value, or `''` when the config sets none. */
  value: string;
  /** Called with the new value. Never called with `CUSTOM_PRESET_OPTION` or an empty string. */
  onChange: (next: string) => void;
  /** The option groups to offer, in the order shown. Empty while the source's fetch is in flight. */
  groups: readonly PresetGroup[];
  /**
   * Values to offer when `groups` is empty -- in practice just whatever the
   * caller already knows. Deliberately not a retyped copy of the source: the host
   * already falls back to the tables embedded in its own binary, so the only way
   * to get here is the host being unreachable, and a second list maintained for
   * that would be a second thing to drift. Free text covers the rest.
   */
  fallbackValues?: readonly string[];
  /** Offers a "Not set" option, for a field whose value is legitimately absent. */
  allowUnset?: boolean;
  /**
   * When the free-text field reports a value: on blur (the default) or on every
   * keystroke.
   *
   * Not a style preference -- it is about what `onChange` *costs* at each call
   * site. In the inspector each call is a YAML document mutation and an undo
   * entry, so per-keystroke would be wrong there. In a dialog it sets local state
   * that is not written anywhere until the user confirms, so waiting for a blur
   * that clicking the button may never produce would silently drop what was
   * typed.
   */
  customCommit?: 'blur' | 'change';
  customPlaceholder?: string;
  /** The free-text input's accessible name, e.g. "Custom resource class". */
  customLabel: string;
  /**
   * An explicit accessible name, for a usage where the visible `<label htmlFor>`
   * can't reliably point at *this* select -- the inspector renders one of these
   * alongside a read-only inherited value under a single label.
   */
  ariaLabel?: string;
  /** Notices the calling field renders under the control: provenance, warnings, a docs link. */
  children?: ReactNode;
}) {
  const customFieldId = useId();

  // With no groups -- the tick before the response arrives, or the host
  // unreachable -- the current value is itself offered as an option, ahead of
  // whatever the caller could supply. So the field always shows the value the
  // config actually has, immediately, instead of blanking or flipping into a
  // free-text box and back again on every render.
  const presetValues =
    groups.length > 0
      ? groups.flatMap((group) => group.options.map((option) => option.value))
      : [...new Set([...(value ? [value] : []), ...fallbackValues])];
  const isPreset = presetValues.includes(value);

  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState(value);
  // A value the offered list doesn't contain is shown in the free-text field
  // rather than silently dropped -- the config says what it says, and this
  // control must never make an existing value invisible. It can only reach that
  // state once real groups have arrived (see `presetValues`), so there is no
  // flicker while the response is in flight.
  const custom = showCustom || (value !== '' && !isPreset);

  const commitCustom = () => {
    const trimmed = customDraft.trim();
    if (trimmed && trimmed !== value) onChange(trimmed);
  };

  return (
    <>
      <select
        id={id}
        aria-label={ariaLabel}
        value={custom ? CUSTOM_PRESET_OPTION : isPreset ? value : ''}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_PRESET_OPTION) {
            setShowCustom(true);
            return;
          }
          setShowCustom(false);
          if (next) onChange(next);
        }}
        className={`${presetControlClassName} font-mono`}
      >
        {allowUnset || !isPreset ? (
          <option value="" disabled={value !== ''}>
            Not set
          </option>
        ) : null}
        {groups.length > 0
          ? groups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.options.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    title={option.title}
                  >
                    {option.label ?? option.value}
                  </option>
                ))}
              </optgroup>
            ))
          : presetValues.map((presetValue) => (
              <option key={presetValue} value={presetValue}>
                {presetValue}
              </option>
            ))}
        <option value={CUSTOM_PRESET_OPTION}>Other&hellip;</option>
      </select>

      {custom ? (
        <input
          id={customFieldId}
          aria-label={customLabel}
          value={customDraft}
          onChange={(event) => {
            setCustomDraft(event.target.value);
            if (customCommit === 'change') {
              const trimmed = event.target.value.trim();
              if (trimmed && trimmed !== value) onChange(trimmed);
            }
          }}
          onBlur={commitCustom}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          placeholder={customPlaceholder}
          className={`${presetControlClassName} mt-1.5 font-mono`}
        />
      ) : null}

      {children}
    </>
  );
}
