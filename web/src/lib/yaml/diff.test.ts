import { describe, expect, it } from 'vitest';

import { countChangedLines, unifiedDiff } from './diff';

describe('unifiedDiff', () => {
  it('returns an empty list for identical text', () => {
    const text = 'a: 1\nb: 2\n';
    expect(unifiedDiff(text, text, 'config.yml')).toEqual([]);
  });

  it('produces a hunk with contextual lines around a single change', () => {
    const before = 'a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n';
    const after = 'a: 1\nb: 2\nc: 30\nd: 4\ne: 5\n';

    const lines = unifiedDiff(before, after, 'config.yml');
    expect(lines[0]).toMatchObject({ type: 'hunk' });
    expect(lines).toEqual(
      expect.arrayContaining([
        { type: 'del', text: 'c: 3', oldLine: 3 },
        { type: 'add', text: 'c: 30', newLine: 3 },
      ]),
    );

    const { additions, deletions } = countChangedLines(lines);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });

  it('emits a separate hunk for each far-apart change', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
    const before = lines.join('\n') + '\n';
    const changed = [...lines];
    changed[0] = 'CHANGED0';
    changed[39] = 'CHANGED39';
    const after = changed.join('\n') + '\n';

    const result = unifiedDiff(before, after, 'config.yml');
    const hunkCount = result.filter((l) => l.type === 'hunk').length;
    expect(hunkCount).toBe(2);
  });

  it('does not miscount a trailing no-newline marker as a content line', () => {
    const before = 'a: 1\n';
    const after = 'a: 2';
    const lines = unifiedDiff(before, after, 'config.yml');
    const noNewlineMarkers = lines.filter((l) =>
      l.text.startsWith('No newline'),
    );
    for (const marker of noNewlineMarkers) {
      expect(marker.oldLine).toBeUndefined();
      expect(marker.newLine).toBeUndefined();
    }
  });
});
