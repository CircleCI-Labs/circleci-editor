import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useState, type DragEvent, type KeyboardEvent } from 'react';

import type { GraphNode } from '~/lib/graph/buildGraph';
import type { LayoutDirection } from '~/lib/graph/layout';
import {
  isDraggingOrbKind,
  readOrbDragPayload,
  type OrbDragPayload,
} from '~/lib/orbs/dragPayload';
import {
  isDraggingPaletteContext,
  readPaletteContextDragPayload,
} from './palette/paletteContexts';
import { isDraggingPaletteExecutor } from './palette/paletteExecutors';
import {
  isDraggingPaletteStep,
  readPaletteStepDragPayload,
} from './palette/paletteSteps';

/**
 * Data carried by every `job`-type React Flow node; see `DagPane`.
 * Deliberately a `type`, not an `interface` -- React Flow's `Node<T>`
 * requires `T extends Record<string, unknown>`, and an `interface` (unlike
 * a plain object `type`) doesn't structurally satisfy that constraint
 * without an explicit index signature.
 */
export type JobNodeData = {
  node: GraphNode;
  direction: LayoutDirection;
  /**
   * Invoked when the user clicks this node's own delete affordance -- the
   * small "x" that appears once the node is selected. Distinct from
   * `DagPane`'s Delete/Backspace key handling, but both end up opening the
   * same "remove from workflow vs. delete job" confirm popover, since a
   * mouse click can't be intent-checked against a focused text input the
   * way a keypress can.
   */
  onRequestDelete?: (nodeId: string) => void;
  /**
   * Invoked when an orb command or executor is dropped on this node. Given
   * the node itself (not just its id) so the caller can decide, without a
   * second lookup, whether this is a valid target -- see
   * `useOrbInsertion.dropOnJobNode`, which owns that decision and the
   * refusal messaging when it isn't.
   */
  onDropElement?: (node: GraphNode, payload: OrbDragPayload) => void;
  /** Invoked when a palette step (issue #71) is dropped on this node -- always appends `stepKey`'s default value to the job's `steps:`; see `usePaletteInsertion.dropStepOnJobNode`, which owns the refusal messaging when this node isn't a valid target. */
  onDropStep?: (node: GraphNode, stepKey: string) => void;
  /** Invoked when a palette *executor* (issue #71) is dropped on this node -- always refused (creating a job is the only supported executor-drop outcome; see `usePaletteInsertion`'s own module doc), but still needs to go through the normal `editError` refusal path rather than silently doing nothing. */
  onDropExecutorRefused?: () => void;
  /**
   * Invoked when a CircleCI context (issue #105) is dropped on this node --
   * appends `contextName` to this *workflow entry's* `context:` list. Note
   * "entry", not "job": unlike a step, a context is not part of the job
   * definition, so the same job aliased twice in one workflow can carry
   * different contexts. See `usePaletteInsertion.dropContextOnJobNode`,
   * which owns the refusal messaging when this node isn't a valid target.
   */
  onDropContext?: (node: GraphNode, contextName: string) => void;
  /**
   * Issue #70: "it's really hard to hit that little circle to link, and
   * there's not really a good indication to go ahead and do that" --
   * dragging a connection is still the primary path (see `styles.css`'s
   * `.vce-dag-handle` for the larger hit area and hover/focus affordance),
   * but it's necessarily mouse-only. `onActivateHandle` is the keyboard
   * equivalent: pressing Enter/Space on either of this node's handles calls
   * it with this node's id, and `DagPane` runs a small two-step state
   * machine on top -- the first activation anywhere becomes the pending
   * "connect from" node, the second either completes the edge (via the
   * exact same `mutate(addRequire(...))` path a mouse drop uses, so cycle
   * prevention and error surfacing are identical) or, activated on the
   * *same* node again, cancels. See `DagPane.handleHandleActivate`.
   */
  onActivateHandle?: (nodeId: string) => void;
  /**
   * This node's id, if it is the pending "connect from" anchor of an
   * in-progress *keyboard* connection (see `onActivateHandle` above).
   * `undefined`/`false` otherwise. Used only for the `vce-dag-node--connect-source`
   * highlight -- mouse-drag's own valid/invalid feedback is pure CSS (see
   * `styles.css`'s `:has(.react-flow__handle.connectingfrom)` rules) since
   * React Flow already exposes that state on the handle element itself,
   * but the keyboard flow's "anchor" state lives in `DagPane`, not React
   * Flow, so it has to be threaded through node data instead.
   */
  isKeyboardConnectSource?: boolean;
  /**
   * Issue #148: the validation error(s) that name this node, already
   * formatted for display. Empty/absent when this node is not implicated --
   * which is the case for every node in a config that compiles, so a valid
   * pipeline gains no error furniture at all.
   *
   * Attribution comes from `lib/validation/diagnostics`' `matchesNode`, which
   * decides from an error's *structured* target (the job/executor/orb name it
   * named), never by looking for this node's name inside the message text.
   */
  diagnostics?: string[];
};

