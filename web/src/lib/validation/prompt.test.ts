import { describe, expect, it } from 'vitest';

import { SCHEMA_EXTRANEOUS_KEY, UNKNOWN_EXECUTOR } from './apiFixtures';
import { groupCompileErrors, type Diagnostic } from './diagnostics';
import { buildFixPrompt } from './prompt';

const TEXT = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:stable
    stpes:
      - checkout
workflows:
  main:
    jobs:
      - build
`;

function diagnostic(
  messages: string[],
  over: Partial<Diagnostic> = {},
): Diagnostic {
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
    ...over,
  };
}

describe('buildFixPrompt', () => {
  it("quotes the compiler's own words, in full", () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt).toContain('extraneous key [stpes] is not permitted');
    // Including the lines this app declines to act on -- the model may well
    // make sense of them.
    expect(prompt).toContain('required key [type] not found');
  });

  it('names the file', () => {
    expect(
      buildFixPrompt({
        diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY),
        text: TEXT,
        configPath: '/repo/.circleci/config.yml',
      }),
    ).toContain('File: /repo/.circleci/config.yml');
  });

  it('attributes a compile error to CircleCI', () => {
    expect(
      buildFixPrompt({
        diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY),
        text: TEXT,
        configPath: '/c.yml',
      }),
    ).toContain('Reported by: CircleCI compiler');
  });

  it('tells the model plainly when the finding is only a local check', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY, { source: 'local' }),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).toContain('Reported by: Local check');
    expect(prompt).toContain('not from CircleCI');
    expect(prompt).toContain('has not actually been compiled');
  });

  it('quotes the surrounding lines with the offending one marked', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY, {
        location: { line: 6, column: 5, basis: 'resolved' },
      }),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).toContain('> 6 |     stpes:');
    expect(prompt).toContain('  5 |       - image: cimg/base:stable');
  });

  it('says the location is unknown rather than implying one', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(UNKNOWN_EXECUTOR),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).toContain('Location: unknown');
    expect(prompt).not.toContain('The surrounding config:');
  });

  it('distinguishes a position the validator quoted from one this app resolved', () => {
    const reported = buildFixPrompt({
      diagnostic: diagnostic(UNKNOWN_EXECUTOR, {
        location: { line: 3, column: 3, basis: 'reported' },
      }),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(reported).toContain('quoted by the validator itself');

    const resolved = buildFixPrompt({
      diagnostic: diagnostic(UNKNOWN_EXECUTOR, {
        location: { line: 3, column: 3, basis: 'resolved' },
      }),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(resolved).toContain('resolved by matching the name');
  });

  it('carries the compile scope the context lines gave', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(UNKNOWN_EXECUTOR),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).toContain('In workflow: main');
    expect(prompt).toContain('In job: build');
  });

  it('asks for the smallest edit and for comments to be preserved', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).toContain('smallest edit');
    expect(prompt).toContain('keep my comments');
  });

  it('does not paste the whole config -- the host already sends it', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(SCHEMA_EXTRANEOUS_KEY),
      text: TEXT,
      configPath: '/c.yml',
    });
    expect(prompt).not.toContain('workflows:');
  });
});

/**
 * Issue #210. The seeded prompt is what a docs search runs over, so it has to say
 * what *kind* of problem this is — otherwise, for `Cannot find circleci/slack@…`,
 * retrieval answers the question the word "slack" suggests. The owner's report was
 * a citation list led by Slack's Block Kit builder.
 */
describe('the problem class in a seeded prompt (issue #210)', () => {
  const ORB_ERROR =
    'Cannot find circleci/slack@4.12.5 in the orb registry. Check that the namespace, orb name and version are correct.';

  it('names an orb problem as an orb problem, and rules out the third-party product', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic([ORB_ERROR]),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt).toContain('Problem type: an orb reference under `orbs:`');
    expect(prompt).toContain('**CircleCI orbs**');
    // The sentence that aims retrieval away from the Block Kit builder. It is a
    // claim about which documentation is relevant, never a hint about the fix.
    expect(prompt).toContain(
      'not a question about the third-party service the orb integrates with',
    );
  });

  it('states the real published versions as facts, so a version need not be invented', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic([ORB_ERROR]),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
      orbVersions: {
        versions: ['5.1.1', '5.0.0', '4.13.7'],
        latestVersion: '5.1.1',
      },
    });
    expect(prompt).toContain('latest published version: 5.1.1');
    expect(prompt).toContain(
      'published versions (newest first): 5.1.1, 5.0.0, 4.13.7',
    );
    expect(prompt).toContain('rather than inventing one');
  });

  it('quotes only the newest few of a long version history', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic([ORB_ERROR]),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
      orbVersions: {
        versions: Array.from({ length: 30 }, (_, index) => `1.0.${29 - index}`),
      },
    });
    expect(prompt).toContain('1.0.29');
    expect(prompt).toContain('and 22 older');
    // The whole history of a popular orb would swamp a prompt whose point is that
    // a human reads it before sending.
    expect(prompt).not.toContain('1.0.0');
  });

  it('says nothing about versions when the registry could not be asked', () => {
    // No token, no network: the class line still helps, and no version facts are
    // invented to fill the gap.
    const prompt = buildFixPrompt({
      diagnostic: diagnostic([ORB_ERROR]),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt).toContain('Problem type: an orb reference');
    expect(prompt).not.toContain('published version');
  });

  it('names an undefined executor as a reusable-config problem', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(UNKNOWN_EXECUTOR),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt).toContain('Problem type:');
    expect(prompt).toContain('**CircleCI reusable config**');
  });

  it('says nothing about a class it could not extract', () => {
    // `diagnostics.ts` refuses to guess a target, and that refusal has to reach
    // the prompt: inventing a class here would aim retrieval confidently at the
    // wrong subject, which is the defect this whole issue is about.
    const prompt = buildFixPrompt({
      diagnostic: diagnostic(['Something went wrong'], { target: undefined }),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt).not.toContain('Problem type:');
  });

  it('still puts the class before the error text, where a reader meets it first', () => {
    const prompt = buildFixPrompt({
      diagnostic: diagnostic([ORB_ERROR]),
      text: TEXT,
      configPath: '/repo/.circleci/config.yml',
    });
    expect(prompt.indexOf('Problem type:')).toBeLessThan(
      prompt.indexOf('Error:'),
    );
  });

  describe('a policy violation (issue #247)', () => {
    // A policy violation is not the same claim as a compile failure -- a
    // soft failure in particular does not stop the config from running --
    // so the prompt must not borrow validation's "is failing"/"Error:"
    // wording for it.
    function policyDiagnostic(over: Partial<Diagnostic> = {}): Diagnostic {
      return {
        id: 'policy-hard-0',
        source: 'policy',
        severity: 'error',
        title: 'You violated this policy because the image is not approved',
        detail: [],
        context: [],
        policyRule: { name: 'require_approved_image', blocking: true },
        ...over,
      };
    }

    it('names the rule and whether it blocks a pipeline, not just the reason', () => {
      const prompt = buildFixPrompt({
        diagnostic: policyDiagnostic(),
        text: TEXT,
        configPath: '/repo/.circleci/config.yml',
      });
      expect(prompt).toContain('Policy rule: require_approved_image');
      expect(prompt).toContain('blocking -- would refuse a pipeline');
      expect(prompt).toContain(
        'You violated this policy because the image is not approved',
      );
    });

    it('does not claim the config is failing validation', () => {
      const prompt = buildFixPrompt({
        diagnostic: policyDiagnostic(),
        text: TEXT,
        configPath: '/repo/.circleci/config.yml',
      });
      expect(prompt).not.toContain('is failing validation');
      expect(prompt).toContain('flagged by an organization config policy');
      expect(prompt).toContain('Policy message:');
      expect(prompt).not.toContain('\nError:');
    });

    it('says a soft failure does not block a pipeline', () => {
      const prompt = buildFixPrompt({
        diagnostic: policyDiagnostic({
          policyRule: { name: 'prefer_release_branch', blocking: false },
        }),
        text: TEXT,
        configPath: '/repo/.circleci/config.yml',
      });
      expect(prompt).toContain(
        'Policy rule: prefer_release_branch (non-blocking -- recorded but does not refuse a pipeline)',
      );
    });
  });
});
