import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { InfoHint } from './InfoHint';

describe('InfoHint', () => {
  it('names its subject so the control is identifiable without the glyph', () => {
    render(<InfoHint subject="Kapa" content="Some background." />);
    // Not a bare "More info": a settings pane with several of these has to
    // tell a screen-reader user which one they have landed on.
    expect(
      screen.getByRole('button', { name: 'More about Kapa' }),
    ).toBeInTheDocument();
  });

  it('reveals its content on hover', async () => {
    render(<InfoHint subject="Kapa" content="Indexes the documentation." />);
    await userEvent.hover(screen.getByRole('button'));
    expect(
      await screen.findByText('Indexes the documentation.'),
    ).toBeInTheDocument();
  });

  it('reveals its content on keyboard focus, not just hover', async () => {
    render(<InfoHint subject="Kapa" content="Indexes the documentation." />);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    expect(
      await screen.findByText('Indexes the documentation.'),
    ).toBeInTheDocument();
  });

  it('hides the decorative glyph from assistive technology', () => {
    render(<InfoHint subject="Kapa" content="Background." />);
    // The letter carries no information the accessible name doesn't.
    expect(screen.getByText('i')).toHaveAttribute('aria-hidden', 'true');
  });
});
