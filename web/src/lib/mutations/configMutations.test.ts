import { describe, expect, it } from 'vitest';

import {
  addJob,
  addJobFromExecutor,
  addOrb,
  addRequire,
  addStep,
  addWorkflow,
  addWorkflowJobEntry,
  addWorkflowJobEntryContext,
  addWorkflowEntryStep,
  addWorkflowTrigger,
  BARE_STRING_STEP_KEYS,
  deleteJob,
  extractSharedCommand,
  extractSharedExecutor,
  insertOrbJob,
  insertOrbStep,
  moveStep,
  moveWorkflowEntryStep,
  removeRequire,
  removeStep,
  removeWorkflowEntryStep,
  removeWorkflowJobEntryContext,
  removeWorkflowJobEntry,
  removeWorkflowTrigger,
  setExecutorField,
  setExecutorImage,
  setJobExecutorFromOrb,
  setJobExecutorSpec,
  setJobField,
  setRequires,
  setStepField,
  setWorkflowEntryStepField,
  setWorkflowEntryStepFieldValue,
  setWorkflowField,
  setWorkflowJobEntryAlias,
  setWorkflowJobEntryOption,
  setWorkflowJobEntryParameter,
  unsetJobField,
  unsetWorkflowField,
  renameJob,
} from './configMutations';
import { MUTATION_FIXTURE } from './fixtures';
import { countChangedLines, unifiedDiff } from '~/lib/yaml/diff';
import {
  cloneDocument,
  getIn,
  getJobGroupMembers,
  getJobGroupNames,
  getJobNames,
  getWorkflowJobEntries,
  getWorkflowNames,
  moveSeqItem,
  parseConfig,
  setIn,
} from '~/lib/yaml/documentUtils';
import { serializeMinimalDiff } from '~/lib/yaml/spliceSerialize';
import type { Document } from 'yaml';
import fullConfigFixture from '~/fixtures/full-config.yml?raw';
import orchestrationConstructs from '~/fixtures/orchestration-constructs.yml?raw';

function parse(): Document.Parsed {
  const { doc, error } = parseConfig(MUTATION_FIXTURE);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

const WORKFLOW = 'build_test_deploy';

describe('addJob', () => {
  it('creates a minimal valid job and appends it to the given workflow', () => {
    const doc = parse();
    addJob(doc, { name: 'lint', workflowName: WORKFLOW });

    expect(getIn(doc, ['jobs', 'lint'])).toEqual({
      docker: [{ image: 'cimg/base:current' }],
      steps: ['checkout'],
    });
    expect(
      getWorkflowJobEntries(doc, WORKFLOW).map((e) => e.jobName),
    ).toContain('lint');
  });

  it('honors opts.image', () => {
    const doc = parse();
    addJob(doc, { name: 'lint', image: 'cimg/node:20.0' });
    expect(getIn(doc, ['jobs', 'lint', 'docker', 0, 'image'])).toBe(
      'cimg/node:20.0',
    );
  });

  it('creates jobs/workflows/jobs-seq from scratch when absent', () => {
    const { doc } = parseConfig('version: 2.1\n');
    if (!doc) throw new Error('parse failed');
    addJob(doc, { name: 'build', workflowName: 'main' });
    expect(getJobNames(doc)).toEqual(['build']);
    expect(getWorkflowNames(doc)).toEqual(['main']);
    expect(getWorkflowJobEntries(doc, 'main')).toEqual([
      { jobName: 'build', requires: [], index: 0, isString: true },
    ]);
  });

  it('rejects a duplicate job name', () => {
    const doc = parse();
    expect(() => addJob(doc, { name: 'build' })).toThrow(/already exists/);
  });

  it('leaves unrelated comments untouched', () => {
    const doc = parse();
    addJob(doc, { name: 'lint' });
    expect(doc.toString()).toContain('# Owned by #platform-eng.');
    expect(doc.toString()).toContain('# Deploy jobs');
    expect(doc.toString()).toContain('# These only run against main.');
  });
});

describe('deleteJob (#12)', () => {
  it('removes the job, its workflow entries (including aliased ones), and prunes requires -- collapsing the emptied entry to a bare string', () => {
    const doc = parse();
    deleteJob(doc, 'test');

    expect(getJobNames(doc)).toEqual(['build', 'deploy']);

    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    // Both aliased "test" entries (test-linux, test-macos) are gone.
    expect(entries.map((e) => e.jobName)).toEqual(['build', 'deploy']);
    // deploy's requires referenced both aliases; both are pruned, and since
    // requires was deploy's only option, it collapses to a bare string.
    const deployEntry = entries.find((e) => e.jobName === 'deploy');
    expect(deployEntry).toEqual({
      jobName: 'deploy',
      requires: [],
      index: 1,
      isString: true,
    });
  });

  it('keeps surrounding comments byte-identical', () => {
    const doc = parse();
    deleteJob(doc, 'test');
    const text = doc.toString();
    expect(text).toContain(
      '# This config builds, tests, and deploys the widgets service.\n# Owned by #platform-eng.\n',
    );
    // The comment sat right above `test:`, which is now gone, but the
    // header/blank-line pair should survive re-attached (or simply absent,
    // never mangled) rather than corrupted.
    expect(text).not.toMatch(/#[^\n]*\n#[^\n]*\n#[^\n]*\n#[^\n]*/); // no comment scrambling
  });

  it('throws for an unknown job', () => {
    const doc = parse();
    expect(() => deleteJob(doc, 'nope')).toThrow(/does not exist/);
  });

  it('is a minimal-diff edit', () => {
    const doc = parse();
    const before = doc.toString();
    deleteJob(doc, 'test');
    const after = doc.toString();
    const diff = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // The whole `test:` job (9 lines incl. blank separator) + both
    // aliased workflow entries (8 lines) + deploy's now-dangling
    // `requires:` block (4 lines) are deleted; deploy's bare-string
    // replacement is the only addition.
    expect(deletions).toBe(21);
    expect(additions).toBe(1);
    expect(after).toContain('# Owned by #platform-eng.');
    expect(after).toContain('orbs:\n  node: circleci/node@5.2.0');
  });
});

describe('renameJob', () => {
  it('renames the jobs key, workflow entries, and requires mentions, preserving key position/comments', () => {
    const doc = parse();
    renameJob(doc, 'build', 'compile');

    expect(getJobNames(doc)).toEqual(['compile', 'test', 'deploy']);
    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    expect(entries[0]).toEqual({
      jobName: 'compile',
      requires: [],
      index: 0,
      isString: true,
    });
    // requires: [build] on both aliased test entries now point at "compile".
    expect(entries[1]).toEqual({
      jobName: 'test',
      requires: ['compile'],
      index: 1,
      isString: false,
    });
    expect(entries[2]).toEqual({
      jobName: 'test',
      requires: ['compile'],
      index: 2,
      isString: false,
    });
  });

  it('keeps an entry alias untouched when the underlying job it points at is renamed', () => {
    const doc = parse();
    renameJob(doc, 'test', 'unit_test');

    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    expect(entries.map((e) => e.jobName)).toEqual([
      'build',
      'unit_test',
      'unit_test',
      'deploy',
    ]);
    // deploy requires the *aliases*, which are untouched by renaming the job.
    expect(entries[3]).toEqual({
      jobName: 'deploy',
      requires: ['test-linux', 'test-macos'],
      index: 3,
      isString: false,
    });
  });

  it('rejects renaming onto an existing job name', () => {
    const doc = parse();
    expect(() => renameJob(doc, 'build', 'test')).toThrow(/already exists/);
  });

  it('is a minimal-diff edit (only the renamed occurrences change)', () => {
    const doc = parse();
    const before = doc.toString();
    renameJob(doc, 'build', 'compile');
    const after = doc.toString();
    const diff = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // jobs key line, workflow bare entry line, and two "requires: - build" lines.
    expect(additions).toBe(4);
    expect(deletions).toBe(4);
    expect(after).toContain('# Deploy jobs');
  });
});

// ---------------------------------------------------------------------------
// Issue #12's sharpest edge: the workflow-entry `name:` alias form. An entry
// can be `- test`, `- test: {requires: [...]}` or `- some-job: {name: test}`,
// and in the last shape it is the *alias* -- not the map key -- that every
// `requires:` in that workflow refers to. Getting this backwards silently
// re-points a dependency at a job that isn't even in the workflow, which no
// amount of YAML-level correctness would catch.
// ---------------------------------------------------------------------------

describe('renameJob and the workflow-entry name: alias form (#12)', () => {
  /**
   * `deploy_pipeline` aliases the *other* job (`shared-runner`) as `test`,
   * while a real `jobs.test` exists and is only used in `ci`. So
   * `requires: [test]` means two entirely different things in the two
   * workflows, and renaming `jobs.test` must only touch the `ci` one.
   */
  function parseShadowFixture(): Document.Parsed {
    const { doc, error } = parseConfig(`
jobs:
  test:
    docker: []
  shared-runner:
    docker: []
  deploy:
    docker: []
workflows:
  ci:
    jobs:
      - test
      - deploy:
          requires:
            - test
  deploy_pipeline:
    jobs:
      - shared-runner:
          name: test
      - deploy:
          name: deploy-prod
          requires:
            - test
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  it('rewrites requires: in a workflow where the bare job name really is the entry id', () => {
    const doc = parseShadowFixture();
    renameJob(doc, 'test', 'unit');

    expect(
      getIn(doc, ['workflows', 'ci', 'jobs', 1, 'deploy', 'requires']),
    ).toEqual(['unit']);
    expect(getIn(doc, ['workflows', 'ci', 'jobs', 0])).toBe('unit');
  });

  it('leaves requires: alone in a workflow where another job is aliased name: <the renamed name>', () => {
    const doc = parseShadowFixture();
    renameJob(doc, 'test', 'unit');

    // `deploy_pipeline`'s `requires: [test]` refers to shared-runner's alias,
    // which this rename never touched -- rewriting it would have pointed the
    // dependency at a job that isn't in this workflow at all.
    expect(
      getIn(doc, [
        'workflows',
        'deploy_pipeline',
        'jobs',
        1,
        'deploy',
        'requires',
      ]),
    ).toEqual(['test']);
    // ...and the aliasing entry itself is untouched in both halves.
    expect(
      getIn(doc, ['workflows', 'deploy_pipeline', 'jobs', 0, 'shared-runner']),
    ).toEqual({ name: 'test' });
  });

  it('leaves requires: alone for the degenerate - job: {name: job} form, whose id survives the rename', () => {
    const { doc, error } = parseConfig(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - build:
          name: build
      - deploy:
          requires:
            - build
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    renameJob(doc, 'build', 'compile');

    // The entry key becomes `compile`, but its explicit `name: build` is
    // never rewritten -- so the entry's id is still `build`, and
    // `requires: [build]` is still correct exactly as written.
    expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toEqual({
      compile: { name: 'build' },
    });
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 1, 'deploy', 'requires']),
    ).toEqual(['build']);
  });

  it('leaves an already-dangling requires: untouched rather than moving the breakage', () => {
    const { doc, error } = parseConfig(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          requires:
            - build
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    // `build` has no entry in `main` at all, so `requires: [build]` was
    // already dangling. Renaming the job must not silently "fix" it into
    // `requires: [compile]`, which would still dangle but hide the original
    // mistake behind a name the user never wrote there.
    renameJob(doc, 'build', 'compile');
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'deploy', 'requires']),
    ).toEqual(['build']);
  });

  it("renames an aliased entry's key across every workflow while every alias keeps its id", () => {
    const doc = parseShadowFixture();
    renameJob(doc, 'shared-runner', 'runner');

    expect(getJobNames(doc)).toContain('runner');
    expect(getIn(doc, ['workflows', 'deploy_pipeline', 'jobs', 0])).toEqual({
      runner: { name: 'test' },
    });
    // The alias `test` is what `requires:` referenced, and it is unchanged.
    expect(
      getIn(doc, [
        'workflows',
        'deploy_pipeline',
        'jobs',
        1,
        'deploy',
        'requires',
      ]),
    ).toEqual(['test']);
  });
});

describe('deleteJob and the workflow-entry name: alias form (#12)', () => {
  it('removes every alias of the deleted job and prunes requires: by alias, not by job name', () => {
    const { doc, error } = parseConfig(`
jobs:
  test:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - test:
          name: test-linux
      - test:
          name: test-macos
      - deploy:
          requires:
            - test-linux
            - test-macos
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    deleteJob(doc, 'test');

    expect(getJobNames(doc)).toEqual(['deploy']);
    // Both aliased entries gone, and deploy's requires -- which named the
    // aliases, never the job -- emptied and collapsed to a bare string.
    expect(getIn(doc, ['workflows', 'main', 'jobs'])).toEqual(['deploy']);
  });

  it('does not prune a same-named alias belonging to a different job', () => {
    const { doc, error } = parseConfig(`
jobs:
  test:
    docker: []
  shared-runner:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - shared-runner:
          name: test
      - deploy:
          requires:
            - test
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    // `jobs.test` has no entry in this workflow; the id `test` belongs to
    // shared-runner's alias. Deleting the job definition must not touch it.
    deleteJob(doc, 'test');

    expect(getJobNames(doc)).toEqual(['shared-runner', 'deploy']);
    expect(getIn(doc, ['workflows', 'main', 'jobs'])).toEqual([
      { 'shared-runner': { name: 'test' } },
      { deploy: { requires: ['test'] } },
    ]);
  });
});

describe('reconciliation preserves comments and formatting (#12)', () => {
  const COMMENTED = `# Widgets service pipeline.
version: 2.1

jobs:
  # Compiles the service.
  build:
    docker:
      - image: cimg/base:2024.01 # pinned deliberately
    steps:
      - checkout

  test: # runs the unit suite
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout

  # Ship it.
  deploy:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout

workflows:
  main:
    jobs:
      - build
      # test gates the deploy
      - test:
          requires:
            - build
      - deploy:
          requires:
            - test # only after tests pass
`;

  /** Every `#`-comment substring in `text`, in order -- same shape `roundtrip.test.ts` asserts on. */
  function comments(text: string): string[] {
    const found: string[] = [];
    for (const line of text.split('\n')) {
      const match = /#.*$/.exec(line);
      if (match) found.push(match[0]);
    }
    return found;
  }

  /**
   * Applies `edit` through exactly the path `appStore.mutate` uses -- clone,
   * mutate the clone, then `serializeMinimalDiff` against the original text --
   * rather than the raw `doc.toString()` the assertions above use. That
   * distinction matters here specifically: `toString()` re-emits the whole
   * document with `yaml`'s own layout rules, which (verified against
   * `yaml@2.9`, with no mutation at all) relocates a trailing comment on a
   * key whose value is a block collection onto its own line. The splice path
   * never rewrites bytes outside the edited node, so it is the one that
   * actually delivers this project's comment-preservation promise, and it is
   * what these tests assert on.
   */
  function applyLikeTheStore(
    text: string,
    edit: (doc: Document) => void,
  ): string {
    const { doc, error } = parseConfig(text);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    const clone = cloneDocument(doc);
    edit(clone);
    return serializeMinimalDiff(text, doc, clone);
  }

  it('a rename touching three sites changes exactly those three lines and no comment', () => {
    const after = applyLikeTheStore(COMMENTED, (d) =>
      renameJob(d, 'test', 'unit'),
    );

    const diff = unifiedDiff(COMMENTED, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // jobs.test's key, the workflow entry key, and deploy's `- test` require
    // -- three sites, one line each.
    expect(additions).toBe(3);
    expect(deletions).toBe(3);

    // The exact lines that changed, and nothing else. Note the trailing
    // comments riding along on two of them, byte-identical.
    const changed = diff
      .filter((line) => line.type === 'add' || line.type === 'del')
      .map((line) => line.text.trim());
    expect(changed.sort()).toEqual(
      [
        '- test # only after tests pass',
        '- unit # only after tests pass',
        'test: # runs the unit suite',
        'unit: # runs the unit suite',
        '- test:',
        '- unit:',
      ].sort(),
    );

    // Every comment survives, in the same order, including the two trailing
    // comments that sit on lines the rename *did* rewrite.
    expect(comments(after)).toEqual(comments(COMMENTED));
  });

  it('a delete removes only the deleted job and its references, leaving every unrelated comment intact', () => {
    const after = applyLikeTheStore(COMMENTED, (d) => deleteJob(d, 'test'));

    expect(after).toContain('# Widgets service pipeline.');
    expect(after).toContain('# Compiles the service.');
    expect(after).toContain('# pinned deliberately');
    expect(after).toContain('# Ship it.');
    // The only comments lost are the ones that lived on lines this delete
    // removed: `test:`'s own trailing note, the full-line comment above its
    // workflow entry, and the trailing note on deploy's `- test` require.
    const lost = comments(COMMENTED).filter(
      (comment) => !comments(after).includes(comment),
    );
    expect(lost.sort()).toEqual(
      [
        '# runs the unit suite',
        '# test gates the deploy',
        '# only after tests pass',
      ].sort(),
    );
  });
});

describe('addWorkflow / addWorkflowJobEntry / removeWorkflowJobEntry', () => {
  it('addWorkflow creates an empty workflow and rejects a duplicate', () => {
    const doc = parse();
    addWorkflow(doc, 'nightly');
    expect(getWorkflowNames(doc)).toContain('nightly');
    expect(getWorkflowJobEntries(doc, 'nightly')).toEqual([]);
    expect(() => addWorkflow(doc, 'nightly')).toThrow(/already exists/);
  });

  it('addWorkflowJobEntry writes bare string, aliased, and requires forms; throws for a missing workflow', () => {
    const doc = parse();
    addWorkflow(doc, 'nightly');
    addWorkflowJobEntry(doc, 'nightly', 'build');
    addWorkflowJobEntry(doc, 'nightly', 'test', {
      alias: 'test-nightly',
      requires: ['build'],
    });

    expect(getWorkflowJobEntries(doc, 'nightly')).toEqual([
      { jobName: 'build', requires: [], index: 0, isString: true },
      { jobName: 'test', requires: ['build'], index: 1, isString: false },
    ]);
    expect(
      getIn(doc, ['workflows', 'nightly', 'jobs', 1, 'test', 'name']),
    ).toBe('test-nightly');
    expect(() => addWorkflowJobEntry(doc, 'nope', 'build')).toThrow(
      /does not exist/,
    );
  });

  it('removeWorkflowJobEntry removes the entry and prunes it from other entries requires', () => {
    const doc = parse();
    removeWorkflowJobEntry(doc, WORKFLOW, 'test-linux');

    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    expect(entries.map((e) => e.jobName)).toEqual(['build', 'test', 'deploy']);
    const deployEntry = entries.find((e) => e.jobName === 'deploy');
    expect(deployEntry?.requires).toEqual(['test-macos']);
  });

  it('throws for an unknown node id', () => {
    const doc = parse();
    expect(() => removeWorkflowJobEntry(doc, WORKFLOW, 'nope')).toThrow(
      /has no entry/,
    );
  });
});

describe('addRequire / removeRequire / setRequires', () => {
  it('addRequire converts a bare-string entry to map form and is idempotent', () => {
    const doc = parse();
    addJob(doc, { name: 'lint' });
    addWorkflowJobEntry(doc, WORKFLOW, 'lint');

    addRequire(doc, WORKFLOW, 'lint', 'build');
    let entries = getWorkflowJobEntries(doc, WORKFLOW);
    let lint = entries.find((e) => e.jobName === 'lint');
    expect(lint).toEqual({
      jobName: 'lint',
      requires: ['build'],
      index: 4,
      isString: false,
    });

    const before = doc.toString();
    addRequire(doc, WORKFLOW, 'lint', 'build'); // idempotent
    expect(doc.toString()).toBe(before);

    entries = getWorkflowJobEntries(doc, WORKFLOW);
    lint = entries.find((e) => e.jobName === 'lint');
    expect(lint?.requires).toEqual(['build']);
  });

  it('throws on a self-loop', () => {
    const doc = parse();
    expect(() => addRequire(doc, WORKFLOW, 'test-linux', 'test-linux')).toThrow(
      /cannot require itself/,
    );
  });

  it('throws on a would-be cycle (a requires b, then b requires a)', () => {
    const doc = parse();
    addJob(doc, { name: 'a' });
    addJob(doc, { name: 'b' });
    addWorkflowJobEntry(doc, WORKFLOW, 'a');
    addWorkflowJobEntry(doc, WORKFLOW, 'b');

    addRequire(doc, WORKFLOW, 'b', 'a'); // b requires a
    expect(() => addRequire(doc, WORKFLOW, 'a', 'b')).toThrow(/cycle/i);
  });

  it('removeRequire updates one alias independently of the other, then collapses to a bare string once empty', () => {
    const doc = parse();
    removeRequire(doc, WORKFLOW, 'deploy', 'test-linux');

    let entries = getWorkflowJobEntries(doc, WORKFLOW);
    let deploy = entries.find((e) => e.jobName === 'deploy');
    expect(deploy).toEqual({
      jobName: 'deploy',
      requires: ['test-macos'],
      index: 3,
      isString: false,
    });

    removeRequire(doc, WORKFLOW, 'deploy', 'test-macos');
    entries = getWorkflowJobEntries(doc, WORKFLOW);
    deploy = entries.find((e) => e.jobName === 'deploy');
    expect(deploy).toEqual({
      jobName: 'deploy',
      requires: [],
      index: 3,
      isString: true,
    });
  });

  it('setRequires replaces the whole list, including clearing it back to a bare string', () => {
    const doc = parse();
    setRequires(doc, WORKFLOW, 'test-linux', ['deploy']); // arbitrary reassignment, not validated for cycles
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'requires']),
    ).toEqual(['deploy']);

    setRequires(doc, WORKFLOW, 'test-linux', []);
    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    const testLinux = entries[1];
    expect(testLinux).toEqual({
      jobName: 'test',
      requires: [],
      index: 1,
      isString: false,
    });
    // still aliased, so it does NOT collapse to a bare string
    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'name'])).toBe(
      'test-linux',
    );
  });

  it('is a minimal-diff edit', () => {
    const doc = parse();
    const before = doc.toString();
    removeRequire(doc, WORKFLOW, 'deploy', 'test-linux');
    const after = doc.toString();
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    expect(additions).toBe(0);
    expect(deletions).toBe(1);
  });

  // Issue #289: canvas-level link (`onConnect` -> `addRequire`) and unlink
  // (`onEdgesDelete`/the hover affordance -> `removeRequire`) are meant to be
  // exact inverses -- the round trip this issue calls out as "the property
  // most likely to quietly break". Asserted at the mutation layer directly
  // (byte-for-byte `doc.toString()`, not just an equivalent re-parse), since
  // this is the one property a semantic/structural comparison could hide a
  // regression in (e.g. a stray blank line, or a bare-string collapse that
  // changes quoting).
  it('addRequire then removeRequire round-trips a bare-string entry byte-for-byte', () => {
    const doc = parse();
    addJob(doc, { name: 'lint' });
    addWorkflowJobEntry(doc, WORKFLOW, 'lint');
    const before = doc.toString();

    addRequire(doc, WORKFLOW, 'lint', 'build');
    expect(doc.toString()).not.toBe(before);

    removeRequire(doc, WORKFLOW, 'lint', 'build');
    expect(doc.toString()).toBe(before);
  });
});

