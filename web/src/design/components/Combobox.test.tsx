import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Combobox, type ComboboxOption } from './Combobox';

/**
 * The shared single-value combobox's own contract (issue #213): the keyboard model,
 * the commit points, the ARIA wiring, and the visible-limit behaviour that keeps a
 * 400-option popup from becoming a scroll region inside a cramped pane
 * (issue #88).
 *
 * The tag-specific behaviour built on this -- ordering, the `latest` warning, the
 * offline note -- is in `ImageTagCombobox.test.tsx`.
 */
const OPTIONS: ComboboxOption[] = [
  { value: 'alpha', group: 'First', hint: 'newest' },
  { value: 'alphabet', group: 'First' },
  { value: 'beta', group: 'Second' },
];

function renderCombobox(props: Partial<Parameters<typeof Combobox>[0]> = {}) {
  return render(
    <Combobox
      id="cb"
      ariaLabel="Thing"
      value=""
      onCommit={vi.fn<(next: string) => void>()}
      options={OPTIONS}
      listLabel="Things"
      {...props}
    />,
  );
}

function input() {
  return screen.getByRole('combobox', { name: 'Thing' });
}

function list() {
  return screen.getByRole('listbox', { name: 'Things' });
}

describe('Combobox', () => {
  it('shows nothing until it is focused, then the whole list', () => {
    renderCombobox();
    expect(
      screen.queryByRole('listbox', { name: 'Things' }),
    ).not.toBeInTheDocument();

    fireEvent.focus(input());
    expect(within(list()).getAllByRole('option')).toHaveLength(3);
  });

  it('filters by case-insensitive substring by default', () => {
    renderCombobox();
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'ALPHAB' } });
    expect(
      within(list())
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['alphabet']);
  });

  it('lets the caller supply a different match rule', () => {
    // The Xcode field wants a prefix match, the tag field a substring one -- the
    // right answer is domain-specific, so it is the caller's to give.
    renderCombobox({
      filter: (option, query) => option.value.startsWith(query),
    });
    fireEvent.focus(input());
    // A substring but not a prefix: the default rule would offer `beta`, a
    // prefix rule offers nothing.
    fireEvent.change(input(), { target: { value: 'eta' } });
    expect(
      screen.queryByRole('listbox', { name: 'Things' }),
    ).not.toBeInTheDocument();
  });

  it('shows the full list, not one option, when the field holds a committed value', () => {
    // Filtering by the value already committed would show exactly the option you
    // already have, which is the opposite of why the list was opened.
    renderCombobox({ value: 'beta' });
    fireEvent.focus(input());
    expect(within(list()).getAllByRole('option')).toHaveLength(3);
  });

  it('walks with the arrow keys, wrapping in both directions', () => {
    const onCommit = vi.fn<(next: string) => void>();
    renderCombobox({ onCommit });
    fireEvent.focus(input());

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('beta');
  });

  it('points aria-activedescendant at the highlighted option', () => {
    renderCombobox();
    fireEvent.focus(input());
    expect(input()).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const active = input().getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('names each option’s group in its accessible name', () => {
    // The rendered group heading is `aria-hidden` -- a heading rendered as a
    // sibling of the options is decorative to a screen reader walking the listbox --
    // so the grouping has to reach assistive tech through the options themselves.
    renderCombobox();
    fireEvent.focus(input());
    expect(
      within(list()).getByRole('option', { name: 'alpha (First)' }),
    ).toBeInTheDocument();
    expect(
      within(list()).getByRole('option', { name: 'beta (Second)' }),
    ).toBeInTheDocument();
  });

  it('commits free text on Enter, whether or not it matches anything', () => {
    const onCommit = vi.fn<(next: string) => void>();
    renderCombobox({ onCommit });
    fireEvent.change(input(), { target: { value: '  gamma  ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('gamma');
  });

  it('commits on blur, so a click straight at a submit button loses nothing', async () => {
    const onCommit = vi.fn<(next: string) => void>();
    renderCombobox({ onCommit });
    fireEvent.change(input(), { target: { value: 'gamma' } });
    fireEvent.blur(input());
    // Deferred, so a click on an option lands before the list is torn away.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(onCommit).toHaveBeenCalledWith('gamma');
  });

  it('does not commit a value that has not changed', () => {
    // Each commit is a YAML mutation and an undo entry at the real call sites.
    const onCommit = vi.fn<(next: string) => void>();
    renderCombobox({ value: 'beta', onCommit });
    fireEvent.change(input(), { target: { value: 'beta' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit per keystroke', () => {
    const onCommit = vi.fn<(next: string) => void>();
    renderCombobox({ onCommit });
    fireEvent.change(input(), { target: { value: 'g' } });
    fireEvent.change(input(), { target: { value: 'ga' } });
    fireEvent.change(input(), { target: { value: 'gam' } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('closes on Escape without discarding what was typed', () => {
    // Escape means "stop suggesting", not "undo my typing".
    renderCombobox();
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'alph' } });
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(
      screen.queryByRole('listbox', { name: 'Things' }),
    ).not.toBeInTheDocument();
    expect(input()).toHaveValue('alph');
  });

  it('reflects a value that changes underneath it', () => {
    // An undo, or a different image selected in the picker above. A draft in
    // progress is never clobbered, but a committed value is always shown.
    const { rerender } = renderCombobox({ value: 'alpha' });
    expect(input()).toHaveValue('alpha');
    rerender(
      <Combobox
        id="cb"
        ariaLabel="Thing"
        value="beta"
        onCommit={vi.fn<(next: string) => void>()}
        options={OPTIONS}
        listLabel="Things"
      />,
    );
    expect(input()).toHaveValue('beta');
  });

  it('bounds the rendered list and says how many more matched', () => {
    // The scale answer. An unbounded popup over hundreds of options would render
    // hundreds of focusable buttons into the accessibility tree and turn its own
    // `max-h` into a several-thousand-pixel scroller -- a nested scroll region in
    // all but name. Capping and saying so is both faster and more truthful than a
    // scrollbar that implies you could reach the end.
    const many = Array.from({ length: 400 }, (_, i) => ({
      value: `v${i}`,
    }));
    renderCombobox({ options: many, visibleLimit: 5 });
    fireEvent.focus(input());

    expect(within(list()).getAllByRole('option')).toHaveLength(5);
    expect(
      within(list()).getByText(/395 more matches — keep typing to narrow/),
    ).toBeInTheDocument();
  });

  it('says nothing about withheld options when it is showing them all', () => {
    renderCombobox();
    fireEvent.focus(input());
    expect(within(list()).queryByText(/more match/)).not.toBeInTheDocument();
  });
});
