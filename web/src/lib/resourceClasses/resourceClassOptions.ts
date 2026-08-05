/**
 * Turns `GET /api/resource-classes`' environments into what a resource-class
 * picker renders: option groups labelled in CircleCI's own words, and the
 * architecture axis to narrow them by (issue #181).
 *
 * Pure and framework-free -- no React -- so the whole of the filtering,
 * grouping and "should this control even exist?" logic is assertable without a
 * render. Same convention as `paletteExecutors.ts` and everything under `~/lib`.
 *
 * ## Architecture is not a config key
 *
 * There is no `architecture:` field in a CircleCI config. `resource_class:
 * arm.medium` is how the architecture is expressed, so an architecture control
 * can only ever *narrow a list*; it must never look like a second thing being
 * written. Hence `architectureAxis` returns choices for a filter and nothing
 * that resembles a value, and the component labels it as a filter.
 *
 * The axis is derived, not declared: it is whatever architectures the offered
 * classes actually carry (the host derives each class's architecture from its
 * own name -- see `internal/guides/resourceclasses.go`). So it appears for
 * Docker and for `machine`, which genuinely span x86 and Arm, and does not
 * appear for macOS, whose table states no architecture at all. Nothing here has
 * a list of architectures to fall out of date.
 *
 * ## Generation is not an axis
 *
 * Gen2 *is* expressible in a `resource_class` value -- `xlarge.gen2`,
 * `gpu.nvidia.small.gen2` -- so gen2 classes are ordinary options in their own
 * upstream-labelled group ("x86 (gen2)", "LinuxVM (gen2) execution
 * environment"). A separate generation control would be a second dropdown whose
 * only effect is appending a suffix the class list already shows.
 */
import {
  ARCH_ARM,
  ARCH_UNSTATED,
  ARCH_X86,
  type ResourceClass,
  type ResourceClassEnvironment,
} from './types';

/** The sentinel `<select>` value for "narrow to nothing" -- every architecture. */
export const ANY_ARCHITECTURE = '';

/** One option group in the resource-class `<select>`: one upstream table, under its own heading. */
export interface ResourceClassGroup {
  id: string;
  /** CircleCI's own heading for this table. */
  label: string;
  classes: ResourceClass[];
}

/** One choice in the architecture filter. */
export interface ArchitectureChoice {
  /** The `<option>` value: an architecture as the host spells it, or `ANY_ARCHITECTURE`. */
  value: string;
  label: string;
}

/**
 * Human wording for an architecture, alongside the identifier CircleCI uses.
 * Both halves matter: "Arm" is what the docs headings say and what a reader
 * recognises, `arm64` is what they will see in `uname -m` inside the job.
 */
const ARCHITECTURE_LABELS: Record<string, string> = {
  [ARCH_X86]: 'Intel/AMD (x86_64)',
  [ARCH_ARM]: 'Arm (arm64)',
};

/** Architecture filter order: x86 first, matching upstream's own document order (its x86 tables precede its Arm ones). */
const ARCHITECTURE_ORDER = [ARCH_X86, ARCH_ARM];

/** The environments belonging to one executor kind, in the host's (upstream document) order. */
export function environmentsForKind(
  environments: readonly ResourceClassEnvironment[],
  kind: string,
): ResourceClassEnvironment[] {
  return environments.filter((environment) => environment.kind === kind);
}

/** The environments named by `ids`, in `ids`' order -- how a palette card picks its own tables out of the full set. */
export function environmentsByIds(
  environments: readonly ResourceClassEnvironment[],
  ids: readonly string[],
): ResourceClassEnvironment[] {
  const byId = new Map(
    environments.map((environment) => [environment.id, environment]),
  );
  return ids
    .map((id) => byId.get(id))
    .filter((environment): environment is ResourceClassEnvironment =>
      Boolean(environment),
    );
}

/**
 * The architecture filter's choices for a set of environments, or an empty
 * array when a filter would be pointless.
 *
 * Empty in exactly two cases, both of which mean "there is nothing to narrow":
 * fewer than two architectures are represented, or the environments state none
 * (macOS). Returning `[]` rather than a one-item list is what stops the UI
 * rendering a control that cannot change anything -- the specific failure the
 * issue warns against for generation.
 */