describe('requires with status conditions (#26)', () => {
  function parseStatusFixture() {
    const { doc, error } = parseConfig(`jobs:
  lint:
    docker: []
  build:
    docker: []
  test:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - lint
      - build
      - test:
          requires:
            - lint:
                - success
                - failed
            - build
      - deploy:
          requires:
            - test:
                - success
                - failed
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  it("renameJob rewrites a status-map requires entry's key and keeps its statuses untouched", () => {
    const doc = parseStatusFixture();
    renameJob(doc, 'lint', 'lint-backend');

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 2, 'test', 'requires']),
    ).toEqual([{ 'lint-backend': ['success', 'failed'] }, 'build']);
    // The sibling plain-string entry ("build") must not have been turned
    // into a map, and the deploy entry's own status-map requires (on a
    // job untouched by this rename) must be completely unaffected.
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 3, 'deploy', 'requires']),
    ).toEqual([{ test: ['success', 'failed'] }]);
  });

  it('renameJob is a minimal-diff edit -- only the renamed key text changes', () => {
    const doc = parseStatusFixture();
    const before = doc.toString();
    renameJob(doc, 'lint', 'lint-backend');
    const after = doc.toString();
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    // jobs.lint's key, the bare "- lint" workflow entry, and the one
    // status-map requires key -- three occurrences of the old name, three
    // of the new one.
    expect(additions).toBe(3);
    expect(deletions).toBe(3);
  });

  it('removeRequire removes only the matching status-map entry, leaving the plain-string sibling as a bare string', () => {
    const doc = parseStatusFixture();
    removeRequire(doc, 'main', 'test', 'lint');

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 2, 'test', 'requires']),
    ).toEqual(['build']);
  });

  it('removeRequire removes a plain-string entry without disturbing a status-map sibling', () => {
    const doc = parseStatusFixture();
    removeRequire(doc, 'main', 'test', 'build');

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 2, 'test', 'requires']),
    ).toEqual([{ lint: ['success', 'failed'] }]);
  });

  it('removeRequire is a minimal-diff edit for a status-map entry', () => {
    const doc = parseStatusFixture();
    const before = doc.toString();
    removeRequire(doc, 'main', 'deploy', 'test');
    const after = doc.toString();
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    // deploy's whole entry (its own "- deploy:" map key plus the 4-line
    // requires: block) is gone; deploy collapses to a single bare-string
    // line.
    expect(deletions).toBe(5);
    expect(additions).toBe(1);
  });

  // Issue #289: the same byte-for-byte link/unlink round trip as
  // `addRequire / removeRequire / setRequires`'s own test of this, but
  // against an entry that already has other options -- `removeRequire`'s
  // collapse-back-to-a-bare-string path only applies once the options map
  // empties out completely, so this exercises the "stays a map" branch
  // instead of that one.
  it('addRequire then removeRequire round-trips an already-map entry byte-for-byte', () => {
    const doc = parseStatusFixture();
    const before = doc.toString();

    // `deploy` already requires `test` (a status-map entry); `lint` has no
    // requires of its own, so `deploy` requiring it too closes no cycle.
    addRequire(doc, 'main', 'deploy', 'lint');
    expect(doc.toString()).not.toBe(before);

    removeRequire(doc, 'main', 'deploy', 'lint');
    expect(doc.toString()).toBe(before);
  });

  it('deleteJob prunes a status-map requires entry referencing the deleted job', () => {
    const doc = parseStatusFixture();
    deleteJob(doc, 'lint');

    const entries = getWorkflowJobEntries(doc, 'main');
    const test = entries.find((e) => e.jobName === 'test');
    expect(test?.requires).toEqual(['build']);
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 1, 'test', 'requires']),
    ).toEqual(['build']);
  });

  it('setRequires accepts RequireRef entries and writes the status-map form', () => {
    const doc = parseStatusFixture();
    setRequires(doc, 'main', 'deploy', [
      'lint',
      { id: 'test', statuses: ['success', 'canceled'] },
    ]);

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 3, 'deploy', 'requires']),
    ).toEqual(['lint', { test: ['success', 'canceled'] }]);
  });

  it('setRequires still accepts plain string ids (backward compatible)', () => {
    const doc = parseStatusFixture();
    setRequires(doc, 'main', 'deploy', ['lint', 'build']);
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 3, 'deploy', 'requires']),
    ).toEqual(['lint', 'build']);
  });
});

describe('setJobField / setExecutorImage', () => {
  it('setJobField sets a nested field, creating containers as needed', () => {
    const doc = parse();
    setJobField(doc, 'build', ['resource_class'], 'large');
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('large');
  });

  it('setExecutorImage updates docker[0].image', () => {
    const doc = parse();
    setExecutorImage(doc, 'build', 'cimg/base:2024.06');
    expect(getIn(doc, ['jobs', 'build', 'docker', 0, 'image'])).toBe(
      'cimg/base:2024.06',
    );
  });

  it('throws for an unknown job', () => {
    const doc = parse();
    expect(() => setJobField(doc, 'nope', ['x'], 1)).toThrow(/does not exist/);
  });
});

describe('addStep / removeStep / moveStep', () => {
  it('addStep inserts at an index, defaulting to append', () => {
    const doc = parse();
    addStep(doc, 'build', { run: 'echo inserted' }, 1);
    expect(getIn(doc, ['jobs', 'build', 'steps'])).toEqual([
      'checkout',
      { run: 'echo inserted' },
      { run: 'make build' },
    ]);

    addStep(doc, 'build', { run: 'echo appended' });
    expect(getIn(doc, ['jobs', 'build', 'steps'])).toEqual([
      'checkout',
      { run: 'echo inserted' },
      { run: 'make build' },
      { run: 'echo appended' },
    ]);
  });

  it('creates steps: if absent', () => {
    const { doc } = parseConfig(
      'jobs:\n  foo:\n    docker:\n      - image: cimg/base:current\n',
    );
    if (!doc) throw new Error('parse failed');
    addStep(doc, 'foo', 'checkout');
    expect(getIn(doc, ['jobs', 'foo', 'steps'])).toEqual(['checkout']);
  });

  it('removeStep removes by index', () => {
    const doc = parse();
    removeStep(doc, 'build', 1);
    expect(getIn(doc, ['jobs', 'build', 'steps'])).toEqual(['checkout']);
  });

  it('removeStep throws for an out-of-range index', () => {
    const doc = parse();
    expect(() => removeStep(doc, 'build', 99)).toThrow(/no step/);
  });

  it('moveStep reorders steps, carrying a step comment with it', () => {
    const doc = parse();
    moveStep(doc, 'test', 2, 0);
    expect(doc.toString()).toContain(`    steps:
      # cleanup after tests
      - run: make clean
      - checkout
      - run: make test
`);
  });
});

describe('addOrb / insertOrbJob / insertOrbStep / setJobExecutorFromOrb', () => {
  it('addOrb is idempotent', () => {
    const doc = parse();
    addOrb(doc, 'node', 'circleci/node@5.2.0');
    expect(getIn(doc, ['orbs'])).toEqual({ node: 'circleci/node@5.2.0' });
  });

  it('insertOrbJob adds the orbs: entry once, and writes bare/params forms correctly', () => {
    const doc = parse();
    insertOrbJob(doc, {
      workflowName: WORKFLOW,
      orbRef: 'circleci/node@5.2.0',
      jobName: 'test',
    });
    insertOrbJob(doc, {
      workflowName: WORKFLOW,
      orbRef: 'circleci/node@5.2.0',
      jobName: 'test',
      params: { version: '20.0' },
      requires: ['build'],
    });

    expect(getIn(doc, ['orbs'])).toEqual({ node: 'circleci/node@5.2.0' });
    const jobs = getIn(doc, ['workflows', WORKFLOW, 'jobs']) as unknown[];
    expect(jobs[4]).toBe('node/test');
    expect(jobs[5]).toEqual({
      'node/test': { version: '20.0', requires: ['build'] },
    });
  });

  it('insertOrbStep adds the orb and the step', () => {
    const doc = parse();
    insertOrbStep(doc, {
      jobName: 'build',
      orbRef: 'circleci/node@5.2.0',
      commandName: 'install-packages',
      params: { 'cache-version': 'v1' },
    });
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.0');
    expect(getIn(doc, ['jobs', 'build', 'steps', 2])).toEqual({
      'node/install-packages': { 'cache-version': 'v1' },
    });
  });

  it('setJobExecutorFromOrb sets executor and imports the orb', () => {
    const doc = parse();
    setJobExecutorFromOrb(doc, {
      jobName: 'build',
      orbRef: 'circleci/node@5.2.0',
      executorName: 'default',
    });
    expect(getIn(doc, ['jobs', 'build', 'executor'])).toBe('node/default');
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.0');
  });

  it('derives a distinct alias for a different orb without disturbing the existing one', () => {
    const doc = parse();
    insertOrbStep(doc, {
      jobName: 'build',
      orbRef: 'circleci/slack@4.12.0',
      commandName: 'notify',
    });
    expect(getIn(doc, ['orbs'])).toEqual({
      node: 'circleci/node@5.2.0',
      slack: 'circleci/slack@4.12.0',
    });
  });

  it('insertOrbStep writes a bare string when there are no parameters', () => {
    const doc = parse();
    insertOrbStep(doc, {
      jobName: 'build',
      orbRef: 'circleci/slack@4.12.0',
      commandName: 'notify',
    });
    // Not `{ 'slack/notify': {} }`. The bare form is what a human writes, and
    // issue #252's step editor has to recognise it as an orb command rather than
    // as an opaque bare step -- which is exactly what it failed to do.
    expect(getIn(doc, ['jobs', 'build', 'steps', 2])).toBe('slack/notify');
  });

  /**
   * Issue #59 was a P1: an orb reference was inserted with its namespace
   * dropped (`slack@4.12.0` rather than `circleci/slack@4.12.0`), which
   * corrupted a real config. The guard has always lived in the completion path
   * and the orb store; these pin it on `insertOrbStep` itself, which is the
   * function #252's work touches.
   *
   * The invariant is that `orbsEntry` keeps the *reference* whole and derives
   * only the *alias* from the bare orb name -- so the alias may be short, and
   * the value under `orbs:` never may be.
   */
  describe('preserves the orb namespace when inserting a step (regression for #59)', () => {
    it.each([
      ['circleci/slack@4.12.0', 'slack'],
      ['cci-labs/act@1.0.0', 'act'],
      // A namespace spelled the same as the orb: truncating to either half
      // still looks like a valid reference, which is the shape that let #59
      // survive review in the first place.
      ['act/act@1.0.0', 'act'],
      // No version pinned: the reference must still arrive whole.
      ['cci-labs/act', 'act'],
    ])('%s is imported verbatim', (orbRef, expectedAlias) => {
      const doc = parse();
      insertOrbStep(doc, {
        jobName: 'build',
        orbRef,
        commandName: 'install',
      });

      const imported = getIn(doc, ['orbs', expectedAlias]);
      expect(imported).toBe(orbRef);
      expect(String(imported)).toContain('/');
      expect(getIn(doc, ['jobs', 'build', 'steps', 2])).toBe(
        `${expectedAlias}/install`,
      );
    });

    it('keeps the namespace when parameters are supplied too', () => {
      const doc = parse();
      insertOrbStep(doc, {
        jobName: 'build',
        orbRef: 'cci-labs/act@1.0.0',
        commandName: 'install',
        params: { version: '0.2.60' },
      });
      expect(getIn(doc, ['orbs', 'act'])).toBe('cci-labs/act@1.0.0');
      expect(getIn(doc, ['jobs', 'build', 'steps', 2])).toEqual({
        'act/install': { version: '0.2.60' },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Critical regression: deleteJob/removeWorkflowJobEntry must never strand a
// YAML alias, which makes doc.toString() throw and Save fail outright.
// ---------------------------------------------------------------------------

describe('deleteJob / removeWorkflowJobEntry refuse to strand a YAML alias', () => {
  function parseFull(): Document.Parsed {
    const { doc, error } = parseConfig(fullConfigFixture);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  it('refuses to delete a job that is a YAML anchor still aliased elsewhere, leaving the doc byte-for-byte unchanged and serializable', () => {
    const doc = parseFull();
    const before = doc.toString();

    expect(() => deleteJob(doc, 'deploy_prod')).toThrow(/deploy_prod_canary/);
    expect(() => doc.toString()).not.toThrow();
    expect(doc.toString()).toBe(before);
  });

  it('deleting the alias site itself (not the anchor) works normally', () => {
    const doc = parseFull();
    deleteJob(doc, 'deploy_prod_canary');

    expect(() => doc.toString()).not.toThrow();
    expect(getJobNames(doc)).not.toContain('deploy_prod_canary');
    expect(getJobNames(doc)).toContain('deploy_prod');
  });

  it('once the alias site is gone, the anchor source can be deleted too', () => {
    const doc = parseFull();
    deleteJob(doc, 'deploy_prod_canary');
    deleteJob(doc, 'deploy_prod');

    expect(() => doc.toString()).not.toThrow();
    expect(getJobNames(doc)).not.toContain('deploy_prod');
  });

  it('renameJob does not disturb an anchor -- an aliased job can still be renamed safely', () => {
    // renameJob only ever mutates a Pair's *key*, never the value node the
    // anchor lives on, so this must never hit the alias-stranding failure
    // mode at all. Asserted here as a regression guard, not because a fix
    // was needed.
    const doc = parseFull();
    const before = doc.toString();

    renameJob(doc, 'deploy_prod', 'deploy_prod_v2');

    expect(() => doc.toString()).not.toThrow();
    expect(getJobNames(doc)).toContain('deploy_prod_v2');
    expect(getJobNames(doc)).toContain('deploy_prod_canary');
    // The rename touched only the key; the alias site is untouched (it
    // still refers to the same anchored node, now reachable via the new key).
    expect(doc.toString()).not.toBe(before);
  });

  it('removeWorkflowJobEntry refuses to remove a workflow entry that is itself a YAML anchor still aliased by a sibling entry', () => {
    const { doc, error } = parseConfig(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
      - &deploy_anchor
        deploy:
          requires:
            - build
      - *deploy_anchor
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    const before = doc.toString();

    expect(() => removeWorkflowJobEntry(doc, 'main', 'deploy')).toThrow(
      /anchor/i,
    );
    expect(() => doc.toString()).not.toThrow();
    expect(doc.toString()).toBe(before);
  });

  it('deleteJob also refuses when one of the workflow entries it would remove is an aliased anchor', () => {
    const { doc, error } = parseConfig(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - build
      - &deploy_entry
        deploy:
          requires:
            - build
      - *deploy_entry
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    const before = doc.toString();

    expect(() => deleteJob(doc, 'deploy')).toThrow(/anchor/i);
    expect(() => doc.toString()).not.toThrow();
    expect(doc.toString()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Workflow entry options (issue #37)
// ---------------------------------------------------------------------------

describe('setWorkflowJobEntryOption', () => {
  it('adding context to a bare-string entry converts it to map form', () => {
    const doc = parse();
    setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'context', [
      'org-global',
    ]);

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toEqual({
      build: { context: ['org-global'] },
    });
  });

  it('removing the only option collapses the entry back to a bare string', () => {
    const doc = parse();
    setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'context', [
      'org-global',
    ]);
    setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'context', undefined);

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toBe('build');
  });

  it('removing one option leaves a sibling option (e.g. requires) untouched', () => {
    const doc = parse();
    setWorkflowJobEntryOption(doc, WORKFLOW, 'test-linux', 'context', [
      'org-global',
    ]);
    setWorkflowJobEntryOption(
      doc,
      WORKFLOW,
      'test-linux',
      'context',
      undefined,
    );

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'requires']),
    ).toEqual(['build']);
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'context']),
    ).toBeUndefined();
  });

  it('sets and clears filters', () => {
    const doc = parse();
    setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'filters', {
      branches: { only: ['main'] },
    });
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'filters']),
    ).toEqual({
      branches: { only: ['main'] },
    });

    setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'filters', undefined);
    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toBe('build');
  });

  it('an approval entry accepts context and filters the same way as a job entry', () => {
    const { doc, error } = parseConfig(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy
      - hold:
          type: approval
          requires:
            - deploy
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    setWorkflowJobEntryOption(doc, 'main', 'hold', 'context', ['org-global']);
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 1, 'hold', 'context']),
    ).toEqual(['org-global']);
  });

  it('an orb job entry accepts context and filters the same way', () => {
    const { doc, error } = parseConfig(`
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    setWorkflowJobEntryOption(doc, 'main', 'node/test', 'context', [
      'org-global',
    ]);
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'node/test', 'context']),
    ).toEqual(['org-global']);
  });

  it('rejects name/requires -- they have dedicated setters', () => {
    const doc = parse();
    expect(() =>
      setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'name', 'x'),
    ).toThrow(/dedicated setter/);
    expect(() =>
      setWorkflowJobEntryOption(doc, WORKFLOW, 'build', 'requires', ['x']),
    ).toThrow(/dedicated setter/);
  });

  it('throws for an unknown entry', () => {
    const doc = parse();
    expect(() =>
      setWorkflowJobEntryOption(doc, WORKFLOW, 'nope', 'context', ['x']),
    ).toThrow(/has no entry/);
  });
});

