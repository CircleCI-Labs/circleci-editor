import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import { referencedContexts } from './referencedContexts';

function doc(source: string) {
  return parseDocument(source);
}

describe('referencedContexts', () => {
  it('returns nothing for a config that references no contexts', () => {
    expect(
      referencedContexts(
        doc(`version: 2.1
workflows:
  build:
    jobs:
      - test
`),
      ),
    ).toEqual([]);
  });

  it('reads a list', () => {
    expect(
      referencedContexts(
        doc(`version: 2.1
workflows:
  build:
    jobs:
      - deploy:
          context: [aws-prod, docker-hub]
`),
      ),
    ).toEqual(['aws-prod', 'docker-hub']);
  });

  // CircleCI accepts a bare string as shorthand for a one-item list, and
  // buildWorkflowGraph already normalises it -- which is exactly why this reads
  // the graph rather than parsing `context:` a second time.
  it('reads the bare-string shorthand', () => {
    expect(
      referencedContexts(
        doc(`version: 2.1
workflows:
  build:
    jobs:
      - deploy:
          context: org-global
`),
      ),
    ).toEqual(['org-global']);
  });

  it('deduplicates across jobs and workflows, in document order', () => {
    expect(
      referencedContexts(
        doc(`version: 2.1
workflows:
  build:
    jobs:
      - a:
          context: [shared, build-only]
      - b:
          context: shared
  release:
    jobs:
      - c:
          context: [shared, release-only]
`),
      ),
    ).toEqual(['shared', 'build-only', 'release-only']);
  });

  // A parameterised context name resolves at run time to something this editor
  // cannot know. Reporting it as a missing context would be a confident wrong
  // answer, so it is skipped instead.
  it('skips a context name that is a parameter reference', () => {
    expect(
      referencedContexts(
        doc(`version: 2.1
parameters:
  ctx:
    type: string
    default: aws-dev
workflows:
  build:
    jobs:
      - deploy:
          context: << pipeline.parameters.ctx >>
`),
      ),
    ).toEqual([]);
  });

  it('returns nothing for no document', () => {
    expect(referencedContexts(null)).toEqual([]);
  });
});
