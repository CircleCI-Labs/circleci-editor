import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';

import {
  contextListCoverage,
  projectLookup,
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from './projectContextStore';

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
    project: {
      name: 'web',
      slug: 'gh/acme/web',
      organizationName: 'Acme Corp',
      organizationSlug: 'gh/acme',
      vcsProvider: 'GitHub',
      defaultBranch: 'trunk',
    },
    contexts: [{ id: 'ctx-1', name: 'build-secrets' }],
    projectVariables: [],
    ...overrides,
  };
}

const PROJECT_404: rpcClient.ProjectContextWarning = {
  kind: 'project',
  headline: 'No CircleCI project matches gh/acme/web.',
  detail:
    'The CircleCI API returned HTTP 404 for that project slug. Most often that means this repository has not been set up on CircleCI.',
};

const CONTEXTS_FORBIDDEN: rpcClient.ProjectContextWarning = {
  kind: 'contexts',
  headline: 'This organization’s contexts could not be listed.',
  detail: 'This token does not have permission (HTTP 403).',
};

describe('projectContextStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectContextStoreForTests();
  });

  it('keeps the host’s structured warnings intact', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({ warnings: [PROJECT_404] }),
    );

    await useProjectContextStore.getState().load();

    const { warnings, state } = useProjectContextStore.getState();
    expect(state).toBe('ready');
    expect(warnings).toEqual([PROJECT_404]);
  });

  /**
   * Issue #152 leans entirely on this: the inspector may only call a typed
   * context name unrecognised when the list it is checking against is the
   * whole list. Everything else -- no token, a partial fetch, a failure -- is
   * "we genuinely don't know", and must stay silent rather than guess.
   */
  describe('contextListCoverage', () => {
    it('is complete when the listing succeeded', () => {
      expect(contextListCoverage({ state: 'ready', warnings: [] })).toBe(
        'complete',
      );
    });

    it('is complete when an unrelated part failed', () => {
      expect(
        contextListCoverage({ state: 'ready', warnings: [PROJECT_404] }),
      ).toBe('complete');
    });

    it('is partial when the context listing itself failed', () => {
      expect(
        contextListCoverage({ state: 'ready', warnings: [CONTEXTS_FORBIDDEN] }),
      ).toBe('partial');
    });

    it('is partial when the owning organization could not be determined', () => {
      expect(
        contextListCoverage({
          state: 'ready',
          warnings: [
            {
              kind: 'organization',
              headline: 'Which organization owns this project is unknown.',
            },
          ],
        }),
      ).toBe('partial');
    });

    it.each(['idle', 'loading', 'unavailable', 'error'] as const)(
      'is unknown in the %s state',
      (state) => {
        expect(contextListCoverage({ state, warnings: [] })).toBe('unknown');
      },
    );
  });

  /**
   * Issue #149: "not a CircleCI project" and "couldn't reach CircleCI" are
   * different states and must not render identically -- which is only possible
   * because issue #150 made a 404 distinguishable from every other failure.
   */
  describe('projectLookup', () => {
    it('is confirmed when CircleCI returned the project record', () => {
      expect(
        projectLookup({
          state: 'ready',
          warnings: [],
          project: readyResponse().project ?? null,
          reason: null,
        }).status,
      ).toBe('confirmed');
    });

    it('is absent for a 404 -- CircleCI has no such project', () => {
      const lookup = projectLookup({
        state: 'ready',
        warnings: [PROJECT_404],
        project: null,
        reason: null,
      });
      expect(lookup.status).toBe('absent');
      expect(lookup.warning).toEqual(PROJECT_404);
    });

    it('is unreachable for any other project failure', () => {
      expect(
        projectLookup({
          state: 'ready',
          warnings: [
            {
              kind: 'project',
              headline: 'This project’s details could not be loaded.',
              detail:
                'Looking up gh/acme/web failed: this host could not reach the CircleCI API (network error).',
            },
          ],
          project: null,
          reason: null,
        }).status,
      ).toBe('unreachable');
    });

    it('is unreachable with no token, carrying the host’s reason', () => {
      const lookup = projectLookup({
        state: 'unavailable',
        warnings: [],
        project: null,
        reason: 'No CircleCI API token is available.',
      });
      expect(lookup.status).toBe('unreachable');
      expect(lookup.reason).toBe('No CircleCI API token is available.');
    });

    it('is unknown while nothing has been fetched', () => {
      expect(
        projectLookup({
          state: 'idle',
          warnings: [],
          project: null,
          reason: null,
        }).status,
      ).toBe('unknown');
    });

    it('ignores a previous load’s warnings once the request itself failed', () => {
      // `error` keeps the last successful load's warnings in state; reporting
      // one of those as this attempt's reason would be its own small lie.
      expect(
        projectLookup({
          state: 'error',
          warnings: [PROJECT_404],
          project: null,
          reason: null,
        }).status,
      ).toBe('unreachable');
    });
  });

  /**
   * Issue #251's central behaviour: adding a context that may not work here
   * *warns* and never blocks.
   *
   * These test the store rather than a rendering because that is where the
   * decision lives -- whether a notice is raised at all, and with what certainty.
   * The banner's own job is only to say it in two voices.
   */
  describe('noteContextAdded', () => {
    function detailResponse(
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

    async function loadThenAdd(
      detail: rpcClient.ContextVariablesResponse,
      contextName = 'build-secrets',
    ) {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({
          contexts: [
            {
              id: 'ctx-1',
              name: 'build-secrets',
              webUrl:
                'https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1',
            },
          ],
        }),
      );
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(detail);
      await useProjectContextStore.getState().load();
      await useProjectContextStore
        .getState()
        .noteContextAdded(contextName, 'deploy');
      return useProjectContextStore.getState().restrictionNotice;
    }

    it('says nothing at all about an unrestricted context', async () => {
      expect(await loadThenAdd(detailResponse())).toBeNull();
    });

    it('says nothing about a context this project is explicitly allowed to use', async () => {
      const notice = await loadThenAdd(
        detailResponse({
          usability: 'allowed',
          restrictions: [{ kind: 'project', name: 'web', thisProject: true }],
        }),
      );
      expect(notice).toBeNull();
    });

    it('warns with certainty when the context is restricted to other projects, and carries the names and the link', async () => {
      const notice = await loadThenAdd(
        detailResponse({
          usability: 'other-projects-only',
          restrictions: [{ kind: 'project', name: 'circle-banking-app' }],
        }),
      );

      expect(notice).not.toBeNull();
      expect(notice?.certainty).toBe('refused');
      expect(notice?.contextName).toBe('build-secrets');
      expect(notice?.entryId).toBe('deploy');
      expect(notice?.restrictions).toEqual([
        { kind: 'project', name: 'circle-banking-app' },
      ]);
      expect(notice?.webUrl).toBe(
        'https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1',
      );
    });

    it('warns without certainty for a restriction it cannot evaluate', async () => {
      const notice = await loadThenAdd(
        detailResponse({
          usability: 'unknown',
          restrictions: [{ kind: 'group', name: 'Field Engineering' }],
        }),
      );
      expect(notice?.certainty).toBe('unevaluable');
    });

    // "No restrictions" and "we could not check" must never look alike -- which
    // starts with them not being the same state here.
    it('warns that the check failed rather than staying silent', async () => {
      const notice = await loadThenAdd(
        detailResponse({
          usability: 'unknown',
          restrictions: null,
          warnings: [
            {
              kind: 'restrictions',
              headline:
                'Whether this context is restricted could not be checked.',
            },
          ],
        }),
      );
      expect(notice?.certainty).toBe('check-failed');
      expect(notice?.restrictions).toEqual([]);
    });

    it('raises nothing for a name this editor has no record of, which the field already flags', async () => {
      const notice = await loadThenAdd(detailResponse(), 'typed-by-hand');
      expect(notice).toBeNull();
      expect(rpcClient.getContextVariables).not.toHaveBeenCalled();
    });

    it('clears a previous notice when the next context added is fine', async () => {
      useProjectContextStore.setState({
        restrictionNotice: {
          contextName: 'stale',
          certainty: 'refused',
          restrictions: [],
        },
      });
      expect(await loadThenAdd(detailResponse())).toBeNull();
    });

    it('reuses an already-fetched detail rather than refetching on every drag', async () => {
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
        readyResponse({ contexts: [{ id: 'ctx-1', name: 'build-secrets' }] }),
      );
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue(
        detailResponse(),
      );
      await useProjectContextStore.getState().load();

      await useProjectContextStore.getState().noteContextAdded('build-secrets');
      await useProjectContextStore.getState().noteContextAdded('build-secrets');

      expect(rpcClient.getContextVariables).toHaveBeenCalledTimes(1);
    });

    it('is dismissible', async () => {
      await loadThenAdd(
        detailResponse({
          usability: 'other-projects-only',
          restrictions: [{ kind: 'project', name: 'other' }],
        }),
      );
      useProjectContextStore.getState().dismissRestrictionNotice();
      expect(useProjectContextStore.getState().restrictionNotice).toBeNull();
    });
  });
});
