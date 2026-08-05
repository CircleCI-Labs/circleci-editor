import { isAlias, isMap, type Alias, type YAMLMap } from 'yaml';
import { describe, expect, it } from 'vitest';

import { countChangedLines, unifiedDiff } from './diff';
import { serializeMinimalDiff } from './spliceSerialize';
import {
  addJobFromExecutor,
  addStep,
  addWorkflowTrigger,
  moveStep,
  moveWorkflowEntryStep,
  removeWorkflowTrigger,
  setExecutorField,
  setJobField,
  setWorkflowField,
  unsetJobField,
  unsetWorkflowField,
} from '~/lib/mutations/configMutations';
import {
  cloneDocument,
  deleteIn,
  getNode,
  moveSeqItem,
  parseConfig,
  renameKey,
  setIn,
} from './documentUtils';

import fullConfig from '../../fixtures/full-config.yml?raw';
import simpleOrb from '../../fixtures/simple-orb.yml?raw';
import alignedComments from '~/fixtures/aligned-comments.yml?raw';
import orchestrationConstructs from '~/fixtures/orchestration-constructs.yml?raw';
import parametersConfig from '~/fixtures/parameters.yml?raw';

const FIXTURES: [name: string, text: string][] = [
  ['full-config.yml', fullConfig],
  ['simple-orb.yml', simpleOrb],
  // Issue #220: job groups, serial groups, no-op and release job types. Every
  // construct carries an explanatory comment, so this fixture exercises the
  // comment-preservation half of the suite as hard as it exercises the
  // structural half.
  ['orchestration-constructs.yml', orchestrationConstructs],
  // Issue #250: `parameters:` at both scopes, `<< >>` interpolations in image
  // tags, step fields and a workflow `when:`, an `enum:` list, and a quoted
  // scalar default. The interpolations are the interesting part here -- they are
  // ordinary strings that happen to contain `<<`, and `merge: true` is on, so
  // this fixture is the standing check that nothing mistakes one for a merge key.
  ['parameters.yml', parametersConfig],
];

/** All `#`-comment substrings appearing anywhere in `text`, in order. */
function extractComments(text: string): string[] {
  const comments: string[] = [];
  for (const line of text.split('\n')) {
    const match = /#.*$/.exec(line);
    if (match) comments.push(match[0]);
  }
  return comments;
}

describe.each(FIXTURES)('golden round-trip fidelity > %s', (_name, text) => {
  it('parses without error and round-trips byte-for-byte with no edits', () => {
    const { doc, error } = parseConfig(text);
    expect(error).toBeNull();
    expect(doc).not.toBeNull();
    expect(doc?.toString()).toBe(text);
  });

  it('preserves every comment present in the input', () => {
    const { doc } = parseConfig(text);
    const before = extractComments(text);
    const after = extractComments(doc?.toString() ?? '');
    expect(before.length).toBeGreaterThan(0);
    for (const comment of before) {
      expect(after).toContain(comment);
    }
    expect(after).toEqual(before);
  });
});

describe('minimal diff after a single surgical mutation', () => {
  it('setIn on a scalar (resource_class) changes exactly one line', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    setIn(clone, ['executors', 'node-medium', 'resource_class'], 'large');
    const after = clone.toString();

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);

    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    assertOnlyLinesDiffer(before, after, [12]);
  });

  it('deleteIn of one job removes only that job (and reattaches its section header)', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    expect(deleteIn(clone, ['jobs', 'deploy_staging'])).toBe(true);
    const after = clone.toString();

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);

    // Measured: deleting deploy_staging (5 content lines + its trailing
    // blank line) removes exactly those 6 lines and adds nothing -- the
    // reattached section header lands as unchanged context, not a new
    // addition, because it already sat exactly where it needs to be.
    expect(additions).toBe(0);
    expect(deletions).toBe(6);

    // The section header that used to precede deploy_staging must survive,
    // now attached to deploy_prod.
    expect(after).toContain('# Deploy jobs');
    expect(after).toContain('# These only run against main, never on forks.');
    // The job definition itself is gone (its `workflows` reference is a
    // separate concern -- deleteIn only touches the path it's given).
    expect(after).not.toMatch(/^ {2}deploy_staging:$/m);

    // Unrelated jobs (build, test) are untouched.
    expect(after).toContain('echo "Building widgets"');
    expect(after).toContain('pnpm test -- --ci');
  });

  it('renameKey of a job changes only that key line', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    expect(renameKey(clone, ['jobs'], 'test', 'unit_test')).toBe(true);
    const after = clone.toString();

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);

    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    assertOnlyLinesDiffer(before, after, [41]);
  });

  it('moveSeqItem in a workflow reorders without touching unrelated content', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    // Swap the `test` and `deploy_staging` workflow-job entries.
    expect(
      moveSeqItem(clone, ['workflows', 'build_test_deploy', 'jobs'], 1, 2),
    ).toBe(true);
    const after = clone.toString();

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);

    // Measured: jsdiff's line matcher recognizes the untouched
    // `deploy_staging` block as shared context and only has to shift the
    // smaller `test` entry (3 lines) across it -- 3 deletions + 3
    // additions, not the naive 9 + 9 a whole-block replace would cost.
    expect(additions).toBe(3);
    expect(deletions).toBe(3);

    expect(after).toContain('- build');
    expect(after).toContain('- deploy_prod:');
    // Both entries are still present, just reordered.
    expect(after).toContain('- test:');
    expect(after).toContain('- deploy_staging:');
  });
});

