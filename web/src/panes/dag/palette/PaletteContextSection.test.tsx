import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { resetProjectContextStoreForTests } from '~/state/projectContextStore';

import { PaletteContextSection } from './PaletteContextSection';

vi.mock('~/lib/rpc/client', () => ({
  getProjectContext: vi.fn<() => void>(),
  getContextVariables: vi.fn<() => void>(),
}));

/** A fully-available `GET /api/project-context` response, with fake data throughout. */
function readyResponse(
  overrides: Partial<rpcClient.ProjectContextResponse> = {},
): rpcClient.ProjectContextResponse {
  return {
    available: true,
    projectSlug: 'gh/acme/web',
    contexts: [
      {
        id: 'ctx-1',
        name: 'build-secrets',
        // The settings link the host builds (issue #251). Present here because
        // it is present in every real response the palette will see; the tests
        // that care about its absence override it.
        webUrl:
          'https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1',
      },
      { id: 'ctx-2', name: 'deploy-prod' },
    ],
    projectVariables: [],
    ...overrides,
  };
}

/**
 * A successful `GET /api/project-context/variables` response.
 *
 * `restrictions: []` is the default on purpose, and is not a formality: it is the
 * host's positive statement that the restrictions call succeeded and found none.
 * A fixture that omitted the key would be describing a *failed* check, which is
 * the distinction issue #251 turns on -- and which the "never renders a failed
 * restrictions check as unrestricted" case below overrides it to exercise.
 */
function contextDetail(
  overrides: Partial<rpcClient.ContextVariablesResponse> = {},
): rpcClient.ContextVariablesResponse {
  return {
    available: true,
    contextId: 'ctx-1',
    variables: [],
    usability: 'unrestricted',
    restrictions: [],
    projectIdentified: true,
    ...overrides,
  };
}

function renderSection(entryIds: string[] = ['build', 'deploy']) {
  const onAdd = vi.fn<(entryId: string, contextName: string) => void>();
  render(
    <PaletteContextSection
      workflowEntryIds={entryIds}
      onAddContextToEntry={onAdd}
    />,
  );
  return onAdd;
}

