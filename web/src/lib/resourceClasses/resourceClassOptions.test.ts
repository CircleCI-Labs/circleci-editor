import { describe, expect, it } from 'vitest';

import {
  ANY_ARCHITECTURE,
  architectureAxis,
  classTitle,
  environmentsByIds,
  environmentsForKind,
  equivalentClassInArchitecture,
  groupedClassNames,
  isClassInArchitecture,
  resolveInitialResourceClass,
  resourceClassGroups,
} from './resourceClassOptions';
import { ARCH_ARM, ARCH_UNSTATED, ARCH_X86 } from './types';
import type { ResourceClass, ResourceClassEnvironment } from './types';

function cls(
  name: string,
  architecture: string,
  extra: Partial<ResourceClass> = {},
): ResourceClass {
  return {
    name,
    architecture,
    generation: name.endsWith('.gen2') ? 'gen2' : 'gen1',
    ...extra,
  };
}

/**
 * A trimmed stand-in for what `GET /api/resource-classes` serves, keeping the
 * shape the real payload has -- per-table environments, x86 and Arm tables for
 * the same executor kind, a gen2 table, and macOS's architecture-less one.
 * Deliberately not the full ten tables: what the *host* extracts is pinned in
 * `internal/guides/resourceclasses_test.go` against the vendored tables
 * themselves, and duplicating that here would be a second literal to drift.
 * These tests are about this module's filtering and grouping logic.
 */
const ENVIRONMENTS: ResourceClassEnvironment[] = [
  {
    id: 'x86',
    label: 'x86',
    kind: 'docker',
    architecture: ARCH_X86,
    generation: 'gen1',
    classes: [cls('small', ARCH_X86), cls('medium', ARCH_X86)],
  },
  {
    id: 'x86-gen2',
    label: 'x86 (gen2)',
    kind: 'docker',
    architecture: ARCH_X86,
    generation: 'gen2',
    classes: [cls('small.gen2', ARCH_X86), cls('medium.gen2', ARCH_X86)],
  },
  {
    id: 'arm',
    label: 'Arm',
    kind: 'docker',
    architecture: ARCH_ARM,
    generation: 'gen1',
    classes: [cls('arm.medium', ARCH_ARM), cls('arm.large', ARCH_ARM)],
  },
  {
    id: 'windows-execution-environment',
    label: 'Windows execution environment',
    kind: 'machine',
    architecture: ARCH_X86,
    generation: 'gen1',
    classes: [
      cls('windows.medium', ARCH_X86, { default: true, spec: 'vCPUs 4' }),
    ],
  },
  {
    id: 'macos-execution-environment',
    label: 'macOS execution environment',
    kind: 'macos',
    architecture: ARCH_UNSTATED,
    generation: 'gen1',
    classes: [cls('m4pro.medium', ARCH_UNSTATED)],
  },
];

describe('scoping environments', () => {
  it('picks a palette card’s own tables, in the order the card names them', () => {
    expect(
      environmentsByIds(ENVIRONMENTS, ['arm', 'x86']).map(({ id }) => id),
    ).toEqual(['arm', 'x86']);
  });

  it('drops an id the host does not serve, rather than failing', () => {
    // A table this project names but upstream has renamed degrades to one fewer
    // option group -- never to a broken field.
    expect(
      environmentsByIds(ENVIRONMENTS, ['x86', 'no-such-table']).map(
        ({ id }) => id,
      ),
    ).toEqual(['x86']);
  });

  it('picks every table for an executor kind, for the inspector', () => {
    expect(environmentsForKind(ENVIRONMENTS, 'docker').map(({ id }) => id)) //
      .toEqual(['x86', 'x86-gen2', 'arm']);
    expect(environmentsForKind(ENVIRONMENTS, 'macos').map(({ id }) => id)) //
      .toEqual(['macos-execution-environment']);
  });
});

