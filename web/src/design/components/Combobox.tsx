/**
 * A single-value combobox: a text input that suggests from a list, narrows as you
 * type, walks with the arrow keys, and accepts anything you type whether or not it
 * is in the list.
 *
 * ## Why this exists as a shared component
 *
 * The pattern is `ContextField`'s (issue #152/#170) -- the same keyboard model,
 * the same deferred blur, the same "free text is first class" rule, the same
 * honesty line under the field. Issue #213 needs it a second time, for `cimg`
 * image tags, and a second hand-rolled combobox would have been two ARIA
 * implementations to keep correct. `ContextField` stays as it is: it is a
 * *multi*-value field with pills and a separate Add button, and folding both into
 * one component would mean a `multiple` prop and two code paths through every
 * keyboard branch. This is the single-value half, extracted rather than
 * generalised.
 *
 * ## Where a combobox is the right control and where it is not
 *
 * Here, because a `cimg` repo publishes hundreds of tags: a `<select>` of 400
 * options is only marginally better than 400 buttons, and neither can be searched.
 * Resource classes and Xcode versions are closed lists of roughly seven and ten,
 * and those stay on the native `<select>` of `PresetSelectField` -- see its doc
 * comment for why the platform's own popup is strictly better at that size.
 *
 * ## Scroll regions (issue #88)
 *
 * The popup is an absolutely-positioned overlay with its own `max-h`, not a
 * scroller inside the pane's own scroll flow: it is painted over whatever is below
 * it and does not lengthen the pane, so it adds no nested scroll region of the
 * kind #88 ruled out. That is the same thing `ContextField`'s popup already
 * does in the same inspector.
 *
 * `visibleLimit` is what keeps that promise honest at scale. An unbounded popup
 * over 400 tags would render 400 focusable buttons into the accessibility tree and
 * turn its own `max-h` into a several-thousand-pixel scroller inside a 300px-wide
 * inspector. Capping the rendered options and *saying* how many more matched is
 * both faster and more truthful than a scrollbar that suggests you could get to
 * the end.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const comboboxInputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** One suggestion. `value` is what gets committed; the rest is what the list shows about it. */
export interface ComboboxOption {
  value: string;
  /** A short note shown to the right of the value, e.g. "newest". */
  hint?: string;
  /** `title` text. */
  title?: string;
  /**
   * A group heading rendered above this option, when it differs from the previous
   * option's. Flat-list-with-headings rather than nested groups, because that is
   * what filtering a grouped list actually produces: a heading with nothing under
   * it must disappear, and a flat list makes that automatic.
   */
  group?: string;
}

/**
 * How many matching options are rendered at once. Twelve is about two pane-widths
 * of vertical space in the inspector -- enough that the list looks like a list
 * rather than a truncation, few enough that typing one more character is obviously
 * the faster way to the rest.
 */
const DEFAULT_VISIBLE_LIMIT = 12;

