/**
 * Vite's `?raw` import suffix returns any file's contents as a plain
 * string, regardless of extension. TypeScript has no built-in knowledge of
 * this Vite-specific convention, so declare it for the `.yml` fixtures the
 * round-trip tests import verbatim.
 */
declare module '*.yml?raw' {
  const content: string;
  export default content;
}
