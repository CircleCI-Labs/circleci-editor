/**
 * The transcript with nothing in it yet (#192's "an explicit empty/no-result
 * message", shipped by #209).
 *
 * Its own component for the reason the rest of the split exists: an empty state is
 * a message about the pane, not a message *in* it, and having it inline in the
 * transcript's own JSX is what made the transcript hard to reason about.
 *
 * It says two different things depending on whether a key is configured, because
 * those are two different situations and only one of them is "type something".
 * The no-key wording keeps #92's promise in view: nothing else in the app depends
 * on this pane, so a missing key is a missing feature, not a broken editor.
 */
export function EmptyTranscript({ configured }: { configured: boolean }) {
  return (
    <div
      data-testid="ai-empty-transcript"
      className="flex flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <p className="text-sm font-medium text-cc-text">Chat with your config</p>
      <p className="max-w-xs text-xs text-cc-text-muted">
        {configured
          ? "Ask about a job, a workflow, or a validation error -- or ask it to propose a change, which you'll review as a diff before anything is written."
          : 'Add an API key in Settings to start chatting. Editing and the graph work the same either way.'}
      </p>
    </div>
  );
}
