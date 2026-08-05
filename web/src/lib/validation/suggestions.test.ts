import { describe, expect, it } from 'vitest';

import { serializeMinimalDiff } from '~/lib/yaml/spliceSerialize';
import { cloneDocument, parseConfig } from '~/lib/yaml/documentUtils';

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
} from './apiFixtures';
import { groupCompileErrors, type Diagnostic } from './diagnostics';
import {
  editDistance,
  nearestUnique,
  orbVersionSuggestion,
  suggestionsFor,
  type Suggestion,
} from './suggestions';

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

function suggest(messages: string[], text: string): Suggestion[] {
  const { doc } = parseConfig(text);
  return suggestionsFor(diagnosticFrom(messages), doc);
}

/**
 * Applies `suggestion` exactly the way `appStore.mutate` does -- clone, apply,
 * splice only the changed range back into the original text -- and
 * returns the resulting text. This is the harness for the guarantee that
 * matters most about an applied fix: it is a surgical AST mutation, so nothing
 * outside the edited range is re-emitted.
 */
function applyLikeStore(text: string, suggestion: Suggestion): string {
  const { doc } = parseConfig(text);
  if (!doc) throw new Error('fixture does not parse');
  const clone = cloneDocument(doc);
  suggestion.apply(clone);
  const { doc: forRanges } = parseConfig(text);
  return forRanges
    ? serializeMinimalDiff(text, forRanges, clone)
    : clone.toString();
}

describe('editDistance', () => {
  it('scores an adjacent transposition as one edit, which plain Levenshtein would not', () => {
    expect(editDistance('stpes', 'steps')).toBe(1);
    expect(editDistance('chekcout', 'checkout')).toBe(1);
  });

  it('scores an insertion as one edit', () => {
    expect(editDistance('imag', 'image')).toBe(1);
  });

  it('is zero for identical strings', () => {
    expect(editDistance('steps', 'steps')).toBe(0);
  });
});

describe('nearestUnique', () => {
  it('picks the single closest candidate', () => {
    expect(nearestUnique('stpes', ['steps', 'shell', 'docker'])).toBe('steps');
  });

  it('declines a tie rather than choosing one', () => {
    // `cat` is one edit from both. Ambiguity is not a coin flip.
    expect(nearestUnique('cat', ['car', 'bat'])).toBeUndefined();
  });

  it('declines when nothing is within two edits', () => {
    expect(nearestUnique('completely-different', ['steps'])).toBeUndefined();
  });

  it('declines when the distance is as large as the shorter word, so short names cannot near-match', () => {
    expect(nearestUnique('os', ['at'])).toBeUndefined();
  });

  it('declines when the candidate list already contains the exact name', () => {
    expect(nearestUnique('steps', ['steps', 'stpes'])).toBeUndefined();
  });
});

describe("suggestions offered: a misspelled key, against CircleCI's own permitted list", () => {
  const config = `# Managed by the platform team -- do not edit by hand.
version: 2.1

jobs:
  # The main build.
  build:
    docker:
      - image: cimg/base:stable # pinned deliberately
    stpes:
      - checkout
`;

  it('offers exactly one rename, to the permitted key CircleCI listed', () => {
    const suggestions = suggest(SCHEMA_EXTRANEOUS_KEY, config);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.label).toBe('Rename "stpes" to "steps"');
  });

  it('says where the candidate came from, so the user can check rather than trust', () => {
    expect(suggest(SCHEMA_EXTRANEOUS_KEY, config)[0]?.rationale).toContain(
      'CircleCI listed the keys permitted here',
    );
  });

  it('applies as a surgical mutation, leaving every comment and all formatting intact', () => {
    const suggestion = suggest(SCHEMA_EXTRANEOUS_KEY, config)[0];
    expect(suggestion).toBeDefined();
    const after = applyLikeStore(config, suggestion as Suggestion);

    // The fix landed...
    expect(after).toContain('    steps:\n');
    expect(after).not.toContain('stpes');
    // ...and nothing else moved. Every comment survives, in place.
    expect(after).toContain(
      '# Managed by the platform team -- do not edit by hand.',
    );
    expect(after).toContain('  # The main build.');
    expect(after).toContain('image: cimg/base:stable # pinned deliberately');
    // The blank line after `version: 2.1` is not reflowed away.
    expect(after).toContain('version: 2.1\n\njobs:');
    // And, precisely: exactly one line differs from the original.
    const changed = after
      .split('\n')
      .filter((line, index) => line !== config.split('\n')[index]);
    expect(changed).toEqual(['    steps:']);
  });

  it('renames a key nested under a sequence index', () => {
    const nested = `version: 2.1
jobs:
  build:
    docker:
      - imag: cimg/base:stable # keep this comment
    steps:
      - checkout
`;
    const suggestion = suggest(SCHEMA_EXTRANEOUS_KEY_NESTED, nested)[0];
    expect(suggestion?.label).toBe('Rename "imag" to "image"');
    const after = applyLikeStore(nested, suggestion as Suggestion);
    expect(after).toContain('- image: cimg/base:stable # keep this comment');
  });

  it('declines when the permitted key is already present, since the rename could not apply', () => {
    const collides = `version: 2.1
jobs:
  build:
    steps:
      - checkout
    stpes:
      - checkout
`;
    expect(suggest(SCHEMA_EXTRANEOUS_KEY, collides)).toEqual([]);
  });
});