describe('setWorkflowJobEntryParameter', () => {
  it('sets an orb job invocation parameter on a bare-string entry, converting it to map form', () => {
    const { doc, error } = parseConfig(`
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    setWorkflowJobEntryParameter(
      doc,
      'main',
      'node/test',
      'run-command',
      'npm run ci',
    );

    expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toEqual({
      'node/test': { 'run-command': 'npm run ci' },
    });
  });

  it('clearing the only parameter collapses back to a bare string', () => {
    const { doc, error } = parseConfig(`
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    setWorkflowJobEntryParameter(
      doc,
      'main',
      'node/test',
      'run-command',
      'npm run ci',
    );
    setWorkflowJobEntryParameter(
      doc,
      'main',
      'node/test',
      'run-command',
      undefined,
    );

    expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toBe('node/test');
  });

  it('rejects a parameter named after a reserved workflow-entry key', () => {
    const doc = parse();
    expect(() =>
      setWorkflowJobEntryParameter(doc, WORKFLOW, 'build', 'context', ['x']),
    ).toThrow(/reserved/);
  });
});

describe('setWorkflowJobEntryAlias (issue #36)', () => {
  it('setting an alias on an entry that has none works', () => {
    const doc = parse();
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'build', 'build-1');

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toEqual({
      build: { name: 'build-1' },
    });
  });

  it('clearing an alias reverts the entry to a bare string when nothing else remains', () => {
    const doc = parse();
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'build', 'build-1');
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'build-1', undefined);

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toBe('build');
  });

  it("changing one aliased entry's alias does not rename the shared job definition, nor the other entry aliasing the same job", () => {
    const doc = parse();
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-linux', 'test-linux-v2');

    // The underlying job definition is untouched.
    expect(getJobNames(doc)).toContain('test');
    // The renamed entry still points at the same job, just under a new alias.
    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'name'])).toBe(
      'test-linux-v2',
    );
    // The *other* aliased entry of the same job is completely untouched.
    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 2, 'test', 'name'])).toBe(
      'test-macos',
    );
  });

  it("renaming an alias updates every other entry's requires: that referenced the old alias", () => {
    const doc = parse();
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-linux', 'test-linux-v2');

    // deploy required both test-linux and test-macos.
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 3, 'deploy', 'requires']),
    ).toEqual(['test-linux-v2', 'test-macos']);
  });

  it('rejects an alias that collides with another entry already in the workflow', () => {
    const doc = parse();
    expect(() =>
      setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-linux', 'test-macos'),
    ).toThrow(/already has an entry/);
  });

  it('rejects clearing an alias when doing so would collide with a sibling bare-job-name entry', () => {
    const doc = parse();
    // Alias "test" the same as the bare job name "test" itself would exist
    // if test-linux's alias were cleared while test-macos still exists --
    // not a collision here (there is no bare "test" entry), so exercise the
    // actual collision case: two entries that would both resolve to "test".
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-macos', undefined);
    expect(() =>
      setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-linux', undefined),
    ).toThrow(/already has an entry/);
  });

  it('is a no-op when the alias already matches the current id', () => {
    const doc = parse();
    const before = doc.toString();
    setWorkflowJobEntryAlias(doc, WORKFLOW, 'test-linux', 'test-linux');
    expect(doc.toString()).toBe(before);
  });

  it('throws for an unknown entry', () => {
    const doc = parse();
    expect(() => setWorkflowJobEntryAlias(doc, WORKFLOW, 'nope', 'x')).toThrow(
      /has no entry/,
    );
  });
});

