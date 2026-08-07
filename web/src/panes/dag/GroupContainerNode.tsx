import type { NodeProps } from '@xyflow/react';
import { memo } from 'react';

import type { GraphNode } from '~/lib/graph/buildGraph';

/**
 * Data carried by a `jobGroup`-type React Flow node -- see `DagPane`'s own
 * module doc for why a selected, resolvable group's interior is drawn at
 * all (issue #24), and why it is drawn as *this* rather than a bigger
 * `JobNode`.
 */
export type GroupContainerNodeData = {
  /** The group's own `GraphNode` -- same object `JobNode` would have
   * rendered had this group stayed collapsed. Named `node`, matching
   * `JobNodeData`'s own field, so `DagPane`'s minimap `nodeClassName`
   * callback (keyed on `data.node.kind`) works unchanged for this node type
   * too, with no separate branch for "this one might be a container". */
  node: GraphNode;
  /** Collapses this group back to its ordinary single-card rendering --
   * `DagPane` wires this to clearing the selection, since expansion is
   * driven by *selection*, not a separate open/closed flag (see this file's
   * own module doc). */
  onCollapse: () => void;
};

type GroupContainerNodeProps = NodeProps & {
  data: GroupContainerNodeData;
};

/**
 * The frame drawn around a selected, resolvable group's members (issue #24)
 * -- sized by ELK to fit whatever those members' own layout needed (see
 * `layout.ts`'s compound-node handling), never by this component itself.
 * The members are separate `JobNode` instances, parented to this node's id
 * via React Flow's own `parentId` relationship; this component only supplies
 * the boundary and the header row identifying whose interior is on screen.
 *
 * Deliberately not a bigger `JobNode`: a job card's whole visual language
 * (solid fill, drop shadow, one-line label) says "this is the thing that
 * runs" -- true of a collapsed group, but not of a box that exists only to
 * hold several of those cards. See `.vce-dag-group-container` in
 * `styles.css` for the boundary styling this borrows instead (dashed,
 * near-transparent, no shadow).
 */
function GroupContainerNodeImpl({ data }: GroupContainerNodeProps) {
  const { node, onCollapse } = data;
  return (
    <div className="vce-dag-group-container">
      <div className="vce-dag-group-container__header">
        <span className="vce-dag-kind-label text-2xs">Group</span>
        <span
          className="min-w-0 truncate text-sm font-medium"
          title={node.jobName}
        >
          {node.jobName}
        </span>
        <span className="text-2xs text-cc-text-faint">
          {node.groupMembers?.length ?? 0}{' '}
          {node.groupMembers?.length === 1 ? 'member' : 'members'}
        </span>
        <button
          type="button"
          className="vce-dag-group-container__collapse nodrag"
          aria-label={`Collapse the "${node.jobName}" job group`}
          title="Collapse this group"
          onClick={(event) => {
            event.stopPropagation();
            onCollapse();
          }}
        >
          Collapse
        </button>
      </div>
    </div>
  );
}

export const GroupContainerNode = memo(GroupContainerNodeImpl);
