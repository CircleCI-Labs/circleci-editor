import type { CompletionContext } from '@codemirror/autocomplete';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ContextDetail } from '~/state/projectContextStore';
import {
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from '~/state/projectContextStore';

import {
  createContextVarCompletionSource,
  createEnvVarCompletionSource,
} from './envVarCompletion';

/**
 * The completion source only ever reads `state.doc.toString()` and `pos`, so a
 * stand-in with those two is enough -- the same shape `completion.test.ts`'s
 * own `fakeContext` uses, and for the same reason (no real `EditorState`).
 */
function fakeContext(text: string, pos: number): CompletionContext {
  return {
    state: { doc: { toString: () => text } },
    pos,
  } as unknown as CompletionContext;
}

/** Puts `names` in the store as if `GET /api/project-context` had returned them. */
function withProjectVariables(names: string[]): void {
  useProjectContextStore.setState({
    state: 'ready',
    projectVariables: names.map((name) => ({ name })),
  });
}

/** A `ContextDetail` with sensible defaults, so a test only has to say what it cares about. */
function contextDetail(overrides: Partial<ContextDetail> = {}): ContextDetail {
  return {
    variables: [],
    usability: 'unrestricted',
    restrictionSummary: '',
    restrictions: [],
    projectIdentified: true,
    warnings: [],
    ...overrides,
  };
}

/**
 * Puts the org's context list and a set of already-fetched context details
 * straight into the store, as if `GET /api/project-context` and
 * `GET /api/project-context/variables` had both already answered.
 *
 * Pre-populating `details` (rather than mocking the RPC client, the way
 * `projectContextStore.test.ts` does to test the *fetch* itself) is
 * deliberate here: `ensureContextDetail` returns a cached entry without
 * making a request, so these tests exercise exactly what
 * `createContextVarCompletionSource` does with the data, not the network
 * path behind it -- which already has its own coverage.
 */
function withContexts(
  contexts: { id: string; name: string; detail?: ContextDetail }[],
): void {
  const details: Record<string, ContextDetail> = {};
  for (const context of contexts) {
    if (context.detail) details[context.id] = context.detail;
  }
  useProjectContextStore.setState({
    state: 'ready',
    contexts: contexts.map(({ id, name }) => ({ id, name })),
    details,
  });
}

/**
 * Runs the source against `text` with the cursor at the `‸` marker (which is
 * stripped before parsing).
 *
 * The marker is `‸`, not `|`: a run command's whole point here is that it is
 * usually written as a `command: |` block literal, so `|` cannot double as a
 * cursor marker in this file's fixtures.
 */
const CURSOR = '‸';

function complete(text: string) {
  const pos = text.indexOf(CURSOR);
  if (pos === -1) throw new Error(`test text needs a ${CURSOR} cursor marker`);
  const source = createEnvVarCompletionSource();
  return source(fakeContext(text.replace(CURSOR, ''), pos));
}

/** Same as `complete`, but against the async context-var source. */
function completeContext(text: string) {
  const pos = text.indexOf(CURSOR);
  if (pos === -1) throw new Error(`test text needs a ${CURSOR} cursor marker`);
  const source = createContextVarCompletionSource();
  return source(fakeContext(text.replace(CURSOR, ''), pos));
}

const BLOCK_LITERAL_COMMAND = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run:
          name: Deploy
          command: |
            make deploy $DEP‸
`;

describe('createEnvVarCompletionSource', () => {
  beforeEach(() => {
    resetProjectContextStoreForTests();
  });

  // The whole point of this being its own source: the schema source bails out
  // inside an opaque scalar, and `command: |` is how run commands are normally
  // written.
  it('completes inside a block-literal run command body', () => {
    withProjectVariables(['DEPLOY_TARGET', 'NPM_TOKEN']);

    const result = complete(BLOCK_LITERAL_COMMAND);
    expect(result).not.toBeNull();
    expect(result?.options.map((o) => o.label)).toEqual([
      '$DEPLOY_TARGET',
      '$NPM_TOKEN',
    ]);
  });

  // `from` must be the `$`, not the start of the scalar -- otherwise applying a
  // completion would replace the whole command.
  it('replaces only the $reference, not the surrounding command', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    const text = BLOCK_LITERAL_COMMAND.replace(CURSOR, '');
    const pos = BLOCK_LITERAL_COMMAND.indexOf(CURSOR);
    const result = complete(BLOCK_LITERAL_COMMAND);

    expect(result?.from).toBe(text.lastIndexOf('$DEP'));
    expect(result?.to).toBe(pos);
    expect(text.slice(result?.from, result?.to)).toBe('$DEP');
  });

  it('completes in the shorthand `run:` form', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    const result = complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo $DEP‸
`);
    expect(result?.options.map((o) => o.label)).toEqual(['$DEPLOY_TARGET']);
  });

  it('completes a braced ${NAME} reference, and keeps the braces', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    const result = complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo \${DEP‸
`);
    expect(result?.options.map((o) => o.label)).toEqual(['${DEPLOY_TARGET}']);
  });

  it('offers every name for a bare $ with no prefix typed yet', () => {
    withProjectVariables(['A_VAR', 'B_VAR']);

    const result = complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo $‸
`);
    expect(result?.options).toHaveLength(2);
  });

  // Requiring the sigil is what keeps a completion list from popping up on
  // every character of a shell script.
  it('proposes nothing without a $ sigil', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    expect(
      complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo DEP‸
`),
    ).toBeNull();
  });

  it('ignores $$ (the shell PID) and an escaped \\$', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    expect(
      complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo $$‸
`),
    ).toBeNull();

    expect(
      complete(`version: 2.1
jobs:
  build:
    steps:
      - run: echo \\$‸
`),
    ).toBeNull();
  });

  // The parser-based container check earns its keep here: a line-scanning
  // implementation walking back for the nearest less-indented line would find
  // the `if` and give up.
  it('still completes inside an indented shell construct', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    const result = complete(`version: 2.1
jobs:
  build:
    steps:
      - run:
          command: |
            if true; then
              echo $DEP‸
            fi
`);
    expect(result?.options.map((o) => o.label)).toEqual(['$DEPLOY_TARGET']);
  });

  it('proposes nothing outside a run command', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    expect(
      complete(`version: 2.1
jobs:
  build:
    docker:
      - image: $DEP‸
`),
    ).toBeNull();
  });

  // Degrading honestly: with no token the store never leaves `unavailable`, so
  // there are no names, and this must stay out of the way of the schema source
  // rather than returning an empty result that suppresses it.
  it('returns null (not an empty result) when no variables are known', () => {
    expect(complete(BLOCK_LITERAL_COMMAND)).toBeNull();
  });

  // `parseDocument` collects errors rather than throwing, and that leniency is
  // deliberate here: a syntax error elsewhere in the file should not silently
  // switch these completions off in the command you are currently editing.
  // What matters is that a malformed document never throws out of the source.
  it('tolerates a malformed document without throwing', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    expect(() =>
      complete('jobs:\n  build:\n   - : : :\n    run: echo $DEP‸\n'),
    ).not.toThrow();
  });

  it('never mentions a value, because there is none to mention', () => {
    withProjectVariables(['DEPLOY_TARGET']);

    const result = complete(BLOCK_LITERAL_COMMAND);
    expect(result?.options[0]?.detail).toBe('project env var');
    expect(result?.options[0]?.info).toMatch(/never available to this editor/);
  });
});

