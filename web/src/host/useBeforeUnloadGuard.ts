/**
 * Warns before closing/reloading a tab with unsaved changes, independent
 * of whether the host is still reachable (issue #110 calls this out as
 * worth having on its own merits, separate from the host-liveness banner;
 * issue #177 is where the owner asked for it directly).
 * `beforeunload`'s confirmation prompt is the browser's, not ours -- the
 * `preventDefault()` plus setting `returnValue` is the (redundant-looking,
 * but each half required by a different browser) combination every
 * current browser needs to actually show one; no page-authored message
 * ever reaches it, by design of the spec.
 *
 * Two properties this has to keep, both from #177:
 *
 * - **Only when genuinely dirty.** A prompt on a clean document is worse
 *   than no prompt at all: it trains people to dismiss the dialog without
 *   reading it, and this is the same dialog that stands between them and
 *   losing real work. `hasUnsavedChanges` is the single definition of
 *   "dirty" for the whole session -- see its comment for why the open file's
 *   `isDirty` is not enough (a *different* file's unsaved edits survive
 *   switching away, by design) and why a stale `docCache` entry for
 *   the open file must not be believed.
 * - **Consistent with the host-gone notice.** When the host stops,
 *   `HostGoneOverlay` blocks the page and offers to copy or download the
 *   unsaved document. This is the mirror case -- the *page* going away
 *   rather than the host -- and it deliberately still fires when the host is
 *   already gone: with no host there is no Save left, so the overlay's
 *   recovery is the only route out and closing the tab is precisely what
 *   discards it.
 *
 * There is no in-app navigation to exempt: the SPA has no router, and the
 * actions that leave this document (the overlay's download, the docs pane's
 * external links) download a file or open a new tab rather than unloading
 * it.
 */
import { useEffect } from 'react';

import { hasUnsavedChanges, useAppStore } from '~/state/appStore';

export function useBeforeUnloadGuard(): void {
  const dirty = useAppStore(hasUnsavedChanges);

  useEffect(() => {
    if (!dirty) return;

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
