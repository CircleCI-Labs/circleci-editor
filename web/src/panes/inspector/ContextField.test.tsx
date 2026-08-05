import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { resetProjectContextStoreForTests } from '~/state/projectContextStore';

import { ContextField } from './ContextField';

vi.mock('~/lib/rpc/client', () => ({
  getProjectContext: vi.fn<() => void>(),
  getContextVariables: vi.fn<() => void>(),
}));

function readyResponse(
  overrides: Partial<rpcClient.ProjectContextResponse> = {},
): rpcClient.ProjectContextResponse {
  return {
    available: true,
    projectSlug: 'gh/acme/web',
    contexts: [
      { id: 'ctx-1', name: 'build-secrets' },
      { id: 'ctx-2', name: 'deploy-prod' },
      { id: 'ctx-3', name: 'org-global' },
    ],
    projectVariables: [],
    ...overrides,
  };
}

function renderField(values: string[] = []) {
  const onAdd = vi.fn<(name: string) => void>();
  const onRemove = vi.fn<(name: string) => void>();
  render(<ContextField values={values} onAdd={onAdd} onRemove={onRemove} />);
  return { onAdd, onRemove };
}

/** Flushes the store's in-flight load so no state update lands outside `act`. */
async function flushLoad() {
  await waitFor(() =>
    expect(rpcClient.getProjectContext).toHaveBeenCalledTimes(1),
  );
}

