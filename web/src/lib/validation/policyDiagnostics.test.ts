import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';
import type { PolicyDecision } from '~/state/policyStore';

import { matchesNode } from './diagnostics';
import {
  buildPolicyDiagnostics,
  documentCandidates,
  reasonCandidateTokens,
  targetForViolation,
} from './policyDiagnostics';

/**
 * A config with a job whose name is also an ordinary English word (`test`),
 * one that is not (`security-scan`), an executor, and an orb -- which is
 * exactly the set of traps the location rules have to survive.
 */
const CONFIG = `version: 2.1
orbs:
  aws-cli: circleci/aws-cli@5.2.0
executors:
  big-linux:
    docker:
      - image: cimg/base:current
jobs:
  test:
    docker:
      - image: nginx:latest
    steps:
      - run: echo hi
  security-scan:
    executor: big-linux
    steps:
      - run: echo scan
workflows:
  main:
    jobs:
      - test
      - security-scan
`;

function lineOf(needle: string): number {
  const index = CONFIG.indexOf(needle);
  if (index < 0) throw new Error(`fixture does not contain ${needle}`);
  return CONFIG.slice(0, index).split('\n').length;
}

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    status: 'HARD_FAIL',
    enabledRules: ['a_rule'],
    hardFailures: [],
    softFailures: [],
    metadataSent: [],
    ...overrides,
  };
}

function build(reason: string, kind: 'hard' | 'soft' = 'hard', text = CONFIG) {
  const { doc } = parseConfig(text);
  return buildPolicyDiagnostics({
    decision: decision({
      [kind === 'hard' ? 'hardFailures' : 'softFailures']: [
        { rule: 'a_rule', reason, kind },
      ],
    }),
    doc,
    text,
    stale: false,
  });
}

describe('reasonCandidateTokens', () => {
  it('takes anything the policy author quoted', () => {
    expect(
      reasonCandidateTokens("Job 'security-scan' is required by your team"),
    ).toContain('security-scan');
    expect(reasonCandidateTokens('the "test" job is not allowed')).toContain(
      'test',
    );
    expect(reasonCandidateTokens('use `big-linux` instead')).toContain(
      'big-linux',
    );
  });

  it('takes an unquoted token only when it is shaped like a reference', () => {
    expect(reasonCandidateTokens('nginx:latest is not approved')).toContain(
      'nginx:latest',
    );
    expect(
      reasonCandidateTokens('circleci/aws-cli@5.2.0 is not an approved orb'),
    ).toContain('circleci/aws-cli@5.2.0');
  });

  it('never takes a bare English word, however exactly it would match', () => {
    // The whole point: a reason mentioning the word "test" must not be
    // allowed to point at the job called `test`.
    const tokens = reasonCandidateTokens(
      'every job must have a test step and must build before deploy',
    );
    expect(tokens).toEqual([]);
  });

  it('strips the punctuation a sentence puts around a token', () => {
    expect(
      reasonCandidateTokens('please remove nginx:latest, it is not approved.'),
    ).toContain('nginx:latest');
  });
});

describe('documentCandidates', () => {
  it('is a closed set drawn from the document: jobs, executors and orbs', () => {
    const { doc } = parseConfig(CONFIG);
    const names = documentCandidates(doc).map((candidate) => candidate.name);
    expect(names).toContain('test');
    expect(names).toContain('security-scan');
    expect(names).toContain('big-linux');
    expect(names).toContain('circleci/aws-cli@5.2.0');
    // The orb's local alias, which is what a policy author is as likely to
    // quote as the full reference.
    expect(names).toContain('aws-cli');
    // Not candidates: workflow names have no single line worth pointing at,
    // and an image is a value rather than a declaration.
    expect(names).not.toContain('main');
    expect(names).not.toContain('nginx:latest');
  });

  it('is empty for an unparsed document', () => {
    expect(documentCandidates(null)).toEqual([]);
  });
});

describe('targetForViolation', () => {
  const candidates = documentCandidates(parseConfig(CONFIG).doc);

  it('resolves a quoted job name to its definition', () => {
    expect(
      targetForViolation("Job 'security-scan' must run first", candidates),
    ).toEqual({ kind: 'schemaPath', path: ['jobs'], key: 'security-scan' });
  });

  it('resolves an orb reference to the orbs entry', () => {
    expect(
      targetForViolation(
        'circleci/aws-cli@5.2.0 is not an approved orb version',
        candidates,
      ),
    ).toMatchObject({ kind: 'orb', ref: 'circleci/aws-cli@5.2.0' });
  });

  it('treats the orb alias and the full reference as the same entity', () => {
    // Both spellings in one reason is not ambiguity, so this still resolves.
    expect(
      targetForViolation(
        'the aws-cli orb (circleci/aws-cli@5.2.0) is not approved',
        candidates,
      ),
    ).toMatchObject({ kind: 'orb' });
  });

  it('declines when two different entities are named', () => {
    expect(
      targetForViolation(
        "'test' and 'security-scan' must not both exist",
        candidates,
      ),
    ).toBeUndefined();
  });

  it('declines when the reason names nothing in the document', () => {
    expect(
      targetForViolation(
        "Job 'deploy-prod' is required but missing from this workflow",
        candidates,
      ),
    ).toBeUndefined();
  });

  it('declines a bare English word that happens to be a job name', () => {
    expect(
      targetForViolation('every job needs a test step', candidates),
    ).toBeUndefined();
  });
});

