import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';
import {
  COMPOSER_KEYBOARD_STEP_PX,
  COMPOSER_MIN_PX,
  UNMEASURED_MAX_PX,
  readPersistedComposerHeight,
} from './composerSize';

/**
 * Stubs the height jsdom cannot compute (it implements no layout, so every
 * `scrollHeight` is 0), and returns the undo. `scrollHeight` lives on
 * `Element.prototype` there, not `HTMLElement.prototype`, so the restore has to
 * *delete* the own property this adds rather than write a captured descriptor
 * back -- getting that wrong leaks the stub into every later test in the file.
 */
function stubContentHeight(px: number): () => void {
  const own = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => px,
  });
  return () => {
    if (own) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', own);
      return;
    }
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollHeight;
  };
}

function renderComposer(
  overrides: Partial<Parameters<typeof Composer>[0]> = {},
) {
  const onSubmit = vi.fn<() => void>();
  const onDraftChange = vi.fn<(draft: string) => void>();
  const utils = render(
    <Composer
      draft=""
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
      configured
      sending={false}
      availablePx={0}
      {...overrides}
    />,
  );
  return { ...utils, onSubmit, onDraftChange };
}

const handle = () => screen.getByRole('separator', { name: /resize/i });

/**
 * Issue #186, at the level a user touches: the box can be resized *without a
 * mouse*, the size it ends up at is the size that comes back after a reload, and
 * Enter-versus-newline does not change as it grows.
 *
 * jsdom implements no layout, so `availablePx` is 0 here and the sizing falls
 * back to `UNMEASURED_MAX_PX` -- exactly the path `composerSize.ts` documents for
 * an unmeasured pane, and the reason a keyboard resize must still work there
 * instead of clamping to nothing.
 */
