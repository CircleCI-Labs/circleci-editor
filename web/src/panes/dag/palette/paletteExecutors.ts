/**
 * The palette's Executors section (issue #71): what shows up as a card, and
 * the drag payload that carries it from card to drop target.
 *
 * Pure and framework-free -- no React -- same convention as `dagUtils.ts`
 * and everything under `~/lib`. Kept alongside the palette's other
 * components (not under `~/lib`) because, unlike `dagUtils.ts`'s cycle/name
 * helpers, this module's whole reason to exist *is* the palette UI's own
 * catalogue -- nothing else in the app has a use for "the list of executor
 * kinds to show as draggable cards".
 *
 * CircleCI's job-level executor is one of exactly three native kinds --
 * `docker`, `machine`, `macos` (see `ExecutorSpec` in `configMutations.ts`)
 * -- there is no fourth `windows:` key. "Windows" and "GPU" below are both
 * `machine` under the hood with a different default image/resource_class;
 * they get their own cards (rather than folding into one "Machine" card
 * with a resource-class dropdown) because the user's own framing of the
 * problem -- issue #71: "these are the executors you can click and drag" --
 * treats them as distinct choices someone reaches for by name, not as a
 * Machine executor's advanced option.
 */

export type BuiltinExecutorKind = 'docker' | 'machine' | 'macos';

/**
 * One built-in executor card.
 *
 * `mutationKind` is what `ExecutorSpec.kind` this card ultimately produces --
 * `docker`/`machine`/`macos`, the only three CircleCI actually has.
 *
 * `resourceEnvironmentIds` is where this card's resource classes come *from*,
 * and is the whole of issue #181's fix on this side of the wire. It used to be a
 * hand-written array of class names per card. Those drifted -- Docker was offered
 * no Arm class at all, "Linux VM" was missing `arm.xlarge`/`arm.2xlarge` and
 * `2xlarge+`, nothing anywhere offered a gen2 class, and macOS still offered
 * `macos.m1.medium.gen1`, which CircleCI's table had stopped listing. What
 * replaces them is a list of *upstream table anchors*: the host reads the classes
 * out of the resource tables vendored from CircleCI's own documentation and
 * serves them from `GET /api/resource-classes`, so the classes on offer cannot
 * drift by more than one seven-day refresh. See
 * `internal/guides/resourceclasses.go`.
 *
 * Naming tables rather than classes is also what lets each card stay the thing
 * the user picked: the Windows card offers Windows classes, and the fact that
 * Windows and GPU and Arm VM are all `machine` underneath (see the module doc
 * comment) stays an implementation detail rather than becoming a dropdown of
 * every `machine` class in existence.
 */
export interface BuiltinExecutorDef {
  id: string;
  label: string;
  description: string;
  mutationKind: BuiltinExecutorKind;
  imageLabel: string;
  /**
   * The image/tag a new job of this kind starts with.
   *
   * `''` means "this card has no opinion, ask the host" -- which is what the macOS
   * card now says, and the whole of issue #203's fix on this side of the wire. It
   * used to say `'15.3.0'`, an Xcode version that appears nowhere in CircleCI's
   * supported-Xcode table: the card did not hold a *stale* value, it held an
   * invented one, so every macOS job created from the palette got an `xcode:`
   * CircleCI does not offer. The version now comes from
   * `GET /api/xcode-versions`, derived from the vendored table (see
   * `internal/guides/xcodeversions.go`), so there is no literal here left to be
   * wrong.
   *
   * The other four cards keep a literal, because for those it is a product choice
   * rather than a fact about the platform -- `cimg/base:current` means "start
   * somewhere general-purpose", not "this is the image CircleCI supports". They are
   * still *checked*: `paletteExecutors.test.ts` asserts each one against the
   * vendored documentation's own examples, which is what a literal about the
   * platform has to do to earn its place.
   */
  defaultImage: string;
  /**
   * The upstream configuration-reference section anchors whose resource tables
   * this card offers, in the order shown. Resolved against
   * `GET /api/resource-classes`; an id the host doesn't know is simply absent
   * from the picker rather than an error, which is what makes a table this
   * project names but upstream has renamed degrade to "one fewer group" instead
   * of "a broken field".
   */
  resourceEnvironmentIds: string[];
  /**
   * The class to preselect, when the host offers it. A *preference*, not an
   * assumption: `resolveInitialResourceClass` falls back to whatever class the
   * table marks `(default)`, and then to the first class on offer, so a stale
   * value here can never leave the field showing something CircleCI does not
   * list.
   */
  defaultResourceClass: string;
}

/**
 * The five built-in cards, in the order shown. "Windows"/"GPU" are
 * `machine` specs with a Windows/GPU-flavored image and resource_class
 * list (see the module doc comment) -- distinct cards, not a variant of
 * "Machine", because that is how CircleCI users actually pick one.
 */
