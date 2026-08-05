/**
 * "Thinking…" as a message in the transcript rather than a spinner beside it
 * (#192's second pattern, shipped by #209).
 *
 * Before this, a request in flight rendered a small detached spinner under the
 * last message. Two things are better about a bubble in the thread:
 *
 *  - **It sits where the answer will.** The reply replaces it in place, so the
 *    eye is already in the right spot — and with the stick-to-bottom rule (#207)
 *    it is also what the transcript is scrolled to.
 *  - **It is somewhere honest to put more.** Once #191's MCP work lands, "calling
 *    a tool…" is a sentence about the same turn, and a spinner has nowhere to say
 *    it. Chunk's `ThinkingMessage` is exactly this, for exactly this reason.
 *
 * `role="status"` so a screen reader is told the assistant is working without the
 * focus moving, and `Spinner` keeps its own accessible label. The pulse is
 * decoration on top of that, never the only signal.
 */
import { Spinner } from '~/design/components/Spinner';

import { MessageAuthor } from './MessageRow';

export function ThinkingMessage() {
  return (
    <>
      <MessageAuthor>Assistant</MessageAuthor>
      <div
        role="status"
        data-testid="ai-thinking"
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-cc-border bg-cc-panel px-3 py-2 text-sm text-cc-text-muted"
      >
        <Spinner size={12} label="Waiting for a reply" />
        <span className="animate-pulse">Thinking…</span>
      </div>
    </>
  );
}
