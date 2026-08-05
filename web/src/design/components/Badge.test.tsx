import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge, type BadgeTone } from './Badge';

describe('Badge', () => {
  it('defaults to the neutral tone', () => {
    render(<Badge>Coming soon</Badge>);
    expect(screen.getByText('Coming soon')).toHaveClass('text-cc-text-muted');
  });

  const coloredTones: Exclude<BadgeTone, 'neutral'>[] = [
    'info',
    'success',
    'warning',
    'danger',
  ];

  it.each(coloredTones)(
    'renders the %s tone coloured after its own CSS custom property',
    (tone) => {
      render(<Badge tone={tone}>{tone}</Badge>);
      expect(screen.getByText(tone)).toHaveClass(`text-cc-${tone}`);
    },
  );

  it('renders the neutral tone with the shared muted text colour, not a tone-specific one', () => {
    render(<Badge tone="neutral">neutral</Badge>);
    expect(screen.getByText('neutral')).toHaveClass('text-cc-text-muted');
  });

  it('has a distinct info tone, not aliased to neutral', () => {
    render(
      <>
        <Badge tone="neutral">Checking A</Badge>
        <Badge tone="info">Checking B</Badge>
      </>,
    );
    const neutralClass = screen.getByText('Checking A').className;
    const infoClass = screen.getByText('Checking B').className;
    expect(infoClass).not.toBe(neutralClass);
    expect(infoClass).toContain('cc-info');
  });

  it('uses the shared 2xs text-size token instead of an arbitrary pixel value', () => {
    render(<Badge>Saved</Badge>);
    expect(screen.getByText('Saved')).toHaveClass('text-2xs');
  });

  it('merges a caller-provided className', () => {
    render(<Badge className="ml-2">Valid</Badge>);
    expect(screen.getByText('Valid')).toHaveClass('ml-2');
  });
});
