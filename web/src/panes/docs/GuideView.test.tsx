import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Guide, GuideProvenance } from '~/lib/guides/types';

import { GuideView } from './GuideView';

/**
 * Issue #19's "mid-section anchors" gap: `Steps` has a nested heading, `The
 * when step`, whose own `[#the-when-step]` anchor -- upstream's real one,
 * see internal/guides/snapshot's configuration-reference.adoc -- is what a
 * `<<the-when-step>>` cross-reference targets. Before this issue,
 * `Guide.anchors` could only ever point navigation at the *section*
 * (`steps`), because that was the most precise thing available; the heading
 * block itself has always carried `id: 'the-when-step'` (`GuideBlocks.tsx`
 * already rendered `<h4 id={block.id}>`), so the fix is entirely in how this
 * view uses that id, not in the data.
 */
const GUIDE: Guide = {
  id: 'configuration-reference',
  origin: 'circleci',
  title: 'Configuration reference',
  url: 'https://circleci.com/docs/reference/configuration-reference/',
  anchors: {
    steps: 'steps',
    'the-when-step': 'steps',
  },
  sections: [
    {
      id: 'version',
      level: 2,
      title: 'version',
      titleSpans: [{ kind: 'code', text: 'version' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#version',
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'See ' },
            {
              kind: 'ref',
              text: 'the when step',
              target: 'the-when-step',
              children: [{ kind: 'text', text: 'the when step' }],
            },
            { kind: 'text', text: '.' },
          ],
        },
      ],
    },
    {
      id: 'steps',
      level: 2,
      title: 'steps',
      titleSpans: [{ kind: 'code', text: 'steps' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#steps',
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'A list of steps to run.' }],
        },
        {
          kind: 'heading',
          level: 4,
          id: 'the-when-step',
          spans: [{ kind: 'text', text: 'The when step' }],
        },
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Details about when.' }],
        },
      ],
    },
  ],
};

const PROVENANCE: GuideProvenance = {
  repo: 'circleci/circleci-docs',
  ref: 'main',
  commit: 'abc1234',
  committedAt: '2026-01-01T00:00:00Z',
  fetchedAt: '2026-01-01T00:00:00Z',
  source: 'vendored',
  refreshing: false,
};

function Harness() {
  const [guideId, setGuideId] = useState('configuration-reference');
  const [sectionId, setSectionId] = useState<string | null>('version');
  return (
    <GuideView
      guides={[GUIDE]}
      provenance={PROVENANCE}
      guideId={guideId}
      onGuideChange={setGuideId}
      sectionId={sectionId}
      onSectionChange={setSectionId}
      onRefresh={() => {}}
    />
  );
}

describe('GuideView: mid-section anchor navigation (issue #19)', () => {
  let scrollIntoView: ReturnType<
    typeof vi.fn<(options?: ScrollIntoViewOptions) => void>
  >;

  beforeEach(() => {
    // jsdom does not implement scrollIntoView; GuideView already guards its
    // absence (see its own doc comment), but asserting *which* element was
    // scrolled to needs a real spy in its place.
    scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('following a cross-reference to a mid-section heading scrolls to that heading, not just its section', () => {
    render(<Harness />);

    const crossRef = screen.getByRole('button', { name: 'the when step' });
    fireEvent.click(crossRef);

    // The section containing the heading is now shown...
    expect(
      within(screen.getByTestId('guide-content')).getByText(
        'Details about when.',
      ),
    ).toBeInTheDocument();

    // ...and the heading itself -- not the section's own top -- is what got
    // scrolled into view.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const scrolledTo = scrollIntoView.mock.contexts[0] as Element;
    expect(scrolledTo.id).toBe('the-when-step');
  });

  it('a plain section-list click never replays a stale pending anchor from an earlier ref click', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'the when step' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockClear();

    // Switching to a different section by its own nav entry must not
    // re-trigger a scroll to the *previous* click's anchor.
    fireEvent.click(
      within(screen.getByTestId('guide-nav')).getByRole('button', {
        name: 'version',
      }),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('a cross-reference whose target is a section itself (not a nested block) does not scroll -- there is nothing more specific to scroll to', () => {
    const guideWithSectionRef: Guide = {
      ...GUIDE,
      sections: [
        {
          ...GUIDE.sections[0]!,
          blocks: [
            {
              kind: 'paragraph',
              spans: [
                {
                  kind: 'ref',
                  text: 'steps',
                  target: 'steps',
                  children: [{ kind: 'text', text: 'steps' }],
                },
              ],
            },
          ],
        },
        GUIDE.sections[1]!,
      ],
    };

    render(
      <GuideView
        guides={[guideWithSectionRef]}
        provenance={PROVENANCE}
        guideId="configuration-reference"
        onGuideChange={() => {}}
        sectionId="version"
        onSectionChange={() => {}}
        onRefresh={() => {}}
      />,
    );

    fireEvent.click(
      within(screen.getByTestId('guide-content')).getByRole('button', {
        name: 'steps',
      }),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
