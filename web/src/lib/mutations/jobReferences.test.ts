import { describe, expect, it } from 'vitest';
import type { Document } from 'yaml';

import {
  countReferenceSites,
  describeDeleteImpact,
  describeRenameImpact,
  findJobReferences,
  hasCrossReferences,
  renameNeedsConfirmation,
} from './jobReferences';
import { deleteJob, renameJob } from './configMutations';
import { MUTATION_FIXTURE } from './fixtures';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';

function parse(text: string): Document.Parsed {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

const FIXTURE = () => parse(MUTATION_FIXTURE);

describe('findJobReferences', () => {
  it('finds the definition, every workflow entry, and every requires mention', () => {
    const refs = findJobReferences(FIXTURE(), 'build');

    expect(refs.defined).toBe(true);
    expect(refs.entries).toEqual([
      {
        workflowName: 'build_test_deploy',
        index: 0,
        entryId: 'build',
        aliased: false,
      },
    ]);
    // Both aliased `test` entries require `build`.
    expect(refs.requires).toEqual([
      {
        workflowName: 'build_test_deploy',
        requiredBy: 'test-linux',
        referencedId: 'build',
        index: 0,
      },
      {
        workflowName: 'build_test_deploy',
        requiredBy: 'test-macos',
        referencedId: 'build',
        index: 0,
      },
    ]);
    expect(countReferenceSites(refs)).toBe(4);
    expect(hasCrossReferences(refs)).toBe(true);
  });

  it("reports an aliased job's references under the alias, which is what requires: names", () => {
    const refs = findJobReferences(FIXTURE(), 'test');

    expect(refs.entries.map((e) => e.entryId)).toEqual([
      'test-linux',
      'test-macos',
    ]);
    expect(refs.entries.every((e) => e.aliased)).toBe(true);
    // `deploy` requires the two aliases, not the bare job name.
    expect(refs.requires.map((r) => r.referencedId)).toEqual([
      'test-linux',
      'test-macos',
    ]);
    expect(refs.requires.every((r) => r.requiredBy === 'deploy')).toBe(true);
    // Nothing spells the bare name `test`, so a rename rewrites no requires.
    expect(refs.requiresRewrittenOnRenameIn).toEqual([]);
  });

  it('reports a job with no references at all as having none', () => {
    const refs = findJobReferences(
      parse('jobs:\n  orphan:\n    docker: []\n'),
      'orphan',
    );
    expect(refs.defined).toBe(true);
    expect(refs.entries).toEqual([]);
    expect(refs.requires).toEqual([]);
    expect(hasCrossReferences(refs)).toBe(false);
    expect(countReferenceSites(refs)).toBe(1);
  });

  it('reports an undefined job that workflows still name', () => {
    const refs = findJobReferences(
      parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - ghost
      - deploy:
          requires:
            - ghost
`),
      'ghost',
    );
    expect(refs.defined).toBe(false);
    expect(refs.entries).toHaveLength(1);
    expect(refs.requires).toHaveLength(1);
    expect(countReferenceSites(refs)).toBe(2);
  });

  it('spans every workflow, not just one', () => {
    const refs = findJobReferences(
      parse(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  ci:
    jobs:
      - build
      - deploy:
          requires:
            - build
  nightly:
    jobs:
      - build
`),
      'build',
    );
    expect(refs.entries.map((e) => e.workflowName)).toEqual(['ci', 'nightly']);
    expect(refs.requires.map((r) => r.workflowName)).toEqual(['ci']);
  });

  it('records the requires index so a caller can point at the exact list item', () => {
    const refs = findJobReferences(
      parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
  c:
    docker: []
workflows:
  main:
    jobs:
      - a
      - b
      - c:
          requires:
            - a
            - b
`),
      'b',
    );
    expect(refs.requires).toEqual([
      {
        workflowName: 'main',
        requiredBy: 'c',
        referencedId: 'b',
        index: 1,
      },
    ]);
  });

  it('reads a status-map requires entry as a reference to its key', () => {
    const refs = findJobReferences(
      parse(`
jobs:
  lint:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - lint
      - test:
          requires:
            - lint:
                - success
                - failed
`),
      'lint',
    );
    expect(refs.requires).toEqual([
      {
        workflowName: 'main',
        requiredBy: 'test',
        referencedId: 'lint',
        index: 0,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The alias form. `- some-job: {name: test}` makes `test` the id `requires:`
// resolves against, so the bare job name `test` can mean something completely
// different in the same document. These pin the enumerator and the mutation
// agreeing about which is which.
// ---------------------------------------------------------------------------

const SHADOW = `
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
`;

describe('findJobReferences and the name: alias form (#12)', () => {
  it("reports a workflow where another job is aliased with this job's name as shadowed", () => {
    const refs = findJobReferences(parse(SHADOW), 'test');
    expect(refs.shadowedWorkflows).toEqual(['deploy_pipeline']);
    // Only `ci`'s requires would be rewritten by a rename.
    expect(refs.requiresRewrittenOnRenameIn).toEqual(['ci']);
    expect(refs.requires).toEqual([
      {
        workflowName: 'ci',
        requiredBy: 'deploy',
        referencedId: 'test',
        index: 0,
      },
    ]);
  });

  it('does not report the shadowing job itself as shadowed', () => {
    const refs = findJobReferences(parse(SHADOW), 'shared-runner');
    expect(refs.shadowedWorkflows).toEqual([]);
    expect(refs.entries).toEqual([
      {
        workflowName: 'deploy_pipeline',
        index: 0,
        entryId: 'test',
        aliased: true,
      },
    ]);
    // `deploy-prod` requires the alias `test`, i.e. *this* job's entry.
    expect(refs.requires).toEqual([
      {
        workflowName: 'deploy_pipeline',
        requiredBy: 'deploy-prod',
        referencedId: 'test',
        index: 0,
      },
    ]);
  });

  it('excludes the degenerate - job: {name: job} form from requires rewriting', () => {
    const refs = findJobReferences(
      parse(`
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
`),
      'build',
    );
    expect(refs.entries[0]).toMatchObject({ entryId: 'build', aliased: true });
    expect(refs.shadowedWorkflows).toEqual([]);
    // Its id survives the rename (the `name:` key is never rewritten), so the
    // `requires:` naming it is still correct afterwards and must be left be.
    expect(refs.requiresRewrittenOnRenameIn).toEqual([]);
  });

  it('agrees with what renameJob actually does, workflow by workflow', () => {
    // The contract that matters: whatever `requiresRewrittenOnRenameIn` says
    // must match the mutation's real behaviour, or the prompt lies to the user.
    const doc = parse(SHADOW);
    const refs = findJobReferences(doc, 'test');
    renameJob(doc, 'test', 'unit');

    for (const workflowName of ['ci', 'deploy_pipeline']) {
      const rewritten = refs.requiresRewrittenOnRenameIn.includes(workflowName);
      const requiresPath =
        workflowName === 'ci'
          ? ['workflows', 'ci', 'jobs', 1, 'deploy', 'requires']
          : ['workflows', 'deploy_pipeline', 'jobs', 1, 'deploy', 'requires'];
      expect(getIn(doc, requiresPath)).toEqual(rewritten ? ['unit'] : ['test']);
    }
  });
});

describe('deleteBlockers', () => {
  it('is empty for an ordinary job', () => {
    expect(findJobReferences(FIXTURE(), 'test').deleteBlockers).toEqual([]);
  });

  it('names the alias site when the job definition is an anchor something aliases', () => {
    const doc = parse(`
jobs:
  deploy_prod: &deploy
    docker: []
  deploy_canary: *deploy
`);
    const refs = findJobReferences(doc, 'deploy_prod');
    expect(refs.deleteBlockers).toHaveLength(1);
    expect(refs.deleteBlockers[0]).toContain('deploy_canary');
    // And the mutation really does refuse, so the prompt is not crying wolf.
    expect(() => deleteJob(doc, 'deploy_prod')).toThrow(/anchor/i);
  });

  it('names a workflow entry that is an anchor a sibling entry aliases', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - build
      - &entry
        deploy:
          requires:
            - build
      - *entry
`);
    const refs = findJobReferences(doc, 'deploy');
    expect(refs.deleteBlockers.join(' ')).toMatch(/workflow "main"/);
    expect(() => deleteJob(doc, 'deploy')).toThrow(/anchor/i);
  });
});

