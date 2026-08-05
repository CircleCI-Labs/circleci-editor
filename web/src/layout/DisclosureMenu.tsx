/**
 * The one dropdown-menu shape this app has, extracted (issue #154) from
 * issue #121's "Move pane" menu so the two *new* menus that responsive
 * collapse introduces -- the file switcher's and the preset switcher's
 * compact forms -- are the same widget, not two more hand-rolled ones.
 *
 * That matters beyond tidiness: the whole point of collapsing a row of
 * buttons into a menu is that the menu is still reachable, and every
 * keyboard/dismissal detail #121 got right (Escape closes and returns focus
 * to the trigger, an outside `pointerdown` closes, choosing an item closes
 * and returns focus) has to hold for all three or "collapses to a menu"
 * becomes "collapses out of reach" for a keyboard user. One implementation
 * is the only way that stays true.
 *
 * Still hand-rolled rather than a library menu, for exactly the reason #121
 * gave: this app has no dropdown-menu dependency (`@radix-ui/react-dialog`/
 * `-switch`/`-tooltip` cover other widget shapes, none of them this one) and
 * the interaction is small enough not to justify adding one.
 *
 * The panel is portaled to `document.body` (`createPortal`) rather than being
 * an ordinary `absolute`-positioned child of the trigger -- discovered
 * against the real running app during #121, and now doubly true: every
 * `PaneSlot` sits inside an ancestor with `overflow-hidden` (so a flexible
 * pane can never drag the page wider -- see `LayoutRoot.tsx`), *and* the app
 * bar itself now clips too (see `App.tsx`), so a non-portaled panel hanging
 * below a 48px-tall header would be cut off at the header's own bottom edge.
 * A portal escapes both clipping boxes; `computeMenuPosition` recovers the
 * on-screen placement a non-portaled `absolute` child would have had.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Default panel width. `w-44`-equivalent, matching what #121's Move menu
 * rendered at; needed as a number up front so `computeMenuPosition` can keep
 * a right-aligned panel from overshooting the viewport's left edge. */
export const MENU_WIDTH_PX = 176;

/** Shared classes for a plain item inside a menu panel. */
export const menuItemClassName =
  'block w-full rounded px-2 py-1 text-left text-xs text-cc-text hover:bg-cc-panel focus-visible:bg-cc-panel outline-none';

/** Shared classes for a small uppercase group heading inside a menu panel. */
export const menuSectionClassName =
  'px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-cc-text-faint';

/**
 * Where to portal a panel of `widthPx`, given its trigger's current
 * on-screen position: right-aligned under the button, clamped so it stays
 * within the viewport rather than trusting the trigger's own position never
 * to push it off an edge.
 */
export function computeMenuPosition(
  button: HTMLElement,
  widthPx: number,
): { top: number; left: number } {
  const rect = button.getBoundingClientRect();
  const left = Math.max(
    4,
    Math.min(rect.right - widthPx, window.innerWidth - widthPx - 4),
  );
  return { top: rect.bottom + 4, left };
}

export function DisclosureMenu({
  triggerContent,
  triggerClassName,
  triggerLabel,
  triggerTitle,
  menuLabel,
  widthPx = MENU_WIDTH_PX,
  children,
}: {
  /** What the trigger button renders. */
  triggerContent: ReactNode;
  triggerClassName: string;
  /** The trigger's accessible name, when it needs to say more than
   * `triggerContent`'s own text does. Omit to let the visible text be the
   * name (which is what keeps "label in name" trivially true). */
  triggerLabel?: string;
  triggerTitle: string;
  /** The panel's accessible name -- what this menu is *for*, since a
   * `role="menu"` gets no name from its items. */
  menuLabel: string;
  widthPx?: number;
  /** Render prop, so an item can close the menu (and hand focus back to the
   * trigger) as part of whatever it does. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function isOutside(target: Node | null): boolean {
      return (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      );
    }
    function handlePointerDown(event: PointerEvent) {
      if (isOutside(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function toggleOpen() {
    if (!open && buttonRef.current) {
      setPosition(computeMenuPosition(buttonRef.current, widthPx));
    }
    setOpen((wasOpen) => !wasOpen);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerTitle}
        className={triggerClassName}
      >
        {triggerContent}
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={menuLabel}
              style={{ top: position.top, left: position.left, width: widthPx }}
              className="fixed z-50 rounded-md border border-cc-border-strong bg-cc-panel-raised p-1 text-xs shadow-lg"
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
