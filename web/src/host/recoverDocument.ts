/**
 * The two ways `HostGoneOverlay` offers to get an unsaved document out of
 * this tab once the host it would have been saved through is gone (issue
 * #110). Both operate purely on text already in memory -- neither touches
 * the network or the (now-unreachable) host -- which is exactly why either
 * one is still possible at all.
 */

/**
 * Triggers a browser download of `contents` named `filename`, entirely
 * client-side via a `Blob` URL. `document.body.appendChild` is required for
 * Firefox, which (unlike Chromium) does not dispatch a click on an anchor
 * that was never attached to the document.
 */
export function downloadText(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Copies `contents` to the clipboard. `navigator.clipboard` requires a
 * secure context, but per the Fetch/Clipboard specs' definition of
 * "potentially trustworthy origin", `http://127.0.0.1` and
 * `http://localhost` both qualify -- which is exactly what this app is
 * always served over (see `internal/host/browser.go`'s `validateLocalURL`)
 * -- so this works without HTTPS here specifically because the host never
 * serves this app anywhere else.
 */
export function copyToClipboard(contents: string): Promise<void> {
  return navigator.clipboard.writeText(contents);
}
