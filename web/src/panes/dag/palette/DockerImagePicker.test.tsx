import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { _resetCimgTagsCacheForTests } from '~/lib/schema/imageTags';

import { DockerImagePicker } from './DockerImagePicker';

vi.mock('~/lib/rpc/client', () => ({ getDockerTags: vi.fn<() => void>() }));

/** Flushes the microtask `fetchCimgTags` resolves on, inside `act` -- every render/selection here kicks off that async lookup in a `useEffect`, and without this, assertions made immediately after would either race it or (if they don't) leave React warning about a state update outside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('DockerImagePicker', () => {
  beforeEach(() => {
    _resetCimgTagsCacheForTests();
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: [],
      live: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in "Convenience image" mode for a cimg/* value, listing every CIMG_IMAGES entry', async () => {
    render(
      <DockerImagePicker
        value="cimg/base:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    expect(
      screen.getByRole('button', { name: 'Convenience image' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('option', { name: /cimg\/node/ }),
    ).toBeInTheDocument();
  });

  it('starts in "Custom image" mode for a non-cimg value', () => {
    render(
      <DockerImagePicker value="ubuntu:22.04" onChange={vi.fn<() => void>()} />,
    );
    expect(
      screen.getByRole('button', { name: 'Custom image' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.queryByRole('option', { name: /cimg\/node/ }),
    ).not.toBeInTheDocument();
  });

  it('selecting a different repo keeps the tag empty rather than carrying over an unrelated one', async () => {
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/base:current" onChange={onChange} />);
    await flush();

    fireEvent.click(screen.getByRole('option', { name: /cimg\/node/ }));
    expect(onChange).toHaveBeenCalledWith('cimg/node:');
  });

  it('re-selecting the already-selected repo preserves the existing tag', async () => {
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/node:20.11.0" onChange={onChange} />);
    await flush();

    fireEvent.click(screen.getByRole('option', { name: /cimg\/node/ }));
    expect(onChange).toHaveBeenCalledWith('cimg/node:20.11.0');
  });

  it('offers live version tags through the tag combobox, ranked ones first', async () => {
    // Issue #213: this used to assert a wrapped row of `role="option"` *buttons*,
    // one per tag, with the newest badged "Latest". That framing survives inside
    // the combobox as the "Recommended" group and the "newest" hint -- see
    // `ImageTagCombobox.test.tsx`. What is asserted here is the wiring: the picker
    // hands the fetched tags to the combobox, and a chosen tag lands back in the
    // single shared image value.
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0', '20.10.0'],
      allTags: ['20.11.2', '20.11.0', '20.10.0'],
      live: true,
    });
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/node:" onChange={onChange} />);

    const combobox = await waitFor(() =>
      screen.getByRole('combobox', { name: 'Image tag' }),
    );
    fireEvent.focus(combobox);

    // Scoped to the tag listbox: the repo rows above it are `role="option"` too.
    const tagList = await waitFor(() =>
      screen.getByRole('listbox', { name: 'Published cimg/node tags' }),
    );
    // Ranked first, in the host's own newest-first order; then everything else,
    // also newest-first. Nothing is sorted alphabetically anywhere.
    expect(
      within(tagList)
        .getAllByRole('option')
        .map((option) => option.textContent?.trim()),
    ).toEqual(['20.11.0newest', '20.10.0', '20.11.2']);

    fireEvent.click(
      within(tagList).getByRole('option', { name: /^20\.11\.2/ }),
    );
    expect(onChange).toHaveBeenCalledWith('cimg/node:20.11.2');
  });

  // Issue #285: the manual "check now" refresh next to the tag combobox.
  it('the Refresh button calls getDockerTags with refresh:true and applies its result', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      live: true,
    });
    render(
      <DockerImagePicker value="cimg/node:" onChange={vi.fn<() => void>()} />,
    );
    await flush();

    vi.mocked(rpcClient.getDockerTags).mockResolvedValueOnce({
      available: true,
      tags: ['20.12.0'],
      live: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(rpcClient.getDockerTags).toHaveBeenLastCalledWith('node', true);

    await flush();
    fireEvent.focus(screen.getByRole('combobox', { name: 'Image tag' }));
    const tagList = await waitFor(() =>
      screen.getByRole('listbox', { name: 'Published cimg/node tags' }),
    );
    expect(
      within(tagList).getByRole('option', { name: /20\.12\.0/ }),
    ).toBeInTheDocument();
  });

  it('degrades gracefully (no crash, offline note) when the live fetch is unavailable', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: false,
      reason: 'offline',
    });
    render(
      <DockerImagePicker value="cimg/node:" onChange={vi.fn<() => void>()} />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(/couldn.t reach docker hub/i),
      ).toBeInTheDocument(),
    );
    // The offline variant suggestions must still be there even with no live tags.
    expect(
      screen.getByRole('button', { name: '-browsers' }),
    ).toBeInTheDocument();
  });

  it('toggles a variant suffix onto the current tag', async () => {
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/node:20.11.0" onChange={onChange} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '-browsers' }));
    expect(onChange).toHaveBeenCalledWith('cimg/node:20.11.0-browsers');
  });

  it('toggling the same variant again removes it', async () => {
    const onChange = vi.fn<() => void>();
    render(
      <DockerImagePicker
        value="cimg/node:20.11.0-browsers"
        onChange={onChange}
      />,
    );
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '-browsers' }));
    expect(onChange).toHaveBeenCalledWith('cimg/node:20.11.0');
  });

  it('switching to "Custom image" mode hides the cimg picker and keeps the text field editable', async () => {
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/base:current" onChange={onChange} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Custom image' }));
    expect(
      screen.queryByRole('option', { name: /cimg\/node/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^image$/i), {
      target: { value: 'my-registry.example.com/app:1.0' },
    });
    expect(onChange).toHaveBeenCalledWith('my-registry.example.com/app:1.0');
  });

  it('typing directly into the text field always works, independent of the picker', async () => {
    const onChange = vi.fn<() => void>();
    render(<DockerImagePicker value="cimg/base:current" onChange={onChange} />);
    await flush();

    fireEvent.change(screen.getByLabelText(/^image$/i), {
      target: { value: 'cimg/base:2024.01' },
    });
    expect(onChange).toHaveBeenCalledWith('cimg/base:2024.01');
  });

  it('renders a doc link to the convenience-images documentation', async () => {
    render(
      <DockerImagePicker
        value="cimg/base:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});
