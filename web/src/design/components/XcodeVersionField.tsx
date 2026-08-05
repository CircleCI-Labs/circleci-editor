/**
 * The macOS executor's Xcode field (issue #211, closing issue #203): the versions
 * CircleCI's own supported-Xcode table lists, grouped by whether upstream marks
 * them pre-release, with free text for a version newer than our documentation
 * snapshot.
 *
 * ## What this replaced, and why it mattered
 *
 * A bare text input, pre-filled from a literal in `paletteExecutors.ts`:
 * `defaultImage: '15.3.0'`. That version does not appear anywhere in CircleCI's
 * supported-Xcode table -- not as a version that used to be supported and was
 * dropped, but as one this editor invented. Every macOS job created from the
 * palette got an `xcode:` value CircleCI does not offer. Issue #203 found it;
 * nothing could have caught it, because a lone literal has nothing to disagree
 * with.
 *
 * Now there is no Xcode version written down anywhere in this repository. The
 * list, the tooltips and the default all come from
 * `GET /api/xcode-versions`, which the host derives from the vendored table --
 * see `internal/guides/xcodeversions.go` and its
 * `TestXcodeVersionsFromVendoredSnapshot`.
 *
 * ## Deliberately the same control as the resource-class field
 *
 * Both are `PresetSelectField`: grouped `<select>`, "Other..." escape hatch,
 * provenance line underneath. They render one above the other in
 * `ConfigureJobDialog`, and issue #213's framing -- "these three fields should
 * end up feeling like one control pattern rather than three" -- is most visible
 * exactly there. What differs is only what each field *knows*: resource classes
 * have an architecture filter, Xcode versions have a pre-release group.
 *
 * ## Pre-releases are offered, labelled, and never the default
 *
 * The table's top rows are routinely a beta and a release candidate. Hiding them
 * would make the newest Xcode look unavailable; mixing them in unlabelled would
 * let someone pick an image upstream itself says is "not frozen" and can change
 * under a running job with minimal notice. So they get their own group, under
 * CircleCI's own word for what they are, and `resolveInitialXcodeVersion` never
 * picks one.
 */
import { DocsLink } from '~/design/components/DocsLink';
import {
  PresetSelectField,
  type PresetGroup,
} from '~/design/components/PresetSelectField';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import {
  xcodeVersionGroups,
  xcodeVersionTitle,
} from '~/lib/xcodeVersions/xcodeVersionOptions';
import { useXcodeVersions } from '~/lib/xcodeVersions/useXcodeVersions';

/** `XcodeVersionGroup`s as `PresetSelectField` wants them, with the table's own wording as each option's `title`. */
function toPresetGroups(
  groups: ReturnType<typeof xcodeVersionGroups>,
): PresetGroup[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    options: group.versions.map((version) => ({
      value: version.version,
      title: xcodeVersionTitle(version),
    })),
  }));
}

export function XcodeVersionField({
  id,
  value,
  onChange,
  customCommit = 'blur',
  ariaLabel,
}: {
  id: string;
  /** The current `xcode:` value, or `''` when none is set. */
  value: string;
  /** Called with the new value. Never called with the custom sentinel or an empty string. */
  onChange: (next: string) => void;
  /** See `PresetSelectField`'s own `customCommit` -- passed straight through. */
  customCommit?: 'blur' | 'change';
  /** An explicit accessible name, for a usage where the visible label can't point at this select. */
  ariaLabel?: string;
}) {
  const response = useXcodeVersions();
  // `?? []` rather than trusting the field: this control renders inside a dialog
  // and inside the inspector, and neither should throw because a host (or a test
  // double) answered with a payload missing a key. Same convention, and same
  // reason, as `ResourceClassField`.
  const versions = response?.versions ?? [];
  const groups = xcodeVersionGroups(versions);

  const selected = versions.find((version) => version.version === value);

  return (
    <PresetSelectField
      id={id}
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      groups={toPresetGroups(groups)}
      // No `fallbackValues`. The resource-class field can fall back to the one
      // class its palette card knows; there is no equivalent here, because the
      // point of this change is that no card knows an Xcode version. With the
      // host unreachable the field offers whatever the config already says (see
      // `PresetSelectField`'s `presetValues`) plus free text, and says why.
      customCommit={customCommit}
      customLabel="Custom Xcode version"
      customPlaceholder="e.g. 26.5"
    >
      {/* The pre-release warning is repeated *outside* the option's `title`
          because a tooltip is not a place to put a consequence: someone who
          picked a beta from a labelled group has still not necessarily read
          what "not frozen" means for their build. */}
      {selected?.prerelease ? (
        <p className="mt-1 text-2xs text-cc-warning">
          CircleCI lists Xcode {selected.version} as a{' '}
          {selected.prereleaseKind ?? 'pre-release'}. Pre-release images are not
          frozen &mdash; each new pre-release overwrites the previous one, so
          this image can change under your job with minimal notice.
        </p>
      ) : null}

      <p className="mt-1 text-2xs text-cc-text-faint">
        From{' '}
        <DocsLink {...DOCS_LINKS.executors.supportedXcodeVersions}>
          CircleCI&rsquo;s supported-Xcode table
        </DocsLink>
        {selected?.label ? ` -- ${selected.label}.` : '.'}
      </p>
      {response && !response.derived ? (
        <p className="mt-1 text-2xs text-cc-warning">{response.reason}</p>
      ) : null}
    </PresetSelectField>
  );
}