describe('PaletteContextSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectContextStoreForTests();
  });

  it('lists the organization’s contexts once loaded', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    renderSection();

    expect(await screen.findByText('build-secrets')).toBeInTheDocument();
    expect(screen.getByText('deploy-prod')).toBeInTheDocument();
  });

  // The degrade-honestly invariant: an explanation, not an empty list and not a
  // spinner that never resolves.
  it('explains itself with no token, and offers no retry (retrying cannot help)', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason:
        'No CircleCI API token is available, so this host cannot look up contexts.',
      contexts: [],
      projectVariables: [],
    });
    renderSection();

    expect(
      await screen.findByText(/need a CircleCI project and API token/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No CircleCI API token is available/),
    ).toBeInTheDocument();

    // Crucially, not the empty-org message -- that would be a lie.
    expect(
      screen.queryByText(/This organization has no contexts/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it('distinguishes an org that genuinely has no contexts', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({ contexts: [] }),
    );
    renderSection();

    expect(
      await screen.findByText(/This organization has no contexts/i),
    ).toBeInTheDocument();
  });

  it('offers a retry for a transport failure, unlike the no-token case', async () => {
    vi.mocked(rpcClient.getProjectContext).mockRejectedValue(
      new Error('network is down'),
    );
    renderSection();

    expect(await screen.findByText(/network is down/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  /**
   * Issue #150. The owner's complaint was not that the warning was wrong but
   * that it sat beside a complete context list with no way to tell whether it
   * mattered -- so this section shows only warnings about *contexts*, and says
   * what is consequently missing.
   */
  it('surfaces a context-listing failure with its consequences, while still listing what loaded', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        contexts: [{ id: 'ctx-1', name: 'build-secrets' }],
        warnings: [
          {
            kind: 'contexts',
            headline: 'This organization’s contexts could not be listed.',
            detail: 'This token does not have permission (HTTP 403).',
            consequences: ['No contexts are listed.'],
          },
        ],
      }),
    );
    renderSection();

    expect(await screen.findByText('build-secrets')).toBeInTheDocument();
    expect(
      screen.getByText(/contexts could not be listed/),
    ).toBeInTheDocument();
    expect(screen.getByText('No contexts are listed.')).toBeInTheDocument();
  });

  it('does not repeat a failed project lookup here, where it is not about the contexts', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        warnings: [
          {
            kind: 'project',
            headline: 'No CircleCI project matches gh/acme/web.',
            detail: 'The CircleCI API returned HTTP 404 for that project slug.',
            consequences: ['This project’s settings are not shown.'],
          },
        ],
      }),
    );
    renderSection();

    // The contexts loaded, which is this section's whole job; the project
    // warning belongs to the reference pane's Project tab (issue #248) and
    // the top bar.
    expect(await screen.findByText('build-secrets')).toBeInTheDocument();
    expect(
      screen.queryByText(/No CircleCI project matches/),
    ).not.toBeInTheDocument();
  });

  it('never claims an organization has no contexts when the listing itself failed', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        contexts: [],
        warnings: [
          {
            kind: 'contexts',
            headline: 'This organization’s contexts could not be listed.',
            detail: 'The CircleCI API rate-limited this request (HTTP 429).',
          },
        ],
      }),
    );
    renderSection();

    expect(
      await screen.findByText(/contexts could not be listed/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/This organization has no contexts/i),
    ).not.toBeInTheDocument();
  });

  describe('the context detail', () => {
    it('shows variable names with CircleCI’s truncated preview, labelled as a preview', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [
            { name: 'AWS_ROLE', truncatedValue: 'arn:' },
            { name: 'AWS_ROLE_ARN', truncatedValue: 'arn:' },
          ],
          usability: 'unrestricted',
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));

      expect(await screen.findByText('AWS_ROLE')).toBeInTheDocument();
      expect(screen.getByText('AWS_ROLE_ARN')).toBeInTheDocument();
      expect(screen.getAllByText('arn:…')).toHaveLength(2);

      // The honesty requirement, asserted: the UI must say plainly that these
      // are previews and that values are never returned.
      expect(
        screen.getByText(/truncated previews, not values/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/never returned by the CircleCI API, by design/i),
      ).toBeInTheDocument();
    });

    it('says "no preview" rather than showing an empty value', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [{ name: 'NO_PREVIEW', truncatedValue: '' }],
          usability: 'unrestricted',
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(await screen.findByText('no preview')).toBeInTheDocument();
    });

    // The red-pipeline case this feature exists to prevent -- and, since issue
    // #251, the case that must say *which* projects, by name.
    it('warns loudly when the context is restricted to other projects, and names them', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [{ name: 'AWS_ROLE', truncatedValue: 'arn:' }],
          usability: 'other-projects-only',
          restrictionSummary: 'restricted to 2 projects',
          restrictions: [
            { kind: 'project', name: 'circle-banking-app' },
            { kind: 'project', name: 'mobile' },
          ],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));

      expect(await screen.findByText('Not allowed here')).toBeInTheDocument();
      expect(screen.getByText(/fail as unauthorized/i)).toBeInTheDocument();
      expect(screen.getByText(/restricted to 2 projects/)).toBeInTheDocument();
      expect(
        screen.getByText(/Restricted to these projects/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/circle-banking-app/, { exact: false }),
      ).toBeInTheDocument();
      expect(screen.getByText(/mobile/, { exact: false })).toBeInTheDocument();
    });

    it('reports "unknown" honestly for a group restriction it cannot evaluate, and names the group', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [],
          usability: 'unknown',
          restrictionSummary: 'restricted to 1 group',
          restrictions: [{ kind: 'group', name: 'Field Engineering' }],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText(/cannot evaluate before a run/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Restricted to these organization groups/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Field Engineering/, { exact: false }),
      ).toBeInTheDocument();
    });

    // Issue #251: "if a restriction can't be resolved to a name, say what it is
    // rather than showing an opaque ID". The host sends no ID at all, so the only
    // way to fail this is to render nothing -- which would make a restricted
    // context look unrestricted.
    it('says what an unnamed restriction is rather than showing nothing', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'other-projects-only',
          restrictionSummary: 'restricted to 1 project',
          // Real shape: one project restriction in a live organization comes back
          // with `"name": ""`, which the host forwards as an absent name.
          restrictions: [{ kind: 'project' }],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText(/A project this editor cannot name/i),
      ).toBeInTheDocument();
    });

    it('shows an expression restriction verbatim, and counts it as an expression', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'unknown',
          restrictionSummary: 'restricted to 1 expression',
          restrictions: [
            { kind: 'expression', expression: 'pipeline.git.branch == "main"' },
          ],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText('pipeline.git.branch == "main"'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Only when these expressions hold/i),
      ).toBeInTheDocument();
    });

    // Issue #251's hardest requirement: "no restrictions" and "we could not
    // check" must never look alike. They differ by a `null` in the response, and
    // this is the assertion that keeps them apart in the rendering.
    it('never renders a failed restrictions check as "unrestricted"', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'unknown',
          restrictionSummary: '',
          restrictions: null,
          warnings: [
            {
              kind: 'restrictions',
              headline:
                'Whether this context is restricted could not be checked.',
              detail: 'This token does not have permission (HTTP 403).',
            },
          ],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));

      expect(await screen.findByText('Check failed')).toBeInTheDocument();
      expect(
        screen.getByText(/not the same as the context being unrestricted/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Unrestricted')).not.toBeInTheDocument();
    });

    it('distinguishes "we do not know which project this is" from "we cannot evaluate the restriction"', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'unknown',
          restrictionSummary: 'restricted to 1 project',
          restrictions: [{ kind: 'project', name: 'circle-banking-app' }],
          projectIdentified: false,
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText(
          /could not work out which CircleCI project this config belongs to/i,
        ),
      ).toBeInTheDocument();
    });

    it('links the context’s own settings page, where a restriction can actually be changed', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail(),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      const link = await screen.findByRole('link', { name: /settings/i });
      expect(link).toHaveAttribute(
        'href',
        'https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1',
      );
    });

    it('renders no settings link at all when the host could not build one', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({ contexts: [{ id: 'ctx-1', name: 'build-secrets' }] }),
      );
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail(),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      await screen.findByText('Unrestricted');
      expect(
        screen.queryByRole('link', { name: /settings/i }),
      ).not.toBeInTheDocument();
    });

    /**
     * Issue #251 plus PR #255. An unversioned run gets the same contexts a normal
     * build would, and the expression that guards against it is one CircleCI's
     * own team says "you need to know to use". So it is mentioned exactly where
     * it is actionable -- and not mentioned where it is noise.
     */
    it('names pipeline.config_source when this project can run an uncommitted config and nothing guards against it', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({
          settings: {
            dynamicConfig: false,
            unversionedConfig: true,
            oss: false,
            buildForkPrs: false,
            passSecretsToForkPrs: false,
          },
        }),
      );
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'unknown',
          restrictions: [
            { kind: 'expression', expression: 'pipeline.git.branch == "main"' },
          ],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText(/runs from an uncommitted config/i),
      ).toBeInTheDocument();
      expect(screen.getByText('pipeline.config_source')).toBeInTheDocument();
    });

    it('stays quiet about pipeline.config_source when a restriction already mentions it', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({
          settings: {
            dynamicConfig: false,
            unversionedConfig: true,
            oss: false,
            buildForkPrs: false,
            passSecretsToForkPrs: false,
          },
        }),
      );
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          usability: 'unknown',
          restrictions: [
            {
              kind: 'expression',
              expression: 'not (pipeline.config_source starts-with "api")',
            },
          ],
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      await screen.findByText('not (pipeline.config_source starts-with "api")');
      expect(
        screen.queryByText(/runs from an uncommitted config/i),
      ).not.toBeInTheDocument();
    });

    it('stays quiet about pipeline.config_source when this project cannot run an uncommitted config', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail(),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      await screen.findByText('Unrestricted');
      expect(
        screen.queryByText(/runs from an uncommitted config/i),
      ).not.toBeInTheDocument();
    });

    it('notes that an empty context would do nothing', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [],
          usability: 'unrestricted',
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(
        await screen.findByText(/holds no environment variables/i),
      ).toBeInTheDocument();
    });

    // Drag-and-drop must never be the only path to an edit.
    it('offers a keyboard path to add the context to a workflow entry', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [{ name: 'AWS_ROLE', truncatedValue: 'arn:' }],
          usability: 'unrestricted',
        }),
      );
      const onAdd = renderSection(['build', 'deploy']);

      await userEvent.click(await screen.findByText('build-secrets'));
      await userEvent.selectOptions(
        await screen.findByRole('combobox', { name: /job to add to/i }),
        'deploy',
      );
      await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

      expect(onAdd).toHaveBeenCalledWith('deploy', 'build-secrets');
    });

    it('returns to the list, and does not refetch an already-loaded context', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        contextDetail({
          variables: [{ name: 'AWS_ROLE', truncatedValue: 'arn:' }],
          usability: 'unrestricted',
        }),
      );
      renderSection();

      await userEvent.click(await screen.findByText('build-secrets'));
      expect(await screen.findByText('AWS_ROLE')).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole('button', { name: /back to contexts/i }),
      );
      expect(await screen.findByText('deploy-prod')).toBeInTheDocument();

      await userEvent.click(screen.getByText('build-secrets'));
      await waitFor(() =>
        expect(rpcClient.getContextVariables).toHaveBeenCalledTimes(1),
      );
    });
  });

  it('re-reads from CircleCI when refreshed, since contexts are edited elsewhere', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    renderSection();

    await screen.findByText('build-secrets');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() =>
      expect(rpcClient.getProjectContext).toHaveBeenLastCalledWith(true),
    );
  });
});
