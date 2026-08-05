/**
 * Unified-diff computation for the Save dialog. Because every visual edit in
 * this app is a surgical AST mutation (see `documentUtils.ts`) rather than a
 * full re-serialization, the diff between the last-saved text and the
 * current text should normally be tiny. That smallness is the trust
 * mechanism for the whole product -- a user should be able to glance at the
 * diff before saving and see exactly (and only) what they changed -- so this
 * module renders it as a real unified diff (hunks + line numbers) rather
 * than a coarse "changed" flag.
 */
import { structuredPatch } from 'diff';

export type DiffLineType = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the "before" text. Present for `del` and `ctx` lines. */
  oldLine?: number;
  /** 1-based line number in the "after" text. Present for `add` and `ctx` lines. */
  newLine?: number;
}

const CONTEXT_LINES = 3;

/**
 * Computes a unified diff between `before` and `after`, flattened into a
 * list of typed lines ready to render directly (no hunk-boundary math
 * needed in the UI layer).
 */
export function unifiedDiff(
  before: string,
  after: string,
  filename: string,
): DiffLine[] {
  if (before === after) return [];

  const patch = structuredPatch(filename, filename, before, after, '', '', {
    context: CONTEXT_LINES,
  });

  const lines: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    lines.push({
      type: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw.charAt(0);
      const text = raw.slice(1);
      if (marker === '+') {
        lines.push({ type: 'add', text, newLine });
        newLine += 1;
      } else if (marker === '-') {
        lines.push({ type: 'del', text, oldLine });
        oldLine += 1;
      } else if (marker === '\\') {
        // "\ No newline at end of file" -- not a real source line.
        lines.push({ type: 'ctx', text: raw });
      } else {
        lines.push({ type: 'ctx', text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return lines;
}

/** Counts the added and deleted lines in a diff (context/hunk lines excluded). */
export function countChangedLines(lines: DiffLine[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions += 1;
    else if (line.type === 'del') deletions += 1;
  }
  return { additions, deletions };
}
