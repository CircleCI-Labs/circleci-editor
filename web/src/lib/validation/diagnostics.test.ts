import { describe, expect, it } from 'vitest';

import {
  CYCLE,
  MISSING_VERSION,
  ORB_NOT_FOUND,
  SCHEMA_EXTRANEOUS_KEY,
  SCHEMA_EXTRANEOUS_KEY_NESTED,
  UNKNOWN_COMMAND,
  UNKNOWN_EXECUTOR,
  UNKNOWN_REQUIRES,
  UNKNOWN_WORKFLOW_JOB,
  UNPARSEABLE,
} from './apiFixtures';
import {
  diagnosticWorkflow,
  describeSource,
  groupCompileErrors,
  matchesNode,
  parseSchemaPointer,
  readExtraneousKeys,
  type Diagnostic,
} from './diagnostics';

describe('groupCompileErrors', () => {
  it('keeps a one-line report as one report', () => {
    const reports = groupCompileErrors(ORB_NOT_FOUND);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.title).toBe(ORB_NOT_FOUND[0]);
    expect(reports[0]?.detail).toEqual([]);
  });

  it('collapses a 24-line schema report into a single report, keeping every line', () => {
    // The regression this whole grouping layer exists for: the pane used to
    // render one bullet per array entry, so this exact response -- one
    // misspelled key -- appeared as 24 separate "errors".
    const reports = groupCompileErrors(SCHEMA_EXTRANEOUS_KEY);
    expect(reports).toHaveLength(1);
    // Every line except the `ERROR IN CONFIG FILE:` banner is kept verbatim
    // and in order -- including the `oneOf` noise this app declines to act
    // on. "We didn't understand it" is not a reason to hide it.
    expect(reports[0]?.detail).toEqual(SCHEMA_EXTRANEOUS_KEY.slice(1));
    expect(reports[0]?.detail).toContain(
      '3. [#/jobs/build] required key [type] not found',
    );
  });

  it('promotes the actionable finding to the headline rather than "0 subschemas matched"', () => {
    const reports = groupCompileErrors(SCHEMA_EXTRANEOUS_KEY);
    expect(reports[0]?.title).toBe('Key "stpes" is not allowed in jobs.build');
    // The useless first line is still there, just not the headline.
    expect(reports[0]?.detail[0]).toBe(
      '[#/jobs/build] 0 subschemas matched instead of one',
    );
  });

  it('treats "Error calling ..." lines as context, not as separate errors', () => {
    const reports = groupCompileErrors(UNKNOWN_EXECUTOR);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.title).toBe(
      'Cannot find a definition for executor named nope',
    );
    expect(reports[0]?.context).toEqual([
      { kind: 'workflow', name: 'main' },
      { kind: 'job', name: 'build' },
    ]);
  });

  it('reports two independent one-line errors as two reports', () => {
    expect(groupCompileErrors(CYCLE)).toHaveLength(2);
  });

  it('reads the position out of the one report that carries one', () => {
    const reports = groupCompileErrors(UNPARSEABLE);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reported).toEqual({ line: 3, column: 3 });
  });

  it('ignores blank entries rather than emitting empty errors', () => {
    expect(groupCompileErrors(['', '   ', 'real problem'])).toHaveLength(1);
  });
});

describe('targets extracted from real messages', () => {
  it('splits an unresolvable orb reference into name and version', () => {
    expect(groupCompileErrors(ORB_NOT_FOUND)[0]?.target).toEqual({
      kind: 'orb',
      ref: 'circleci/slack@99.99.99',
      orbName: 'circleci/slack',
      version: '99.99.99',
    });
  });

  it('reads the requiring alias, the missing id and the workflow from a requires error', () => {
    expect(groupCompileErrors(UNKNOWN_REQUIRES)[0]?.target).toEqual({
      kind: 'requires',
      workflow: 'main',
      fromAlias: 'build',
      missingId: 'nonexistent',
    });
  });

  it('scopes an executor error to the job the context lines named', () => {
    expect(groupCompileErrors(UNKNOWN_EXECUTOR)[0]?.target).toEqual({
      kind: 'executor',
      job: 'build',
      name: 'nope',
    });
  });

  it('scopes a command error to the job the context lines named', () => {
    expect(groupCompileErrors(UNKNOWN_COMMAND)[0]?.target).toEqual({
      kind: 'command',
      job: 'build',
      fromCommand: undefined,
      name: 'chekcout',
    });
  });

  it('scopes an undefined workflow job to its workflow', () => {
    expect(groupCompileErrors(UNKNOWN_WORKFLOW_JOB)[0]?.target).toEqual({
      kind: 'workflowJob',
      workflow: 'main',
      jobName: 'notdefined',
    });
  });

  it('extracts no target at all from a cycle error -- there is no single entity to blame', () => {
    for (const report of groupCompileErrors(CYCLE)) {
      expect(report.target).toBeUndefined();
    }
  });

  it('extracts no target from a missing-version error', () => {
    expect(groupCompileErrors(MISSING_VERSION)[0]?.target).toBeUndefined();
  });
});

