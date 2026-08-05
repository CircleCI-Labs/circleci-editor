/**
 * A deterministic, generated "avatar" for an orb, used in place of a logo.
 *
 * The CircleCI v3 orb registry API has no logo/icon/avatar field anywhere:
 * confirmed by hitting `GET /api/v3/orb/packages` (both the bulk list and
 * the single-orb `filter[name]` lookup), `GET /api/v3/orb/versions`,
 * `GET /api/v3/orb/categories`, and `GET /api/v3/namespaces` directly against
 * the real API and inspecting the raw response bodies -- every one of them
 * returns only `{id, attributes: {name, is_private, is_listed, ...}}`-shaped
 * data (plus, for a single-orb lookup only, an `orb_categories` relationship
 * that is itself just `{id, attributes: {name}}`). None of it is an image
 * URL. See the PR description for the exact JSON this produced.
 *
 * Rather than a blank space (or, worse, quietly reaching out to a
 * third-party host per orb, which is exactly the kind of fragile external
 * dependency this project already rejected Algolia over), every orb gets a
 * small colored monogram derived only from its own name: the same orb
 * always renders the same way, there is no network request or bundled
 * image asset involved, and a 6,000-entry results list is at least
 * visually scannable rather than a wall of identical rows.
 */

/** The palette a monogram's background/foreground is picked from -- all of
 * them existing `--color-cc-*` theme tokens (see styles.css), never a
 * one-off hex value. Five buckets is enough variety for adjacent rows to
 * look different without needing more hues than this dark palette
 * actually has to spare. */
export const AVATAR_TONES = [
  'accent',
  'success',
  'warning',
  'danger',
  'info',
] as const;

export type AvatarTone = (typeof AVATAR_TONES)[number];

/**
 * A small, fast, deterministic string hash (FNV-1a). Good enough to spread
 * orb names roughly evenly across `AVATAR_TONES` and initial letters; not
 * used for anything security-sensitive, so collision resistance doesn't
 * matter here.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Picks a stable tone for `fullName` ("<namespace>/<name>", or just a bare
 * name for an orb reference with no namespace segment). Always returns the
 * same tone for the same input. */
export function avatarTone(fullName: string): AvatarTone {
  const index = hashString(fullName) % AVATAR_TONES.length;
  return AVATAR_TONES[index] ?? 'accent';
}

/**
 * The one-or-two-letter monogram shown in an `OrbAvatar`: the first letter
 * of the namespace plus the first letter of the orb name, e.g.
 * "circleci/slack" -> "CS". Falls back to the first two letters of the
 * whole string when there's no "/" (an orb reference should always have
 * one, but this is defensive against a malformed or partial name rather
 * than throwing).
 */
export function avatarInitials(fullName: string): string {
  const slash = fullName.indexOf('/');
  if (slash < 0) {
    return fullName.slice(0, 2).toUpperCase() || '?';
  }

  const namespace = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  const initials = (namespace.charAt(0) + name.charAt(0)).toUpperCase();
  return initials.trim() || '?';
}
