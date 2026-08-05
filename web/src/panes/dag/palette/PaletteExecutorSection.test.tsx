import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { PaletteExecutorSection } from './PaletteExecutorSection';
import type { PaletteExecutorPayload } from './paletteExecutors';

describe('PaletteExecutorSection', () => {
  it('always shows the five built-in cards, and clicking one activates the matching builtin payload', () => {
    const onActivate = vi.fn<(payload: PaletteExecutorPayload) => void>();
    render(<PaletteExecutorSection doc={null} onActivate={onActivate} />);

    for (const label of ['Docker', 'Linux VM', 'macOS', 'Windows', 'GPU']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${label}\\b`) }),
      ).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: /^docker\b/i }));
    expect(onActivate).toHaveBeenCalledWith({
      source: 'builtin',
      builtinId: 'docker',
    });
  });

  it("lists this document's own executors: entries, and clicking one activates a local payload", () => {
    const { doc } = parseConfig(`
executors:
  py-executor:
    docker:
      - image: cimg/python:3.11
`);
    if (!doc) throw new Error('fixture failed to parse');
    const onActivate = vi.fn<(payload: PaletteExecutorPayload) => void>();
    render(<PaletteExecutorSection doc={doc} onActivate={onActivate} />);

    fireEvent.click(screen.getByRole('button', { name: /^py-executor\b/i }));
    expect(onActivate).toHaveBeenCalledWith({
      source: 'local',
      executorName: 'py-executor',
    });
  });

  it('shows no local-executors group for a doc with no executors: block, or no doc at all', () => {
    render(
      <PaletteExecutorSection
        doc={null}
        onActivate={vi.fn<(payload: PaletteExecutorPayload) => void>()}
      />,
    );
    expect(screen.queryByText(/from this config/i)).not.toBeInTheDocument();
  });
});
