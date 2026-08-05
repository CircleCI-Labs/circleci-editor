import { describe, expect, it } from 'vitest';

import { defaultSectionOpen } from './inspectorSections';

/**
 * The defaults rule from issue #219, which says defaults matter more than the
 * mechanism -- so it gets its own tests rather than being asserted only through
 * the rendered pane.
 */
describe('defaultSectionOpen (issue #219)', () => {
  it('opens a section that has content', () => {
    expect(defaultSectionOpen('post-steps', true)).toBe(true);
    expect(defaultSectionOpen('context', true)).toBe(true);
    expect(defaultSectionOpen('filters', true)).toBe(true);
    expect(defaultSectionOpen('requires', true)).toBe(true);
  });

  it('closes a section that is empty -- the owner’s named candidates included', () => {
    expect(defaultSectionOpen('pre-steps', false)).toBe(false);
    expect(defaultSectionOpen('post-steps', false)).toBe(false);
    // Generalised rather than a fixed list of two: the same rule reaches the
    // sections that are empty just as often and were never named.
    expect(defaultSectionOpen('context', false)).toBe(false);
    expect(defaultSectionOpen('filters', false)).toBe(false);
    expect(defaultSectionOpen('requires', false)).toBe(false);
  });

  it('closes the workflow-level sections (issue #288) when empty, and opens them with content', () => {
    expect(defaultSectionOpen('workflow-condition', false)).toBe(false);
    expect(defaultSectionOpen('workflow-condition', true)).toBe(true);
    expect(defaultSectionOpen('workflow-triggers', false)).toBe(false);
    expect(defaultSectionOpen('workflow-triggers', true)).toBe(true);
  });

  it('keeps Steps open even when empty, because its Add form lives inside it', () => {
    // The one exception, and the reason for it: applying the content rule
    // naively would close the Steps section exactly for a job with no steps --
    // the one case where the user certainly came here to add one, and the "Add
    // a run step" form is inside the section.
    expect(defaultSectionOpen('steps', false)).toBe(true);
    expect(defaultSectionOpen('steps', true)).toBe(true);
  });
});
