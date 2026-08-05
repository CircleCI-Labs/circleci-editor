/**
 * The single place that turns "a palette executor/step landed somewhere" --
 * whether from a drag-and-drop or from a card's click/`JobPicker` "Add" --
 * into an actual config edit (issue #71). Mirrors `useOrbInsertion.ts`'s own
 * shape and rationale deliberately: that hook is exactly the precedent for
 * "drag-and-drop and the keyboard-reachable equivalent must behave
 * identically", and there is no reason for the palette's own executor/step
 * flows to invent a second pattern for the same guarantee.
 *
 * An executor always creates a *new* job (issue #71: "dropping an executor
 * on the canvas opens a configure dialog... then creates the job + its
 * workflow entry as one undoable mutation") -- there is no drop target here
 * that retrofits an existing job's executor; that is deliberately out of
 * scope (see the PR description). A step always targets an *existing* job,
 * either a node on the canvas or the inspector's own steps list.
 */
import { useCallback, useMemo, useState } from 'react';

import type { GraphNode } from '~/lib/graph/buildGraph';
import {
  addJobFromExecutor,
  addStep,
  addWorkflowJobEntryContext,
  extractSharedCommand,
  extractSharedExecutor,
  type ExecutorSpec,
} from '~/lib/mutations/configMutations';
import { listExecutorNames } from '~/lib/graph/resolveExecutor';
import { getJobNames } from '~/lib/yaml/documentUtils';
import { useAppStore } from '~/state/appStore';
import { useProjectContextStore } from '~/state/projectContextStore';

import { generateUniqueJobName } from './dagUtils';
import type {
  ConfigureJobSubmitValues,
  PendingExecutorItem,
} from './palette/ConfigureJobDialog';
import {
  findBuiltinExecutor,
  type PaletteExecutorPayload,
} from './palette/paletteExecutors';
import { defaultStepValue } from './palette/paletteSteps';

/**
 * The workflow a dropped executor's job entry lands in when the config has
 * no `workflows:` block yet at all (issue #71's own empty-config
 * constraint) -- matches the name `DagPane`'s existing "Add workflow"
 * button already uses for the identical "nothing to pick from yet" case,
 * so a user who drops an executor before ever clicking that button doesn't
 * end up with two differently-named first workflows depending on which
 * path they happened to use.
 */
const DEFAULT_WORKFLOW_NAME = 'build-and-test';

function refusalMessage(node: GraphNode): string {
  if (node.kind === 'approval') {
    return `Can't add a step to "${node.alias}": it's a manual approval step, which has no job definition.`;
  }
  if (node.kind === 'orb') {
    return `Can't add a step to "${node.alias}": it's provided by the "${node.orbRef ?? ''}" orb, so there's no local job definition to edit.`;
  }
  return `Can't add a step to "${node.alias}": "${node.jobName}" isn't defined under jobs: in this config.`;
}

