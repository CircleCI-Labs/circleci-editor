/**
 * One turn the *user* typed (#192's "a component per message role", shipped by
 * #209).
 *
 * Verbatim, always. Someone who types `**not bold**` said those characters, and
 * running a Markdown formatter over their own message would misrepresent what
 * they sent — which matters more here than it looks, because this is also the
 * only record in the pane of what actually went to a paid API.
 *
 * A bubble, right-aligned, on the raised surface rather than in the accent
 * colour. The accent bubble it replaces read as the loudest thing in the pane,
 * and the thing worth reading in a chat is the answer; #185's surface-role table
 * puts a message on the raised plane and leaves the accent for controls.
 */
export function UserMessage({ content }: { content: string }) {
  return (
    <div
      data-testid="ai-user-message"
      className="min-w-0 max-w-[85%] rounded-lg rounded-tr-sm border border-cc-border-strong bg-cc-panel-raised px-3 py-2 text-sm text-cc-text"
    >
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
  );
}
