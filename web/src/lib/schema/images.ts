/**
 * Fact tables for the two "value is a well-known image string" completion
 * targets the JSON Schema itself can't help with -- `docker: - image:` and
 * `machine: image:` are both typed as plain `string` in the vendored
 * schema (verified by inspection: neither carries an `enum`), so there is
 * nothing to extract the way `circleciSchema.ts` extracts `resource_class`
 * or `type`. These lists are hand-curated instead.
 *
 * # Provenance
 *
 * ## `CIMG_IMAGES` (docker convenience images)
 *
 * CircleCI's `cimg/*` Docker Hub org (https://hub.docker.com/u/cimg) is the
 * canonical list of "convenience images" -- verified 2026-07-28 via the
 * public, unauthenticated Docker Hub API:
 *
 *   curl -s 'https://hub.docker.com/v2/repositories/cimg/?page_size=100' \
 *     | jq -r '.results[].name'
 *
 * which returned (excluding non-image housekeeping repos `cimg-orb`,
 * `signatures`, `testing`): base, python, go, rust, node, openjdk, android,
 * ruby, mariadb, php, elixir, clojure, postgres, redis, mysql, unity,
 * deploy, rlang, aws, gcp, azure.
 *
 * Deliberately *not* vendored here: specific version tags (e.g. `20.11` or
 * `3.13.14`). Per-repo tag listings (via the same API's
 * `/v2/repositories/cimg/<name>/tags/`) show each language image cutting a
 * new tag roughly every few weeks and keeping hundreds of historical ones
 * live -- baking any of those in would go stale within one release cycle
 * and silently push users towards outdated images. What *is* stable enough
 * to vendor is which *suffix variants* (`-node`, `-browsers`, `-ndk`) each
 * image family supports, since that's a naming convention CircleCI has
 * kept consistent across every tag of a given image for years; the variant
 * lists below were spot-checked against each repo's current tag list on
 * the same date. Choosing an actual version number is left to the user,
 * who generally already knows which one they want -- the thing this
 * completion helps with is the `cimg/<name>` naming convention and the
 * existence of the variant suffixes, not picking a version.
 *
 * ## `MACHINE_IMAGES` (machine executor images)
 *
 * Enumerated by hand from the CircleCI docs and each image's own page on
 * the CircleCI Developer Hub (verified 2026-07-28):
 *
 *   https://circleci.com/docs/reference/configuration-reference/#available-machine-images
 *   https://circleci.com/developer/machine/image/<name>  (one page per family below)
 *
 * Unlike `cimg/*`, these images are addressed by a small closed set of
 * "moving" tags documented by CircleCI itself as the intended way to
 * reference them (`current`/`edge` for Ubuntu and the Windows families,
 * plus `previous`/`stable` for Windows; `default`/`edge` for the GPU and
 * Android images) -- dated tags exist too but are release history, not the
 * recommended pinning mechanism, so only the moving tags are offered here.
 *
 * ## Why this table stays a hand-curated literal (issue #242)
 *
 * `internal/guides/resourceclasses.go` and `xcodeversions.go` derive their
 * own lists from CircleCI's vendored `circleci-docs` snapshot instead of
 * being retyped -- issue #242 asked whether `MACHINE_IMAGES` should join
 * them. Investigated 2026-07-30, and deliberately not done:
 *
 *   - The configuration reference's "Available Linux/Windows/GPU/Android
 *     machine images" sections are not an enumeration the way the
 *     supported-Xcode and resource-class tables are. Each one is a paragraph
 *     that names a Developer Hub URL and says, in its own words, "for a full
 *     list ... refer to" it -- upstream is pointing at a *different, unvendored*
 *     site (`circleci.com/developer/machine/image/*`) as the actual source of
 *     truth. `internal/guides` only vendors `circleci-docs` itself
 *     (docs/guides, docs/orbs, docs/reference), so there is no offline table to
 *     parse this list *from*, regardless of what shape a parser took.
 *   - Concretely: as of the snapshot vendored today, three of the Windows
 *     families below (`windows-server-2022-nvidia-medium`,
 *     `windows-server-2025-gui`, `windows-server-2025-nvidia-medium`) are not
 *     named anywhere in the vendored corpus at all. Deriving from it would
 *     silently ship a *smaller* list than this literal -- exactly the "list
 *     that silently omits images people use" issue #242 itself warns against,
 *     not drift prevention.
 *   - `internal/guides/machineimages_test.go` pins both findings as tests
 *     (one structural -- no table where a table would be needed; one
 *     falsifiable -- those three families are absent), so if upstream ever
 *     restructures this page into a real enumeration, those tests start
 *     failing and *that* is the signal to revisit derivation, not a hand
 *     re-check of this comment.
 *
 * ## Superseded, not replaced (issue #305)
 *
 * The reasoning above about the vendored *docs* still holds -- what it
 * missed is that CircleCI also publishes a live, unauthenticated API
 * (`GET /api/v3/catalog/offerings`) this project didn't know about when this
 * literal was first written. `MachineImagePicker.tsx` now prefers that live catalog
 * (fetched and cached by `internal/offerings`, served via
 * `GET /api/machine-offerings`) for compatibility filtering and deprecated-
 * image flagging, but this literal is unchanged and still what the picker
 * falls back to, labelled, the moment that catalog has never been
 * reachable -- the exact offline floor this table has always been.
 *
 * # Refreshing
 *
 * There is no automated refresh for either table. New `cimg/*` repos or
 * machine image families appear only a few times a year; when one does,
 * repeat the `curl`/Developer-Hub-page check above and add an entry. No
 * schema or checksum test pins these (unlike `internal/schema/schema.json`)
 * because they aren't a redistributed third-party artifact -- they're this
 * project's own summary of publicly documented CircleCI image names, so a
 * plain code review of the diff is the right level of scrutiny for a
 * refresh.
 */

