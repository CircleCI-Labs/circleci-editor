import type { DiffLine, DiffLineType } from '~/lib/yaml/diff';

const LINE_CLASSES: Record<DiffLineType, string> = {
  add: 'bg-[color-mix(in_srgb,var(--color-cc-success)_14%,transparent)] text-cc-success',
  del: 'bg-[color-mix(in_srgb,var(--color-cc-danger)_14%,transparent)] text-cc-danger',
  ctx: 'text-cc-text-muted',
  hunk: 'text-cc-text-faint',
};

const LINE_PREFIX: Record<DiffLineType, string> = {
  add: '+',
  del: '-',
  ctx: ' ',
  hunk: ' ',
};

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`flex whitespace-pre px-3 ${LINE_CLASSES[line.type]}`}>
      <span className="mr-3 inline-block w-6 shrink-0 select-none text-right text-cc-text-faint">
        {line.oldLine ?? ''}
      </span>
      <span className="mr-3 inline-block w-6 shrink-0 select-none text-right text-cc-text-faint">
        {line.newLine ?? ''}
      </span>
      <span className="select-none">{LINE_PREFIX[line.type]}</span>
      <span className="ml-1">{line.text}</span>
    </div>
  );
}

interface DiffViewProps {
  lines: DiffLine[];
  emptyMessage?: string;
}

/**
 * Renders a `unifiedDiff()` result as monospace, line-numbered rows.
 * Factored out of `panes/yaml/SaveDialog.tsx` so the AI pane's own
 * approval dialog (issue #92: a proposed config change must be shown as a
 * diff the user approves before anything is written) reuses the exact same
 * rendering rather than inventing a second diff view -- the two dialogs
 * differ in what happens on confirm (write to disk vs. apply to the live
 * document), not in how a diff is drawn.
 */
export function DiffView({
  lines,
  emptyMessage = 'No changes.',
}: DiffViewProps) {
  if (lines.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-cc-text-muted">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto py-2">
      <div className="min-w-max font-mono text-xs leading-5">
        {lines.map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- static diff list for this render only
          <DiffRow key={index} line={line} />
        ))}
      </div>
    </div>
  );
}