// ---------------------------------------------------------------------------
// pre-steps / post-steps (issue #37)
// ---------------------------------------------------------------------------

describe('addWorkflowEntryStep / removeWorkflowEntryStep / moveWorkflowEntryStep', () => {
  it('adding a pre-step to a bare-string entry converts it to map form', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 'checkout');

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toEqual({
      build: { 'pre-steps': ['checkout'] },
    });
  });

  it('adds post-steps too, independently of pre-steps', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 'checkout');
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'post-steps', {
      run: 'echo done',
    });

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'pre-steps']),
    ).toEqual(['checkout']);
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'post-steps']),
    ).toEqual([{ run: 'echo done' }]);
  });

  it('inserts at an index, defaulting to append', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'a' });
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'c' });
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'b' }, 1);

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'pre-steps']),
    ).toEqual([{ run: 'a' }, { run: 'b' }, { run: 'c' }]);
  });

  it('removing the last step collapses back to a bare string', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 'checkout');
    removeWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 0);

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toBe('build');
  });

  it('removing one of several pre-steps leaves the rest, and other sibling options, untouched', () => {
    const doc = parse();
    // test-linux already has requires:.
    addWorkflowEntryStep(doc, WORKFLOW, 'test-linux', 'pre-steps', {
      run: 'a',
    });
    addWorkflowEntryStep(doc, WORKFLOW, 'test-linux', 'pre-steps', {
      run: 'b',
    });
    removeWorkflowEntryStep(doc, WORKFLOW, 'test-linux', 'pre-steps', 0);

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'pre-steps']),
    ).toEqual([{ run: 'b' }]);
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 1, 'test', 'requires']),
    ).toEqual(['build']);
  });

  it('reorders steps, carrying a step comment with it (mirrors moveStep)', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'a' });
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'b' });
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', { run: 'c' });
    moveWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 2, 0);

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'pre-steps']),
    ).toEqual([{ run: 'c' }, { run: 'a' }, { run: 'b' }]);
  });

  it('removeWorkflowEntryStep throws when the entry has no such list', () => {
    const doc = parse();
    expect(() =>
      removeWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 0),
    ).toThrow(/has no "pre-steps"/);
  });
});

describe('setWorkflowEntryStepField', () => {
  it('sets a nested parameter on an orb-command pre-step, rooted at the workflow entry', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', {
      'node/install-packages': { 'app-dir': 'web' },
    });
    setWorkflowEntryStepField(
      doc,
      WORKFLOW,
      'build',
      'pre-steps',
      [0, 'node/install-packages', 'app-dir'],
      'api',
    );

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'pre-steps', 0]),
    ).toEqual({
      'node/install-packages': { 'app-dir': 'api' },
    });
  });
});

// ---------------------------------------------------------------------------
// Individual step fields (issue #48)
// ---------------------------------------------------------------------------

describe('setStepField / setWorkflowEntryStepFieldValue (issue #48)', () => {
  function parseJob(stepsYaml: string): Document.Parsed {
    const { doc, error } = parseConfig(
      `jobs:\n  build:\n    docker:\n      - image: cimg/base:current\n    steps:\n${stepsYaml}\nworkflows:\n  main:\n    jobs:\n      - build\n`,
    );
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  describe('bare-string steps only become maps once a field is actually set', () => {
    it('leaves a bare "- checkout" untouched by describing it, and only promotes it to a map on the first field write', () => {
      const doc = parseJob('      - checkout\n');
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('checkout');

      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'checkout',
        'path',
        'src',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        checkout: { path: 'src' },
      });
    });

    it('setting a second field on an already-promoted step edits the same map, not a fresh one', () => {
      const doc = parseJob('      - checkout\n');
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'checkout',
        'path',
        'src',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'checkout',
        'method',
        'shallow',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        checkout: { path: 'src', method: 'shallow' },
      });
    });

    it('collapses back to the bare string once the last field is unset -- for every keyword with a payload-free shorthand', () => {
      expect([...BARE_STRING_STEP_KEYS].sort()).toEqual(
        ['add_ssh_keys', 'checkout', 'setup_remote_docker'].sort(),
      );
      const doc = parseJob('      - setup_remote_docker\n');
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'setup_remote_docker',
        'docker_layer_caching',
        true,
      );
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        setup_remote_docker: { docker_layer_caching: true },
      });

      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'setup_remote_docker',
        'docker_layer_caching',
        undefined,
      );
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe(
        'setup_remote_docker',
      );
    });

    it('never collapses run: {} back to a bare string, since command is still required', () => {
      const doc = parseJob('      - run:\n          command: make test\n');
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'run',
        'command',
        undefined,
        'command',
      );
      // The map survives (empty), not silently reverted to a bare "run"
      // step, which isn't even valid CircleCI syntax on its own.
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({ run: {} });
    });
  });

  /**
   * Issue #252: an orb command dropped into a job's steps had no parameter
   * editing at all, and the mutation layer is half of why -- the inspector's
   * only write path for a step's parameters was `setJobField`, which addresses
   * `[index, fullKey, param]` and therefore requires the step to already be a
   * map. A command inserted with no parameters is a bare string, so there was
   * nothing to address.
   *
   * `setStepField` already converted between the two shapes for `checkout` and
   * friends; these pin that it does the same for `<alias>/<command>`, which is
   * what lets the step editor treat both written forms as one thing.
   */
  describe('an orb-command step is editable in both of its written shapes (issue #252)', () => {
    it('promotes a bare "- act/install" to the mapping form on the first parameter write', () => {
      const doc = parseJob('      - act/install\n');
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('act/install');

      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'act/install',
        'version',
        '0.2.60',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        'act/install': { version: '0.2.60' },
      });
      expect(doc.toString()).toContain('- act/install:');
      expect(doc.toString()).toContain('version: 0.2.60');
    });

    it("carries the step's own comment across the promotion", () => {
      const doc = parseJob(
        '      - checkout\n      # install the runner first\n      - act/install\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 1],
        'act/install',
        'version',
        '0.2.60',
      );

      const text = doc.toString();
      expect(text).toContain('# install the runner first');
      // Still attached to the step it belonged to, not orphaned above it or
      // dragged inside the new map.
      expect(text.indexOf('# install the runner first')).toBeLessThan(
        text.indexOf('- act/install:'),
      );
    });

    it('adds a second parameter to the same mapping rather than a fresh one', () => {
      const doc = parseJob(
        '      - act/install:\n          version: "0.2.60"\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'act/install',
        'install-dir',
        '/usr/local/bin',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        'act/install': { version: '0.2.60', 'install-dir': '/usr/local/bin' },
      });
    });

    it('collapses back to the bare string once the last parameter is cleared', () => {
      const doc = parseJob(
        '      - act/install:\n          version: "0.2.60"\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'act/install',
        'version',
        undefined,
      );

      // `- act/install` and `- act/install: {}` invoke the same command the
      // same way, and the bare form is both idiomatic and exactly what
      // inserting the command with no parameters writes -- so clearing the last
      // one must not leave a shape nothing else in this codebase produces.
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('act/install');
      expect(doc.toString()).not.toContain('{}');
    });

    it('edits an orb command nested inside a when group', () => {
      const doc = parseJob(
        '      - when:\n          condition: << parameters.deploy >>\n          steps:\n            - act/install\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0, 'when', 'steps', 0],
        'act/install',
        'version',
        '0.2.60',
      );

      expect(
        getIn(doc, ['jobs', 'build', 'steps', 0, 'when', 'steps', 0]),
      ).toEqual({ 'act/install': { version: '0.2.60' } });
    });

    it('refuses to write to a step it was not told the key of', () => {
      const doc = parseJob('      - act/install\n');
      expect(() =>
        setStepField(
          doc,
          ['jobs', 'build', 'steps', 0],
          'act/uninstall',
          'version',
          '1',
        ),
      ).toThrow(/not a "act\/uninstall" step/);
      // Nothing partial written.
      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('act/install');
    });
  });

  describe("run's scalar shorthand is preserved as `command` when promoted to map form", () => {
    it('setting `name` on a shorthand run step keeps the shorthand string as `command`', () => {
      const doc = parseJob('      - run: make build\n');
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'run',
        'name',
        'Build',
        'command',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        run: { command: 'make build', name: 'Build' },
      });
    });

    it('editing an already-map-form run step touches only the field written', () => {
      const doc = parseJob(
        '      - run:\n          name: Build\n          command: make build\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'run',
        'command',
        'make build --verbose',
        'command',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        run: { name: 'Build', command: 'make build --verbose' },
      });
    });
  });

  describe('array and map fields', () => {
    it('sets save_cache.paths as a whole array', () => {
      const doc = parseJob('      - save_cache:\n          key: v1-deps\n');
      setStepField(doc, ['jobs', 'build', 'steps', 0], 'save_cache', 'paths', [
        'node_modules',
        '.cache',
      ]);

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        save_cache: { key: 'v1-deps', paths: ['node_modules', '.cache'] },
      });
    });

    it('sets run.environment as a whole map', () => {
      const doc = parseJob('      - run: make build\n');
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0],
        'run',
        'environment',
        { NODE_ENV: 'test' },
        'command',
      );

      expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toEqual({
        run: { command: 'make build', environment: { NODE_ENV: 'test' } },
      });
    });
  });

  describe('a step nested inside a when/unless group', () => {
    it('edits the nested step in place via a stepPath that walks through the group', () => {
      const doc = parseJob(
        '      - when:\n          condition: true\n          steps:\n            - checkout\n            - run: echo hi\n',
      );
      setStepField(
        doc,
        ['jobs', 'build', 'steps', 0, 'when', 'steps', 1],
        'run',
        'name',
        'Greet',
        'command',
      );

      expect(
        getIn(doc, ['jobs', 'build', 'steps', 0, 'when', 'steps', 1]),
      ).toEqual({
        run: { command: 'echo hi', name: 'Greet' },
      });
      // The sibling nested step is untouched.
      expect(
        getIn(doc, ['jobs', 'build', 'steps', 0, 'when', 'steps', 0]),
      ).toBe('checkout');
    });
  });

  describe('errors', () => {
    it('throws for an out-of-range index', () => {
      const doc = parseJob('      - checkout\n');
      expect(() =>
        setStepField(
          doc,
          ['jobs', 'build', 'steps', 5],
          'checkout',
          'path',
          'x',
        ),
      ).toThrow(/no step/i);
    });

    it("throws when stepKey doesn't match the step actually at that index", () => {
      const doc = parseJob('      - checkout\n');
      expect(() =>
        setStepField(doc, ['jobs', 'build', 'steps', 0], 'run', 'command', 'x'),
      ).toThrow(/not a "run" step/);
    });
  });

  it('is a minimal-diff, comment-preserving edit -- editing one field changes only that region', () => {
    const before = `jobs:
  build:
    docker:
      - image: cimg/base:current # pinned base image
    steps:
      # Checks out the repo before anything else.
      - checkout
      - run:
          name: Build
          command: make build # keep in sync with the Makefile
      - save_cache:
          key: v1-{{ checksum "go.sum" }}
          paths:
            - vendor
      # Ship it.
      - run: make deploy
workflows:
  main:
    jobs:
      - build
`;
    const { doc, error } = parseConfig(before);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    setStepField(
      doc,
      ['jobs', 'build', 'steps', 1],
      'run',
      'command',
      'make build --verbose',
      'command',
    );
    const after = doc.toString();

    const diff = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // Exactly the one `command:` line changed; nothing else moved.
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    expect(after).toContain(
      'command: make build --verbose # keep in sync with the Makefile',
    );
    // Every comment elsewhere in the file survives untouched.
    expect(after).toContain('# pinned base image');
    expect(after).toContain('# Checks out the repo before anything else.');
    expect(after).toContain('# Ship it.');
  });

  it('survives editing as a block scalar (issue #86): `command: |` keeps its block style, and only its own content lines change', () => {
    // `run.command` is usually written as a block literal (`|`), not a
    // plain scalar -- and its content commonly contains YAML-significant
    // characters (here, a colon inside the echoed string) that would force
    // quoting/escaping if this ever collapsed to a flow scalar. This is the
    // shape `Inspector.tsx`'s `CommandField` (issue #86 part 2's shell
    // editor) actually edits, via this same `setStepField` call.
    const before = `jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      # Runs the full suite across every package.
      - run:
          name: Test
          command: |
            go test ./... -v
            echo done
      # Ship it.
      - run: make deploy
workflows:
  main:
    jobs:
      - build
`;
    const { doc, error } = parseConfig(before);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    // Trailing `\n` matches the original value's own chomping (a plain `|`
    // reads with one trailing newline) purely to keep this scoped to *only*
    // the block's content lines -- see the next test for the (still
    // correct, just not minimal-diff) case where a caller's value doesn't
    // end in a newline, e.g. CodeMirror's own value never has one.
    setStepField(
      doc,
      ['jobs', 'build', 'steps', 0],
      'run',
      'command',
      'go test ./... -v -count=1\necho "done: $?"\n',
      'command',
    );
    const after = doc.toString();

    // Still a block literal, not collapsed to a quoted single-line scalar
    // just because the new value contains a colon.
    expect(after).toContain('command: |\n');
    expect(after).toContain('go test ./... -v -count=1');
    expect(after).toContain('echo "done: $?"');

    const diff = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // Only the block's own two content lines changed.
    expect(additions).toBe(2);
    expect(deletions).toBe(2);
    // Everything around the block -- both comments, the job's other step,
    // and the workflow -- is untouched.
    expect(after).toContain('# Runs the full suite across every package.');
    expect(after).toContain('# Ship it.');
    expect(after).toContain('- run: make deploy');
    expect(after).toContain('- image: cimg/base:current');
  });

  it("keeps the block-literal style even when the new value has no trailing newline (CodeMirror's own draft strings never do)", () => {
    const before = `jobs:
  build:
    steps:
      - run:
          command: |
            echo one
`;
    const { doc, error } = parseConfig(before);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    // No trailing "\n" -- exactly what `Inspector.tsx`'s `CommandField`
    // hands `onCommit` (CodeMirror's `value` never carries one).
    setStepField(
      doc,
      ['jobs', 'build', 'steps', 0],
      'run',
      'command',
      'echo one\necho two: three',
      'command',
    );
    const after = doc.toString();

    // The chomping indicator adapts (`|` -> `|-`, since the value no
    // longer ends in a newline), but it's still a block literal -- never a
    // quoted flow scalar, which the embedded colon in "two: three" would
    // otherwise force.
    expect(after).toMatch(/command: \|-\n/);
    expect(after).toContain('echo one\n            echo two: three');
  });
});

