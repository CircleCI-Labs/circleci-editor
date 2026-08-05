/**
 * Keeps the newest message in view, unless the user has scrolled up to read
 * history (issue #207).
 *
 * The report: *"`AiPane`'s transcript is a plain `overflow-y-auto` column with no
 * scroll management, so after a send the reply — and its "Sources" footer, and any
 * "Review change…" affordance — can render below the fold while the pane still
 * shows the top of the conversation. On the pane's default height that happens on
 * the first exchange... It reads as the assistant not having replied."*
 *
 * Chunk solves this with `use-stick-to-bottom`. This is the same behaviour written
 * here rather than taken from there: it is thirty lines of `scrollTop`, and this
 * repository is MIT while that UI's source is proprietary (#209's permission
 * covers modelling the behaviour, not lifting the code) — and adding a dependency
 * to do this would be the wrong trade even if it were ours.
 *
 * # The rule, stated once
 *
 *  - **Stick to the bottom by default.** Any change to the transcript's content
 *    scrolls it to the newest message.
 *  - **Stop sticking the moment the user scrolls away**, and resume the moment
 *    they come back. #207 is explicit that a reply must not be yanked out from
 *    under someone mid-read.
 *  - **Say so when it is not sticking**, with a control that fixes it. A
 *    transcript silently parked in the past is the same failure as one silently
 *    parked at the top.
 *
 * "At the bottom" is `scrollHeight - scrollTop - clientHeight <= BOTTOM_SLACK_PX`
 * rather than `=== 0`: sub-pixel rounding, fractional device pixel ratios and a
 * mid-scroll frame all make an exact comparison flap, and flapping here means the
 * "jump to newest" button blinking on and off while a reply streams in.
 *
 * # What it deliberately is not
 *
 * It adds **no scroll region** — it drives the transcript's existing one, which is
 * the pane's only one (#88). And it does not use `scrollIntoView` on the
 * newest message: that scrolls whatever ancestor happens to be scrollable, which
 * in a pane inside a `Panel` inside a split is a good way to move something other
 * than the transcript. `scrollTop` on a container this hook was handed is exact.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How far from the bottom still counts as "at the bottom", in CSS pixels. Two is
 * the same tolerance `e2e/scroll-regions.spec.ts`'s probe uses when deciding
 * whether an element genuinely overflows; four gives a mid-scroll frame room to
 * settle without letting a real half-line of content hide.
 */
export const BOTTOM_SLACK_PX = 4;

export interface StickToBottom<T extends HTMLElement> {
  /** Attach to the scroll container. */
  ref: (element: T | null) => void;
  /** Whether the container is currently at (or within `BOTTOM_SLACK_PX` of) its bottom. */
  atBottom: boolean;
  /** Scrolls to the newest message and resumes sticking. Safe to call when there is no container. */
  scrollToBottom: () => void;
}

/**
 * Sticks `ref`'s element to its bottom whenever `deps` change.
 *
 * `deps` is the caller's summary of "the transcript changed" — the message count
 * and whether a reply is in flight, in `AiPane`'s case. Passing the messages array
 * itself would work too, but re-running on every identity change of a large array
 * is exactly the kind of accidental dependency that makes a scroll effect fire
 * when nothing visible happened.
 */
export function useStickToBottom<T extends HTMLElement>(
  deps: readonly unknown[],
): StickToBottom<T> {
  const elementRef = useRef<T | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Read by the scroll-on-change effect, written by the scroll listener. A ref as
  // well as state because the effect must see the *current* value without having
  // `atBottom` in its dependency list -- with it there, coming back to the bottom
  // would itself re-trigger a scroll.
  const atBottomRef = useRef(true);

  const measure = useCallback((element: T) => {
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const next = distance <= BOTTOM_SLACK_PX;
    atBottomRef.current = next;
    setAtBottom((current) => (current === next ? current : next));
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  // A callback ref, not `useRef` alone: the listener has to be attached the moment
  // the element exists and removed when it goes, and a callback ref is the only
  // hook that is told about both.
  const ref = useCallback(
    (element: T | null) => {
      const previous = elementRef.current;
      const previousListener = previous ? handlers.get(previous) : undefined;
      if (previous && previousListener) {
        previous.removeEventListener('scroll', previousListener);
      }
      elementRef.current = element;
      if (!element) return;
      const onScroll = () => measure(element);
      handlers.set(element, onScroll);
      element.addEventListener('scroll', onScroll, { passive: true });
      // The transcript opens on its newest message, not on its top. This is the
      // situation #207 was reported from -- a pane mounting with a conversation
      // already in it and showing the beginning of it -- and *measuring* first
      // would conclude "the user has scrolled up" from a scroll position no user
      // chose. Chunk's transcript does the same thing (`initial`), for the same
      // reason.
      element.scrollTop = element.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
    },
    [measure],
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    // jsdom reports every dimension as 0, so `distance` is 0 there and this stays
    // harmlessly at the bottom -- the behaviour is asserted in the browser
    // (`e2e/ai-pane.spec.ts`), where there are real pixels to assert about.
    if (!atBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, atBottom, scrollToBottom };
}

/**
 * The listener attached to each element, so the callback ref can remove exactly
 * the function it added. A `WeakMap` rather than a second ref because a callback
 * ref can be invoked with a new element before the old one is detached, and
 * keeping the pairing on the element itself makes that ordering irrelevant.
 */
const handlers = new WeakMap<HTMLElement, () => void>();
