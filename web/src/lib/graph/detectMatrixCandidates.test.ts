import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { findMatrixCandidates } from './detectMatrixCandidates';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('findMatrixCandidates', () => {
  it('finds a job invoked twice in one workflow with a differing parameter', () => {
    const doc = parse(`jobs:
  deploy-service:
    parameters:
      region:
        type: string
    docker:
      - image: cimg/base:current
    steps:
      - run: echo << parameters.region >>
workflows:
  deploy:
    jobs:
      - deploy-service:
          name: deploy-service-na
          region: NA
      - deploy-service:
          name: deploy-service-eu
          region: EU
`);
    const groups = findMatrixCandidates(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      workflowName: 'deploy',
      jobName: 'deploy-service',
      entryIds: ['deploy-service-na', 'deploy-service-eu'],
      paramNames: ['region'],
      combos: [{ region: 'NA' }, { region: 'EU' }],
    });
  });

  it('does not flag two invocations whose arguments are identical -- nothing varies', () => {
    const doc = parse(`jobs:
  build:
    parameters:
      region:
        type: string
workflows:
  deploy:
    jobs:
      - build:
          name: a
          region: NA
      - build:
          name: b
          region: NA
`);
    expect(findMatrixCandidates(doc)).toEqual([]);
  });

  it('does not flag invocations whose parameter shapes differ', () => {
    const doc = parse(`jobs:
  build:
    parameters:
      region:
        type: string
      version:
        type: string
workflows:
  deploy:
    jobs:
      - build:
          name: a
          region: NA
      - build:
          name: b
          version: "1.0"
`);
    expect(findMatrixCandidates(doc)).toEqual([]);
  });

  it('ignores a single bare-string invocation and a single invocation with args -- no group of two', () => {
    const doc = parse(`jobs:
  build: {}
workflows:
  deploy:
    jobs:
      - build
      - build:
          region: NA
`);
    expect(findMatrixCandidates(doc)).toEqual([]);
  });

  it('excludes an invocation that already has its own matrix:', () => {
    const doc = parse(`jobs:
  build: {}
workflows:
  deploy:
    jobs:
      - build:
          region: NA
      - build:
          matrix:
            parameters:
              region: [EU]
`);
    expect(findMatrixCandidates(doc)).toEqual([]);
  });

  it('returns [] for a config with no workflows, or no repeated invocations', () => {
    expect(findMatrixCandidates(parse('jobs:\n  build: {}\n'))).toEqual([]);
    expect(
      findMatrixCandidates(
        parse(
          'jobs:\n  build: {}\nworkflows:\n  deploy:\n    jobs:\n      - build\n',
        ),
      ),
    ).toEqual([]);
  });
});
