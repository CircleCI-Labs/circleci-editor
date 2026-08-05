/**
 * Shared, session-cached accessor for the Xcode versions CircleCI's own table
 * lists (issue #211), modelled on `useResourceClasses` -- deliberately the same
 * shape, because the two fields sit next to each other in the same dialog and
 * must not behave differently while their data is in flight.
 *
 * Three states and no fourth:
 *
 *  - `undefined` -- the one fetch is in flight. Callers render their own
 *    fallback (whatever version the config already has, plus free text), never a
 *    spinner.
 *  - `derived: true` -- the list from the documentation the host is serving.
 *  - `derived: false` with a `reason` -- a list the UI must label as possibly
 *    dated, or an empty one. Either way the field says so.
 *
 * A rejected fetch resolves to the third state rather than staying pending, so
 * there is no path to a control that waits forever.
 */
import { useEffect, useState } from 'react';

import { getXcodeVersions } from '~/lib/rpc/client';

import type { XcodeVersionsResponse } from './types';

/**
 * What callers get when even the request failed.
 *
 * Deliberately empty, and with an empty `default`. The host already falls back to
 * the table embedded in its own binary when it cannot read the one it is serving
 * (see `guides.XcodeVersions`), so the only way to reach *this* is the host being
 * unreachable. A literal version here would be exactly the mistake issue #203
 * records -- and it would be worse than nothing, because a field that offers one
 * unverified version looks as authoritative as one that offers ten verified ones.
 */
function unreachableHostResponse(): XcodeVersionsResponse {
  return {
    versions: [],
    default: '',
    derived: false,
    reason:
      "This app's own local server didn't return CircleCI's supported-Xcode table, so only free text is offered here.",
  };
}

let cached: Promise<XcodeVersionsResponse> | null = null;
/**
 * The resolved response, for the one caller that cannot await one.
 *
 * The YAML pane's `xcode:` completion source is that caller. CodeMirror
 * re-invokes a completion source on every keystroke, and
 * `circleciCompletionSource` deliberately keeps its async surface to the two
 * places that genuinely need it (live `cimg` tags, and the `orbs:` block) so that
 * everything else stays synchronous -- a property `completion.test.ts`'s `runSync`
 * helper asserts. Reading a resolved value out of the same module cache the field
 * uses is how the completion gets the same list without a third fetch and without
 * widening that surface. Exactly the shape `envVarCompletion` already uses against
 * the project-context store.
 */
let resolved: XcodeVersionsResponse | undefined;

function loadXcodeVersions(): Promise<XcodeVersionsResponse> {
  cached ??= getXcodeVersions()
    .catch(() => unreachableHostResponse())
    .then((response) => {
      resolved = response;
      return response;
    });
  return cached;
}

/**
 * Starts the shared fetch without waiting for it, so that a consumer which can
 * only read synchronously has something to read by the time a user reaches it.
 * Called from `YamlPane`, beside where it primes the project-context store for the
 * `$NAME` completion -- same reason, same place.
 *
 * Idempotent: the module cache means repeated calls cost nothing.
 */
export function primeXcodeVersions(): void {
  void loadXcodeVersions();
}

/**
 * The resolved response, or `undefined` when the fetch has not finished (or was
 * never started).
 *
 * `undefined` is a normal state, not an error, and callers must treat it as "offer
 * nothing" rather than "offer a guess" -- one keystroke later the answer is there,
 * and `reopenCompletionOnDelete` means even a deletion re-asks. Inventing a version
 * to fill a one-tick gap is precisely the class of bug issue #203 recorded.
 */
export function getLoadedXcodeVersions(): XcodeVersionsResponse | undefined {
  return resolved;
}

/**
 * Test-only escape hatch: clears the module cache so the next
 * `useXcodeVersions()` call fetches again instead of replaying whatever the first
 * test in a file happened to get back. Mirrors
 * `__resetResourceClassesCacheForTests`.
 */
export function __resetXcodeVersionsCacheForTests(): void {
  cached = null;
  resolved = undefined;
}

/**
 * Test-only: installs a resolved response with no fetch, for the completion
 * source's tests -- which need the synchronous accessor populated and have neither
 * a component to render nor a promise to await.
 */
export function __setLoadedXcodeVersionsForTests(
  response: XcodeVersionsResponse | undefined,
): void {
  resolved = response;
}

/** `undefined` while the at-most-once fetch is in flight; the response after. */
export function useXcodeVersions(): XcodeVersionsResponse | undefined {
  const [response, setResponse] = useState<XcodeVersionsResponse | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    loadXcodeVersions().then((resolved) => {
      if (!cancelled) setResponse(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return response;
}
