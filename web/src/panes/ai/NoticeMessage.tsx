/**
 * A degraded-state or transport-failure notice in the transcript — "no key
 * configured for Anthropic", "the request failed" (#92's honest degrade, given
 * its own component by #209).
 *
 * Host-supplied copy, rendered **verbatim**: not Markdown, no links, no
 * formatting. It must keep saying exactly what the host said, and it is never fed
 * back to the provider as conversation history (see `aiStore.sendMessage`), so it
 * is not a turn of the conversation and does not read like one.
 */
export function NoticeMessage({ content }: { content: string }) {
  return (
    <div
      data-testid="ai-notice-message"
      className="min-w-0 max-w-full rounded-md border border-cc-border-strong bg-cc-panel-raised px-3 py-2 text-sm text-cc-text-muted"
    >
      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-cc-text-faint">
        Notice
      </p>
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
  );
}
