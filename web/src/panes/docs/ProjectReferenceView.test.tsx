import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import { resetProjectContextStoreForTests } from '~/state/projectContextStore';

import { ProjectReferenceView } from './ProjectReferenceView';

vi.mock('~/lib/rpc/client', () => ({
  getProjectContext: vi.fn<() => void>(),
  getContextVariables: vi.fn<() => void>(),
}));

const META: rpcClient.Meta = {
  version: 'test',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  projectSlug: 'gh/acme/web',
  hasToken: true,
  host: 'https://circleci.com',
  cwd: '/repo',
  csrfToken: 'test-csrf-token',
  projectWebUrl: 'https://app.circleci.com/projects/gh/acme/web',
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
      organizationName: 'acme',
      organizationSlug: 'gh/acme',
      vcsProvider: 'GitHub',
      defaultBranch: 'trunk',
      webUrl: 'https://app.circleci.com/projects/gh/acme/web',
      settingsUrl: 'https://app.circleci.com/settings/project/gh/acme/web',
    },
    settings: {
      dynamicConfig: true,
      unversionedConfig: true,
      oss: false,
      buildForkPrs: false,
      passSecretsToForkPrs: false,
    },
    contexts: [],
    projectVariables: [{ name: 'DEPLOY_TARGET' }, { name: 'NPM_TOKEN' }],
    ...overrides,
  };
}

/** Flushes the store's in-flight load, so no state update lands outside `act`. */
async function flushLoad() {
  await waitFor(() =>
    expect(rpcClient.getProjectContext).toHaveBeenCalledTimes(1),
  );
}