type JobNodeProps = NodeProps & {
  data: JobNodeData;
};

/**
 * The DAG pane's only node renderer, styled to echo CircleCI's own job
 * nodes: the job name in the same sans/roomier size production uses for its
 * label (issue #90 -- mono was this app's own choice, not production's, and
 * read as a code token rather than a name), plus small affordances for the
 * three node kinds and the two "something's off" flags (undefined job,
 * matrix job). Memoised because a workflow can have dozens of these and
 * they never need to re-render unless their own data (which includes
 * `selected`, via `NodeProps`) changes.
 */
function JobNodeImpl({ id, data, selected, dragging }: JobNodeProps) {
  const {
    node,
    direction,
    onRequestDelete,
    onDropElement,
    onDropStep,
    onDropExecutorRefused,
    onDropContext,
    onActivateHandle,
    isKeyboardConnectSource,
    diagnostics,
  } = data;
  const hasDiagnostic = (diagnostics?.length ?? 0) > 0;
  const isHorizontal = direction === 'RIGHT';
  const targetPosition = isHorizontal ? Position.Left : Position.Top;
  const sourcePosition = isHorizontal ? Position.Right : Position.Bottom;

  const label = node.alias;
  // Issue #24: a group whose `jobs:` this app could not read as a list at
  // all -- distinct from a group that resolved to zero (or more) members,
  // and it must never render the same way one of those does (see
  // `getJobGroupMembers`'s own doc comment on why `undefined` and `[]` mean
  // different things here).
  const isUnresolvedGroup =
    node.kind === 'group' && node.groupMembers === undefined;
  // Issue #12: a `missing` placeholder stands for a `requires:` target nothing
  // in the workflow provides. It has no job name of its own worth showing (its
  // `jobName` is a copy of the id) and no editing affordances at all -- see
  // `DagPane`'s `flowNodes`, which withholds every callback for it.
  const isMissing = node.isMissing === true;
  const showJobName =
    !isMissing && node.kind !== 'approval' && node.alias !== node.jobName;

  // Enter/Space on a handle activates it exactly like a click would for any
  // other `role="button"` element -- necessary here because these are plain
  // `<div>`s (React Flow's `Handle`, not a real `<button>`), which get no
  // such behaviour from the browser for free.
  const handleHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onActivateHandle) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivateHandle(id);
  };

  // `null` when nothing relevant is being dragged over this node; otherwise
  // whether *this* node would accept the drop -- a command/executor/palette
  // step can only land on a locally-defined job (see
  // `useOrbInsertion.dropOnJobNode`/`usePaletteInsertion.dropStepOnJobNode`
  // for the exact rule this mirrors). A palette *executor* is always
  // 'invalid' here -- it only ever creates a new job on the canvas
  // background, never retrofits an existing one (see `JobNodeData`'s own
  // doc comment on `onDropExecutorRefused`). Purely a rendering hint: the
  // actual accept/refuse decision, including the user-facing message on
  // refusal, is made once at `drop` time.
  const [dragState, setDragState] = useState<'valid' | 'invalid' | null>(null);
  const acceptsDrop = node.kind === 'job' && node.isDefined;

  // A context has its own rule, deliberately looser than `acceptsDrop`:
  // `context:` is a key of the *workflow entry*, not of the job definition,
  // so an orb-provided job (never listed under `jobs:`) is a perfectly valid
  // target where a *step* would not be. Approval entries are excluded --
  // nothing runs, so there is nothing a context could supply.
  const acceptsContextDrop =
    node.kind === 'job' ? node.isDefined : node.kind === 'orb';

  // Issue #87: `preventDefault()` is what accepts the drop (and is the only
  // thing that makes the browser show its "copy" cursor -- the green "+" --
  // instead of its own "not-allowed" one) -- calling it unconditionally, as
  // this used to, is why a palette executor dragged over a job node showed
  // that green "+" right up until release, then refused it via
  // `onDropExecutorRefused`'s error banner. `stopPropagation()` is called
  // whenever this node has *any* answer (valid or invalid) for a kind it
  // recognizes, so the event never falls through to `DagPane`'s own canvas
  // `onDragOver` on the bubble and gets *that* handler's canvas-background
  // answer instead -- both palette steps and palette executors are kinds
  // the canvas handler also recognizes.
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    const isCommandOrExecutor =
      isDraggingOrbKind(event.dataTransfer, 'command') ||
      isDraggingOrbKind(event.dataTransfer, 'executor');
    const isPaletteStep = isDraggingPaletteStep(event.dataTransfer);
    const isPaletteExecutor = isDraggingPaletteExecutor(event.dataTransfer);
    const isPaletteContext = isDraggingPaletteContext(event.dataTransfer);
    if (
      !isCommandOrExecutor &&
      !isPaletteStep &&
      !isPaletteExecutor &&
      !isPaletteContext
    ) {
      return;
    }
    if ((isCommandOrExecutor || isPaletteStep) && !onDropElement && !onDropStep)
      return;
    if (isPaletteContext && !onDropContext) return;

    event.stopPropagation();

    // A palette executor is never valid on an *existing* job node --
    // symmetric with a step being refused on the canvas background (see
    // `DagPane.handleCanvasDragOver`) -- it only ever creates a *new* job
    // (see `usePaletteInsertion`'s own module doc), regardless of whether
    // this particular node `acceptsDrop`. A command/executor/step is valid
    // only when this node does.
    const isValid = isPaletteContext
      ? acceptsContextDrop
      : !isPaletteExecutor && acceptsDrop;
    setDragState(isValid ? 'valid' : 'invalid');
    event.dataTransfer.dropEffect = isValid ? 'copy' : 'none';
    if (!isValid) return;
    event.preventDefault();
  };

  const handleDragLeave = () => setDragState(null);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const orbPayload =
      readOrbDragPayload(event.dataTransfer, 'command') ??
      readOrbDragPayload(event.dataTransfer, 'executor');
    const stepPayload = readPaletteStepDragPayload(event.dataTransfer);
    const contextPayload = readPaletteContextDragPayload(event.dataTransfer);
    const isPaletteExecutor = isDraggingPaletteExecutor(event.dataTransfer);
    setDragState(null);

    if (orbPayload && onDropElement) {
      event.preventDefault();
      event.stopPropagation();
      onDropElement(node, orbPayload);
      return;
    }
    if (stepPayload && onDropStep) {
      event.preventDefault();
      event.stopPropagation();
      onDropStep(node, stepPayload.stepKey);
      return;
    }
    if (contextPayload && onDropContext) {
      event.preventDefault();
      event.stopPropagation();
      onDropContext(node, contextPayload.contextName);
      return;
    }
    if (isPaletteExecutor && onDropExecutorRefused) {
      event.preventDefault();
      event.stopPropagation();
      onDropExecutorRefused();
    }
  };

  return (
    <div
      className={`vce-dag-node vce-dag-node--${node.kind}${
        !node.isDefined && !isMissing ? ' vce-dag-node--undefined' : ''
      }${isUnresolvedGroup ? ' vce-dag-node--group-unresolved' : ''}${
        selected ? ' vce-dag-node--selected' : ''
      }${
        dragState ? ` vce-dag-node--drop-${dragState}` : ''
      }${hasDiagnostic ? ' vce-dag-node--diagnostic' : ''}${
        isKeyboardConnectSource ? ' vce-dag-node--connect-source' : ''
      }${
        // Issue #85: React Flow's own `NodeProps.dragging` is the exact
        // same "is this node currently being dragged" signal its
        // `.react-flow__node` wrapper's own `dragging` class carries --
        // read directly off the prop (rather than reaching for that
        // wrapper via a `.react-flow__node.dragging` descendant selector)
        // since this component already builds its own className from
        // props/state everywhere else, and doing the same here keeps every
        // one of `.vce-dag-node`'s state classes discoverable from this one
        // line instead of splitting "is this node dragging" off into a
        // separate CSS-only lookup.
        dragging ? ' vce-dag-node--dragging' : ''
      }`}
      title={
        // A validation error outranks both structural notes: it is the reason
        // the pipeline won't run at all, and the other two are observations
        // about a config that may well still compile.
        hasDiagnostic
          ? diagnostics?.join('\n')
          : isMissing
            ? `Nothing in this workflow provides "${node.id}", but something requires it. This dependency is broken: either fix the requires: that names it, or add an entry called "${node.id}".`
            : node.isDefined
              ? undefined
              : `"${node.jobName}" is not defined under jobs:`
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Handle
        type="target"
        position={targetPosition}
        className="vce-dag-handle"
        tabIndex={0}
        role="button"
        aria-label={`Connect another job to "${label}" (or finish a pending connection here)`}
        onKeyDown={handleHandleKeyDown}
      />

      {selected && onRequestDelete ? (
        <button
          type="button"
          className="vce-dag-delete-affordance nodrag"
          aria-label={`Remove "${label}" node`}
          title="Remove this node"
          onClick={(event) => {
            event.stopPropagation();
            onRequestDelete(id);
          }}
        >
          &times;
        </button>
      ) : null}

      {/*
        Issue #90: production holds a status pill, name and duration on
        *one* comfortable line (`WorkflowDagDialog.tsx`'s own job card); ours
        previously stacked two cramped rows (alias+matrix, then
        kind/job-name/warning) at `text-xs font-mono`, which is what made a
        job read as a code token rather than a name, and made the box both
        narrower *and* taller than production's despite holding less. Now
        one row: the primary label takes production's sans, roomier size
        (see `vce-dag-node`'s own comment on the exact size), and every
        secondary signal -- matrix, kind, the alias's real job name,
        "undefined" -- trails it in the smaller, muted, still-monospaced
        style a code token/badge deserves (`showJobName`'s job-name span
        keeps `font-mono` deliberately: unlike the alias, it *is* a literal
        YAML key). `shrink-0` on every trailing badge is what keeps a long
        label the thing that truncates first, matching `NODE_WIDTH`'s own
        assumption that overflow degrades via `truncate`+`title`, never a
        squeezed badge.
      */}
      <div className="flex min-w-0 items-center gap-1.5">
        {node.kind === 'approval' ? (
          <span className="vce-dag-approval-icon" aria-hidden="true">
            &#10003;
          </span>
        ) : null}
        {/*
          Issue #90's own audit: production's label is "truncating ... with
          title" -- a `title` this app's primary label never actually had
          (the outer node's own `title` only ever fires for an *undefined*
          job). Harmless before now since `text-xs` mono rarely ran out of
          room; a bigger, roomier `text-sm` sans truncates sooner on a long
          job name, so the fallback that was already implicit in
          production's own design stops being optional here.
        */}
        <span className="min-w-0 truncate text-sm font-medium" title={label}>
          {label}
        </span>
        {/*
          Issue #284: a matrix entry now expands into one real node per
          parameter combination (`exclude:` honoured) rather than one node
          standing in for all of them -- necessary so `requires:` naming an
          expanded instance resolves instead of looking dangling. This badge
          is what keeps that expansion from *losing* the "these came from one
          matrix entry" grouping the old single-node rendering conveyed for
          free: it shows the real sibling count (`matrixGroupSize`), not a
          literal "N", so a two-instance matrix reads "×2" and a nine-instance
          one reads "×9".
        */}
        {node.matrix ? (
          <span
            className="vce-dag-matrix-badge"
            aria-label={`Matrix job: one of ${node.matrixGroupSize ?? '?'} parallel jobs from the same matrix entry`}
            title={`Matrix job: one of ${node.matrixGroupSize ?? '?'} parallel jobs from the same matrix entry`}
          >
            ×{node.matrixGroupSize ?? 'N'}
          </span>
        ) : null}
        {node.kind === 'approval' ? (
          <span className="vce-dag-kind-label text-2xs">Approval</span>
        ) : null}
        {node.kind === 'orb' && node.orbRef ? (
          <span
            className="vce-dag-kind-label max-w-20 truncate font-mono text-2xs"
            title={`Provided by the "${node.orbRef}" orb`}
          >
            orb: {node.orbRef}
          </span>
        ) : null}
        {/*
          Issue #220: a job group is invoked exactly like a job and, without
          this, drew as one -- so a node that actually runs several jobs read as
          a single job with a slightly odd name. One node per invocation is the
          truthful shape (the workflow invokes the group as a unit, and its
          `requires:` applies to the unit), but it has to *say* it is a group.

          Issue #24: the members themselves moved out of this tooltip and onto
          the canvas -- `DagPane` draws them for real, as sibling nodes inside
          a container, the moment this group is selected (see its own module
          doc for why "on selection" rather than always or never). What stays
          here is the disclosure hint (`groupSubgraph ? ' ▸' : ''`) that
          this node *has* something more to show and how to get it, plus the
          unresolved case, which never gets that hint because there is nothing
          to expand into.
        */}
        {node.kind === 'group' ? (
          isUnresolvedGroup ? (
            <span
              className="vce-dag-warning-label text-2xs"
              role="status"
              title={`Job group "${node.jobName}" -- its membership could not be determined: job-groups.${node.jobName}.jobs is missing or is not a list. Fix its jobs: list to see what this group runs.`}
            >
              Group: unresolved
            </span>
          ) : (
            <span
              className="vce-dag-kind-label text-2xs"
              title={
                (node.groupMembers && node.groupMembers.length > 0
                  ? `Job group "${node.jobName}", which runs: ${node.groupMembers.join(', ')}.`
                  : `Job group "${node.jobName}" currently has no members.`) +
                (node.groupSubgraph
                  ? selected
                    ? ' Click elsewhere to collapse it.'
                    : ' Select to see its members.'
                  : '')
              }
            >
              Group{node.groupSubgraph ? ' ▸' : ''}
            </span>
          )
        ) : null}
        {/*
          Issue #220: `serial-group` is the one piece of orchestration on an
          entry with consequences the graph cannot draw -- jobs sharing the
          string run one after another across the whole organisation, ordered at
          run time by queue arrival and pipeline number. There is no truthful
          edge for that, so it gets a badge instead of an edge, and the wording
          leads with "across your organization" because that is the part users
          do not expect.
        */}
        {node.serialGroup ? (
          <span
            className="vce-dag-serial-badge text-2xs"
            role="status"
            aria-label={`Serial group "${node.serialGroup}": runs one at a time across your organization`}
            title={`Serial group "${node.serialGroup}" -- jobs sharing this string run one at a time across your organization, not just in this workflow. The order is decided at run time, so it is not drawn as a dependency.`}
          >
            serial
          </span>
        ) : null}
        {showJobName ? (
          <span
            className="max-w-20 shrink-0 truncate font-mono text-2xs opacity-70"
            title={node.jobName}
          >
            {node.jobName}
          </span>
        ) : null}
        {isMissing ? (
          <span className="vce-dag-missing-label text-2xs" role="status">
            missing
          </span>
        ) : !node.isDefined ? (
          <span className="vce-dag-warning-label text-2xs" role="status">
            undefined
          </span>
        ) : null}
        {/* Issue #148: not hover-only. The ring is the at-a-glance signal; this
            badge is what a screen reader (and anyone not using a mouse)
            actually gets, with the message itself in the node's `title` and in
            the problems banner, which is keyboard-navigable. */}
        {hasDiagnostic ? (
          <span
            className="vce-dag-error-label text-2xs"
            role="status"
            aria-label={`Validation error: ${diagnostics?.join('; ')}`}
          >
            error
          </span>
        ) : null}
      </div>

      <Handle
        type="source"
        position={sourcePosition}
        className="vce-dag-handle"
        tabIndex={0}
        role="button"
        aria-label={`Connect "${label}" to another job (or finish a pending connection here)`}
        onKeyDown={handleHandleKeyDown}
      />
    </div>
  );
}

export const JobNode = memo(JobNodeImpl);
