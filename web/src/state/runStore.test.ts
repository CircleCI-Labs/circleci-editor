import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '~/lib/rpc/client';
import type { RunAvailabilityResponse, RunResponse } from '~/lib/rpc/client';

import {
  isRunResultStale,
  resetRunStoreForTests,
  runTargetsDefaultBranch,
  useRunStore,
} from './runStore';

vi.mock('~/lib/rpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/rpc/client')>();
  return {
    ...actual,
    getRunAvailability: vi.fn<() => Promise<RunAvailabilityResponse>>(),
    postRun: vi.fn<() => Promise<RunResponse>>(),
  };
});

const rpc = await import('~/lib/rpc/client');

const TEXT = 'version: 2.1\n';

function available(): RunAvailabilityResponse {
  return {
    status: 'available',
    reason: 'ok',
    projectSlug: 'gh/acme/widgets',
    branch: 'topic',
    defaultBranch: 'main',
  };
}

describe('useRunStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunStoreForTests();
    vi.mocked(rpc.getRunAvailability).mockResolvedValue(available());
  });

  it('records a triggered pipeline and the text that ran', async () => {
    vi.mocked(rpc.postRun).mockResolvedValue({
      triggered: true,
      pipelineNumber: 4211,
      pipelineId: 'pipe-1',
      state: 'pending',
      webUrl: 'https://app.circleci.com/pipelines/gh/acme/widgets/4211',
      projectSlug: 'gh/acme/widgets',
      branch: 'topic',
    });

    await useRunStore.getState().trigger(TEXT, 'topic');

    const state = useRunStore.getState();
    expect(state.state).toBe('triggered');
    expect(state.lastRun?.pipelineNumber).toBe(4211);
    // The text is kept so a later edit can demote the result to "not what ran".
    expect(state.lastRun?.ranText).toBe(TEXT);
    expect(rpc.postRun).toHaveBeenCalledWith(TEXT, 'topic');
  });

  it('a refusal is not an error, keeps the host’s words, and re-reads availability', async () => {
    vi.mocked(rpc.postRun).mockResolvedValue({
      triggered: false,
      status: 'organization-disabled',
      reason: 'the organization has not turned it on',
    });

    await useRunStore.getState().trigger(TEXT, 'topic');

    const state = useRunStore.getState();
    expect(state.state).toBe('refused');
    expect(state.refusedStatus).toBe('organization-disabled');
    expect(state.reason).toBe('the organization has not turned it on');
    expect(state.lastRun).toBeNull();
    // A refusal is usually a gate that changed under us, so the precondition
    // report is refreshed rather than left stale.
    expect(rpc.getRunAvailability).toHaveBeenCalled();
  });

  it('a failed request is its own state and keeps any earlier pipeline', async () => {
    vi.mocked(rpc.postRun).mockResolvedValueOnce({
      triggered: true,
      pipelineNumber: 1,
      branch: 'topic',
    });
    await useRunStore.getState().trigger(TEXT, 'topic');
    expect(useRunStore.getState().lastRun?.pipelineNumber).toBe(1);

    vi.mocked(rpc.postRun).mockRejectedValueOnce(
      new ApiError(502, 'gateway timeout'),
    );
    await useRunStore.getState().trigger(TEXT, 'topic');

    const state = useRunStore.getState();
    expect(state.state).toBe('error');
    // The earlier pipeline is real and is still the only record the user has
    // of it, so a later failure must not take the link away.
    expect(state.lastRun?.pipelineNumber).toBe(1);
  });

  // A double-press must not buy two pipelines. There is deliberately no
  // sequence-number discard here: both pipelines would exist, so dropping a
  // response would hide one the user is paying for.
  it('a second trigger while one is in flight does nothing', async () => {
    let release: (value: RunResponse) => void = () => {};
    vi.mocked(rpc.postRun).mockImplementation(
      () =>
        new Promise<RunResponse>((resolve) => {
          release = resolve;
        }),
    );

    const first = useRunStore.getState().trigger(TEXT, 'topic');
    await useRunStore.getState().trigger(TEXT, 'topic');
    expect(rpc.postRun).toHaveBeenCalledTimes(1);

    release({ triggered: true, pipelineNumber: 7, branch: 'topic' });
    await first;
    expect(useRunStore.getState().state).toBe('triggered');
  });

  it('an availability failure is retryable and distinct from a settled "no"', async () => {
    vi.mocked(rpc.getRunAvailability).mockRejectedValue(new Error('offline'));

    await useRunStore.getState().checkAvailability();

    const state = useRunStore.getState();
    expect(state.availabilityState).toBe('error');
    expect(state.availability).toBeNull();
    expect(state.availabilityError).toBe('offline');
  });

  it('reset drops a run result, for a file switch', async () => {
    vi.mocked(rpc.postRun).mockResolvedValue({
      triggered: true,
      pipelineNumber: 4211,
      branch: 'topic',
    });
    await useRunStore.getState().trigger(TEXT, 'topic');

    useRunStore.getState().reset();
    expect(useRunStore.getState().lastRun).toBeNull();
    expect(useRunStore.getState().state).toBe('idle');
  });
});

describe('isRunResultStale', () => {
  const lastRun = {
    pipelineNumber: 1,
    pipelineId: null,
    state: null,
    webUrl: null,
    projectSlug: null,
    branch: null,
    ranText: TEXT,
    configVerified: 'confirmed' as const,
  };

  it('is false with no run at all -- there is nothing to be stale', () => {
    expect(isRunResultStale({ lastRun: null }, TEXT)).toBe(false);
  });

  it('is false while the buffer still matches what ran', () => {
    expect(isRunResultStale({ lastRun }, TEXT)).toBe(false);
  });

  it('is true the moment the buffer differs', () => {
    expect(isRunResultStale({ lastRun }, `${TEXT}# edit\n`)).toBe(true);
  });
});

describe('runTargetsDefaultBranch', () => {
  it('is true only when both branches are known and equal', () => {
    expect(
      runTargetsDefaultBranch({
        status: 'available',
        reason: '',
        branch: 'main',
        defaultBranch: 'main',
      }),
    ).toBe(true);
  });

  it('is false for a different branch', () => {
    expect(
      runTargetsDefaultBranch({
        status: 'available',
        reason: '',
        branch: 'topic',
        defaultBranch: 'main',
      }),
    ).toBe(false);
  });

  // Only ever true on evidence. "We do not know the default branch" is the
  // caller's job to warn about, not this function's to guess at.
  it('is false when the default branch is unknown', () => {
    expect(
      runTargetsDefaultBranch({
        status: 'available',
        reason: '',
        branch: 'main',
      }),
    ).toBe(false);
  });

  it('is false with no availability at all', () => {
    expect(runTargetsDefaultBranch(null)).toBe(false);
  });
});
