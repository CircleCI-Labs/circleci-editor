/**
 * A small, realistic `GET /api/xcode-versions` response for tests that need one.
 *
 * Modelled on the vendored table's actual shape as of circleci-docs 447dc483 --
 * newest-first, a beta and a release candidate at the top, and a `16.4.0` row
 * whose "Config" value and human label genuinely disagree ("Xcode 16.4"), which
 * is the case that would break any code tempted to derive one from the other.
 *
 * Deliberately shorter than the real table: a fixture that tried to be the table
 * would be a second copy of it to keep in step, which is the whole failure mode
 * this feature exists to remove. Tests that must agree with the real table assert
 * against the vendored snapshot directly -- see `vendoredXcodeTable.test.ts`.
 */
import type { XcodeVersionsResponse } from './types';

export function xcodeVersionsFixture(): XcodeVersionsResponse {
  return {
    versions: [
      {
        version: '27.0',
        label: 'Xcode 27.0 (27A5228h)',
        spec: 'macOS Version 26.5.1',
        resourceClasses: ['m4pro.medium', 'm4pro.large'],
        prerelease: true,
        prereleaseKind: 'beta',
      },
      {
        version: '26.6',
        label: 'Xcode 26.6 (17F113)',
        spec: 'macOS Version 26.5.1',
        resourceClasses: ['m4pro.medium', 'm4pro.large'],
        prerelease: true,
        prereleaseKind: 'release candidate',
      },
      {
        version: '26.5',
        label: 'Xcode 26.5 (17F42)',
        spec: 'macOS Version 26.3.1',
        resourceClasses: ['m4pro.medium', 'm4pro.large'],
      },
      {
        version: '26.4.1',
        label: 'Xcode 26.4.1 (17E202)',
        spec: 'macOS Version 26.3',
        resourceClasses: ['m4pro.medium', 'm4pro.large'],
      },
      {
        version: '16.4.0',
        label: 'Xcode 16.4 (16F6)',
        spec: 'macOS Version 15.3.2',
        resourceClasses: ['m4pro.medium', 'm4pro.large'],
      },
    ],
    default: '26.5',
    derived: true,
  };
}

/**
 * A `fetch` implementation that answers `/api/xcode-versions` with `response` (the
 * fixture by default) and every other URL with `fallback`.
 *
 * URL-aware for the same reason `resourceClassesFetchStub` is: the components under
 * test make more than one request in a render, and a single-body stub would hand one
 * of them an already-consumed `Response`.
 */
export function xcodeVersionsFetchStub(
  fallback: unknown = {},
  response: XcodeVersionsResponse = xcodeVersionsFixture(),
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.includes('/api/xcode-versions') ? response : fallback;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}
