import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';

import {
  hasRules,
  isPolicyDecisionStale,
  policyViolations,
  toDecision,
  usePolicyStore,
} from './policyStore';

vi.mock('~/lib/rpc/client', () => ({
  postPolicyDecide: vi.fn<() => void>(),
}));

/** A HARD_FAIL exactly as the live endpoint returns one (see internal/circleci/policy_test.go). */
function hardFailResponse(): rpcClient.PolicyDecisionResponse {
  return {
    available: true,
    source: 'api',
    status: 'HARD_FAIL',
    enabledRules: [
      'check_orb_version',
      'required_jobs_in_workflow',
      'use_official_docker_image',
    ],
    hardFailures: [
      {
        rule: 'required_jobs_in_workflow',
        reason:
          "Job 'security-scan' is enforced by your Security Team but missing from this workflow",
      },
    ],
    softFailures: [
      {
        rule: 'use_official_docker_image',
        reason: 'nginx:latest is not an approved Docker image',
      },
    ],
    orgSlug: 'gh/acme',
    policyContext: 'config',
    metadataSent: ['project_id', 'vcs.branch'],
  };
}

describe('policyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePolicyStore.getState().reset();
  });

  it('starts with no verdict at all', () => {
    const store = usePolicyStore.getState();
    expect(store.state).toBe('idle');
    expect(store.decision).toBeNull();
    expect(store.checkedText).toBeNull();
  });

  it('records a decision and the exact text it was made against', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(hardFailResponse());

    await usePolicyStore.getState().check('version: 2.1\n');

    const store = usePolicyStore.getState();
    expect(store.state).toBe('decided');
    expect(store.decision?.status).toBe('HARD_FAIL');
    expect(store.checkedText).toBe('version: 2.1\n');
    expect(rpcClient.postPolicyDecide).toHaveBeenCalledWith('version: 2.1\n');
  });

  it('keeps hard and soft failures apart, and tags which is which', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(hardFailResponse());
    await usePolicyStore.getState().check('version: 2.1\n');

    const decision = usePolicyStore.getState().decision;
    expect(decision?.hardFailures).toHaveLength(1);
    expect(decision?.softFailures).toHaveLength(1);
    // Blocking ones first: they are what would refuse a pipeline.
    expect(policyViolations(decision ?? null).map((v) => v.kind)).toEqual([
      'hard',
      'soft',
    ]);
  });

  it('treats an unavailable answer as "no verdict", never as a pass', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue({
      available: false,
      source: 'unavailable',
      reason: 'no CircleCI API token available; a policy check needs a token',
    });

    await usePolicyStore.getState().check('version: 2.1\n');

    const store = usePolicyStore.getState();
    expect(store.state).toBe('unavailable');
    expect(store.decision).toBeNull();
    expect(store.reason).toContain('token');
  });

  it('refuses a status it does not model rather than guessing at it', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue({
      available: true,
      source: 'api',
      status: 'SOFT_BLOCK',
      enabledRules: ['whatever'],
    });

    await usePolicyStore.getState().check('version: 2.1\n');

    const store = usePolicyStore.getState();
    expect(store.state).toBe('unavailable');
    expect(store.decision).toBeNull();
  });

  it('drops a stale decision when a re-check fails, rather than leaving it standing', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(hardFailResponse());
    await usePolicyStore.getState().check('version: 2.1\n');
    expect(usePolicyStore.getState().decision).not.toBeNull();

    vi.mocked(rpcClient.postPolicyDecide).mockRejectedValue(
      new Error('could not check this config against your policies'),
    );
    await usePolicyStore.getState().check('version: 2.1\n');

    const store = usePolicyStore.getState();
    expect(store.state).toBe('error');
    expect(store.decision).toBeNull();
    expect(store.reason).toContain('could not check');
  });

  it('ignores a response that a newer check has superseded', async () => {
    // Initialised to a no-op rather than null: the assignment below happens
    // inside a Promise executor, which TypeScript's narrowing cannot see.
    let resolveFirst: (
      value: rpcClient.PolicyDecisionResponse,
    ) => void = () => {};
    vi.mocked(rpcClient.postPolicyDecide).mockImplementationOnce(
      () =>
        new Promise<rpcClient.PolicyDecisionResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = usePolicyStore.getState().check('old\n');

    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValueOnce({
      available: true,
      source: 'api',
      status: 'PASS',
      enabledRules: ['rule'],
    });
    await usePolicyStore.getState().check('new\n');

    resolveFirst({
      available: true,
      source: 'api',
      status: 'HARD_FAIL',
      hardFailures: [{ rule: 'r', reason: 'stale answer' }],
    });
    await first;

    const store = usePolicyStore.getState();
    expect(store.state).toBe('decided');
    expect(store.decision?.status).toBe('PASS');
    expect(store.checkedText).toBe('new\n');
  });

  describe('evaluateInBackground (issue #247)', () => {
    it('checks text with no prior decision', async () => {
      vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(
        hardFailResponse(),
      );

      usePolicyStore.getState().evaluateInBackground('version: 2.1\n');
      // The call is fire-and-forget from a caller's point of view (appStore's
      // debounce does not await it), so give its promise a turn to settle.
      await vi.waitFor(() =>
        expect(usePolicyStore.getState().state).toBe('decided'),
      );
      expect(rpcClient.postPolicyDecide).toHaveBeenCalledTimes(1);
    });

    it('skips text that already has a decision', async () => {
      vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(
        hardFailResponse(),
      );
      await usePolicyStore.getState().check('version: 2.1\n');
      expect(rpcClient.postPolicyDecide).toHaveBeenCalledTimes(1);

      // The debounce settling again on text this store already has a
      // decision for -- e.g. the user typed and then deleted it back to the
      // exact text last checked -- must not spend a second request asking
      // the same question.
      usePolicyStore.getState().evaluateInBackground('version: 2.1\n');
      expect(rpcClient.postPolicyDecide).toHaveBeenCalledTimes(1);
    });

    it('skips text that already has a request in flight', async () => {
      let resolveFirst: (
        value: rpcClient.PolicyDecisionResponse,
      ) => void = () => {};
      vi.mocked(rpcClient.postPolicyDecide).mockImplementationOnce(
        () =>
          new Promise<rpcClient.PolicyDecisionResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      );

      usePolicyStore.getState().evaluateInBackground('version: 2.1\n');
      expect(usePolicyStore.getState().state).toBe('checking');
      expect(usePolicyStore.getState().pendingText).toBe('version: 2.1\n');

      // A second call for the exact same text, while the first is still
      // outstanding, must not fire a second request -- this is the guard
      // against a network call per keystroke-batch the issue asks for.
      usePolicyStore.getState().evaluateInBackground('version: 2.1\n');
      expect(rpcClient.postPolicyDecide).toHaveBeenCalledTimes(1);

      resolveFirst(hardFailResponse());
      await vi.waitFor(() =>
        expect(usePolicyStore.getState().state).toBe('decided'),
      );
    });

    it('does check newer text even while an older check is still in flight', async () => {
      let resolveFirst: (
        value: rpcClient.PolicyDecisionResponse,
      ) => void = () => {};
      vi.mocked(rpcClient.postPolicyDecide).mockImplementationOnce(
        () =>
          new Promise<rpcClient.PolicyDecisionResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      usePolicyStore.getState().evaluateInBackground('old\n');
      expect(usePolicyStore.getState().pendingText).toBe('old\n');

      vi.mocked(rpcClient.postPolicyDecide).mockResolvedValueOnce({
        available: true,
        source: 'api',
        status: 'PASS',
        enabledRules: ['rule'],
      });
      usePolicyStore.getState().evaluateInBackground('new\n');
      await vi.waitFor(() =>
        expect(usePolicyStore.getState().state).toBe('decided'),
      );
      expect(usePolicyStore.getState().checkedText).toBe('new\n');
      expect(rpcClient.postPolicyDecide).toHaveBeenCalledTimes(2);

      // The older, superseded request resolving afterwards must not clobber
      // the newer, already-decided verdict.
      resolveFirst({
        available: true,
        source: 'api',
        status: 'HARD_FAIL',
        hardFailures: [{ rule: 'r', reason: 'stale answer' }],
      });
      expect(usePolicyStore.getState().checkedText).toBe('new\n');
      expect(usePolicyStore.getState().decision?.status).toBe('PASS');
    });
  });

  it('reset drops the verdict, for a file switch', async () => {
    vi.mocked(rpcClient.postPolicyDecide).mockResolvedValue(hardFailResponse());
    await usePolicyStore.getState().check('version: 2.1\n');

    usePolicyStore.getState().reset();

    const store = usePolicyStore.getState();
    expect(store.state).toBe('idle');
    expect(store.decision).toBeNull();
  });
});

