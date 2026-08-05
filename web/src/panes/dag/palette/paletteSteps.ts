/**
 * The palette's Steps section (issue #71): the catalogue of step keywords
 * offered as draggable cards, and the drag payload that carries one from a
 * card to a drop target (a job node on the canvas, or the inspector's own
 * steps list).
 *
 * Deliberately reuses the inspector's own step vocabulary --
 * `KNOWN_STEP_KEYS` (exported from `Inspector.tsx`) plus
 * `BARE_STRING_STEP_KEYS` (from `configMutations.ts`) -- rather than a
 * second hand-maintained list: issue #71 explicitly calls out that "the
 * step types are already enumerated for the editors added in #48; reuse
 * that catalogue rather than duplicating it." Every card this module
 * offers therefore corresponds to a step the inspector's `StepFieldsSection`
 * can already fully edit once it lands in the document.
 *
 * Pure and framework-free -- no React -- same convention as
 * `paletteExecutors.ts`.
 */
import { KNOWN_STEP_KEYS } from '~/lib/schema/stepKeywords';

/** One step keyword offered as a palette card. */
export interface PaletteStepDef {
  key: string;
  label: string;
  description: string;
}

/**
 * The default value written when this step is dropped/added with nothing
 * configured yet -- deliberately a *valid*, if generic, step rather than an
 * empty shell, so the config still compiles immediately (same philosophy as
 * `addJob`'s own `docker`/`cimg/base:current` default). The user edits it
 * afterward via the inspector's schema-driven `StepFieldsSection` (issue
 * #48), which every one of these keywords already has full field coverage
 * for.
 */
const STEP_DEFAULTS: Record<string, () => unknown> = {
  checkout: () => 'checkout',
  run: () => ({ run: 'echo "Replace this with your command"' }),
  setup_remote_docker: () => 'setup_remote_docker',
  add_ssh_keys: () => 'add_ssh_keys',
  save_cache: () => ({
    save_cache: {
      key: 'v1-{{ checksum "package-lock.json" }}',
      paths: ['node_modules'],
    },
  }),
  restore_cache: () => ({
    restore_cache: { key: 'v1-{{ checksum "package-lock.json" }}' },
  }),
  store_artifacts: () => ({ store_artifacts: { path: 'artifacts' } }),
  store_test_results: () => ({ store_test_results: { path: 'test-results' } }),
  persist_to_workspace: () => ({
    persist_to_workspace: { root: '.', paths: ['.'] },
  }),
  attach_workspace: () => ({ attach_workspace: { at: '.' } }),
};

const STEP_DESCRIPTIONS: Record<string, string> = {
  checkout: 'Check out this project’s source code.',
  run: 'Run a shell command.',
  setup_remote_docker:
    'Create a remote Docker environment for building/pushing images.',
  add_ssh_keys: 'Add SSH keys from project settings to the job.',
  save_cache: 'Save a cache of files for a future job to restore.',
  restore_cache: 'Restore a cache saved by a previous job.',
  store_artifacts: 'Upload a file or directory as a job artifact.',
  store_test_results: 'Upload test result files for CircleCI’s test insights.',
  persist_to_workspace:
    'Share files with downstream jobs in the same workflow run.',
  attach_workspace: 'Attach files persisted by an upstream job.',
};

/** `checkout` -> "checkout", `store_artifacts` -> "Store artifacts", ... -- mirrors `Inspector.tsx`'s own `humanizeBuiltinKey`. */
function humanize(key: string): string {
  if (key === 'checkout' || key === 'run') return key;
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Every step keyword offered as a palette card, in a fixed, deliberate order (checkout and run -- the two nearly every job uses -- first, then the rest alphabetically by key). */
export const PALETTE_STEPS: PaletteStepDef[] = [
  'checkout',
  'run',
  ...[...KNOWN_STEP_KEYS].filter((key) => key !== 'checkout').sort(),
]
  .filter((key, index, all) => all.indexOf(key) === index)
  .map((key) => ({
    key,
    label: humanize(key),
    description: STEP_DESCRIPTIONS[key] ?? '',
  }));

/** The step value to insert for `stepKey`, per `STEP_DEFAULTS` above. Throws for a key this module doesn't recognize -- every caller sources `stepKey` from `PALETTE_STEPS`, so this should never actually happen outside a test deliberately passing a bad key. */
export function defaultStepValue(stepKey: string): unknown {
  const build = STEP_DEFAULTS[stepKey];
  if (!build) throw new Error(`No default value for step "${stepKey}"`);
  return build();
}

// Sanity check, at module load, that every exported card has a default
// builder -- `checkout`/`setup_remote_docker`/`add_ssh_keys` (CircleCI's
// `BARE_STRING_STEP_KEYS`, see `configMutations.ts`) default to their bare
// string form above rather than a single-key map, but still need an entry
// here like every other keyword.
for (const step of PALETTE_STEPS) {
  if (!STEP_DEFAULTS[step.key]) {
    throw new Error(
      `paletteSteps.ts: "${step.key}" has no default value builder`,
    );
  }
}

// ---------------------------------------------------------------------------
// Drag payload
// ---------------------------------------------------------------------------

export interface PaletteStepPayload {
  stepKey: string;
}

/** `dataTransfer` MIME type for a palette-step drag. See `paletteExecutors.ts`'s identical note on why this is its own type rather than a shared generic one. */
const PALETTE_STEP_MIME = 'application/x-vce-palette-step';

export function setPaletteStepDragPayload(
  dataTransfer: DataTransfer,
  stepKey: string,
): void {
  dataTransfer.setData(PALETTE_STEP_MIME, JSON.stringify({ stepKey }));
  dataTransfer.setData('text/plain', stepKey);
  dataTransfer.effectAllowed = 'copy';
}

export function isDraggingPaletteStep(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PALETTE_STEP_MIME);
}

export function readPaletteStepDragPayload(
  dataTransfer: DataTransfer,
): PaletteStepPayload | undefined {
  const raw = dataTransfer.getData(PALETTE_STEP_MIME);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as PaletteStepPayload;
    return typeof parsed?.stepKey === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
