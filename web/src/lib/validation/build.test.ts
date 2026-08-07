import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  ORB_NOT_FOUND,
  SCHEMA_EXTRANEOUS_KEY,
  UNKNOWN_EXECUTOR,
} from './apiFixtures';
import {
  buildDiagnostics,
  localDiagnostics,
  sortDiagnostics,
  topLevelKeyDiagnostics,
} from './build';
import type { DiagnosticsSource } from './build';

const BROKEN = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    stpes: [checkout]
workflows:
  main:
    jobs:
      - build:
          requires:
            - nonexistent
`;

function source(over: Partial<DiagnosticsSource> = {}): DiagnosticsSource {
  const text = over.text ?? BROKEN;
  const { doc, error } = parseConfig(text);
  return {
    doc,
    text,
    parseError: error,
    validation: { state: 'idle', errors: [] },
    ...over,
  };
}

describe('buildDiagnostics: which source is speaking', () => {
  it('attributes compile errors to CircleCI, and only when the API actually ran', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'invalid',
          errors: SCHEMA_EXTRANEOUS_KEY.map((message) => ({ message })),
        },
      }),
    );
    expect(result.state).toBe('invalid');
    expect(result.source).toBe('circleci');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.source).toBe('circleci');
  });

  it('never claims CircleCI said anything when validation was unavailable', () => {
    // The core honesty requirement: with no token nothing was compiled, so
    // whatever is on screen has to be labelled as this app's own checking.
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'unavailable',
          errors: [],
          reason:
            'no CircleCI API token available; validation requires a token',
        },
      }),
    );
    expect(result.state).toBe('localOnly');
    expect(result.source).toBe('local');
    expect(result.diagnostics.every((d) => d.source === 'local')).toBe(true);
    expect(result.degradedReason).toContain('token');
  });

  it('degrades to local checks, not silence, when the request itself failed', () => {
    const result = buildDiagnostics(
      source({
        validation: { state: 'error', errors: [], reason: 'network down' },
      }),
    );
    expect(result.state).toBe('localOnly');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.degradedReason).toBe('network down');
  });

  // Issue #224: a rejected token still means CircleCI's compiler produced no
  // verdict, exactly like `unavailable`/`error` -- it degrades to the
  // identical offline fallback, distinguished only by `degradedReason`.
  it('degrades to local checks for a rejected token too, same as unavailable/error', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'unauthorized',
          errors: [],
          reason: 'the CircleCI API rejected the configured token (HTTP 401).',
        },
      }),
    );
    expect(result.state).toBe('localOnly');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.degradedReason).toContain('401');
  });

  it('reports a valid config as valid, with nothing to show', () => {
    const result = buildDiagnostics(
      source({ validation: { state: 'valid', errors: [] } }),
    );
    expect(result.state).toBe('valid');
    expect(result.diagnostics).toEqual([]);
    expect(result.source).toBeNull();
  });

  it('holds the previous result while a new check is in flight, rather than blanking', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'checking',
          errors: ORB_NOT_FOUND.map((message) => ({ message })),
        },
      }),
    );
    expect(result.state).toBe('checking');
    expect(result.diagnostics).toHaveLength(1);
  });

  it('shows nothing while the YAML does not parse -- that error has its own surfacing', () => {
    const result = buildDiagnostics(
      source({
        text: 'version: 2.1\n  bad indent\n',
        parseError: 'bad indentation',
        validation: { state: 'invalid', errors: [{ message: 'anything' }] },
      }),
    );
    expect(result.state).toBe('unknown');
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to local findings when an invalid verdict carried nothing groupable', () => {
    const result = buildDiagnostics(
      source({ validation: { state: 'invalid', errors: [] } }),
    );
    expect(result.state).toBe('invalid');
    expect(result.source).toBe('local');
  });

  it('shows nothing before any check has run', () => {
    expect(buildDiagnostics(source()).diagnostics).toEqual([]);
  });

  // Issue #145: a file that isn't a CircleCI config gets no diagnostics at
  // all, not even the local structural checks -- those check `workflows:`/
  // `requires:`, which a file classified as not a config was never
  // expected to have, and the `localOnly` state's own footnote ("this
  // config has not been compiled by CircleCI") would misrepresent a file
  // that isn't a config to begin with.
  it('shows nothing for a file the host classified as not a CircleCI config', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'not-a-config',
          errors: [],
          reason: 'No CircleCI structure: has "command:", not "commands:".',
        },
      }),
    );
    expect(result.state).toBe('unknown');
    expect(result.diagnostics).toEqual([]);
    expect(result.source).toBeNull();
  });
});

// Issue #5: `workflow:` in place of `workflows:` compiles `valid: true` on
// the live API with an empty `errors` array (verified against
// `compile-config-with-defaults` -- see this change's PR description), so a
// config that will run nothing looks identical, everywhere else in this
// app, to one that's actually fine. These pin the one check this app raises
// about that on its own.
describe('buildDiagnostics: issue #5, an unrecognised top-level key', () => {
  const TYPO = `version: 2.1
workflow:
  main:
    jobs:
      - build
