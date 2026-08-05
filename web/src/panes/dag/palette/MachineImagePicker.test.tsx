import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { __resetMachineOfferingsCacheForTests } from '~/lib/machineOfferings/useMachineOfferings';

import { MachineImagePicker } from './MachineImagePicker';

vi.mock('~/lib/rpc/client', () => ({
  getMachineOfferings: vi.fn<() => void>(),
}));

/** Flushes the microtask `useMachineOfferings` resolves on -- every render here kicks off that async lookup in a `useEffect`. Mirrors `DockerImagePicker.test.tsx`'s own `flush`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('MachineImagePicker', () => {
  beforeEach(() => {
    __resetMachineOfferingsCacheForTests();
    vi.mocked(rpcClient.getMachineOfferings).mockResolvedValue({
      available: false,
      reason: 'not fetched in this test',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every MACHINE_IMAGES family with its description', async () => {
    render(
      <MachineImagePicker
        value="ubuntu-2204:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    expect(
      screen.getByRole('option', { name: /ubuntu-2204/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ubuntu 22\.04/i)).toBeInTheDocument();
  });

  it("marks the initial value's family and tag as selected", async () => {
    render(
      <MachineImagePicker
        value="ubuntu-2204:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    expect(screen.getByRole('option', { name: /ubuntu-2204/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: /^current/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it("selecting a family sets the image to that family's first tag", async () => {
    const onChange = vi.fn<() => void>();
    render(
      <MachineImagePicker value="ubuntu-2204:current" onChange={onChange} />,
    );
    await flush();

    fireEvent.click(screen.getByRole('option', { name: /android/ }));
    expect(onChange).toHaveBeenCalledWith('android:default');
  });

  it('selecting a tag keeps the current family', async () => {
    const onChange = vi.fn<() => void>();
    render(
      <MachineImagePicker value="ubuntu-2204:current" onChange={onChange} />,
    );
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /^edge/ }));
    expect(onChange).toHaveBeenCalledWith('ubuntu-2204:edge');
  });

  it('marks "current" as recommended, with a citation-style tooltip, but not "edge"', async () => {
    render(
      <MachineImagePicker
        value="ubuntu-2204:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    const currentButton = screen.getByRole('button', { name: /^current/ });
    expect(currentButton).toHaveTextContent('Recommended');
    const edgeButton = screen.getByRole('button', { name: /^edge/ });
    expect(edgeButton).not.toHaveTextContent('Recommended');
  });

  it('typing directly into the text field still works, with no picker interaction at all', async () => {
    const onChange = vi.fn<() => void>();
    render(
      <MachineImagePicker value="ubuntu-2204:current" onChange={onChange} />,
    );
    await flush();

    fireEvent.change(screen.getByLabelText(/^vm image$/i), {
      target: { value: 'some-custom-image:tag' },
    });
    expect(onChange).toHaveBeenCalledWith('some-custom-image:tag');
  });

  it('renders a doc link to the machine-images documentation', async () => {
    render(
      <MachineImagePicker
        value="ubuntu-2204:current"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows no tag row (and no crash) for a value that does not match a known family', async () => {
    render(
      <MachineImagePicker
        value="my-own-image:v1"
        onChange={vi.fn<() => void>()}
      />,
    );
    await flush();
    expect(
      screen.queryByRole('button', { name: /^current/ }),
    ).not.toBeInTheDocument();
  });

  it('says the built-in list is shown when the live catalog is unavailable', async () => {
    render(
      <MachineImagePicker
        value="ubuntu-2204:current"
        onChange={vi.fn<() => void>()}
        resourceClass="large"
      />,
    );
    await flush();
    expect(screen.getByText(/not fetched in this test/)).toBeInTheDocument();
    // Unfiltered: with no live catalog, every family still shows.
    expect(screen.getByRole('option', { name: /android/ })).toBeInTheDocument();
  });

  describe('with a live catalog', () => {
    beforeEach(() => {
      vi.mocked(rpcClient.getMachineOfferings).mockResolvedValue({
        available: true,
        linux: { large: ['ubuntu-2204:current', 'ubuntu-2404:current'] },
        windows: {},
        macos: {},
        deprecated: { linux: ['ubuntu-2204:edge'] },
        fetchedAt: '2026-07-31T00:00:00Z',
        live: true,
      });
    });

    it('hides a family the catalog does not offer for the selected resource class', async () => {
      render(
        <MachineImagePicker
          value="ubuntu-2204:current"
          onChange={vi.fn<() => void>()}
          resourceClass="large"
        />,
      );
      await flush();
      expect(
        screen.getByRole('option', { name: /ubuntu-2204/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: /android/ }),
      ).not.toBeInTheDocument();
    });

    it('keeps the current value visible, with a notice, even when the catalog does not offer it for this class', async () => {
      render(
        <MachineImagePicker
          value="android:default"
          onChange={vi.fn<() => void>()}
          resourceClass="large"
        />,
      );
      await flush();
      expect(
        screen.getByRole('option', { name: /android/ }),
      ).toBeInTheDocument();
      expect(screen.getByText(/does not offer/)).toBeInTheDocument();
    });

    it('flags a tag the catalog lists as deprecated', async () => {
      render(
        <MachineImagePicker
          value="ubuntu-2204:current"
          onChange={vi.fn<() => void>()}
          resourceClass="large"
        />,
      );
      await flush();
      const edgeButton = screen.getByRole('button', { name: /^edge/ });
      expect(edgeButton).toHaveTextContent('Deprecated');
      const currentButton = screen.getByRole('button', { name: /^current/ });
      expect(currentButton).not.toHaveTextContent('Deprecated');
    });

    it('offers a manual refresh once a catalog is available', async () => {
      render(
        <MachineImagePicker
          value="ubuntu-2204:current"
          onChange={vi.fn<() => void>()}
          resourceClass="large"
        />,
      );
      await flush();
      const refreshButton = screen.getByRole('button', { name: /^refresh$/i });
      fireEvent.click(refreshButton);
      await flush();
      expect(rpcClient.getMachineOfferings).toHaveBeenCalledWith(true);
    });
  });
});
