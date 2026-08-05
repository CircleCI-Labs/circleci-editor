/**
 * WCAG 2.x relative-luminance contrast ratio, per the spec's own formula
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance /
 * #dfn-contrast-ratio). Pure sRGB math, no DOM -- used both by unit tests
 * asserting a *derived* token's contrast (e.g. `yamlHighlight.test.ts`'s
 * light syntax palette) and by `e2e/contrast.spec.ts`'s real-DOM audit,
 * which extracts `rgb(...)`/`rgba(...)` strings via `getComputedStyle` in
 * the browser and hands them to `contrastRatio` here in the Node-side test
 * body -- one implementation, so the two can't silently disagree.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const RGB_RE =
  /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i;

/**
 * Parses a CSS `rgb(...)`/`rgba(...)` string, the form every browser's
 * `getComputedStyle(...).color`/`.backgroundColor` resolves to regardless
 * of how the colour was originally authored (hex, `oklch()`, a named
 * colour, ...). Returns `null` for anything else (e.g. `"transparent"`,
 * which has no colour to contrast against -- callers must walk up to a
 * parent's background instead, they can't treat it as black).
 */
export function parseRgb(value: string): Rgb | null {
  const match = RGB_RE.exec(value);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** The WCAG contrast ratio between two colours, always >= 1 (order doesn't matter). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA thresholds (2.1, 1.4.3): 4.5:1 for normal text, 3:1 for "large"
 * text (>=18.66px, or >=14.66px bold) and non-text UI component boundaries. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
