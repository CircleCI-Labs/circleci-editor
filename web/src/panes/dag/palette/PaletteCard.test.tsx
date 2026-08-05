import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PaletteCard } from './PaletteCard';

describe('PaletteCard', () => {
  it('renders without a docs link by default', () => {
    render(<PaletteCard avatarSeed="Docker" title="Docker" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an optional docs link as a sibling of the card button, not nested inside it (issue #78)', () => {
    render(
      <PaletteCard
        avatarSeed="Docker"
        title="Docker"
        docsLink={{
          label: 'Docker execution environment',
          url: 'https://circleci.com/docs/using-docker/',
        }}
      />,
    );
    const link = screen.getByRole('link');
    const button = screen.getByRole('button');
    // An <a> nested inside a <button> would still satisfy `contains`, so
    // this specifically checks the link is *not* a descendant of the
    // button -- it must be reachable as its own, independent tab stop.
    expect(button.contains(link)).toBe(false);
    expect(link).toHaveAttribute(
      'href',
      'https://circleci.com/docs/using-docker/',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('the card itself is still draggable and clickable with a docs link present', () => {
    const onActivate = vi.fn<() => void>();
    render(
      <PaletteCard
        avatarSeed="Docker"
        title="Docker"
        onActivate={onActivate}
        docsLink={{
          label: 'Docker execution environment',
          url: 'https://circleci.com/docs/using-docker/',
        }}
      />,
    );
    screen.getByRole('button').click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