export function architectureAxis(
  environments: readonly ResourceClassEnvironment[],
): ArchitectureChoice[] {
  const present = new Set<string>();
  for (const environment of environments) {
    for (const resourceClass of environment.classes) {
      if (resourceClass.architecture !== ARCH_UNSTATED) {
        present.add(resourceClass.architecture);
      }
    }
  }
  if (present.size < 2) return [];

  const known = ARCHITECTURE_ORDER.filter((architecture) =>
    present.has(architecture),
  );
  // An architecture the host started reporting that this file has no wording
  // for still gets an option, labelled with the identifier itself. Better a
  // slightly technical label than a class the user cannot reach.
  const extra = [...present]
    .filter((architecture) => !ARCHITECTURE_ORDER.includes(architecture))
    .sort();

  return [
    { value: ANY_ARCHITECTURE, label: 'Any architecture' },
    ...[...known, ...extra].map((architecture) => ({
      value: architecture,
      label: ARCHITECTURE_LABELS[architecture] ?? architecture,
    })),
  ];
}

/**
 * The option groups to render, narrowed to one architecture.
 *
 * Two rules:
 *
 *  - `ARCH_UNSTATED` classes survive every filter. An environment whose table
 *    states no architecture is not evidence that it is the *other* one, so
 *    hiding it would be a claim the tables do not make.
 *  - A group left with no classes is dropped rather than rendered empty.
 *
 * ## The rule that used to be here, and why it was wrong
 *
 * This used to take a third argument, `keepName`, that exempted the currently-set
 * class from the filter, on the reasoning that a control must never make an
 * existing value invisible. The reasoning is right; the implementation was not.
 * Choosing "Arm" left `medium` -- an x86 class -- in the list *and selected*, so a
 * control labelled "Filters the list below" visibly did not, which is what issue
 * #212 reports.
 *
 * The current value is still never made invisible. It is just no longer made
 * invisible *by pretending it belongs to the architecture you asked for*: the
 * field names it explicitly, says it is not in the chosen architecture, and offers
 * the equivalent class where one exists (see `equivalentClassInArchitecture`).
 * Naming a problem is a better way of not hiding something than silently leaving
 * it in a list it does not belong to.
 */
export function resourceClassGroups(
  environments: readonly ResourceClassEnvironment[],
  architecture: string = ANY_ARCHITECTURE,
): ResourceClassGroup[] {
  return environments
    .map((environment) => ({
      id: environment.id,
      label: environment.label,
      classes: environment.classes.filter(
        (resourceClass) =>
          architecture === ANY_ARCHITECTURE ||
          resourceClass.architecture === architecture ||
          resourceClass.architecture === ARCH_UNSTATED,
      ),
    }))
    .filter((group) => group.classes.length > 0);
}

/**
 * Whether `name` is a class the given architecture filter would show -- i.e.
 * whether an explicit architecture choice leaves the current selection valid.
 *
 * `''` (no class set) counts as valid: a filter has nothing to invalidate, and
 * "you must pick a class" is a different message from "the class you have is the
 * wrong architecture".
 */
export function isClassInArchitecture(
  environments: readonly ResourceClassEnvironment[],
  name: string,
  architecture: string,
): boolean {
  if (name === '' || architecture === ANY_ARCHITECTURE) return true;
  return resourceClassGroups(environments, architecture).some((group) =>
    group.classes.some((resourceClass) => resourceClass.name === name),
  );
}

/**
 * The class in `architecture` that corresponds to `name`, or `undefined` when the
 * offered tables contain no such class.
 *
 * ## How the correspondence is computed
 *
 * By rewriting the `arm` *segment* of the class name and looking the result up in
 * the tables -- `medium` <-> `arm.medium`, `xlarge.gen2` <-> `arm.xlarge.gen2`.
 * Nothing is inferred from size or spec.
 *
 * That matters because the tempting alternative is to match on the size word, or
 * on vCPU count, and both would produce a confident wrong answer. Docker's x86
 * table lists `small`, `medium+` and `2xlarge+`; its Arm table lists none of
 * them. A size-matching rule would answer "`arm.medium`" for `medium+`, which is
 * a *smaller machine* than the one the job asked for -- a silent downgrade of
 * someone's build. So this returns `undefined` there, and the field says there is
 * no Arm equivalent rather than choosing a nearest size (issue #212, explicitly).
 *
 * The result is looked up in the offered classes rather than merely constructed,
 * so a name this rewriting produces but CircleCI does not publish is never
 * offered. There is no list of correspondences here to go stale: the segment
 * rewrite is mechanical and the lookup is against the vendored tables.
 */