jobs:
  build:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
`;

  it('warns on "workflow", the near miss of "workflows" issue #5 was filed over, even though CircleCI says valid', () => {
    const result = buildDiagnostics(
      source({ text: TYPO, validation: { state: 'valid', errors: [] } }),
    );
    // The compiler's own verdict is not overruled...
    expect(result.state).toBe('valid');
    // ...but this app's own warning still shows, clearly not attributed to
    // CircleCI.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.source).toBe('local');
    expect(result.diagnostics[0]?.source).toBe('local');
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.diagnostics[0]?.title).toContain('"workflow"');
    expect(result.diagnostics[0]?.title).toContain('"workflows"');
  });

  it('stays silent on an unrecognised top-level key that is not a near miss of anything', () => {
    // `notifications` is not within a typo's distance of any known top-level
    // key -- it reads as a deliberate addition, not a typo, and issue #5 is
    // explicit that this app must not nag about that.
    const deliberate = `version: 2.1
notifications:
  webhook: https://example.com/hook
jobs:
  build:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;
    const result = buildDiagnostics(
      source({
        text: deliberate,
        validation: { state: 'valid', errors: [] },
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.source).toBeNull();
  });

  it('produces no warning at all for a config with only recognised top-level keys', () => {
    const clean = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;
    const result = buildDiagnostics(
      source({ text: clean, validation: { state: 'valid', errors: [] } }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.source).toBeNull();
  });

  it("locates the warning at the misspelled key's own line", () => {
    const { doc } = parseConfig(TYPO);
    const [diagnostic] = topLevelKeyDiagnostics(doc, TYPO);
    // Asserts the fields this test is about rather than deep-equalling the
    // whole location: `DiagnosticLocation` also carries the optional
    // `endLine`/`endColumn` the inline underlines need, and a whole-object
    // comparison here failed the moment those were added -- an
    // over-specified assertion breaking on a change that could not affect
    // what this test checks.
    expect(diagnostic?.location).toMatchObject({
      line: 2,
      column: 1,
      basis: 'resolved',
    });
  });
});

describe('buildDiagnostics: locations', () => {
  it('resolves a schema path to the line holding the offending key', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'invalid',
          errors: SCHEMA_EXTRANEOUS_KEY.map((message) => ({ message })),
        },
      }),
    );
    expect(result.diagnostics[0]?.location).toEqual({
      line: 5,
      column: 5,
      basis: 'resolved',
      // Issue #9: `endColumn` is the offending key's own width ("stpes" is
      // 5 characters), not the rest of the line -- the inline squiggle
      // underlines just the key, not everything after it.
      endLine: 5,
      endColumn: 10,
    });
  });

  it('leaves an unplaceable error unplaced rather than guessing', () => {
    const result = buildDiagnostics(
      source({
        validation: {
          state: 'invalid',
          // A real message naming an executor this config doesn't mention at
          // all: nothing to resolve, so nothing is claimed.
          errors: UNKNOWN_EXECUTOR.map((message) => ({ message })),
        },
      }),
    );
    expect(result.diagnostics[0]?.location).toBeUndefined();
    expect(result.diagnostics[0]?.title).toBe(
      'Cannot find a definition for executor named nope',
    );
  });
});

describe('localDiagnostics', () => {
  it('finds a broken requires: with no network, no token and no API result', () => {
    const { doc } = parseConfig(BROKEN);
    const diagnostics = localDiagnostics(doc, BROKEN);
    const dangling = diagnostics.find((d) => d.target?.kind === 'requires');
    expect(dangling).toBeDefined();
    expect(dangling?.source).toBe('local');
    // And places it, from the document alone -- the `- nonexistent` line.
    expect(dangling?.location?.line).toBe(
      BROKEN.split('\n').findIndex((line) => line.includes('- nonexistent')) +
        1,
    );
  });

  it("uses the graph's own wording rather than paraphrasing it", () => {
    const { doc } = parseConfig(BROKEN);
    expect(localDiagnostics(doc, BROKEN)[0]?.title).toContain(
      'requires unknown job "nonexistent"',
    );
  });

  it('finds nothing in a config with no structural problems', () => {
    const clean = `version: 2.1
jobs:
  build:
    docker: [{ image: cimg/base:stable }]
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
`;
    const { doc } = parseConfig(clean);
    expect(localDiagnostics(doc, clean)).toEqual([]);
  });

  it('returns nothing when there is no document at all', () => {
    expect(localDiagnostics(null, '')).toEqual([]);
  });
});

describe('sortDiagnostics', () => {
  it('puts errors before warnings and is otherwise stable', () => {
    const make = (id: string, severity: 'error' | 'warning') => ({
      id,
      source: 'local' as const,
      severity,
      title: id,
      detail: [],
      context: [],
    });
    expect(
      sortDiagnostics([
        make('w1', 'warning'),
        make('e1', 'error'),
        make('w2', 'warning'),
        make('e2', 'error'),
      ]).map((d) => d.id),
    ).toEqual(['e1', 'e2', 'w1', 'w2']);
  });
});