describe('architectureAxis', () => {
  it('offers a filter only where more than one architecture is represented', () => {
    const docker = environmentsForKind(ENVIRONMENTS, 'docker');
    expect(architectureAxis(docker).map((choice) => choice.value)).toEqual([
      ANY_ARCHITECTURE,
      ARCH_X86,
      ARCH_ARM,
    ]);
  });

  it('offers no filter for a single-architecture executor', () => {
    // Windows is x86 only: a control whose every option shows the same list is
    // worse than no control.
    expect(
      architectureAxis(environmentsForKind(ENVIRONMENTS, 'machine')),
    ).toEqual([]);
  });

  it('offers no filter when the tables state no architecture at all', () => {
    // macOS. `m4pro.medium` is Apple silicon, but its table does not say so, and
    // the host refuses to assert it -- so there is nothing here to filter by.
    expect(
      architectureAxis(environmentsForKind(ENVIRONMENTS, 'macos')),
    ).toEqual([]);
  });

  it('labels architectures with both the human name and the identifier', () => {
    const labels = architectureAxis(
      environmentsForKind(ENVIRONMENTS, 'docker'),
    ).map((choice) => choice.label);
    expect(labels).toEqual([
      'Any architecture',
      'Intel/AMD (x86_64)',
      'Arm (arm64)',
    ]);
  });

  it('still offers an architecture this module has no wording for', () => {
    const withRiscv: ResourceClassEnvironment[] = [
      ...environmentsForKind(ENVIRONMENTS, 'docker'),
      {
        id: 'riscv',
        label: 'RISC-V',
        kind: 'docker',
        architecture: 'riscv64',
        generation: 'gen1',
        classes: [cls('riscv.medium', 'riscv64')],
      },
    ];
    expect(architectureAxis(withRiscv).map((choice) => choice.value)).toEqual([
      ANY_ARCHITECTURE,
      ARCH_X86,
      ARCH_ARM,
      'riscv64',
    ]);
  });
});

describe('resourceClassGroups', () => {
  const docker = environmentsForKind(ENVIRONMENTS, 'docker');

  it('groups by upstream table, using CircleCI’s own headings as labels', () => {
    expect(resourceClassGroups(docker).map((group) => group.label)).toEqual([
      'x86',
      'x86 (gen2)',
      'Arm',
    ]);
  });

  it('narrows to one architecture, dropping tables left with nothing', () => {
    const arm = resourceClassGroups(docker, ARCH_ARM);
    expect(arm.map((group) => group.id)).toEqual(['arm']);
    expect(groupedClassNames(arm)).toEqual(['arm.medium', 'arm.large']);
  });

  it('filters away the class already set, leaving no stragglers', () => {
    // Issue #212. This used to assert the opposite: the currently-set class was
    // exempt from the filter, so choosing Arm left `medium` -- an x86 class --
    // listed *and selected* under a control labelled "Filters the list below".
    // The owner's report is exactly that mismatch, so the exemption is gone.
    //
    // The value is still never made invisible; the field names it instead of
    // smuggling it into a list it does not belong to. See `isClassInArchitecture`
    // and `equivalentClassInArchitecture` below for the replacement, and
    // `ResourceClassField.test.tsx` for what the user actually sees.
    const arm = resourceClassGroups(docker, ARCH_ARM);
    expect(arm.map((group) => group.id)).toEqual(['arm']);
    expect(groupedClassNames(arm)).not.toContain('medium');
  });

  it('keeps both generations under the x86 filter, in their own groups', () => {
    // Gen2 is a `resource_class` suffix, not an architecture: filtering to x86
    // must not hide `small.gen2`, and the groups are what tell them apart.
    const x86 = resourceClassGroups(docker, ARCH_X86);
    expect(x86.map((group) => group.label)).toEqual(['x86', 'x86 (gen2)']);
    expect(groupedClassNames(x86)).toEqual([
      'small',
      'medium',
      'small.gen2',
      'medium.gen2',
    ]);
  });

  it('never hides a class whose table states no architecture', () => {
    // Not stating an architecture is not evidence of being the other one.
    const mixed = [
      ...docker,
      ...environmentsForKind(ENVIRONMENTS, 'macos'),
    ] as ResourceClassEnvironment[];
    expect(groupedClassNames(resourceClassGroups(mixed, ARCH_ARM))).toEqual([
      'arm.medium',
      'arm.large',
      'm4pro.medium',
    ]);
  });
});

