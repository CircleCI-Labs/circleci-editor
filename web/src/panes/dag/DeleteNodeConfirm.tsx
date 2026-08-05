import { useEffect, useRef } from 'react';

import { Button } from '~/design/components/Button';
import { ReferenceImpactList } from '~/design/components/ReferenceImpactList';
import type { GraphNode } from '~/lib/graph/buildGraph';
import type { ReferenceImpact as Impact } from '~/lib/mutations/jobReferences';

interface DeleteNodeConfirmProps {
  node: GraphNode;
  /** True only for a locally-defined `job` node -- see `DagPane`. */
  canDeleteJob: boolean;
  /**
   * What "Delete job" would actually touch (issue #12) -- the concrete list of
   * sites, the caveat that dependents are not re-wired, and any reason the
   * delete will be refused. `undefined` when there is no job definition to
   * delete (`canDeleteJob` false), where there is nothing to enumerate.
   */
  deleteImpact?: Impact;
  onRemoveFromWorkflow: () => void;
  onDeleteJob: () => void;
  onCancel: () => void;
}

/**
 * "Remove from workflow" and "Delete job" are deliberately two separate,
 * explicitly-labeled buttons, never a single "Delete" action: removing a
 * workflow entry only detaches this one reference, while deleting the job
 * also destroys its definition (and, per `deleteJob`, prunes it out of every
 * *other* workflow that also uses it). Silently doing the latter when the
 * user meant the former would be a destructive surprise, so both intents
 * are surfaced side by side and neither is the "default" / pre-focused one.
 *
 * Issue #12 makes the second of those concrete rather than abstract: instead
 * of "this also removes it from every other workflow", the dialog lists the
 * actual sites ("workflow \"main\": removed from deploy's requires:") and says
 * plainly that `deploy` will *not* be re-pointed at whatever the deleted job
 * required.
 *
 * There is deliberately no "don't ask again" here, unlike the rename prompt:
 * this is a chooser between two different intents, not a yes/no confirmation,
 * so suppressing it would have to silently pick one of them. See
 * `state/confirmStore.ts`'s `CONFIRM_KINDS`.
 */
export function DeleteNodeConfirm({
  node,
  canDeleteJob,
  deleteImpact,
  onRemoveFromWorkflow,
  onDeleteJob,
  onCancel,
}: DeleteNodeConfirmProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const blocked = (deleteImpact?.blockers.length ?? 0) > 0;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Remove "${node.alias}"`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      /* `flex-col` with a scroll cap on the impact list alone (see its own
         className below), rather than `overflow-y-auto` on the whole popover:
         the graph pane can be short enough that a long impact list would
         otherwise push Cancel / Remove / Delete below the fold, and a
         destructive dialog whose buttons you have to scroll to find is worse
         than one whose detail you do. */
      className="absolute inset-x-2 top-2 z-20 flex max-h-[calc(100%-1rem)] flex-col rounded-md border border-cc-border-strong bg-cc-panel p-3 text-xs shadow-xl outline-none"
    >
      <p className="mb-2 font-medium text-cc-text">
        Remove <span className="font-mono">{node.alias}</span>?
      </p>
      <p className="mb-3 text-cc-text-muted">
        {canDeleteJob
          ? 'Take it out of this workflow only, or delete the job definition entirely.'
          : "Take it out of this workflow. This entry has no job definition of its own, so there's nothing else to delete."}
      </p>

      {canDeleteJob && deleteImpact ? (
        <ReferenceImpactList
          impact={deleteImpact}
          className="mb-3 min-h-0 shrink overflow-y-auto rounded border border-cc-border bg-cc-panel-raised p-2"
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={onRemoveFromWorkflow}>
          Remove from workflow
        </Button>
        {canDeleteJob ? (
          <Button
            variant="danger"
            size="sm"
            disabled={blocked}
            onClick={onDeleteJob}
          >
            Delete job
          </Button>
        ) : null}
      </div>
    </div>
  );
}