describe('suggestions offered: an unknown job in requires:', () => {
  const config = `version: 2.1
jobs:
  build:
    steps: [checkout]
  test:
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
      - test:
          # waits for the build
          requires:
            - biuld
`;
  const message = [
    "Job 'test' requires 'biuld', which is the name of 0 other jobs in workflow 'main'",
  ];

  it('offers the near-matching alias from this workflow, plus removing the dependency', () => {
    const suggestions = suggest(message, config);
    expect(suggestions.map((s) => s.id)).toEqual([
      'requires-rename',
      'requires-remove',
    ]);
    expect(suggestions[0]?.label).toBe('Change requires: "biuld" to "build"');
  });

  it('flags the removal as behaviour-changing and says what it costs', () => {
    const remove = suggest(message, config)[1];
    expect(remove?.changesBehavior).toBe(true);
    expect(remove?.rationale).toContain('will no longer wait');
  });

  it('renames in place, keeping the comment above the requires: block', () => {
    const after = applyLikeStore(
      config,
      suggest(message, config)[0] as Suggestion,
    );
    expect(after).toContain('- build\n');
    expect(after).toContain('          # waits for the build');
    expect(after).not.toContain('biuld');
  });

  it('offers only the removal when the id is nothing like any job -- the deleted-job case', () => {
    // `nonexistent` is not a typo of `build`; a job that used to exist and was
    // deleted leaves exactly this. Dropping the dependency is then the only
    // mechanical fix, and it is offered as such.
    const orphaned = config.replace('- biuld', '- nonexistent');
    const suggestions = suggest(
      [
        "Job 'test' requires 'nonexistent', which is the name of 0 other jobs in workflow 'main'",
      ],
      orphaned,
    );
    expect(suggestions.map((s) => s.id)).toEqual(['requires-remove']);
    const after = applyLikeStore(orphaned, suggestions[0] as Suggestion);
    expect(after).not.toContain('nonexistent');
    // Removing the last requirement collapses the entry back to a bare
    // string, which is `removeRequire`'s existing behaviour -- reused, not
    // reimplemented.
    expect(after).toContain('      - test\n');
  });

  it('declines entirely when the id appears twice in the same requires:', () => {
    const ambiguous = config.replace(
      '            - biuld',
      '            - biuld\n            - biuld',
    );
    expect(suggest(message, ambiguous)).toEqual([]);
  });
});