describe('describeRenameImpact', () => {
  it('names the definition, the entries, and who requires it', () => {
    const impact = describeRenameImpact(FIXTURE(), 'build', 'compile');

    expect(impact.headline).toBe(
      'Renaming build to compile rewrites 4 places.',
    );
    expect(impact.lines).toEqual([
      'the job definition: jobs.build becomes jobs.compile',
      'workflow "build_test_deploy": 1 job entry renamed to compile',
      'workflow "build_test_deploy": build is required by test-linux and test-macos -- those requires: are updated to compile',
    ]);
    expect(impact.blockers).toEqual([]);
  });

  it('explains that an aliased entry keeps its alias', () => {
    const impact = describeRenameImpact(FIXTURE(), 'test', 'unit');

    expect(impact.lines).toContain(
      'workflow "build_test_deploy": 2 aliased entries now point at unit',
    );
    expect(impact.notes.join(' ')).toContain('aliases this job with name:');
    // Nothing in `requires:` is rewritten, so nothing claims otherwise.
    expect(impact.lines.join(' ')).not.toContain('is required by');
  });

  it('warns that a shadowed workflow is deliberately left alone', () => {
    const impact = describeRenameImpact(parse(SHADOW), 'test', 'unit');
    expect(impact.notes.join(' ')).toContain('workflow "deploy_pipeline"');
    expect(impact.notes.join(' ')).toContain('refers to that entry');
    expect(impact.headline).toBe('Renaming test to unit rewrites 3 places.');
  });

  it('is never blocked -- a rename cannot strand a YAML alias', () => {
    const doc = parse(`
jobs:
  deploy_prod: &deploy
    docker: []
  deploy_canary: *deploy
`);
    expect(describeRenameImpact(doc, 'deploy_prod', 'x').blockers).toEqual([]);
  });
});

