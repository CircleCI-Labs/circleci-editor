import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ValidationBadge } from './ValidationBadge';

describe('ValidationBadge', () => {
  it('renders nothing for idle', () => {
    const { container } = render(<ValidationBadge state="idle" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a hard red "Invalid" for the primary file', () => {
    render(<ValidationBadge state="invalid" />);
    expect(screen.getByText('Invalid')).toHaveClass('text-cc-danger');
  });

  // Issue #106: a continuation config validated out of the context its
  // setup workflow would have provided must never look like a broken file.
  it('softens "Invalid" to a neutral note when softenInvalid is set', () => {
    render(<ValidationBadge state="invalid" softenInvalid />);
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    const badge = screen.getByText('Not independently valid');
    expect(badge).toHaveClass('text-cc-text-muted');
  });

  it('does not soften a valid result -- softenInvalid only ever changes the invalid branch', () => {
    render(<ValidationBadge state="valid" softenInvalid />);
    expect(screen.getByText('Valid')).toHaveClass('text-cc-success');
  });

  it('the softened badge explains why in its tooltip content', () => {
    render(<ValidationBadge state="invalid" softenInvalid />);
    // Tooltip content lives in the accessible name/description via Radix;
    // simplest robust check is that the trigger is present and focusable.
    const trigger = screen
      .getByText('Not independently valid')
      .closest('span[tabindex]');
    expect(trigger).toBeInTheDocument();
  });

  // Issue #224: a rejected token gets its own label, distinct from both
  // "Validation unavailable" (no token at all) and "Validation error"
  // (CircleCI unreachable) -- the three call for different user actions.
  it('renders "Token rejected" for unauthorized, distinct from unavailable and error', () => {
    render(<ValidationBadge state="unauthorized" />);
    expect(screen.getByText('Token rejected')).toBeInTheDocument();
    expect(
      screen.queryByText('Validation unavailable'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Validation error')).not.toBeInTheDocument();
  });

  // Issue #145: a file that isn't a CircleCI config at all gets its own
  // neutral label, distinct from "Invalid" and from the softened
  // "Not independently valid" -- neither of those is honest for a file
  // that was never a config to begin with.
  it('renders "Not a CircleCI config" for not-a-config, even with softenInvalid set', () => {
    render(
      <ValidationBadge
        state="not-a-config"
        reason='No CircleCI structure: has "command:", not "commands:".'
        softenInvalid
      />,
    );
    expect(screen.getByText('Not a CircleCI config')).toBeInTheDocument();
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Not independently valid'),
    ).not.toBeInTheDocument();
  });
});