describe('buildPolicyDiagnostics', () => {
  it('carries the rule and the policy’s own words, unreworded', () => {
    const [diagnostic] = build(
      "Job 'security-scan' is enforced by your Security Team",
    );
    expect(diagnostic?.source).toBe('policy');
    expect(diagnostic?.policyRule).toEqual({
      name: 'a_rule',
      blocking: true,
    });
    expect(diagnostic?.title).toBe(
      "Job 'security-scan' is enforced by your Security Team",
    );
  });

  it('maps a blocking violation to an error and a non-blocking one to a warning', () => {
    expect(build('x', 'hard')[0]?.severity).toBe('error');
    expect(build('x', 'soft')[0]?.severity).toBe('warning');
    expect(build('x', 'soft')[0]?.policyRule?.blocking).toBe(false);
  });

  it('locates a violation that names a job, at the job’s own line', () => {
    const [diagnostic] = build("Job 'security-scan' must run first");
    expect(diagnostic?.location?.line).toBe(lineOf('security-scan:'));
    expect(diagnostic?.location?.basis).toBe('resolved');
  });

  it('locates a violation that names an orb, at the orbs entry', () => {
    const [diagnostic] = build('circleci/aws-cli@5.2.0 is not allowed');
    expect(diagnostic?.location?.line).toBe(lineOf('circleci/aws-cli@5.2.0'));
  });

  it('leaves a violation it cannot place with no location at all', () => {
    // The commonest real shape: prose about an image, naming no declaration.
    const [diagnostic] = build(
      'nginx:latest is not an approved Docker image. Please only use images approved by our organization',
    );
    expect(diagnostic?.location).toBeUndefined();
    expect(diagnostic?.target).toBeUndefined();
  });

  it('leaves a violation naming a job that does not exist with no location', () => {
    const [diagnostic] = build(
      "Job 'security-audit' is enforced by your Security Team but missing from this workflow",
    );
    expect(diagnostic?.location).toBeUndefined();
  });

  it('marks the DAG node for a violation that named a job', () => {
    const [diagnostic] = build("Job 'security-scan' must run first");
    expect(diagnostic).toBeDefined();
    expect(
      matchesNode(diagnostic!, 'main', {
        id: 'security-scan',
        jobName: 'security-scan',
      }),
    ).toBe(true);
    expect(
      matchesNode(diagnostic!, 'main', { id: 'test', jobName: 'test' }),
    ).toBe(false);
  });

  it('marks no node for a violation it could not place', () => {
    const [diagnostic] = build('nginx:latest is not an approved Docker image');
    expect(
      matchesNode(diagnostic!, 'main', { id: 'test', jobName: 'test' }),
    ).toBe(false);
  });

  it('produces nothing for a stale decision', () => {
    const { doc } = parseConfig(CONFIG);
    expect(
      buildPolicyDiagnostics({
        decision: decision({
          hardFailures: [{ rule: 'r', reason: 'anything', kind: 'hard' }],
        }),
        doc,
        text: CONFIG,
        stale: true,
      }),
    ).toEqual([]);
  });

  it('produces nothing when there is no decision', () => {
    const { doc } = parseConfig(CONFIG);
    expect(
      buildPolicyDiagnostics({
        decision: null,
        doc,
        text: CONFIG,
        stale: false,
      }),
    ).toEqual([]);
  });

  it('orders blocking violations before non-blocking ones', () => {
    const { doc } = parseConfig(CONFIG);
    const diagnostics = buildPolicyDiagnostics({
      decision: decision({
        hardFailures: [{ rule: 'hard_rule', reason: 'blocked', kind: 'hard' }],
        softFailures: [{ rule: 'soft_rule', reason: 'flagged', kind: 'soft' }],
      }),
      doc,
      text: CONFIG,
      stale: false,
    });
    expect(diagnostics.map((d) => d.policyRule?.name)).toEqual([
      'hard_rule',
      'soft_rule',
    ]);
    // Ids are stable within one decision, so React keys and "which one am I
    // looking at" survive a re-render.
    expect(new Set(diagnostics.map((d) => d.id)).size).toBe(2);
  });
});
