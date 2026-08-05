import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { avatarInitials } from '~/lib/orbs/avatar';

import { OrbAvatar } from './OrbAvatar';

describe('OrbAvatar', () => {
  it('renders the same monogram text avatarInitials computes', () => {
    render(<OrbAvatar name="circleci/slack" />);
    expect(
      screen.getByText(avatarInitials('circleci/slack')),
    ).toBeInTheDocument();
  });

  it('is hidden from assistive tech -- the row already renders the orb name as text', () => {
    render(<OrbAvatar name="circleci/slack" />);
    expect(screen.getByText('CS')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders identically for the same name across two instances (deterministic)', () => {
    render(
      <>
        <OrbAvatar name="cci-labs/act" />
        <OrbAvatar name="cci-labs/act" />
      </>,
    );
    expect(screen.getAllByText('CA')).toHaveLength(2);
  });
});
