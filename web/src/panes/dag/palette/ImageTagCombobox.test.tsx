import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CimgTagsState } from '~/lib/schema/imageTags';

import { ImageTagCombobox, isMutableTag, tagOptions } from './ImageTagCombobox';

/**
 * The tag control's own tests (issue #213). The keyboard model and the visible-limit
 * behaviour belong to `Combobox` and are tested in `Combobox.test.tsx`; what is
 * tested here is what makes this control *about tags*: the ordering, the surviving
 * best-practice framing, the `latest` warning, and the offline story.
 */
function state(over: Partial<CimgTagsState> = {}): CimgTagsState {
  return {
    tags: ['20.11.0', '20.10.0'],
    allTags: ['20.11.2', '20.11.0', '20.11.0-browsers', '20.10.0'],
    source: 'live',
    ...over,
  };
}

function renderCombobox(
  props: Partial<Parameters<typeof ImageTagCombobox>[0]> = {},
) {
  return render(
    <ImageTagCombobox
      id="tag"
      imageName="node"
      tag=""
      tagsState={state()}
      onChange={vi.fn<(tag: string) => void>()}
      {...props}
    />,
  );
}

function openList() {
  fireEvent.focus(screen.getByRole('combobox', { name: 'Image tag' }));
  return screen.getByRole('listbox', { name: 'Published cimg/node tags' });
}

describe('tagOptions', () => {
  it('puts the ranked tags first, then the rest, each newest-first', () => {
    // Both groups come from the host in Docker Hub's own newest-first order and are
    // not re-sorted. Alphabetical would put `20.11` between `2.1` and `3.0`, which
    // is exactly the wrong answer for version tags.
    expect(tagOptions(state(), '').map((o) => [o.group, o.value])).toEqual([
      ['Recommended', '20.11.0'],
      ['Recommended', '20.10.0'],
      ['All published tags', '20.11.2'],
      ['All published tags', '20.11.0-browsers'],
    ]);
  });

  it('keeps #77’s recommendation framing: the ranked group, and the newest marked', () => {
    // The button row badged the first tag "Latest" with a tooltip disclaiming that
    // CircleCI recommends no specific version. That framing had to survive the
    // control change rather than being dropped with the buttons.
    const options = tagOptions(state(), '');
    expect(options[0]?.hint).toBe('newest');
    expect(options[0]?.title).toMatch(
      /CircleCI does not officially recommend a specific version/,
    );
    expect(options[1]?.hint).toBeUndefined();
  });

  it('pins the current tag to the front of its own group, marked', () => {
    // "Where am I?" is the first question a picker of hundreds has to answer, and an
    // unsorted list answers it last.
    const options = tagOptions(state(), '20.10.0');
    expect(options[0]?.value).toBe('20.10.0');
    expect(options[0]?.hint).toBe('current');
    expect(options.map((o) => o.value)).toContain('20.11.0');
  });

  it('shows a current tag Docker Hub’s page did not carry, in its own honest group', () => {
    // An older release, or one published since the cache was filled. A picker that
    // silently disagreed with the file open next to it would be worse than one that
    // admits it does not recognise a value.
    const options = tagOptions(state(), '18.0.0');
    expect(options[0]).toMatchObject({
      value: '18.0.0',
      group: 'Currently set',
      hint: 'current',
    });
    expect(options[0]?.title).toMatch(/not necessarily wrong/);
  });

  it('offers nothing at all before the lookup resolves', () => {
    expect(tagOptions(undefined, '20.11.0')).toEqual([]);
  });

  it('falls back to the ranked list when the host served no full list', () => {
    // A cache entry written before `allTags` existed -- `imageTags.ts` fills it from
    // `tags`, so this is belt-and-braces, but a combobox with nothing in it is the
    // failure mode worth being sure about.
    const options = tagOptions(
      state({ tags: ['1.21.0'], allTags: ['1.21.0'] }),
      '',
    );
    expect(options.map((o) => o.value)).toEqual(['1.21.0']);
  });
});

describe('isMutableTag', () => {
  it('recognises latest, case- and space-insensitively', () => {
    expect(isMutableTag('latest')).toBe(true);
    expect(isMutableTag('  LATEST ')).toBe(true);
  });

  it('does not fire on CircleCI’s own documented moving tags', () => {
    // `cimg/base:current` is this editor's Docker default and issue #203 reviewed it
    // as fine. A warning on the app's own default would train people to ignore the
    // warning.
    expect(isMutableTag('current')).toBe(false);
    expect(isMutableTag('edge')).toBe(false);
  });

  it('does not fire on a deliberate major pin', () => {
    // Upstream's paragraph names `1` too, but pinning a major is a common,
    // defensible choice, and a warning that fires on a deliberate choice is noise.
    expect(isMutableTag('14')).toBe(false);
    expect(isMutableTag('20.11.0')).toBe(false);
  });
});

