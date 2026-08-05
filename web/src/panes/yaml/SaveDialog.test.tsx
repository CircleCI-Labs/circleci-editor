import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '~/state/appStore';

import { SaveDialog } from './SaveDialog';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SaveDialog', () => {
  beforeEach(() => {
    useAppStore.setState({
      savedText: 'a: 1\nb: 2\n',
      text: 'a: 1\nb: 2\n',
      isDirty: false,
      status: 'ready',
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says there are no changes and disables saving when text matches savedText', () => {
    render(<SaveDialog open onOpenChange={() => {}} filename="config.yml" />);

    expect(screen.getByText(/no changes to save/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /save changes/i }),
    ).toBeDisabled();
  });

  it('renders added and removed lines for a changed document', () => {
    useAppStore.setState({
      savedText: 'a: 1\nb: 2\n',
      text: 'a: 10\nb: 2\n',
    });

    render(<SaveDialog open onOpenChange={() => {}} filename="config.yml" />);

    expect(screen.getByText('a: 1')).toBeInTheDocument();
    expect(screen.getByText('a: 10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('confirming Save changes PUTs the current text and closes the dialog', async () => {
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 2\n',
      isDirty: true,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { path: '/repo/.circleci/config.yml', bytes: 5 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const onOpenChange = vi.fn<(open: boolean) => void>();
    const user = userEvent.setup();
    render(
      <SaveDialog open onOpenChange={onOpenChange} filename="config.yml" />,
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    );
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(useAppStore.getState().savedText).toBe('a: 2\n');
  });

  it('Cancel closes without saving', async () => {
    useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 2\n' });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const onOpenChange = vi.fn<(open: boolean) => void>();
    const user = userEvent.setup();
    render(
      <SaveDialog open onOpenChange={onOpenChange} filename="config.yml" />,
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