export function usePaletteInsertion(
  activeWorkflow: string | undefined,
  /**
   * Called with the new job's name right after `confirmPending` commits it
   * -- lets `DagPane` set its own `autoFocusNameNodeId` (local component
   * state, not this hook's concern) so the inspector's Job name field
   * autofocuses exactly the way the old "Add job" button already made it
   * do. Optional purely so a test/consumer that doesn't care can omit it.
   */
  onJobCreated?: (jobName: string) => void,
) {
  const doc = useAppStore((state) => state.doc);
  const mutate = useAppStore((state) => state.mutate);
  const selectNode = useAppStore((state) => state.selectNode);
  const setSelectedWorkflow = useAppStore((state) => state.setSelectedWorkflow);
  const [pendingItem, setPendingItem] = useState<PendingExecutorItem | null>(
    null,
  );
  /**
   * Issue #251: raises the "this context may not work here" notice *after* an
   * added context turns out to be restricted. Read as an action from the store
   * rather than taken as a prop so both context paths below get it without
   * threading it through `DagPane` -- and so the inspector's own `context:` field
   * can call the same action for the same guarantee.
   */
  const noteContextAdded = useProjectContextStore(
    (state) => state.noteContextAdded,
  );

  // Memoized (not recomputed inline) so `openConfigureFor`/
  // `openConfigureForOrbExecutor` below get a stable dependency -- a fresh
  // array every render would defeat their own `useCallback` memoization.
  const existingJobNames = useMemo(() => (doc ? getJobNames(doc) : []), [doc]);
  const existingExecutorNames = useMemo(
    () => (doc ? listExecutorNames(doc) : []),
    [doc],
  );

  /** Surfaces `message` via the existing `editError` mechanism without touching the document -- see `useOrbInsertion.refuse`, which this mirrors exactly. */
  const refuse = useCallback(
    (message: string) => {
      mutate(() => {
        throw new Error(message);
      });
    },
    [mutate],
  );

  /** Opens `ConfigureJobDialog` for a built-in or local executor -- the shared entry point for both a card's `onActivate` (click) and a canvas drop. */
  const openConfigureFor = useCallback(
    (payload: PaletteExecutorPayload) => {
      const defaultJobName = generateUniqueJobName(existingJobNames);
      if (payload.source === 'builtin') {
        const def = findBuiltinExecutor(payload.builtinId);
        if (!def) return; // Defensive only -- every real payload's `builtinId` comes from `BUILTIN_EXECUTORS` itself.
        setPendingItem({ source: 'builtin', def, defaultJobName });
        return;
      }
      setPendingItem({
        source: 'local',
        executorName: payload.executorName,
        defaultJobName,
      });
    },
    [existingJobNames],
  );

  /** Opens the same dialog for an orb-provided executor -- reached from the Orbs section's "New job" action (see `OrbBrowser`/`Palette`), not from a drag payload; see this module's own doc comment for why orb executors don't get a canvas drop target here. */
  const openConfigureForOrbExecutor = useCallback(
    (orbRef: string, executorName: string) => {
      setPendingItem({
        source: 'orb',
        orbRef,
        executorName,
        defaultJobName: generateUniqueJobName(existingJobNames),
      });
    },
    [existingJobNames],
  );

  const cancelPending = useCallback(() => setPendingItem(null), []);

  const confirmPending = useCallback(
    (values: ConfigureJobSubmitValues) => {
      const item = pendingItem;
      if (!item) return;

      const executor: ExecutorSpec =
        item.source === 'builtin'
          ? {
              kind: item.def.mutationKind,
              image: values.image,
              resourceClass: values.resourceClass,
              dockerAuth: values.dockerAuth,
            }
          : item.source === 'local'
            ? { kind: 'local', executorName: item.executorName }
            : {
                kind: 'orb',
                orbRef: item.orbRef,
                executorName: item.executorName,
              };

      const workflowName = activeWorkflow ?? DEFAULT_WORKFLOW_NAME;
      mutate((d) =>
        addJobFromExecutor(d, {
          name: values.jobName,
          workflowName,
          executor,
          saveAsExecutor: values.saveAsExecutorName
            ? { name: values.saveAsExecutorName }
            : undefined,
        }),
      );
      // The mutation above auto-creates `workflowName` when it didn't exist
      // (mirrors `addJob`'s own `ensureSeq` behavior) -- if that's what just
      // happened, the store's own `selectedWorkflow` needs to catch up so
      // the DAG pane actually shows the workflow the new job landed in,
      // exactly as `DagPane.handleAddWorkflow` already does for its own
      // "Add workflow" button.
      if (!activeWorkflow) setSelectedWorkflow(workflowName);
      selectNode(values.jobName);
      onJobCreated?.(values.jobName);
      setPendingItem(null);
    },
    [
      activeWorkflow,
      mutate,
      onJobCreated,
      pendingItem,
      selectNode,
      setSelectedWorkflow,
    ],
  );

  /** Drop (or drag-over-reject) of a palette executor on the canvas background -- always opens the configure dialog; there's no "insert immediately" case the way an orb job without required params has, because a job name always has to be chosen. */
  const dropOnCanvas = useCallback(
    (payload: PaletteExecutorPayload) => {
      openConfigureFor(payload);
    },
    [openConfigureFor],
  );

  /** A palette step dropped directly on the canvas background (not a job node) has nowhere to go -- refused the same way `useOrbInsertion.dropOnCanvas` refuses a non-job orb element. */
  const refuseStepOnCanvas = useCallback(() => {
    refuse(
      'Drop a step onto a job node instead -- the canvas background only accepts executors (which create a new job).',
    );
  }, [refuse]);

  /** Issue #105: a context dropped on the canvas background has nowhere to go -- it attaches to a specific workflow *entry*, not to the workflow at large. Refused with a pointer to the actual target; like `refuseStepOnCanvas`, an unreachable backstop in normal use because `handleCanvasDragOver` already shows this drop as invalid. */
  const refuseContextOnCanvas = useCallback(() => {
    refuse(
      'Drop a context onto a job node instead -- a context applies to one job in the workflow, not to the canvas.',
    );
  }, [refuse]);

  /** A palette executor dropped on an existing job node has nowhere sensible to go either -- retrofitting a job's executor is out of scope here (see the module doc comment); refused with a pointer to the actual target. */
  const refuseExecutorOnJobNode = useCallback(() => {
    refuse(
      'Drop an executor onto the canvas background to create a new job -- job nodes aren’t a target for another executor.',
    );
  }, [refuse]);

  /** Handles a step dropped on `node` (a rendered graph node in the DAG canvas). */
  const dropStepOnJobNode = useCallback(
    (node: GraphNode, stepKey: string) => {
      const isValidTarget = node.kind === 'job' && node.isDefined;
      if (!isValidTarget) {
        refuse(refusalMessage(node));
        return;
      }
      mutate((d) => addStep(d, node.jobName, defaultStepValue(stepKey)));
    },
    [mutate, refuse],
  );

  /**
   * Handles a context dropped on `node` (issue #105) -- appends it to that
   * *workflow entry's* `context:` list.
   *
   * The target rule is deliberately looser than `dropStepOnJobNode`'s: a
   * context is a key of the workflow entry, not of the job definition, so an
   * orb-provided job is a valid target here even though it has no local
   * `jobs:` entry a step could be added to. Approval entries are refused --
   * nothing runs, so a context has nothing to supply.
   *
   * Needs `activeWorkflow` because the same job can appear in several
   * workflows (and, aliased, several times in one) with different contexts, so
   * `node.id` alone does not identify which entry to edit.
   */
  const dropContextOnJobNode = useCallback(
    (node: GraphNode, contextName: string) => {
      if (!activeWorkflow) {
        refuse(
          `Can’t add the "${contextName}" context: no workflow is selected.`,
        );
        return;
      }
      if (node.kind === 'approval') {
        refuse(
          `Can’t add the "${contextName}" context to "${node.alias}": it’s a manual approval step, so nothing runs that could use a context.`,
        );
        return;
      }
      if (node.kind === 'job' && !node.isDefined) {
        refuse(
          `Can’t add the "${contextName}" context to "${node.alias}": "${node.jobName}" isn’t defined under jobs: in this config.`,
        );
        return;
      }
      mutate((d) =>
        addWorkflowJobEntryContext(d, activeWorkflow, node.id, contextName),
      );
      // After the edit, never instead of it (issue #251). The splice above is
      // synchronous and stays that way; the notice arrives when the restrictions
      // answer does, and warns rather than blocks.
      void noteContextAdded(contextName, node.id);
    },
    [activeWorkflow, mutate, noteContextAdded, refuse],
  );

  /**
   * The keyboard-reachable equivalent of `dropContextOnJobNode` -- the
   * Contexts section's own entry picker. Drag-and-drop must never be the only
   * path to an edit (the palette's own accessibility constraint from #88), and
   * this is the same mutation with the same workflow-entry semantics.
   */
  const addContextToJobEntry = useCallback(
    (nodeId: string, contextName: string) => {
      if (!activeWorkflow) {
        refuse(
          `Can’t add the "${contextName}" context: no workflow is selected.`,
        );
        return;
      }
      mutate((d) =>
        addWorkflowJobEntryContext(d, activeWorkflow, nodeId, contextName),
      );
      void noteContextAdded(contextName, nodeId);
    },
    [activeWorkflow, mutate, noteContextAdded, refuse],
  );

  /** Handles a step dropped at `index` in `jobName`'s steps (the inspector's own drop target). */
  const dropStepOnSteps = useCallback(
    (jobName: string, index: number, stepKey: string) => {
      mutate((d) => addStep(d, jobName, defaultStepValue(stepKey), index));
    },
    [mutate],
  );

  /** The `JobPicker` "Add" keyboard path for a step card -- always appends. */
  const addStepToJob = useCallback(
    (jobName: string, stepKey: string) => {
      mutate((d) => addStep(d, jobName, defaultStepValue(stepKey)));
    },
    [mutate],
  );

  /**
   * Issue #79: the palette's Commands section adds a reference to one of
   * this config's own `commands:` entries -- a bare string step naming it,
   * exactly what `- <command-name>` already means to CircleCI (mirrors
   * `describeStep`'s `'command'`/`'bare'` step shapes in the inspector).
   * Kept separate from `addStepToJob` (rather than folding the command name
   * into `defaultStepValue`'s lookup table) because a local command has no
   * fixed catalogue entry the way a step keyword does -- its name *is* the
   * step value, with nothing to look up.
   */
  const addCommandToJob = useCallback(
    (jobName: string, commandName: string) => {
      mutate((d) => addStep(d, jobName, commandName));
    },
    [mutate],
  );

  /**
   * Issue #79's highest-value item: performs the AST-level move
   * `DuplicationSuggestions` offers once a user accepts it. Both
   * `extractSharedExecutor`/`extractSharedCommand` re-verify the jobs still
   * match immediately before mutating (see their own doc comments) and
   * throw if not, which -- same as every other mutation this hook calls --
   * the store surfaces via `editError` rather than silently doing nothing.
   */
  const extractExecutor = useCallback(
    (jobNames: string[], executorName: string) => {
      mutate((d) => extractSharedExecutor(d, jobNames, executorName));
    },
    [mutate],
  );

  const extractCommand = useCallback(
    (jobNames: string[], commandName: string) => {
      mutate((d) => extractSharedCommand(d, jobNames, commandName));
    },
    [mutate],
  );

  return {
    existingJobNames,
    existingExecutorNames,
    pendingItem,
    openConfigureFor,
    openConfigureForOrbExecutor,
    confirmPending,
    cancelPending,
    dropOnCanvas,
    refuseStepOnCanvas,
    refuseContextOnCanvas,
    refuseExecutorOnJobNode,
    dropStepOnJobNode,
    dropContextOnJobNode,
    addContextToJobEntry,
    dropStepOnSteps,
    addStepToJob,
    addCommandToJob,
    extractExecutor,
    extractCommand,
  };
}

export type UsePaletteInsertion = ReturnType<typeof usePaletteInsertion>;
