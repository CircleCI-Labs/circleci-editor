import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RunAvailabilityResponse,
  RunAvailabilityStatus,
} from '~/lib/rpc/client';
import { resetRunStoreForTests, useRunStore } from '~/state/runStore';

import { RunControl, RunStrip } from './RunStrip';

vi.mock('~/lib/rpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/rpc/client')>();
  return {
    ...actual,
    getRunAvailability: vi.fn<() => Promise<RunAvailabilityResponse>>(),
    postRun: vi.fn<() => Promise<never>>(),
  };
});

const rpc = await import('~/lib/rpc/client');

const TEXT = 'version: 2.1\njobs: {}\n';

function availability(
  status: RunAvailabilityStatus,
  overrides: Partial<RunAvailabilityResponse> = {},
): RunAvailabilityResponse {
  return {
    status,
    reason: `host prose for ${status}`,
    projectSlug: 'gh/acme/widgets',
    branch: 'feature/try-it',
    branchSource: 'checkout',
    defaultBranch: 'main',
    ...overrides,
  };
}

/**
 * Waits for the mount-time availability read to settle, so no store update
 * lands outside `act`. Same idiom as `ProjectIdentity.test.tsx`'s `flushLoad`.
 */
async function flushAvailability() {
  await waitFor(() => {
    expect(useRunStore.getState().availabilityState).toBe('loaded');
  });
}