describe('ProjectReferenceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectContextStoreForTests();
    useAppStore.setState({ meta: null });
  });

  it('shows a spinner before meta has loaded', () => {
    // Never resolves, so the component's own `state === 'loading'` render is
    // what this observes -- not a subsequent transition landing outside `act`.
    vi.mocked(rpcClient.getProjectContext).mockReturnValue(
      new Promise(() => {}),
    );
    render(<ProjectReferenceView />);
    expect(
      screen.getByText(/Loading project information/i),
    ).toBeInTheDocument();
  });

  // Issues #149/#150, restated for this tab: "not a CircleCI project" is a
  // calm, ordinary state, distinct from every kind of failure below it.
  it('says "Not a CircleCI project" when no source names one', async () => {
    setMeta({ projectSlug: '', projectWebUrl: undefined });
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason:
        'This config is not associated with a CircleCI project, so there is no project whose contexts, environment variables or settings could be listed.',
      contexts: [],
      projectVariables: [],
    });
    render(<ProjectReferenceView />);

    expect(
      await screen.findByText('Not a CircleCI project'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/API token/i)).not.toBeInTheDocument();
  });

  // Issue #198's split, preserved here: a binding file that exists and could
  // not be read is not the same calm state as no source naming a project.
  it('says the project binding is unreadable, distinctly from "not a CircleCI project"', async () => {
    setMeta({
      projectSlug: '',
      projectWebUrl: undefined,
      projectBinding: {
        status: 'malformed',
        path: '/repo/.circleci/info.yml',
        description:
          'Records which CircleCI project this checkout is bound to.',
        problem: 'the file is not parseable as YAML',
      },
    });
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason:
        'This checkout records which CircleCI project it belongs to in /repo/.circleci/info.yml, and this host could not use that file: the file is not parseable as YAML.',
      contexts: [],
      projectVariables: [],
    });
    render(<ProjectReferenceView />);

    expect(
      await screen.findByText('Project binding unreadable'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this editor never changes it/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Not a CircleCI project'),
    ).not.toBeInTheDocument();
  });

  // A slug exists but nothing could be asked at all -- no token. Grouped
  // with "unreachable"/"Unverified" (the same judgement the top bar makes
  // for this state via `projectLookup`), and not with "not a CircleCI
  // project", which would be a materially different, calmer claim.
  it('says "Unverified" with the host’s own reason when there is no token', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
      available: false,
      reason: 'No CircleCI API token is available.',
      contexts: [],
      projectVariables: [],
    });
    render(<ProjectReferenceView />);

    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    expect(
      screen.getByText(/No CircleCI API token is available/i),
    ).toBeInTheDocument();
    // Never claims there are no variables -- that would assert a listing
    // that was never attempted.
    expect(
      screen.queryByText(/has no environment variables of its own/i),
    ).not.toBeInTheDocument();
  });

  it('renders the project record, settings and both outbound links when confirmed', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    render(<ProjectReferenceView />);
    await flushLoad();

    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.getByText('gh/acme/web')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('trunk')).toBeInTheDocument();
    expect(screen.getByText('DEPLOY_TARGET')).toBeInTheDocument();
    expect(screen.getByText('NPM_TOKEN')).toBeInTheDocument();
    expect(
      screen.getByText(/does not return project variable values/i),
    ).toBeInTheDocument();

    const openProject = screen.getByRole('link', { name: /open project/i });
    expect(openProject).toHaveAttribute(
      'href',
      'https://app.circleci.com/projects/gh/acme/web',
    );
    const openSettings = screen.getByRole('link', { name: /open settings/i });
    expect(openSettings).toHaveAttribute(
      'href',
      'https://app.circleci.com/settings/project/gh/acme/web',
    );

    // Confirmed: no identity badge at all.
    expect(screen.queryByText('Unknown to CircleCI')).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('renders neither link for an ID-addressed (GitLab/GitHub App) project', async () => {
    setMeta({ projectWebUrl: undefined });
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: {
          name: 'web',
          slug: 'circleci/orgId/projectId',
          organizationName: 'acme',
          organizationSlug: 'circleci/orgId',
          vcsProvider: 'GitLab',
          defaultBranch: 'trunk',
        },
      }),
    );
    render(<ProjectReferenceView />);

    expect(await screen.findByText('trunk')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /open project/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /open settings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/addresses this GitLab project by ID/i),
    ).toBeInTheDocument();
  });

  // Issue #150's case: a 404 reads as "Unknown to CircleCI", never as the
  // calm "not a CircleCI project" state and never as an unlabelled failure.
  it('badges a 404 project lookup as "Unknown to CircleCI" and still shows what did load', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: undefined,
        settings: undefined,
        warnings: [
          {
            kind: 'project',
            headline:
              'No CircleCI project matches gh/example-org/flakey-todo-list.',
            detail: 'The CircleCI API returned HTTP 404 for that project slug.',
            consequences: [
              'This project’s default branch and settings are not shown.',
            ],
          },
        ],
      }),
    );
    render(<ProjectReferenceView />);

    expect(await screen.findByText('Unknown to CircleCI')).toBeInTheDocument();
    expect(
      screen.getByText(
        /No CircleCI project matches gh\/example-org\/flakey-todo-list/,
      ),
    ).toBeInTheDocument();
    // Still doing its job: the variables that did load are shown.
    expect(screen.getByText('DEPLOY_TARGET')).toBeInTheDocument();
  });

  // A permissions or transport failure on the project lookup is a different
  // situation from a 404, and must not share its badge.
  it('badges a non-404 project lookup failure as "Unverified", not "Unknown to CircleCI"', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        project: undefined,
        settings: undefined,
        warnings: [
          {
            kind: 'project',
            headline: 'This project’s details could not be loaded.',
            detail:
              'Looking up gh/acme/web failed: this token does not have permission (HTTP 403).',
          },
        ],
      }),
    );
    render(<ProjectReferenceView />);

    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Unknown to CircleCI')).not.toBeInTheDocument();
    // Shown twice by design: once as the badge's own visible explanation,
    // once in the detailed warning card below it -- see this component's
    // doc comment on why the explanation is never hover-only.
    expect(screen.getAllByText(/HTTP 403/).length).toBeGreaterThan(0);
  });

  it('never claims a project has no variables when the listing itself failed', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        projectVariables: [],
        warnings: [
          {
            kind: 'projectVariables',
            headline:
              'This project’s environment variable names could not be listed.',
            detail: 'This token does not have permission (HTTP 403).',
          },
        ],
      }),
    );
    render(<ProjectReferenceView />);

    expect(
      await screen.findByText(/environment variable names could not be listed/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/has no environment variables of its own/i),
    ).not.toBeInTheDocument();
  });

  it('distinguishes a project that genuinely has no variables', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({ projectVariables: [] }),
    );
    render(<ProjectReferenceView />);

    expect(
      await screen.findByText(/has no environment variables of its own/i),
    ).toBeInTheDocument();
  });

  it('warns that a setup config does nothing while dynamic config is off', async () => {
    setMeta();
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
    render(<ProjectReferenceView />);

    expect(await screen.findByText('disabled')).toBeInTheDocument();
    expect(
      screen.getByText(/only does anything once dynamic config is enabled/i),
    ).toBeInTheDocument();
  });

  it('flags a project that passes secrets to fork PRs', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(
      readyResponse({
        settings: {
          dynamicConfig: true,
          unversionedConfig: true,
          oss: true,
          buildForkPrs: true,
          passSecretsToForkPrs: true,
        },
      }),
    );
    render(<ProjectReferenceView />);

    expect(await screen.findByText('Fork PRs get secrets')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
  });

  // Never even a truncated preview here, unlike a context variable's own
  // detail -- names only, every time this view renders a variable.
  it('never renders a project variable value', async () => {
    setMeta();
    vi.mocked(rpcClient.getProjectContext).mockResolvedValue(readyResponse());
    render(<ProjectReferenceView />);

    expect(await screen.findByText('DEPLOY_TARGET')).toBeInTheDocument();
    expect(screen.queryByText(/truncatedValue/i)).not.toBeInTheDocument();
  });
});