describe('suggestions offered: executors, steps and workflow job names', () => {
  it("offers the near-matching executor from this config's own executors:", () => {
    const config = `version: 2.1
executors:
  builder:
    docker: [{ image: cimg/base:stable }]
jobs:
  build:
    executor: bulider
    steps: [checkout]
`;
    const messages = [
      "Error calling workflow: 'main'",
      "Error calling job: 'build'",
      'Cannot find a definition for executor named bulider',
    ];
    const suggestions = suggest(messages, config);
    expect(suggestions[0]?.label).toBe('Use executor "builder"');
    expect(applyLikeStore(config, suggestions[0] as Suggestion)).toContain(
      'executor: builder',
    );
  });

  it('declines an executor with no near match rather than inventing an inline one', () => {
    const config = `version: 2.1
executors:
  builder:
    docker: [{ image: cimg/base:stable }]
jobs:
  build:
    executor: nope
    steps: [checkout]
`;
    expect(suggest(UNKNOWN_EXECUTOR, config)).toEqual([]);
  });

  it('offers the built-in step a misspelling is one edit away from', () => {
    const config = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    steps:
      - chekcout # first thing we do
`;
    const suggestions = suggest(UNKNOWN_COMMAND, config);
    expect(suggestions[0]?.label).toBe('Rename step "chekcout" to "checkout"');
    expect(suggestions[0]?.rationale).toContain('built-in CircleCI step');
    const after = applyLikeStore(config, suggestions[0] as Suggestion);
    expect(after).toContain('- checkout # first thing we do');
  });

  it("offers a locally-declared command, and says it is this config's own", () => {
    const config = `version: 2.1
commands:
  install_deps:
    steps: [checkout]
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    steps:
      - install_dpes
`;
    const messages = [
      "Error calling workflow: 'main'",
      "Error calling job: 'build'",
      'Cannot find a definition for command named install_dpes',
    ];
    expect(suggest(messages, config)[0]?.rationale).toContain(
      'a command this config declares',
    );
  });

  it("declines an orb-qualified command name -- correcting it would need the orb's command list", () => {
    const config = `version: 2.1
orbs:
  slack: circleci/slack@4.13.3
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    steps:
      - slack/notifyy
`;
    const messages = [
      "Error calling workflow: 'main'",
      "Error calling job: 'build'",
      'Cannot find a definition for command named slack/notifyy',
    ];
    expect(suggest(messages, config)).toEqual([]);
  });

  it('offers the near-matching job name for a workflow entry', () => {
    const config = `version: 2.1
jobs:
  notdefine:
    steps: [checkout]
workflows:
  main:
    jobs:
      - notdefined
`;
    const suggestions = suggest(UNKNOWN_WORKFLOW_JOB, config);
    expect(suggestions[0]?.label).toBe('Change "notdefined" to "notdefine"');
    expect(applyLikeStore(config, suggestions[0] as Suggestion)).toContain(
      '- notdefine\n',
    );
  });
});

describe('suggestions deliberately declined', () => {
  const anything = 'version: 2.1\njobs:\n  build:\n    steps: [checkout]\n';

  it('offers nothing for a dependency cycle -- which edge to cut is a design decision', () => {
    for (const message of CYCLE) {
      expect(suggest([message], anything)).toEqual([]);
    }
  });

  it('offers nothing for a missing version:, which governs how the whole file is read', () => {
    expect(suggest(MISSING_VERSION, anything)).toEqual([]);
  });

  it('offers nothing offline for an unresolvable orb -- the registry has to be asked', () => {
    const config = `version: 2.1
orbs:
  slack: circleci/slack@99.99.99
`;
    expect(suggest(ORB_NOT_FOUND, config)).toEqual([]);
  });

  it('never acts on the "required key [type] not found" branch of a schema report', () => {
    // The report for a misspelled `steps:` also says `required key [type] not
    // found` (the `oneOf` branch for "a string reference to another job").
    // Acting on that would add `type:` to a job that never wanted it.
    const config = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    stpes: [checkout]
`;
    const suggestions = suggest(SCHEMA_EXTRANEOUS_KEY, config);
    expect(suggestions).toHaveLength(1);
    expect(suggestions.map((s) => s.label).join()).not.toContain('type');
  });

  it('offers nothing when the document is not available at all', () => {
    expect(suggestionsFor(diagnosticFrom(UNKNOWN_REQUIRES), null)).toEqual([]);
  });
});

describe('orbVersionSuggestion', () => {
  const published = {
    versions: ['4.13.3', '4.13.2', '4.12.0'],
    latestVersion: '4.13.3',
  };

  it("offers the registry's latest published version, and only the version", () => {
    const suggestion = orbVersionSuggestion(
      'circleci/slack@99.99.99',
      'circleci/slack',
      '99.99.99',
      published,
    );
    expect(suggestion?.label).toBe('Use circleci/slack@4.13.3');
    expect(suggestion?.rationale).toContain('left exactly as you wrote it');
  });

  it('rewrites only the orbs: value, keeping the alias and its comment', () => {
    const config = `version: 2.1
orbs:
  # notifications
  slack: circleci/slack@99.99.99 # bump me
jobs:
  build:
    steps: [checkout]
`;
    const suggestion = orbVersionSuggestion(
      'circleci/slack@99.99.99',
      'circleci/slack',
      '99.99.99',
      published,
    );
    const after = applyLikeStore(config, suggestion as Suggestion);
    expect(after).toContain('slack: circleci/slack@4.13.3 # bump me');
    expect(after).toContain('  # notifications');
  });

  it('offers nothing when the requested version does exist -- the fault is elsewhere', () => {
    expect(
      orbVersionSuggestion(
        'circleci/slack@4.12.0',
        'circleci/slack',
        '4.12.0',
        published,
      ),
    ).toBeUndefined();
  });

  it('offers nothing when the registry answered with no versions at all', () => {
    expect(
      orbVersionSuggestion('a/b@1.0.0', 'a/b', '1.0.0', {}),
    ).toBeUndefined();
  });

  it('never proposes a different orb name', () => {
    const suggestion = orbVersionSuggestion(
      'circleci/nodee@5.2.0',
      'circleci/nodee',
      '5.2.0',
      { versions: ['1.0.0'], latestVersion: '1.0.0' },
    );
    expect(suggestion?.label).toContain('circleci/nodee@');
    expect(suggestion?.label).not.toContain('circleci/node@');
  });
});
