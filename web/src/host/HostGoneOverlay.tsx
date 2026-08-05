/**
 * The blocking notice issue #110 asks for: once `useHostLiveness` reports
 * the host is gone, this renders a full-viewport modal over the *entire*
 * app -- not a toast, not a corner banner -- because the whole point is
 * that the page must stop presenting itself as a live editor. Everything
 * underneath (DAG, inspector, YAML pane) is still mounted and still
 * responsive, exactly as issue #110 describes; this overlay's job is to
 * make sure nobody can act on that responsiveness without first seeing
 * this.
 *
 * There is no dismiss: no close button, `Escape` and outside-click are
 * both suppressed. A user who has genuinely lost the process is not being
 * held hostage by that -- there is nothing behind this dialog to interact
 * with productively any more, since the one thing this whole page exists
 * to let them do (save) can no longer work.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { useAppStore } from '~/state/appStore';

import { useHostLiveness } from './hostLiveness';
import { copyToClipboard, downloadText } from './recoverDocument';

/** Falls back to a generic name if `configPath` is empty (e.g. still loading) -- `download` needs *some* filename. Splits on both separators since the host reports a native path, which is backslash-separated on Windows. */
function filenameFromPath(configPath: string): string {
  const parts = configPath.split(/[/\\]/);
  return parts[parts.length - 1] || 'config.yml';
}

export function HostGoneOverlay() {
  const alive = useHostLiveness();
  const isDirty = useAppStore((state) => state.isDirty);
  const text = useAppStore((state) => state.text);
  const configPath = useAppStore((state) => state.configPath);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  // Best-effort only, and only when there is nothing left to lose:
  // `window.close()` is restricted by every browser to windows script
  // opened (`window.open()`) or -- per Chromium's implementation of the
  // same check -- whose tab has never navigated away from its first page,
  // which describes both this single-page app's own tabs and a chromeless
  // `--app=` window (see `internal/host/browser.go`'s `runDetached`; issue
  // #110 asks specifically whether that mode's window, a Chromium process
  // this tool launched directly, can be closed from here). It is silently
  // a no-op everywhere else -- there is no error to catch, browsers simply
  // decline -- so this never risks anything beyond "nothing happened",
  // and it never fires while `isDirty`, so it can never close a window
  // before its recovery actions below have had a chance to be seen.
  useEffect(() => {
    if (alive || isDirty) return;
    window.close();
  }, [alive, isDirty]);

  if (alive) return null;

  const filename = filenameFromPath(configPath);

  const handleDownload = () => downloadText(filename, text);
  const handleCopy = () => {
    copyToClipboard(text).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  };

  return (
    <RadixDialog.Root open modal>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <RadixDialog.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          aria-describedby="host-gone-description"
          className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-cc-danger/40 bg-cc-panel p-6 shadow-xl"
        >
          <Badge tone="danger" className="mb-3">
            Editor process not running
          </Badge>

          <RadixDialog.Title className="mb-2 text-base font-semibold text-cc-text">
            Connection to circleci-editor was lost
          </RadixDialog.Title>

          <p
            id="host-gone-description"
            className="mb-4 text-sm text-cc-text-muted"
          >
            The local process that opened this window has stopped -- for
            example, with Ctrl-C in its terminal. This tab still shows your
            document, but it can no longer save: without this notice, Save would
            look normal right up until it failed.
          </p>

          {isDirty ? (
            <>
              <p className="mb-3 text-sm font-medium text-cc-danger">
                You have changes here that were never written to{' '}
                <span className="font-mono">{configPath || filename}</span>. Get
                them out of this tab now, then start circleci-editor again to
                save them for real.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={handleDownload}>
                  Download {filename}
                </Button>
                <Button variant="secondary" size="sm" onClick={handleCopy}>
                  {copyState === 'copied'
                    ? 'Copied'
                    : copyState === 'failed'
                      ? 'Copy failed -- try Download'
                      : 'Copy to clipboard'}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-cc-text-muted">
              Everything here was already saved, so there is nothing to lose.
              You can close this tab.
            </p>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
