import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePolicyStore, type PolicyDecision } from '~/state/policyStore';

import { describePolicyBadge, PolicyBadge } from './PolicyBadge';

const TEXT = 'version: 2.1\n';

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    status: 'PASS',
    enabledRules: ['use_official_docker_image'],
    hardFailures: [],
    softFailures: [],
    orgSlug: 'gh/acme',
    policyContext: 'config',
    metadataSent: [],
    // Steady state unless a test is specifically about issue #25's caveat --
    // see the 'compiledConfigIncluded' describe block below.
    compiledConfigIncluded: true,
    ...overrides,
  };
}

describe('PolicyBadge', () => {
  beforeEach(() => {
    usePolicyStore.setState({
      state: 'idle',
      reason: null,
      decision: null,
      checkedText: null,
      pendingText: null,
    });
  });

  it('says a parse error means the engine was never asked, before anything else', () => {
    // Even with a decision left over from before the parse error appeared,
    // "unchecked because it doesn't parse" must win -- the file cannot have
    // been sent, whatever a stale decision might otherwise suggest.
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({ status: 'HARD_FAIL' }),
      checkedText: TEXT,
    });
    render(<PolicyBadge text={TEXT} hasParseError />);
    expect(screen.getByText('Policy: unchecked')).toBeInTheDocument();
    expect(screen.queryByText('Policy hard fail')).not.toBeInTheDocument();
  });

  it('says "checking" while a request is in flight', () => {
    usePolicyStore.setState({ state: 'checking' });
    render(<PolicyBadge text={TEXT} hasParseError={false} />);
    expect(screen.getByText('Checking policies…')).toBeInTheDocument();
  });

  it('says "not checked" before anything has run', () => {
    render(<PolicyBadge text={TEXT} hasParseError={false} />);
    expect(screen.getByText('Policy: not checked')).toBeInTheDocument();
  });

  it('says "not checked" -- never anything that reads as a pass -- when the host could not reach a decision', () => {
    usePolicyStore.setState({
      state: 'unavailable',
      reason: 'no CircleCI API token available; a policy check needs a token',
    });
    render(<PolicyBadge text={TEXT} hasParseError={false} />);
    expect(screen.getByText('Policy: not checked')).toBeInTheDocument();
    expect(screen.queryByText('Policy pass')).not.toBeInTheDocument();
  });

  it('demotes a verdict to "out of date" the moment the text differs from what was checked', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({
        status: 'HARD_FAIL',
        hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
      }),
      checkedText: TEXT,
    });
    render(<PolicyBadge text={`${TEXT}# edited\n`} hasParseError={false} />);
    expect(screen.getByText('Policy check out of date')).toBeInTheDocument();
    expect(screen.queryByText('Policy hard fail')).not.toBeInTheDocument();
  });

  describe('the three verdicts render as three different things', () => {
    it('PASS against real rules is a pass', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({ status: 'PASS' }),
        checkedText: TEXT,
      });
      render(<PolicyBadge text={TEXT} hasParseError={false} />);
      expect(screen.getByText('Policy pass')).toBeInTheDocument();
    });

    it('PASS against an empty bundle is "no policies to check", never a pass', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({ status: 'PASS', enabledRules: [] }),
        checkedText: TEXT,
      });
      render(<PolicyBadge text={TEXT} hasParseError={false} />);
      expect(screen.getByText('No policies to check')).toBeInTheDocument();
      expect(screen.queryByText('Policy pass')).not.toBeInTheDocument();
    });

    it('SOFT_FAIL is neither a pass nor a hard fail', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({
          status: 'SOFT_FAIL',
          softFailures: [{ rule: 'r', reason: 'flagged', kind: 'soft' }],
        }),
        checkedText: TEXT,
      });
      render(<PolicyBadge text={TEXT} hasParseError={false} />);
      expect(screen.getByText('Policy soft fail')).toBeInTheDocument();
      expect(screen.queryByText('Policy pass')).not.toBeInTheDocument();
      expect(screen.queryByText('Policy hard fail')).not.toBeInTheDocument();
    });

    it('HARD_FAIL is a hard fail', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({
          status: 'HARD_FAIL',
          hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
        }),
        checkedText: TEXT,
      });
      render(<PolicyBadge text={TEXT} hasParseError={false} />);
      expect(screen.getByText('Policy hard fail')).toBeInTheDocument();
    });

    it('ERROR is not a pass, and is labelled distinctly', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({ status: 'ERROR' }),
        checkedText: TEXT,
      });
      render(<PolicyBadge text={TEXT} hasParseError={false} />);
      expect(screen.getByText('Policy engine error')).toBeInTheDocument();
      expect(screen.queryByText('Policy pass')).not.toBeInTheDocument();
    });
  });

  it('renders a focusable, hoverable trigger -- the owner\'s "hover over and see" ask', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({ status: 'PASS' }),
      checkedText: TEXT,
    });
    render(<PolicyBadge text={TEXT} hasParseError={false} />);
    // Radix only mounts `Tooltip.Content` on hover/focus, so the reliable,
    // non-flaky check (same one `ValidationBadge.test.tsx` uses) is that the
    // trigger itself is present and focusable.
    const trigger = screen.getByText('Policy pass').closest('span[tabindex]');
    expect(trigger).toBeInTheDocument();
  });

  describe('describePolicyBadge (the tooltip prose, pinned directly)', () => {
    it('names the full detail a strip used to spell out, for a real pass', () => {
      const view = describePolicyBadge(
        'decided',
        decision({ status: 'PASS', enabledRules: ['a', 'b'] }),
        false,
        null,
        false,
      );
      expect(view.tooltip).toMatch(
        /evaluated this config against 2 enabled rule/i,
      );
    });

    it('says a PASS from an empty bundle says nothing about the config', () => {
      const view = describePolicyBadge(
        'decided',
        decision({ status: 'PASS', enabledRules: [] }),
        false,
        null,
        false,
      );
      expect(view.tooltip).toMatch(/says nothing about the config/i);
    });

    it('says a soft failure does not block a pipeline', () => {
      const view = describePolicyBadge(
        'decided',
        decision({
          status: 'SOFT_FAIL',
          softFailures: [{ rule: 'r', reason: 'flagged', kind: 'soft' }],
        }),
        false,
        null,
        false,
      );
      expect(view.tooltip).toMatch(/do not block a pipeline/i);
    });

    it('says a hard failure would refuse a pipeline', () => {
      const view = describePolicyBadge(
        'decided',
        decision({
          status: 'HARD_FAIL',
          hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
        }),
        false,
        null,
        false,
      );
      expect(view.tooltip).toMatch(/would refuse to run a pipeline/i);
    });

    it('says an ERROR decision is not a pass', () => {
      const view = describePolicyBadge(
        'decided',
        decision({ status: 'ERROR', decisionReason: 'eval_conflict_error' }),
        false,
        null,
        false,
      );
      expect(view.tooltip).toMatch(/eval_conflict_error/);
      expect(view.tooltip).toMatch(/is not a pass/i);
    });

    it('says "could not check" is not the same as "no violations"', () => {
      const view = describePolicyBadge(
        'unavailable',
        null,
        false,
        'no CircleCI API token available',
        false,
      );
      expect(view.tooltip).toMatch(/not the same as finding no violations/i);
      expect(view.tooltip).toMatch(/no CircleCI API token available/);
    });

    it('says a stale verdict is unknown until the next automatic check', () => {
      const view = describePolicyBadge(
        'decided',
        decision(),
        true,
        null,
        false,
      );
      expect(view.tooltip).toMatch(/runs automatically/i);
      expect(view.tooltip).toMatch(/policy standing is unknown/i);
    });

    it('a parse error pre-empts everything else, even a stale HARD_FAIL', () => {
      const view = describePolicyBadge(
        'decided',
        decision({
          status: 'HARD_FAIL',
          hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
        }),
        true,
        null,
        true,
      );
      expect(view.label).toBe('Policy: unchecked');
      expect(view.tooltip).toMatch(/doesn't parse as YAML/i);
    });

    describe('issue #25: a decision made against the source alone says so', () => {
      it('adds the caveat to a PASS, without changing its label or tone', () => {
        const included = describePolicyBadge(
          'decided',
          decision({ status: 'PASS', compiledConfigIncluded: true }),
          false,
          null,
          false,
        );
        const sourceOnly = describePolicyBadge(
          'decided',
          decision({
            status: 'PASS',
            compiledConfigIncluded: false,
            compiledConfigReason: 'this config did not compile',
          }),
          false,
          null,
          false,
        );

        // The verdict itself -- label, tone -- must not change: a false
        // PASS is not fixed by relabelling it, only by disclosing what it
        // did not check.
        expect(sourceOnly.label).toBe(included.label);
        expect(sourceOnly.tone).toBe(included.tone);
        expect(sourceOnly.tooltip).toMatch(/evaluated the source config only/i);
        expect(sourceOnly.tooltip).toMatch(/this config did not compile/);
        expect(included.tooltip).not.toMatch(
          /evaluated the source config only/i,
        );
      });

      it('adds the same caveat to a HARD_FAIL', () => {
        const view = describePolicyBadge(
          'decided',
          decision({
            status: 'HARD_FAIL',
            hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
            compiledConfigIncluded: false,
          }),
          false,
          null,
          false,
        );
        expect(view.label).toBe('Policy hard fail');
        expect(view.tooltip).toMatch(/evaluated the source config only/i);
        expect(view.tooltip).toMatch(
          /rule written against.*may not have fired/i,
        );
      });
    });
  });
});
