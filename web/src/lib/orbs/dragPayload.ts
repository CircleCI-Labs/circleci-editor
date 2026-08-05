/**
 * The HTML5 drag-and-drop payload for dragging an orb element (job,
 * command, or executor) out of the orb browser and onto some part of the
 * config -- the DAG canvas, a job node, or the inspector's steps list.
 *
 * A distinct `dataTransfer` MIME type is registered per *kind*
 * (`ORB_JOB_MIME`/`ORB_COMMAND_MIME`/`ORB_EXECUTOR_MIME`) rather than one
 * generic type with the kind inside the JSON body. That split matters
 * during `dragover`: browsers let a handler read `dataTransfer.types` (to
 * decide "is *something* draggable-here currently over me") but, for
 * security reasons, not `dataTransfer.getData(...)` (to read what it
 * actually is) until the `drop` event fires. Per-kind MIME types let every
 * drop target answer "would I accept this?" during `dragover` -- and
 * therefore highlight -- using only `types`, with the full payload read out
 * via `getData` once the drop actually happens.
 *
 * The payload embeds the whole `OrbElement` (not just its name) so a drop
 * target can decide immediately whether a parameter form is needed, without
 * a second round trip through the orb store's cache.
 */
import type { OrbElement } from './types';

/** The `dataTransfer` MIME type used for one element kind's drag payload. */
const MIME_BY_KIND: Record<OrbElement['kind'], string> = {
  job: 'application/x-vce-orb-job',
  command: 'application/x-vce-orb-command',
  executor: 'application/x-vce-orb-executor',
};

/** The JSON payload carried by an orb-element drag, once decoded. */
export interface OrbDragPayload {
  kind: OrbElement['kind'];
  /** Full orb reference including version, e.g. `"circleci/node@5.2.0"`. */
  orbRef: string;
  element: OrbElement;
}

/**
 * Starts dragging `element` (from `orbRef`) by writing its payload onto
 * `dataTransfer` under its kind's MIME type, plus a human-readable
 * `text/plain` fallback for anything that only understands that.
 */
export function setOrbDragPayload(
  dataTransfer: DataTransfer,
  orbRef: string,
  element: OrbElement,
): void {
  const payload: OrbDragPayload = { kind: element.kind, orbRef, element };
  dataTransfer.setData(MIME_BY_KIND[element.kind], JSON.stringify(payload));
  dataTransfer.setData('text/plain', `${orbRef}/${element.name}`);
  dataTransfer.effectAllowed = 'copy';
}

/**
 * Reads `dataTransfer.types` only (safe during `dragover`, before a drop
 * happens) to say whether a drag of `kind` is currently in flight over this
 * target. Use this to decide whether/how to highlight while dragging.
 */
export function isDraggingOrbKind(
  dataTransfer: DataTransfer,
  kind: OrbElement['kind'],
): boolean {
  return Array.from(dataTransfer.types).includes(MIME_BY_KIND[kind]);
}

/**
 * Reads back the payload for `kind` from a `drop` event's `dataTransfer`.
 * Returns `undefined` if no such payload is present, or it fails to parse
 * (a defensive fallback -- a same-origin drag we started ourselves should
 * always parse, but a drag dragged in from elsewhere might carry garbage
 * under a colliding MIME type).
 */
export function readOrbDragPayload(
  dataTransfer: DataTransfer,
  kind: OrbElement['kind'],
): OrbDragPayload | undefined {
  const raw = dataTransfer.getData(MIME_BY_KIND[kind]);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as OrbDragPayload;
    if (
      parsed &&
      parsed.kind === kind &&
      typeof parsed.orbRef === 'string' &&
      parsed.element
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
