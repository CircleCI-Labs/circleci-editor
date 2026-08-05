import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import {
  addJobFromExecutor,
  DOCKER_IMAGE,
  MACHINE_IMAGE,
} from '~/lib/mutations/configMutations';
import { BUILTIN_EXECUTORS } from '~/panes/dag/palette/paletteExecutors';

/**
 * The cross-language disagreement tests issues #211 and #203 ask for.
 *
 * `internal/guides/xcodeversions_test.go` already pins the *extraction* against
 * the vendored snapshot: if CircleCI's table changes, that test fails. What it
 * cannot see is the TypeScript half -- the literals this repository still writes
 * about CircleCI's platform. Those are exactly what went wrong: `15.3.0` and
 * `ubuntu-2204:current` were TypeScript constants, and no Go test could ever have
 * noticed them.
 *
 * So these tests read the vendored AsciiDoc *from disk* and assert against it
 * directly. Vitest runs in Node, the snapshot is a committed file, and reading it
 * is the only way for a web-side test to be answerable to the same source of truth
 * the host is. The alternative -- a fixture -- would be a second copy of the table
 * to keep in step, which is the failure mode this whole change removes.
 *
 * These are deliberately *not* run against a fixture and deliberately *not*
 * mocked. If the snapshot is refreshed and a literal here goes stale, this fails,
 * which is the entire point.
 */

/**
 * The vendored snapshot's root.
 *
 * Resolved from the Vitest root (`web/`) rather than from `import.meta.url`: under
 * Vite's transform the module URL is not a `file:` URL, so `fileURLToPath` throws.
 * `process.cwd()` is `web/` for every invocation of this suite (the `test` script
 * runs `vitest` there, and `vitest.config.ts` scopes `include` to `src/**`).
 */
const SNAPSHOT = join(process.cwd(), '..', 'internal/guides/snapshot/docs');

function readSnapshot(relative: string): string {
  return readFileSync(join(SNAPSHOT, relative), 'utf8');
}

/**
 * The `xcode:` values upstream's supported-Xcode table lists, read out of its
 * "Config" column.
 *
 * A line-oriented read of the AsciiDoc rather than a reimplementation of the Go
 * parser: this test only needs the first column, every row of which is a lone
 * backticked value on its own line immediately after a `|`. Keeping it this crude
 * is a feature -- if it and the Go extraction ever disagree about what the table
 * says, that is a signal worth having, and a test that shared the parser could not
 * produce it.
 */
