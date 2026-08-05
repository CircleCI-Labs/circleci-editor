/**
 * Pure functions over `MachineOfferingsState`, kept out of
 * `MachineImagePicker.tsx` and unit-tested without a render -- the same
 * split `resourceClassOptions.ts` uses for `ResourceClassField` (issue
 * #305, "image <-> resource-class compatibility for free").
 *
 * # What this deliberately does not do
 *
 * The offerings catalog lists full `<family>:<tag>` image strings
 * (`"ubuntu-2404:current"`), but `images.ts`'s own provenance comment
 * explains why `MACHINE_IMAGES` offers only a small, CircleCI-documented set
 * of "moving" tags (`current`/`edge`/`previous`/`stable`) rather than every
 * dated release CircleCI has ever published for a family. This module only
 * ever narrows *families*, not tags: filtering the tag list by exactly which
 * dated releases the catalog happens to list for one resource class would
 * quietly undo that deliberate curation and start surfacing release-history
 * tags the picker was built to hide. Deprecation flagging is the one place a
 * *tag* is checked against the catalog, because "this exact tag has been
 * retired" is a fact about that tag specifically, not a curation decision.
 */
import type { MachineOfferingsState } from './useMachineOfferings';

/** Splits `"ubuntu-2404:current"` into its family name, `"ubuntu-2404"`. Returns the whole string unchanged if it carries no `:`. */
function familyNameOf(image: string): string {
  const colonIdx = image.indexOf(':');
  return colonIdx === -1 ? image : image.slice(0, colonIdx);
}

/**
 * The image families offered for `resourceClass`, per the live catalog --
 * or `undefined` when there is nothing to say: the catalog is unavailable,
 * `resourceClass` is unset, or `resourceClass` is a real class this
 * catalog's snapshot does not (yet, or ever) cover.
 *
 * `undefined` and "an empty set" mean different things and callers must not
 * conflate them: an empty set would filter every family out of the picker,
 * which is a worse answer than showing the unfiltered list whenever this
 * function does not actually know. Checks `linux` first, then `windows` --
 * a resource class belongs to at most one of them (see
 * `internal/circleci.Offerings`'s own doc comment), so this is "whichever
 * one has it", not a preference between the two.
 */
export function familiesForResourceClass(
  state: MachineOfferingsState | undefined,
  resourceClass: string,
): Set<string> | undefined {
  if (!state?.available || !resourceClass) return undefined;
  const images = state.linux[resourceClass] ?? state.windows[resourceClass];
  if (!images) return undefined;
  return new Set(images.map(familyNameOf));
}

/**
 * Reports whether `image` (a full `<family>:<tag>` string, e.g.
 * `"windows-server-2019:stable"`) is in the live catalog's deprecated list.
 *
 * Checks `linux` and `windows` together (`MachineImagePicker` covers both),
 * never `macos` -- the Xcode field is a separate control, and the live
 * catalog's deprecation data deliberately does not flow into it yet. Always false
 * when the catalog is unavailable: an unknown deprecation status must never
 * read as "known and clean".
 */
export function isDeprecatedMachineImage(
  state: MachineOfferingsState | undefined,
  image: string,
): boolean {
  if (!state?.available) return false;
  const deprecated = [
    ...(state.deprecated.linux ?? []),
    ...(state.deprecated.windows ?? []),
  ];
  return deprecated.includes(image);
}
