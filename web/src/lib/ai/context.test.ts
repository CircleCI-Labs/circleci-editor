import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';
import type { ConfigFileInfo } from '~/lib/rpc/client';

import {
  buildAiContext,
  buildDirectoryContext,
  DIRECTORY_CONTEXT_TOKEN_BUDGET,
  estimateTokens,
} from './context';
import type { AiContextSource } from './context';

const CONFIG_TEXT = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;

function sourceState(
  overrides: Partial<AiContextSource> = {},
): AiContextSource {
  const { doc } = parseConfig(CONFIG_TEXT);
  return {
    configPath: '/repo/.circleci/config.yml',
    text: CONFIG_TEXT,
    doc,
    validation: { errors: [] },
    ...overrides,
  };
}

describe('buildAiContext', () => {
  it('derives job/workflow names from the parsed document, plus the raw text and path', () => {
    const context = buildAiContext(sourceState());
    expect(context).toEqual({
      configPath: '/repo/.circleci/config.yml',
      configText: CONFIG_TEXT,
      jobNames: ['build'],
      workflowNames: ['main'],
      validationErrors: [],
      otherFiles: [],
      skippedFiles: [],
      policyViolations: [],
    });
  });

  // Issue #247 item 6.
  it('carries policy violations through, defaulting to empty when absent', () => {
    expect(buildAiContext(sourceState()).policyViolations).toEqual([]);

    const violations = [{ rule: 'r', reason: 'nope', blocking: true }];
    const context = buildAiContext(
      sourceState({ policyViolations: violations }),
    );
    expect(context.policyViolations).toEqual(violations);
  });

  it('carries a supplied directory context through untouched (issue #102)', () => {
    const directory = {
      otherFiles: [
        { path: '/repo/.circleci/continue-config.yml', text: 'version: 2.1\n' },
      ],
      skippedFiles: [
        { path: '/repo/.circleci/huge.yml', reason: 'token budget exceeded' },
      ],
    };
    const context = buildAiContext(sourceState(), directory);
    expect(context.otherFiles).toEqual(directory.otherFiles);
    expect(context.skippedFiles).toEqual(directory.skippedFiles);
  });

  it('carries validation error messages through as plain strings', () => {
    const context = buildAiContext(
      sourceState({
        validation: { errors: [{ message: 'job "broken" not found' }] },
      }),
    );
    expect(context.validationErrors).toEqual(['job "broken" not found']);
  });

  it('degrades to empty job/workflow lists when there is no parsed document (a YAML parse error)', () => {
    const context = buildAiContext(
      sourceState({ doc: null, text: 'not: valid: yaml: at all' }),
    );
    expect(context.jobNames).toEqual([]);
    expect(context.workflowNames).toEqual([]);
    // The raw (unparseable) text is still sent -- the assistant can still
    // usefully comment on why it doesn't parse.
    expect(context.configText).toBe('not: valid: yaml: at all');
  });
});

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is roughly text length divided by four, rounded up', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

function fileInfo(overrides: Partial<ConfigFileInfo> = {}): ConfigFileInfo {
  return {
    path: '/repo/.circleci/continue-config.yml',
    relPath: 'continue-config.yml',
    size: 20,
    isPrimary: false,
    isConfig: true,
    configReason: 'Has CircleCI top-level keys: jobs, workflows.',
    ...overrides,
  };
}