describe('resolveInitialResourceClass', () => {
  const docker = environmentsForKind(ENVIRONMENTS, 'docker');

  it('honours the card’s preference while the tables still list it', () => {
    expect(resolveInitialResourceClass(docker, 'medium')).toBe('medium');
  });

  it('falls back to the table’s own default when the preference has gone stale', () => {
    const windows = environmentsForKind(ENVIRONMENTS, 'machine');
    expect(resolveInitialResourceClass(windows, 'windows.gone')).toBe(
      'windows.medium',
    );
  });

  it('falls back to the first class on offer when no table marks a default', () => {
    // The whole point: a literal in this repository can go stale, and when it
    // does the field must still preselect something CircleCI actually lists.
    expect(resolveInitialResourceClass(docker, 'macos.m1.medium.gen1')).toBe(
      'small',
    );
  });

  it('returns the preference unchanged when nothing is on offer', () => {
    // The host unreachable. The card's own default is all anyone knows.
    expect(resolveInitialResourceClass([], 'medium')).toBe('medium');
  });
});

describe('classTitle', () => {
  it('is the table’s own machine description, and says when upstream marks a default', () => {
    expect(classTitle(cls('medium', ARCH_X86, { spec: 'vCPUs 2, RAM 4GB' }))) //
      .toBe('vCPUs 2, RAM 4GB');
    expect(
      classTitle(
        cls('arm.medium', ARCH_ARM, { spec: 'vCPUs 2', default: true }),
      ),
    ).toBe('vCPUs 2 -- default');
  });

  it('is undefined when the table carried no columns to summarise', () => {
    expect(classTitle(cls('medium', ARCH_X86))).toBeUndefined();
  });
});

/**
 * Issue #212's replacement for the "never filter away the current class" rule. The
 * old rule kept the selection *in the list*; these two functions are what let the
 * field keep the selection *visible* while the list itself narrows honestly.
 */
describe('isClassInArchitecture', () => {
  const docker = environmentsForKind(ENVIRONMENTS, 'docker');

  it('answers for a class the filter would show, and against one it would not', () => {
    expect(isClassInArchitecture(docker, 'arm.medium', ARCH_ARM)).toBe(true);
    expect(isClassInArchitecture(docker, 'medium', ARCH_ARM)).toBe(false);
    expect(isClassInArchitecture(docker, 'medium', ARCH_X86)).toBe(true);
  });

  it('treats no filter, and no class, as nothing to invalidate', () => {
    // "Any architecture" cannot invalidate anything, and "you have not chosen a
    // class" is a different message from "your class is the wrong architecture".
    expect(isClassInArchitecture(docker, 'medium', ANY_ARCHITECTURE)).toBe(
      true,
    );
    expect(isClassInArchitecture(docker, '', ARCH_ARM)).toBe(true);
  });

  it('keeps a class whose table states no architecture valid under every filter', () => {
    // Not stating an architecture is not evidence of being the other one.
    const macos = environmentsForKind(ENVIRONMENTS, 'macos');
    expect(isClassInArchitecture(macos, 'm4pro.medium', ARCH_ARM)).toBe(true);
    expect(isClassInArchitecture(macos, 'm4pro.medium', ARCH_X86)).toBe(true);
  });
});

