import { describe, expect, it } from 'vitest';

import { serializeMinimalDiff } from './spliceSerialize';
import { addJobFromExecutor } from '~/lib/mutations/configMutations';
import {
  cloneDocument,
  deleteIn,
  moveSeqItem,
  parseConfig,
  renameKey,
  setIn,
} from './documentUtils';
import { countChangedLines, unifiedDiff } from './diff';

import fullConfig from '../../fixtures/full-config.yml?raw';
import alignedComments from '~/fixtures/aligned-comments.yml?raw';
import mixedIndentRequires from '~/fixtures/mixed-indent-requires.yml?raw';

/** Parses `before`, applies `fn` to a clone, and returns the spliced result. */
function mutate(
  before: string,
  fn: (doc: ReturnType<typeof parseConfig>['doc'] & object) => void,
): string {
  const { doc: oldDoc } = parseConfig(before);
  if (!oldDoc) throw new Error('fixture failed to parse');
  const newDoc = cloneDocument(oldDoc);
  fn(newDoc as ReturnType<typeof parseConfig>['doc'] & object);
  return serializeMinimalDiff(before, oldDoc, newDoc);
}

/** Every line that differs between `before` and `after`, keyed by 1-based line number. */
function changedLineNumbers(before: string, after: string): number[] {
  const lines = unifiedDiff(before, after, 'config.yml');
  const nums = new Set<number>();
  for (const line of lines) {
    if (line.type === 'del' && line.oldLine) nums.add(line.oldLine);
    if (line.type === 'add' && line.newLine) nums.add(line.newLine);
  }
  return [...nums].sort((a, b) => a - b);
}

describe('serializeMinimalDiff -- issue #81 (requires: indentation churn)', () => {
  it('a fully unrelated edit leaves both mixed-style requires: blocks byte-identical', () => {
    const before = mixedIndentRequires;
    const after = mutate(before, (doc) => {
      setIn(
        doc,
        ['jobs', 'lint-backend', 'docker', 0, 'image'],
        'cimg/python:3.12',
      );
    });

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);
    // Exactly the one edited line changes.
    expect(additions).toBe(1);
    expect(deletions).toBe(1);

    // The whole point of #81: these status-conditioned requires: blocks used
    // a shallower indent than this file's other sequences, and a naive
    // `doc.toString()` normalises them both to the deeper convention (proven
    // in this module's own investigation -- see the PR). Splicing must not
    // touch either one.
    expect(after).toContain(
      '            - lint-backend:\n              - success\n              - failed\n',
    );
    const occurrences =
      after.split(
        '- lint-backend:\n              - success\n              - failed',
      ).length - 1;
    expect(occurrences).toBe(2);
  });

  it('preserves trailing whitespace on an untouched blank line', () => {
    const before = mixedIndentRequires;
    const after = mutate(before, (doc) => {
      setIn(
        doc,
        ['jobs', 'lint-backend', 'docker', 0, 'image'],
        'cimg/python:3.12',
      );
    });
    expect(after).toContain('    type: boolean\n    \n    default: false\n');
  });

  it('preserves trailing blank lines at end of file', () => {
    const before = mixedIndentRequires;
    const after = mutate(before, (doc) => {
      setIn(
        doc,
        ['jobs', 'lint-backend', 'docker', 0, 'image'],
        'cimg/python:3.12',
      );
    });
    expect(after.endsWith('- failed\n\n\n\n')).toBe(true);
  });

  it('an edit inside one requires: block only touches that block, not its sibling', () => {
    const before = mixedIndentRequires;
    const { doc: oldDoc } = parseConfig(before);
    if (!oldDoc) throw new Error('fixture failed to parse');
    const newDoc = cloneDocument(oldDoc);
    setIn(
      newDoc,
      [
        'workflows',
        'main',
        'jobs',
        2,
        'test-backend',
        'requires',
        0,
        'lint-backend',
        0,
      ],
      'success',
    );
    const after = serializeMinimalDiff(before, oldDoc, newDoc);

    // The second (build-backend) requires: block is a byte-for-byte
    // untouched sibling.
    expect(after).toContain(
      '      - build-backend:\n          requires:\n            - lint-backend:\n              - success\n              - failed\n',
    );
  });
});

