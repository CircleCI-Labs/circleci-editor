import * as RadixDialog from '@radix-ui/react-dialog';
import { useMemo } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DiffView } from '~/design/components/DiffView';
import {
  applyAction,
  describeAction,
  type ProposedAction,
} from '~/lib/ai/actions';
import { cloneDocument } from '~/lib/yaml/documentUtils';
import { unifiedDiff } from '~/lib/yaml/diff';
import { useAppStore } from '~/state/appStore';

interface ProposeChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ProposedAction;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * The AI pane's approval surface (issue #92's central constraint): before a
 * single byte of a proposed change is written, the user sees the exact
 * diff it would produce, computed the same way `SaveDialog` computes its
 * own -- clone the live document, apply the edit, `unifiedDiff` the
 * result against the current text -- and reusing that same `DiffView`
 * rendering, per the issue's explicit instruction to reuse the existing
 * diff/approval surface rather than inventing a second one.
 *
 * The one deliberate difference from `SaveDialog`: this diffs against
 * `appStore`'s current in-memory `text`, not `savedText` -- approving here
 * only ever applies the edit to the open document (via
 * `useAiStore.approveAction`, which calls `appStore.mutate()`), exactly
 * like any other visual edit. Writing it to disk still requires the user's
 * separate, explicit Save step afterwards -- this dialog never
 * saves anything itself.
 */
export function ProposeChangeDialog({
  open,
  onOpenChange,
  action,
  onApprove,
  onReject,
}: ProposeChangeDialogProps) {
  const doc = useAppStore((state) => state.doc);
  const currentText = useAppStore((state) => state.text);
  const configPath = useAppStore((state) => state.configPath);

  const preview = useMemo(() => {
    if (!doc)
      return {
        error:
          'The config has a YAML syntax error right now, so this change cannot be previewed.',
      };
    try {
      const clone = cloneDocument(doc);
      applyAction(clone, action);
      return { text: clone.toString() };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This change could not be applied.',
      };
    }
  }, [doc, action]);

  const lines = useMemo(
    () =>
      preview.text !== undefined
        ? unifiedDiff(currentText, preview.text, configPath || 'config.yml')
        : [],
    [preview.text, currentText, configPath],
  );

  const canApprove = preview.text !== undefined && lines.length > 0;

  const handleApprove = () => {
    onApprove();
    onOpenChange(false);
  };

  const handleReject = () => {
    onReject();
    onOpenChange(false);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-black/60" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 flex max-h-[80vh] w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-cc-border-strong bg-cc-panel shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-cc-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone="info">Proposed change</Badge>
              <RadixDialog.Title className="min-w-0 truncate text-sm font-semibold text-cc-text">
                {describeAction(action)}
              </RadixDialog.Title>
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close dialog">
                Close
              </Button>
            </RadixDialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {preview.error ? (
              <p className="p-6 text-center text-sm text-cc-danger">
                {preview.error}
              </p>
            ) : (
              <DiffView
                lines={lines}
                emptyMessage="This change would have no effect."
              />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-cc-border px-4 py-3">
            <p className="text-xs text-cc-text-faint">
              Applied to the open document only -- you still choose when to
              save.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleReject}>
                Reject
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canApprove}
                onClick={handleApprove}
              >
                Apply to editor
              </Button>
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
