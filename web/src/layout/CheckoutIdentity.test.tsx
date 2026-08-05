import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAppStore } from '~/state/appStore';
import type { Meta } from '~/lib/rpc/client';

import {
  branchTooltip,
  CheckoutIdentity,
  gitHostLabel,
} from './CheckoutIdentity';

const BASE_META: Meta = {
  version: 'test',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  projectSlug: 'gh/acme/web',
  hasToken: true,
  host: 'https://circleci.com',
  cwd: '/repo',
  csrfToken: 'test-csrf-token',
  branch: 'main',
  branchSource: 'checkout',
  envBranch: 'main',
  repoWebUrl: 'https://github.com/acme/web',
  repoName: 'acme/web',
  repoHost: 'github.com',
  projectSlugSource: 'environment',
  projectBinding: { status: 'absent', description: 'test' },
};

function setMeta(meta: Meta | null): void {
  useAppStore.setState({ meta });
}

describe('gitHostLabel', () => {
  it('names the three hosts worth naming, self-hosted included', () => {
    expect(gitHostLabel('github.com')).toBe('GitHub');
    expect(gitHostLabel('GitHub.com')).toBe('GitHub');
    // A self-hosted instance is spelled "github.example.com" and is still
    // GitHub -- the same substring rule the host side uses.
    expect(gitHostLabel('github.example.com')).toBe('GitHub');
    expect(gitHostLabel('bitbucket.org')).toBe('Bitbucket');
    expect(gitHostLabel('gitlab.com')).toBe('GitLab');
  });

  it('shows an unrecognised host as itself rather than inventing a brand', () => {
    expect(gitHostLabel('git.internal.example')).toBe('git.internal.example');
  });
});

describe('branchTooltip', () => {
  it('says the branch came from the working tree', () => {
    expect(branchTooltip('main', 'checkout', 'main')).toContain(
      'checked out in this working tree',
    );
  });

  /** The whole point of reporting both sources: when they disagree the user is
   * told which one is on screen, rather than one being silently preferred. */
  it('names both branches, and which one is shown, when they disagree', () => {
    const tip = branchTooltip('fix/thing', 'checkout', 'release-1.2');
    expect(tip).toContain('fix/thing');
    expect(tip).toContain('release-1.2');
    expect(tip).toContain('the checkout wins');
  });

  it('says so when the branch is only the injected environment’s claim', () => {
    const tip = branchTooltip('release-1.2', 'environment', 'release-1.2');
    expect(tip).toContain('CIRCLE_BRANCH');
    expect(tip).toContain('not a git checkout');
  });
});

describe('CheckoutIdentity', () => {
  beforeEach(() => {
    setMeta(null);
  });

  it('renders nothing before meta has loaded', () => {
    const { container } = render(<CheckoutIdentity tight={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Editing a config outside a checkout is ordinary, and it must cost the app
   * bar's furniture budget nothing at all. */
  it('renders nothing when there is no branch and no remote', () => {
    setMeta({ ...BASE_META, branch: undefined, repoName: undefined });
    const { container } = render(<CheckoutIdentity tight={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the branch and a repository link labelled by its host', () => {
    setMeta(BASE_META);
    render(<CheckoutIdentity tight={false} />);

    expect(screen.getByTestId('checkout-branch')).toHaveTextContent('main');
    const link = screen.getByTestId('checkout-repo-link');
    expect(link).toHaveTextContent('GitHub');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/web');
    // Opening the repository must never be able to navigate this app away from
    // the user's unsaved work.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    // The label is short; the destination is named in full for assistive tech.
    expect(link).toHaveAttribute(
      'aria-label',
      'Opens acme/web on github.com in a new tab.',
    );
  });

  /**
   * The remote is where this checkout pushes, and issue #198 documented that it
   * can be stale after a rename -- so the repository *name* stays out of the
   * rendered label, where it would sit next to `ProjectIdentity`'s claim about
   * what CircleCI calls the project.
   */
  it('keeps the remote-derived repository name out of the visible label', () => {
    setMeta(BASE_META);
    render(<CheckoutIdentity tight={false} />);
    expect(screen.getByTestId('checkout-identity')).not.toHaveTextContent(
      'acme/web',
    );
  });

  it('renders plain text, not a link, for a host with no assumable web layout', () => {
    setMeta({
      ...BASE_META,
      repoWebUrl: undefined,
      repoHost: 'git.internal.example',
    });
    render(<CheckoutIdentity tight={false} />);

    expect(screen.queryByTestId('checkout-repo-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkout-repo-text')).toHaveTextContent(
      'git.internal.example',
    );
  });

  /** The `tight` demotion (see this component's doc comment): two cells become
   * one link, still pointing at the repository, still a link. */
  it('folds to a single branch-labelled repository link at the tight tier', () => {
    setMeta(BASE_META);
    render(<CheckoutIdentity tight />);

    expect(screen.queryByTestId('checkout-branch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkout-repo-link')).not.toBeInTheDocument();
    const folded = screen.getByTestId('checkout-branch-link');
    expect(folded).toHaveTextContent('main');
    expect(folded).toHaveAttribute('href', 'https://github.com/acme/web');
    // Nothing becomes unreachable at any tier, and the short label does not
    // leave a screen reader guessing where it goes.
    expect(folded).toHaveAttribute(
      'aria-label',
      'Branch main. Opens acme/web on github.com in a new tab.',
    );
  });

  /** Nothing to fold: with no link there is only one cell anyway, so `tight`
   * must not silently drop the branch. */
  it('still shows the branch at the tight tier when there is no repository link', () => {
    setMeta({ ...BASE_META, repoWebUrl: undefined, repoName: undefined });
    render(<CheckoutIdentity tight />);
    expect(screen.getByTestId('checkout-branch')).toHaveTextContent('main');
  });
});