function supportedXcodeVersionsFromSnapshot(): string[] {
  const source = readSnapshot(
    'guides/modules/ROOT/partials/execution-resources/xcode-silicon-vm.adoc',
  );
  const versions: string[] = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    // A Config cell: `| \`26.4.1\``, whose next line is the "Xcode Version"
    // column. Requiring that neighbour is what keeps this from also matching the
    // resource-class cells further along each row.
    const match = /^\|\s*`([^`]+)`\s*$/.exec(line);
    if (!match?.[1]) continue;
    if (!/^\|\s*Xcode\s/.test(lines[index + 1] ?? '')) continue;
    versions.push(match[1]);
  }
  return versions;
}

describe('the vendored supported-Xcode table', () => {
  it('is readable, and lists more than one version', () => {
    // Guards every assertion below: a regex that silently matched nothing would
    // make the rest of this file pass for the wrong reason.
    const versions = supportedXcodeVersionsFromSnapshot();
    expect(versions.length).toBeGreaterThan(1);
    expect(versions.every((version) => /^\d/.test(version))).toBe(true);
  });

  it('does not contain 15.3.0, the version this editor used to write', () => {
    // Issue #203, stated where it can actually be checked. `15.3.0` was the macOS
    // palette card's `defaultImage` *and* the mutation layer's fallback, and it is
    // not a version CircleCI offers -- not a stale entry, an invented one. Nothing
    // in this repository writes an Xcode version any more, and this is the test
    // that says the old one was never real.
    expect(supportedXcodeVersionsFromSnapshot()).not.toContain('15.3.0');
  });

  it('is the only source of the macOS card’s default -- the card carries none', () => {
    // The structural half of the same fix. A literal here could go stale; an empty
    // string cannot. The version comes from `GET /api/xcode-versions`, resolved by
    // `resolveInitialXcodeVersion`.
    const macos = BUILTIN_EXECUTORS.find((def) => def.id === 'macos');
    expect(macos).toBeDefined();
    expect(macos?.defaultImage).toBe('');
  });
});

describe('the palette cards’ remaining image literals', () => {
  /**
   * Every `machine: image:` value the vendored configuration reference writes in
   * its own examples. This is what "a release behind" was measured against in issue
   * #203, and what it is measured against now.
   */
  function machineImageExamples(): string[] {
    const source = readSnapshot(
      'reference/modules/ROOT/pages/configuration-reference.adoc',
    );
    return [...source.matchAll(/^\s*image:\s*(ubuntu-\d+:[a-z]+)/gm)].flatMap(
      (match) => (match[1] ? [match[1]] : []),
    );
  }

  it('offers a Linux VM image the reference’s own examples use', () => {
    // Issue #203: the card said `ubuntu-2204:current` while every example in the
    // reference said `ubuntu-2404:current`, commented "recommended linux image".
    // Asserting membership rather than equality on purpose -- the reference may
    // legitimately show more than one Ubuntu line, and the requirement is that ours
    // is one CircleCI actually writes, not that it is the alphabetically first.
    const machine = BUILTIN_EXECUTORS.find((def) => def.id === 'machine');
    expect(machine).toBeDefined();
    const examples = machineImageExamples();
    expect(examples.length).toBeGreaterThan(0);
    expect(examples).toContain(machine?.defaultImage);
  });

  it('keeps the mutation layer’s fallbacks equal to the cards’ defaults', () => {
    // `configMutations.ts` cannot import from a pane, so it carries its own copies
    // (see `DOCKER_IMAGE`/`MACHINE_IMAGE`). Two copies of a fact is how
    // `ubuntu-2204:current` outlived the docs' move in the first place, so the
    // duplication is pinned rather than tolerated: one fact, checked in two places.
    const docker = BUILTIN_EXECUTORS.find((def) => def.id === 'docker');
    const machine = BUILTIN_EXECUTORS.find((def) => def.id === 'machine');
    expect(DOCKER_IMAGE).toBe(docker?.defaultImage);
    expect(MACHINE_IMAGE).toBe(machine?.defaultImage);
  });

  it('refuses to write a macOS job with no Xcode version rather than inventing one', () => {
    // The counterpart to the card carrying no default: with nothing to fall back
    // to, `addJobFromExecutor` refuses. `mutate` discards the failed clone, so the
    // document is untouched and the user is told what is missing -- instead of
    // getting the unsupported `15.3.0` this line used to supply.
    //
    // Unreachable from the UI (`ConfigureJobDialog` will not submit without a
    // version); this is the backstop, and the assertion that no literal crept back.
    const doc = parseDocument('version: 2.1\njobs: {}\n');
    expect(() =>
      addJobFromExecutor(doc, {
        name: 'build',
        workflowName: 'w',
        executor: { kind: 'macos' },
      }),
    ).toThrow(/needs an Xcode version/);
    // And the document really is untouched -- no half-written `macos:` block.
    expect(doc.toString()).toBe('version: 2.1\njobs: {}\n');
  });

  it('still writes a macOS job when a version is supplied, quoting it when YAML would read it as a number', () => {
    // `26.5` unquoted is a YAML float and `xcode: 26.5` would round-trip as one,
    // which is a different value from the string CircleCI's table lists. `yaml`
    // handles this itself given a string node; this pins that it does, because the
    // failure would be silent and only visible to CircleCI.
    const doc = parseDocument('version: 2.1\njobs: {}\n');
    addJobFromExecutor(doc, {
      name: 'build',
      workflowName: 'w',
      executor: { kind: 'macos', image: '26.5' },
    });
    expect(doc.toString()).toContain('xcode: "26.5"');

    // A version YAML cannot mistake for a number stays plain, so this does not
    // gratuitously quote every value either.
    const dotted = parseDocument('version: 2.1\njobs: {}\n');
    addJobFromExecutor(dotted, {
      name: 'build',
      workflowName: 'w',
      executor: { kind: 'macos', image: '14.3.1' },
    });
    expect(dotted.toString()).toContain('xcode: 14.3.1');
  });
});