describe('equivalentClassInArchitecture', () => {
  const docker = environmentsForKind(ENVIRONMENTS, 'docker');

  it('rewrites the arm segment, in both directions', () => {
    // The owner's own example, and its inverse. The `arm` segment is where CircleCI
    // encodes the architecture, so moving it is the only mechanical correspondence
    // there is.
    expect(
      equivalentClassInArchitecture(docker, 'medium', ARCH_ARM)?.name,
    ).toBe('arm.medium');
    expect(
      equivalentClassInArchitecture(docker, 'arm.medium', ARCH_X86)?.name,
    ).toBe('medium');
  });

  it('offers nothing where the tables list no counterpart', () => {
    // `small` is x86-only here, and `arm.large` has no x86 sibling. The tempting
    // answers -- `arm.medium` for `small`, `medium` for `arm.large` -- are each a
    // *different machine*, and quietly resizing someone's build is the failure
    // issue #212 names explicitly. So: undefined, and the field says so.
    expect(
      equivalentClassInArchitecture(docker, 'small', ARCH_ARM),
    ).toBeUndefined();
    expect(
      equivalentClassInArchitecture(docker, 'arm.large', ARCH_X86),
    ).toBeUndefined();
  });

  it('never invents a name the tables do not list', () => {
    // The rewrite is mechanical, but its *result* is looked up in the offered
    // classes rather than trusted. `medium.gen2` rewrites to `arm.medium.gen2`,
    // which CircleCI does not publish, so nothing is offered.
    expect(
      equivalentClassInArchitecture(docker, 'medium.gen2', ARCH_ARM),
    ).toBeUndefined();
    expect(
      equivalentClassInArchitecture(docker, 'not-a-real-class', ARCH_ARM),
    ).toBeUndefined();
  });

  it('matches `arm` as a whole segment, never as a prefix', () => {
    // The same rule the host applies (`classArchitecture`): `alarm.medium` has no
    // `arm` segment, so going to x86 must not strip anything out of it, and the
    // lookup then finds no such x86 class.
    const withAlarm: ResourceClassEnvironment[] = [
      ...docker,
      {
        id: 'odd',
        label: 'Odd',
        kind: 'docker',
        architecture: ARCH_X86,
        generation: 'gen1',
        classes: [cls('alarm.medium', ARCH_X86)],
      },
    ];
    expect(
      equivalentClassInArchitecture(withAlarm, 'alarm.medium', ARCH_X86),
    ).toBeUndefined();
    // And going the other way prefixes rather than reusing the existing "arm".
    expect(
      equivalentClassInArchitecture(withAlarm, 'alarm.medium', ARCH_ARM),
    ).toBeUndefined();
  });

  it('carries the table’s own spec through, for the switch button to show', () => {
    // The button says what the user would be moving to, in CircleCI's words rather
    // than ours.
    const pair: ResourceClassEnvironment[] = [
      {
        id: 'x86',
        label: 'x86',
        kind: 'docker',
        architecture: ARCH_X86,
        generation: 'gen1',
        classes: [cls('medium', ARCH_X86)],
      },
      {
        id: 'arm',
        label: 'Arm',
        kind: 'docker',
        architecture: ARCH_ARM,
        generation: 'gen1',
        classes: [cls('arm.medium', ARCH_ARM, { spec: 'vCPUs 2, RAM 8 GB' })],
      },
    ];
    expect(equivalentClassInArchitecture(pair, 'medium', ARCH_ARM)?.spec).toBe(
      'vCPUs 2, RAM 8 GB',
    );
  });

  it('offers nothing for no filter, no class, or an architecture it has no rule for', () => {
    expect(
      equivalentClassInArchitecture(docker, 'medium', ANY_ARCHITECTURE),
    ).toBeUndefined();
    expect(equivalentClassInArchitecture(docker, '', ARCH_ARM)).toBeUndefined();
    // An architecture the host started reporting that this has no rewriting rule
    // for degrades to "we don't know of one" -- the same answer an x86-only class
    // gets, and never a guess.
    expect(
      equivalentClassInArchitecture(docker, 'medium', 'riscv64'),
    ).toBeUndefined();
  });
});