/** One `cimg/*` Docker Hub repository CircleCI publishes as a "convenience image". */
export interface CimgImage {
  /** The repo name under the `cimg` org, e.g. `node` for `cimg/node`. */
  name: string;
  /** One-line description shown in the completion's info panel. */
  description: string;
  /**
   * Tag suffixes this image's tags are commonly published with, e.g.
   * `-browsers` on `cimg/node:20.11-browsers`. Empty for images that don't
   * publish variant tags (databases, cloud CLIs, etc.).
   */
  variants: string[];
}

/** Info shown for a variant suffix, keyed by the suffix itself (including its leading `-`). Reused across every image that offers it. */
export const CIMG_VARIANT_INFO: Readonly<Record<string, string>> = {
  '-browsers':
    'Adds headless Chrome and Firefox, for browser-based test suites',
  '-node':
    'Adds a Node.js runtime, for projects that also need to build JS/CSS assets',
  '-ndk': 'Adds the Android NDK, for projects with native (C/C++) code',
};

export const CIMG_IMAGES: readonly CimgImage[] = [
  {
    name: 'base',
    description: 'Minimal general-purpose image (Ubuntu + common CLI tools)',
    variants: [],
  },
  { name: 'python', description: 'Python', variants: ['-node', '-browsers'] },
  { name: 'node', description: 'Node.js', variants: ['-browsers'] },
  { name: 'ruby', description: 'Ruby', variants: ['-node', '-browsers'] },
  {
    name: 'openjdk',
    description: 'OpenJDK (Java, Kotlin, Scala)',
    variants: ['-node', '-browsers'],
  },
  { name: 'go', description: 'Go', variants: ['-node', '-browsers'] },
  { name: 'rust', description: 'Rust', variants: ['-node', '-browsers'] },
  { name: 'php', description: 'PHP', variants: ['-node', '-browsers'] },
  {
    name: 'android',
    description: 'Android SDK',
    variants: ['-node', '-browsers', '-ndk'],
  },
  {
    name: 'elixir',
    description: 'Elixir/Erlang',
    variants: ['-node', '-browsers'],
  },
  {
    name: 'clojure',
    description: 'Clojure/OpenJDK',
    variants: ['-node', '-browsers'],
  },
  { name: 'postgres', description: 'PostgreSQL', variants: ['-postgis'] },
  { name: 'mysql', description: 'MySQL', variants: [] },
  { name: 'mariadb', description: 'MariaDB', variants: [] },
  { name: 'redis', description: 'Redis', variants: [] },
  { name: 'aws', description: 'AWS CLI', variants: [] },
  { name: 'gcp', description: 'Google Cloud SDK', variants: [] },
  { name: 'azure', description: 'Azure CLI', variants: [] },
  {
    name: 'deploy',
    description: 'General-purpose deployment tools image',
    variants: ['-node'],
  },
  { name: 'rlang', description: 'R language', variants: [] },
  { name: 'unity', description: 'Unity game engine', variants: [] },
];

