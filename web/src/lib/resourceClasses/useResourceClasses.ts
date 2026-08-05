/**
 * Shared, session-cached accessor for the resource classes CircleCI's own
 * tables list (issue #181), modelled on `useGuides` and
 * `useCircleciSchema` for the same reason: several controls in two panes want
 * the same small list, and each of them can remount (a preset switch, a pane
 * move, a dialog opening and closing) without that costing another request.
 *
 * Three states and no fourth:
 *
 *  - `undefined` -- the one fetch is in flight. Callers render their own
 *    fallback (the executor's default class plus free text), never a spinner:
 *    this populates a dropdown inside a dialog that has already opened, and
 *    briefly disabling it would be worse than briefly offering less.
 *  - `derived: true` -- the list from the documentation the host is serving.
 *  - `derived: false` with a `reason` -- a list the UI must label as possibly
 *    dated, or an empty one. Either way the field says so.
 *
 * A rejected fetch resolves to the third state rather than staying pending, so
 * there is no path to a control that waits forever. That is the project-wide
 * "degrade honestly" invariant, enforced here rather than in each
 * component.
 */
import { useEffect, useState } from 'react';

import { getResourceClasses } from '~/lib/rpc/client';

import type { ResourceClassesResponse } from './types';

/**
 * What callers get when even the request failed.
 *
 * Deliberately empty rather than a hardcoded class list. The host already falls
 * back to the resource tables embedded in its own binary when it cannot read the
 * ones it is serving (see `guides.ResourceClasses`), so the only way to reach
 * *this* is the host being unreachable -- at which point there is no config
 * loaded, no canvas and no executor field to fill in. A retyped list here would
 * be a second thing to drift, kept alive for a state the user cannot see.
 *
 * The one thing a picker still has in this state is its own executor's default
 * class, which its card knows without asking anybody, plus free text. See
 * `ResourceClassField`.
 */
function unreachableHostResponse(): ResourceClassesResponse {
  return {
    environments: [],
    derived: false,
    reason:
      "This app's own local server didn't return CircleCI's resource-class tables, so only free text is offered here.",
  };
}

let cached: Promise<ResourceClassesResponse> | null = null;

function loadResourceClasses(): Promise<ResourceClassesResponse> {
  cached ??= getResourceClasses().catch(() => unreachableHostResponse());
  return cached;
}

/**
 * Test-only escape hatch: clears the module cache so the next
 * `useResourceClasses()` call fetches again instead of replaying whatever the
 * first test in a file happened to get back. Mirrors
 * `__resetGuidesCacheForTests`.
 */
export function __resetResourceClassesCacheForTests(): void {
  cached = null;
}

/** `undefined` while the at-most-once fetch is in flight; the response after. */
export function useResourceClasses(): ResourceClassesResponse | undefined {
  const [response, setResponse] = useState<ResourceClassesResponse | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    loadResourceClasses().then((resolved) => {
      if (!cancelled) setResponse(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return response;
}
