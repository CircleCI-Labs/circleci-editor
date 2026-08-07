import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from 'yaml';

import type { ResourceClassesResponse } from '~/lib/resourceClasses/types';
import { __resetResourceClassesCacheForTests } from '~/lib/resourceClasses/useResourceClasses';
import type { UsageJobSummary, UsageResponse } from '~/lib/rpc/client';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import { useOrbStore } from '~/state/orbStore';
import { useUsageStore } from '~/state/usageStore';

import { RecommendationsSection } from './RecommendationsSection';

type MutateFn = (fn: (doc: Document) => void) => void;

// Every test in this file except the "resource-class right-sizing" group
// below is exercising a detector that has nothing to do with usage or
// resource-class data; stubbing both `getUsage` and `getResourceClasses` to a
// promise that never resolves keeps `RecommendationsSection`'s automatic
// fetch effects from ever updating state after those tests' assertions run
// (the alternative -- letting the real fetch reject against jsdom's fetch --
// still "works", but resolves on a later microtask than `render()` returns,
// outside any `act()` those tests perform, so React logs a warning for every
// one of them).
vi.mock('~/lib/rpc/client', async () => {
  const actual =
    await vi.importActual<typeof import('~/lib/rpc/client')>(
      '~/lib/rpc/client',
    );
  return {
    ...actual,
    getUsage: vi.fn<typeof actual.getUsage>(() => new Promise(() => {})),
    getResourceClasses: vi.fn<typeof actual.getResourceClasses>(
      () => new Promise(() => {}),
    ),
  };
});

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

afterEach(() => {
  window.localStorage.clear();
  __resetResourceClassesCacheForTests();
  act(() => {
    useOrbStore.setState({ parsedOrbs: {}, orbVersionsCache: {} });
    useUsageStore.setState({
      fetchState: 'idle',
      status: null,
      jobs: [],
      reason: null,
      windowDays: 7,
    });
  });
});

