/**
 * Turns `GET /api/xcode-versions`' rows into what the macOS executor's Xcode field
 * renders, and what the YAML pane's `xcode:` completion offers (issue #211).
 *
 * Pure and framework-free -- no React -- so the grouping, ordering and
 * "what should a new job get?" logic is assertable without a render. Same
 * convention as `resourceClassOptions.ts`, which this deliberately mirrors: the
 * two fields sit next to each other in the same dialog, and a user who learns one
 * should not have to learn the other (issue #213's "these three fields should end
 * up feeling like one control pattern").
 *
 * ## Pre-releases are grouped, not hidden
 *
 * Upstream's table is newest-first and its top rows are routinely a beta and a
 * release candidate. Hiding those would make the newest Xcode look unavailable;
 * mixing them in unlabelled would let someone pick an image upstream says is "not
 * frozen" and can change under a running job with minimal notice. So they are
 * offered, in their own group, under CircleCI's own word for what they are -- the
 * same "say what the data says, in the data's own words" rule the resource-class
 * groups follow.
 */
import type { XcodeVersion } from './types';

/** One option group in the Xcode `<select>`. */
export interface XcodeVersionGroup {
  id: string;
  /** The group heading. */
  label: string;
  versions: XcodeVersion[];
}

/**
 * The group headings. "Supported" rather than "Stable": the table's own name for
 * itself is "Supported Xcode versions", and calling the other group's contents
 * unsupported would be wrong -- they are supported, they are just not frozen.
 */
const SUPPORTED_GROUP_LABEL = 'Supported';
const PRERELEASE_GROUP_LABEL = 'Pre-release (not frozen -- may change)';

/**
 * The option groups to render, in upstream's own order within each group.
 *
 * Two groups at most, and a group with no rows is dropped rather than rendered
 * empty -- so a table that stops carrying pre-releases simply shows one
 * unlabelled-feeling list, with no control that cannot change anything.
 *
 * When there is nothing to separate (every row in one bucket) the single group
 * still carries its heading, because the heading is the only place the UI says
 * whether what you are looking at is frozen.
 */
export function xcodeVersionGroups(
  versions: readonly XcodeVersion[],
): XcodeVersionGroup[] {
  const supported = versions.filter((version) => !version.prerelease);
  const prerelease = versions.filter((version) => version.prerelease);

  const groups: XcodeVersionGroup[] = [];
  if (supported.length > 0) {
    groups.push({
      id: 'supported',
      label: SUPPORTED_GROUP_LABEL,
      versions: supported,
    });
  }
  if (prerelease.length > 0) {
    groups.push({
      id: 'prerelease',
      label: PRERELEASE_GROUP_LABEL,
      versions: prerelease,
    });
  }
  return groups;
}

/** Every version string in `groups`, in order -- what "is the current value one of the presets?" is asked against. */
export function groupedVersionNames(
  groups: readonly XcodeVersionGroup[],
): string[] {
  return groups.flatMap((group) =>
    group.versions.map(({ version }) => version),
  );
}

/**
 * The version to preselect for a newly created macOS job: the host's own
 * `default` when the offered list still contains it, then the first non-pre-release
 * row, then the first row, then `''`.
 *
 * Unlike `resolveInitialResourceClass` there is no caller preference to honour.
 * Docker jobs start on `medium` rather than the `small` that heads CircleCI's
 * table because that is a product choice about compute; there is no equivalent
 * reason to prefer one Xcode over another, so nothing in this repository writes an
 * Xcode version down. That is issue #203's fix at the root rather than a fresher
 * copy of the same literal.
 *
 * Returns `''` when nothing is on offer -- the host unreachable. The field then
 * shows whatever the config already says and offers free text, which is the only
 * honest answer: an Xcode version this app has not seen in a table is a version it
 * has no business suggesting.
 */
export function resolveInitialXcodeVersion(
  response: { versions: readonly XcodeVersion[]; default?: string } | undefined,
): string {
  const versions = response?.versions ?? [];
  if (versions.length === 0) return '';
  const preferred = response?.default ?? '';
  if (versions.some(({ version }) => version === preferred)) return preferred;
  const stable = versions.find(({ prerelease }) => !prerelease);
  return stable?.version ?? versions[0]?.version ?? '';
}

/**
 * The `title` text for one option: CircleCI's own label for the row, its machine
 * summary, the classes it runs on, and the pre-release warning when there is one.
 *
 * Every clause is read from the table. Nothing here describes an Xcode version in
 * this project's words, which is what stops a tooltip from being the one place the
 * documentation and the editor disagree.
 */
export function xcodeVersionTitle(version: XcodeVersion): string | undefined {
  const classes = version.resourceClasses ?? [];
  const parts = [
    version.label,
    version.spec,
    classes.length > 0 ? `Runs on ${classes.join(', ')}` : '',
    version.prerelease
      ? `CircleCI lists this as a ${version.prereleaseKind ?? 'pre-release'}: pre-release images are not frozen and can change with minimal notice.`
      : '',
  ]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' -- ') : undefined;
}

/**
 * The versions matching `prefix`, for the YAML pane's `xcode:` completion.
 *
 * A prefix match, not a substring one: `xcode:` values are dotted version numbers
 * read left to right, so someone who has typed `26.` means "the 26 line" and would
 * be surprised to be offered `16.4.0` because it contains a `6.`. This is the one
 * place the Xcode control and the tag combobox deliberately differ -- see
 * `matchesTagQuery`, where substring matching is right because a tag can carry a
 * variant suffix someone searches by.
 *
 * `''` matches everything, so opening the completion on an empty value (or after
 * deleting the whole value -- see `reopenCompletionOnDelete`) offers the full
 * list rather than nothing.
 */
export function xcodeVersionsMatching(
  versions: readonly XcodeVersion[],
  prefix: string,
): XcodeVersion[] {
  const trimmed = prefix.trim();
  if (trimmed === '') return [...versions];
  return versions.filter(({ version }) => version.startsWith(trimmed));
}