/** One machine-executor image family, addressed by `machine: image: <name>:<tag>`. */
export interface MachineImageFamily {
  /** The image family name, e.g. `ubuntu-2204`. */
  name: string;
  /** One-line description shown in the completion's info panel. */
  description: string;
  /** The "moving" tags CircleCI documents as the intended way to reference this family (see module doc comment). */
  tags: string[];
}

export const MACHINE_IMAGES: readonly MachineImageFamily[] = [
  {
    name: 'ubuntu-2204',
    description:
      'Ubuntu 22.04 LTS (default Linux machine image; also usable with arm resource classes)',
    tags: ['current', 'edge'],
  },
  {
    name: 'ubuntu-2404',
    description: 'Ubuntu 24.04 LTS',
    tags: ['current', 'edge'],
  },
  {
    name: 'ubuntu-2604',
    description: 'Ubuntu 26.04 LTS',
    tags: ['current', 'edge'],
  },
  {
    name: 'android',
    description:
      'Android SDK/emulator image (nested virtualization, x86 emulators)',
    tags: ['default', 'edge'],
  },
  {
    name: 'windows-server-2019',
    description: 'Windows Server 2019',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'windows-server-2019-cuda',
    description: 'Windows Server 2019 with NVIDIA CUDA/GPU support',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'windows-server-2022-gui',
    description: 'Windows Server 2022 with GUI support',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'windows-server-2022-nvidia-medium',
    description:
      'Windows Server 2022 with an NVIDIA GPU (medium resource class)',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'windows-server-2025-gui',
    description: 'Windows Server 2025 with GUI support',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'windows-server-2025-nvidia-medium',
    description:
      'Windows Server 2025 with an NVIDIA GPU (medium resource class)',
    tags: ['current', 'edge', 'previous', 'stable'],
  },
  {
    name: 'linux-cuda-11',
    description: 'Linux GPU image, CUDA 11',
    tags: ['default', 'edge'],
  },
  {
    name: 'linux-cuda-12',
    description: 'Linux GPU image, CUDA 12',
    tags: ['default', 'edge'],
  },
];

/** A completed image-value suggestion. `label` is what's shown; `apply` (if set) is what's inserted, replacing the whole value -- the two differ once a tag/variant is being appended to something the user already typed. */
export interface ImageCompletionItem {
  label: string;
  apply: string;
  info?: string;
}

/**
 * If `tag` ends with a `-`-prefixed fragment that's a (possibly partial)
 * match for the start of one of `variants`, strips that fragment off and
 * returns the remainder -- so a variant can be appended fresh without
 * duplicating what's already been typed (`20.11-brow` -> `20.11`, ready for
 * `-browsers` to be re-appended in full). Returns `tag` unchanged if its
 * last `-`-segment doesn't look like the start of any known variant (e.g.
 * elixir/clojure's own `-erlang-X.Y.Z`/`-openjdk-X.Y` version segments).
 */
