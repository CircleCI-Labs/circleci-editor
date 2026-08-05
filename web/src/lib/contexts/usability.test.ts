/**
 * The restriction presentation model (issue #251).
 *
 * Worth its own suite rather than only being exercised through the palette,
 * because two of its guarantees are properties of the *table* rather than of any
 * one rendering: that a certain state never borrows an uncertain state's voice,
 * and that no two states say the same thing. Both are the kind of thing that
 * regresses by someone copying a `note` while adding a case.
 */
import { describe, expect, it } from 'vitest';

import type { ContextRestrictionDetail } from '~/lib/rpc/client';

import {
  describeRestriction,
  guardsAgainstUnversionedConfig,
  restrictionCertainty,
  RESTRICTION_PRESENTATION,
  type RestrictionCertainty,
  type RestrictionState,
} from './usability';

const project = (
  overrides: Partial<ContextRestrictionDetail> = {},
): ContextRestrictionDetail => ({ kind: 'project', ...overrides });

describe('restrictionCertainty', () => {
  it.each<[string, RestrictionState, RestrictionCertainty]>([
    [
      'an empty list is the positive statement that there are no restrictions',
      { usability: 'unrestricted', restrictions: [], projectIdentified: true },
      'unrestricted',
    ],
    [
      'a project restriction naming us is allowed',
      {
        usability: 'allowed',
        restrictions: [project({ name: 'web', thisProject: true })],
        projectIdentified: true,
      },
      'allowed',
    ],
    [
      'project restrictions naming others is a refusal we are certain about',
      {
        usability: 'other-projects-only',
        restrictions: [project({ name: 'other' })],
        projectIdentified: true,
      },
      'refused',
    ],
    [
      'a group restriction is unevaluable, not a refusal',
      {
        usability: 'unknown',
        restrictions: [{ kind: 'group', name: 'Field Engineering' }],
        projectIdentified: true,
      },
      'unevaluable',
    ],
    [
      'an expression is unevaluable too -- it is a rule about a run that has not happened',
      {
        usability: 'unknown',
        restrictions: [
          { kind: 'expression', expression: 'not job.ssh.enabled' },
        ],
        projectIdentified: true,
      },
      'unevaluable',
    ],
    [
      'a project restriction with no project of our own to compare is its own state',
      {
        usability: 'unknown',
        restrictions: [project({ name: 'other' })],
        projectIdentified: false,
      },
      'project-unknown',
    ],
    [
      'an unidentified project with only a group restriction is still just unevaluable: knowing our project would not have helped',
      {
        usability: 'unknown',
        restrictions: [{ kind: 'group', name: 'Pipelines' }],
        projectIdentified: false,
      },
      'unevaluable',
    ],
    [
      'an absent list is a failed check, whatever the usability says',
      { usability: 'unknown', restrictions: null, projectIdentified: true },
      'check-failed',
    ],
    [
      'an undefined list is a failed check as well -- an older or newer host must not read as unrestricted',
      { usability: 'unrestricted' },
      'check-failed',
    ],
  ])('%s', (_name, state, want) => {
    expect(restrictionCertainty(state)).toBe(want);
  });
});

describe('RESTRICTION_PRESENTATION', () => {
  const entries = Object.entries(RESTRICTION_PRESENTATION) as [
    RestrictionCertainty,
    (typeof RESTRICTION_PRESENTATION)[RestrictionCertainty],
  ][];

  it('marks exactly the three checked states as certain', () => {
    const certain = entries
      .filter(([, presentation]) => presentation.certain)
      .map(([certainty]) => certainty)
      .sort();
    expect(certain).toEqual(['allowed', 'refused', 'unrestricted']);
  });

  // The failure mode issue #251 names: a warning that reads the same whether we
  // know something or know nothing teaches users to dismiss it.
  it('gives every state its own label and its own sentence', () => {
    const labels = entries.map(([, presentation]) => presentation.label);
    const notes = entries.map(([, presentation]) => presentation.note);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(notes).size).toBe(notes.length);
  });

  /*
    The two voices, asserted as a property of the table rather than case by case.
    A certain state opens by saying the check happened; an uncertain one must not
    claim that, and has to name the gap somewhere in its own sentence.

    Phrased as "does it admit a gap" rather than "does it avoid the words 'will
    fail'", because the honest wording of an uncertain state legitimately
    *mentions* failure in order to disclaim it ("this is not a prediction that it
    will fail").
  */
  it.each(entries.filter(([, presentation]) => presentation.certain))(
    '%s asserts the check happened, because it did',
    (_certainty, presentation) => {
      expect(presentation.note).toMatch(/^Checked: /);
    },
  );

  it.each(entries.filter(([, presentation]) => !presentation.certain))(
    '%s claims no check and names the gap',
    (_certainty, presentation) => {
      expect(presentation.note).not.toMatch(/^Checked: /);
      expect(presentation.note).toMatch(/cannot|could not|does not know/i);
    },
  );
});

describe('describeRestriction', () => {
  it('names this project as such, so a user is not left matching names', () => {
    expect(
      describeRestriction(project({ name: 'web', thisProject: true })),
    ).toBe('This project');
  });

  it('uses CircleCI’s own name when there is one', () => {
    expect(describeRestriction(project({ name: 'circle-banking-app' }))).toBe(
      'circle-banking-app',
    );
  });

  // The live API really does return `"name": ""` for a project restriction, and
  // the host carries no UUID for a UI to fall back to on purpose.
  it('says what an unnamed project restriction is', () => {
    expect(describeRestriction(project())).toBe(
      'A project this editor cannot name',
    );
  });

  it('says what an unnamed group restriction is', () => {
    expect(describeRestriction({ kind: 'group' })).toBe(
      'A group this editor cannot name',
    );
  });

  it('returns an expression verbatim -- paraphrasing a rule would be worse than useless', () => {
    expect(
      describeRestriction({
        kind: 'expression',
        expression: 'not (pipeline.config_source starts-with "api")',
      }),
    ).toBe('not (pipeline.config_source starts-with "api")');
  });

  it('names an unrecognised restriction type rather than gesturing at it', () => {
    expect(
      describeRestriction({ kind: 'other', rawType: 'something-new' }),
    ).toBe('A “something-new” restriction this editor does not understand');
  });
});

describe('guardsAgainstUnversionedConfig', () => {
  it('sees the pipeline value wherever it appears in the expression', () => {
    expect(
      guardsAgainstUnversionedConfig([
        {
          kind: 'expression',
          expression:
            'pipeline.git.branch == "main" and not (pipeline.config_source starts-with "api")',
        },
      ]),
    ).toBe(true);
  });

  it('is false for an expression about something else entirely', () => {
    expect(
      guardsAgainstUnversionedConfig([
        { kind: 'expression', expression: 'pipeline.git.branch == "main"' },
      ]),
    ).toBe(false);
  });

  it('is false for project and group restrictions, which cannot guard against this at all', () => {
    expect(
      guardsAgainstUnversionedConfig([
        project({ name: 'web' }),
        { kind: 'group', name: 'Pipelines' },
      ]),
    ).toBe(false);
  });

  it('is false for a context with no restrictions', () => {
    expect(guardsAgainstUnversionedConfig([])).toBe(false);
  });
});
