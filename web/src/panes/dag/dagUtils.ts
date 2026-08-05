/**
 * Small, framework-free helpers for `DagPane`'s interactive editing. Kept
 * separate (and pure) so the cycle check in particular -- which runs on
 * every pointer-move frame while the user is dragging a connection -- stays
 * trivial to unit test without mounting React Flow at all.
 */
import type { GraphEdge } from '~/lib/graph/buildGraph';

/**
 * Whether adding an edge `newSource -> newTarget` (dependency -> dependent,
 * matching `GraphEdge`'s own direction) would create a cycle in the
 * `requires` graph, *before* the edit is ever attempted.
 *
 * Adding that edge closes a cycle iff `newTarget` can already reach
 * `newSource` by following the existing edges forward -- that path, plus
 * the new edge back from `newSource` to `newTarget`, is the cycle. This
 * mirrors (and is intentionally simpler than) `buildGraph.ts`'s own
 * `detectCycles`, which walks the *whole* graph to report every cycle as a
 * problem; this only needs a yes/no answer for one prospective edge, fast
 * enough to call from `isValidConnection` on every drag frame.
 */
export function wouldCreateCycle(
  edges: GraphEdge[],
  newSource: string,
  newTarget: string,
): boolean {
  if (newSource === newTarget) return true;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source);
    if (list) {
      list.push(edge.target);
    } else {
      adjacency.set(edge.source, [edge.target]);
    }
  }

  // BFS from newTarget: if we ever reach newSource, the new edge would
  // close a loop.
  const seen = new Set<string>([newTarget]);
  const queue: string[] = [newTarget];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current === newSource) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Every node reachable by walking `requires` edges *backward* from
 * `nodeId` -- i.e. `nodeId` itself plus every job it (transitively) depends
 * on. Issue #54: this answers "what does this job actually depend on?",
 * which `DagPane` uses to highlight the ancestor chain on node selection
 * and dim everything else (ground-truthed against production's
 * `WorkflowDagDialog.tsx`, which does the same on select). Unlike
 * `wouldCreateCycle`'s forward BFS, this walks `target -> source` since an
 * ancestor is whatever a node's `requires:` points at, not what points at
 * it.
 *
 * A cycle in `edges` (which `buildWorkflowGraph` already reports as a
 * `GraphProblem` but still renders) can't loop this forever: `seen` is
 * checked before a node is ever re-queued.
 */
export function getAncestorChain(
  edges: GraphEdge[],
  nodeId: string,
): Set<string> {
  const parentsByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const list = parentsByTarget.get(edge.target);
    if (list) {
      list.push(edge.source);
    } else {
      parentsByTarget.set(edge.target, [edge.source]);
    }
  }

  const chain = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const parent of parentsByTarget.get(current) ?? []) {
      if (!chain.has(parent)) {
        chain.add(parent);
        queue.push(parent);
      }
    }
  }
  return chain;
}

/**
 * Generates a name guaranteed not to collide with `existingNames`: `base`,
 * then `base-2`, `base-3`, etc. (never `-1` -- the bare name comes first).
 * Factored out of what used to be `generateUniqueJobName`'s own hardcoded
 * `"new-job"` (issue #79's duplicate-executor/duplicate-steps extraction
 * suggestions need the identical "propose a free name" behavior for a
 * fresh `executors:`/`commands:` entry, not just a job).
 */
export function generateUniqueName(
  base: string,
  existingNames: readonly string[],
): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Generates a job name guaranteed not to collide with `existingNames`:
 * `new-job`, then `new-job-2`, `new-job-3`, etc. Matches the pattern users
 * already see from other "Add X" affordances in the product (never `-1`,
 * the bare name comes first).
 */
export function generateUniqueJobName(
  existingNames: readonly string[],
): string {
  return generateUniqueName('new-job', existingNames);
}

/**
 * True when `target` is a form control that owns its own text editing
 * (input/textarea/select/contenteditable). Delete/Backspace key handling
 * for "remove the selected DAG node" must bail out when this is true --
 * otherwise pressing Backspace to edit a job name or command in the
 * inspector would also delete the selected node out from under the user.
 */
export function isEditableTarget(
  target: EventTarget | Element | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // `Boolean(...)`, not a bare `||` chain: `isContentEditable` is `undefined`
  // rather than `false` in some DOM implementations (notably jsdom, which
  // this project's tests run under) when it's never been set, and this
  // function must always return a real boolean.
  return Boolean(
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable,
  );
}
