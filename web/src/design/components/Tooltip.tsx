import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Thin wrapper around Radix Tooltip, styled to match the dark panel UI.
 * `delayDuration={300}` mirrors production's own tooltip timing (issue #90's
 * audit; CircleCI's job-card/control tooltips use `delay={300}`) rather than
 * an arbitrary value -- close enough that a user moving between this app and
 * production doesn't notice a different hover rhythm.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className="z-50 max-w-xs rounded-md border border-cc-border-strong bg-cc-panel-raised px-2.5 py-1.5 text-xs text-cc-text shadow-lg"
          >
            {content}
            <RadixTooltip.Arrow className="fill-cc-panel-raised" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
