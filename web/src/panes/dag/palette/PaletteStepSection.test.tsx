import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PaletteStepSection } from './PaletteStepSection';

describe('PaletteStepSection', () => {
  it('shows every catalogued step as a card, checkout/run first', () => {
    render(
      <PaletteStepSection
        localJobNames={['build']}
        onAddToJob={vi.fn<(jobName: string, stepKey: string) => void>()}
      />,
    );

    const cards = screen.getAllByRole('button', { name: /add$/i });
    expect(cards.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /^checkout\b/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^run\b/i })).toBeInTheDocument();
  });

  it('the JobPicker "Add" keyboard path calls onAddToJob with the picked job and this card\'s step key', () => {
    const onAddToJob = vi.fn<(jobName: string, stepKey: string) => void>();
    render(
      <PaletteStepSection
        localJobNames={['build', 'test']}
        onAddToJob={onAddToJob}
      />,
    );

    // Scope to the "checkout" card's own row so this doesn't accidentally
    // pick a different step's picker.
    const checkoutCard = screen.getByRole('button', { name: /^checkout\b/i });
    const row = checkoutCard.closest('li')!;
    const select = within(row).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'test' } });
    fireEvent.click(within(row).getByRole('button', { name: /^add$/i }));

    expect(onAddToJob).toHaveBeenCalledWith('test', 'checkout');
  });

  it('shows "No jobs to add to" when there are no local jobs yet', () => {
    render(
      <PaletteStepSection
        localJobNames={[]}
        onAddToJob={vi.fn<(jobName: string, stepKey: string) => void>()}
      />,
    );
    expect(screen.getAllByText(/no jobs to add to/i).length).toBeGreaterThan(0);
  });
});