export const BUILTIN_EXECUTORS: BuiltinExecutorDef[] = [
  {
    id: 'docker',
    label: 'Docker',
    description:
      'Run steps inside a Docker container image -- the fastest, most common executor.',
    mutationKind: 'docker',
    imageLabel: 'Image',
    defaultImage: 'cimg/base:current',
    // x86, x86 (gen2) and Arm -- the three tables CircleCI's Docker execution
    // environment section documents. The Arm one is what the editor was
    // missing entirely when issue #181 was filed.
    resourceEnvironmentIds: ['x86', 'x86-gen2', 'arm'],
    defaultResourceClass: 'medium',
  },
  {
    id: 'machine',
    label: 'Linux VM',
    description:
      'A full Linux virtual machine -- use this when a job needs Docker-in-Docker or a kernel Docker can’t give you.',
    mutationKind: 'machine',
    imageLabel: 'VM image',
    // `ubuntu-2404`, not `ubuntu-2204` (issue #203). Every `machine` example in the
    // vendored configuration reference uses `ubuntu-2404:current`, commented
    // "recommended linux image"; this card was a release behind. Pinned by
    // `paletteExecutors.test.ts` against that snapshot, so the next time upstream
    // moves, a test says so rather than a user finding out.
    defaultImage: 'ubuntu-2404:current',
    resourceEnvironmentIds: [
      'linuxvm-execution-environment',
      'linuxvm-gen2-execution-environment',
      'arm-execution-environment-linux',
    ],
    defaultResourceClass: 'medium',
  },
  {
    id: 'macos',
    label: 'macOS',
    description:
      'An Apple silicon or Intel macOS VM, for building and testing Apple platform apps.',
    mutationKind: 'macos',
    imageLabel: 'Xcode version',
    // Empty on purpose -- see `defaultImage`'s own doc comment. The version comes
    // from CircleCI's supported-Xcode table via `GET /api/xcode-versions`; this
    // card knows nothing about Xcode and is not entitled to.
    defaultImage: '',
    resourceEnvironmentIds: ['macos-execution-environment'],
    // Upstream's macOS table lists only `m4pro.medium`/`m4pro.large` now; the
    // `macos.m1.medium.gen1` this card used to preselect is no longer in it.
    defaultResourceClass: 'm4pro.medium',
  },
  {
    id: 'windows',
    label: 'Windows',
    description:
      'A Windows Server VM. Written as a `machine` executor -- CircleCI has no separate top-level Windows executor type.',
    mutationKind: 'machine',
    imageLabel: 'VM image',
    defaultImage: 'windows-server-2022-gui:current',
    resourceEnvironmentIds: ['windows-execution-environment'],
    defaultResourceClass: 'windows.medium',
  },
  {
    id: 'gpu',
    label: 'GPU',
    description:
      'A Linux VM with an attached GPU, for ML training/inference or graphics workloads.',
    mutationKind: 'machine',
    imageLabel: 'VM image',
    defaultImage: 'linux-cuda-12:default',
    // Both GPU tables: the Windows GPU class (`windows.gpu.nvidia.medium`) is a
    // GPU resource before it is a Windows one, and this card is where someone
    // looking for a GPU will look.
    resourceEnvironmentIds: [
      'gpu-execution-environment-linux',
      'gpu-execution-environment-windows',
    ],
    defaultResourceClass: 'gpu.nvidia.small',
  },
];

export function findBuiltinExecutor(
  id: string,
): BuiltinExecutorDef | undefined {
  return BUILTIN_EXECUTORS.find((def) => def.id === id);
}

// ---------------------------------------------------------------------------
// Drag payload
// ---------------------------------------------------------------------------

/** What a card in the Executors section actually drags: a built-in kind by its `BuiltinExecutorDef.id`, or one of the document's own named `executors:` entries. */
export type PaletteExecutorPayload =
  | { source: 'builtin'; builtinId: string }
  | { source: 'local'; executorName: string };

/** `dataTransfer` MIME type for a palette-executor drag -- see `~/lib/orbs/dragPayload.ts`'s doc comment for why a dedicated type per draggable kind (rather than one generic type) is what lets a drop target answer "would I accept this?" during `dragover`, before `getData` is even readable. */
const PALETTE_EXECUTOR_MIME = 'application/x-vce-palette-executor';

export function setPaletteExecutorDragPayload(
  dataTransfer: DataTransfer,
  payload: PaletteExecutorPayload,
): void {
  dataTransfer.setData(PALETTE_EXECUTOR_MIME, JSON.stringify(payload));
  dataTransfer.setData(
    'text/plain',
    payload.source === 'builtin' ? payload.builtinId : payload.executorName,
  );
  dataTransfer.effectAllowed = 'copy';
}

export function isDraggingPaletteExecutor(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PALETTE_EXECUTOR_MIME);
}

export function readPaletteExecutorDragPayload(
  dataTransfer: DataTransfer,
): PaletteExecutorPayload | undefined {
  const raw = dataTransfer.getData(PALETTE_EXECUTOR_MIME);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as PaletteExecutorPayload;
    if (parsed?.source === 'builtin' && typeof parsed.builtinId === 'string')
      return parsed;
    if (parsed?.source === 'local' && typeof parsed.executorName === 'string')
      return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
