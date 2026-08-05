import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';

import type { RunAvailabilityResponse, RunResponse } from '~/lib/rpc/client';
import { RESTRICTION_PRESENTATION } from '~/lib/contexts/usability';
import { useAppStore } from '~/state/appStore';
import {
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from '~/state/projectContextStore';
import { resetRunStoreForTests, useRunStore } from '~/state/runStore';

import { RunDialog } from './RunDialog';

vi.mock('~/lib/rpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/rpc/client')>();
  return {
    ...actual,
    getRunAvailability: vi.fn<() => Promise<RunAvailabilityResponse>>(),
    postRun: vi.fn<() => Promise<RunResponse>>(),
  };
});

const rpc = await import('~/lib/rpc/client');

const SAVED = 'version: 2.1\njobs: {}\n';

function availability(
  overrides: Partial<RunAvailabilityResponse> = {},
): RunAvailabilityResponse {
  return {
    status: 'available',
    reason: 'this config can be run on CircleCI without committing it',
    projectSlug: 'gh/acme/widgets',
    branch: 'feature/try-it',
    branchSource: 'checkout',
    defaultBranch: 'main',
    ...overrides,
  };
}

function triggered(): RunResponse {
  return {
    triggered: true,
    pipelineId: 'pipe-1',
    pipelineNumber: 4211,
    state: 'pending',
    webUrl: 'https://app.circleci.com/pipelines/gh/acme/widgets/4211',
    projectSlug: 'gh/acme/widgets',
    branch: 'feature/try-it',
  };
}

function renderDialog(
  overrides: Partial<RunAvailabilityResponse> = {},
  app: { text?: string; savedText?: string; isDirty?: boolean } = {},
) {
  const text = app.text ?? SAVED;
  useAppStore.setState({
    text,
    savedText: app.savedText ?? SAVED,
    isDirty: app.isDirty ?? false,
    // The dialog reads contexts from the Document, not the text, so
    // the two have to be kept in step here as the real store keeps them.
    doc: parseDocument(text),
    parseError: null,
  });
  useRunStore.setState({
    availabilityState: 'loaded',
    availability: availability(overrides),
  });
  return render(
    <RunDialog
      open
      onOpenChange={vi.fn<(open: boolean) => void>()}
      filename="config.yml"
    />,
  );
}