describe('readExtraneousKeys', () => {
  it("captures the key and CircleCI's own permitted-key list", () => {
    const findings = readExtraneousKeys(SCHEMA_EXTRANEOUS_KEY.slice(1));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('stpes');
    expect(findings[0]?.path).toEqual(['jobs', 'build']);
    expect(findings[0]?.permitted).toContain('steps');
    // The full list, not just the first bullet -- it is the candidate set.
    expect(findings[0]?.permitted).toHaveLength(14);
    expect(findings[0]?.permitted.at(-1)).toBe('parameters');
  });

  it('turns a sequence index in the path into a number, so it indexes rather than keys', () => {
    const findings = readExtraneousKeys(SCHEMA_EXTRANEOUS_KEY_NESTED.slice(1));
    expect(findings[0]?.path).toEqual(['jobs', 'build', 'docker', 0]);
    expect(findings[0]?.key).toBe('imag');
    expect(findings[0]?.permitted).toContain('image');
  });

  it('finds nothing in a report with no extraneous-key line', () => {
    expect(readExtraneousKeys(CYCLE)).toEqual([]);
  });
});

describe('parseSchemaPointer', () => {
  it('drops the leading # and empty segments', () => {
    expect(parseSchemaPointer('/jobs/build')).toEqual(['jobs', 'build']);
  });

  it('unescapes ~1 and ~0', () => {
    expect(parseSchemaPointer('/jobs/a~1b')).toEqual(['jobs', 'a/b']);
  });
});

describe('describeSource', () => {
  it('never describes a local check in words that could be read as CircleCI speaking', () => {
    expect(describeSource('circleci')).toBe('CircleCI compiler');
    expect(describeSource('local')).toBe('Local check');
    expect(describeSource('local').toLowerCase()).not.toContain('circleci');
  });
});

function diagnosticFrom(messages: string[]): Diagnostic {
  const report = groupCompileErrors(messages)[0];
  if (!report) throw new Error('fixture produced no report');
  return {
    id: 'd',
    source: 'circleci',
    severity: 'error',
    title: report.title,
    detail: report.detail,
    context: report.context,
    target: report.target,
    extraneousKeys: report.extraneousKeys,
  };
}

describe('matchesNode', () => {
  const node = (
    over: Partial<{ id: string; jobName: string; orbRef: string }> = {},
  ) => ({ id: 'build', jobName: 'build', ...over });

  it('marks both ends of a broken requires: the requiring entry and the hole', () => {
    const diagnostic = diagnosticFrom(UNKNOWN_REQUIRES);
    expect(matchesNode(diagnostic, 'main', node())).toBe(true);
    expect(
      matchesNode(
        diagnostic,
        'main',
        node({ id: 'nonexistent', jobName: 'nonexistent' }),
      ),
    ).toBe(true);
    expect(
      matchesNode(diagnostic, 'main', node({ id: 'other', jobName: 'other' })),
    ).toBe(false);
  });

  it('does not mark a node in a different workflow', () => {
    expect(
      matchesNode(diagnosticFrom(UNKNOWN_REQUIRES), 'other-wf', node()),
    ).toBe(false);
  });

  it('marks the job an executor error was scoped to', () => {
    const diagnostic = diagnosticFrom(UNKNOWN_EXECUTOR);
    expect(matchesNode(diagnostic, 'main', node())).toBe(true);
    expect(matchesNode(diagnostic, 'main', node({ jobName: 'test' }))).toBe(
      false,
    );
  });

  it('marks an orb-provided node from the orb package name, not from prose', () => {
    const diagnostic = diagnosticFrom(ORB_NOT_FOUND);
    expect(
      matchesNode(
        diagnostic,
        'main',
        node({ jobName: 'slack/notify', orbRef: 'slack' }),
      ),
    ).toBe(true);
    expect(
      matchesNode(
        diagnostic,
        'main',
        node({ jobName: 'node/test', orbRef: 'node' }),
      ),
    ).toBe(false);
  });

  it('marks the job a schema path points into', () => {
    const diagnostic = diagnosticFrom(SCHEMA_EXTRANEOUS_KEY);
    expect(matchesNode(diagnostic, 'main', node())).toBe(true);
    expect(matchesNode(diagnostic, 'main', node({ jobName: 'deploy' }))).toBe(
      false,
    );
  });

  it('marks nothing when there is no target -- a cycle error implicates no single node', () => {
    expect(matchesNode(diagnosticFrom(CYCLE), 'main', node())).toBe(false);
  });
});

describe('diagnosticWorkflow', () => {
  it('uses the target workflow when the message named one', () => {
    expect(diagnosticWorkflow(diagnosticFrom(UNKNOWN_REQUIRES))).toBe('main');
  });

  it('falls back to the "Error calling workflow" context line', () => {
    expect(diagnosticWorkflow(diagnosticFrom(UNKNOWN_EXECUTOR))).toBe('main');
  });

  it('attributes an orb error to no workflow, so no tab gets a false error dot', () => {
    expect(diagnosticWorkflow(diagnosticFrom(ORB_NOT_FOUND))).toBeUndefined();
  });
});
