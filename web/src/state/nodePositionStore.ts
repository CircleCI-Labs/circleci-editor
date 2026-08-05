/**
 * Persisted manual node positions for the DAG pane's free-drag affordance
 * (issue #70): "It'd be really nice to be able to click and drag things...
 * but with how the workflow DAG is looking right now, it's all pretty
 * static." Nodes were already `draggable`, but `DagPane`'s own (now
 * outdated) comment on `flowNodes` admitted the drag was thrown away the
 * moment the graph's structure changed, because `rendered.nodes` gets a
 * fresh identity from ELK on every relayout and ELK's own position always
 * won.
 *
 * CircleCI config has no coordinate fields, so a dragged position can never
 * be written into the YAML the way `addRequire`/`addJob`/etc write their
 * edits -- it has to live entirely outside `doc`. This store keys each
 * position by (config path, workflow name, node id) rather than by the
 * node's array index or object identity, which is the whole point: `doc`'s
 * own node ids (a job's `name:` alias, or its job name) are the one thing
 * that survives an unrelated structural edit, a save, and a reload, even
 * though the `PositionedNode[]` array ELK returns does not.
 *
 * Follows `layoutStore.ts`'s versioned-localStorage pattern deliberately
 * (schema version + full-shape validation on read, corrupt/foreign values
 * fall back to empty rather than throwing) so the two stores' persistence
 * behaviour -- and its test coverage -- stays easy to compare rather than
 * inventing a second convention for the same problem.
 */
import { create } from 'zustand';

export const NODE_POSITION_SCHEMA_VERSION = 1;
export const NODE_POSITION_STORAGE_KEY = 'vce.nodePositions';
const SCHEMA_VERSION = NODE_POSITION_SCHEMA_VERSION;
const STORAGE_KEY = NODE_POSITION_STORAGE_KEY;

export interface StoredPosition {
  x: number;
  y: number;
}

export interface PersistedNodePositions {
  schemaVersion: number;
  /** Flat, not nested: `positionKey` folds (configPath, workflowName, nodeId)
   * into one string key so storage shape, validation, and the
   * per-workflow "clear" used by Re-layout are all a single `Record`
   * operation rather than three nested levels of presence-checking. */
  positions: Record<string, StoredPosition>;
}

// U+0000 can't appear in a config path, workflow name, or job/alias id (YAML
// text can't contain a NUL byte), so it's a safe join separator that can
// never collide with a real id containing the separator "by coincidence" --
// unlike e.g. `:` or `/`, which do turn up in orb-derived job ids such as
// `node/test`.
const KEY_SEPARATOR = '\u0000';

function positionKey(
  configPath: string,
  workflowName: string,
  nodeId: string,
): string {
  return `${configPath}${KEY_SEPARATOR}${workflowName}${KEY_SEPARATOR}${nodeId}`;
}

/** Prefix shared by every key belonging to one (configPath, workflowName)
 * pair -- used by `clearWorkflowPositions` ("Re-layout") to drop exactly
 * that workflow's manual positions without disturbing any other workflow's
 * or any other config's. */
function workflowKeyPrefix(configPath: string, workflowName: string): string {
  return `${configPath}${KEY_SEPARATOR}${workflowName}${KEY_SEPARATOR}`;
}

function isStoredPosition(value: unknown): value is StoredPosition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === 'number' &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === 'number' &&
    Number.isFinite(candidate.y)
  );
}

function isPersistedNodePositions(
  value: unknown,
): value is PersistedNodePositions {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== SCHEMA_VERSION) return false;
  if (
    typeof candidate.positions !== 'object' ||
    candidate.positions === null ||
    Array.isArray(candidate.positions)
  ) {
    return false;
  }
  return Object.values(candidate.positions).every(isStoredPosition);
}

/**
 * Reads and validates persisted positions, falling back to an empty map for
 * a first run, unparseable JSON, a schema-version mismatch, or an
 * environment where `localStorage` itself throws. Never throws -- a
 * corrupted position store must never block the DAG pane from rendering.
 */
export function readPersistedNodePositions(): PersistedNodePositions {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { schemaVersion: SCHEMA_VERSION, positions: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedNodePositions(parsed))
      return { schemaVersion: SCHEMA_VERSION, positions: {} };
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, positions: {} };
  }
}

export function writePersistedNodePositions(
  state: PersistedNodePositions,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Dragging still works for the rest of this session even if the result
    // can't persist across a reload (private browsing, disabled storage).
  }
}

interface NodePositionState {
  positions: Record<string, StoredPosition>;
  /** Called from `onNodeDragStop` -- see `DagPane`. */
  setPosition: (
    configPath: string,
    workflowName: string,
    nodeId: string,
    position: StoredPosition,
  ) => void;
  /** Called by "Re-layout" (see `DagPane`'s `handleRelayout`), which is the
   * one explicit, discoverable way to discard manual positions and hand a
   * workflow's nodes back to ELK. */
  clearWorkflowPositions: (configPath: string, workflowName: string) => void;
}

export const useNodePositionStore = create<NodePositionState>((set) => {
  const initial = readPersistedNodePositions();

  return {
    positions: initial.positions,

    setPosition: (configPath, workflowName, nodeId, position) =>
      set((state) => {
        const positions = {
          ...state.positions,
          [positionKey(configPath, workflowName, nodeId)]: position,
        };
        writePersistedNodePositions({
          schemaVersion: SCHEMA_VERSION,
          positions,
        });
        return { positions };
      }),

    clearWorkflowPositions: (configPath, workflowName) =>
      set((state) => {
        const prefix = workflowKeyPrefix(configPath, workflowName);
        const positions = Object.fromEntries(
          Object.entries(state.positions).filter(
            ([key]) => !key.startsWith(prefix),
          ),
        );
        writePersistedNodePositions({
          schemaVersion: SCHEMA_VERSION,
          positions,
        });
        return { positions };
      }),
  };
});

/** Non-reactive lookup for one node's manually-placed position, if any --
 * used inside `flowNodes`' `useMemo` (a `useCallback`-free plain read of the
 * `positions` slice the component already subscribes to via the store hook,
 * not a fresh subscription of its own). */
export function getStoredPosition(
  positions: Record<string, StoredPosition>,
  configPath: string,
  workflowName: string,
  nodeId: string,
): StoredPosition | undefined {
  return positions[positionKey(configPath, workflowName, nodeId)];
}