describe('comment semantics', () => {
  it('editing a value keeps its inline comment', () => {
    const text = `jobs:
  build:
    resource_class: medium # tune this if CI is slow
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    setIn(doc, ['jobs', 'build', 'resource_class'], 'large');
    expect(doc.toString()).toBe(`jobs:
  build:
    resource_class: large # tune this if CI is slow
`);
  });

  it('moving a node carries its own comment along', () => {
    const text = `steps:
  - checkout
  # only on release branches
  - run: deploy
  - run: cleanup
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    // Move the commented item (index 1, "run: deploy") to the front; its
    // comment must travel with it rather than staying behind on `checkout`.
    moveSeqItem(doc, ['steps'], 1, 0);
    expect(doc.toString()).toBe(`steps:
  # only on release branches
  - run: deploy
  - checkout
  - run: cleanup
`);
  });

  it('deleting a node removes its own bound comment', () => {
    const text = `jobs:
  build:
    x: 1
  # a one-off note, not a section header
  deploy:
    x: 2
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    deleteIn(doc, ['jobs', 'deploy']);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1
`);
  });

  it('a section header survives deleting the item it precedes', () => {
    const text = `jobs:
  build:
    x: 1

  # Release jobs
  # Only run on tags.

  deploy:
    x: 2
  cleanup:
    x: 3
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    deleteIn(doc, ['jobs', 'deploy']);
    expect(doc.toString()).toBe(`jobs:
  build:
    x: 1

  # Release jobs
  # Only run on tags.

  cleanup:
    x: 3
`);
  });
});

/**
 * Round-trip coverage for issue #288's workflow-level fields
 * (`setWorkflowField`/`unsetWorkflowField`/`addWorkflowTrigger`/
 * `removeWorkflowTrigger`), which reuse exactly the same `setIn`/`deleteIn`
 * surgical-write machinery `setJobField` already has coverage for above --
 * this is the workflow-scoped half of that same guarantee, using
 * `parameters.yml`'s own `workflows.integration.when:` (a real
 * `<< pipeline.parameters.* >>` string, the shape issue #288 calls out by
 * name) rather than a fixture built just for this test.
 */
describe('workflow-level field mutations preserve everything around them (issue #288)', () => {
  it('editing an existing when: string changes exactly its own line', () => {
    const before = parametersConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    setWorkflowField(
      clone,
      'integration',
      ['when'],
      '<< pipeline.parameters.deploy-env >>',
    );
    const after = clone.toString();

    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    assertOnlyLinesDiffer(before, after, [69]);
    expect(extractComments(after)).toEqual(extractComments(before));
  });

  it('setting when: and then unsetting it round-trips byte-for-byte', () => {
    const before = parametersConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    setWorkflowField(clone, 'main', ['when'], 'true');
    expect(clone.toString()).not.toBe(before);
    unsetWorkflowField(clone, 'main', ['when']);
    expect(clone.toString()).toBe(before);
  });

  it('rewriting when: as a structured logic expression does not merely stringify the old value', () => {
    const { doc } = parseConfig(parametersConfig);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    setWorkflowField(clone, 'integration', ['when'], {
      and: [
        '<< pipeline.parameters.run-integration-tests >>',
        { not: { equal: ['skip', '<< pipeline.git.branch >>'] } },
      ],
    });
    const after = clone.toString();

    expect(after).toContain('when:');
    expect(after).toContain('and:');
    expect(after).toContain('not:');
    expect(after).toContain('equal:');
    // The string form is gone -- this is a genuine shape change, not a
    // string wearing new punctuation.
    expect(after).not.toContain(
      'when: << pipeline.parameters.run-integration-tests >>',
    );
    // Everything else in the file is untouched.
    expect(after).toContain('- build:\n          target: release');
  });

  it('adding a schedule trigger is additive -- no existing line moves or is rewritten', () => {
    const before = parametersConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    addWorkflowTrigger(clone, 'main');
    const after = clone.toString();

    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(deletions).toBe(0);
    expect(additions).toBeGreaterThan(0);
    expect(extractComments(after)).toEqual(extractComments(before));
    expect(after).toContain('triggers:');
    expect(after).toContain('cron: 0 0 * * *');
  });

  it('adding then removing a trigger leaves every other line untouched (mirrors removeStep: an emptied list is left as `[]`, not collapsed away)', () => {
    const before = parametersConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    addWorkflowTrigger(clone, 'main');
    expect(clone.toString()).not.toBe(before);
    removeWorkflowTrigger(clone, 'main', 0);
    const after = clone.toString();

    // Same "removing the last item leaves `key: []`" behavior `removeStep`
    // already has -- neither collapses the now-empty list back to absent,
    // so this is consistency with an existing convention, not a gap.
    expect(after).toBe(
      before.replace(
        '            branches:\n              only: main\n',
        '            branches:\n              only: main\n    triggers: []\n',
      ),
    );
    expect(extractComments(after)).toEqual(extractComments(before));
  });
});

describe('anchors, aliases, and block scalars survive an unrelated edit', () => {
  it('keeps the anchor/alias pair and the block scalar intact after editing a sibling job', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    setIn(clone, ['jobs', 'test', 'executor'], 'node-medium'); // no-op value, but exercises the path
    setIn(
      clone,
      ['executors', 'node-medium', 'working_directory'],
      '~/project2',
    );
    const after = clone.toString();

    expect(after).toContain('deploy_prod: &deploy_prod');
    expect(after).toContain('deploy_prod_canary: *deploy_prod');
    expect(after).toContain(
      'echo "Building widgets"\n            pnpm run build\n            echo "Done"',
    );

    const anchorNode = getNode(clone, ['jobs', 'deploy_prod']);
    expect(isMap(anchorNode)).toBe(true);
    expect((anchorNode as YAMLMap).anchor).toBe('deploy_prod');

    // deploy_prod_canary still resolves as an alias to that same anchor.
    const canaryNode = getNode(clone, ['jobs', 'deploy_prod_canary']);
    expect(isAlias(canaryNode)).toBe(true);
    expect((canaryNode as Alias).source).toBe('deploy_prod');
    expect((canaryNode as Alias).resolve(clone)).toBe(anchorNode);
  });
});

/**
 * Demonstrates a real gap left by issue #35 that belongs to
 * `configMutations.ts`'s `deleteJob` (not owned by this module, so this
 * only documents the current behavior via the lower-level `deleteIn` this
 * module *does* own -- see the final report for what `deleteJob` needs).
 *
 * `deploy_prod: &deploy_prod` / `deploy_prod_canary: *deploy_prod` in
 * full-config.yml is exactly the shape a real config uses to avoid
 * repeating a job: one job holds the anchor, another is nothing but an
 * alias to it. `deleteIn` has no idea anything else in the document points
 * at the node it's about to remove -- it only ever looks at the one path
 * it's given -- so deleting the anchor's own job leaves the alias pointing
 * at nothing.
 */
describe('deleting an anchor-source job leaves any alias to it dangling (issue #35 delete path)', () => {
  it('deleteIn reports success, but the document can no longer be serialized', () => {
    const { doc } = parseConfig(fullConfig);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    expect(getNode(clone, ['jobs', 'deploy_prod_canary'])).toBeDefined();
    expect(deleteIn(clone, ['jobs', 'deploy_prod'])).toBe(true);

    // deploy_prod_canary's `*deploy_prod` alias is now unresolvable -- the
    // anchor it named no longer exists anywhere in the document.
    expect(() => clone.toString()).toThrow(/Unresolved alias/);
  });
});

/**
 * Asserts that `after` differs from `before` only on the given 1-based line
 * numbers -- i.e. the mutation touched exactly those lines and nothing else,
 * which is the whole point of surgical, node-level edits.
 */
function assertOnlyLinesDiffer(
  before: string,
  after: string,
  changedLines: number[],
): void {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  const changed = new Set(changedLines);
  for (let i = 0; i < beforeLines.length; i++) {
    const lineNo = i + 1;
    if (changed.has(lineNo)) continue;
    expect(afterLines[i]).toBe(beforeLines[i]);
  }
}

describe('known comment normalisations (issue #39)', () => {
  /**
   * Pins two pre-existing `yaml` behaviours so they are recorded decisions
   * rather than blind spots. Both are independent of any option we pass --
   * verified directly against yaml@2.9.0 with no options at all -- and both
   * are visible to the user, because the save dialog shows a diff.
   *
   * 1. Padding before an inline comment collapses to a single space.
   *    Cosmetic, and only affects files that column-align comments.
   *
   * 2. A comment trailing a key that introduces a nested block is MOVED onto
   *    its own line inside that block. This is the more serious of the two:
   *    it changes structure rather than whitespace, and it happens even with
   *    ordinary single-space spacing, so `jobs: # the jobs` is rewritten on
   *    the first save of any config that does it.
   *
   * Every other fixture here uses comments on their own line or trailing a
   * scalar, which is why the round-trip suite could not catch either.
   */
  it('collapses padding before a comment that trails a scalar or list item', () => {
    expect(parseConfig('a: 1   # c\n').doc!.toString()).toBe('a: 1 # c\n');
    expect(parseConfig('- checkout   # c\n').doc!.toString()).toBe(
      '- checkout # c\n',
    );
  });

  it('moves a comment trailing a nested-block key onto its own line', () => {
    // Note the input already uses a single space: this is not about padding.
    expect(parseConfig('build: # c\n  a: 1\n').doc!.toString()).toBe(
      'build:\n  # c\n  a: 1\n',
    );
    expect(parseConfig('steps: # c\n  - checkout\n').doc!.toString()).toBe(
      'steps:\n  # c\n  - checkout\n',
    );
  });

  it('keeps every comment, and never loses one', () => {
    const { doc, error } = parseConfig(alignedComments);
    expect(error).toBeNull();
    const commentsOf = (text: string) =>
      text
        .split('\n')
        .filter((line) => line.includes('#'))
        .map((line) => line.slice(line.indexOf('#')).trim())
        .sort();
    // Placement may shift per the two cases above; content must not be lost.
    expect(commentsOf(doc!.toString())).toEqual(commentsOf(alignedComments));
  });
});

/**
 * Issue #71's own comment/format-preservation bar for the palette's
 * "drop an executor, get a job" mutation (`addJobFromExecutor`): unlike
 * every other mutation in this suite, it *adds* lines rather than editing
 * existing ones in place, so `assertOnlyLinesDiffer`'s equal-line-count
 * assumption doesn't apply -- this instead asserts the diff is
 * addition-only (no line is removed or rewritten) and that every comment
 * in the fixture survives untouched.
 */
describe('addJobFromExecutor preserves comments and format (issue #71)', () => {
  it('appending a docker job only adds lines -- nothing existing is deleted or rewritten', () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    addJobFromExecutor(clone, {
      name: 'lint',
      workflowName: 'build_test_deploy',
      executor: { kind: 'docker', image: 'cimg/node:20.0' },
    });
    const after = clone.toString();

    const lines = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(lines);
    expect(deletions).toBe(0);
    expect(additions).toBeGreaterThan(0);

    expect(extractComments(after)).toEqual(extractComments(before));
    // Every original line still appears, in order, as a subsequence of the
    // new text -- the strongest form of "only additions" this suite has:
    // not just equal-or-more comments, but every pre-existing *line*
    // untouched.
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let cursor = 0;
    for (const line of beforeLines) {
      const found = afterLines.indexOf(line, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });

  it("referencing this config's own named executor (`executors: node-medium`) writes only `executor: node-medium` on the new job -- no duplicated image/resource_class", () => {
    const before = fullConfig;
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');

    const clone = cloneDocument(doc);
    addJobFromExecutor(clone, {
      name: 'lint',
      workflowName: 'build_test_deploy',
      executor: { kind: 'local', executorName: 'node-medium' },
    });
    const after = clone.toString();

    expect(after).toContain('executor: node-medium');
    expect(extractComments(after)).toEqual(extractComments(before));
    // The executors: block itself -- the thing being referenced, not
    // copied -- is completely untouched.
    const executorsIndex = before.indexOf('executors:');
    const commandsIndex = before.indexOf('commands:');
    expect(after.slice(executorsIndex, commandsIndex)).toBe(
      before.slice(executorsIndex, commandsIndex),
    );
  });
});

/**
 * Issue #181's own comment-preservation bar for the mutation the resource-class
 * field performs.
 *
 * The field's list now comes from CircleCI's vendored resource tables instead of
 * a hardcoded array, and its *write* is unchanged and must stay that way: a
 * surgical `eemeli/yaml` Document edit, never a re-serialisation of the whole
 * config. Asserted here rather than trusted, because "we changed where the
 * options come from" is exactly the kind of change that invites someone to
 * rebuild the value on the way out.
 *
 * Every path the field can take is covered: setting a class on a job, on a named
 * executor, reverting a job-level override, and writing a free-text class the
 * documentation snapshot has never heard of.
 */
describe('writing resource_class is surgical and comment-safe (issue #181)', () => {
  const before = fullConfig;

  /** `Document` here must be the parsed-document type the mutations accept, not the DOM's. */
  type ConfigDocument = Parameters<typeof setJobField>[0];

  function mutated(mutate: (doc: ConfigDocument) => void): string {
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);
    mutate(clone);
    return clone.toString();
  }

  it('setting a job-level resource_class adds one line and keeps every comment', () => {
    const after = mutated((doc) =>
      setJobField(doc, 'build', ['resource_class'], 'arm.large'),
    );

    expect(after).toContain('resource_class: arm.large');
    expect(extractComments(after)).toEqual(extractComments(before));
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(0);
  });

  it('changing a named executor’s resource_class rewrites exactly its own line', () => {
    const after = mutated((doc) =>
      setExecutorField(doc, 'node-medium', ['resource_class'], 'arm.2xlarge'),
    );

    expect(extractComments(after)).toEqual(extractComments(before));
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    // Line 12 is `    resource_class: medium` inside `executors: node-medium`.
    // The `# pin to LTS` comment on the line above it is what makes this worth
    // asserting: a whole-document re-serialisation would move or drop it.
    assertOnlyLinesDiffer(before, after, [12]);
    expect(after).toContain('- image: cimg/node:20.0 # pin to LTS');
  });

  it('a gen2 class round-trips as a plain scalar, not a quoted or re-typed one', () => {
    // `xlarge.gen2` and `2xlarge+` both contain characters that a serialiser
    // might decide need quoting. The written line must be exactly what CircleCI
    // documents, since that is what the user picked.
    expect(
      mutated((doc) =>
        setJobField(doc, 'build', ['resource_class'], 'xlarge.gen2'),
      ),
    ).toContain('resource_class: xlarge.gen2');
    expect(
      mutated((doc) =>
        setJobField(doc, 'build', ['resource_class'], '2xlarge+'),
      ),
    ).toContain('resource_class: 2xlarge+');
  });

  it('a free-text class this snapshot has never heard of is written verbatim', () => {
    // The escape hatch: a class that shipped today must be writable before the
    // vendored tables are refreshed, and must not be normalised on the way out.
    const after = mutated((doc) =>
      setJobField(doc, 'build', ['resource_class'], 'arm.128xlarge.gen3'),
    );
    expect(after).toContain('resource_class: arm.128xlarge.gen3');
    expect(extractComments(after)).toEqual(extractComments(before));
  });

  it('reverting a job-level override removes only that line, comments intact', () => {
    const withOverride = mutated((doc) =>
      setJobField(doc, 'build', ['resource_class'], 'arm.large'),
    );
    const { doc } = parseConfig(withOverride);
    if (!doc) throw new Error('intermediate text failed to parse');
    const clone = cloneDocument(doc);
    unsetJobField(clone, 'build', ['resource_class']);
    const after = clone.toString();

    // Back to byte-for-byte identical with the original fixture: a set followed
    // by an unset is a no-op on the file, not a reformat of it.
    expect(after).toBe(before);
  });
});

/**
 * Issue #218's own comment-preservation bar for step reordering.
 *
 * Reordering is the first mutation this editor performs whose *whole point* is
 * to move an existing node rather than to change a value inside one, which
 * makes it the sharpest case for the guarantee `docs/ARCHITECTURE.md` is built
 * on. Issues #132 and #39 both record comment relocation as a known sharp edge
 * here, and there are two distinct ways to get it wrong:
 *
 * - A **`commentBefore`** (a comment on its own line above a step) already had
 *   a test. It is the easier half: the comment is attached to the node, so any
 *   implementation that moves the node moves it.
 * - A **trailing comment** (`- checkout # grab the source`) did not, and it is
 *   the half that looks like it might not survive, because in the serialised
 *   text it sits *after* its own value on a shared line rather than on a line
 *   of its own. Issue #218 asks for exactly this: "must move a step's trailing
 *   comment *with it*."
 *
 * Both are asserted against the whole document as an exact string -- not
 * "contains", and not a comment-set comparison -- because the failure mode
 * being guarded against is a comment that is still *present* while attached to
 * the wrong step, which every weaker assertion passes. A trailing comment that
 * stayed behind would silently re-label an unrelated step, and in a config
 * editor a comment pointing at the wrong line is worse than a missing one: it
 * is confidently wrong.
 */
describe('reordering steps carries every comment with the step (issue #218)', () => {
  it('moves a trailing comment with its own step, in both directions', () => {
    const text = `jobs:
  build:
    steps:
      - checkout # grab the source
      - run: make build # the slow one
      - run: make test # fast
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');

    // Last to first: every comment travels with the step it annotates.
    moveStep(doc, 'build', 2, 0);
    expect(doc.toString()).toBe(`jobs:
  build:
    steps:
      - run: make test # fast
      - checkout # grab the source
      - run: make build # the slow one
`);

    // ...and back again, which must restore the original file byte for byte
    // rather than an equivalent-but-reformatted version of it.
    moveStep(doc, 'build', 0, 2);
    expect(doc.toString()).toBe(text);
  });

  it('moves a step carrying both a preceding and a trailing comment, including a multi-line one', () => {
    const text = `jobs:
  build:
    steps:
      - checkout
      # setup_remote_docker has to come before anything that uses it
      - setup_remote_docker # needed by the docker build below
      - run:
          name: build image # tagged from the branch
          command: docker build .
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    moveStep(doc, 'build', 1, 0);

    // The preceding comment and the trailing comment both moved as one unit
    // with the step, and the multi-line `run:` below kept its own shape and its
    // own nested trailing comment -- nothing was re-emitted.
    expect(doc.toString()).toBe(`jobs:
  build:
    steps:
      # setup_remote_docker has to come before anything that uses it
      - setup_remote_docker # needed by the docker build below
      - checkout
      - run:
          name: build image # tagged from the branch
          command: docker build .
`);
  });

  /**
   * The honest boundary, pinned so it can't drift unnoticed in either
   * direction.
   *
   * A comment above the *first* item of a block sequence binds to the sequence,
   * not to that item -- so it stays with the list when the first step moves
   * away, which is the opposite of what happens for every later step (the test
   * above). That is `eemeli/yaml`'s parse behaviour, not something reordering
   * chose, and it is arguably the more useful of the two readings anyway
   * (a comment at the top of a step list usually describes the list).
   *
   * The point of asserting it is that it is *not obvious*, and it is exactly
   * the kind of thing a future "improve comment handling" change would alter by
   * accident. Deliberately not "fixed" into a heuristic here: guessing whether
   * a given comment describes the list or its first item would silently move
   * some comments to the wrong place, and #218's requirement is about not doing
   * that.
   */
  it('leaves a comment bound to the list itself with the list, not with the first step', () => {
    const text = `jobs:
  build:
    steps:
      # always first
      - checkout
      - run: make build
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    moveStep(doc, 'build', 0, 1);
    expect(doc.toString()).toBe(`jobs:
  build:
    steps:
      # always first
      - run: make build
      - checkout
`);
  });

  /**
   * A shape whose trailing comment is *already* relocated by a plain
   * parse-and-serialise, with no mutation at all: a comment on a step keyword
   * whose value is a nested block map (`- setup_remote_docker: # ...`) is
   * re-emitted on its own line above the first nested key.
   *
   * Recorded here because it would otherwise look like a reordering bug the
   * first time someone hits it -- it is not; it is one of issue #39's known
   * comment normalisations, and it happens whether or not any step is ever
   * moved. Asserted as the *current* behaviour so that a future fix to #39
   * fails this test loudly and gets it updated, rather than leaving a stale
   * claim in the suite.
   */
  it('does not introduce the block-map trailing-comment normalisation, which predates it (issue #39)', () => {
    const text = `jobs:
  build:
    steps:
      - setup_remote_docker: # not the default version
          version: docker24
      - run: docker build .
`;
    const normalised = `jobs:
  build:
    steps:
      - setup_remote_docker:
          # not the default version
          version: docker24
      - run: docker build .
`;
    const { doc: untouched } = parseConfig(text);
    if (!untouched) throw new Error('failed to parse');
    // No edit whatsoever, and the comment has already moved.
    expect(untouched.toString()).toBe(normalised);

    // Reordering therefore cannot be blamed for it -- and, crucially, does not
    // make it *worse*: the comment still travels with its own step.
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    moveStep(doc, 'build', 0, 1);
    expect(doc.toString()).toBe(`jobs:
  build:
    steps:
      - run: docker build .
      - setup_remote_docker:
          # not the default version
          version: docker24
`);
  });

  it("moves a pre-step's trailing comment too, and touches nothing else in the file", () => {
    const text = `# Managed by the platform team.
version: 2.1

jobs:
  build:
    steps:
      - checkout

workflows:
  main:
    jobs:
      - build:
          pre-steps:
            - run: setup-a # first
            - run: setup-b # second
            - run: setup-c # third
          requires: [] # nothing yet
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    moveWorkflowEntryStep(doc, 'main', 'build', 'pre-steps', 0, 2);

    expect(doc.toString()).toBe(`# Managed by the platform team.
version: 2.1

jobs:
  build:
    steps:
      - checkout

workflows:
  main:
    jobs:
      - build:
          pre-steps:
            - run: setup-b # second
            - run: setup-c # third
            - run: setup-a # first
          requires: [] # nothing yet
`);
  });

  it('reorders inside the real fixture without changing a single unrelated line', () => {
    const { doc } = parseConfig(fullConfig);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);
    moveStep(clone, 'test', 2, 0);
    const after = clone.toString();

    // Every comment in the file is still there, and still exactly the same
    // set -- the reorder moved one, it did not drop or duplicate any.
    expect(extractComments(after).sort()).toEqual(
      extractComments(fullConfig).sort(),
    );
    // And the diff is confined to the lines the moved step and its own comment
    // occupy, not a whole-file reformat.
    const { additions, deletions } = countChangedLines(
      unifiedDiff(fullConfig, after, 'config.yml'),
    );
    expect(additions).toBeLessThanOrEqual(3);
    expect(deletions).toBeLessThanOrEqual(3);
  });
});

/**
 * Issue #249. The visible change is an interaction one -- the list reflows to
 * open a gap where the drop will land instead of drawing a line -- and it moves
 * no YAML code at all: a reorder is still `moveStep`, a positioned insert is
 * still `addStep(doc, job, value, index)`.
 *
 * That is exactly why these tests are here. What #249 *does* change is which
 * gaps a user can reach confidently, and it makes the two ends of the list --
 * gap `0` and gap `steps.length` -- the easy, obvious targets rather than the
 * awkward ones. Those are the two indices where comment binding behaves
 * differently from the middle (`eemeli/yaml` binds a comment above the first
 * item to the *sequence*, not to that item), so a change that drives more
 * traffic through them should carry the round-trip evidence for them.
 *
 * Every assertion is on the **whole document as an exact string**, per #226 and
 * for its reason: the failure mode being guarded against is a comment that is
 * still present but attached to the *wrong step*, which `toContain` and a
 * comment-multiset comparison both pass. In a config editor a comment pointing
 * at the wrong line is worse than a missing one -- it is confidently wrong.
 */
describe('the boundary gaps a reflowed drop makes easy (issue #249)', () => {
  /** Every step carries a distinct trailing comment, so a misattachment is provable rather than merely possible. */
  const everyStepCommented = `jobs:
  build:
    docker:
      - image: cimg/base:current # small
    steps:
      - checkout # step one
      - run: make build # step two
      - run: make test # step three
`;

  it('a reorder into gap 0 moves the first-position comment binding, and inverts exactly', () => {
    const { doc } = parseConfig(everyStepCommented);
    if (!doc) throw new Error('failed to parse');

    // The last step dragged to the gap above the first row.
    moveStep(doc, 'build', 2, 0);
    expect(doc.toString()).toBe(`jobs:
  build:
    docker:
      - image: cimg/base:current # small
    steps:
      - run: make test # step three
      - checkout # step one
      - run: make build # step two
`);

    // ...and dragging it back to the gap after the last row restores the file
    // byte for byte, not an equivalent-but-reformatted version of it.
    moveStep(doc, 'build', 0, 2);
    expect(doc.toString()).toBe(everyStepCommented);
  });

  it('inserting a new step at gap 0 leaves every existing comment on its own step', () => {
    const { doc } = parseConfig(everyStepCommented);
    if (!doc) throw new Error('failed to parse');

    // What a palette card dropped in the gap above the first row writes.
    addStep(doc, 'build', 'setup_remote_docker', 0);
    expect(doc.toString()).toBe(`jobs:
  build:
    docker:
      - image: cimg/base:current # small
    steps:
      - setup_remote_docker
      - checkout # step one
      - run: make build # step two
      - run: make test # step three
`);
  });

  it('inserting a new step at the last gap appends without disturbing the step above it', () => {
    const { doc } = parseConfig(everyStepCommented);
    if (!doc) throw new Error('failed to parse');

    addStep(doc, 'build', 'setup_remote_docker', 3);
    expect(doc.toString()).toBe(`jobs:
  build:
    docker:
      - image: cimg/base:current # small
    steps:
      - checkout # step one
      - run: make build # step two
      - run: make test # step three
      - setup_remote_docker
`);
  });

  /**
   * The honest boundary at gap 0, pinned as a whole-document string rather than
   * left as prose. A comment on its own line above the *first* item binds to the
   * sequence, so it stays at the top of the list when a step is inserted above
   * the step it was written over -- while the same comment above any later step
   * travels with that step. That is `eemeli/yaml`'s parse behaviour, not
   * something the drop position chose, and #218 already records why guessing
   * between the two readings would be worse. Asserted here because gap 0 is the
   * position #249 makes easiest to hit.
   */
  it('leaves a list-bound comment at the top of the list when a step is dropped into gap 0', () => {
    const text = `jobs:
  build:
    steps:
      # always check out first
      - checkout
      - run: make build
`;
    const { doc } = parseConfig(text);
    if (!doc) throw new Error('failed to parse');
    addStep(doc, 'build', 'setup_remote_docker', 0);

    expect(doc.toString()).toBe(`jobs:
  build:
    steps:
      # always check out first
      - setup_remote_docker
      - checkout
      - run: make build
`);
  });

  it('reorders the real fixture through both boundary gaps with the file otherwise byte-identical', () => {
    const { doc } = parseConfig(fullConfig);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);

    // First row to the gap after the last, then straight back: two moves the
    // reflow makes trivially aimable, and a file that has to come out identical.
    moveStep(clone, 'test', 0, 2);
    expect(clone.toString()).not.toBe(fullConfig);
    moveStep(clone, 'test', 2, 0);
    expect(clone.toString()).toBe(fullConfig);
  });
});

/**
 * Round-trip coverage for the two writes issues #211 and #212 introduce. Both are
 * surgical `eemeli/yaml` mutations of an existing document -- nothing here
 * regenerates YAML -- and both are reached from a *field*, so a user watching the
 * editor pane must see one line change and nothing else move.
 */
describe('executor field mutations preserve everything around them', () => {
  /** A macOS job with comments in every position a re-serialisation would disturb. */
  const macosConfig = `version: 2.1

# Apple platform builds.
jobs:
  ios: # runs on Apple silicon
    macos:
      # Bump this when a new Xcode ships.
      xcode: 15.3.0 # <- not a version CircleCI offers (issue #203)
    resource_class: m4pro.medium
    steps:
      - checkout # shallow by default

workflows:
  build:
    jobs:
      - ios
`;

  /** A Docker job on an x86 class, for the architecture filter's own mutation. */
  const dockerConfig = `version: 2.1

jobs:
  build:
    docker:
      - image: cimg/base:current # general purpose
    # Sized for the test suite, not the build.
    resource_class: medium
    steps:
      - checkout

workflows:
  build:
    jobs:
      - build
`;

  type ConfigDocument = Parameters<typeof setJobField>[0];

  /**
   * Applies `fn` the way the app does: a clone, mutated, then re-serialised
   * through `serializeMinimalDiff` (issues #81/#39), which splices only the
   * changed nodes back into the original text.
   *
   * Deliberately *not* `clone.toString()`, which the older blocks above use. The
   * difference matters for exactly the case these fixtures contain: a trailing
   * comment on a *mapping key* (`ios: # runs on Apple silicon`) is re-emitted by
   * `yaml` on its own line, so a whole-document serialisation reports three changed
   * lines for a one-line edit. The store never does that, so a test that did would
   * be asserting against something no user sees.
   */
  function mutate(
    before: string,
    fn: (doc: ConfigDocument) => void,
  ): { before: string; after: string } {
    const { doc } = parseConfig(before);
    if (!doc) throw new Error('fixture failed to parse');
    const clone = cloneDocument(doc);
    fn(clone);
    return { before, after: serializeMinimalDiff(before, doc, clone) };
  }

  it('changing the Xcode version rewrites exactly its own line', () => {
    const { before, after } = mutate(macosConfig, (doc) =>
      setJobField(doc, 'ios', ['macos', 'xcode'], '26.4.1'),
    );

    expect(after).toContain('xcode: 26.4.1');
    // Every comment survives, including the two on the lines either side of the
    // one that changed and the trailing comment on the changed line's own key.
    expect(extractComments(after)).toEqual(extractComments(before));
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    // The resource class, the steps and the workflow entry are untouched.
    expect(after).toContain('resource_class: m4pro.medium');
    expect(after).toContain('- checkout # shallow by default');
    expect(after).toContain('ios: # runs on Apple silicon');
  });

  it('quotes an Xcode version YAML would otherwise read as a number', () => {
    // `26.5` unquoted is a YAML float, which is a different value from the string
    // CircleCI's table lists -- and the difference is invisible until CircleCI
    // rejects the config. `yaml` handles this given a string node; this pins that
    // it does, and that it does not over-quote the dotted versions.
    expect(
      mutate(macosConfig, (doc) =>
        setJobField(doc, 'ios', ['macos', 'xcode'], '26.5'),
      ).after,
    ).toContain('xcode: "26.5"');
    expect(
      mutate(macosConfig, (doc) =>
        setJobField(doc, 'ios', ['macos', 'xcode'], '14.3.1'),
      ).after,
    ).toContain('xcode: 14.3.1');
  });

  it('writes a free-text Xcode version verbatim', () => {
    // The escape hatch: an Xcode released today must be writable before the
    // vendored table is refreshed, and must not be normalised on the way out.
    const { after } = mutate(macosConfig, (doc) =>
      setJobField(doc, 'ios', ['macos', 'xcode'], '27.2.0'),
    );
    expect(after).toContain('xcode: 27.2.0');
  });

  it('the architecture filter’s switch changes one line and no comments', () => {
    // Issue #212's "Switch to arm.medium". It is a config mutation, so it has to be
    // as surgical as any other field write -- and as undoable, which `mutate` in
    // `appStore` gives it by construction (one call, one history entry).
    const { before, after } = mutate(dockerConfig, (doc) =>
      setJobField(doc, 'build', ['resource_class'], 'arm.medium'),
    );

    expect(after).toContain('resource_class: arm.medium');
    expect(after).not.toContain('resource_class: medium');
    expect(extractComments(after)).toEqual(extractComments(before));
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    // The comment immediately above the changed line, and the trailing comment on
    // the image line, both stay put -- the two things a whole-document
    // re-serialisation reliably moves.
    expect(after).toContain('# Sized for the test suite, not the build.');
    expect(after).toContain('- image: cimg/base:current # general purpose');
  });

  it('switching architecture and back leaves the file byte-for-byte identical', () => {
    // Narrowing a filter is a view, not an edit; and a switch followed by its
    // inverse must be a no-op on the file rather than a reformat of it.
    const { after: armed } = mutate(dockerConfig, (doc) =>
      setJobField(doc, 'build', ['resource_class'], 'arm.medium'),
    );
    const { after } = mutate(armed, (doc) =>
      setJobField(doc, 'build', ['resource_class'], 'medium'),
    );
    expect(after).toBe(dockerConfig);
  });
});