/** A job that a workflow invokes with one attached context (issue #23's own example). */
const JOB_WITH_ATTACHED_CONTEXT = `version: 2.1
jobs:
  deploy:
    docker:
      - image: cimg/base:2024.01
    steps:
      - run: echo $DEP‸
workflows:
  release:
    jobs:
      - deploy:
          context: [deploy-prod]
`;

describe('createContextVarCompletionSource', () => {
  beforeEach(() => {
    resetProjectContextStoreForTests();
  });

  it('completes a variable held by a context this job attaches', async () => {
    withContexts([
      {
        id: 'ctx-1',
        name: 'deploy-prod',
        detail: contextDetail({
          variables: [{ name: 'DEPLOY_KEY', truncatedValue: 'ab12' }],
        }),
      },
    ]);

    const result = await completeContext(JOB_WITH_ATTACHED_CONTEXT);
    expect(result?.options.map((o) => o.label)).toEqual(['$DEPLOY_KEY']);
  });

  // The core rule issue #23 asks for: a context this token can read, with
  // variables of its own, offers nothing here unless *this job* actually
  // attaches it -- offering every context the organization has would be
  // exactly the "looks like a guarantee" failure the issue names.
  it('does not offer a variable from a context this job does not attach', async () => {
    withContexts([
      {
        id: 'ctx-other',
        name: 'unrelated-context',
        detail: contextDetail({
          variables: [{ name: 'OTHER_SECRET', truncatedValue: 'zz99' }],
        }),
      },
    ]);

    expect(await completeContext(JOB_WITH_ATTACHED_CONTEXT)).toBeNull();
  });

  it('does not offer a variable from a sibling job’s context', async () => {
    withContexts([
      {
        id: 'ctx-lint',
        name: 'lint-only',
        detail: contextDetail({
          variables: [{ name: 'LINT_TOKEN', truncatedValue: '11aa' }],
        }),
      },
    ]);

    const result = await completeContext(`version: 2.1
jobs:
  deploy:
    steps:
      - run: echo $DEP‸
  lint:
    steps:
      - run: echo $LINT_TOKEN
workflows:
  release:
    jobs:
      - deploy
      - lint:
          context: [lint-only]
`);
    expect(result).toBeNull();
  });

  // Degrading honestly, the way `createEnvVarCompletionSource` already does
  // for project variables: with no token (or before the org's context list
  // has loaded) this must be absent, not an empty-but-present result that
  // could be mistaken for "this job's contexts hold nothing".
  it('returns null with no token, rather than an empty result', async () => {
    useProjectContextStore.setState({ state: 'unavailable' });
    expect(await completeContext(JOB_WITH_ATTACHED_CONTEXT)).toBeNull();
  });

  it('returns null while the org’s context list is still loading', async () => {
    useProjectContextStore.setState({ state: 'loading' });
    expect(await completeContext(JOB_WITH_ATTACHED_CONTEXT)).toBeNull();
  });

  // A context whose own variable listing failed reports that as a warning
  // and an empty `variables` list (see `fetchContextVariables` on the host) --
  // never as "there are none". This source must not turn that degraded
  // fetch into a confident "this context is empty" either: it simply has
  // nothing to offer from it, the same as if the context had never loaded.
  it('offers nothing from a context whose variable listing failed (degraded, not empty)', async () => {
    withContexts([
      {
        id: 'ctx-1',
        name: 'deploy-prod',
        detail: contextDetail({
          variables: [],
          warnings: [
            {
              kind: 'contextVariables',
              headline: "This context's variables could not be listed.",
            },
          ],
        }),
      },
    ]);

    expect(await completeContext(JOB_WITH_ATTACHED_CONTEXT)).toBeNull();
  });

  // A `command:`/`run:` scalar outside any `jobs.<name>` -- a reusable
  // command's own body -- has no job to look up contexts for.
  it('returns null for a run command outside any job', async () => {
    withContexts([
      {
        id: 'ctx-1',
        name: 'deploy-prod',
        detail: contextDetail({
          variables: [{ name: 'DEPLOY_KEY', truncatedValue: 'ab12' }],
        }),
      },
    ]);

    const result = await completeContext(`version: 2.1
commands:
  deploy:
    steps:
      - run: echo $DEP‸
`);
    expect(result).toBeNull();
  });

  it('names the attaching context and never a value, in the info line', async () => {
    withContexts([
      {
        id: 'ctx-1',
        name: 'deploy-prod',
        detail: contextDetail({
          variables: [{ name: 'DEPLOY_KEY', truncatedValue: 'ab12' }],
        }),
      },
    ]);

    const result = await completeContext(JOB_WITH_ATTACHED_CONTEXT);
    expect(result?.options[0]?.detail).toBe('context env var');
    expect(result?.options[0]?.info).toContain('"deploy-prod"');
    expect(result?.options[0]?.info).not.toContain('ab12');
    expect(result?.options[0]?.info).toMatch(/never available to this editor/);
  });
});
