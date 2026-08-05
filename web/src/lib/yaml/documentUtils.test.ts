import { isMap, isScalar } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  deleteIn,
  getIn,
  getJobNames,
  getNode,
  getWorkflowJobEntries,
  getWorkflowNames,
  isSetupConfig,
  listKeys,
  moveSeqItem,
  parseConfig,
  parseRequiresEntries,
  renameKey,
  setIn,
  setNodeIn,
  takeNode,
} from './documentUtils';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('parseConfig', () => {
  it('parses valid YAML', () => {
    const { doc, error } = parseConfig('version: 2.1\n');
    expect(error).toBeNull();
    expect(doc).not.toBeNull();
    expect(doc?.toString()).toBe('version: 2.1\n');
  });

  it('returns doc: null and a short single-line message for invalid YAML', () => {
    const { doc, error } = parseConfig('foo: [1, 2\n');
    expect(doc).toBeNull();
    expect(error).not.toBeNull();
    expect(error).not.toContain('\n');
    expect(error).toMatch(/line 2/);
  });

  it('treats an empty document as valid', () => {
    const { doc, error } = parseConfig('');
    expect(error).toBeNull();
    expect(doc).not.toBeNull();
  });
});

describe('getIn / getNode', () => {
  const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.0
    resource_class: medium
`);

  it('getIn unwraps scalars to plain values', () => {
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium');
  });

  it('getIn unwraps collections via toJSON', () => {
    expect(getIn(doc, ['jobs', 'build', 'docker'])).toEqual([
      { image: 'cimg/node:20.0' },
    ]);
  });

  it('getIn returns undefined for a missing path', () => {
    expect(getIn(doc, ['jobs', 'missing'])).toBeUndefined();
    expect(getIn(doc, ['jobs', 'build', 'missing', 'deeper'])).toBeUndefined();
  });

  it('getNode returns the live YAML node, not a copy', () => {
    const node = getNode(doc, ['jobs', 'build', 'resource_class']);
    expect(isScalar(node)).toBe(true);
    if (isScalar(node)) {
      node.value = 'large';
    }
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('large');
  });
});

describe('setIn', () => {
  it('mutates an existing scalar in place, leaving siblings and comments untouched', () => {
    const doc = parse(`jobs:
  build:
    resource_class: medium # keep this note
    docker:
      - image: cimg/node:20.0
`);
    setIn(doc, ['jobs', 'build', 'resource_class'], 'large');
    expect(doc.toString()).toBe(`jobs:
  build:
    resource_class: large # keep this note
    docker:
      - image: cimg/node:20.0
`);
  });

  it('creates intermediate maps as needed', () => {
    const doc = parse('jobs:\n  build:\n    resource_class: medium\n');
    setIn(doc, ['jobs', 'test', 'resource_class'], 'small');
    expect(getIn(doc, ['jobs', 'test', 'resource_class'])).toBe('small');
    // existing sibling untouched
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium');
  });

  it('creates the root map when the document is empty', () => {
    const doc = parse('');
    setIn(doc, ['jobs', 'build', 'resource_class'], 'medium');
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium');
  });

  it('sets a value inside a sequence by index', () => {
    const doc = parse('steps:\n  - checkout\n  - run: echo hi\n');
    setIn(doc, ['steps', 1], 'run: echo bye');
    expect(getIn(doc, ['steps', 1])).toBe('run: echo bye');
  });
});

describe('deleteIn', () => {
  it('deletes a map key and its own (non-header) comment', () => {
    const doc = parse(`jobs:
  build:
    x: 1
  # just a note about deploy
  deploy:
    x: 2
`);
    expect(deleteIn(doc, ['jobs', 'deploy'])).toBe(true);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1
`);
  });

  it('re-attaches a section-header comment to the next sibling', () => {
    const doc = parse(`jobs:
  build:
    x: 1

  # Deploy jobs
  # These run only on main

  deploy:
    x: 2
  cleanup:
    x: 3
`);
    expect(deleteIn(doc, ['jobs', 'deploy'])).toBe(true);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1

  # Deploy jobs
  # These run only on main

  cleanup:
    x: 3
`);
  });

  it('drops a section header with no remaining sibling to attach to', () => {
    const doc = parse(`jobs:
  build:
    x: 1

  # Deploy jobs

  deploy:
    x: 2
`);
    expect(deleteIn(doc, ['jobs', 'deploy'])).toBe(true);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1
`);
  });

  it('re-attaches a sequence-item section header to the next item', () => {
    const doc = parse(`steps:
  - checkout

  # Deploy steps

  - run: deploy
  - run: cleanup
`);
    expect(deleteIn(doc, ['steps', 1])).toBe(true);
    expect(doc.toString()).toBe(`steps:
  - checkout

  # Deploy steps

  - run: cleanup
`);
  });

  it('returns false for a path that does not exist', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(deleteIn(doc, ['jobs', 'missing'])).toBe(false);
    expect(deleteIn(doc, [])).toBe(false);
  });
});