describe('ImageTagCombobox', () => {
  it('filters by substring, so a variant suffix is searchable', async () => {
    // Deliberately different from the Xcode field's prefix match: a tag carries
    // variant suffixes people search by, so typing `browsers` has to work.
    renderCombobox();
    const input = screen.getByRole('combobox', { name: 'Image tag' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'browsers' } });

    const list = screen.getByRole('listbox', {
      name: 'Published cimg/node tags',
    });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['20.11.0-browsers']);
  });

  it('accepts free text that matches nothing, so a new tag is writable at once', () => {
    // A tag must be writable the moment it is published, long before any cache
    // refresh notices it.
    const onChange = vi.fn<(tag: string) => void>();
    renderCombobox({ onChange });
    const input = screen.getByRole('combobox', { name: 'Image tag' });
    fireEvent.change(input, { target: { value: '99.0.0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('99.0.0');
  });

  it('walks the list with the arrow keys and commits with Enter', () => {
    const onChange = vi.fn<(tag: string) => void>();
    renderCombobox({ onChange });
    const input = screen.getByRole('combobox', { name: 'Image tag' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('20.10.0');
  });

  it('warns off latest, citing CircleCI, at the moment someone types it', () => {
    // `latest` is never *offered* -- the host drops non-version tags entirely -- so
    // this only ever fires against something typed. Warning where the thing happens
    // is the only place a warning is worth anything.
    renderCombobox({ tag: 'latest' });
    expect(screen.getByText(/is a mutable tag\./)).toBeInTheDocument();
    expect(
      screen.getByText(/CircleCI recommends pinning a precise version/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Why not to pin a mutable tag/ }),
    ).toBeInTheDocument();
  });

  it('says nothing about a pinned version', () => {
    renderCombobox({ tag: '20.11.0' });
    expect(screen.queryByText(/mutable tag/)).not.toBeInTheDocument();
  });

  it('degrades to free text plus an explanation when Docker Hub is unreachable', () => {
    // Never an empty dropdown presented as the answer.
    const onChange = vi.fn<(tag: string) => void>();
    renderCombobox({
      onChange,
      tagsState: state({ tags: [], allTags: [], source: 'unavailable' }),
    });

    expect(
      screen.getByText(/Couldn’t reach Docker Hub for a version list/),
    ).toBeInTheDocument();
    // No listbox at all, rather than an empty one.
    expect(
      screen.queryByRole('listbox', { name: 'Published cimg/node tags' }),
    ).not.toBeInTheDocument();
    // And typing still works.
    const input = screen.getByRole('combobox', { name: 'Image tag' });
    fireEvent.change(input, { target: { value: '20.11.0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('20.11.0');
  });

  it('says how many tags it has and how fresh they are', () => {
    renderCombobox();
    expect(
      screen.getByText(/4 version tags, newest first\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Fetched just now from Docker Hub/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Any tag is accepted as typed/),
    ).toBeInTheDocument();
  });

  it('says the list is cached rather than implying it is fresh', () => {
    renderCombobox({ tagsState: state({ source: 'cache' }) });
    expect(
      screen.getByText(/From a previous Docker Hub fetch \(cached\)/),
    ).toBeInTheDocument();
  });

  it('discloses a rate-limit truncation rather than presenting a short list as complete (issue #243)', () => {
    renderCombobox({
      tagsState: state({
        truncated: true,
        truncatedReason: 'Docker Hub rate-limited this request (HTTP 429)',
      }),
    });
    expect(
      screen.getByText(/may be shorter than what Docker Hub actually has/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Docker Hub rate-limited this request \(HTTP 429\)/),
    ).toBeInTheDocument();
  });

  it('says nothing about truncation for an ordinary, complete list', () => {
    renderCombobox();
    expect(
      screen.queryByText(/may be shorter than what Docker Hub actually has/),
    ).not.toBeInTheDocument();
  });

  it('stays usable at ~400 tags: renders a bounded list and says what it withheld', () => {
    // The owner's actual concern -- "I don't think the buttons will scale, especially
    // if there's thousands of different versions of those images." A combobox popup
    // that rendered 400 focusable options would trade a wall of buttons for a wall of
    // options plus a several-thousand-pixel scroller inside a cramped inspector.
    // It renders a screenful and says how many more matched.
    const many = Array.from({ length: 400 }, (_, i) => `1.${400 - i}.0`);
    renderCombobox({
      tagsState: state({ tags: many.slice(0, 8), allTags: many }),
    });

    const list = openList();
    expect(within(list).getAllByRole('option')).toHaveLength(12);
    expect(
      within(list).getByText(/388 more matches — keep typing to narrow/),
    ).toBeInTheDocument();

    // And typing gets you to a specific one -- which is the whole reason the ranked
    // eight could not remain the only reachable tags.
    fireEvent.change(screen.getByRole('combobox', { name: 'Image tag' }), {
      target: { value: '1.137.0' },
    });
    expect(
      within(
        screen.getByRole('listbox', { name: 'Published cimg/node tags' }),
      ).getAllByRole('option'),
    ).toHaveLength(1);
  });
});
