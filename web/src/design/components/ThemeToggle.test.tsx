import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveTheme, useThemeStore } from '~/state/themeStore';

import { ThemeToggle } from './ThemeToggle';

function resetStoreToDefaults(): void {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  useThemeStore.setState({
    preference: 'system',
    resolvedTheme: resolveTheme('system'),
  });
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  it('is reachable as a labelled group with one button per theme option', () => {
    render(<ThemeToggle />);
    const group = screen.getByRole('group', { name: /colour theme/i });
    for (const label of ['Light', 'Dark', 'System']) {
      expect(
        within(group).getByRole('button', { name: label }),
      ).toBeInTheDocument();
    }
  });

  it('marks the active preference pressed and switches the store on click', () => {
    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(useThemeStore.getState().preference).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking Light/Dark also updates the resolved theme on <html>, for React Flow/CodeMirror to read', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