describe('ContextField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectContextStoreForTests();
  });

  it('offers the real context list as you type, and adds the chosen one', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    const { onAdd } = renderField();
    await flushLoad();

    const input = screen.getByRole('combobox', { name: 'Contexts' });
    await userEvent.type(input, 'depl');

    const listbox = screen.getByRole('listbox');
    expect(
      within(listbox).getByRole('option', { name: 'deploy-prod' }),
    ).toBeInTheDocument();
    // Filtered, not just listed.
    expect(
      within(listbox).queryByRole('option', { name: 'build-secrets' }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(listbox).getByRole('option', { name: 'deploy-prod' }),
    );
    expect(onAdd).toHaveBeenCalledWith('deploy-prod');
  });

  /**
   * The requirement that rules out a plain `<select>`: a context that does not
   * exist yet, or one in an organization this token cannot read, must remain
   * writable.
   */
  it('accepts a free-typed name that is not in the list', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    const { onAdd } = renderField();
    await flushLoad();

    const input = screen.getByRole('combobox', { name: 'Contexts' });
    await userEvent.type(input, 'not-created-yet{Enter}');

    expect(onAdd).toHaveBeenCalledWith('not-created-yet');
  });

  it('is fully keyboard operable: arrow to a suggestion, Enter to take it', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    const { onAdd } = renderField();
    await flushLoad();

    const input = screen.getByRole('combobox', { name: 'Contexts' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');

    // The highlight is announced, not merely painted.
    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('deploy-prod');
  });

  it('Escape closes the list without discarding what was typed', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    renderField();
    await flushLoad();

    const input = screen.getByRole('combobox', { name: 'Contexts' });
    await userEvent.type(input, 'deploy');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('deploy');
  });

  it('does not offer a context that is already on this entry', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    renderField(['deploy-prod']);
    await flushLoad();

    await userEvent.click(screen.getByRole('combobox', { name: 'Contexts' }));

    expect(
      screen.queryByRole('option', { name: 'deploy-prod' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'build-secrets' }),
    ).toBeInTheDocument();
  });

  it('removes a context through its own button', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    const { onRemove } = renderField(['deploy-prod']);
    await flushLoad();

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove context deploy-prod' }),
    );
    expect(onRemove).toHaveBeenCalledWith('deploy-prod');
  });

  describe('flagging an unrecognised name', () => {
    it('marks a name that is not in a complete list, without calling it wrong', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField(['deploy-prd']);
      await flushLoad();

      const marker = await screen.findByLabelText(
        'deploy-prd was not found in the fetched context list',
      );
      expect(marker).toBeInTheDocument();
      // Focusable, so the explanation is reachable without a pointer.
      expect(marker).toHaveAttribute('tabindex', '0');
    });

    it('says nothing when the context listing itself failed', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({
          contexts: [],
          warnings: [
            {
              kind: 'contexts',
              headline: 'This organization’s contexts could not be listed.',
              detail: 'This token does not have permission (HTTP 403).',
            },
          ],
        }),
      );
      renderField(['deploy-prod']);
      await flushLoad();

      expect(
        screen.queryByLabelText(/was not found in the fetched context list/),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByText(/could not be read in full/),
      ).toBeInTheDocument();
    });

    it('says nothing with no token, where we genuinely cannot know', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
        available: false,
        reason: 'No CircleCI API token is available.',
        contexts: [],
        projectVariables: [],
      });
      renderField(['deploy-prod']);
      await flushLoad();

      expect(
        screen.queryByLabelText(/was not found in the fetched context list/),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByText(/No CircleCI context list is available/),
      ).toBeInTheDocument();
    });

    it('does not flag a name that is in the list', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField(['deploy-prod']);
      await flushLoad();

      expect(
        screen.queryByLabelText(/was not found in the fetched context list/),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #219's discoverability half. The combobox worked; nothing said so.
   * The owner found the dropdown by accident -- *"Oh wait, there's a
   * dropdown"* -- having read the field as free text, which is only half of
   * what it is.
   */
  describe('discoverability (issue #219)', () => {
    it('names both behaviours in the placeholder even before the list has loaded', () => {
      // Deliberately no `flushLoad`: this is the mid-fetch state, which used to
      // fall back to a bare "context name" and promise neither behaviour. Both
      // are true regardless of what the fetch returns, so the copy no longer
      // depends on it.
      vi.mocked(rpcClient.getProjectContext).mockReturnValue(
        new Promise(() => {}) as never,
      );
      renderField();
      expect(
        screen.getByPlaceholderText('Type to filter, or enter any name'),
      ).toBeInTheDocument();
    });

    it('still names both behaviours when no context list is available at all', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
        available: false,
        reason: 'no token',
        contexts: [],
        projectVariables: [],
      } as never);
      renderField();
      await flushLoad();
      expect(
        screen.getByPlaceholderText('Type to filter, or enter any name'),
      ).toBeInTheDocument();
    });

    it('opens the list from the chevron without typing a character', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField();
      await flushLoad();

      const field = screen.getByRole('combobox');
      expect(field).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // The pointer path that was missing: browse the list without first
      // guessing that typing would produce one.
      const chevron = screen
        .getByRole('combobox')
        .parentElement!.querySelector('button')!;
      await userEvent.click(chevron);

      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      // ...and the next keystroke still lands in the combobox, so the keyboard
      // model is unchanged rather than merely still present.
      expect(screen.getByRole('combobox')).toHaveFocus();
    });

    it('the chevron closes the list again', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField();
      await flushLoad();

      const chevron = screen
        .getByRole('combobox')
        .parentElement!.querySelector('button')!;
      await userEvent.click(chevron);
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      await userEvent.click(chevron);
      await waitFor(() =>
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
      );
    });

    it('adds no tab stop and no duplicate announcement for the chevron', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField();
      await flushLoad();

      // A pointer affordance for something the keyboard already reaches
      // (ArrowDown opens the list). Giving it a tab stop would cost every
      // keyboard user an extra Tab between the field and Add for nothing they
      // did not already have, and announcing it would duplicate the
      // combobox's own `aria-expanded`.
      const chevron = screen
        .getByRole('combobox')
        .parentElement!.querySelector('button')!;
      expect(chevron).toHaveAttribute('tabindex', '-1');
      expect(chevron).toHaveAttribute('aria-hidden', 'true');
    });

    it('ArrowDown still opens the list, unchanged', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      renderField();
      await flushLoad();

      const field = screen.getByRole('combobox');
      field.focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
    });
  });

  it('reuses the store’s fetch rather than issuing its own', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    renderField();
    await flushLoad();

    // A second mount (the user clicks another job) must not refetch.
    renderField();
    await waitFor(() =>
      expect(rpcClient.getProjectContext).toHaveBeenCalledTimes(1),
    );
  });
});