describe('toDecision', () => {
  it('never fills in an absent rule list', () => {
    // The live shape for an org with no policies at all.
    const decision = toDecision({
      available: true,
      source: 'api',
      status: 'PASS',
    });
    expect(decision?.enabledRules).toEqual([]);
    expect(hasRules(decision ?? null)).toBe(false);
  });

  it('reports an empty metadata list as empty', () => {
    const decision = toDecision({
      available: true,
      source: 'api',
      status: 'PASS',
      enabledRules: ['r'],
    });
    expect(decision?.metadataSent).toEqual([]);
    expect(hasRules(decision ?? null)).toBe(true);
  });

  describe('compiledConfigIncluded (issue #25)', () => {
    it('carries true through when the host says the compiled config was included', () => {
      const decision = toDecision({
        available: true,
        source: 'api',
        status: 'PASS',
        compiledConfigIncluded: true,
      });
      expect(decision?.compiledConfigIncluded).toBe(true);
      expect(decision?.compiledConfigReason).toBeUndefined();
    });

    it('carries the reason through when the host says it was left out', () => {
      const decision = toDecision({
        available: true,
        source: 'api',
        status: 'HARD_FAIL',
        compiledConfigIncluded: false,
        compiledConfigReason: 'this config did not compile',
      });
      expect(decision?.compiledConfigIncluded).toBe(false);
      expect(decision?.compiledConfigReason).toBe(
        'this config did not compile',
      );
    });

    it('defaults to false -- the safe assumption -- when the host omits the field', () => {
      // Every response the real host sends carries this field (see
      // internal/host/policy.go's own doc comment: it is deliberately not
      // `omitempty`), so this covers a response this build predates or a
      // test fixture that forgot it -- and it must fail closed, not credit
      // a decision with a stronger guarantee than it can prove it has.
      const decision = toDecision({
        available: true,
        source: 'api',
        status: 'PASS',
      });
      expect(decision?.compiledConfigIncluded).toBe(false);
    });
  });
});

describe('isPolicyDecisionStale', () => {
  const decision = toDecision({
    available: true,
    source: 'api',
    status: 'PASS',
    enabledRules: ['r'],
  });

  it('is false when the text is the text that was checked', () => {
    expect(
      isPolicyDecisionStale(
        { decision: decision ?? null, checkedText: 'a\n' },
        'a\n',
      ),
    ).toBe(false);
  });

  it('is true the moment the text differs, whitespace included', () => {
    expect(
      isPolicyDecisionStale(
        { decision: decision ?? null, checkedText: 'a\n' },
        'a\n\n',
      ),
    ).toBe(true);
  });

  it('is false when there is no decision to be stale', () => {
    expect(
      isPolicyDecisionStale({ decision: null, checkedText: null }, 'a\n'),
    ).toBe(false);
  });
});