export function Combobox({
  id,
  value,
  onCommit,
  options,
  filter,
  placeholder,
  listLabel,
  visibleLimit = DEFAULT_VISIBLE_LIMIT,
  ariaLabel,
  children,
}: {
  id: string;
  /** The current value. Shown in the input, and editable in place. */
  value: string;
  /**
   * Called with a trimmed, non-empty value that differs from the current one.
   *
   * Commit points are: picking an option, pressing Enter, and blurring the input.
   * Not every keystroke -- in the inspector each commit is a YAML mutation and an
   * undo entry, and a per-keystroke combobox would put one undo step per character
   * on the stack.
   */
  onCommit: (next: string) => void;
  /** Everything that could be suggested, in the order it should appear when nothing is typed. */
  options: readonly ComboboxOption[];
  /**
   * Whether an option matches what has been typed. Supplied by the caller because
   * the right answer is domain-specific: image tags want a substring match (a
   * variant suffix is a thing people search by), version numbers want a prefix
   * match. Defaults to case-insensitive substring.
   */
  filter?: (option: ComboboxOption, query: string) => boolean;
  placeholder?: string;
  /** The listbox's accessible name, e.g. "Recent cimg/node tags". */
  listLabel: string;
  visibleLimit?: number;
  ariaLabel?: string;
  /** The honesty line (and anything else) rendered under the input. */
  children?: ReactNode;
}) {
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `null` means "showing the committed value"; a string means the user is
   * editing. Kept distinct so that a `value` that changes underneath (a different
   * image selected, an undo) is reflected immediately, while a draft in progress is
   * never clobbered by a re-render.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const text = draft ?? value;

  const matches = useMemo(() => {
    const query = text.trim();
    const predicate =
      filter ??
      ((option: ComboboxOption, q: string) =>
        option.value.toLowerCase().includes(q.toLowerCase()));
    // An untouched field shows the whole list: the point of opening it is to see
    // what is on offer, and filtering by the value already committed would show
    // exactly one option -- the one you already have.
    const all =
      draft === null || query === ''
        ? [...options]
        : options.filter((option) => predicate(option, query));
    return all;
  }, [options, text, draft, filter]);

  const visible = matches.slice(0, visibleLimit);
  const hiddenCount = matches.length - visible.length;

  const commit = (next: string) => {
    const trimmed = next.trim();
    setDraft(null);
    setOpen(false);
    setHighlighted(-1);
    if (trimmed && trimmed !== value) onCommit(trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visible.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlighted((current) =>
        current + 1 >= visible.length ? 0 : current + 1,
      );
      return;
    }
    if (event.key === 'ArrowUp' && visible.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlighted((current) =>
        current <= 0 ? visible.length - 1 : current - 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // The highlighted option when there is one, otherwise exactly what was
      // typed -- free text stays a first-class way to use this field, because a
      // tag must be writable the moment it is published and long before any
      // cache refresh notices.
      const chosen =
        open && highlighted >= 0 && highlighted < visible.length
          ? (visible[highlighted]?.value ?? text)
          : text;
      commit(chosen);
      return;
    }
    if (event.key === 'Escape' && open) {
      // Closes the list without discarding the draft: Escape means "stop
      // suggesting", not "undo my typing".
      event.preventDefault();
      setOpen(false);
      setHighlighted(-1);
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open && visible.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && highlighted >= 0 && highlighted < visible.length
            ? `${listId}-${highlighted}`
            : undefined
        }
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setHighlighted(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Deferred so a click on an option lands before the list is torn out
          // from under the pointer.
          blurTimer.current = setTimeout(() => {
            setOpen(false);
            setHighlighted(-1);
            // Blur is a commit point: someone who typed a tag and clicked
            // straight at "Create job" must not lose it.
            if (draft !== null) commit(draft);
          }, 120);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={`${comboboxInputClassName} font-mono`}
      />

      {open && visible.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-cc-border-strong bg-cc-panel p-1 shadow-lg"
        >
          {visible.map((option, index) => {
            const heading =
              option.group && option.group !== lastGroup ? option.group : null;
            lastGroup = option.group;
            return (
              <li key={option.value}>
                {heading ? (
                  <p
                    // `aria-hidden` because a heading rendered as a sibling of
                    // the options is decorative to a screen reader walking the
                    // listbox; each option carries its own group in its
                    // accessible name instead (see `aria-label` below).
                    aria-hidden
                    className="px-2 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wide text-cc-text-faint"
                  >
                    {heading}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  aria-label={
                    option.group
                      ? `${option.value} (${option.group})`
                      : option.value
                  }
                  title={option.title}
                  // The list must not steal focus from the input, or the
                  // combobox's keyboard model comes apart.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => commit(option.value)}
                  className={`flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left font-mono text-2xs ${
                    index === highlighted
                      ? 'bg-cc-panel-raised text-cc-text'
                      : 'text-cc-text-muted hover:bg-cc-panel-raised'
                  }`}
                >
                  <span className="truncate">{option.value}</span>
                  {option.hint ? (
                    <span className="shrink-0 font-sans text-cc-text-faint">
                      {option.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {hiddenCount > 0 ? (
            /* Said rather than scrolled to. See the module doc comment: a
               scrollbar over 400 options implies you could reach the end, and
               typing one more character is the faster route to what you want. */
            <li
              role="presentation"
              className="px-2 pb-0.5 pt-1 text-2xs text-cc-text-faint"
            >
              {hiddenCount} more match{hiddenCount === 1 ? '' : 'es'} &mdash;
              keep typing to narrow.
            </li>
          ) : null}
        </ul>
      ) : null}

      {children}
    </div>
  );
}
