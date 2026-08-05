import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import { resetProjectContextStoreForTests } from '~/state/projectContextStore';

import {
  ProjectIdentity,
  slugProvenance,
  unreadableBindingTooltip,
} from './ProjectIdentity';

vi.mock('~/lib/rpc/client', () => ({
  getProjectContext: vi.fn<() => void>(),
  getContextVariables: vi.fn<() => void>(),
}));

const META: rpcClient.Meta = {
  version: 'test',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  // What the host derives from the CLI-injected environment: normalised to
  // CircleCI's canonical short VCS spelling since issue #182.
  projectSlug: 'gh/acme/web',
  hasToken: true,
  host: 'https://circleci.com',
  cwd: '/repo',
  csrfToken: 'test-csrf-token',
  projectWebUrl: 'https://app.circleci.com/projects/gh/acme/web',
  // The ordinary case (issue #198): no `.circleci/info.yml`, so the identity
  // comes from the CLI-injected environment. Never an error -- most checkouts
  // have never been linked.
  projectSlugSource: 'environment',
  projectBinding: {
    status: 'absent',
    path: '/repo/.circleci/info.yml',
    description:
      'Records which CircleCI project this checkout is bound to, written by `circleci project link`.',
  },
};

function setMeta(overrides: Partial<rpcClient.Meta> = {}) {
  useAppStore.setState({ meta: { ...META, ...overrides } });
}

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
      webUrl: 'https://app.circleci.com/projects/gh/acme/web',
    },
    contexts: [],
    projectVariables: [],
    ...overrides,
  };
}

/** Flushes the store's in-flight load, so no state update lands outside `act`. */
async function flushLoad() {
  await waitFor(() =>
    expect(rpcClient.getProjectContext).toHaveBeenCalledTimes(1),
  );
}

