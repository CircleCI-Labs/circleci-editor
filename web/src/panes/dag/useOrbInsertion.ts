/**
 * The single place that turns "an orb element landed somewhere" -- whether
 * from a drag-and-drop or from an orb browser "Add" button -- into an
 * actual config edit. Centralising this (rather than letting `DagPane`,
 * `JobNode`, and `Inspector` each reimplement it) is what keeps drag-and-drop
 * and the keyboard-reachable "Add" affordance behaving identically, as
 * required by M5's accessibility bar.
 *
 * Every entry point funnels through `beginInsertion`, which either inserts
 * immediately (no required parameters) or opens the parameter dialog
 * (`ParamsDialog`, rendered by `DagPane`) and waits for `confirmPending`.
 * A refused drop (wrong kind for the target, or a target with no local job
 * definition) is reported by calling `mutate()` with a function that just
 * throws -- the same path a real mutation failure takes -- so the existing
 * `editError` banner in `Inspector` is the single place refusal messages
 * surface, and the document is provably left untouched (the thrown error
 * happens before the mutation layer is ever called).
 */
import { useCallback, useState } from 'react';

import type { GraphNode } from '~/lib/graph/buildGraph';
import {
  insertOrbJob,
  insertOrbStep,
  setJobExecutorFromOrb,
} from '~/lib/mutations/configMutations';
import type { OrbDragPayload } from '~/lib/orbs/dragPayload';
import { defaultParamValues } from '~/lib/orbs/snippets';
import type { OrbElement } from '~/lib/orbs/types';
import { useAppStore } from '~/state/appStore';

type InsertionTarget =
  | { type: 'workflow'; workflowName: string }
  | { type: 'steps'; jobName: string; index?: number }
  | { type: 'executor'; jobName: string };

interface PendingInsertion {
  orbRef: string;
  element: OrbElement;
  target: InsertionTarget;
}

function refusalMessage(
  node: GraphNode,
  action: 'a step' | 'an executor',
): string {
  if (node.kind === 'approval') {
    return `Can't add ${action} to "${node.alias}": it's a manual approval step, which has no job definition.`;
  }
  if (node.kind === 'orb') {
    return `Can't add ${action} to "${node.alias}": it's provided by the "${node.orbRef ?? ''}" orb, so there's no local job definition to edit.`;
  }
  return `Can't add ${action} to "${node.alias}": "${node.jobName}" isn't defined under jobs: in this config.`;
}