function stripPartialVariant(tag: string, variants: readonly string[]): string {
  const dashIdx = tag.lastIndexOf('-');
  if (dashIdx === -1) return tag;
  const suffixSoFar = tag.slice(dashIdx);
  return variants.some((v) => v.startsWith(suffixSoFar))
    ? tag.slice(0, dashIdx)
    : tag;
}

/**
 * Completions for a `docker: - image:` value, given whatever's already
 * been typed (`prefix`, the full value text so far -- not just the current
 * "word", since `cimg/node:20` is one continuous value with no internal
 * word boundary CodeMirror would split on). Two phases, distinguished by
 * whether `prefix` contains a `:` yet: before one, propose the `cimg/<name>`
 * repos themselves (appending `:` so the tag is typed next); after one,
 * propose that repo's known variant suffixes appended to whatever tag has
 * been typed so far. Returns `[]` once the repo name doesn't match any
 * known `cimg` image (an unrecognized or third-party image, which this
 * table has nothing to say about) or once no tag has been started yet
 * (`cimg/node:` alone -- a bare `-browsers` with no version behind it is
 * never a real tag).
 */
export function cimgImageCandidates(prefix: string): ImageCompletionItem[] {
  const colonIdx = prefix.indexOf(':');
  if (colonIdx === -1) {
    const lowerPrefix = prefix.toLowerCase();
    return CIMG_IMAGES.filter((img) =>
      `cimg/${img.name}`.toLowerCase().startsWith(lowerPrefix),
    ).map((img) => ({
      label: `cimg/${img.name}`,
      apply: `cimg/${img.name}:`,
      info: img.description,
    }));
  }

  // Only offer variant suggestions once `cimg/` has actually been typed --
  // otherwise a coincidentally-matching bare name (a custom `node:18` image,
  // say) would get silently rewritten to `cimg/node:...` by `apply` below.
  const rawRepo = prefix.slice(0, colonIdx);
  if (!rawRepo.startsWith('cimg/')) return [];
  const repoName = rawRepo.slice('cimg/'.length);
  const image = CIMG_IMAGES.find((img) => img.name === repoName);
  const tag = prefix.slice(colonIdx + 1);
  if (!image || image.variants.length === 0 || tag.length === 0) return [];

  const baseTag = stripPartialVariant(tag, image.variants);
  if (baseTag.length === 0) return [];

  return image.variants
    .filter((variant) => `${baseTag}${variant}` !== tag)
    .map((variant) => ({
      label: `${baseTag}${variant}`,
      apply: `cimg/${repoName}:${baseTag}${variant}`,
      info: CIMG_VARIANT_INFO[variant],
    }));
}

/**
 * Completions for a `machine: image:` value, given whatever's already been
 * typed (`prefix`). Same two-phase shape as `cimgImageCandidates`: before a
 * `:`, propose the image family names; after one, propose that family's
 * known moving tags (see module doc comment for why only those, not the
 * dated release tags).
 */
export function machineImageCandidates(prefix: string): ImageCompletionItem[] {
  const colonIdx = prefix.indexOf(':');
  if (colonIdx === -1) {
    const lowerPrefix = prefix.toLowerCase();
    return MACHINE_IMAGES.filter((img) =>
      img.name.toLowerCase().startsWith(lowerPrefix),
    ).map((img) => ({
      label: img.name,
      apply: `${img.name}:`,
      info: img.description,
    }));
  }

  const familyName = prefix.slice(0, colonIdx);
  const family = MACHINE_IMAGES.find((img) => img.name === familyName);
  if (!family) return [];

  const tagPrefix = prefix.slice(colonIdx + 1).toLowerCase();
  return family.tags
    .filter((tag) => tag.toLowerCase().startsWith(tagPrefix))
    .map((tag) => ({
      label: `${familyName}:${tag}`,
      apply: `${familyName}:${tag}`,
      info: family.description,
    }));
}
