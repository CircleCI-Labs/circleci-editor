import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Meta } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import {
  resetOrbDescriptionPrefetchForTests,
  useOrbStore,
} from '~/state/orbStore';

import { OrbBrowser, type OrbBrowserProps } from './OrbBrowser';

// A token present by default: most of this file's cases are about search
// results and filters, not about the token itself, and issue #160 made
// `hasToken` matter to `NoResultsMessage`'s Private-filter wording. The two
// tests that are specifically about the no-token case override this.
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RESET_STATE = {
  query: '',
  // Reset explicitly: the filter deliberately outlives a query change (issue
  // #151), so it equally outlives anything short of resetting it here, and a
  // test inheriting "private" from an earlier one would be baffling.
  filter: 'all' as const,
  results: [],
  status: null,
  match: null,
  searchState: 'idle' as const,
  reason: null,
  selectedOrb: null,
  loadingOrb: false,
  error: null,
  parsedOrbs: {},
  orbVersionsCache: {},
};

const DEFAULT_PROPS: OrbBrowserProps = {
  localJobNames: ['build'],
  activeWorkflowName: 'main',
  onAddJob: vi.fn<OrbBrowserProps['onAddJob']>(),
  onAddCommand: vi.fn<OrbBrowserProps['onAddCommand']>(),
  onAddExecutor: vi.fn<OrbBrowserProps['onAddExecutor']>(),
};

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe('OrbBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useOrbStore.setState(RESET_STATE);
    useAppStore.setState({ meta: BASE_META });
    // The description-prefetch dedupe/queue (see orbStore.ts) deliberately
    // lives outside zustand state, so it survives the setState reset above
    // -- without this, a test reusing an orb name/version another test
    // already prefetched (e.g. "circleci/node@5.2.0", which recurs
    // throughout this file) would see its own prefetch silently no-op.
    resetOrbDescriptionPrefetchForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders search results in the exact order the API returned them, not re-sorted', async () => {
    // "circleci/uncertified" is returned *before* the certified orb -- if this
    // component ever re-sorted (e.g. certified-first client-side), this
    // ordering assumption would flip and the test would catch it.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        status: { ready: true, complete: true, count: 6400, warming: false },
        results: [
          {
            name: 'circleci/uncertified',
            private: false,
            certified: false,
            listed: true,
            latestVersion: '1.0.0',
            versions: ['1.0.0'],
            matchedOn: 'name',
          },
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: true,
            latestVersion: '5.2.0',
            versions: ['5.2.0'],
            matchedOn: 'exact-name',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();

    const buttons = screen.getAllByRole('button', { name: /circleci\// });
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining('circleci/uncertified'),
      expect.stringContaining('circleci/node'),
    ]);
  });

  // Issue #285: the manual "check now" refresh button, consistent with the
  // palette Contexts section's own.
  describe('the Refresh button (issue #285)', () => {
    it('clicking it re-issues the current search with refresh=1', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: { ready: true, complete: true, count: 1, warming: false },
          results: [],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle(); // initial empty-query load

      fetchMock.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('refresh=1');
    });

    it('is disabled and says so while the registry is warming', async () => {
      useOrbStore.setState({
        searchState: 'ready',
        status: {
          ready: true,
          complete: false,
          count: 79,
          warming: true,
          certifiedCount: 79,
          privateCount: 0,
        },
      });

      render(<OrbBrowser {...DEFAULT_PROPS} />);

      const button = screen.getByRole('button', { name: /refreshing/i });
      expect(button).toBeDisabled();
    });
  });

  it('shows Certified and Private badges on the matching results only', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: true,
            latestVersion: '5.2.0',
            versions: ['5.2.0'],
            matchedOn: 'name',
          },
          {
            name: 'acme/internal',
            private: true,
            certified: false,
            listed: true,
            latestVersion: '0.1.0',
            versions: ['0.1.0'],
            matchedOn: 'name',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'orb' },
    });
    await settle();

    // Scoped to the results list: the filter chips (issue #151) are labelled
    // "Certified"/"Private" too, and this test is about the row badges.
    const list = screen.getByTestId('orb-results-list');
    expect(within(list).getByText('Certified')).toBeInTheDocument();
    expect(within(list).getByText('Private')).toBeInTheDocument();
  });

  it('shows an Unlisted badge for a result the registry does not list, distinct from Private', async () => {
    // Both `listed: false` here, one private and one not: unlisted and
    // private are orthogonal signals (see orbSearchResultPayload's doc
    // comment in internal/host/orbs.go) and this must badge both cases,
    // not just the private one.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: false,
            latestVersion: '5.2.0',
            versions: ['5.2.0'],
            matchedOn: 'exact-name',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'circleci/node' },
    });
    await settle();

    expect(screen.getByText('Unlisted')).toBeInTheDocument();
    // Never fabricated: the v3 API has no partner/tier field (see
    // ResultBadges's doc comment in OrbBrowser.tsx), so there must be
    // nothing claiming to be one.
    expect(screen.queryByText('Partner')).not.toBeInTheDocument();
  });

  it("shows a result's description in the list row once prefetched, without requiring a click", async () => {
    const searchResponse = jsonResponse(200, {
      available: true,
      status: null,
      results: [
        {
          name: 'circleci/node',
          private: false,
          certified: true,
          listed: true,
          latestVersion: '5.2.0',
          versions: ['5.2.0'],
          matchedOn: 'name',
        },
      ],
    });
    const sourceResponse = jsonResponse(200, {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source:
        'description: Tools for the Node.js ecosystem\njobs:\n  test:\n    steps: []\n',
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : String(input);
      return Promise.resolve(
        url.includes('/api/orbs/source') ? sourceResponse : searchResponse,
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();

    // No click happened -- the description prefetch (issue #50) is what
    // put this on the page, not `selectOrb`.
    expect(screen.queryByTestId('orb-detail-region')).not.toBeInTheDocument();
    expect(
      screen.getByText('Tools for the Node.js ecosystem'),
    ).toBeInTheDocument();
  });

  // Issue #160: orb search no longer refuses for lack of a token -- the
  // public registry answers unauthenticated -- so `available: false` is
  // exercised here only as a defensive branch for whatever reason the host
  // might still report, verbatim, rather than as the token-specific case it
  // used to be.
  it('shows the host-reported reason when the search API reports itself unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: false,
        source: 'unavailable',
        reason: 'the orb registry could not be reached',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();

    expect(screen.getByText(/orb search is unavailable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/the orb registry could not be reached/i),
    ).toBeInTheDocument();
    // Must not read as "nothing matched" -- that's a different, misleading state.
    expect(screen.queryByText(/no orbs matched/i)).not.toBeInTheDocument();
  });

  it('selecting a result lists its jobs, commands, and executors', async () => {
    const searchResponse = jsonResponse(200, {
      available: true,
      status: null,
      results: [
        {
          name: 'circleci/node',
          private: false,
          certified: true,
          listed: true,
          latestVersion: '5.2.0',
          versions: ['5.2.0'],
          matchedOn: 'name',
        },
      ],
    });
    const sourceResponse = jsonResponse(200, {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source: [
        'description: Node.js orb',
        'jobs:',
        '  test:',
        '    steps: []',
        'commands:',
        '  install-packages:',
        '    steps: []',
        'executors:',
        '  default:',
        '    docker: []',
        '',
      ].join('\n'),
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : String(input);
      return Promise.resolve(
        url.includes('/api/orbs/source') ? sourceResponse : searchResponse,
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
    await settle();

    expect(screen.getByText(/jobs \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/commands \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/executors \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText('install-packages')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  describe('registry-style filters (issue #151)', () => {
    interface MatchPayload {
      filter: string;
      matched: number;
      matchedUnfiltered: number;
      scopeSize: number;
    }

    const READY_STATUS = {
      ready: true,
      complete: true,
      count: 6400,
      warming: false,
      certifiedCount: 79,
      privateCount: 2,
    };

    const NODE_RESULT = {
      name: 'circleci/node',
      private: false,
      certified: true,
      listed: true,
      latestVersion: '5.2.0',
      versions: ['5.2.0'],
      matchedOn: 'exact-name',
    };

    /**
     * A `fetch` stub that builds a *fresh* `Response` per call. Every test
     * here searches more than once (selecting a filter re-runs the query), and
     * a `Response` body can only be read once -- a single shared instance
     * fails the second read with "Body has already been read".
     *
     * `body` receives the request URL so a test can answer the filtered and
     * unfiltered requests differently, which is what makes "N hidden by this
     * filter" observable at all.
     */
    function stubSearch(body: (url: string) => unknown): void {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockImplementation((input: RequestInfo | URL) =>
            Promise.resolve(jsonResponse(200, body(String(input)))),
          ),
      );
    }

    function searchBody(
      results: unknown[],
      match: MatchPayload,
      status: Record<string, unknown> = READY_STATUS,
    ) {
      return { available: true, status, match, results };
    }

    it('offers exactly All, Certified and Private -- no Partner, which no CircleCI API exposes', async () => {
      stubSearch(() =>
        searchBody([NODE_RESULT], {
          filter: 'all',
          matched: 1,
          matchedUnfiltered: 1,
          scopeSize: 6400,
        }),
      );
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();

      const group = screen.getByRole('radiogroup', { name: /filter orbs/i });
      expect(
        within(group)
          .getAllByRole('radio')
          .map((radio) => (radio as HTMLInputElement).value),
      ).toEqual(['all', 'certified', 'private']);
      expect(
        within(group).queryByRole('radio', { name: /partner/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    });

    it('sends the chosen filter to the host and keeps it across a query change', async () => {
      stubSearch(() =>
        searchBody([NODE_RESULT], {
          filter: 'certified',
          matched: 1,
          matchedUnfiltered: 1,
          scopeSize: 79,
        }),
      );
      const fetchMock = globalThis.fetch as unknown as ReturnType<
        typeof vi.fn<typeof fetch>
      >;

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();

      fireEvent.click(screen.getByRole('radio', { name: 'Certified' }));
      await settle();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('filter=certified'),
        ),
      ).toBe(true);

      // The requirement: typing a new query must not silently drop the filter.
      fetchMock.mockClear();
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'slack' },
      });
      await settle();

      const searchUrls = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes('/api/orbs/search'));
      expect(searchUrls.some((url) => url.includes('q=slack'))).toBe(true);
      expect(searchUrls.every((url) => url.includes('filter=certified'))).toBe(
        true,
      );
      expect(screen.getByRole('radio', { name: 'Certified' })).toBeChecked();
    });

    it('says how much the filter is hiding, and offers a way back to all orbs', async () => {
      stubSearch((url) =>
        url.includes('filter=certified')
          ? searchBody([NODE_RESULT], {
              filter: 'certified',
              matched: 1,
              matchedUnfiltered: 12,
              scopeSize: 79,
            })
          : searchBody([NODE_RESULT], {
              filter: 'all',
              matched: 12,
              matchedUnfiltered: 12,
              scopeSize: 6400,
            }),
      );

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      // Unfiltered: no filter to blame, so no count line at all -- the
      // affordance costs nothing until it has something to explain.
      expect(
        screen.queryByText(/hidden by this filter/i),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: 'Certified' }));
      await settle();

      expect(screen.getByText(/1 certified orb/)).toBeInTheDocument();
      expect(screen.getByText(/11 hidden by this filter/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /show all/i }));
      await settle();
      expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
      expect(
        screen.queryByText(/hidden by this filter/i),
      ).not.toBeInTheDocument();
    });

    it('explains an empty private list as a limit of the token, not as "you have none"', async () => {
      stubSearch((url) =>
        url.includes('filter=private')
          ? searchBody(
              [],
              {
                filter: 'private',
                matched: 0,
                matchedUnfiltered: 4,
                scopeSize: 0,
              },
              { ...READY_STATUS, privateCount: 0 },
            )
          : searchBody([NODE_RESULT], {
              filter: 'all',
              matched: 4,
              matchedUnfiltered: 4,
              scopeSize: 6400,
            }),
      );

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();
      fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
      await settle();

      expect(
        screen.getByText(/no private orbs found for this host's api token/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/not the same as your organizations having none/i),
      ).toBeInTheDocument();
    });

    it('says an empty private list is unsettled while the registry is still being crawled', async () => {
      stubSearch(() =>
        searchBody(
          [],
          {
            filter: 'private',
            matched: 0,
            matchedUnfiltered: 0,
            scopeSize: 0,
          },
          {
            ready: true,
            complete: false,
            count: 79,
            warming: true,
            certifiedCount: 79,
            privateCount: 0,
          },
        ),
      );

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();
      fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
      await settle();

      expect(screen.getByText(/still being crawled/i)).toBeInTheDocument();
      expect(
        screen.queryByText(/not the same as your organizations having none/i),
      ).not.toBeInTheDocument();
    });

    it('distinguishes "none of your private orbs match this" from "you have no private orbs"', async () => {
      stubSearch(() =>
        searchBody([], {
          filter: 'private',
          matched: 0,
          matchedUnfiltered: 3,
          // The scope is *not* empty -- private orbs exist, this query just
          // matched none of them.
          scopeSize: 2,
        }),
      );

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
      await settle();

      expect(screen.getByText(/no private orb matched/i)).toBeInTheDocument();
      expect(
        screen.getByText(/3 orbs outside this filter match/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/not the same as your organizations having none/i),
      ).not.toBeInTheDocument();
    });

    // Issue #160: with no token at all, search itself still succeeds -- the
    // public registry answers unauthenticated -- but an unauthenticated crawl
    // can never see a private namespace, so the Private filter's scope is
    // genuinely empty. That must read as "this host cannot look" rather than
    // as "you have none", and distinctly from the token-present case (the
    // scoped-empty test above), whose wording says something different.
    it('with no token, says the private filter cannot be answered rather than showing an empty list', async () => {
      useAppStore.setState({ meta: { ...BASE_META, hasToken: false } });
      stubSearch(() =>
        searchBody(
          [],
          { filter: 'private', matched: 0, matchedUnfiltered: 4, scopeSize: 0 },
          { ...READY_STATUS, privateCount: 0 },
        ),
      );

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();
      fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
      await settle();

      expect(
        screen.getByText(
          /no private orbs can be shown.*no circleci api token/i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /not a report that your organizations have no private orbs/i,
        ),
      ).toBeInTheDocument();
      // The filter control stays usable, so the explanation is reachable at
      // all rather than being hidden behind a disabled toggle.
      expect(screen.getByRole('radio', { name: 'Private' })).toBeChecked();
    });
  });
  // Master and detail alternate rather than stack (see `OrbBrowser`'s render
  // comment). Issue #29's requirement -- reach the detail without scrolling
  // past every result -- is satisfied more strongly by replacing the list than
  // by capping it, and doing so removed two of the four scroll regions this
  // pane had at once.
  describe('selecting a result drills down to its detail (issues #29, #88)', () => {
    // Builds fresh Response objects per call (rather than one shared
    // instance) because a `Response` body can only be read once, and this
    // orb's source is now genuinely fetched more than once per test in
    // practice: the background description prefetch (issue #50, see
    // `useDescriptionPrefetch`) fetches it as soon as the search settles,
    // ahead of any click.
    function buildSearchResponse(): Response {
      return jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: true,
            latestVersion: '5.2.0',
            versions: ['5.2.0'],
            matchedOn: 'name',
          },
        ],
      });
    }
    function buildSourceResponse(): Response {
      return jsonResponse(200, {
        available: true,
        name: 'circleci/node',
        version: '5.2.0',
        source: 'jobs:\n  test:\n    steps: []\n',
      });
    }

    /**
     * `deferFirstSourceCall` holds open the *first* `/api/orbs/source`
     * call (deterministically the background description prefetch's --
     * see `useDescriptionPrefetch` -- since it fires as soon as results
     * commit, before any click) rather than resolving it immediately.
     * Without this, that prefetch resolves and warms `selectOrb`'s cache
     * before a test ever gets to click a row, so `selectOrb` takes the
     * cache-hit path and the loading state this file's issue #29 tests
     * are about would never actually appear to assert against.
     */
    function stubNodeOrbFetch({
      deferFirstSourceCall = false,
    }: { deferFirstSourceCall?: boolean } = {}): {
      fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
      resolveDeferredSource: () => void;
    } {
      let resolveDeferredSource: () => void = () => {};
      const deferredSource = new Promise<Response>((resolve) => {
        resolveDeferredSource = () => resolve(buildSourceResponse());
      });
      let sourceCallCount = 0;

      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        if (!url.includes('/api/orbs/source'))
          return Promise.resolve(buildSearchResponse());
        sourceCallCount += 1;
        if (deferFirstSourceCall && sourceCallCount === 1)
          return deferredSource;
        return Promise.resolve(buildSourceResponse());
      });
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, resolveDeferredSource };
    }

    it('shows the detail region immediately on click, before the fetch resolves', async () => {
      const { resolveDeferredSource } = stubNodeOrbFetch({
        deferFirstSourceCall: true,
      });
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();

      expect(screen.queryByTestId('orb-detail-region')).not.toBeInTheDocument();
      expect(screen.getByTestId('orb-results-list')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));

      // The detail region (with its loading state) appears synchronously, and
      // takes the list's place -- so it can never need scrolling to, and only
      // the palette column around it scrolls.
      expect(screen.getByTestId('orb-detail-region')).toBeInTheDocument();
      expect(screen.getByText(/loading orb source/i)).toBeInTheDocument();
      expect(screen.queryByTestId('orb-results-list')).not.toBeInTheDocument();

      resolveDeferredSource();
      await settle();
    });

    // Replaces a test that asserted the selected row was marked `aria-pressed`
    // and scrolled into view inside the capped list. Neither can hold now: the
    // list unmounts while a detail is open, which is also why the
    // scroll-into-view effect was removed as dead. The requirement underneath
    // it -- you can tell which orb you are looking at -- is now carried by the
    // detail's own header, which is what this asserts instead.
    it('names the selected orb in the detail, and returns to an unselected list', async () => {
      stubNodeOrbFetch();
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      const detail = screen.getByTestId('orb-detail-region');
      expect(detail).toHaveTextContent('circleci/node');

      fireEvent.click(screen.getByRole('button', { name: /back to results/i }));

      expect(
        screen.getByRole('button', { name: /circleci\/node/ }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('the "Back to results" affordance clears the selection and restores the list', async () => {
      stubNodeOrbFetch();
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();
      expect(screen.getByTestId('orb-detail-region')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /back to results/i }));

      expect(screen.queryByTestId('orb-detail-region')).not.toBeInTheDocument();
      expect(screen.getByTestId('orb-results-list')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /circleci\/node/ }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('keeps the search field reachable while a result is selected', async () => {
      stubNodeOrbFetch();
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      const searchInput = screen.getByLabelText(/search orbs/i);
      expect(searchInput).toBeInTheDocument();
      expect(searchInput).toBeEnabled();
    });

    it('does not re-sort results after a selection (certified-first server ordering preserved)', async () => {
      const searchResponse = jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/uncertified',
            private: false,
            certified: false,
            listed: true,
            latestVersion: '1.0.0',
            versions: ['1.0.0'],
            matchedOn: 'name',
          },
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: true,
            latestVersion: '5.2.0',
            versions: ['5.2.0'],
            matchedOn: 'exact-name',
          },
        ],
      });
      const sourceResponse = jsonResponse(200, {
        available: true,
        name: 'circleci/node',
        version: '5.2.0',
        source: 'jobs:\n  test:\n    steps: []\n',
      });
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        return Promise.resolve(
          url.includes('/api/orbs/source') ? sourceResponse : searchResponse,
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();
      // Selecting drills down, so the list is unmounted -- come back to it to
      // check the ordering survived. That round trip is the stronger assertion
      // anyway: it proves the results weren't re-sorted *and* weren't refetched
      // into a different order on the way back.
      fireEvent.click(screen.getByRole('button', { name: /back to results/i }));

      const buttons = within(
        screen.getByTestId('orb-results-list'),
      ).getAllByRole('button', { name: /circleci\// });
      expect(buttons.map((b) => b.textContent)).toEqual([
        expect.stringContaining('circleci/uncertified'),
        expect.stringContaining('circleci/node'),
      ]);
    });
  });

  describe('browsing with an empty query (issue #50)', () => {
    it('groups the default certified-orb browse list by namespace', async () => {
      // Alphabetical by "<namespace>/<name>", exactly as
      // orbs.defaultResults returns it -- namespaces are already
      // contiguous, which is what makes grouping this list safe (see
      // groupByNamespace's doc comment in OrbBrowser.tsx).
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: { ready: true, complete: true, count: 79, warming: false },
          results: [
            {
              name: 'cci-labs/act',
              private: false,
              certified: true,
              listed: true,
              latestVersion: '1.0.0',
              versions: ['1.0.0'],
              matchedOn: 'default',
            },
            {
              name: 'circleci/node',
              private: false,
              certified: true,
              listed: true,
              latestVersion: '5.2.0',
              versions: ['5.2.0'],
              matchedOn: 'default',
            },
            {
              name: 'circleci/slack',
              private: false,
              certified: true,
              listed: true,
              latestVersion: '4.0.0',
              versions: ['4.0.0'],
              matchedOn: 'default',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      // No fireEvent.change -- the panel's own mount effect searches ''
      // as soon as it opens (see OrbBrowser's idle-state effect); this
      // is exactly the "just looking at the orb section" browse state
      // issue #50 describes, not a user-typed query.
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      await settle();

      expect(screen.getByText('cci-labs (1)')).toBeInTheDocument();
      expect(screen.getByText('circleci (2)')).toBeInTheDocument();

      const circleciGroup = screen.getByText('circleci (2)').closest('details');
      expect(circleciGroup).not.toBeNull();
      const circleciButtons = within(circleciGroup!).getAllByRole('button', {
        name: /circleci\//,
      });
      expect(circleciButtons.map((b) => b.textContent)).toEqual([
        expect.stringContaining('node'),
        expect.stringContaining('slack'),
      ]);
    });

    it('does not group a non-empty query -- only the unqueried browse list', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: null,
          results: [
            {
              name: 'circleci/node',
              private: false,
              certified: true,
              listed: true,
              latestVersion: '5.2.0',
              versions: ['5.2.0'],
              matchedOn: 'exact-name',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();

      expect(screen.queryByRole('group')).not.toBeInTheDocument();
      expect(document.querySelector('details')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /circleci\/node/ }),
      ).toBeInTheDocument();
    });
  });

  it('adding an orb job calls onAddJob with the ref and element', async () => {
    const searchResponse = jsonResponse(200, {
      available: true,
      status: null,
      results: [
        {
          name: 'circleci/node',
          private: false,
          certified: true,
          listed: true,
          latestVersion: '5.2.0',
          versions: ['5.2.0'],
          matchedOn: 'name',
        },
      ],
    });
    const sourceResponse = jsonResponse(200, {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source: 'jobs:\n  test:\n    steps: []\n',
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : String(input);
      return Promise.resolve(
        url.includes('/api/orbs/source') ? sourceResponse : searchResponse,
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAddJob = vi.fn<OrbBrowserProps['onAddJob']>();
    render(<OrbBrowser {...DEFAULT_PROPS} onAddJob={onAddJob} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /add to workflow/i }));

    expect(onAddJob).toHaveBeenCalledWith(
      'circleci/node@5.2.0',
      expect.objectContaining({ name: 'test', kind: 'job' }),
    );
  });

  // Issue #89's readability half: an element's parameters render with
  // their type, required-ness, and default, rather than only the "N params
  // (M required)" summary line.
  it("shows a job's parameters with type, required/optional, and default", async () => {
    const searchResponse = jsonResponse(200, {
      available: true,
      status: null,
      results: [
        {
          name: 'circleci/node',
          private: false,
          certified: true,
          listed: true,
          latestVersion: '5.2.0',
          versions: ['5.2.0'],
          matchedOn: 'name',
        },
      ],
    });
    const sourceResponse = jsonResponse(200, {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source: [
        'description: A Node.js orb with **bold** text and a [link](https://example.com/orb).',
        'display:',
        '  home_url: https://example.com/home',
        '  source_url: https://example.com/source',
        'jobs:',
        '  test:',
        '    parameters:',
        '      version:',
        '        type: string',
        '        default: "20"',
        '      cache-key:',
        '        type: string',
        '    steps: []',
        '',
      ].join('\n'),
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : String(input);
      return Promise.resolve(
        url.includes('/api/orbs/source') ? sourceResponse : searchResponse,
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OrbBrowser {...DEFAULT_PROPS} />);
    fireEvent.change(screen.getByLabelText(/search orbs/i), {
      target: { value: 'node' },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
    await settle();

    // Scoped to the detail region: the panel header's own "Registry" link
    // (see `OrbBrowser`'s own render, issue #78/#79) is always present too,
    // and would otherwise collide with this orb's per-orb registry link.
    const detail = within(screen.getByTestId('orb-detail-region'));

    // The required param shows no default and an explicit "Required" badge;
    // the optional one shows its default value.
    expect(detail.getByText('cache-key')).toBeInTheDocument();
    expect(detail.getByText('Required')).toBeInTheDocument();
    expect(detail.getByText('version')).toBeInTheDocument();
    expect(detail.getByText('20')).toBeInTheDocument();

    // The description renders through the markdown-lite subset (bold + a
    // real link), not as a flat string.
    const bold = detail.getByText('bold');
    expect(bold.tagName).toBe('STRONG');
    const link = detail.getByRole('link', { name: 'link' });
    expect(link).toHaveAttribute('href', 'https://example.com/orb');

    // homeUrl/sourceUrl plus a registry docs link, per the docsLinks table
    // (never a literal circleci.com URL in this component).
    expect(detail.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      'https://example.com/home',
    );
    expect(detail.getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://example.com/source',
    );
    const registryLink = detail.getByRole('link', { name: 'Registry' });
    expect(registryLink).toHaveAttribute(
      'href',
      'https://circleci.com/developer/orbs/orb/circleci/node',
    );
    expect(registryLink).toHaveAttribute(
      'title',
      'circleci/node on the CircleCI orb registry',
    );
  });

  // Issue #89: version is a first-class, always-visible control, not one
  // gated on the search response happening to carry more than one version.
  describe('version selection (issue #89)', () => {
    function buildSearchResponse(): Response {
      return jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            listed: true,
            latestVersion: '5.2.0',
            versions: ['5.2.0', '5.1.0'],
            matchedOn: 'name',
          },
        ],
      });
    }

    /** Each version's source declares a differently-named job, so a re-fetch/re-parse on version switch is observable. */
    function buildSourceResponse(version: string): Response {
      const jobName = version === '5.2.0' ? 'test' : 'legacy-test';
      return jsonResponse(200, {
        available: true,
        name: 'circleci/node',
        version,
        source: `jobs:\n  ${jobName}:\n    steps: []\n`,
      });
    }

    function stubVersionedNodeFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        if (!url.includes('/api/orbs/source')) {
          return Promise.resolve(buildSearchResponse());
        }
        const version =
          new URLSearchParams(url.split('?')[1]).get('version') ?? '5.2.0';
        return Promise.resolve(buildSourceResponse(version));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('renders a version control even when only one version is known -- never gated on versions.length > 1', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        return Promise.resolve(
          url.includes('/api/orbs/source')
            ? jsonResponse(200, {
                available: true,
                name: 'circleci/node',
                version: '5.2.0',
                source: 'jobs:\n  test:\n    steps: []\n',
              })
            : jsonResponse(200, {
                available: true,
                status: null,
                results: [
                  {
                    name: 'circleci/node',
                    private: false,
                    certified: true,
                    listed: true,
                    latestVersion: '5.2.0',
                    versions: ['5.2.0'],
                    matchedOn: 'name',
                  },
                ],
              }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      expect(screen.getByLabelText('Orb version')).toBeInTheDocument();
    });

    // Against the real host, /api/orbs/search ranks a crawled cache that
    // (per orbsSourceResponse's own doc comment) often only has each
    // package's *newest* version embedded -- so a search result's own
    // `versions` array is frequently just one entry, even for an orb with
    // a long release history. This asserts the version control still
    // offers more than that one entry once /api/orbs/source's own
    // (authoritative) version list arrives.
    it('shows more than one version even when the search result itself only carried the latest', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        if (!url.includes('/api/orbs/source')) {
          return Promise.resolve(
            jsonResponse(200, {
              available: true,
              status: null,
              results: [
                {
                  name: 'circleci/node',
                  private: false,
                  certified: true,
                  listed: true,
                  latestVersion: '5.2.0',
                  versions: ['5.2.0'], // reduced, as the real crawled cache often is
                  matchedOn: 'name',
                },
              ],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            available: true,
            name: 'circleci/node',
            version: '5.2.0',
            source: 'jobs:\n  test:\n    steps: []\n',
            versions: ['5.2.0', '5.1.0', '5.0.0'],
            latestVersion: '5.2.0',
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      const select = screen.getByLabelText('Orb version') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        '5.2.0',
        '5.1.0',
        '5.0.0',
      ]);
    });

    it('recommends the resolved latest version, and switching to an older one re-fetches/re-parses and offers "Use latest" back', async () => {
      stubVersionedNodeFetch();
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      // Landed on the latest version by default, visibly marked as such.
      expect(screen.getByLabelText('Orb version')).toHaveValue('5.2.0');
      expect(screen.getByText('Latest')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /use latest/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('test')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Orb version'), {
        target: { value: '5.1.0' },
      });
      await settle();

      // Re-fetched and re-parsed for the newly selected version: the older
      // version's job appears, the newer version's job is gone.
      expect(screen.getByText('legacy-test')).toBeInTheDocument();
      expect(screen.queryByText('test')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Orb version')).toHaveValue('5.1.0');
      expect(screen.queryByText('Latest')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /use latest/i }),
      ).toBeInTheDocument();

      // "Use latest" switches straight back.
      fireEvent.click(screen.getByRole('button', { name: /use latest/i }));
      await settle();

      expect(screen.getByLabelText('Orb version')).toHaveValue('5.2.0');
      expect(screen.getByText('test')).toBeInTheDocument();
    });

    // The #59 guard, extended to this new version-switch path: #59 was a
    // cache-hit bug that truncated a namespaced orb name to its bare name
    // when writing `orbs:`. This asserts the ref handed to `onAddJob`
    // after switching versions is still the full "<namespace>/<name>" --
    // with the *newly selected* version, not the one first resolved.
    it('adding a job after switching versions inserts a fully namespaced ref with the newly selected version', async () => {
      stubVersionedNodeFetch();
      const onAddJob = vi.fn<OrbBrowserProps['onAddJob']>();
      render(<OrbBrowser {...DEFAULT_PROPS} onAddJob={onAddJob} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: 'node' },
      });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /circleci\/node/ }));
      await settle();

      fireEvent.change(screen.getByLabelText('Orb version'), {
        target: { value: '5.1.0' },
      });
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /add to workflow/i }));

      expect(onAddJob).toHaveBeenCalledWith(
        'circleci/node@5.1.0',
        expect.objectContaining({ name: 'legacy-test', kind: 'job' }),
      );
    });
  });

  /**
   * Issue #257: an empty orb list used to render with no reason at all, because
   * `internal/orbs.Cache` recorded one and `orbsStatusPayload` had nowhere to
   * carry it. These cover the browser end of that -- the reason now arrives, and
   * has to reach the screen rather than being dropped a second time.
   */
  describe('an empty orb list says why it is empty (issue #257)', () => {
    const EMPTY_COUNTS = {
      ready: false,
      complete: false,
      count: 0,
      warming: false,
      certifiedCount: 0,
      privateCount: 0,
    };

    const NODE = {
      name: 'circleci/node',
      private: false,
      certified: true,
      listed: true,
      latestVersion: '5.2.0',
      versions: ['5.2.0'],
      matchedOn: 'name',
    };

    function stubSearchStatus(status: unknown, results: unknown[] = []): void {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockImplementation(() =>
          Promise.resolve(
            jsonResponse(200, {
              available: true,
              status,
              match: {
                filter: 'all',
                matched: results.length,
                matchedUnfiltered: results.length,
                scopeSize: results.length,
              },
              results,
            }),
          ),
        ),
      );
    }

    async function searchFor(query: string): Promise<void> {
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.change(screen.getByLabelText(/search orbs/i), {
        target: { value: query },
      });
      await settle();
    }

    it('reports a failed fetch as a failure, not as "no orbs matched"', async () => {
      stubSearchStatus({
        ...EMPTY_COUNTS,
        state: 'failed',
        reason: 'the CircleCI API reported a server error (HTTP 500)',
      });
      await searchFor('node');

      const box = screen.getByTestId('orb-cache-notice');
      expect(box).toHaveTextContent(/could not be fetched/i);
      expect(box).toHaveTextContent(/HTTP 500/);
      // The pre-#257 message, and the reason it was wrong: nothing was searched
      // against any listing, so nothing can have failed to match.
      expect(screen.queryByText(/no orbs matched/i)).not.toBeInTheDocument();
    });

    it('reports a genuinely empty registry differently from a failure', async () => {
      stubSearchStatus({
        ...EMPTY_COUNTS,
        ready: true,
        complete: true,
        state: 'empty',
      });
      await searchFor('node');

      const box = screen.getByTestId('orb-cache-notice');
      expect(box).toHaveTextContent(/has no orbs in it/i);
      expect(box).not.toHaveTextContent(/could not be fetched/i);
    });

    it('explains an empty registry as normal on a CircleCI Server installation', async () => {
      stubSearchStatus({
        ...EMPTY_COUNTS,
        ready: true,
        complete: true,
        state: 'empty',
        selfHosted: true,
      });
      await searchFor('node');

      const box = screen.getByTestId('orb-cache-notice');
      expect(box).toHaveTextContent(/CircleCI Server/);
      expect(box).toHaveTextContent(/after your account became an admin/i);
    });

    // The cache-level explanation *replaces* the filter-level one rather than
    // preceding it: with nothing cached, "no private orbs were found for this
    // host's token" is not merely unhelpful, it is false.
    it('outranks the private-filter message when nothing is cached at all', async () => {
      stubSearchStatus({
        ...EMPTY_COUNTS,
        state: 'failed',
        reason: 'this host could not reach the CircleCI API (network error)',
      });
      render(<OrbBrowser {...DEFAULT_PROPS} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
      await settle();

      expect(screen.getByTestId('orb-cache-notice')).toHaveTextContent(
        /network error/,
      );
      expect(
        screen.queryByText(/No private orbs found for this host/i),
      ).not.toBeInTheDocument();
    });

    it('admits it does not know when the host reported no state', async () => {
      stubSearchStatus({ ...EMPTY_COUNTS });
      await searchFor('node');

      expect(screen.getByTestId('orb-cache-notice')).toHaveTextContent(
        /did not report why/i,
      );
    });

    it('labels a stale-but-usable list above the results instead of withholding it', async () => {
      stubSearchStatus(
        {
          ...EMPTY_COUNTS,
          ready: true,
          complete: true,
          count: 6400,
          state: 'stale',
          stale: true,
          fetchedAt: '2026-06-01T00:00:00Z',
          refreshWindowHours: 24,
        },
        [NODE],
      );
      await searchFor('node');

      const box = screen.getByTestId('orb-cache-notice');
      expect(box).toHaveTextContent(/not current/i);
      expect(box).toHaveTextContent(/1 day refresh window/);
      // Still usable, which is the point of labelling rather than withholding.
      expect(
        screen.getByRole('button', { name: /circleci\/node/ }),
      ).toBeInTheDocument();
    });

    it('says nothing at all when the cached listing is current', async () => {
      stubSearchStatus(
        {
          ...EMPTY_COUNTS,
          ready: true,
          complete: true,
          count: 6400,
          state: 'ready',
          refreshWindowHours: 24,
        },
        [NODE],
      );
      await searchFor('node');

      expect(screen.queryByTestId('orb-cache-notice')).not.toBeInTheDocument();
    });
  });
});