describe('RunDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // See RunStrip.test.tsx on why this is a beforeEach and not an afterEach.
    resetRunStoreForTests();
    resetProjectContextStoreForTests();
    vi.mocked(rpc.postRun).mockResolvedValue(triggered());
    vi.mocked(rpc.getRunAvailability).mockResolvedValue(availability());
  });

  it('names the project, the branch, where the branch came from, and which config', () => {
    renderDialog();

    const target = screen.getByTestId('run-target');
    expect(target).toHaveTextContent('gh/acme/widgets');
    expect(target).toHaveTextContent('feature/try-it');
    expect(target).toHaveTextContent(/this checkout’s current branch/i);
  });

  it('says outright that a run costs credits and is visible to the organization', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/costs credits/i);
    expect(dialog).toHaveTextContent(/dashboard/i);
  });

  // CircleCI's security team's own assessment, carried unsoftened. This is the
  // honest cost of the capability and the dialog must not bury it.
  it('carries the security assessment verbatim and names the one mitigation', () => {
    renderDialog();

    expect(screen.getByTestId('run-security-note')).toHaveTextContent(
      /end-run around context restrictions and OIDC claims/i,
    );
    // The mitigation exists but, as the feature's own team put it, "you need to
    // know to use it" -- so the pipeline value is named rather than alluded to.
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /pipeline\.config_source/,
    );
    // Audit attributability, added after the 2023 preview.
    expect(screen.getByRole('dialog')).toHaveTextContent(/audit log/i);
  });

  // The unsaved-changes question the issue calls out: running the buffer and
  // running the file are different things and the user must know which fired.
  it('when the buffer is clean, says the config matches the file on disk', () => {
    renderDialog();
    expect(screen.getByTestId('run-config-source')).toHaveTextContent(
      /matches config\.yml on disk/i,
    );
    expect(screen.queryByTestId('run-diff')).not.toBeInTheDocument();
  });

  it('when the buffer is dirty, says so and shows the diff that will be included', () => {
    renderDialog(
      {},
      { savedText: SAVED, text: `${SAVED}# added\n`, isDirty: true },
    );

    expect(screen.getByTestId('run-config-source')).toHaveTextContent(
      /the version in this editor.*unsaved changes.*not the file on disk/is,
    );
    expect(screen.getByTestId('run-diff')).toBeInTheDocument();
  });

  it('posts the confirmed branch and the buffer text, once', async () => {
    renderDialog(
      {},
      { savedText: SAVED, text: `${SAVED}# added\n`, isDirty: true },
    );

    await userEvent.click(
      screen.getByRole('button', { name: /run on feature\/try-it/i }),
    );

    await waitFor(() => {
      expect(rpc.postRun).toHaveBeenCalledTimes(1);
    });
    expect(rpc.postRun).toHaveBeenCalledWith(
      `${SAVED}# added\n`,
      'feature/try-it',
    );
  });

  it('does nothing until the confirm button is pressed', () => {
    renderDialog();
    expect(rpc.postRun).not.toHaveBeenCalled();
  });

  describe('the default branch', () => {
    it('requires the branch name to be typed before it can be confirmed', async () => {
      renderDialog({ branch: 'main', defaultBranch: 'main' });

      const confirm = screen.getByRole('button', { name: /run on main/i });
      expect(confirm).toBeDisabled();
      expect(screen.getByTestId('run-default-branch-gate')).toHaveTextContent(
        /without going through code review/i,
      );

      await userEvent.type(
        screen.getByLabelText(/type the branch name/i),
        'main',
      );
      expect(confirm).toBeEnabled();
    });

    it('a wrong name does not unlock it', async () => {
      renderDialog({ branch: 'main', defaultBranch: 'main' });

      await userEvent.type(
        screen.getByLabelText(/type the branch name/i),
        'maim',
      );
      expect(
        screen.getByRole('button', { name: /run on main/i }),
      ).toBeDisabled();
      expect(rpc.postRun).not.toHaveBeenCalled();
    });

    it('a non-default branch needs no typing', () => {
      renderDialog({ branch: 'topic', defaultBranch: 'main' });

      expect(
        screen.queryByTestId('run-default-branch-gate'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /run on topic/i }),
      ).toBeEnabled();
    });

    // Absence of evidence is not evidence of absence: an unknown default
    // branch is stated rather than silently treated as "not the default".
    it('says so when it cannot tell which branch is the default', () => {
      renderDialog({ branch: 'topic', defaultBranch: undefined });

      expect(
        screen.getByTestId('run-default-branch-unknown'),
      ).toHaveTextContent(/could not determine which branch/i);
    });
  });

  // The project-binding precedence (info.yml over the environment-derived
  // slug) decides which project runs; this dialog's job is to make sure the
  // surface that spends money is not the one that picked a side in silence.
  // It must name the project the rest of the app is showing.
  it('names both projects when info.yml and the environment disagree', () => {
    renderDialog({
      projectSlug: 'gh/example-org/flaky-todo-list',
      identitySource: 'binding',
      environmentSlug: 'gh/example-org/some-other-repo',
      identityDisagrees: true,
    });

    const warning = screen.getByTestId('run-identity-disagreement');
    // The project that will actually run, and where that came from.
    expect(warning).toHaveTextContent('gh/example-org/flaky-todo-list');
    expect(warning).toHaveTextContent(/info\.yml/);
    // And the one that lost, so the user can tell which they meant.
    expect(warning).toHaveTextContent('gh/example-org/some-other-repo');

    // The target block still names the winning project -- the same one the rest
    // of the editor shows.
    expect(screen.getByTestId('run-target')).toHaveTextContent(
      'gh/example-org/flaky-todo-list',
    );
    // A disagreement is a thing to say, not a refusal.
    expect(
      screen.getByRole('button', { name: /run on feature\/try-it/i }),
    ).toBeEnabled();
  });

  it('shows no disagreement warning when the sources agree', () => {
    renderDialog({ identitySource: 'binding' });
    expect(
      screen.queryByTestId('run-identity-disagreement'),
    ).not.toBeInTheDocument();
  });

  it('warns about dynamic config without refusing the run', () => {
    renderDialog({ dynamicConfig: true });

    expect(screen.getByTestId('run-dynamic-config-warning')).toHaveTextContent(
      /could not confirm that is still enforced/i,
    );
    expect(
      screen.getByRole('button', { name: /run on feature\/try-it/i }),
    ).toBeEnabled();
  });

  it('offers no confirmation when availability is not "available"', () => {
    renderDialog({ status: 'organization-disabled' });
    expect(
      screen.getByRole('button', { name: /run on feature\/try-it/i }),
    ).toBeDisabled();
  });

  // The contexts a config asks for, using the same four-state usability model
  // from issue #105 rather than a second one. The stakes are higher here than
  // in the palette:
  // `other-projects-only` is a config that compiles, starts a pipeline, and
  // then fails when the job asks for the context -- after the money is spent.
  describe('the contexts the config asks for', () => {
    const WITH_CONTEXT = `version: 2.1
workflows:
  build:
    jobs:
      - deploy:
          context: aws-prod
`;

    function renderWithContexts(
      store: Partial<ReturnType<typeof useProjectContextStore.getState>>,
    ) {
      useProjectContextStore.setState(store);
      return renderDialog({}, { text: WITH_CONTEXT, savedText: WITH_CONTEXT });
    }

    it('renders the fetched usability verbatim from the shared table', () => {
      renderWithContexts({
        state: 'ready',
        warnings: [],
        contexts: [{ id: 'ctx-1', name: 'aws-prod' }],
        details: {
          'ctx-1': {
            variables: [],
            usability: 'other-projects-only',
            restrictionSummary: 'restricted to 1 project',
            restrictions: [{ kind: 'project', name: 'some-other-project' }],
            projectIdentified: true,
            warnings: [],
          },
        },
      });

      const list = screen.getByTestId('run-contexts');
      expect(list).toHaveTextContent('aws-prod');
      expect(list).toHaveTextContent(RESTRICTION_PRESENTATION.refused.label);
      expect(list).toHaveTextContent(RESTRICTION_PRESENTATION.refused.note);
    });

    // Issue #251: the higher-stakes half of "unknown was three answers wearing
    // one coat". A restrictions call that failed used to render the sentence
    // about organization groups, here of all places -- a dialog that is about to
    // spend money -- naming a cause that had not been established.
    it('says the check failed, not that a group is involved, when the restrictions could not be read', () => {
      renderWithContexts({
        state: 'ready',
        warnings: [],
        contexts: [{ id: 'ctx-1', name: 'aws-prod' }],
        details: {
          'ctx-1': {
            variables: [],
            usability: 'unknown',
            restrictionSummary: '',
            restrictions: null,
            projectIdentified: true,
            warnings: [
              {
                kind: 'restrictions',
                headline:
                  'Whether this context is restricted could not be checked.',
              },
            ],
          },
        },
      });

      const list = screen.getByTestId('run-contexts');
      expect(list).toHaveTextContent(
        RESTRICTION_PRESENTATION['check-failed'].label,
      );
      expect(list).not.toHaveTextContent(/organization group/i);
    });

    it('says "not checked" for a context whose restrictions were never fetched', () => {
      renderWithContexts({
        state: 'ready',
        warnings: [],
        contexts: [{ id: 'ctx-1', name: 'aws-prod' }],
        details: {},
      });

      const list = screen.getByTestId('run-contexts');
      expect(list).toHaveTextContent(/Not checked/);
      expect(list).toHaveTextContent(/was not checked/i);
    });

    it('claims a context does not exist only when the list is known to be complete', () => {
      renderWithContexts({
        state: 'ready',
        warnings: [],
        contexts: [{ id: 'ctx-9', name: 'something-else' }],
        details: {},
      });

      expect(screen.getByTestId('run-contexts')).toHaveTextContent(/Not found/);
    });

    it('says "unknown" rather than "not found" when there is no complete list', () => {
      // No token, so `contextListCoverage` is not `complete` and this editor
      // has no standing to say a context is missing.
      renderWithContexts({
        state: 'unavailable',
        warnings: [],
        contexts: [],
        details: {},
      });

      const list = screen.getByTestId('run-contexts');
      expect(list).toHaveTextContent(/Unknown/);
      expect(list).not.toHaveTextContent(/Not found/);
    });

    it('renders no context section for a config that asks for none', () => {
      renderDialog();
      expect(screen.queryByTestId('run-contexts')).not.toBeInTheDocument();
    });
  });
});