describe('setWorkflowEntryStepFieldValue (issue #48)', () => {
  it('promotes a bare pre-step and edits it, rooted at the workflow entry rather than a job body', () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'pre-steps', 'checkout');

    setWorkflowEntryStepFieldValue(
      doc,
      WORKFLOW,
      'build',
      'pre-steps',
      [0],
      'checkout',
      'path',
      'src',
    );

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'pre-steps', 0]),
    ).toEqual({
      checkout: { path: 'src' },
    });
  });

  it("preserves a run pre-step's shorthand command when promoting it to add `name`", () => {
    const doc = parse();
    addWorkflowEntryStep(doc, WORKFLOW, 'build', 'post-steps', {
      run: 'notify-slack',
    });

    setWorkflowEntryStepFieldValue(
      doc,
      WORKFLOW,
      'build',
      'post-steps',
      [0],
      'run',
      'name',
      'Notify',
      'command',
    );

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'post-steps', 0]),
    ).toEqual({
      run: { command: 'notify-slack', name: 'Notify' },
    });
  });
});

// ---------------------------------------------------------------------------
// Executor field setters (issue #27)
// ---------------------------------------------------------------------------

describe('setExecutorField / unsetJobField', () => {
  function parseExecutors(): Document.Parsed {
    const { doc, error } = parseConfig(`
executors:
  py-executor:
    docker:
      - image: cimg/python:3.11.13
    resource_class: large
jobs:
  lint:
    executor: py-executor
    steps: [checkout]
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  it('setExecutorField edits the named executor, affecting every job that references it', () => {
    const doc = parseExecutors();
    setExecutorField(doc, 'py-executor', ['resource_class'], 'xlarge');
    expect(getIn(doc, ['executors', 'py-executor', 'resource_class'])).toBe(
      'xlarge',
    );
  });

  it('setExecutorField throws for an unknown executor', () => {
    const doc = parseExecutors();
    expect(() =>
      setExecutorField(doc, 'nope', ['resource_class'], 'xlarge'),
    ).toThrow(/does not exist/);
  });

  it("unsetJobField removes a job-level override, reverting to the executor's own value", () => {
    const doc = parseExecutors();
    setJobField(doc, 'lint', ['resource_class'], 'medium');
    expect(getIn(doc, ['jobs', 'lint', 'resource_class'])).toBe('medium');

    unsetJobField(doc, 'lint', ['resource_class']);
    expect(getIn(doc, ['jobs', 'lint', 'resource_class'])).toBeUndefined();
    // The executor's own value is untouched and now applies again.
    expect(getIn(doc, ['executors', 'py-executor', 'resource_class'])).toBe(
      'large',
    );
  });
});

// ---------------------------------------------------------------------------
// workflow-level fields (issue #288)
// ---------------------------------------------------------------------------

describe('setWorkflowField / unsetWorkflowField', () => {
  it('sets when: as a plain string, creating no other containers', () => {
    const doc = parse();
    setWorkflowField(
      doc,
      WORKFLOW,
      ['when'],
      '<< pipeline.parameters.deploy >>',
    );
    expect(getIn(doc, ['workflows', WORKFLOW, 'when'])).toBe(
      '<< pipeline.parameters.deploy >>',
    );
  });

  it('sets when: as a structured logic map without disturbing unless:', () => {
    const doc = parse();
    setWorkflowField(doc, WORKFLOW, ['when'], {
      and: ['<< pipeline.parameters.a >>', '<< pipeline.parameters.b >>'],
    });
    expect(getIn(doc, ['workflows', WORKFLOW, 'when'])).toEqual({
      and: ['<< pipeline.parameters.a >>', '<< pipeline.parameters.b >>'],
    });
  });

  it('sets max_auto_reruns as a number', () => {
    const doc = parse();
    setWorkflowField(doc, WORKFLOW, ['max_auto_reruns'], 3);
    expect(getIn(doc, ['workflows', WORKFLOW, 'max_auto_reruns'])).toBe(3);
  });

  it('unsetWorkflowField removes the field entirely', () => {
    const doc = parse();
    setWorkflowField(doc, WORKFLOW, ['when'], 'true');
    unsetWorkflowField(doc, WORKFLOW, ['when']);
    expect(getIn(doc, ['workflows', WORKFLOW, 'when'])).toBeUndefined();
  });

  it('setWorkflowField throws for an unknown workflow', () => {
    const doc = parse();
    expect(() => setWorkflowField(doc, 'nope', ['when'], 'true')).toThrow(
      /does not exist/,
    );
  });

  it('unsetWorkflowField throws for an unknown workflow', () => {
    const doc = parse();
    expect(() => unsetWorkflowField(doc, 'nope', ['when'])).toThrow(
      /does not exist/,
    );
  });

  it('edits one trigger schedule field by index without disturbing others', () => {
    const doc = parse();
    addWorkflowTrigger(doc, WORKFLOW);
    addWorkflowTrigger(doc, WORKFLOW);
    setWorkflowField(
      doc,
      WORKFLOW,
      ['triggers', 1, 'schedule', 'cron'],
      '0 12 * * 1-5',
    );
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'triggers', 0, 'schedule', 'cron']),
    ).toBe('0 0 * * *');
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'triggers', 1, 'schedule', 'cron']),
    ).toBe('0 12 * * 1-5');
  });
});

describe('addWorkflowTrigger / removeWorkflowTrigger', () => {
  it('appends a syntactically valid schedule trigger, creating triggers: if absent', () => {
    const doc = parse();
    expect(getIn(doc, ['workflows', WORKFLOW, 'triggers'])).toBeUndefined();
    addWorkflowTrigger(doc, WORKFLOW);
    expect(getIn(doc, ['workflows', WORKFLOW, 'triggers'])).toEqual([
      { schedule: { cron: '0 0 * * *' } },
    ]);
  });

  it('appends without disturbing an existing trigger', () => {
    const doc = parse();
    addWorkflowTrigger(doc, WORKFLOW);
    setWorkflowField(
      doc,
      WORKFLOW,
      ['triggers', 0, 'schedule', 'cron'],
      '0 9 * * *',
    );
    addWorkflowTrigger(doc, WORKFLOW);
    expect(getIn(doc, ['workflows', WORKFLOW, 'triggers'])).toEqual([
      { schedule: { cron: '0 9 * * *' } },
      { schedule: { cron: '0 0 * * *' } },
    ]);
  });

  it('removeWorkflowTrigger removes by index', () => {
    const doc = parse();
    addWorkflowTrigger(doc, WORKFLOW);
    addWorkflowTrigger(doc, WORKFLOW);
    removeWorkflowTrigger(doc, WORKFLOW, 0);
    expect(getIn(doc, ['workflows', WORKFLOW, 'triggers'])).toHaveLength(1);
  });

  it('addWorkflowTrigger throws for an unknown workflow', () => {
    const doc = parse();
    expect(() => addWorkflowTrigger(doc, 'nope')).toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
// insertOrbJob carrying alias/context/filters/pre-steps/post-steps (issue #37)
// ---------------------------------------------------------------------------

describe('insertOrbJob with workflow-entry options', () => {
  it('sets an alias, context, filters, pre-steps, and post-steps at insertion time', () => {
    const doc = parse();
    insertOrbJob(doc, {
      workflowName: WORKFLOW,
      orbRef: 'circleci/node@5.2.0',
      jobName: 'test',
      alias: 'node-test',
      context: ['org-global'],
      filters: { branches: { only: ['main'] } },
      preSteps: ['checkout'],
      postSteps: [{ run: 'echo done' }],
    });

    const entries = getWorkflowJobEntries(doc, WORKFLOW);
    const inserted = entries.find((e) => e.jobName === 'node/test');
    expect(inserted).toBeDefined();
    const index = inserted!.index;

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', index, 'node/test', 'name']),
    ).toBe('node-test');
    expect(
      getIn(doc, [
        'workflows',
        WORKFLOW,
        'jobs',
        index,
        'node/test',
        'context',
      ]),
    ).toEqual(['org-global']);
    expect(
      getIn(doc, [
        'workflows',
        WORKFLOW,
        'jobs',
        index,
        'node/test',
        'filters',
      ]),
    ).toEqual({
      branches: { only: ['main'] },
    });
    expect(
      getIn(doc, [
        'workflows',
        WORKFLOW,
        'jobs',
        index,
        'node/test',
        'pre-steps',
      ]),
    ).toEqual(['checkout']);
    expect(
      getIn(doc, [
        'workflows',
        WORKFLOW,
        'jobs',
        index,
        'node/test',
        'post-steps',
      ]),
    ).toEqual([{ run: 'echo done' }]);
  });

  it('omitting all the new options behaves exactly as before (no regression)', () => {
    const doc = parse();
    insertOrbJob(doc, {
      workflowName: WORKFLOW,
      orbRef: 'circleci/node@5.2.0',
      jobName: 'test',
    });
    const jobs = getIn(doc, ['workflows', WORKFLOW, 'jobs']) as unknown[];
    expect(jobs[jobs.length - 1]).toBe('node/test');
  });
});

// ---------------------------------------------------------------------------
// addJobFromExecutor / setJobExecutorSpec (issue #71)
// ---------------------------------------------------------------------------

describe('addJobFromExecutor', () => {
  it('creates a docker job with the given image/resource_class and appends it to the workflow, in one call', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: 'cimg/node:20.0',
        resourceClass: 'large',
      },
    });

    expect(getIn(doc, ['jobs', 'lint'])).toEqual({
      docker: [{ image: 'cimg/node:20.0' }],
      resource_class: 'large',
      steps: ['checkout'],
    });
    expect(
      getWorkflowJobEntries(doc, WORKFLOW).map((e) => e.jobName),
    ).toContain('lint');
  });

  it('writes `auth: {username, password}` for a `basic` dockerAuth spec (issue #77)', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: 'acme/private-image:1.2.3',
        dockerAuth: {
          kind: 'basic',
          username: 'myuser',
          password: '$DOCKERHUB_PASSWORD',
        },
      },
    });

    expect(getIn(doc, ['jobs', 'lint', 'docker'])).toEqual([
      {
        image: 'acme/private-image:1.2.3',
        auth: { username: 'myuser', password: '$DOCKERHUB_PASSWORD' },
      },
    ]);
  });

  it('writes `aws_auth: {aws_access_key_id, aws_secret_access_key}` for an `awsKeys` dockerAuth spec', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: '123456789.dkr.ecr.us-east-1.amazonaws.com/acme/repo:1.0',
        dockerAuth: {
          kind: 'awsKeys',
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: '$ECR_AWS_SECRET_ACCESS_KEY',
        },
      },
    });

    expect(getIn(doc, ['jobs', 'lint', 'docker', 0, 'aws_auth'])).toEqual({
      aws_access_key_id: 'AKIAEXAMPLE',
      aws_secret_access_key: '$ECR_AWS_SECRET_ACCESS_KEY',
    });
  });

  it('writes `aws_auth: {oidc_role_arn}` for an `awsOidc` dockerAuth spec', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: '123456789.dkr.ecr.us-east-1.amazonaws.com/acme/repo:1.0',
        dockerAuth: {
          kind: 'awsOidc',
          roleArn: 'arn:aws:iam::123456789012:role/ecr-pull',
        },
      },
    });

    expect(getIn(doc, ['jobs', 'lint', 'docker', 0, 'aws_auth'])).toEqual({
      oidc_role_arn: 'arn:aws:iam::123456789012:role/ecr-pull',
    });
  });

  it('writes no auth block at all for `{ kind: "none" }` or an omitted dockerAuth', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: 'cimg/base:current',
        dockerAuth: { kind: 'none' },
      },
    });

    expect(getIn(doc, ['jobs', 'lint', 'docker'])).toEqual([
      { image: 'cimg/base:current' },
    ]);
  });

  it("creates a machine job (covers the palette's Windows/GPU cards, which are `machine` under the hood)", () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'win-build',
      workflowName: WORKFLOW,
      executor: {
        kind: 'machine',
        image: 'windows-server-2022-gui:current',
        resourceClass: 'windows.medium',
      },
    });

    expect(getIn(doc, ['jobs', 'win-build', 'machine'])).toEqual({
      image: 'windows-server-2022-gui:current',
    });
    expect(getIn(doc, ['jobs', 'win-build', 'resource_class'])).toBe(
      'windows.medium',
    );
  });

  it('creates a macos job', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'ios-build',
      workflowName: WORKFLOW,
      executor: { kind: 'macos', image: '15.3.0' },
    });
    expect(getIn(doc, ['jobs', 'ios-build', 'macos'])).toEqual({
      xcode: '15.3.0',
    });
  });

  it('references an existing named executor via `executor:` for a `local` spec, writing no image/resource_class', () => {
    const { doc, error } = parseConfig(`
executors:
  py-executor:
    docker:
      - image: cimg/python:3.11.13
workflows:
  main:
    jobs: []
`);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);

    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: 'main',
      executor: { kind: 'local', executorName: 'py-executor' },
    });

    expect(getIn(doc, ['jobs', 'lint', 'executor'])).toBe('py-executor');
    expect(getIn(doc, ['jobs', 'lint', 'docker'])).toBeUndefined();
  });

  it('throws for a `local` spec naming an executor that does not exist, leaving the document untouched', () => {
    const doc = parse();
    const before = doc.toString();
    expect(() =>
      addJobFromExecutor(doc, {
        name: 'lint',
        workflowName: WORKFLOW,
        executor: { kind: 'local', executorName: 'nope' },
      }),
    ).toThrow(/does not exist/);
    expect(doc.toString()).toBe(before);
  });

  it('imports the orb and references its executor for an `orb` spec', () => {
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'py-lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'orb',
        orbRef: 'circleci/python@3.2.0',
        executorName: 'default',
      },
    });

    expect(getIn(doc, ['orbs', 'python'])).toBe('circleci/python@3.2.0');
    expect(getIn(doc, ['jobs', 'py-lint', 'executor'])).toBe('python/default');
  });

  it("auto-creates the workflow (mirrors addJob's own ensureSeq behavior) when it does not exist yet", () => {
    const { doc, error } = parseConfig('version: 2.1\n');
    if (!doc) throw new Error(`parse failed: ${error}`);

    addJobFromExecutor(doc, {
      name: 'build',
      workflowName: 'main',
      executor: { kind: 'docker' },
    });

    expect(getIn(doc, ['jobs', 'build', 'docker', 0, 'image'])).toBe(
      'cimg/base:current',
    );
    expect(getIn(doc, ['workflows', 'main', 'jobs'])).toEqual(['build']);
  });

  it('rejects a duplicate job name', () => {
    const doc = parse();
    expect(() =>
      addJobFromExecutor(doc, {
        name: 'build',
        workflowName: WORKFLOW,
        executor: { kind: 'docker' },
      }),
    ).toThrow(/already exists/);
  });

  describe('saveAsExecutor (the "reusable executor" checkbox)', () => {
    it('writes the executor fields to executors.<name> and points the job at it via executor:, instead of inlining them', () => {
      const doc = parse();
      addJobFromExecutor(doc, {
        name: 'lint',
        workflowName: WORKFLOW,
        executor: {
          kind: 'docker',
          image: 'cimg/node:20.0',
          resourceClass: 'large',
        },
        saveAsExecutor: { name: 'node-lint-executor' },
      });

      expect(getIn(doc, ['executors', 'node-lint-executor'])).toEqual({
        docker: [{ image: 'cimg/node:20.0' }],
        resource_class: 'large',
      });
      expect(getIn(doc, ['jobs', 'lint', 'executor'])).toBe(
        'node-lint-executor',
      );
      expect(getIn(doc, ['jobs', 'lint', 'docker'])).toBeUndefined();
    });

    it('rejects a saveAsExecutor name that already exists, leaving the document untouched', () => {
      const doc = parse();
      addJobFromExecutor(doc, {
        name: 'lint',
        workflowName: WORKFLOW,
        executor: { kind: 'docker' },
        saveAsExecutor: { name: 'existing-executor' },
      });
      const before = doc.toString();

      expect(() =>
        addJobFromExecutor(doc, {
          name: 'lint2',
          workflowName: WORKFLOW,
          executor: { kind: 'docker' },
          saveAsExecutor: { name: 'existing-executor' },
        }),
      ).toThrow(/already exists/);
      expect(doc.toString()).toBe(before);
    });

    it('rejects saveAsExecutor combined with a local/orb spec', () => {
      const doc = parse();
      expect(() =>
        addJobFromExecutor(doc, {
          name: 'lint',
          workflowName: WORKFLOW,
          executor: {
            kind: 'orb',
            orbRef: 'circleci/python@3.2.0',
            executorName: 'default',
          },
          saveAsExecutor: { name: 'x' },
        }),
      ).toThrow(/only applies to an inline/);
    });
  });

  it('preserves every comment in the fixture and touches only the new job/executors/workflow region', () => {
    const before = MUTATION_FIXTURE;
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: { kind: 'docker', image: 'cimg/node:20.0' },
    });
    const after = doc.toString();

    const commentsBefore = before.match(/#.*/g) ?? [];
    const commentsAfter = after.match(/#.*/g) ?? [];
    expect(commentsAfter).toEqual(commentsBefore);

    // Nothing above the pre-existing `deploy` job's own body changed --
    // the new job is appended after it, and the workflow's jobs list only
    // grew by one line.
    const deployIndex = before.indexOf('  deploy:');
    expect(after.slice(0, deployIndex)).toBe(before.slice(0, deployIndex));
  });

  it('preserves every comment when the new job also carries a dockerAuth block', () => {
    const before = MUTATION_FIXTURE;
    const doc = parse();
    addJobFromExecutor(doc, {
      name: 'lint',
      workflowName: WORKFLOW,
      executor: {
        kind: 'docker',
        image: 'acme/private-image:1.2.3',
        dockerAuth: {
          kind: 'basic',
          username: 'myuser',
          password: '$DOCKERHUB_PASSWORD',
        },
      },
    });
    const after = doc.toString();

    const commentsBefore = before.match(/#.*/g) ?? [];
    const commentsAfter = after.match(/#.*/g) ?? [];
    expect(commentsAfter).toEqual(commentsBefore);

    const deployIndex = before.indexOf('  deploy:');
    expect(after.slice(0, deployIndex)).toBe(before.slice(0, deployIndex));
  });
});

describe('setJobExecutorSpec', () => {
  it("retrofits an existing job's executor, clearing whichever docker/machine/macos/executor fields it previously had", () => {
    const doc = parse();
    // The fixture's `build` job starts as a plain docker job.
    setJobExecutorSpec(doc, 'build', {
      kind: 'machine',
      image: 'ubuntu-2204:current',
    });

    expect(getIn(doc, ['jobs', 'build', 'docker'])).toBeUndefined();
    expect(getIn(doc, ['jobs', 'build', 'machine'])).toEqual({
      image: 'ubuntu-2204:current',
    });
  });

  it('throws for an unknown job', () => {
    const doc = parse();
    expect(() => setJobExecutorSpec(doc, 'nope', { kind: 'docker' })).toThrow(
      /does not exist/,
    );
  });
});

describe('extractSharedExecutor (issue #79)', () => {
  // MUTATION_FIXTURE's build/test/deploy all carry the exact same inline
  // `docker: [{ image: cimg/base:2024.01 }]` with no resource_class --
  // exactly the shape `findDuplicateExecutors` groups.
  it('moves the source job’s executor fields to a new executors: entry and points every job at it', () => {
    const doc = parse();
    extractSharedExecutor(doc, ['build', 'test', 'deploy'], 'base-executor');

    expect(getIn(doc, ['executors', 'base-executor', 'docker'])).toEqual([
      { image: 'cimg/base:2024.01' },
    ]);
    for (const job of ['build', 'test', 'deploy']) {
      expect(getIn(doc, ['jobs', job, 'docker'])).toBeUndefined();
      expect(getIn(doc, ['jobs', job, 'executor'])).toBe('base-executor');
    }
    // Steps are a completely separate concern -- untouched by this mutation.
    expect(getIn(doc, ['jobs', 'test', 'steps'])).toEqual([
      'checkout',
      { run: 'make test' },
      { run: 'make clean' },
    ]);
  });

  it('preserves every comment in the fixture -- including the one attached to a step this mutation never touches', () => {
    const before = MUTATION_FIXTURE;
    const doc = parse();
    extractSharedExecutor(doc, ['build', 'test', 'deploy'], 'base-executor');
    const after = doc.toString();

    const commentsBefore = before.match(/#.*/g) ?? [];
    const commentsAfter = after.match(/#.*/g) ?? [];
    expect(commentsAfter).toEqual(commentsBefore);
    expect(after).toContain('# cleanup after tests');
    expect(after).toContain('# Deploy jobs');
  });

  it('moves a comment that lives inside the moved docker: node itself', () => {
    const { doc } = parseConfig(`jobs:
  build:
    docker:
      # pinned -- see RFC 12
      - image: cimg/base:2024.01
    steps:
      - checkout
  test:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
`);
    if (!doc) throw new Error('fixture failed to parse');
    extractSharedExecutor(doc, ['build', 'test'], 'shared');
    const after = doc.toString();
    expect(after).toContain('# pinned -- see RFC 12');
    expect(after).toMatch(
      /executors:\s*\n\s*shared:\s*\n\s*docker:\s*\n\s*# pinned -- see RFC 12/,
    );
  });

  it('rejects fewer than two jobs, leaving the document untouched', () => {
    const before = MUTATION_FIXTURE;
    const doc = parse();
    expect(() => extractSharedExecutor(doc, ['build'], 'x')).toThrow(
      /at least two jobs/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('rejects an executor name that already exists', () => {
    const doc = parse();
    setIn(
      doc,
      ['executors', 'base-executor', 'docker', 0, 'image'],
      'cimg/base:2024.01',
    );
    const before = doc.toString();
    expect(() =>
      extractSharedExecutor(doc, ['build', 'test'], 'base-executor'),
    ).toThrow(/already exists/);
    expect(doc.toString()).toBe(before);
  });

  it('refuses an unknown job, leaving the document untouched', () => {
    const before = MUTATION_FIXTURE;
    const doc = parse();
    expect(() => extractSharedExecutor(doc, ['build', 'nope'], 'x')).toThrow(
      /does not exist/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('re-verifies the jobs still match and refuses if one has since diverged', () => {
    const doc = parse();
    // Give `test` its own resource_class after the fact -- it and `build`
    // no longer have byte-for-byte identical executors.
    setJobField(doc, 'test', ['resource_class'], 'large');
    const before = doc.toString();
    expect(() => extractSharedExecutor(doc, ['build', 'test'], 'x')).toThrow(
      /no longer have identical/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('refuses a job with no inline executor at all (e.g. already on a named executor)', () => {
    const doc = parse();
    // Give `build` an `executor:` reference and drop its inline `docker:` --
    // `resolveJobExecutor` then reports its source as 'none'/'executor', not
    // 'job', so it is no longer a candidate to be *merged into* one.
    unsetJobField(doc, 'build', ['docker']);
    setJobField(doc, 'build', ['executor'], 'some-other-executor');
    const before = doc.toString();
    expect(() => extractSharedExecutor(doc, ['build', 'test'], 'x')).toThrow(
      /no longer have identical/,
    );
    expect(doc.toString()).toBe(before);
  });
});

describe('extractSharedCommand (issue #79)', () => {
  const STEPS_FIXTURE = `jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: npm ci
      # keep this in sync with test's own copy
      - run: npm run build
  test:
    docker:
      - image: cimg/python:3.12
    steps:
      - checkout
      - run: npm ci
      # keep this in sync with test's own copy
      - run: npm run build
  deploy:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: make deploy
`;

  function parseSteps(): Document.Parsed {
    const { doc, error } = parseConfig(STEPS_FIXTURE);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  it("moves the source job's steps to a new commands: entry and replaces every job's steps with a single reference", () => {
    const doc = parseSteps();
    extractSharedCommand(doc, ['build', 'test'], 'ci-setup');

    expect(getIn(doc, ['commands', 'ci-setup', 'steps'])).toEqual([
      'checkout',
      { run: 'npm ci' },
      { run: 'npm run build' },
    ]);
    expect(getIn(doc, ['jobs', 'build', 'steps'])).toEqual(['ci-setup']);
    expect(getIn(doc, ['jobs', 'test', 'steps'])).toEqual(['ci-setup']);
    // Unrelated job untouched.
    expect(getIn(doc, ['jobs', 'deploy', 'steps'])).toEqual([
      'checkout',
      { run: 'make deploy' },
    ]);
    // Each job's own executor is untouched -- extracting steps is a
    // completely separate concern from extracting an executor.
    expect(getIn(doc, ['jobs', 'test', 'docker'])).toEqual([
      { image: 'cimg/python:3.12' },
    ]);
  });

  it('preserves the step-level comment inside the moved steps, and drops nothing outside it', () => {
    const before = STEPS_FIXTURE;
    const doc = parseSteps();
    extractSharedCommand(doc, ['build', 'test'], 'ci-setup');
    const after = doc.toString();

    const commentsBefore = before.match(/#.*/g) ?? [];
    const commentsAfter = after.match(/#.*/g) ?? [];
    // The comment appears twice in the source (once per job's identical
    // steps list) but only once in the new shared command -- exactly one
    // copy is expected to disappear, since only one job's copy survives the
    // move and the other's is deleted outright along with its own steps:.
    expect(commentsAfter.length).toBe(commentsBefore.length - 1);
    expect(after).toContain("# keep this in sync with test's own copy");
  });

  it('rejects fewer than two jobs, leaving the document untouched', () => {
    const before = STEPS_FIXTURE;
    const doc = parseSteps();
    expect(() => extractSharedCommand(doc, ['build'], 'x')).toThrow(
      /at least two jobs/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('rejects a command name that already exists', () => {
    const doc = parseSteps();
    setIn(doc, ['commands', 'ci-setup', 'steps', 0], 'checkout');
    expect(() =>
      extractSharedCommand(doc, ['build', 'test'], 'ci-setup'),
    ).toThrow(/already exists/);
  });

  it('refuses an unknown job, leaving the document untouched', () => {
    const before = STEPS_FIXTURE;
    const doc = parseSteps();
    expect(() => extractSharedCommand(doc, ['build', 'nope'], 'x')).toThrow(
      /does not exist/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('re-verifies the jobs still match and refuses if one has since diverged', () => {
    const doc = parseSteps();
    addStep(doc, 'test', { run: 'echo extra' });
    const before = doc.toString();
    expect(() => extractSharedCommand(doc, ['build', 'test'], 'x')).toThrow(
      /no longer have identical/,
    );
    expect(doc.toString()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Dragging a context onto a workflow job entry (issue #105)
// ---------------------------------------------------------------------------

describe('addWorkflowJobEntryContext', () => {
  it('promotes a bare-string entry to map form with a one-item list', () => {
    const doc = parse();
    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'deploy-prod');

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toEqual({
      build: { context: ['deploy-prod'] },
    });
  });

  it('adds the key to a map entry that has other options, leaving them alone', () => {
    const doc = parse();
    addWorkflowJobEntryContext(doc, WORKFLOW, 'test-linux', 'deploy-prod');

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 1])).toEqual({
      test: {
        name: 'test-linux',
        requires: ['build'],
        context: ['deploy-prod'],
      },
    });
  });

  it('appends to an existing list rather than replacing it', () => {
    const doc = parse();
    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'first');
    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'second');

    expect(getIn(doc, ['workflows', WORKFLOW, 'jobs', 0])).toEqual({
      build: { context: ['first', 'second'] },
    });
  });

  it('is a no-op when the context is already listed', () => {
    const doc = parse();
    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'org-global');
    const after = doc.toString();

    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'org-global');
    expect(doc.toString()).toBe(after);
  });

  // The shorthand-scalar case. `context: org-global` is valid CircleCI, and
  // the naive "replace the value with a fresh seq" approach silently drops
  // the context that was already there.
  it('widens a shorthand scalar into a list, keeping the original value', () => {
    const doc = parse();
    setIn(doc, ['workflows', WORKFLOW, 'jobs', 0], { build: null });
    setIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build'], {
      context: 'org-global',
    });

    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'deploy-prod');

    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build', 'context']),
    ).toEqual(['org-global', 'deploy-prod']);
  });

  it('is a no-op when a shorthand scalar already names the context', () => {
    const doc = parse();
    setIn(doc, ['workflows', WORKFLOW, 'jobs', 0], { build: null });
    setIn(doc, ['workflows', WORKFLOW, 'jobs', 0, 'build'], {
      context: 'org-global',
    });
    const before = doc.toString();

    addWorkflowJobEntryContext(doc, WORKFLOW, 'build', 'org-global');
    expect(doc.toString()).toBe(before);
  });

  it('refuses an empty context name, leaving the document untouched', () => {
    const doc = parse();
    const before = doc.toString();
    expect(() =>
      addWorkflowJobEntryContext(doc, WORKFLOW, 'build', '  '),
    ).toThrow(/context name is required/);
    expect(doc.toString()).toBe(before);
  });

  it('refuses an unknown workflow entry', () => {
    const doc = parse();
    expect(() =>
      addWorkflowJobEntryContext(doc, WORKFLOW, 'nope', 'deploy-prod'),
    ).toThrow(/has no entry/);
  });

  it('is a minimal-diff edit that preserves every comment', () => {
    const doc = parse();
    const before = doc.toString();

    addWorkflowJobEntryContext(doc, WORKFLOW, 'deploy', 'deploy-prod');

    const after = doc.toString();
    const { additions, deletions } = countChangedLines(
      unifiedDiff(before, after, 'config.yml'),
    );
    // Two added lines (`context:` and its one item), nothing removed:
    // `deploy` was already a map entry, so no line had to be rewritten.
    expect(additions).toBe(2);
    expect(deletions).toBe(0);

    // Every comment in the fixture survives.
    expect(after).toContain(
      '# This config builds, tests, and deploys the widgets service.',
    );
    expect(after).toContain('# Owned by #platform-eng.');
    expect(after).toContain('# cleanup after tests');
    expect(after).toContain('# Deploy jobs');
    expect(after).toContain('# These only run against main.');

    // The sibling `requires:` is untouched.
    expect(
      getIn(doc, ['workflows', WORKFLOW, 'jobs', 3, 'deploy', 'requires']),
    ).toEqual(['test-linux', 'test-macos']);
  });

  // The append-vs-replace distinction, asserted directly: a comment attached
  // to a context already in the list is exactly what a whole-value rewrite
  // destroys, and what this mutation exists to preserve.
  it('preserves a comment attached to an existing context item', () => {
    const source = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          context:
            # shared across every service
            - org-global
`;
    const { doc } = parseConfig(source);
    if (!doc) throw new Error('fixture failed to parse');

    addWorkflowJobEntryContext(doc, 'main', 'build', 'deploy-prod');

    const after = doc.toString();
    expect(after).toContain('# shared across every service');
    expect(after).toContain('- org-global');
    expect(after).toContain('- deploy-prod');

    const { additions, deletions } = countChangedLines(
      unifiedDiff(source, after, 'config.yml'),
    );
    expect(additions).toBe(1);
    expect(deletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Removing a context from a workflow job entry (issue #152)
// ---------------------------------------------------------------------------

describe('removeWorkflowJobEntryContext', () => {
  /** A config whose `context:` list carries a comment on one of its items. */
  const COMMENTED = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          context:
            # shared across every service
            - org-global
            - deploy-prod
          requires:
            - setup
`;

  it('removes one item from the list, leaving the others in place', () => {
    const { doc } = parseConfig(COMMENTED);
    if (!doc) throw new Error('fixture failed to parse');

    removeWorkflowJobEntryContext(doc, 'main', 'build', 'deploy-prod');

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'context']),
    ).toEqual(['org-global']);
  });

  /**
   * Why this mutation exists rather than the inspector's old whole-array
   * replace (issue #152): a comment on a *surviving* item is exactly
   * what rebuilding the sequence destroys.
   */
  it('is a minimal-diff edit that preserves a comment on a surviving item', () => {
    const { doc } = parseConfig(COMMENTED);
    if (!doc) throw new Error('fixture failed to parse');

    removeWorkflowJobEntryContext(doc, 'main', 'build', 'deploy-prod');

    const after = doc.toString();
    expect(after).toContain('# shared across every service');
    expect(after).toContain('- org-global');
    expect(after).not.toContain('deploy-prod');

    const { additions, deletions } = countChangedLines(
      unifiedDiff(COMMENTED, after, 'config.yml'),
    );
    // Exactly the one line that held the removed item.
    expect(additions).toBe(0);
    expect(deletions).toBe(1);

    // The sibling key is untouched.
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'requires']),
    ).toEqual(['setup']);
  });

  it('deletes the key when the last context is removed, collapsing to a bare string', () => {
    const source = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          context:
            - org-global
`;
    const { doc } = parseConfig(source);
    if (!doc) throw new Error('fixture failed to parse');

    removeWorkflowJobEntryContext(doc, 'main', 'build', 'org-global');

    // No `context: []` artefact left behind, and with nothing else on the
    // entry it returns to the bare-string form it would have been written in.
    expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toEqual('build');
  });

  it('removes the shorthand scalar form', () => {
    const source = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          context: org-global
          requires:
            - setup
`;
    const { doc } = parseConfig(source);
    if (!doc) throw new Error('fixture failed to parse');

    removeWorkflowJobEntryContext(doc, 'main', 'build', 'org-global');

    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'context']),
    ).toBeUndefined();
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'requires']),
    ).toEqual(['setup']);
  });

  it('is a no-op for a context that is not listed, and for a bare-string entry', () => {
    const { doc } = parseConfig(COMMENTED);
    if (!doc) throw new Error('fixture failed to parse');
    const before = doc.toString();

    removeWorkflowJobEntryContext(doc, 'main', 'build', 'never-added');
    expect(doc.toString()).toBe(before);

    const bare = parse();
    const bareBefore = bare.toString();
    removeWorkflowJobEntryContext(bare, WORKFLOW, 'build', 'org-global');
    expect(bare.toString()).toBe(bareBefore);
  });

  it('refuses an unknown workflow entry', () => {
    const doc = parse();
    expect(() =>
      removeWorkflowJobEntryContext(doc, WORKFLOW, 'nope', 'org-global'),
    ).toThrow(/no entry "nope"/);
  });
});

/*
 * Issue #220's editing half: do the three flagged constructs survive a rename,
 * a delete and a reorder with their comments intact?
 *
 * Two of these tests were written against behaviour that turned out to be
 * broken -- `renameJob` and `deleteJob` reconciled `workflows:` but not
 * `job-groups:`, which is issue #12's defect exactly, one namespace down and
 * invisible because nothing renders a group's interior. The rest record that
 * no-op and release jobs need no special handling at all.
 */
describe('orchestration constructs: editing (#220)', () => {
  function parseConstructs(): Document.Parsed {
    const { doc, error } = parseConfig(orchestrationConstructs);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  /** Every `#`-comment substring in `text`, in order -- the comment-fidelity check. */
  function comments(text: string): string[] {
    return text
      .split('\n')
      .map((line) => /#.*$/.exec(line)?.[0])
      .filter((c): c is string => c !== undefined);
  }

  describe('no-op jobs', () => {
    it('renames a no-op fan-in gate and every requires: that named it', () => {
      const doc = parseConstructs();
      const before = doc.toString();

      renameJob(doc, 'ok-to-deploy', 'all-green');
      const after = doc.toString();

      // The definition moved...
      expect(getJobNames(doc)).toContain('all-green');
      expect(getJobNames(doc)).not.toContain('ok-to-deploy');
      // ...its `type: no-op` came with it, untouched...
      expect(getIn(doc, ['jobs', 'all-green', 'type'])).toBe('no-op');
      // ...the workflow entry followed...
      expect(
        getWorkflowJobEntries(doc, 'main').map((e) => e.jobName),
      ).toContain('all-green');
      // ...and so did the downstream `requires:` naming it. This is #12's
      // reconciliation, which had never been exercised on a no-op job.
      expect(after).not.toContain('ok-to-deploy');
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 3, 'deploy', 'requires', 0]),
      ).toBe('all-green');

      expect(comments(after)).toEqual(comments(before));
    });

    it('deletes a no-op gate and prunes it from every dependent', () => {
      const doc = parseConstructs();
      const before = doc.toString();

      deleteJob(doc, 'ok-to-deploy');
      const after = doc.toString();

      expect(getJobNames(doc)).not.toContain('ok-to-deploy');
      // A gate is required by things downstream, which is the whole point of
      // the construct and the case most likely to leave a dangling reference.
      expect(after).not.toContain('ok-to-deploy');
      // The deleted job's own doc comment, and the comment on its workflow
      // entry, go with the things they describe -- that is correct, not a loss.
      // What must never happen is a *surviving* construct losing its comment,
      // so that is what is asserted, alongside "nothing was invented".
      const lost = comments(before).filter((c) => !comments(after).includes(c));
      const gained = comments(after).filter(
        (c) => !comments(before).includes(c),
      );
      expect(gained).toEqual([]);
      expect(lost).toHaveLength(6);
      for (const survivor of [
        '# `serial-group` is a *string*, not a boolean and not a list: jobs sharing',
        '# A job group invoked in a workflow, with `requires:` naming a plain job.',
        "# `override-with` replaces a locally-defined job with an orb's job at the",
        '# Two members, one internal dependency: release waits for deploy.',
      ]) {
        expect(comments(after)).toContain(survivor);
      }
      // `deploy`'s `requires:` had exactly one entry, so the key is gone and
      // the entry keeps its other options rather than collapsing wrongly.
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 2, 'deploy', 'requires']),
      ).toBeUndefined();
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 2, 'deploy', 'serial-group']),
      ).toBe('<< pipeline.project.slug >>/deploy-group');
    });

    it('renames the hand-rolled echo gate the same way', () => {
      // Both no-op shapes must behave identically; `gate` is the executor+echo
      // form this repository's own config used before `type: no-op` existed.
      const doc = parseConstructs();
      renameJob(doc, 'gate', 'final-gate');
      expect(getJobNames(doc)).toContain('final-gate');
      expect(
        getIn(doc, [
          'workflows',
          'main',
          'jobs',
          6,
          'final-gate',
          'override-with',
        ]),
      ).toBe('my-orb/my-gate');
    });
  });

  describe('job groups', () => {
    it('renames a job used inside a group, in the group too', () => {
      // The bug this found: reconciliation stopped at `workflows:`, so the
      // group went on invoking a job that no longer existed.
      const doc = parseConstructs();
      const before = doc.toString();

      renameJob(doc, 'deploy', 'deploy-renamed');
      const after = doc.toString();

      expect(getJobGroupMembers(doc, 'deploy-and-release')).toEqual([
        'deploy-renamed',
        'release-service',
      ]);
      // ...including the group's *internal* requires:, which is the members'
      // only way of depending on each other.
      expect(
        getIn(doc, [
          'job-groups',
          'deploy-and-release',
          'jobs',
          1,
          'release-service',
          'requires',
          0,
        ]),
      ).toBe('deploy-renamed');
      // No *reference* to the old name survives anywhere it could be read as
      // one: not the job key, not the workflow entry, not a requires: item.
      // Asserted per site rather than by grepping the whole document, because
      // the job's own step really does run `ccc deploy` and a shell command is
      // not a job reference.
      expect(getJobNames(doc)).not.toContain('deploy');
      expect(
        getWorkflowJobEntries(doc, 'main').map((e) => e.jobName),
      ).not.toContain('deploy');
      expect(getJobGroupMembers(doc, 'deploy-and-release')).not.toContain(
        'deploy',
      );
      expect(
        getIn(doc, [
          'workflows',
          'main',
          'jobs',
          4,
          'deploy-and-release',
          'requires',
          0,
        ]),
      ).toBe('deploy-renamed');

      expect(comments(after)).toEqual(comments(before));
    });

    it('deletes a job used inside a group, removing it from the group', () => {
      const doc = parseConstructs();
      const before = doc.toString();

      deleteJob(doc, 'smoke-test');
      const after = doc.toString();

      expect(getJobNames(doc)).not.toContain('smoke-test');
      // The group survives with an empty member list rather than vanishing: a
      // workflow still invokes `smoke`, and deleting the definition would trade
      // one dangling reference for another while discarding the user's
      // comments. An empty group is visible and fixable.
      expect(getJobGroupNames(doc)).toContain('smoke');
      expect(getJobGroupMembers(doc, 'smoke')).toEqual([]);
      expect(after).not.toContain('smoke-test');

      expect(comments(after)).toEqual(comments(before));
    });

    it('prunes a deleted member from a sibling member’s requires:', () => {
      const doc = parseConstructs();
      deleteJob(doc, 'deploy');

      expect(getJobGroupMembers(doc, 'deploy-and-release')).toEqual([
        'release-service',
      ]);
      // `release-service` required `deploy`; that requirement is gone, and the
      // now-empty `requires:` collapsed the entry back to a bare string.
      expect(
        getIn(doc, [
          'job-groups',
          'deploy-and-release',
          'jobs',
          0,
          'release-service',
          'requires',
        ]),
      ).toBeUndefined();
    });

    it('refuses to rename or delete a group as though it were a job, accurately', () => {
      // Neither operation means for a group what it means for a job, so both
      // refuse -- but the message has to name what the user should edit
      // instead. It previously claimed the group "does not exist".
      for (const act of [
        () => deleteJob(parseConstructs(), 'deploy-and-release'),
        () => renameJob(parseConstructs(), 'deploy-and-release', 'other'),
      ]) {
        expect(act).toThrow(/is a job group, not a job/);
      }
    });

    it('leaves the document untouched when it refuses', () => {
      const doc = parseConstructs();
      const before = doc.toString();
      expect(() => deleteJob(doc, 'deploy-and-release')).toThrow(
        /is a job group, not a job/,
      );
      expect(doc.toString()).toBe(before);
    });
  });

  describe('reordering', () => {
    it('reorders workflow entries with each comment following its entry', () => {
      const doc = parseConstructs();
      const before = doc.toString();

      // Move the serial-group `deploy` entry (index 3) ahead of the no-op gate
      // (index 2). The comment above each is attached to it and must travel.
      moveSeqItem(doc, ['workflows', 'main', 'jobs'], 3, 2);
      const after = doc.toString();

      expect(getWorkflowJobEntries(doc, 'main').map((e) => e.jobName)).toEqual([
        'build',
        'test',
        'deploy',
        'ok-to-deploy',
        'deploy-and-release',
        'smoke',
        'gate',
      ]);
      // Same comments, same count, reordered rather than dropped or duplicated.
      expect(comments(after).sort()).toEqual(comments(before).sort());
      // The serial-group comment still sits immediately above its own entry.
      const lines = after.split('\n');
      const entryLine = lines.findIndex((l) => l.includes('- deploy:'));
      expect(lines[entryLine - 1]).toContain('mistaken for a job invocation');
    });

    it('reorders group members without disturbing their requires:', () => {
      const doc = parseConstructs();
      moveSeqItem(doc, ['job-groups', 'deploy-and-release', 'jobs'], 1, 0);
      expect(getJobGroupMembers(doc, 'deploy-and-release')).toEqual([
        'release-service',
        'deploy',
      ]);
      // Order in the list is not the dependency: `requires:` is, and it is
      // untouched. A group whose members are listed "backwards" still runs
      // deploy first.
      expect(
        getIn(doc, [
          'job-groups',
          'deploy-and-release',
          'jobs',
          0,
          'release-service',
          'requires',
          0,
        ]),
      ).toBe('deploy');
    });
  });

  describe('release jobs', () => {
    it('renames a type: release job, keeping its plan_name', () => {
      const doc = parseConstructs();
      renameJob(doc, 'release-service', 'ship-service');

      expect(getIn(doc, ['jobs', 'ship-service', 'type'])).toBe('release');
      expect(getIn(doc, ['jobs', 'ship-service', 'plan_name'])).toBe(
        'my-service-release',
      );
      // It is invoked from inside a group, so this is also the group-member
      // rename path.
      expect(getJobGroupMembers(doc, 'deploy-and-release')).toContain(
        'ship-service',
      );
    });
  });

  describe('minimal diffs', () => {
    it('changes only the lines it has to when renaming a group member', () => {
      const doc = parseConstructs();
      const edited = cloneDocument(doc);
      renameJob(edited, 'smoke-test', 'smoke-check');

      const output = serializeMinimalDiff(orchestrationConstructs, doc, edited);
      // Two definition/invocation sites, no reflowed neighbours: the job key
      // and the group's member entry.
      const { additions, deletions } = countChangedLines(
        unifiedDiff(orchestrationConstructs, output, 'config.yml'),
      );
      expect(additions).toBeLessThanOrEqual(2);
      expect(deletions).toBeLessThanOrEqual(2);
      expect(comments(output)).toEqual(comments(orchestrationConstructs));
    });
  });
});

