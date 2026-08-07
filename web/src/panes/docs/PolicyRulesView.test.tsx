import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';
import { useAiStore } from '~/state/aiStore';
import { useAppStore } from '~/state/appStore';
import { usePolicyStore, type PolicyDecision } from '~/state/policyStore';

import { PolicyRulesView } from './PolicyRulesView';

const CONFIG = 'version: 2.1\n';

/** A config with a real job, so a violation naming it resolves a location. */
const CONFIG_WITH_JOB = `version: 2.1
jobs:
  security-scan:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
workflows:
  main:
    jobs:
      - security-scan
`;

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    status: 'SOFT_FAIL',
    enabledRules: ['use_official_docker_image', 'check_orb_version'],
    hardFailures: [],
    softFailures: [
      {
        rule: 'use_official_docker_image',
        reason: 'nginx:latest is not an approved Docker image',
        kind: 'soft',
      },
    ],
    orgSlug: 'gh/acme',
    policyContext: 'config',
    metadataSent: [],
    // Steady state unless a test is specifically about issue #25's notice --
    // see the describe block below.
    compiledConfigIncluded: true,
    ...overrides,
  };
}

describe('PolicyRulesView', () => {
  beforeEach(() => {
    useAppStore.setState({ text: CONFIG });
    usePolicyStore.setState({
      state: 'idle',
      reason: null,
      decision: null,
      checkedText: null,
    });
  });

  it('does not present "nothing yet" as "no policies"', () => {
    render(<PolicyRulesView />);
    expect(
      screen.getByText(/does not mean your organization has no policies/i),
    ).toBeInTheDocument();
  });

  it('lists the rules that ran, and which of them fired', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision(),
      checkedText: CONFIG,
    });
    render(<PolicyRulesView />);

    expect(screen.getByText('use_official_docker_image')).toBeInTheDocument();
    expect(screen.getByText('Non-blocking')).toBeInTheDocument();
    expect(
      screen.getByText('nginx:latest is not an approved Docker image'),
    ).toBeInTheDocument();
    // The rule that ran and stayed silent is listed as such, rather than
    // being omitted -- "these were applied" is the actionable part.
    expect(screen.getByText('check_orb_version')).toBeInTheDocument();
    expect(screen.getByText('Did not fire')).toBeInTheDocument();
  });

  it('says nothing extra when the compiled config was included (issue #25)', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({ compiledConfigIncluded: true }),
      checkedText: CONFIG,
    });
    render(<PolicyRulesView />);
    expect(screen.queryByTestId('policy-compiled-unavailable')).toBeNull();
  });

  it('discloses a source-only check, and why, rather than letting a silent rule imply it (issue #25)', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({
        compiledConfigIncluded: false,
        compiledConfigReason: 'this config did not compile',
      }),
      checkedText: CONFIG,
    });
    render(<PolicyRulesView />);
    const notice = screen.getByTestId('policy-compiled-unavailable');
    expect(notice).toHaveTextContent(/evaluated the source config only/i);
    expect(notice).toHaveTextContent('this config did not compile');
  });

  it('says an empty rule list means nothing was checked', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({
        status: 'PASS',
        enabledRules: [],
        softFailures: [],
      }),
      checkedText: CONFIG,
    });
    render(<PolicyRulesView />);
    expect(
      screen.getByText(/decision says nothing about this config/i),
    ).toBeInTheDocument();
  });

  it('reports an unavailable check as unknown, not empty', () => {
    usePolicyStore.setState({
      state: 'unavailable',
      reason: 'no CircleCI API token available; a policy check needs a token',
    });
    render(<PolicyRulesView />);
    expect(screen.getByTestId('policy-rules-unavailable')).toHaveTextContent(
      /unknown, not empty/i,
    );
  });

  it('still reports a violation whose rule was not listed as enabled', () => {
    usePolicyStore.setState({
      state: 'decided',
      decision: decision({
        enabledRules: ['check_orb_version'],
      }),
      checkedText: CONFIG,
    });
    render(<PolicyRulesView />);
    expect(
      screen.getByText(/Also reported, without being listed as enabled/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nginx:latest is not an approved Docker image/),
    ).toBeInTheDocument();
  });

  it('states that this editor cannot write policies', () => {
    render(<PolicyRulesView />);
    expect(screen.getByText(/policy push/)).toBeInTheDocument();
    expect(screen.getByText(/only ever/i)).toBeInTheDocument();
  });

  // Issue #247 item 3/5: establish honestly that the Rego source is not
  // fetched, rather than showing an empty panel or working around the 403.
  it('says the full policy source is not fetched, and why', () => {
    render(<PolicyRulesView />);
    expect(screen.getByText(/circleci policy fetch/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 403/)).toBeInTheDocument();
    expect(screen.getByText(/ask an organization admin/i)).toBeInTheDocument();
  });

  // Issue #247 item 4: ties this tab to the vendored guide page, through the
  // same cross-tab mechanism EntryDetail already uses -- no second
  // navigation mechanism.
  it('offers to open the vendored config-policies guide, via the shared callback', async () => {
    const onOpenGuideSection =
      vi.fn<(guideId: string, sectionId: string) => void>();
    render(<PolicyRulesView onOpenGuideSection={onOpenGuideSection} />);

    await userEvent.click(
      screen.getByRole('button', { name: /what are config policies/i }),
    );
    expect(onOpenGuideSection).toHaveBeenCalledWith(
      'config-policies',
      'introduction',
    );
  });

  it('offers no such link when the callback is not supplied', () => {
    render(<PolicyRulesView />);
    expect(
      screen.queryByRole('button', { name: /what are config policies/i }),
    ).not.toBeInTheDocument();
  });

  describe('a violation shown in full (issue #247 items 3 and 6)', () => {
    beforeEach(() => {
      const { doc } = parseConfig(CONFIG_WITH_JOB);
      useAppStore.setState({
        doc,
        text: CONFIG_WITH_JOB,
        configPath: '/repo/.circleci/config.yml',
      });
      useAiStore.setState({
        statusState: 'ready',
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            configured: true,
            model: 'm',
            source: 'store',
            envVar: 'CIRCLECI_EDITOR_AI_KEY_ANTHROPIC',
            storedKeyShadowed: false,
          },
        ],
        selectedProvider: 'anthropic',
      });
    });

    it('shows the resolved line for a violation naming a real job', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({
          status: 'HARD_FAIL',
          hardFailures: [
            {
              rule: 'required_jobs_in_workflow',
              reason: "Job 'security-scan' must not run before the scan",
              kind: 'hard',
            },
          ],
          softFailures: [],
        }),
        checkedText: CONFIG_WITH_JOB,
      });
      render(<PolicyRulesView />);
      expect(screen.getByText(/Location: line \d+/)).toBeInTheDocument();
      expect(screen.queryByText(/Location unknown/)).not.toBeInTheDocument();
    });

    it('says the location is unknown rather than guessing one', () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({
          status: 'SOFT_FAIL',
          softFailures: [
            {
              rule: 'r',
              reason: 'Please only use approved images',
              kind: 'soft',
            },
          ],
        }),
        checkedText: CONFIG_WITH_JOB,
      });
      render(<PolicyRulesView />);
      expect(screen.getByText(/Location unknown/)).toBeInTheDocument();
    });

    it('"Fix with AI" seeds the composer with the rule and its reason', async () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: decision({
          status: 'HARD_FAIL',
          hardFailures: [
            {
              rule: 'required_jobs_in_workflow',
              reason: "Job 'security-scan' must not run before the scan",
              kind: 'hard',
            },
          ],
          softFailures: [],
        }),
        checkedText: CONFIG_WITH_JOB,
      });
      render(<PolicyRulesView />);

      await userEvent.click(
        screen.getByRole('button', { name: 'Fix with AI' }),
      );

      const promptSeed = useAiStore.getState().promptSeed;
      expect(promptSeed?.text).toContain('required_jobs_in_workflow');
      expect(promptSeed?.text).toContain(
        "Job 'security-scan' must not run before the scan",
      );
      expect(
        screen.getByText(/including this rule's name and message/i),
      ).toBeInTheDocument();
    });
  });
});
