import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from '~/state/projectContextStore';

import { createEnvVarCompletionSource } from './envVarCompletion';

/**
 * The completion source only ever reads `state.doc.toString()` and `pos`, so a
 * stand-in with those two is enough -- the same shape `completion.test.ts`'s
 * own `fakeContext` uses, and for the same reason (no real `EditorState`).
 */
function fakeContext(text: string, pos: number) {
  return {
    state: { doc: { toString: () => text } },
    pos,
  } as unknown as Parameters<
    ReturnType<typeof createEnvVarCompletionSource>
  >[0];
}

/** Puts `names` in the store as if `GET /api/project-context` had returned them. */
function withProjectVariables(names: string[]): void {
  useProjectContextStore.setState({
    state: 'ready',
    projectVariables: names.map((name) => ({ name })),
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
