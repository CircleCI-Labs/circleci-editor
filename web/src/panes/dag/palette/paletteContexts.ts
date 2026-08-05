/**
 * The drag payload that carries a CircleCI context from the palette's
 * Contexts section to a workflow job node on the canvas (issue #105).
 *
 * Contexts are the one part of the project metadata this feature surfaces
 * that is genuinely draggable, because there is exactly one unambiguous
 * place a context goes: the `context:` key of a workflow job entry. Project
 * environment variables deliberately have no payload here -- they are
 * referenced as `$NAME` inside a `run` command's text, which is not a drop
 * target, so they are offered as completions in the YAML editor instead
 * (`~/lib/schema/envVarCompletion.ts`).
 *
 * Pure and framework-free -- no React -- same convention as
 * `paletteSteps.ts` and `paletteExecutors.ts`.
 */

export interface PaletteContextPayload {
  contextName: string;
}

/**
 * `dataTransfer` MIME type for a palette-context drag. Its own type rather
 * than a shared generic one for the same reason every other payload here has
 * one: `dataTransfer.types` is readable during `dragover` while `getData()`
 * is not, so a per-kind MIME type is what lets a drop target decide whether
 * it would accept the drag *before* the drop -- which is what drives the
 * valid/invalid affordance (see `JobNode.tsx`, and issue #87).
 */
const PALETTE_CONTEXT_MIME = 'application/x-vce-palette-context';

export function setPaletteContextDragPayload(
  dataTransfer: DataTransfer,
  contextName: string,
): void {
  dataTransfer.setData(PALETTE_CONTEXT_MIME, JSON.stringify({ contextName }));
  dataTransfer.setData('text/plain', contextName);
  dataTransfer.effectAllowed = 'copy';
}

export function isDraggingPaletteContext(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PALETTE_CONTEXT_MIME);
}

export function readPaletteContextDragPayload(
  dataTransfer: DataTransfer,
): PaletteContextPayload | undefined {
  const raw = dataTransfer.getData(PALETTE_CONTEXT_MIME);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as PaletteContextPayload;
    return typeof parsed?.contextName === 'string' && parsed.contextName !== ''
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
