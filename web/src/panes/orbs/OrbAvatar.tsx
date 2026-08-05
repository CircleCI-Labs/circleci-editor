/**
 * A small, deterministic colored monogram standing in for an orb's logo.
 * See `~/lib/orbs/avatar`'s doc comment for why this is generated rather
 * than fetched: the v3 registry API exposes no logo/icon field at all.
 *
 * Purely decorative -- the orb's name is always rendered as text right next
 * to this, so screen readers gain nothing from also announcing the
 * monogram, hence `aria-hidden`.
 */
import { avatarInitials, avatarTone, type AvatarTone } from '~/lib/orbs/avatar';

// One literal class string per tone, not built via template interpolation:
// Tailwind's build-time scanner matches literal text in source, so an
// interpolated `${tone}` inside a class name would silently fail to
// generate any CSS (same constraint `Badge`'s `toneClasses` documents).
const toneClassNames: Record<AvatarTone, string> = {
  accent:
    'bg-[color-mix(in_srgb,var(--color-cc-accent)_22%,transparent)] text-cc-accent',
  success:
    'bg-[color-mix(in_srgb,var(--color-cc-success)_22%,transparent)] text-cc-success',
  warning:
    'bg-[color-mix(in_srgb,var(--color-cc-warning)_22%,transparent)] text-cc-warning',
  danger:
    'bg-[color-mix(in_srgb,var(--color-cc-danger)_22%,transparent)] text-cc-danger',
  info: 'bg-[color-mix(in_srgb,var(--color-cc-info)_22%,transparent)] text-cc-info',
};

export function OrbAvatar({
  name,
  size = 20,
}: {
  name: string;
  size?: number;
}) {
  const tone = avatarTone(name);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-mono font-semibold leading-none ${toneClassNames[tone]}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {avatarInitials(name)}
    </span>
  );
}
