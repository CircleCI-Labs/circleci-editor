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

  it('splices rather than falling back -- aligned padding toString() would collapse', () => {
    // The distinguishing evidence that the splice path actually ran has to be
    // something only the splice can produce. It used to be "the two outputs
    // differ" for the LEADING fixture above, which passed for the wrong
    // reason: what differed was that the splice emitted the sequence item at
    // twelve columns instead of six. That is still valid, semantically
    // identical YAML, so the safety net accepted it and the test read a
    // mis-indentation as proof of success. Fixing the indentation made the two
    // outputs agree and this assertion fail -- a test that only ever passed
    // because of the bug it happened to be standing next to.
    //
    // Column-aligned trailing comments are proper evidence: `toString()` emits
    // exactly one space before a comment, so multi-space padding surviving can
    // only have come from the original bytes.
    const before = `version: 2.1

jobs:
  build:
    docker:
      - image: cimg/base:2024.12     # aligned deliberately
    resource_class: large            # and this one
    steps:
      - checkout
`;
    const { doc: oldDoc } = parseConfig(before);
    if (!oldDoc) throw new Error('fixture failed to parse');
    const newDoc = cloneDocument(oldDoc);
    setIn(newDoc, ['jobs', 'build', 'resource_class'], 'medium');

    const spliced = serializeMinimalDiff(before, oldDoc, newDoc);
    expect(spliced).not.toBe(newDoc.toString());
    expect(spliced).toContain(
      '- image: cimg/base:2024.12     # aligned deliberately',
    );
    expect(newDoc.toString()).toContain(
      '- image: cimg/base:2024.12 # aligned deliberately',
    );
  });

  it('keeps a sequence item at its own indentation when a sibling key changes', () => {
    // Pins the bug the assertion above used to be resting on: the item must
    // come back at the column it was written at, not at the parent's indent
    // plus a guess.
    const before = `jobs:
  build:
    docker:
      - image: cimg/base:2024.12
    steps:
      - checkout
`;
    const after = mutate(before, (doc) => {
      setIn(doc, ['jobs', 'build', 'docker', 0, 'image'], 'cimg/base:2025.01');
    });
    expect(after).toContain('\n      - image: cimg/base:2025.01\n');
    expect(changedLineNumbers(before, after)).toEqual([4]);
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

/**
 * These pin the two defects that made issue #6 ("the round-trip is not
 * byte-identical") visible in the save diff. Both were invisible from the
 * outside because `serializeMinimalDiff`'s safety net caught the malformed
 * splice and fell back to re-emitting the document -- so the symptom was
 * never "invalid YAML", it was "every comment in the file moved".
 */
describe('serializeMinimalDiff -- issue #6 (editing must not reflow the file)', () => {
  const NESTED = `version: 2.1

jobs:
  build:                        # comment on the job key
    executor: go
    resource_class: large       # aligned comment
    steps:
      - checkout                # aligned comment
`;

  it('editing the FIRST key of a nested block leaves every other line alone', () => {
    // The asymmetry that hid this: `executor` is `build`'s first child, so the
    // parent had already emitted its indentation and the regenerated pair
    // added it again. Editing `resource_class` -- the second child -- was
    // always fine, which made this look like an unrelated flake.
    const after = mutate(NESTED, (doc) => {
      setIn(doc, ['jobs', 'build', 'executor'], 'other');
    });
    expect(after).toContain('    executor: other');
    expect(after).toContain(
      '  build:                        # comment on the job key',
    );
    expect(after).toContain(
      '    resource_class: large       # aligned comment',
    );
    expect(after).toContain(
      '      - checkout                # aligned comment',
    );
    // Only the edited line may differ.
    expect(changedLineNumbers(NESTED, after)).toEqual([5]);
  });

  it('renaming the first key of a nested block keeps its indentation and inline comment', () => {
    const src = `jobs:\n  build: # compile\n    executor: go\n`;
    const after = mutate(src, (doc) => {
      renameKey(doc, ['jobs'], 'build', 'compile');
    });
    expect(after).toBe(`jobs:\n  compile: # compile\n    executor: go\n`);
  });

  it("preserves an aligned trailing comment's column when the value changes", () => {
    const after = mutate(NESTED, (doc) => {
      setIn(doc, ['jobs', 'build', 'resource_class'], 'medium');
    });
    // `medium` is shorter than `large`, so the comment stays in its column
    // rather than collapsing to a single space.
    expect(after).toContain(
      '    resource_class: medium      # aligned comment',
    );
    expect(changedLineNumbers(NESTED, after)).toEqual([6]);
  });

  it('falls back to a single space when the new value reaches the comment column', () => {
    // There is no alignment left to preserve once the value is that long, and
    // padding backwards is not an option -- a single space is what any
    // formatter would emit.
    const after = mutate(NESTED, (doc) => {
      setIn(
        doc,
        ['jobs', 'build', 'resource_class'],
        'a-very-long-resource-class-name',
      );
    });
    expect(after).toContain(
      '    resource_class: a-very-long-resource-class-name # aligned comment',
    );
  });

  it('does not eat the "- " of a map nested in a sequence item', () => {
    // keyLineStart walks back over indentation only, so a key preceded by
    // `- ` on its line keeps it: the walk-back stops at the dash rather than
    // treating it as indentation to be re-emitted.
    const src = `jobs:\n  build:\n    docker:\n      - image: cimg/go:1.26\n        auth: x\n        other: k\n`;
    const after = mutate(src, (doc) => {
      setIn(doc, ['jobs', 'build', 'docker', 0, 'auth'], 'y');
    });
    expect(after).toContain('      - image: cimg/go:1.26');
    expect(after).toContain('        auth: y');
    expect(after).toContain('        other: k');
  });

  it('editing inside a sequence item keeps the rest of that item verbatim', () => {
    // This was the documented gap #41 recorded: renderSeqChildren diffed items
    // by deep equality with no path into a *changed* one, so an edit anywhere
    // inside an item re-rendered the whole item and collapsed the alignment in
    // it. It now recurses, pairing a removed item with an added one of the same
    // container kind -- a heuristic, because sequence items have no keys to
    // match on, and a safe one: the pair is only used to reuse bytes for
    // subtrees that compare equal, so a wrong guess reuses fewer bytes rather
    // than producing a different document.
    const src = `jobs:
  build:
    docker:
      - image: cimg/go:1.26     # pinned
        auth: x
      - image: cimg/redis:7.0   # service
`;
    const after = mutate(src, (doc) => {
      setIn(doc, ['jobs', 'build', 'docker', 0, 'auth'], 'y');
    });
    expect(after).toContain('- image: cimg/go:1.26     # pinned');
    expect(after).toContain('- image: cimg/redis:7.0   # service');
    expect(changedLineNumbers(src, after)).toEqual([5]);
  });

  it('reordering a step is a pure move, in either direction', () => {
    // Found while fixing the above, and worse than the gap it was found next
    // to: moveSeqItem -- the reorder the inspector performs -- reflowed every
    // comment in the file. An item's own range starts *past* its `- ` marker,
    // so a moved item was spliced without its dash or indentation, landing at
    // column zero; that is a different document, so the safety net re-emitted
    // the whole file.
    //
    // Moves toward the back happened to work, which is why this went unnoticed:
    // diffArrays reports a move toward the front as the addition *before* the
    // removal, so the orphan pool was still empty when the new position asked
    // for it. Both directions are asserted for that reason.
    const src = `jobs:
  build:
    steps:
      - checkout                # first
      - run: go build ./...     # second
      - run: go test ./...      # third
`;
    for (const [from, to] of [
      [2, 0],
      [0, 2],
      [1, 2],
      [2, 1],
    ] as const) {
      const after = mutate(src, (doc) => {
        moveSeqItem(doc, ['jobs', 'build', 'steps'], from, to);
      });
      expect(after, `move ${from} -> ${to}`).toContain(
        '- checkout                # first',
      );
      expect(after, `move ${from} -> ${to}`).toContain(
        '- run: go build ./...     # second',
      );
      expect(after, `move ${from} -> ${to}`).toContain(
        '- run: go test ./...      # third',
      );
    }
  });

  it('does not recurse into an item whose own leading comment would be lost', () => {
    // The recursion splices an item's own bytes, and an item's leading comment
    // sits before the dash, outside its range -- so recursing there would drop
    // the comment. It falls back to a fresh render instead: the alignment
    // inside that one item is the lesser loss, and the comment above it
    // survives. Pins the case that caught this, a comment above a renamed
    // workflow entry.
    const src = `workflows:
  main:
    jobs:
      - build
      # test gates the deploy
      - test:
          requires:
            - build
`;
    const after = mutate(src, (doc) => {
      const jobs: any = doc.getIn(['workflows', 'main', 'jobs']);
      jobs.items[1].items[0].key.value = 'unit';
    });
    expect(after).toContain('# test gates the deploy');
    expect(after).toContain('- unit:');
  });
});
