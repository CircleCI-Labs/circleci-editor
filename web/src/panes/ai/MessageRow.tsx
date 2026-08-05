/**
 * The frame every message in the transcript sits in, and the two pieces of
 * furniture the assistant's messages hang off it (issues #192 and #209).
 *
 * # Why a frame at all
 *
 * Before #209 one component branched on `message.role` and rendered a bubble
 * either way, which is why the assistant's replies could not carry affordances
 * of their own: there was nowhere to put them that would not also appear on the
 * user's own messages. Chunk's chat splits a component per role around a shared
 * wrapper, and this is the same shape arrived at independently — the wrapper owns
 * alignment and nothing else, so `UserMessage`, `AssistantMessage`,
 * `NoticeMessage` and `ThinkingMessage` are each free to look like what they are.
 *
 * Modelled on Chunk's layout with the owner's explicit permission (#209), and
 * under the standing rule that survives it: that UI's source is
 * proprietary and this repository is MIT, so the *behaviour* and the *shape* are
 * what crossed over. No source did, and nothing here depends on
 * CircleCI's internal design system — the same line already held for the production DAG and
 * for the design tokens.
 *
 * # The two roles read differently on purpose
 *
 * The user's message is a bubble on the right; the assistant's is the full width
 * of the pane with no bubble at all, under a small role label. That asymmetry is
 * Chunk's, and the reason to take it is legibility rather than fashion: a reply
 * can be several paragraphs with a fenced YAML sample in it, and a code block
 * inside an 85%-width bubble in a 320px-wide pane wraps to nothing. The bubble
 * stays where it is *cheap* — on the short thing a human typed.
 */
import type { ReactNode } from 'react';

/** Which role's frame this is. `notice` is host-supplied copy, not a turn of the conversation. */
export type MessageRole = 'user' | 'assistant' | 'notice';

/**
 * One row of the transcript.
 *
 * `group` is what lets the assistant's action toolbar stay quiet until the
 * message is hovered or something inside it takes focus, without JavaScript
 * tracking hover state — see `MessageActions`.
 */
export function MessageRow({
  role,
  children,
  testId,
}: {
  role: MessageRole;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-role={role}
      className={`group flex w-full min-w-0 flex-col gap-1.5 ${
        role === 'user' ? 'items-end' : 'items-start'
      }`}
    >
      {children}
    </div>
  );
}

/**
 * The small label above a non-user message, naming who is speaking.
 *
 * Chunk puts its product's icon and name here. This app has no icon-asset
 * convention (see `SourcesList`'s external-link glyph for the same constraint),
 * so it is a word — which also keeps the label honest about the one thing worth
 * saying in this pane: the reply came from whichever provider *the user*
 * configured, not from CircleCI.
 */
export function MessageAuthor({ children }: { children: ReactNode }) {
  return (
    <p className="text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
      {children}
    </p>
  );
}

/**
 * The body of an assistant-side message: full width, no bubble, ordinary page
 * text. See this module's header for why the assistant does not get one.
 */
export function MessageBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 max-w-full text-sm text-cc-text">{children}</div>
  );
}
