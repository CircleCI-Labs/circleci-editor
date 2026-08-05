import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OrbElement } from '~/lib/orbs/types';

import { ParamsDialog } from './ParamsDialog';

const NO_REQUIRED: OrbElement = {
  name: 'checkout-and-cache',
  kind: 'command',
  parameters: [
    { name: 'cache-path', type: 'string', required: false, default: '' },
  ],
};

const WITH_REQUIRED: OrbElement = {
  name: 'install-packages',
  kind: 'command',
  parameters: [
    {
      name: 'pkg-manager',
      type: 'enum',
      required: false,
      enumValues: ['npm', 'yarn'],
      default: 'npm',
    },
    {
      name: 'override-ci-command',
      type: 'string',
      required: true,
      description: 'Custom install command',
    },
    { name: 'retries', type: 'integer', required: true },
    { name: 'verbose', type: 'boolean', required: true },
  ],
};

describe('ParamsDialog', () => {
  it('renders nothing (no dialog) when element is null', () => {
    render(
      <ParamsDialog
        element={null}
        onSubmit={vi.fn<(values: Record<string, unknown>) => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing when the element has no required parameters', () => {
    render(
      <ParamsDialog
        element={NO_REQUIRED}
        onSubmit={vi.fn<(values: Record<string, unknown>) => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows only the required parameters, marked required, with each type rendered appropriately', () => {
    render(
      <ParamsDialog
        element={WITH_REQUIRED}
        onSubmit={vi.fn<(values: Record<string, unknown>) => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('override-ci-command')).toBeInTheDocument();
    expect(screen.getByText('Custom install command')).toBeInTheDocument();
    // The optional "pkg-manager" enum is not part of the required-only form.
    expect(screen.queryByText('pkg-manager')).not.toBeInTheDocument();

    expect(screen.getByLabelText('override-ci-command *')).toHaveAttribute(
      'type',
      'text',
    );
    expect(screen.getByLabelText('retries *')).toHaveAttribute(
      'type',
      'number',
    );
    // Radix Switch renders as a button with role="switch".
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('disables submit until the required text field is filled, then submits every required value', () => {
    const onSubmit = vi.fn<(values: Record<string, unknown>) => void>();
    render(
      <ParamsDialog
        element={WITH_REQUIRED}
        onSubmit={onSubmit}
        onCancel={vi.fn<() => void>()}
      />,
    );

    // Required integer/boolean fields already start with a valid (if empty)
    // value -- 0/false -- so only the required *text* field gates submit.
    const submit = screen.getByRole('button', { name: /^add$/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('retries *'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('switch'));
    expect(submit).toBeDisabled(); // still missing the required text field

    fireEvent.change(screen.getByLabelText('override-ci-command *'), {
      target: { value: 'npm ci' },
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({
      'override-ci-command': 'npm ci',
      retries: 3,
      verbose: true,
    });
  });

  it('calls onCancel when the dialog is dismissed', () => {
    const onCancel = vi.fn<() => void>();
    render(
      <ParamsDialog
        element={WITH_REQUIRED}
        onSubmit={vi.fn<(values: Record<string, unknown>) => void>()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
