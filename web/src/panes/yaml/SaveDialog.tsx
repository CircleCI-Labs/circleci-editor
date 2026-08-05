import * as RadixDialog from '@radix-ui/react-dialog';
import { useMemo } from 'react';

import { Button } from '~/design/components/Button';
import { DiffView } from '~/design/components/DiffView';
import { Spinner } from '~/design/components/Spinner';
import { unifiedDiff } from '~/lib/yaml/diff';
import { useAppStore } from '~/state/appStore';

interface SaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
}

/**
 * A confirmation dialog that shows the exact unified diff between what's on
 * disk and what's about to be saved. Because every visual edit in this app
 * is a surgical AST mutation, that diff should normally be tiny -- seeing
 * it, in full, before confirming is the trust mechanism that lets users
 * believe their comments and formatting really did survive.
 *
 * Autosave intentionally never opens this dialog -- it's an explicit,
 * opt-in "save immediately" mode, so it calls `save()` directly.
 */
export function SaveDialog({ open, onOpenChange, filename }: SaveDialogProps) {
  const text = useAppStore((state) => state.text);
  const savedText = useAppStore((state) => state.savedText);
  const status = useAppStore((state) => state.status);
  const save = useAppStore((state) => state.save);

  const lines = useMemo(
    () => unifiedDiff(savedText, text, filename),
    [savedText, text, filename],
  );
  const hasChanges = lines.length > 0;
  const isSaving = status === 'saving';

  const handleConfirm = () => {
    void save().then(() => onOpenChange(false));
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
            <RadixDialog.Title className="text-sm font-semibold text-cc-text">
              Review changes to <span className="font-mono">{filename}</span>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close dialog">
                Close
              </Button>
            </RadixDialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <DiffView lines={lines} emptyMessage="No changes to save." />
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
            <RadixDialog.Close asChild>
              <Button variant="secondary" size="sm">
                Cancel
              </Button>
            </RadixDialog.Close>
            <Button
              variant="primary"
              size="sm"
              disabled={!hasChanges || isSaving}
              onClick={handleConfirm}
            >
              {isSaving ? <Spinner size={12} label="Saving" /> : null}
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
