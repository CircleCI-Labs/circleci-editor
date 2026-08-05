import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Meta } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import {
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from '~/state/projectContextStore';

import {
  CIRCLECI_STATUS_URL,
  CircleciReachability,
  observedCircleciFailures,
} from './CircleciReachability';

const META: Meta = {
  version: 'test',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  projectSlug: 'gh/acme/web',
  hasToken: true,
  host: 'https://circleci.com',
  cwd: '/repo',
  csrfToken: 'test-csrf-token',
  projectSlugSource: 'environment',
  projectBinding: { status: 'absent', description: 'test' },
};

describe('observedCircleciFailures', () => {
  const healthy = {
    hasToken: true,
    validationState: 'valid',
    lookupStatus: 'confirmed',
    lookupReason: null,
  };

  it('reports nothing while nothing has failed', () => {
    expect(observedCircleciFailures(healthy)).toEqual([]);
  });

  /**
   * The point of the whole design: silence is not a claim that CircleCI is up.
   * `unknown` is what the lookup reports before it has an answer, and it must
   * not be treated as either good or bad news.
   */
  it('reports nothing while the lookup has no answer yet', () => {
    expect(
      observedCircleciFailures({
        ...healthy,
        validationState: 'checking',
        lookupStatus: 'unknown',
      }),
    ).toEqual([]);
  });

  it('reports a validation request that failed at the transport layer', () => {
    const failures = observedCircleciFailures({
      ...healthy,
      validationState: 'error',
      validationReason: 'Failed to fetch',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe('Failed to fetch');
  });

  /**
   * `invalid` is CircleCI answering and saying no, and `unavailable` is this
   * host declining to ask. Neither is a reachability failure, and conflating
   * either with one would make this indicator wrong in the most common cases.
   *
   * `unauthorized` (issue #224) belongs in this list too: CircleCI answered,
   * and refused a bad token, which is a credential problem the "Token
   * rejected" badge already reports on its own -- not evidence that
   * CircleCI itself is unreachable.
   */
  it('does not treat an invalid config, a token-less host, or a rejected token as unreachable', () => {
    for (const validationState of [
      'invalid',
      'unavailable',
      'unauthorized',
      'idle',
    ]) {
      expect(observedCircleciFailures({ ...healthy, validationState })).toEqual(
        [],
      );
    }
  });

  it('reports a project lookup that could not get an answer', () => {
    const failures = observedCircleciFailures({
      ...healthy,
      lookupStatus: 'unreachable',
      lookupReason: 'Looking up gh/acme/web failed: HTTP 503.',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.what).toContain('Looking up this project');
  });

  /** CircleCI answering 404 is an answer: the project does not exist. That is
   * `ProjectIdentity`'s "Unknown to CircleCI", not a platform problem. */
  it('does not treat a 404 as unreachable', () => {
    expect(
      observedCircleciFailures({ ...healthy, lookupStatus: 'absent' }),
    ).toEqual([]);
  });

  /**
   * The structural discriminator. Without a token the project lookup reports
   * `unreachable` for a reason that has nothing to do with CircleCI's health,
   * and the bar's own "No token" badge already explains it.
   */
  it('reports nothing at all when this host never had a token to ask with', () => {
    expect(
      observedCircleciFailures({
        hasToken: false,
        validationState: 'error',
        lookupStatus: 'unreachable',
        lookupReason: 'No CircleCI API token is available.',
      }),
    ).toEqual([]);
  });

  it('reports both failures when both happened', () => {
    expect(
      observedCircleciFailures({
        hasToken: true,
        validationState: 'error',
        lookupStatus: 'unreachable',
        lookupReason: 'HTTP 503',
      }),
    ).toHaveLength(2);
  });
});

describe('CircleciReachability', () => {
  beforeEach(() => {
    resetProjectContextStoreForTests();
    useAppStore.setState({
      meta: META,
      validation: { state: 'valid', errors: [] },
    });
  });

  /** Zero furniture at rest is what keeps this out of the app bar's measured
   * budget entirely (#175). */
  it('renders nothing while nothing has failed', () => {
    const { container } = render(<CircleciReachability />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links to CircleCI’s status page once a call has been seen to fail', () => {
    useAppStore.setState({
      validation: { state: 'error', errors: [], reason: 'Failed to fetch' },
    });
    render(<CircleciReachability />);

    const link = screen.getByTestId('circleci-reachability');
    expect(link).toHaveTextContent('CircleCI unreachable');
    // Linked, never fetched: that is the whole difference between this and a
    // polling status indicator.
    expect(link).toHaveAttribute('href', CIRCLECI_STATUS_URL);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('stays silent for a config CircleCI answered about and rejected', () => {
    useAppStore.setState({
      validation: { state: 'invalid', errors: [{ message: 'bad' }] },
    });
    const { container } = render(<CircleciReachability />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces a project lookup this app watched fail', () => {
    useProjectContextStore.setState({
      state: 'error',
      reason: 'network error talking to CircleCI',
    });
    render(<CircleciReachability />);
    expect(screen.getByTestId('circleci-reachability')).toBeInTheDocument();
  });
});