describe('ProjectIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectContextStoreForTests();
    useAppStore.setState({ meta: null });
  });

  it('renders nothing before the host meta has loaded', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    render(<ProjectIdentity />);

    expect(screen.queryByTestId('project-identity')).not.toBeInTheDocument();
    await flushLoad();
    expect(screen.queryByTestId('project-identity')).not.toBeInTheDocument();
  });

  it('shows the slug immediately, without waiting for CircleCI', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    setMeta();
    render(<ProjectIdentity />);

    // The environment's own spelling, before the project record arrives --
    // this element must never be a spinner in the top bar.
    expect(screen.getByRole('link', { name: 'acme/web' })).toBeInTheDocument();
    await flushLoad();
  });

  it('upgrades to CircleCI’s own organization name once the lookup succeeds', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    setMeta();
    render(<ProjectIdentity />);

    const link = await screen.findByRole('link', { name: 'Acme Corp/web' });
    expect(link).toHaveAttribute(
      'href',
      'https://app.circleci.com/projects/gh/acme/web',
    );
    // Deep-linking out opens the web UI rather than navigating this
    // single-page tool away from an unsaved config.
    expect(link).toHaveAttribute('target', '_blank');

    // A confirmed project needs no badge; the absence of one is the signal.
    expect(screen.queryByText(/unverified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown to circleci/i)).not.toBeInTheDocument();
  });

  /**
   * Issue #149's central requirement: these two must not render identically.
   */
  it('says plainly that this is not a CircleCI project when no slug was injected', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason: 'This config is not associated with a CircleCI project.',
      contexts: [],
      projectVariables: [],
    });
    setMeta({ projectSlug: '', projectWebUrl: undefined });
    render(<ProjectIdentity />);

    expect(screen.getByText('Not a CircleCI project')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/unverified/i)).not.toBeInTheDocument();

    // Still that, and only that, once the host has answered.
    await flushLoad();
    expect(screen.getByText('Not a CircleCI project')).toBeInTheDocument();
  });

  it('marks the identity unverified when CircleCI could not be reached', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: undefined,
        warnings: [
          {
            kind: 'project',
            headline: 'This project’s details could not be loaded.',
            detail:
              'Looking up gh/acme/web failed: this host could not reach the CircleCI API (network error).',
          },
        ],
      }),
    );
    setMeta();
    render(<ProjectIdentity />);

    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    // The identity itself is still shown -- it is what the checkout claims.
    expect(screen.getByRole('link', { name: 'acme/web' })).toBeInTheDocument();
    expect(screen.queryByText(/unknown to circleci/i)).not.toBeInTheDocument();
  });

  it('marks the identity unknown to CircleCI on a 404, which is a different thing', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: undefined,
        warnings: [
          {
            kind: 'project',
            headline:
              'No CircleCI project matches gh/example-org/flakey-todo-list.',
            detail:
              'The CircleCI API returned HTTP 404 for that project slug. Most often that means this repository has not been set up on CircleCI.',
          },
        ],
      }),
    );
    setMeta();
    render(<ProjectIdentity />);

    expect(await screen.findByText('Unknown to CircleCI')).toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('is unverified, not confirmed, with no token at all', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason: 'No CircleCI API token is available.',
      contexts: [],
      projectVariables: [],
    });
    setMeta({ hasToken: false });
    render(<ProjectIdentity />);

    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'acme/web' })).toBeInTheDocument();
  });

  it('renders plain text, not a broken link, when the host could not build a URL', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: {
          ...readyResponse().project!,
          slug: 'circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
          webUrl: undefined,
        },
      }),
    );
    // A GitLab / GitHub App project: addressed by ID in the web UI, so the host
    // deliberately sends no URL.
    setMeta({ projectSlug: 'circleci/acme/web', projectWebUrl: undefined });
    render(<ProjectIdentity />);

    await flushLoad();
    expect(screen.getByText('Acme Corp/web')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  /**
   * Issue #182. The environment's link and CircleCI's link can disagree, and
   * CircleCI's must win -- including when CircleCI's answer is "there is no
   * name-addressed page for this project", which is what a GitHub App or GitLab
   * project's `circleci/<org-id>/<project-id>` slug means. Falling back to the
   * environment-derived URL there would hand the user a confident link to a page
   * shaped for a different kind of project.
   */
  it('prefers CircleCI’s own link over the environment’s once the record arrives', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: {
          ...readyResponse().project!,
          slug: 'gh/Acme/Web',
          webUrl: 'https://app.circleci.com/projects/gh/Acme/Web',
        },
      }),
    );
    // The host's environment-derived URL differs in case, as a stand-in for the
    // more general fact that it is a guess and the record is not.
    setMeta();
    render(<ProjectIdentity />);

    const link = await screen.findByRole('link', { name: 'Acme Corp/web' });
    expect(link).toHaveAttribute(
      'href',
      'https://app.circleci.com/projects/gh/Acme/Web',
    );
  });

  it('drops the environment’s link entirely when the record has none', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: {
          ...readyResponse().project!,
          slug: 'circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
          webUrl: undefined,
        },
      }),
    );
    // `meta` still carries a perfectly well-formed name-addressed URL, built
    // from an injected VCS type that does not describe how this project is
    // addressed. It must not be used.
    setMeta();
    render(<ProjectIdentity />);

    expect(await screen.findByText('Acme Corp/web')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  /**
   * Issue #198. The identity now has two possible sources, and which one it came
   * from is not decoration: a recorded binding is what the checkout itself says,
   * while a CLI-derived slug is an inference from a git remote that a repository
   * rename silently invalidates.
   */
  describe('where the identity came from (issue #198)', () => {
    const linkedBinding = {
      status: 'present' as const,
      path: '/repo/.circleci/info.yml',
      slug: 'gh/example-org/flaky-todo-list',
      description: 'test',
    };

    it('names the recorded binding as the source', () => {
      // Asserted through the exported helper rather than the rendered tooltip:
      // Radix mounts tooltip content on hover, so no test in this file reads it
      // from the DOM.
      const provenance = slugProvenance({
        ...META,
        projectSlug: 'gh/example-org/flaky-todo-list',
        projectSlugSource: 'binding',
        projectBinding: linkedBinding,
      });

      expect(provenance).toContain('/repo/.circleci/info.yml');
      expect(provenance).toContain('circleci project link');
    });

    it('reports a binding that contradicts the CLI, naming both', () => {
      const provenance = slugProvenance({
        ...META,
        projectSlug: 'gh/example-org/flaky-todo-list',
        projectSlugSource: 'binding',
        projectBinding: {
          ...linkedBinding,
          disagreesWithEnvironment: true,
          environmentSlug: 'gh/example-org/flakey-todo-list',
        },
      });

      // Both names, and which of them is preferred and why. The binding wins;
      // saying so is what turns a stale remote into a lead rather than a
      // mystery.
      expect(provenance).toContain('gh/example-org/flakey-todo-list');
      expect(provenance).toContain('survives a repository rename');
      expect(provenance).toContain('out of date');
    });

    it('says a CLI-derived slug has no binding behind it', () => {
      expect(slugProvenance(META)).toContain(
        'records no CircleCI project binding of its own',
      );
    });

    it('mentions an unusable binding even when the environment supplied a slug', () => {
      const provenance = slugProvenance({
        ...META,
        projectSlugSource: 'environment',
        projectBinding: {
          status: 'malformed',
          path: '/repo/.circleci/info.yml',
          problem: 'The file is not parseable as YAML.',
          description: 'test',
        },
      });

      expect(provenance).toContain('/repo/.circleci/info.yml');
      expect(provenance).toContain('not parseable as YAML');
    });

    it('says nothing at all when there is no slug to explain', () => {
      expect(
        slugProvenance({
          ...META,
          projectSlug: '',
          projectSlugSource: undefined,
        }),
      ).toBe('');
    });
  });

  /**
   * The state that had to split. "Nothing names a project" is calm and ordinary;
   * "the file that names the project could not be read" is neither, and rendering
   * the second as the first would be a silent fallback dressed as success.
   */
  it('distinguishes an unreadable binding from not being a CircleCI project', async () => {
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason: 'could not read the binding',
      contexts: [],
      projectVariables: [],
    });
    setMeta({
      projectSlug: '',
      projectSlugSource: undefined,
      projectWebUrl: undefined,
      projectBinding: {
        status: 'malformed',
        path: '/repo/.circleci/info.yml',
        problem: 'The file is not parseable as YAML.',
        description: 'test',
      },
    });
    render(<ProjectIdentity />);

    expect(screen.getByText('Project binding unreadable')).toBeInTheDocument();
    expect(
      screen.queryByText('Not a CircleCI project'),
    ).not.toBeInTheDocument();

    // The host's own words for what is wrong, and the reassurance that nothing
    // touched the file. Asserted on the wording helper, since Radix mounts
    // tooltip content on hover.
    const tooltip = unreadableBindingTooltip({
      status: 'malformed',
      path: '/repo/.circleci/info.yml',
      problem: 'The file is not parseable as YAML.',
      description: 'test',
    });
    expect(tooltip).toContain('/repo/.circleci/info.yml');
    expect(tooltip).toContain('not parseable as YAML');
    expect(tooltip).toContain('never changes it');

    await flushLoad();
    expect(screen.getByText('Project binding unreadable')).toBeInTheDocument();
  });
});