describe('describeDeleteImpact', () => {
  it('names every site and says the dependents will not be re-pointed', () => {
    const impact = describeDeleteImpact(FIXTURE(), 'test');

    expect(impact.headline).toBe('Deleting test changes 5 places.');
    expect(impact.lines).toEqual([
      'the job definition: jobs.test',
      'workflow "build_test_deploy": 2 job entries removed',
      'workflow "build_test_deploy": removed from deploy\'s requires:',
    ]);
    // No auto-rewiring, said out loud rather than discovered later.
    expect(impact.notes.join(' ')).toContain('not re-pointed');
    expect(impact.notes.join(' ')).toContain('deploy');
  });

  it('says nothing about re-pointing when nothing requires the job', () => {
    const impact = describeDeleteImpact(FIXTURE(), 'deploy');
    expect(impact.notes).toEqual([]);
    expect(impact.lines).toEqual([
      'the job definition: jobs.deploy',
      'workflow "build_test_deploy": 1 job entry removed',
    ]);
  });

  it('surfaces a blocker instead of promising an edit that will be refused', () => {
    const doc = parse(`
jobs:
  deploy_prod: &deploy
    docker: []
  deploy_canary: *deploy
`);
    const impact = describeDeleteImpact(doc, 'deploy_prod');
    expect(impact.blockers).toHaveLength(1);
    expect(impact.blockers[0]).toContain('deploy_canary');
  });

  it('lists both dependents by name for a mid-chain delete', () => {
    const impact = describeDeleteImpact(
      parse(`
jobs:
  build:
    docker: []
  test:
    docker: []
  deploy:
    docker: []
  notify:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build
      - deploy:
          requires:
            - test
      - notify:
          requires:
            - test
`),
      'test',
    );
    expect(impact.lines).toContain(
      'workflow "main": removed from deploy and notify\'s requires:',
    );
    expect(impact.notes[0]).toBe(
      "deploy and notify are not re-pointed at whatever test required -- reconnect them yourself if that's what you want.",
    );
  });
});

describe('renameNeedsConfirmation', () => {
  it('is false when the only reference is a single un-aliased entry', () => {
    const refs = findJobReferences(
      parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`),
      'build',
    );
    expect(hasCrossReferences(refs)).toBe(true);
    // ...but the one reference is the node the user is looking at.
    expect(renameNeedsConfirmation(refs)).toBe(false);
  });

  it('is false for a job with no references at all', () => {
    const refs = findJobReferences(
      parse('jobs:\n  orphan:\n    docker: []\n'),
      'orphan',
    );
    expect(renameNeedsConfirmation(refs)).toBe(false);
  });

  it('is true as soon as something requires the job', () => {
    expect(renameNeedsConfirmation(findJobReferences(FIXTURE(), 'build'))).toBe(
      true,
    );
  });

  it('is true when two entries share the definition (issue #36)', () => {
    // `test` is aliased twice; one rename changes two nodes at once.
    expect(renameNeedsConfirmation(findJobReferences(FIXTURE(), 'test'))).toBe(
      true,
    );
  });

  it('is true when a workflow shadows the name, even though nothing there changes', () => {
    const refs = findJobReferences(parse(SHADOW), 'test');
    expect(renameNeedsConfirmation(refs)).toBe(true);
  });
});