describe('Composer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('exposes the resize affordance as a keyboard-reachable separator', () => {
    renderComposer();
    const separator = handle();
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(separator).toHaveAttribute('tabindex', '0');
    expect(separator).toHaveAttribute('aria-valuenow', String(COMPOSER_MIN_PX));
    expect(separator).toHaveAttribute('aria-valuemin', String(COMPOSER_MIN_PX));
    expect(separator).toHaveAttribute(
      'aria-valuemax',
      String(UNMEASURED_MAX_PX),
    );
  });

  it('resizes with the arrow keys and persists what the user chose', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.tab();
    // The separator is the first focusable thing in the composer.
    expect(handle()).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    const taller = COMPOSER_MIN_PX + COMPOSER_KEYBOARD_STEP_PX;
    expect(handle()).toHaveAttribute('aria-valuenow', String(taller));
    expect(readPersistedComposerHeight()).toBe(taller);

    await user.keyboard('{ArrowDown}');
    expect(handle()).toHaveAttribute('aria-valuenow', String(COMPOSER_MIN_PX));
    expect(readPersistedComposerHeight()).toBe(COMPOSER_MIN_PX);

    // End/Home reach the ends of the range, matching `Splitter`'s contract.
    await user.keyboard('{End}');
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(UNMEASURED_MAX_PX),
    );
    await user.keyboard('{Home}');
    expect(handle()).toHaveAttribute('aria-valuenow', String(COMPOSER_MIN_PX));
  });

  it('starts at the height the user last chose, on the very first render', () => {
    // Read in a `useState` initialiser, not an effect, so there is no frame of
    // the old size -- same approach as `DagPane`'s inspector width.
    window.localStorage.setItem(
      'vce.aiComposer',
      JSON.stringify({ schemaVersion: 1, heightPx: 180 }),
    );
    renderComposer();
    expect(handle()).toHaveAttribute('aria-valuenow', '180');
    expect(screen.getByLabelText(/message the ai assistant/i)).toHaveStyle({
      height: '180px',
    });
  });

  it('keeps Enter sending and Shift+Enter newlining at every size', async () => {
    const { onSubmit, onDraftChange } = renderComposer({ draft: 'a question' });
    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/message the ai assistant/i);

    await user.click(textarea);
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Grow the box, then check the rule has not changed with it -- the failure
    // mode this pins is a composer that starts sending on ⌘Enter once it is
    // multiline, which is what "predictable" rules out.
    await user.click(handle());
    await user.keyboard('{End}');
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(UNMEASURED_MAX_PX),
    );

    await user.click(textarea);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Shift+Enter reaches the text area as an ordinary newline.
    expect(onDraftChange).toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('describes the text area with the Enter rule always, and shows it once the box has grown', async () => {
    renderComposer();
    const textarea = screen.getByLabelText(/message the ai assistant/i);
    const hintId = textarea.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId as string);
    expect(hint?.textContent).toMatch(
      /Enter sends .* Shift\+Enter adds a line/,
    );
    // At the minimum height it costs the transcript no pixels, but a screen
    // reader still gets it.
    expect(hint?.className).toBe('sr-only');

    const user = userEvent.setup();
    await user.click(handle());
    await user.keyboard('{ArrowUp}');
    expect(document.getElementById(hintId as string)?.className).not.toBe(
      'sr-only',
    );
  });

  it('stays inert with no provider key configured', () => {
    renderComposer({ configured: false });
    expect(screen.getByLabelText(/message the ai assistant/i)).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /send message/i }),
    ).toBeDisabled();
    // The resize affordance is still there: nothing about having no key makes
    // reading a seeded prompt less useful (#148 seeds one even with no key).
    expect(handle()).toBeInTheDocument();
  });

  /**
   * Issue #209's replacement for `DraftPreview`. The requirement from #186 stands
   * -- a user must be able to see what they are about to send -- and after #209 the
   * *input* is what has to show it. So the one thing that must never happen is the
   * box holding thirty lines and saying nothing about it.
   */
  describe('a draft the box cannot show (issue #209)', () => {
    const LONG_DRAFT = Array.from(
      { length: 30 },
      (_, index) => `detail line ${index + 1}`,
    ).join('\n');

    it('says how many lines it is holding, and that they scroll', () => {
      // jsdom reports 0 for every measurement, so the content height is stubbed:
      // the property under test is what the composer *says* when the text is
      // taller than the box.
      const restore = stubContentHeight(900);
      try {
        renderComposer({ draft: LONG_DRAFT, availablePx: 200 });
        expect(
          screen.getByTestId('ai-composer-overflow').textContent,
        ).toContain('30 lines');
        const textarea = screen.getByLabelText(/message the ai assistant/i);
        const hint = document.getElementById(
          textarea.getAttribute('aria-describedby') as string,
        );
        // The full sentence is in the text area's own description, so this is not
        // a visual-only affordance.
        expect(hint?.textContent).toMatch(/30 lines and taller than the box/);
        expect(hint?.textContent).toMatch(/scroll it to read the rest/);
      } finally {
        restore();
      }
    });

    it('says nothing at all when the whole draft fits', () => {
      renderComposer({ draft: 'short question', availablePx: 200 });
      expect(
        screen.queryByTestId('ai-composer-overflow'),
      ).not.toBeInTheDocument();
    });

    it('costs no height, because the pane it matters most on has none', () => {
      // The count rides inside the text area's own corner rather than taking a
      // row: on `graph-focus` the box is at its 56px minimum with nowhere to put a
      // line of prose, and that is exactly the pane where a user is about to send
      // thirty lines having read two.
      const restore = stubContentHeight(900);
      try {
        renderComposer({ draft: LONG_DRAFT, availablePx: 90 });
        const chip = screen.getByTestId('ai-composer-overflow');
        expect(chip.className).toContain('absolute');
        // ...and there is no handle to spend 12px on either, because at this size
        // there is no range for it to move through.
        expect(
          screen.queryByRole('separator', { name: /resize/i }),
        ).not.toBeInTheDocument();
      } finally {
        restore();
      }
    });

    it('shows a seeded prompt from its beginning, not its end', () => {
      // Filling a text area programmatically leaves the caret at the end, so the
      // error the prompt opens with was the one part off screen.
      const restore = stubContentHeight(900);
      try {
        const { rerender } = renderComposer({ draft: '', availablePx: 400 });
        const textarea = screen.getByLabelText(
          /message the ai assistant/i,
        ) as HTMLTextAreaElement;
        textarea.scrollTop = 400;
        rerender(
          <Composer
            draft={LONG_DRAFT}
            onDraftChange={() => {}}
            onSubmit={() => {}}
            configured
            sending={false}
            availablePx={400}
            seedSeq={1}
          />,
        );
        expect(textarea.scrollTop).toBe(0);
        expect(textarea.selectionStart).toBe(0);
        expect(textarea.selectionEnd).toBe(0);
      } finally {
        restore();
      }
    });
  });
});