function loaded(response: RunAvailabilityResponse) {
  useRunStore.setState({
    availabilityState: 'loaded',
    availability: response,
    availabilityError: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset here rather than in an afterEach: Testing Library's automatic cleanup
  // runs after ours, so resetting the store there would push a state change
  // into components that are still mounted -- outside `act`.
  resetRunStoreForTests();
  vi.mocked(rpc.getRunAvailability).mockResolvedValue(
    availability('available'),
  );
});

/**
 * The steady state lives in the pane header, not in a strip -- this pane's
 * vertical budget is measured and had no room for a third one. See RunStrip's
 * own doc comment for the two measurements that settled it.
 */
describe('RunControl', () => {
  function renderControl(
    response: RunAvailabilityResponse,
    blockedReason?: string,
  ) {
    loaded(response);
    return render(
      <RunControl filename="config.yml" blockedReason={blockedReason} />,
    );
  }

  it('never starts a run on its own: it reads settings and stops there', async () => {
    render(<RunControl filename="config.yml" />);

    await flushAvailability();
    expect(rpc.getRunAvailability).toHaveBeenCalledTimes(1);
    // The whole safety property of this component in one assertion.
    expect(rpc.postRun).not.toHaveBeenCalled();
  });

  it('offers a run when both gates are on, and opening the dialog runs nothing', async () => {
    renderControl(availability('available'));

    const button = screen.getByRole('button', { name: /run this config/i });
    expect(button).toBeEnabled();
    // Issue #290: plain, not the old "Run…" -- the ellipsis was read as
    // truncation, twice, rather than as the "this opens a dialog" convention
    // it was meant to be.
    expect(button).toHaveTextContent('Run uncommitted');

    await userEvent.click(button);
    expect(rpc.postRun).not.toHaveBeenCalled();
  });

  // Issue #194's central degradation requirement. Compacting the steady state
  // into a badge must not cost the six-way distinction, so each state keeps
  // its own label and the host's own words ride verbatim on a tooltip.
  //
  // Issue #290: for every state below except `available`, the badge's own
  // label already explains why nothing is offered ("turned off", "unknown",
  // "unsafe here") -- stacking a second, permanently disabled "Run…" button
  // next to it taught the owner nothing (it read as one confusing unit, and
  // a disabled native button's `title` never even shows on hover or focus).
  // So only the badge is asserted here; `RunControl` renders no run button at
  // all for these states now.
  describe('honest degradation', () => {
    const cases: {
      status: RunAvailabilityStatus;
      label: RegExp;
    }[] = [
      {
        status: 'organization-disabled',
        label: /Run: turned off/i,
      },
      {
        status: 'project-disabled',
        label: /Run: turned off/i,
      },
      { status: 'unknown', label: /Run: unknown/i },
      // The refusal that exists to stop a wrong green.
      { status: 'unroutable', label: /Run: unsafe here/i },
    ];

    for (const { status, label } of cases) {
      it(`${status} gets its own badge, hoverable/focusable for the host's own words, and no run button`, () => {
        renderControl(availability(status));

        const badgeText = screen.getByText(label);
        expect(badgeText).toBeInTheDocument();
        // Radix only mounts `Tooltip.Content` on hover/focus -- the reliable,
        // non-flaky check (same one ValidationBadge.test.tsx/PolicyBadge.test.tsx
        // use) is that the trigger itself is present and focusable, so the
        // host's full reason is reachable without a mouse.
        expect(badgeText.closest('span[tabindex]')).toBeInTheDocument();

        expect(
          screen.queryByRole('button', { name: /run this config/i }),
        ).not.toBeInTheDocument();
      });
    }

    it('available offers an enabled run button', () => {
      renderControl(availability('available'));

      const button = screen.getByRole('button', { name: /run this config/i });
      expect(button).toBeEnabled();
    });

    // "Turned off" and "we could not tell" must never render alike. The badge
    // labels are the compact form of that guarantee.
    it('a settled "off" and an unanswered question have different badges', () => {
      const { unmount } = renderControl(availability('organization-disabled'));
      const off = screen.getByTestId('run-control').textContent;
      unmount();

      renderControl(availability('unknown'));
      expect(screen.getByTestId('run-control').textContent).not.toBe(off);
    });

    // The two states where the feature is not applicable cost nothing at all:
    // the app bar's token badge and ProjectIdentity already report both, and
    // this pane's height is measured.
    for (const status of ['no-token', 'no-project'] as const) {
      it(`${status} renders nothing, because the app bar already says so`, () => {
        renderControl(availability(status));
        expect(screen.queryByTestId('run-control')).not.toBeInTheDocument();
      });
    }

    it('a failed availability read is retryable, and never reads as "off"', async () => {
      useRunStore.setState({
        availabilityState: 'error',
        availability: null,
        availabilityError: 'network down',
      });
      render(<RunControl filename="config.yml" />);

      const badgeText = screen.getByText(/Run: unknown/i);
      expect(badgeText).toBeInTheDocument();
      expect(badgeText.closest('span[tabindex]')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /run this config/i }),
      ).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));
      expect(rpc.getRunAvailability).toHaveBeenCalled();
      await flushAvailability();
    });
  });

  it('a local parse error blocks the run without spending a request, and stays hoverable for why', () => {
    renderControl(availability('available'), 'This file doesn’t parse locally');

    // The badge still says "Can run uncommitted" here -- the block is local
    // to this editor, not a host-reported state -- so the button itself (not
    // the badge) must remain and carry the reason, on a wrapper that stays
    // reachable by hover/focus despite the button being `disabled`.
    const button = screen.getByRole('button', { name: /run this config/i });
    expect(button).toBeDisabled();
    expect(button.closest('span[tabindex]')).toBeInTheDocument();
    expect(rpc.postRun).not.toHaveBeenCalled();
  });
});

/**
 * The strip carries prose, and only once there is prose worth a row: after the
 * user acted, or for the one refusal that has to explain itself.
 */
