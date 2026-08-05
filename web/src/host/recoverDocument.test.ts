import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard, downloadText } from './recoverDocument';

describe('downloadText', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn<() => string>(() => 'blob:fake-url');
    revokeObjectURL = vi.fn<(url: string) => void>();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clickSpy.mockRestore();
  });

  it('creates a Blob URL, clicks a download anchor with the given filename, and revokes the URL', () => {
    downloadText('config.yml', 'version: 2.1\n');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0] as [Blob];
    expect(blob.type).toBe('text/yaml;charset=utf-8');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    // The anchor `click()` was called on is removed from the DOM
    // immediately afterward, per downloadText's own comment about Firefox
    // requiring it to have been attached in the first place -- so there
    // should be nothing left over in the document.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('still revokes the URL if the click throws', () => {
    clickSpy.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => downloadText('config.yml', 'x: 1\n')).toThrow('boom');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delegates to navigator.clipboard.writeText', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await copyToClipboard('version: 2.1\n');

    expect(writeText).toHaveBeenCalledWith('version: 2.1\n');
  });

  it('propagates a rejection (e.g. permission denied) to the caller', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyToClipboard('x: 1\n')).rejects.toThrow('denied');
  });
});
