import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BOTTOM_SLACK_PX, useStickToBottom } from './useStickToBottom';

/**
 * Issue #207. jsdom implements no layout, so the scroll geometry is stubbed on a
 * real element -- which is exactly the right level for this hook: the *rule* (stick
 * unless the user scrolled away) is arithmetic over three numbers, and the pixels
 * are asserted in the browser by `e2e/ai-pane.spec.ts`.
 */
function scrollableDiv({
  scrollHeight,
  clientHeight,
  scrollTop = 0,
}: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  let top = scrollTop;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = next;
    },
  });
  document.body.append(element);
  return element;
}

describe('useStickToBottom', () => {
  it('scrolls to the newest message when the transcript changes', () => {
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useStickToBottom<HTMLDivElement>([count]),
      { initialProps: { count: 1 } },
    );
    act(() => result.current.ref(element));

    rerender({ count: 2 });
    expect(element.scrollTop).toBe(1_000);
  });

  it('stops sticking once the user has scrolled up to read history', () => {
    // #207 is explicit: a reply must not be yanked out from under someone
    // mid-read.
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useStickToBottom<HTMLDivElement>([count]),
      { initialProps: { count: 1 } },
    );
    act(() => result.current.ref(element));

    act(() => {
      element.scrollTop = 100;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(false);

    rerender({ count: 2 });
    expect(element.scrollTop).toBe(100);
  });

  it('resumes the moment the user comes back to the bottom', () => {
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useStickToBottom<HTMLDivElement>([count]),
      { initialProps: { count: 1 } },
    );
    act(() => result.current.ref(element));

    act(() => {
      element.scrollTop = 100;
      element.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      element.scrollTop = 800;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(true);

    rerender({ count: 2 });
    expect(element.scrollTop).toBe(1_000);
  });

  it('opens on the newest message, not on the top of the history', () => {
    // The situation #207 was reported from: the pane mounts with a conversation
    // already in it. Measuring first would read a scroll position no user chose as
    // "the user has scrolled up".
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>([1]));
    act(() => result.current.ref(element));
    expect(element.scrollTop).toBe(1_000);
    expect(result.current.atBottom).toBe(true);
  });

  it('treats a hair short of the bottom as the bottom', () => {
    // Sub-pixel rounding and fractional device pixel ratios make an exact
    // comparison flap, and flapping here is a "Jump to newest" button blinking on
    // and off while a reply arrives.
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>([1]));
    act(() => result.current.ref(element));

    act(() => {
      element.scrollTop = 800 - BOTTOM_SLACK_PX;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(true);

    act(() => {
      element.scrollTop = 800 - BOTTOM_SLACK_PX - 1;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(false);
  });

  it('goes back to the bottom on demand, and starts sticking again', () => {
    const element = scrollableDiv({ scrollHeight: 1_000, clientHeight: 200 });
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>([1]));
    act(() => result.current.ref(element));

    act(() => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.atBottom).toBe(false);

    act(() => result.current.scrollToBottom());
    expect(element.scrollTop).toBe(1_000);
    expect(result.current.atBottom).toBe(true);
  });

  it('does nothing, and throws nothing, with no container', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useStickToBottom<HTMLDivElement>([count]),
      { initialProps: { count: 1 } },
    );
    expect(() => {
      act(() => result.current.scrollToBottom());
      rerender({ count: 2 });
    }).not.toThrow();
  });
});
