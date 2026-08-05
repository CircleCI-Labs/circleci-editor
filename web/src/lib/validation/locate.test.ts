import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  ORB_NOT_FOUND,
  SCHEMA_EXTRANEOUS_KEY,
  SCHEMA_EXTRANEOUS_KEY_NESTED,
  UNKNOWN_COMMAND,
  UNKNOWN_EXECUTOR,
  UNKNOWN_REQUIRES,
  UNKNOWN_WORKFLOW_JOB,
} from './apiFixtures';
import { groupCompileErrors } from './diagnostics';
import { locateTarget, offsetToPosition } from './locate';

/** Resolves the fixture's target against `text`, the way `buildDiagnostics` does. */
function locate(messages: string[], text: string) {
  const { doc } = parseConfig(text);
  const target = groupCompileErrors(messages)[0]?.target;
  return locateTarget(doc, text, target);
}

/** The 1-based line of `needle`'s first occurrence, so expectations read as "the line I can see", not as a magic number. */
function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture does not contain ${needle}`);
  return text.slice(0, index).split('\n').length;
}

describe('offsetToPosition', () => {
  it('is 1-based on both axes', () => {
    expect(offsetToPosition('abc', 0)).toEqual({ line: 1, column: 1 });
  });

  it('counts the line after a newline', () => {
    expect(offsetToPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
  });

  it('clamps an out-of-range offset rather than producing nonsense', () => {
    expect(offsetToPosition('ab', 99)).toEqual({ line: 1, column: 3 });
  });
});

describe('locateTarget: orb references', () => {
  const config = `version: 2.1
orbs:
  slack: circleci/slack@99.99.99
jobs:
  build:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
`;

  it('points at the orbs: entry holding the exact reference the compiler echoed', () => {
    const location = locate(ORB_NOT_FOUND, config);
    expect(location?.line).toBe(lineOf(config, 'circleci/slack@99.99.99'));
    expect(location?.basis).toBe('resolved');
  });

  it('declines when the reference is not written literally in orbs:', () => {
    // A parameterised orb reference: the compiler still reports the resolved
    // string, but there is no line holding it, so there is no honest line to
    // point at.
    const parameterised = config.replace(
      'circleci/slack@99.99.99',
      'circleci/slack@<< pipeline.parameters.slack_version >>',
    );
    expect(locate(ORB_NOT_FOUND, parameterised)).toBeUndefined();
  });
});

describe('locateTarget: requires', () => {
  const config = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    steps: [checkout]
workflows:
  main:
    jobs:
      - build:
          requires:
            - nonexistent
`;

  it('points at the offending requires: item, not at the entry or the workflow', () => {
    const location = locate(UNKNOWN_REQUIRES, config);
    expect(location?.line).toBe(lineOf(config, '- nonexistent'));
  });

  it('finds the item through the status-map form as well as the bare-string form', () => {
    const statusMap = config.replace(
      '            - nonexistent',
      '            - nonexistent: [success]',
    );
    expect(locate(UNKNOWN_REQUIRES, statusMap)?.line).toBe(
      lineOf(statusMap, '- nonexistent:'),
    );
  });

  it("matches on the entry's alias, not on its job name", () => {
    // `requires:` references aliases. An entry aliased to `build` while
    // invoking `compile` must still be found by an error naming `build`.
    const aliased = `version: 2.1
jobs:
  compile:
    docker: [{ image: cimg/base:stable }]
    steps: [checkout]
workflows:
  main:
    jobs:
      - compile:
          name: build
          requires:
            - nonexistent
`;
    expect(locate(UNKNOWN_REQUIRES, aliased)?.line).toBe(
      lineOf(aliased, '- nonexistent'),
    );
  });

  it('declines when the id appears twice, because there is no single site to point at', () => {
    const ambiguous = `version: 2.1
workflows:
  main:
    jobs:
      - build:
          requires:
            - nonexistent
            - nonexistent
`;
    expect(locate(UNKNOWN_REQUIRES, ambiguous)).toBeUndefined();
  });
});

describe('locateTarget: executors and commands', () => {
  it('points at the executor name in the job that named it', () => {
    const config = `version: 2.1
jobs:
  build:
    executor: nope
    steps: [checkout]
`;
    expect(locate(UNKNOWN_EXECUTOR, config)?.line).toBe(
      lineOf(config, 'executor: nope'),
    );
  });

  it('finds an executor written in the parameterised name: form', () => {
    const config = `version: 2.1
jobs:
  build:
    executor:
      name: nope
      tag: "20"
    steps: [checkout]
`;
    expect(locate(UNKNOWN_EXECUTOR, config)?.line).toBe(
      lineOf(config, 'name: nope'),
    );
  });

  it('points at the misspelled step within the job the context named', () => {
    const config = `version: 2.1
jobs:
  other:
    steps:
      - chekcout
  build:
    docker: [{ image: cimg/base:stable }]
    steps:
      - chekcout
`;
    // Deliberately present in two jobs: the error named `build`, so the hit
    // must be the one in `build`, not the first in the file.
    expect(locate(UNKNOWN_COMMAND, config)?.line).toBe(9);
  });

  it('declines when the job the error named does not exist in the document', () => {
    const config = 'version: 2.1\njobs:\n  test:\n    steps: [checkout]\n';
    expect(locate(UNKNOWN_COMMAND, config)).toBeUndefined();
  });
});

describe('locateTarget: workflow job entries', () => {
  it('points at the entry naming the undefined job', () => {
    const config = `version: 2.1
workflows:
  main:
    jobs:
      - build
      - notdefined
`;
    expect(locate(UNKNOWN_WORKFLOW_JOB, config)?.line).toBe(
      lineOf(config, '- notdefined'),
    );
  });

  it('declines when the same undefined job is invoked twice', () => {
    const config = `version: 2.1
workflows:
  main:
    jobs:
      - notdefined:
          name: first
      - notdefined:
          name: second
`;
    expect(locate(UNKNOWN_WORKFLOW_JOB, config)).toBeUndefined();
  });
});

describe('locateTarget: schema paths', () => {
  it('points at the offending key itself, not at its parent map', () => {
    const config = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    stpes:
      - checkout
`;
    expect(locate(SCHEMA_EXTRANEOUS_KEY, config)?.line).toBe(
      lineOf(config, 'stpes:'),
    );
  });

  it('follows a sequence index in the pointer', () => {
    const config = `version: 2.1
jobs:
  build:
    docker:
      - imag: cimg/base:stable
    steps:
      - checkout
`;
    expect(locate(SCHEMA_EXTRANEOUS_KEY_NESTED, config)?.line).toBe(
      lineOf(config, 'imag:'),
    );
  });

  it('declines when the key is no longer at that path', () => {
    // Same error, a document the user has since fixed: nothing to point at.
    const config = 'version: 2.1\njobs:\n  build:\n    steps: [checkout]\n';
    expect(locate(SCHEMA_EXTRANEOUS_KEY, config)).toBeUndefined();
  });
});
