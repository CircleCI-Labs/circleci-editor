import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('defaults to the secondary variant', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button', { name: 'Click' })).toHaveClass(
      'bg-cc-panel-raised',
    );
  });

  it('renders a real danger variant with its own solid background, not a hand-patched override', () => {
    render(<Button variant="danger">Delete job</Button>);
    const el = screen.getByRole('button', { name: 'Delete job' });
    expect(el).toHaveClass('bg-cc-danger');
    expect(el).toHaveClass('hover:bg-cc-danger-hover');
  });

  it('gives the danger variant AA-legible disabled text (not the too-faint text-cc-text-faint)', () => {
    render(
      <Button variant="danger" disabled>
        Delete job
      </Button>,
    );
    const el = screen.getByRole('button', { name: 'Delete job' });
    expect(el).toBeDisabled();
    expect(el).toHaveClass('disabled:text-cc-text-muted');
    expect(el).not.toHaveClass('disabled:text-cc-text-faint');
  });

  it('gives the primary variant AA-legible disabled text (regression test for the 2.62:1 Save button contrast failure)', () => {
    render(
      <Button variant="primary" disabled>
        Save
      </Button>,
    );
    const el = screen.getByRole('button', { name: 'Save' });
    expect(el).toHaveClass('disabled:text-cc-text-muted');
    expect(el).not.toHaveClass('disabled:text-cc-text-faint');
  });

  it('still supports primary, secondary, and ghost variants', () => {
    render(
      <>
        <Button variant="primary">A</Button>
        <Button variant="secondary">B</Button>
        <Button variant="ghost">C</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'A' })).toHaveClass(
      'bg-cc-accent',
    );
    expect(screen.getByRole('button', { name: 'B' })).toHaveClass(
      'bg-cc-panel-raised',
    );
    expect(screen.getByRole('button', { name: 'C' })).toHaveClass(
      'bg-transparent',
    );
  });
});