describe('serializeMinimalDiff -- issue #39 (comment padding/relocation)', () => {
  it('an unrelated edit leaves every aligned/relocatable comment in aligned-comments.yml untouched', () => {
    const before = alignedComments;
    const { doc: oldDoc, error } = parseConfig(before);
    expect(error).toBeNull();
    if (!oldDoc) throw new Error('fixture failed to parse');
    const newDoc = cloneDocument(oldDoc);

    // Any single scalar edit far from the comments; if the splice is
    // working, the whole rest of the file -- including every padded/aligned
    // comment -- is reused verbatim, so the naive normalisation from #39
    // never has a chance to fire.
    setIn(newDoc, ['version'], 2.1);
    const after = serializeMinimalDiff(before, oldDoc, newDoc);

    expect(after).toBe(before);
  });
});

describe('serializeMinimalDiff -- matches or beats the existing round-trip suite', () => {
  it('setIn on a scalar changes exactly one line (same bound as the naive-stringify suite)', () => {
    const before = fullConfig;
    const after = mutate(before, (doc) => {
      setIn(doc, ['executors', 'node-medium', 'resource_class'], 'large');
    });
    expect(changedLineNumbers(before, after)).toEqual([12]);
  });

  it('renameKey changes exactly one line', () => {
    const before = fullConfig;
    const after = mutate(before, (doc) => {
      expect(renameKey(doc, ['jobs'], 'test', 'unit_test')).toBe(true);
    });
    expect(changedLineNumbers(before, after)).toEqual([41]);
  });

  it('deleteIn of one job removes only that job and reattaches its section header, with zero unrelated churn', () => {
    const before = fullConfig;
    const after = mutate(before, (doc) => {
      expect(deleteIn(doc, ['jobs', 'deploy_staging'])).toBe(true);
    });
    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);
    expect(additions).toBe(0);
    expect(deletions).toBe(6);
    expect(after).toContain('# Deploy jobs');
    expect(after).toContain('# These only run against main, never on forks.');
  });

  it('moveSeqItem reorders without rewriting either moved entry', () => {
    const before = fullConfig;
    const after = mutate(before, (doc) => {
      expect(
        moveSeqItem(doc, ['workflows', 'build_test_deploy', 'jobs'], 1, 2),
      ).toBe(true);
    });
    expect(after).toContain('- deploy_staging:');
    expect(after).toContain('- test:');
    // Both moved entries keep their exact original text (just reordered) --
    // splicing has no reason to touch either one's own bytes.
    expect(after).toContain(
      '      - deploy_staging:\n          requires:\n            - test\n',
    );
  });

  it('addJobFromExecutor is still purely additive and keeps every prior line untouched', () => {
    const before = fullConfig;
    const { doc: oldDoc } = parseConfig(before);
    if (!oldDoc) throw new Error('fixture failed to parse');
    const newDoc = cloneDocument(oldDoc);
    addJobFromExecutor(newDoc, {
      name: 'lint',
      workflowName: 'build_test_deploy',
      executor: { kind: 'docker', image: 'cimg/node:20.0' },
    });
    const after = serializeMinimalDiff(before, oldDoc, newDoc);

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let cursor = 0;
    for (const line of beforeLines) {
      const found = afterLines.indexOf(line, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });
});

describe('serializeMinimalDiff -- safety net', () => {
  it('handles the document root changing kind entirely (map -> sequence) without throwing', () => {
    const { doc: oldDoc } = parseConfig('a: 1\n');
    const { doc: newDoc } = parseConfig('- 1\n- 2\n');
    if (!oldDoc || !newDoc) throw new Error('fixture failed to parse');
    let result = '';
    expect(() => {
      result = serializeMinimalDiff('a: 1\n', oldDoc, newDoc);
    }).not.toThrow();
    expect(parseConfig(result).error).toBeNull();
    expect(result).toBe('- 1\n- 2\n');
  });

  it('falls back to naive toString() when old and new documents disagree about what the new one means', () => {
    // A deliberately inconsistent pair -- `newDoc` here is not actually
    // derived from `oldText`/`oldDoc` at all, so nothing should line up.
    // The important thing is that the safety net still produces valid,
    // semantically-correct output rather than corrupted text.
    const oldText = 'jobs:\n  build:\n    x: 1\n';
    const { doc: oldDoc } = parseConfig(oldText);
    const { doc: newDoc } = parseConfig(
      'jobs:\n  build:\n    x: 1\n  deploy:\n    y: 2\n',
    );
    if (!oldDoc || !newDoc) throw new Error('fixture failed to parse');
    const result = serializeMinimalDiff(oldText, oldDoc, newDoc);
    expect(parseConfig(result).error).toBeNull();
    expect(parseConfig(result).doc?.toJS()).toEqual(newDoc.toJS());
  });

  it('never produces text that fails to reparse', () => {
    const before = mixedIndentRequires;
    const after = mutate(before, (doc) => {
      setIn(
        doc,
        ['jobs', 'test-backend', 'docker', 0, 'image'],
        'cimg/python:3.12-node',
      );
    });
    const { error } = parseConfig(after);
    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: a leading file-level comment used to disable this module
// entirely. It is parsed onto the *first pair's key* as its `commentBefore`
// and lives in the bytes before the root map's own range, so a splice that
// started at `root.range[0]` dropped it; the safety net then (correctly)
// rejected the result and fell back to whole-document `toString()`. Since
// every fixture in this repo -- and practically every real config -- opens
// with such a comment, the splice path was effectively dead code. Found while
// building issue #12's rename round-trip test, which is what these pin.
// ---------------------------------------------------------------------------

describe('serializeMinimalDiff -- leading file-level comment', () => {
  const LEADING = `# Widgets service pipeline.
# Owned by #platform-eng.
version: 2.1

jobs:
  build:
    docker:
      - image: cimg/base:2024.01 # pinned deliberately
    steps:
      - checkout
`;

  it('keeps the leading comment and splices only the edited line', () => {
    const after = mutate(LEADING, (doc) => {
      setIn(doc, ['jobs', 'build', 'docker', 0, 'image'], 'cimg/base:2025.01');
    });

    expect(after.startsWith('# Widgets service pipeline.\n')).toBe(true);
    expect(after).toContain('# Owned by #platform-eng.');
    // The trailing comment rides along on the one edited line, byte-identical
    // -- which is only true on the splice path; `toString()` moves it.
    expect(after).toContain('- image: cimg/base:2025.01 # pinned deliberately');
    const { additions, deletions } = countChangedLines(
      unifiedDiff(LEADING, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });

  it('splices rather than falling back -- the result differs from naive toString()', () => {
    // The distinguishing evidence that the splice path actually ran: a
    // trailing comment on a key whose value is a block collection stays on
    // its own line under `toString()` but keeps its original bytes under the
    // splice (verified against yaml@2.9). If this ever silently reverts to
    // the fallback, the two become byte-identical and this fails.
    const { doc: oldDoc } = parseConfig(LEADING);
    if (!oldDoc) throw new Error('fixture failed to parse');
    const newDoc = cloneDocument(oldDoc);
    setIn(newDoc, ['jobs', 'build', 'docker', 0, 'image'], 'cimg/base:2025.01');

    const spliced = serializeMinimalDiff(LEADING, oldDoc, newDoc);
    expect(spliced).not.toBe(newDoc.toString());
    expect(newDoc.toString().startsWith('# Widgets service pipeline.')).toBe(
      true,
    );
  });

  it('keeps a leading comment on a delete that removes the first job entirely', () => {
    const before = `# Header comment.
jobs:
  build:
    x: 1
  deploy:
    y: 2
`;
    const after = mutate(before, (doc) => {
      deleteIn(doc, ['jobs', 'deploy']);
    });
    expect(after).toBe(`# Header comment.
jobs:
  build:
    x: 1
`);
  });
});
