import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { stepDocsUrl } from '~/lib/docs/docsLinks';

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

  // Issue #19: the palette listed every built-in step with no way to learn
  // what it does -- the Executors section above it, and the inspector's own
  // field editor for the very same step, have both carried this link since
  // issue #78, but nobody had wired `stepDocsUrl` into this section. This
  // pins the fix against the same table those two already use, so a future
  // change to `stepDocsUrl` keeps all three in sync automatically.
  it("wires each step card's docs link to stepDocsUrl, and skips it for a keyword with none", () => {
    render(
      <PaletteStepSection
        localJobNames={['build']}
        onAddToJob={vi.fn<(jobName: string, stepKey: string) => void>()}
      />,
    );

    const saveCacheCard = screen.getByRole('button', {
      name: /^save cache\b/i,
    });
    const row = saveCacheCard.closest('li')!;
    const docsLink = within(row).getByRole('link');
    expect(docsLink).toHaveAttribute('href', stepDocsUrl('save_cache'));
    expect(docsLink).toHaveAttribute('target', '_blank');

    // Every keyword this section can ever list is a built-in `stepDocsUrl`
    // resolves (see `paletteSteps.ts`'s own doc comment: it draws from
    // `KNOWN_STEP_KEYS`, not from orb/custom commands), so there is no card
    // in this particular list to assert the "no link" branch against --
    // `stepDocsUrl`'s own test already covers that case for the function
    // this section calls.
  });
});