describe('buildDirectoryContext', () => {
  const activePath = '/repo/.circleci/config.yml';

  it('excludes the active file itself', () => {
    const { otherFiles } = buildDirectoryContext(activePath, [
      fileInfo({
        path: activePath,
        relPath: 'config.yml',
        contents: 'version: 2.1\n',
      }),
    ]);
    expect(otherFiles).toEqual([]);
  });

  it('includes a sibling file with fetched contents, in relPath order', () => {
    const { otherFiles, skippedFiles } = buildDirectoryContext(activePath, [
      fileInfo({
        path: '/repo/.circleci/setup.yml',
        relPath: 'setup.yml',
        contents: 'setup: true\n',
      }),
      fileInfo({
        path: '/repo/.circleci/continue-config.yml',
        relPath: 'continue-config.yml',
        contents: 'version: 2.1\n',
      }),
    ]);
    expect(skippedFiles).toEqual([]);
    expect(otherFiles.map((f) => f.path)).toEqual([
      '/repo/.circleci/continue-config.yml',
      '/repo/.circleci/setup.yml',
    ]);
  });

  it('skips (not truncates) a file whose contents were never fetched', () => {
    const { otherFiles, skippedFiles } = buildDirectoryContext(activePath, [
      fileInfo({ contents: undefined }),
    ]);
    expect(otherFiles).toEqual([]);
    expect(skippedFiles).toEqual([
      {
        path: '/repo/.circleci/continue-config.yml',
        reason: 'contents unavailable',
      },
    ]);
  });

  it('skips a file the host itself omitted for being too large', () => {
    const { otherFiles, skippedFiles } = buildDirectoryContext(activePath, [
      fileInfo({ omitted: true, contents: undefined }),
    ]);
    expect(otherFiles).toEqual([]);
    expect(skippedFiles).toEqual([
      {
        path: '/repo/.circleci/continue-config.yml',
        reason: 'too large to load',
      },
    ]);
  });

  it('stops including files once the token budget would be exceeded, reporting the rest as skipped rather than truncating any one of them', () => {
    const big = 'x'.repeat(40); // 10 tokens each at ~4 chars/token
    const files = [
      fileInfo({ path: '/a.yml', relPath: 'a.yml', contents: big }),
      fileInfo({ path: '/b.yml', relPath: 'b.yml', contents: big }),
      fileInfo({ path: '/c.yml', relPath: 'c.yml', contents: big }),
    ];
    const { otherFiles, skippedFiles } = buildDirectoryContext(
      activePath,
      files,
      /* budgetTokens */ 15,
    );
    // Only the first (10 tokens) fits under a 15-token budget; the second
    // would push the running total to 20, so it -- and everything after it
    // in order -- is reported skipped, never partially included.
    expect(otherFiles.map((f) => f.path)).toEqual(['/a.yml']);
    expect(skippedFiles).toEqual([
      { path: '/b.yml', reason: 'token budget exceeded' },
      { path: '/c.yml', reason: 'token budget exceeded' },
    ]);
  });

  // Issue #146: the model must not reason about a non-config sibling (a
  // goss/Compose/tooling YAML file) as though it were a pipeline it could
  // propose an edit to. The host's own classification (#135) is reused
  // rather than re-derived, so this label and the switcher's/appStore's
  // (#145) can never disagree about the same file.
  it("labels a non-config sibling, and reuses the host's own configReason verbatim", () => {
    const { otherFiles } = buildDirectoryContext(activePath, [
      fileInfo({
        path: '/repo/.circleci/goss.yaml',
        relPath: 'goss.yaml',
        isConfig: false,
        configReason: 'No CircleCI structure: has "command:", not "commands:".',
        contents: 'command:\n  wait-for: {}\n',
      }),
    ]);
    expect(otherFiles).toEqual([
      {
        path: '/repo/.circleci/goss.yaml',
        text:
          '# Read-only sibling, not a CircleCI config: No CircleCI structure: has "command:", not "commands:".\n' +
          'command:\n  wait-for: {}\n',
      },
    ]);
  });

  it('leaves a real config sibling unlabelled', () => {
    const { otherFiles } = buildDirectoryContext(activePath, [
      fileInfo({
        path: '/repo/.circleci/continue-config.yml',
        isConfig: true,
        contents: 'version: 2.1\njobs: {}\n',
      }),
    ]);
    expect(otherFiles).toEqual([
      {
        path: '/repo/.circleci/continue-config.yml',
        text: 'version: 2.1\njobs: {}\n',
      },
    ]);
  });

  it('counts the label itself against the token budget, not just the raw contents', () => {
    // 40 chars of raw content is exactly 10 tokens at ~4 chars/token, which
    // fits a 10-token budget on its own -- but the label line this file
    // gains pushes the labelled text well past it, so a 10-token budget must
    // now exclude it. Proof the budget is computed against what is actually
    // sent, not against `file.contents` alone.
    const content = 'x'.repeat(40);
    const { otherFiles, skippedFiles } = buildDirectoryContext(
      activePath,
      [
        fileInfo({
          path: '/repo/.circleci/goss.yaml',
          relPath: 'goss.yaml',
          isConfig: false,
          configReason: 'No CircleCI structure.',
          contents: content,
        }),
      ],
      /* budgetTokens */ 10,
    );
    expect(otherFiles).toEqual([]);
    expect(skippedFiles).toEqual([
      { path: '/repo/.circleci/goss.yaml', reason: 'token budget exceeded' },
    ]);
  });

  it('defaults to DIRECTORY_CONTEXT_TOKEN_BUDGET when no budget is given', () => {
    const hugeContents = 'x'.repeat(
      (DIRECTORY_CONTEXT_TOKEN_BUDGET + 1000) * 4,
    );
    const { otherFiles, skippedFiles } = buildDirectoryContext(activePath, [
      fileInfo({ contents: hugeContents }),
    ]);
    expect(otherFiles).toEqual([]);
    expect(skippedFiles).toEqual([
      {
        path: '/repo/.circleci/continue-config.yml',
        reason: 'token budget exceeded',
      },
    ]);
  });
});