describe('matrix entries: N expanded nodes, one YAML entry (issue #284)', () => {
  function parseMatrix(text: string): Document.Parsed {
    const { doc, error } = parseConfig(text);
    if (!doc) throw new Error(`fixture failed to parse: ${error}`);
    return doc;
  }

  const MATRIX_CONFIG = `
jobs:
  build-frontend:
    docker: []
  deploy-service:
    docker: []
  staging-complete:
    docker: []
workflows:
  main:
    jobs:
      - build-frontend
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - staging-complete:
          requires:
            - Deploy frontend to NA
            - Deploy frontend to EU
`;

  it('a mutation reached through either expanded node id edits the one shared entry once', () => {
    const docViaNa = parseMatrix(MATRIX_CONFIG);
    addWorkflowJobEntryContext(
      docViaNa,
      'main',
      'Deploy frontend to NA',
      'org-global',
    );

    const docViaEu = parseMatrix(MATRIX_CONFIG);
    addWorkflowJobEntryContext(
      docViaEu,
      'main',
      'Deploy frontend to EU',
      'org-global',
    );

    // Whichever of the matrix's two expanded ids the edit was made through,
    // it is the same one YAML entry -- the resulting document is identical,
    // and `context:` appears exactly once, not once per expanded node.
    expect(docViaNa.toString()).toBe(docViaEu.toString());
    const contextOccurrences = (docViaNa.toString().match(/context:/g) ?? [])
      .length;
    expect(contextOccurrences).toBe(1);
    expect(docViaNa.toString()).toContain('context:\n            - org-global');
  });

  it('deleting via one expanded node id removes the whole matrix entry, and leaves a later entry untouched (no double-delete by index)', () => {
    const doc = parseMatrix(`
jobs:
  before-job:
    docker: []
  deploy-service:
    docker: []
  after-job:
    docker: []
workflows:
  main:
    jobs:
      - before-job
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - after-job:
          requires:
            - before-job
`);
    removeWorkflowJobEntry(doc, 'main', 'Deploy frontend to NA');

    // The workflow's own invocation of the matrix is gone (both instances --
    // there is only one entry to remove); the job *definition* under jobs:
    // is untouched, since removing a workflow entry is not deleting a job.
    const workflowJobs = getIn(doc, ['workflows', 'main', 'jobs']);
    expect(workflowJobs).toEqual([
      'before-job',
      { 'after-job': { requires: ['before-job'] } },
    ]);
    expect(getJobNames(doc)).toEqual([
      'before-job',
      'deploy-service',
      'after-job',
    ]);
    // The entry after the matrix entry in the sequence must survive
    // completely intact -- a naive "delete this index once per matching
    // WorkflowEntryNode" would delete the matrix's shared index twice and
    // take a *different*, unrelated entry with it the second time.
    const text = doc.toString();
    expect(text).toContain('after-job');
    expect(text).toContain('before-job');
  });

  it("removing one expanded node also prunes the *other* combination's id from other entries' requires:", () => {
    const doc = parseMatrix(MATRIX_CONFIG);
    removeWorkflowJobEntry(doc, 'main', 'Deploy frontend to NA');

    const text = doc.toString();
    // staging-complete required both NA and EU; deleting the (single, whole)
    // matrix entry via its NA id must not leave a stale reference to EU
    // behind as a fresh dangling requires:.
    expect(text).not.toContain('Deploy frontend to NA');
    expect(text).not.toContain('Deploy frontend to EU');
  });

  it('deleteJob on a job with a matrix workflow entry removes exactly one entry per workflow, leaving later entries untouched', () => {
    const doc = parseMatrix(`
jobs:
  before-job:
    docker: []
  deploy-service:
    docker: []
  after-job:
    docker: []
workflows:
  main:
    jobs:
      - before-job
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - after-job:
          requires:
            - before-job
`);
    deleteJob(doc, 'deploy-service');

    const text = doc.toString();
    expect(text).not.toContain('deploy-service');
    expect(getJobNames(doc)).toEqual(['before-job', 'after-job']);
    expect(text).toContain('after-job');
    expect(text).toContain('requires:');
    expect(text).toContain('before-job');
  });

  it('addRequire from a plain entry to one expanded matrix node writes only that one id, not the template', () => {
    const doc = parseMatrix(`
jobs:
  deploy-service:
    docker: []
  another-job:
    docker: []
workflows:
  main:
    jobs:
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - another-job
`);
    addRequire(doc, 'main', 'another-job', 'Deploy frontend to NA');
    const text = doc.toString();
    expect(text).toMatch(
      /another-job:\s*\n\s*requires:\s*\n\s*- Deploy frontend to NA/,
    );
    // The requires: entry just added is the literal, substituted id -- not
    // a copy of the matrix's own unresolved `<< matrix.region >>` template.
    const requiresLine = text
      .split('\n')
      .find((line) => line.includes('- Deploy frontend to NA'));
    expect(requiresLine).not.toContain('matrix.region');
  });
});