export function equivalentClassInArchitecture(
  environments: readonly ResourceClassEnvironment[],
  name: string,
  architecture: string,
): ResourceClass | undefined {
  if (name === '' || architecture === ANY_ARCHITECTURE) return undefined;

  const candidate = rewriteArmSegment(name, architecture);
  if (candidate === undefined || candidate === name) return undefined;

  for (const environment of environments) {
    for (const resourceClass of environment.classes) {
      if (resourceClass.name !== candidate) continue;
      // The table has to agree that this class belongs to the architecture
      // asked for. It always does today -- the host derives a class's
      // architecture from the same segment this rewrites -- but relying on the
      // rewrite alone would make this the one place that asserts an
      // architecture rather than reading one.
      if (
        resourceClass.architecture === architecture ||
        resourceClass.architecture === ARCH_UNSTATED
      ) {
        return resourceClass;
      }
    }
  }
  return undefined;
}

/**
 * `name` with its `arm` segment added or removed so that it names a class in
 * `architecture`, or `undefined` when the architecture is one this rewriting has
 * no rule for.
 *
 * The segment is matched and inserted as a whole dot-separated component, exactly
 * as the host's own `classArchitecture` reads it: `arm.2xlarge` is Arm and a
 * hypothetical `alarm.medium` is not.
 *
 * `arm` goes at the *front* for x86 -> Arm because that is where CircleCI puts it
 * in every class it publishes (`arm.medium`, `arm.xlarge`, `arm.2xlarge`) -- and
 * because the result is looked up in the tables rather than trusted, a naming
 * convention change makes this return no equivalent rather than a wrong one.
 */
function rewriteArmSegment(
  name: string,
  architecture: string,
): string | undefined {
  const segments = name.split('.');
  const armIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === ARM_SEGMENT,
  );

  if (architecture === ARCH_ARM) {
    if (armIndex !== -1) return name;
    return [ARM_SEGMENT, ...segments].join('.');
  }
  if (architecture === ARCH_X86) {
    if (armIndex === -1) return name;
    return segments.filter((_, index) => index !== armIndex).join('.');
  }
  // An architecture the host started reporting that this has no rewriting rule
  // for. No equivalent is offered, which reads as "we don't know of one" -- the
  // honest answer, and the same one an x86-only class gets.
  return undefined;
}

/**
 * The class-name segment that means arm64, matching the host's own `armSegment`.
 * Duplicated across the wire rather than served, because it is a fact about how
 * CircleCI spells a class name, not about any particular table -- and
 * `resourceClassOptions.test.ts` pins it against the fixture the host's own
 * extraction produced.
 */
const ARM_SEGMENT = 'arm';

/** Every class name in `groups`, in order -- what "is the current value one of the presets?" is asked against. */
export function groupedClassNames(
  groups: readonly ResourceClassGroup[],
): string[] {
  return groups.flatMap((group) => group.classes.map(({ name }) => name));
}

/**
 * The class to preselect for a newly-created job: the caller's preference when
 * the tables still offer it, then whatever class the tables mark `(default)`,
 * then the first class on offer.
 *
 * The order matters. A palette card's `defaultResourceClass` is a product
 * choice -- Docker jobs start on `medium`, not on the `small` that happens to
 * head CircleCI's table -- so it wins while it remains a real class. But it is a
 * literal in this repository, and the point of issue #181 is that literals about
 * CircleCI's compute go stale; when it does, this degrades to something the
 * tables actually list rather than preselecting a class that no longer exists.
 *
 * `preferred` is returned unchanged when nothing is on offer at all (the host
 * unreachable), which is the only case where this can hand back a value the
 * tables have not confirmed.
 */
export function resolveInitialResourceClass(
  environments: readonly ResourceClassEnvironment[],
  preferred: string,
): string {
  const offered = environments.flatMap((environment) => environment.classes);
  if (offered.length === 0) return preferred;
  if (offered.some(({ name }) => name === preferred)) return preferred;
  const marked = offered.find(({ default: isDefault }) => isDefault);
  // Non-null: `offered` is known non-empty, but `noUncheckedIndexedAccess` is on.
  return marked?.name ?? offered[0]?.name ?? preferred;
}

/**
 * The `title` text for one option: the table's own machine description, plus a
 * note when upstream marks the class its environment's default.
 */
export function classTitle(resourceClass: ResourceClass): string | undefined {
  const parts = [resourceClass.spec, resourceClass.default ? 'default' : '']
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' -- ') : undefined;
}
