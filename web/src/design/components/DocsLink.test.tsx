import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocsLink } from './DocsLink';

describe('DocsLink', () => {
  it('opens externally: target=_blank and rel=noreferrer (issue #78)', () => {
    render(
      <DocsLink
        label="Docker execution environment"
        url="https://circleci.com/docs/using-docker/"
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://circleci.com/docs/using-docker/',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('icon-only (no children) carries its accessible name via aria-label, mentioning it opens a new tab', () => {
    render(
      <DocsLink label="Contexts" url="https://circleci.com/docs/contexts/" />,
    );
    const link = screen.getByRole('link', { name: /Contexts.*new tab/i });
    expect(link).toBeVisible();
  });

  it('with visible children, the accessible name comes from the children instead of a redundant aria-label', () => {
    render(
      <DocsLink
        label="Orbs introduction"
        url="https://circleci.com/docs/orb-intro/"
      >
        Docs
      </DocsLink>,
    );
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).not.toHaveAttribute('aria-label');
    expect(link).toHaveAttribute('title', 'Orbs introduction');
  });

  it('merges a caller-provided className', () => {
    render(
      <DocsLink
        label="Contexts"
        url="https://circleci.com/docs/contexts/"
        className="ml-1"
      />,
    );
    expect(screen.getByRole('link')).toHaveClass('ml-1');
  });
});
