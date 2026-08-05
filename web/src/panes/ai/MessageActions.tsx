/**
 * The per-message action toolbar (#192's third pattern, shipped by #209).
 *
 * Chunk gives every assistant message a small row of actions — copy, feedback,
 * and one contextual action ("View logs"). Ours had *none*: a reply was text you
 * could select by hand, and the only affordance in the pane was the approval
 * button, rendered inline in the middle of the message.
 *
 * What we take, and what we deliberately do not:
 *
 *  - **Copy**, because a model's reply is frequently a YAML fragment somebody
 *    wants in their editor, and "select the right part of a chat bubble with a
 *    mouse" is a bad way to get it. It copies the prose *as rendered* — with the
 *    machine-readable action block already stripped (see `AssistantMessage`) —
 *    because copying something the user was never shown would be a small lie
 *    about what they have in their clipboard.
 *  - **One contextual action**, which for this app is "Review change…" on a
 *    reply carrying a proposed edit. That button used to sit inline; it is an
 *    *action on the message*, so this is where it belongs. Its label is
 *    unchanged, and so is everything behind it: the approval gate is the
 *    only path from a model to the document, and it is still a diff the user
 *    accepts before anything is written.
 *  - **No feedback control.** Chunk's posts to CircleCI's telemetry. This tool
 *    sends nothing anywhere by default and says so in its own docs (#180); a
 *    thumbs-up that went nowhere would be furniture, and one that went somewhere
 *    would break that promise.
 *
 * Quiet until wanted: `opacity-0` lifted by `group-hover` *and* by
 * `group-focus-within`, so the toolbar is reachable by keyboard — tabbing into it
 * reveals it. It is never `hidden`, so it is always in the accessibility tree and
 * always in the tab order.
 *
 * `prominent` turns that off, and there is one caller: a reply carrying a
 * proposed edit. Hiding *the* affordance for reviewing a change until the mouse
 * happens to pass over it would be a real regression from the inline button it
 * replaces — quiet-until-hover is for a convenience, not for the only route to a
 * gated action.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '~/design/components/Button';

/** The row itself. Empty children render nothing, so a message with no actions grows no furniture. */
export function MessageActions({
  children,
  prominent = false,
}: {
  children: React.ReactNode;
  prominent?: boolean;
}) {
  return (
    <div
      data-testid="ai-message-actions"
      className={`flex items-center gap-1 transition-opacity ${
        prominent
          ? ''
          : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
      }`}
    >
      {children}
    </div>
  );
}

/**
 * Copies `text` and says so for a beat.
 *
 * `navigator.clipboard` is absent in jsdom and can be absent or refused in a
 * browser (a permissions prompt, an insecure origin). A failure leaves the label
 * alone rather than throwing or claiming success: the user can still select the
 * text, and a button that lied about having copied would be worse than one that
 * visibly did nothing.
 */
export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        return;
      }
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    })();
  }, [text]);

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={copy}
      aria-label="Copy this reply"
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