describe('RunStrip', () => {
  it('renders nothing in the steady state, so the editor keeps its height', () => {
    loaded(availability('available'));
    render(<RunStrip text={TEXT} />);
    expect(screen.queryByTestId('run-strip')).not.toBeInTheDocument();
  });

  it('renders nothing for a settled "off", which the header badge already states', () => {
    loaded(availability('organization-disabled'));
    render(<RunStrip text={TEXT} />);
    expect(screen.queryByTestId('run-strip')).not.toBeInTheDocument();
  });

  // The one refusal that earns a row before the user has done anything: it has
  // to explain why guessing is not an option, or it reads as arbitrary.
  it('explains an unroutable project, and keeps the host’s words behind Why?', async () => {
    loaded(availability('unroutable'));
    render(<RunStrip text={TEXT} />);

    expect(screen.getByTestId('run-unroutable')).toHaveTextContent(
      /report success while testing the committed config/i,
    );

    await userEvent.click(screen.getByRole('button', { name: /why\?/i }));
    expect(screen.getByTestId('run-detail')).toHaveTextContent(
      'host prose for unroutable',
    );
  });

  describe('after a run', () => {
    function withResult(
      overrides: Partial<{
        webUrl: string | null;
        configVerified: 'confirmed' | 'mismatch' | 'unverified';
      }> = {},
    ) {
      loaded(availability('available'));
      useRunStore.setState({
        state: 'triggered',
        lastRun: {
          pipelineNumber: 4211,
          pipelineId: 'pipe-1',
          state: 'pending',
          webUrl: 'https://app.circleci.com/pipelines/gh/acme/widgets/4211',
          projectSlug: 'gh/acme/widgets',
          branch: 'feature/try-it',
          ranText: TEXT,
          configVerified: 'confirmed' as const,
          ...overrides,
        },
      });
    }

    it('deep-links the pipeline and says it is not being followed', () => {
      withResult();
      render(<RunStrip text={TEXT} />);

      expect(
        screen.getByRole('link', { name: /open it in circleci/i }),
      ).toHaveAttribute(
        'href',
        'https://app.circleci.com/pipelines/gh/acme/widgets/4211',
      );
      // No observation UI: the strip says outright that it is not
      // watching, so an absent spinner cannot be read as "still running".
      expect(screen.getByTestId('run-triggered')).toHaveTextContent(
        /not followed from here/i,
      );
    });

    it('renders the pipeline number as text when there is no linkable URL', () => {
      withResult({ webUrl: null });
      render(<RunStrip text={TEXT} />);

      expect(
        screen.queryByRole('link', { name: /open it in circleci/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('run-triggered')).toHaveTextContent(/4211/);
    });

    it('demotes the result to "an earlier version" once the buffer changes', () => {
      withResult();
      render(<RunStrip text={`${TEXT}# edited\n`} />);

      expect(screen.getByTestId('run-triggered')).toHaveTextContent(
        /earlier version/i,
      );
    });

    // The wrong-green case. A pipeline that ran the committed config instead of
    // the editor's must not read as a successful test of the editor's -- the
    // single most important assertion about this feature's output.
    it('says loudly when CircleCI ran the committed config instead of ours', () => {
      withResult({ configVerified: 'mismatch' });
      render(<RunStrip text={TEXT} />);

      const summary = screen.getByTestId('run-triggered');
      expect(summary).toHaveTextContent(/is not running your config/i);
      expect(summary).toHaveTextContent(/committed to/i);
    });

    it('says so when it could not confirm which config the run picked up', () => {
      withResult({ configVerified: 'unverified' });
      render(<RunStrip text={TEXT} />);

      expect(screen.getByTestId('run-triggered')).toHaveTextContent(
        /couldn['’]t confirm it picked up your edits/i,
      );
    });

    it('only claims the run is testing your config when that was verified', () => {
      withResult({ configVerified: 'confirmed' });
      render(<RunStrip text={TEXT} />);

      expect(screen.getByTestId('run-triggered')).toHaveTextContent(
        /running your config/i,
      );
    });

    it('seeds the assistant with a question about the run, and sends nothing', async () => {
      withResult();
      const onAskAssistant = vi.fn<(prompt: string) => void>();
      render(<RunStrip text={TEXT} onAskAssistant={onAskAssistant} />);

      await userEvent.click(
        screen.getByRole('button', { name: /ask the assistant/i }),
      );
      expect(onAskAssistant).toHaveBeenCalledTimes(1);
      expect(onAskAssistant.mock.calls[0]?.[0]).toMatch(/#4211/);
    });

    it('a failed request admits it cannot tell whether a pipeline was created', () => {
      loaded(availability('available'));
      useRunStore.setState({
        state: 'error',
        reason: 'gateway timeout',
        lastRun: null,
      });
      render(<RunStrip text={TEXT} />);

      expect(screen.getByTestId('run-error')).toHaveTextContent(
        /cannot tell.*whether a pipeline was created/i,
      );
    });

    it('a refusal says plainly that no pipeline was started', () => {
      loaded(availability('available'));
      useRunStore.setState({
        state: 'refused',
        reason: 'the organization has not turned it on',
        lastRun: null,
      });
      render(<RunStrip text={TEXT} />);

      expect(screen.getByTestId('run-refused')).toHaveTextContent(
        /No pipeline was started/i,
      );
    });
  });
});
