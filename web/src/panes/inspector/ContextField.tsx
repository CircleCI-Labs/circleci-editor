/**
 * The inspector's `context:` editor (issue #152).
 *
 * ## The problem, in the owner's words
 *
 * *"I can click and drag a context, which is great. But I did notice when I
 * click on the job, it has a context section where I think you can add a
 * context by name. But obviously it doesn't have a list of the contexts."* The
 * palette knows every context the organization has; this field -- the one place
 * you are *explicitly* editing contexts -- knew none of them, so the only way
 * to use it was to remember a name exactly, and a typo here is a red pipeline
 * some minutes later.
 *
 * ## Why a combobox, and not a picker or a second list
 *
 * The owner was explicitly unsure ("maybe noodle on that -- what's the best way
 * to display that nicely") and invited a recommendation, so: a combobox on the
 * field itself. Type-to-filter over the real list, free text still accepted,
 * one control.
 *
 * The alternatives, and why not:
 *
 * - **A `<select>` of the fetched contexts.** Smallest change, and wrong: it
 *   makes a free-typed name impossible. A context that does not exist yet is a
 *   legitimate thing to write (you are about to create it), and a context in an
 *   organization this token cannot read is invisible to us but perfectly real.
 *   A picker that cannot express those turns a working config into an
 *   unwritable one.
 * - **A second browsable list here, mirroring the palette's.** Duplicates the
 *   palette's whole affordance in a narrower pane, and answers a question the
 *   user standing in this field is not asking. They are not browsing; they know
 *   which context they want and need help spelling it. The palette remains the
 *   place to *browse* (with variable previews and restriction badges, which do
 *   not belong in a text field).
 * - **Validation-only: keep free text, flag unknown names.** Half the fix. It
 *   tells you afterwards that you were wrong without ever helping you be right,
 *   and it cannot help at all with the case where you have simply forgotten
 *   what the context is called.
 *
 * The combobox is the union of the useful parts: the list is there when it
 * helps, the field is still a field, and the flag is still there for a name
 * that came from somewhere else (dragged in, hand-written, copied from another
 * config).
 *
 * ## Flagging without asserting
 *
 * An unrecognised name is marked as *unrecognised*, never as wrong -- and only
 * when the fetched list is known to be complete (`contextListCoverage`). With
 * no token, a failed listing, or an organization we could not resolve, we
 * genuinely do not know, and saying nothing is the only honest option. This is
 * the same rule the palette follows for `available: false` and the same one
 * already set for context usability elsewhere: "I cannot tell" is a real
 * answer and must not be flattened into "no".
 *
 * ## Keyboard
 *
 * Every drag affordance in this app has a keyboard path, and so does this:
 * ArrowDown/ArrowUp move through the suggestions, Enter accepts the highlighted
 * one (or the typed text when nothing is highlighted), Escape closes the list
 * and leaves what you typed, and the pills' remove buttons are ordinary
 * buttons. `role="combobox"` with `aria-activedescendant` is what makes the
 * highlight audible to a screen reader rather than only visible.
 *
 * ## Discoverability (issue #219)
 *
 * The control was right and invisible. The owner found it by accident, out
 * loud: *"I don't know why you can type to filter or enter any name. Oh wait,
 * there's a dropdown. Oh, you can actually select them. Okay, that's actually
 * really nice."* Everything in that sentence after "oh wait" is the bug -- they
 * read the field as free text, which is half of what it is, and only found the
 * other half by chance.
 *
 * Two changes, both about making the second half visible before it is used:
 *
 * - **A chevron.** The one affordance every user already reads as "there is a
 *   list behind this", and the thing a bare bordered input is missing next to
 *   this app's own `<select>`s. It is a real `<button>` that opens and closes
 *   the list, not decoration -- issue #183's rule is that anything that looks
 *   clickable must be -- and it gives a pointer user a way to browse the list
 *   without typing a character first, which is exactly the discovery path that
 *   failed here.
 * - **A placeholder naming both behaviours.** It already said "Type to filter,
 *   or enter any name" -- but *only* once the fetch had returned a non-empty
 *   list, so during the load, and forever for an org whose contexts cannot be
 *   read, it read "context name" and promised nothing. The two behaviours are
 *   true regardless of what the fetch returned, so the copy no longer depends
 *   on it.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '~/design/components/Button';
import { Tooltip } from '~/design/components/Tooltip';
import {
  contextListCoverage,
  useProjectContextStore,
} from '~/state/projectContextStore';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** Case-insensitive substring match, the same forgiving filter the palette's searches use. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}

export function ContextField({
  values,
  onAdd,
  onRemove,
}: {
  /** The context names currently on this workflow entry. */
  values: string[];
  /** Adds one name. Surgical at the YAML level -- see `addWorkflowJobEntryContext`. */
  onAdd: (name: string) => void;
  /** Removes one name. Also surgical -- see `removeWorkflowJobEntryContext`. */
  onRemove: (name: string) => void;
}) {
  const contexts = useProjectContextStore((state) => state.contexts);
  const state = useProjectContextStore((state) => state.state);
  const warnings = useProjectContextStore((state) => state.warnings);
  const reason = useProjectContextStore((state) => state.reason);
  const load = useProjectContextStore((state) => state.load);

  // Reuses the palette's fetch rather than issuing its own: `load` is a no-op
  // once a load is in flight or has succeeded, so opening the inspector on a
  // job costs no request when the palette has already loaded, and one when it
  // has not.
  useEffect(() => {
    void load();
  }, [load]);

  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const fieldId = useId();
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only so the chevron below can hand focus back to the field it belongs to
  // -- see its own comment.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const coverage = contextListCoverage({ state, warnings });
  const known = useMemo(
    () => new Set(contexts.map((context) => context.name)),
    [contexts],
  );

  // Already-added names are filtered out: offering one again would only ever
  // produce a duplicate the mutation refuses anyway.
  const suggestions = useMemo(
    () =>
      contexts
        .filter(
          (context) =>
            !values.includes(context.name) && matches(context.name, draft),
        )
        .map((context) => context.name),
    [contexts, values, draft],
  );

  const commit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || values.includes(trimmed)) {
        setDraft('');
        setOpen(false);
        return;
      }
      onAdd(trimmed);
      setDraft('');
      setOpen(false);
      setHighlighted(-1);
    },
    [onAdd, values],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlighted((current) =>
        current + 1 >= suggestions.length ? 0 : current + 1,
      );
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlighted((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // The highlighted suggestion when there is one, otherwise exactly what
      // was typed -- free text stays a first-class way to use this field.
      const chosen =
        open && highlighted >= 0 && highlighted < suggestions.length
          ? (suggestions[highlighted] ?? draft)
          : draft;
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

  const unrecognisedTooltip = (name: string) =>
    `“${name}” is not among the ${contexts.length} context${
      contexts.length === 1 ? '' : 's'
    } this editor fetched from CircleCI. That may be a typo, a context that does not exist yet, or one in an organization this token cannot read — it is not necessarily wrong.`;

  return (
    <div className="mb-2">
      <label
        htmlFor={fieldId}
        className="mb-1 block text-2xs font-medium text-cc-text-muted"
      >
        Contexts
      </label>

      {values.length > 0 ? (
        <ul className="mb-1.5 flex flex-wrap gap-1.5">
          {values.map((value) => {
            const unrecognised = coverage === 'complete' && !known.has(value);
            return (
              <li
                key={value}
                className={`flex items-center gap-1 rounded-full border bg-cc-panel-raised px-2 py-0.5 text-2xs font-mono text-cc-text ${
                  unrecognised
                    ? 'border-cc-warning/50'
                    : 'border-cc-border-strong'
                }`}
              >
                {value}
                {unrecognised ? (
                  <Tooltip content={unrecognisedTooltip(value)}>
                    <span
                      tabIndex={0}
                      aria-label={`${value} was not found in the fetched context list`}
                      className="cursor-help rounded-full px-0.5 text-cc-warning"
                    >
                      ?
                    </span>
                  </Tooltip>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove context ${value}`}
                  onClick={() => onRemove(value)}
                  className="rounded-full px-1 text-cc-text-muted hover:bg-cc-danger/20 hover:text-cc-danger"
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="relative flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            id={fieldId}
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && highlighted >= 0 && highlighted < suggestions.length
                ? `${listId}-${highlighted}`
                : undefined
            }
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setOpen(true);
              setHighlighted(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Deferred so a click on a suggestion lands before the list is
              // torn out from under the pointer.
              blurTimer.current = setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={handleKeyDown}
            // Names both behaviours unconditionally -- see the module comment.
            // `pr-7` reserves the chevron's own column so a long typed name
            // never runs underneath it.
            placeholder="Type to filter, or enter any name"
            className={`${inputClassName} pr-7 font-mono`}
          />

          {/*
            The visible "there is a list here" affordance (issue #219). Not a
            tab stop: `tabIndex={-1}` keeps the keyboard path exactly as it was
            -- ArrowDown from the input already opens the list, so a second
            focus stop between the field and the Add button would be one more
            Tab for every keyboard user in exchange for nothing they don't
            already have. `aria-hidden` for the same reason: to a screen
            reader the input's own `role="combobox"`/`aria-expanded` already
            says the list exists, and announcing a duplicate control that
            toggles the same thing is noise. This is a pointer affordance,
            deliberately.
          */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            // `onMouseDown`, not `onClick`: the input's deferred `onBlur`
            // (120ms) would otherwise race a click here and close the list the
            // moment this button had just opened it. `preventDefault` stops
            // the press from moving focus *off* the input, and the explicit
            // `focus()` puts it *on* the input when the press arrived from
            // outside the field -- so clicking the chevron always leaves you
            // typing in the combobox, which is where the next keystroke has to
            // land for the keyboard model to still hold.
            onMouseDown={(event) => {
              event.preventDefault();
              setOpen((current) => !current);
              setHighlighted(-1);
              inputRef.current?.focus();
            }}
            className="absolute right-0.5 top-0.5 rounded px-1 py-1 text-2xs leading-none text-cc-text-muted hover:bg-cc-border hover:text-cc-text"
          >
            {open ? '▴' : '▾'}
          </button>

          {open && suggestions.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label="Contexts in this organization"
              className="absolute z-20 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-cc-border-strong bg-cc-panel p-1 shadow-lg"
            >
              {suggestions.map((name, index) => (
                <li key={name}>
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlighted}
                    // The list must not steal focus from the input, or the
                    // combobox's keyboard model comes apart.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => commit(name)}
                    className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-2xs ${
                      index === highlighted
                        ? 'bg-cc-panel-raised text-cc-text'
                        : 'text-cc-text-muted hover:bg-cc-panel-raised'
                    }`}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => commit(draft)}
          disabled={!draft.trim()}
        >
          Add
        </Button>
      </div>

      {/*
        One faint line saying how much this field knows -- so an empty
        suggestion list is never mistaken for "this organization has no
        contexts", and so the absence of an unrecognised marker is never read as
        "checked, and fine".
      */}
      <p
        className="mt-1 text-2xs text-cc-text-faint"
        // The host's own reason (no token, not a CircleCI project) is worth
        // having, but not worth three lines inside a narrow pane that already
        // says it plainly in the palette.
        title={coverage === 'unknown' ? (reason ?? undefined) : undefined}
      >
        {coverage === 'complete' ? (
          contexts.length > 0 ? (
            <>
              {contexts.length} context{contexts.length === 1 ? '' : 's'} found
              in this organization. Any other name is still accepted.
            </>
          ) : (
            <>
              This organization has no contexts yet. A name typed here will work
              once one exists.
            </>
          )
        ) : coverage === 'partial' ? (
          <>
            CircleCI’s context list could not be read in full, so names here are
            not checked against it.
          </>
        ) : state === 'loading' || state === 'idle' ? (
          <>Loading this organization’s contexts…</>
        ) : (
          <>
            No CircleCI context list is available here, so names are not
            checked. Any name is accepted as typed.
          </>
        )}
      </p>
    </div>
  );
}