describe('renameKey', () => {
  it('renames a key in place, keeping its position and comment', () => {
    const doc = parse(`jobs:
  build:
    x: 1
  # notes about deploy
  deploy:
    x: 2
  cleanup:
    x: 3
`);
    expect(renameKey(doc, ['jobs'], 'deploy', 'deploy_prod')).toBe(true);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1
  # notes about deploy
  deploy_prod:
    x: 2
  cleanup:
    x: 3
`);
  });

  it('is a no-op returning true when old and new keys are the same', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(renameKey(doc, ['jobs'], 'build', 'build')).toBe(true);
  });

  it('refuses to clobber an existing different key', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n  deploy:\n    x: 2\n');
    expect(renameKey(doc, ['jobs'], 'build', 'deploy')).toBe(false);
    expect(getIn(doc, ['jobs', 'build', 'x'])).toBe(1);
    expect(getIn(doc, ['jobs', 'deploy', 'x'])).toBe(2);
  });

  it('returns false when the old key does not exist', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(renameKey(doc, ['jobs'], 'missing', 'new')).toBe(false);
  });
});

describe('moveSeqItem', () => {
  it('reorders items, carrying an item comment with it', () => {
    const doc = parse(`jobs:
  - build
  # run after build
  - test
  - deploy
`);
    expect(moveSeqItem(doc, ['jobs'], 1, 2)).toBe(true);
    expect(doc.toString()).toBe(`jobs:
  - build
  - deploy
  # run after build
  - test
`);
  });

  it('clamps out-of-range indices', () => {
    const doc = parse('jobs:\n  - a\n  - b\n  - c\n');
    expect(moveSeqItem(doc, ['jobs'], 0, 99)).toBe(true);
    expect(getIn(doc, ['jobs'])).toEqual(['b', 'c', 'a']);
  });

  it('returns false for a non-sequence path', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(moveSeqItem(doc, ['jobs'], 0, 1)).toBe(false);
  });
});

describe('listKeys / getJobNames / getWorkflowNames', () => {
  const doc = parse(`jobs:
  build:
    x: 1
  test:
    x: 2
workflows:
  version: 2
  main:
    jobs:
      - build
      - test
`);

  it('listKeys returns keys in document order', () => {
    expect(listKeys(doc, ['jobs'])).toEqual(['build', 'test']);
  });

  it('getJobNames reads top-level jobs', () => {
    expect(getJobNames(doc)).toEqual(['build', 'test']);
  });

  it('getWorkflowNames filters out non-map entries like a legacy version key', () => {
    expect(getWorkflowNames(doc)).toEqual(['main']);
  });
});

describe('isSetupConfig', () => {
  it('is true for a top-level setup: true', () => {
    const doc = parse('version: 2.1\nsetup: true\n');
    expect(isSetupConfig(doc)).toBe(true);
  });

  it('is false when setup is absent', () => {
    const doc = parse('version: 2.1\n');
    expect(isSetupConfig(doc)).toBe(false);
  });

  it('is false for setup: false, and false for a job merely named "setup" (issue #106 -- must not false-positive on a step/job name)', () => {
    expect(isSetupConfig(parse('version: 2.1\nsetup: false\n'))).toBe(false);
    expect(
      isSetupConfig(parse('version: 2.1\njobs:\n  setup:\n    docker: []\n')),
    ).toBe(false);
  });

  it('is false for a non-boolean setup value', () => {
    expect(isSetupConfig(parse('version: 2.1\nsetup: "true"\n'))).toBe(false);
  });
});

describe('getWorkflowJobEntries', () => {
  it('reads bare-string and options-map entries, including requires', () => {
    const doc = parse(`workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build
      - deploy:
          requires:
            - test
          filters:
            branches:
              only: main
`);
    const entries = getWorkflowJobEntries(doc, 'main');
    expect(entries).toEqual([
      { jobName: 'build', requires: [], index: 0, isString: true },
      { jobName: 'test', requires: ['build'], index: 1, isString: false },
      { jobName: 'deploy', requires: ['test'], index: 2, isString: false },
    ]);
  });

  it('resolves a status-map requires entry to its map key, not a stringified object (#26)', () => {
    const doc = parse(`workflows:
  main:
    jobs:
      - lint
      - test:
          requires:
            - lint:
                - success
                - failed
`);
    const entries = getWorkflowJobEntries(doc, 'main');
    expect(entries).toEqual([
      { jobName: 'lint', requires: [], index: 0, isString: true },
      { jobName: 'test', requires: ['lint'], index: 1, isString: false },
    ]);
  });

  it('returns an empty list for an unknown workflow', () => {
    const doc = parse('workflows:\n  main:\n    jobs:\n      - build\n');
    expect(getWorkflowJobEntries(doc, 'nope')).toEqual([]);
  });
});

describe('parseRequiresEntries (#26)', () => {
  it('returns [] for a non-sequence or absent node', () => {
    expect(parseRequiresEntries(undefined)).toEqual([]);
  });

  it('parses a plain string entry with statuses left undefined', () => {
    const doc = parse('a:\n  - build\n');
    const node = getNode(doc, ['a']);
    expect(parseRequiresEntries(node)).toEqual([{ id: 'build' }]);
  });

  it('parses a status-map entry, capturing id and statuses separately', () => {
    const doc = parse('a:\n  - lint:\n      - success\n      - failed\n');
    const node = getNode(doc, ['a']);
    expect(parseRequiresEntries(node)).toEqual([
      { id: 'lint', statuses: ['success', 'failed'] },
    ]);
  });

  it('parses a mix of plain and status-map entries, in order', () => {
    const doc = parse('a:\n  - build\n  - lint:\n      - success\n  - test\n');
    const node = getNode(doc, ['a']);
    expect(parseRequiresEntries(node)).toEqual([
      { id: 'build' },
      { id: 'lint', statuses: ['success'] },
      { id: 'test' },
    ]);
  });

  it('flags a status-map entry whose value is not a list as malformedStatuses, but keeps the id', () => {
    const doc = parse('a:\n  - lint: not-a-list\n');
    const node = getNode(doc, ['a']);
    expect(parseRequiresEntries(node)).toEqual([
      { id: 'lint', malformedStatuses: true },
    ]);
  });
});

describe('takeNode / setNodeIn (issue #79 extraction primitives)', () => {
  it('moves a scalar node, including its own comment, to a fresh location', () => {
    const doc = parse(
      'jobs:\n  build:\n    resource_class: medium # tune if slow\n',
    );
    const node = takeNode(doc, ['jobs', 'build', 'resource_class']);
    expect(node).toBeDefined();
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBeUndefined();

    setNodeIn(doc, ['executors', 'shared', 'resource_class'], node!);
    expect(getIn(doc, ['executors', 'shared', 'resource_class'])).toBe(
      'medium',
    );
    const after = doc.toString();
    expect(after).toContain('resource_class: medium # tune if slow');
    expect(after).not.toMatch(/build:\s*\n\s*resource_class/);
  });

  it('moves a sequence node, preserving a comment on one of its items', () => {
    const doc = parse(
      'jobs:\n  build:\n    docker:\n      # pinned -- see RFC 12\n      - image: cimg/node:20.10\n',
    );
    const node = takeNode(doc, ['jobs', 'build', 'docker']);
    expect(node).toBeDefined();
    expect(getIn(doc, ['jobs', 'build', 'docker'])).toBeUndefined();

    setNodeIn(doc, ['executors', 'node-executor', 'docker'], node!);
    const after = doc.toString();
    expect(after).toContain('# pinned -- see RFC 12');
    expect(after).toContain('executors:\n  node-executor:\n    docker:');
  });

  it('takeNode returns undefined for a path that does not resolve', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(takeNode(doc, ['jobs', 'nope', 'docker'])).toBeUndefined();
    expect(takeNode(doc, ['jobs', 'build', 'nope', 'deeper'])).toBeUndefined();
  });

  it('setNodeIn creates intermediate maps as needed, mirroring setIn', () => {
    const doc = parse('a: 1\n');
    const node = getNode(doc, ['a']);
    expect(node).toBeDefined();
    setNodeIn(doc, ['deeply', 'nested', 'b'], node!);
    expect(getIn(doc, ['deeply', 'nested', 'b'])).toBe(1);
  });

  it('a plain (non-section-header) comment on the removed key is dropped, matching deleteIn', () => {
    // `docker` is deliberately not `build`'s first key here: a comment
    // preceding a block's very first entry attaches to the block itself
    // (verified empirically against this `yaml` version), not to that
    // entry's key -- it would survive regardless of what this test does,
    // which would make it a false pass. Putting `docker` second is what
    // actually attaches the comment to the key this test removes.
    const doc = parse(
      'jobs:\n  build:\n    steps:\n      - checkout\n    # builds the docker image\n    docker:\n      - image: cimg/base:current\n',
    );
    const node = takeNode(doc, ['jobs', 'build', 'docker']);
    setNodeIn(doc, ['executors', 'shared', 'docker'], node!);
    expect(doc.toString()).not.toContain('# builds the docker image');
  });
});

describe('sanity: node identity helpers stay importable', () => {
  it('isMap/isScalar still behave as expected against a parsed doc', () => {
    const doc = parse('jobs:\n  build:\n    x: 1\n');
    expect(isMap(doc.contents)).toBe(true);
    expect(isScalar(getNode(doc, ['jobs', 'build', 'x']))).toBe(true);
  });
});