export function useOrbInsertion(activeWorkflow: string | undefined) {
  const mutate = useAppStore((state) => state.mutate);
  const [pending, setPending] = useState<PendingInsertion | null>(null);

  /** Surfaces `message` via the existing `editError` mechanism without touching the document. */
  const refuse = useCallback(
    (message: string) => {
      mutate(() => {
        throw new Error(message);
      });
    },
    [mutate],
  );

  const performInsert = useCallback(
    (
      orbRef: string,
      element: OrbElement,
      target: InsertionTarget,
      values: Record<string, unknown>,
    ) => {
      switch (target.type) {
        case 'workflow':
          mutate((doc) =>
            insertOrbJob(doc, {
              workflowName: target.workflowName,
              orbRef,
              jobName: element.name,
              params: values,
            }),
          );
          return;
        case 'steps':
          mutate((doc) =>
            insertOrbStep(doc, {
              jobName: target.jobName,
              orbRef,
              commandName: element.name,
              params: values,
              index: target.index,
            }),
          );
          return;
        case 'executor':
          mutate((doc) =>
            setJobExecutorFromOrb(doc, {
              jobName: target.jobName,
              orbRef,
              executorName: element.name,
            }),
          );
      }
    },
    [mutate],
  );

  const beginInsertion = useCallback(
    (orbRef: string, element: OrbElement, target: InsertionTarget) => {
      // Executor references are written as a plain "<alias>/<name>" string
      // (`setJobExecutorFromOrb`); there's nowhere in that shape to carry
      // parameter values, so an orb executor's required parameters (rare in
      // practice) can't be filled in from here -- it always inserts
      // immediately, and any required value has to be added by hand in the
      // resulting YAML. That's a deliberate, narrower scope, not a bug.
      if (target.type === 'executor') {
        performInsert(orbRef, element, target, {});
        return;
      }

      const hasRequired = element.parameters.some((p) => p.required);
      if (!hasRequired) {
        performInsert(orbRef, element, target, defaultParamValues(element));
        return;
      }
      setPending({ orbRef, element, target });
    },
    [performInsert],
  );

  const confirmPending = useCallback(
    (values: Record<string, unknown>) => {
      if (!pending) return;
      performInsert(pending.orbRef, pending.element, pending.target, values);
      setPending(null);
    },
    [pending, performInsert],
  );

  const cancelPending = useCallback(() => setPending(null), []);

  /** Drop (or programmatic add) of an orb job -- the DAG canvas is the only valid target. */
  const insertJob = useCallback(
    (orbRef: string, element: OrbElement) => {
      if (!activeWorkflow) {
        refuse('Add a workflow before adding an orb job.');
        return;
      }
      beginInsertion(orbRef, element, {
        type: 'workflow',
        workflowName: activeWorkflow,
      });
    },
    [activeWorkflow, beginInsertion, refuse],
  );

  /** Drop (or programmatic add) of an orb command onto `jobName`'s steps, optionally at `index` (default: append). */
  const insertCommand = useCallback(
    (orbRef: string, element: OrbElement, jobName: string, index?: number) => {
      beginInsertion(orbRef, element, { type: 'steps', jobName, index });
    },
    [beginInsertion],
  );

  /** Drop (or programmatic add) of an orb executor onto `jobName`. */
  const insertExecutor = useCallback(
    (orbRef: string, element: OrbElement, jobName: string) => {
      beginInsertion(orbRef, element, { type: 'executor', jobName });
    },
    [beginInsertion],
  );

  /** Handles a drop of `payload` directly on the DAG canvas background. */
  const dropOnCanvas = useCallback(
    (payload: OrbDragPayload) => {
      if (payload.kind !== 'job') {
        refuse(
          `Drop "${payload.element.name}" onto a job node instead -- the canvas only accepts orb jobs.`,
        );
        return;
      }
      insertJob(payload.orbRef, payload.element);
    },
    [insertJob, refuse],
  );

  /** Handles a drop of `payload` on `node` (a rendered graph node in the DAG canvas). */
  const dropOnJobNode = useCallback(
    (node: GraphNode, payload: OrbDragPayload) => {
      if (payload.kind === 'job') {
        refuse(
          `Drop "${payload.element.name}" onto the canvas background to add it to the workflow -- job nodes aren't a target for another job.`,
        );
        return;
      }
      const isValidTarget = node.kind === 'job' && node.isDefined;
      if (!isValidTarget) {
        refuse(
          refusalMessage(
            node,
            payload.kind === 'command' ? 'a step' : 'an executor',
          ),
        );
        return;
      }
      if (payload.kind === 'command') {
        insertCommand(payload.orbRef, payload.element, node.jobName);
      } else {
        insertExecutor(payload.orbRef, payload.element, node.jobName);
      }
    },
    [insertCommand, insertExecutor, refuse],
  );

  /** Handles a drop of `payload` at `index` in `jobName`'s steps list (the inspector's own drop target). */
  const dropOnSteps = useCallback(
    (jobName: string, index: number, payload: OrbDragPayload) => {
      if (payload.kind !== 'command') {
        refuse(
          `Drop "${payload.element.name}" onto ${payload.kind === 'job' ? 'the canvas' : 'a job node'} instead -- the steps list only accepts orb commands.`,
        );
        return;
      }
      insertCommand(payload.orbRef, payload.element, jobName, index);
    },
    [insertCommand, refuse],
  );

  return {
    /** The element awaiting required-parameter input, or `null` when no dialog should show. */
    pendingElement: pending?.element ?? null,
    confirmPending,
    cancelPending,
    dropOnCanvas,
    dropOnJobNode,
    dropOnSteps,
    insertJob,
    insertCommand,
    insertExecutor,
  };
}

export type UseOrbInsertion = ReturnType<typeof useOrbInsertion>;
