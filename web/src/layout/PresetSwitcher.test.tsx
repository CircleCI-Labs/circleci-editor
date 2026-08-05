import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildDefaultPersistedLayout,
  useLayoutStore,
} from '~/state/layoutStore';

import { PresetSwitcher } from './PresetSwitcher';
import { PRESETS } from './presets';

function resetStoreToDefaults(): void {
  window.localStorage.clear();
  const defaults = buildDefaultPersistedLayout();
  useLayoutStore.setState({
    activePreset: defaults.activePreset,
    presetStates: defaults.presets,
    custom: defaults.custom,
  });
}

describe('PresetSwitcher', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  it('is reachable as a labelled group with one button per preset', () => {
    render(<PresetSwitcher />);
    const group = screen.getByRole('group', { name: /pane layout/i });
    for (const preset of PRESETS) {
      expect(
        within(group).getByRole('button', { name: preset.label }),
      ).toBeInTheDocument();
    }
  });

  it('marks the active preset pressed and switches the store on click', () => {
    render(<PresetSwitcher />);

    // 'Graph focus' is DEFAULT_PRESET_ID (see presets.ts) as of the
    // first-run layout change, not 'Columns'.
    expect(screen.getByRole('button', { name: 'Graph focus' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));

    expect(useLayoutStore.getState().activePreset).toBe('three-column');
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Graph focus' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // Issue #121.
  describe('the Custom pill', () => {
    it('is absent until the user has rearranged a pane', () => {
      render(<PresetSwitcher />);
      expect(
        screen.queryByRole('button', { name: 'Custom' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /reset custom layout/i }),
      ).not.toBeInTheDocument();
    });

    it('appears, pressed, as soon as a move creates a custom layout', () => {
      render(<PresetSwitcher />);
      act(() => {
        useLayoutStore.getState().swapPanes('yaml', 'dag');
      });

      expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // The preset it displaced no longer shows as pressed.
      expect(
        screen.getByRole('button', { name: 'Graph focus' }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('switches back to the custom layout when clicked after a named preset was chosen', () => {
      render(<PresetSwitcher />);
      act(() => {
        useLayoutStore.getState().swapPanes('yaml', 'dag');
      });
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      expect(useLayoutStore.getState().activePreset).toBe('three-column');

      fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
      expect(useLayoutStore.getState().activePreset).toBe('custom');
    });

    it('Reset discards the custom layout and returns to its starting preset, hiding the pill again', () => {
      render(<PresetSwitcher />);
      act(() => {
        useLayoutStore.getState().setPreset('editor-focus');
        useLayoutStore.getState().swapPanes('yaml', 'ai');
      });
      expect(
        screen.getByRole('button', { name: 'Custom' }),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: /reset custom layout/i }),
      );

      expect(useLayoutStore.getState().activePreset).toBe('editor-focus');
      expect(useLayoutStore.getState().custom).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Custom' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Editor focus' }),
      ).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // Issue #154: on a narrow window the app bar collapses this row of pills --
  // by far its widest item -- to a single menu, which is what buys the file
  // switcher enough room to stay a row of buttons. Everything the row could do
  // must still be reachable, and reachable by keyboard.
  describe('compact form (issue #154)', () => {
    it('collapses to one trigger labelled with the active preset, still inside the same labelled group', () => {
      render(<PresetSwitcher compact />);

      const group = screen.getByRole('group', { name: /pane layout/i });
      const trigger = within(group).getByRole('button');
      // 'Graph focus' is DEFAULT_PRESET_ID -- see presets.ts.
      expect(trigger).toHaveTextContent('Graph focus');
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      // The visible label alone wouldn't say what the button is, so the
      // accessible name keeps it as a prefix and adds that.
      expect(trigger).toHaveAccessibleName(/^Graph focus/);
      expect(trigger).toHaveAccessibleName(/change the pane layout/i);
    });

    it('offers every preset as a single-choice menu item, with the active one checked', () => {
      render(<PresetSwitcher compact />);
      fireEvent.click(screen.getByRole('button'));

      const menu = screen.getByRole('menu', { name: /pane layout/i });
      for (const preset of PRESETS) {
        expect(
          within(menu).getByRole('menuitemradio', { name: preset.label }),
        ).toBeInTheDocument();
      }
      expect(
        within(menu).getByRole('menuitemradio', { name: 'Graph focus' }),
      ).toHaveAttribute('aria-checked', 'true');
    });

    it('choosing a preset switches the store, closes the menu and returns focus to the trigger', () => {
      render(<PresetSwitcher compact />);
      const trigger = screen.getByRole('button');
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Columns' }));

      expect(useLayoutStore.getState().activePreset).toBe('three-column');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button')).toHaveFocus();
      expect(screen.getByRole('button')).toHaveTextContent('Columns');
    });

    it('Escape closes the menu without changing the layout, and hands focus back', () => {
      render(<PresetSwitcher compact />);
      const trigger = screen.getByRole('button');
      fireEvent.click(trigger);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(useLayoutStore.getState().activePreset).toBe('graph-focus');
      expect(trigger).toHaveFocus();
    });

    it("still reaches issue #121's Custom arrangement and its Reset, which the pills carry as separate controls", () => {
      render(<PresetSwitcher compact />);
      act(() => {
        useLayoutStore.getState().swapPanes('yaml', 'dag');
      });
      // The swap itself activates 'custom' (see layoutStore), so the trigger
      // now names it.
      expect(screen.getByRole('button')).toHaveTextContent('Custom');

      fireEvent.click(screen.getByRole('button'));
      expect(
        screen.getByRole('menuitemradio', { name: 'Custom' }),
      ).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(
        screen.getByRole('menuitem', { name: /reset custom layout/i }),
      );

      expect(useLayoutStore.getState().custom).toBeNull();
      expect(useLayoutStore.getState().activePreset).toBe('graph-focus');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