describe('RecommendationsSection', () => {
  it('renders nothing for a null doc, or a doc with nothing to suggest', () => {
    const { container } = render(
      <RecommendationsSection doc={null} mutate={vi.fn<MutateFn>()} />,
    );
    expect(container).toBeEmptyDOMElement();

    const { container: container2 } = render(
      <RecommendationsSection
        doc={parse('jobs:\n  build:\n    steps:\n      - checkout\n')}
        mutate={vi.fn<MutateFn>()}
      />,
    );
    expect(container2).toBeEmptyDOMElement();
  });

  it('surfaces a matrix candidate with no action button, only a docs link and Dismiss', () => {
    render(
      <RecommendationsSection
        doc={parse(`jobs:
  deploy:
    parameters:
      region:
        type: string
    steps:
      - run: echo << parameters.region >>
workflows:
  release:
    jobs:
      - deploy:
          name: deploy-na
          region: NA
      - deploy:
          name: deploy-eu
          region: EU
`)}
        mutate={vi.fn<MutateFn>()}
      />,
    );

    expect(
      screen.getByText(/"deploy" is invoked 2 times in workflow "release"/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /extract/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Dismiss this suggestion' }),
    ).toBeInTheDocument();
  });

  it('surfaces an outdated orb using only the already-cached version info, and can bump it', () => {
    useOrbStore.setState({
      orbVersionsCache: {
        'circleci/node': {
          versions: ['5.0.0', '5.2.1'],
          latestVersion: '5.2.1',
        },
      },
    });
    const mutate = vi.fn<MutateFn>((fn) => fn(doc));
    const doc = parse(`orbs:
  node: circleci/node@5.0.0
`);

    render(<RecommendationsSection doc={doc} mutate={mutate} />);

    expect(
      screen.getByText(
        /circleci\/node@5\.0\.0 is behind the registry's latest/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update to 5.2.1' }));
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.1');
  });

  it('does not surface an outdated orb when the version has not already been looked up', () => {
    render(
      <RecommendationsSection
        doc={parse('orbs:\n  node: circleci/node@5.0.0\n')}
        mutate={vi.fn<MutateFn>()}
      />,
    );
    expect(screen.queryByText(/behind the registry/)).not.toBeInTheDocument();
  });

  it('extracts a repeated image tag into a pipeline parameter', () => {
    const mutate = vi.fn<MutateFn>((fn) => fn(doc));
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
    resource_class: medium
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.9
    resource_class: large
    steps:
      - checkout
`);

    render(<RecommendationsSection doc={doc} mutate={mutate} />);

    expect(
      screen.getByText(/2 places pin the exact image "cimg\/node:20.9"/),
    ).toBeInTheDocument();
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('image-tag');
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));

    expect(getIn(doc, ['parameters', 'image-tag'])).toEqual({
      type: 'string',
      default: 'cimg/node:20.9',
    });
    expect(getIn(doc, ['jobs', 'build', 'docker', 0, 'image'])).toBe(
      '<< pipeline.parameters.image-tag >>',
    );
  });

  it('adds a suggested fallback key to a single-key restore_cache', () => {
    const mutate = vi.fn<MutateFn>((fn) => fn(doc));
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          key: v1-deps-{{ checksum "package-lock.json" }}
`);

    render(<RecommendationsSection doc={doc} mutate={mutate} />);

    expect(
      screen.getByText(/restore_cache in "build" has one key and no fallback/),
    ).toBeInTheDocument();
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('v1-deps-');
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback key' }));

    expect(getIn(doc, ['jobs', 'build', 'steps', 0, 'restore_cache'])).toEqual({
      keys: ['v1-deps-{{ checksum "package-lock.json" }}', 'v1-deps-'],
    });
  });

  it('dismissing a card removes it without mutating the document', () => {
    useOrbStore.setState({
      orbVersionsCache: {
        'circleci/node': {
          versions: ['5.0.0', '5.2.1'],
          latestVersion: '5.2.1',
        },
      },
    });
    const mutate = vi.fn<MutateFn>();
    render(
      <RecommendationsSection
        doc={parse('orbs:\n  node: circleci/node@5.0.0\n')}
        mutate={mutate}
      />,
    );
    expect(
      screen.getByText(/behind the registry's latest/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss this suggestion' }),
    );
    expect(
      screen.queryByText(/behind the registry's latest/),
    ).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  describe('resource-class right-sizing (issue #307)', () => {
    // `getUsage` is one shared `vi.fn` for the whole file (the module mock
    // factory above runs once); without this, call-count assertions below
    // would accumulate across every test in this describe block, not just
    // within the one making them.
    beforeEach(() => {
      vi.clearAllMocks();
    });

    const RESOURCE_CONFIG = `jobs:
  build:
    resource_class: large
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
`;

    function usageResponse(
      overrides: Partial<UsageJobSummary> = {},
    ): UsageResponse {
      return {
        available: true,
        status: {
          ready: true,
          warming: false,
          state: 'ready',
          windowDays: 7,
        },
        jobs: [
          {
            jobName: 'build',
            resourceClass: 'large',
            executor: 'docker',
            operatingSystem: 'linux',
            runs: 12,
            avgMedianCpuPct: 18,
            avgMaxCpuPct: 25,
            maxMaxCpuPct: 30,
            avgMedianRamPct: 40,
            avgMaxRamPct: 55,
            maxMaxRamPct: 60,
            computeCredits: 4,
            totalCredits: 4,
            ...overrides,
          },
        ],
      };
    }

    // A minimal `/api/resource-classes` response with real `rank` values on
    // its Docker/x86 table (issue #8) -- just enough of the shape
    // `resourceClassCatalog.ts` reads to let `large`'s neighbours resolve to
    // `medium+` (one smaller) and `xlarge` (one larger), the same relative
    // positions the real vendored table gives them. Not the full ten-table
    // fixture `resourceClasses/testFixtures.ts` keeps for the picker's own
    // tests -- this describe block only ever asks about a Docker `large`.
    function resourceClassesResponse(): ResourceClassesResponse {
      return {
        derived: true,
        environments: [
          {
            id: 'x86',
            label: 'x86',
            kind: 'docker',
            architecture: 'x86_64',
            generation: 'gen1',
            classes: [
              {
                name: 'small',
                architecture: 'x86_64',
                generation: 'gen1',
                rank: 0,
              },
              {
                name: 'medium',
                architecture: 'x86_64',
                generation: 'gen1',
                rank: 1,
              },
              {
                name: 'medium+',
                architecture: 'x86_64',
                generation: 'gen1',
                rank: 2,
              },
              {
                name: 'large',
                architecture: 'x86_64',
                generation: 'gen1',
                rank: 3,
              },
              {
                name: 'xlarge',
                architecture: 'x86_64',
                generation: 'gen1',
                rank: 4,
              },
            ],
          },
        ],
      };
    }

    it('surfaces a low-cpu finding, with no action button while resource classes have not loaded', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(usageResponse());
      // getResourceClasses keeps its module default (never resolves, see the
      // top-level mock) -- exercising the window before `resourceClassCatalog`
      // exists at all, which must degrade to no action button rather than
      // wait or guess.

      render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByText(/averaged 18% median CPU on large/),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByText(/12 runs over the last 7 days/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^Move to/ }),
      ).not.toBeInTheDocument();
    });

    it('names and can apply a smaller class once the resource-class tables resolve, with a plan-dependence caveat', async () => {
      const { getUsage, getResourceClasses } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(usageResponse());
      vi.mocked(getResourceClasses).mockResolvedValueOnce(
        resourceClassesResponse(),
      );

      const mutate = vi.fn<MutateFn>((fn) => fn(doc));
      const doc = parse(RESOURCE_CONFIG);
      render(<RecommendationsSection doc={doc} mutate={mutate} />);

      // `medium+` is the nearest class ranked below `large` on the Docker
      // table above -- the same "nearest, not just any smaller class" rule
      // `detectResourceUtilization.test.ts` already pins against a stub
      // catalog, now exercised through the real one.
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Move to medium+' }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByText(/utilisation suggests `medium\+` would be enough/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/depends on your CircleCI plan/),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Move to medium+' }));
      expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium+');
    });

    it('never names a class the resource-class tables do not confirm, even once they resolve', async () => {
      const { getUsage, getResourceClasses } = await import('~/lib/rpc/client');
      // The job's own resource class ("large") is not in this response at
      // all -- e.g. a class the vendored tables have since renamed or
      // dropped. No environment can be found to rank within, so this must
      // stay information-only rather than guess.
      vi.mocked(getUsage).mockResolvedValueOnce(usageResponse());
      vi.mocked(getResourceClasses).mockResolvedValueOnce({
        derived: true,
        environments: [],
      });

      render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByText(/averaged 18% median CPU on large/),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole('button', { name: /^Move to/ }),
      ).not.toBeInTheDocument();
    });

    it('surfaces a high-ram finding independently of CPU', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(
        usageResponse({ avgMedianCpuPct: 70, maxMaxRamPct: 92 }),
      );

      render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByText(/peaked at 92% RAM on large/),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByText(/median CPU/)).not.toBeInTheDocument();
    });

    it('says nothing when there are too few runs to mean anything', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(usageResponse({ runs: 1 }));

      const { container } = render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() => expect(getUsage).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    });

    it('says nothing about a job no longer in the config', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(
        usageResponse({ jobName: 'some-other-job' }),
      );

      const { container } = render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() => expect(getUsage).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    });

    it('shows the manual refresh affordance and window selector only alongside a utilization suggestion', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValueOnce(usageResponse());

      render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Refresh' }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByRole('combobox', { name: 'Usage data window' }),
      ).toHaveValue('7');
    });

    it('refresh calls the usage store, and the window selector re-fetches with the new window', async () => {
      const { getUsage } = await import('~/lib/rpc/client');
      vi.mocked(getUsage).mockResolvedValue(usageResponse());

      render(
        <RecommendationsSection
          doc={parse(RESOURCE_CONFIG)}
          mutate={vi.fn<MutateFn>()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Refresh' }),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(2));
      expect(getUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ refresh: true }),
      );

      fireEvent.change(
        screen.getByRole('combobox', { name: 'Usage data window' }),
        { target: { value: '30' } },
      );
      await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(3));
      expect(getUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ windowDays: 30 }),
      );
    });
  });
});
