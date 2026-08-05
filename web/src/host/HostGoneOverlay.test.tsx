import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '~/state/appStore';

import { HostGoneOverlay } from './HostGoneOverlay';

const { useHostLivenessMock } = vi.hoisted(() => ({
  useHostLivenessMock: vi.fn<() => boolean>(),
}));
vi.mock('./hostLiveness', () => ({
  useHostLiveness: useHostLivenessMock,
}));

const { downloadTextMock, copyToClipboardMock } = vi.hoisted(() => ({
  downloadTextMock: vi.fn<(filename: string, contents: string) => void>(),
  copyToClipboardMock: vi.fn<(contents: string) => Promise<void>>(),
}));
vi.mock('./recoverDocument', () => ({
  downloadText: downloadTextMock,
  copyToClipboard: copyToClipboardMock,
}));

describe('HostGoneOverlay', () => {
  beforeEach(() => {
    useHostLivenessMock.mockReset();
    downloadTextMock.mockReset();
    copyToClipboardMock.mockReset();
    copyToClipboardMock.mockResolvedValue(undefined);
    vi.stubGlobal('close', vi.fn());
    useAppStore.setState({
      isDirty: false,
      text: 'version: 2.1\n',
      configPath: '/home/dev/widgets/.circleci/config.yml',
    });
  });

  it('renders nothing while the host is alive', () => {
    useHostLivenessMock.mockReturnValue(true);
    render(<HostGoneOverlay />);

    expect(
      screen.queryByText(/connection to circleci-editor was lost/i),
    ).not.toBeInTheDocument();
  });

  it('blocks the page with an unmistakable notice once the host is gone', () => {
    useHostLivenessMock.mockReturnValue(false);
    render(<HostGoneOverlay />);

    expect(
      screen.getByText(/connection to circleci-editor was lost/i),
    ).toBeVisible();
  });

  describe('with unsaved changes', () => {
    beforeEach(() => {
      useAppStore.setState({ isDirty: true });
      useHostLivenessMock.mockReturnValue(false);
    });

    it('offers Download and Copy, and never attempts to close the window', () => {
      render(<HostGoneOverlay />);

      expect(
        screen.getByRole('button', { name: /download config\.yml/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /copy to clipboard/i }),
      ).toBeInTheDocument();

      // The one thing this overlay must never risk: closing a window before
      // its recovery actions have been seen (see the component's own
      // comment on the window.close() effect).
      expect(window.close).not.toHaveBeenCalled();
    });

    it('Download passes the current text and the filename derived from configPath', () => {
      render(<HostGoneOverlay />);

      screen.getByRole('button', { name: /download config\.yml/i }).click();

      expect(downloadTextMock).toHaveBeenCalledWith(
        'config.yml',
        'version: 2.1\n',
      );
    });

    it('Copy writes the current text to the clipboard and confirms on success', async () => {
      render(<HostGoneOverlay />);

      screen.getByRole('button', { name: /copy to clipboard/i }).click();

      expect(copyToClipboardMock).toHaveBeenCalledWith('version: 2.1\n');
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /^copied$/i }),
        ).toBeInTheDocument(),
      );
    });

    it('Copy reports failure distinctly rather than claiming success', async () => {
      copyToClipboardMock.mockRejectedValue(new Error('denied'));
      render(<HostGoneOverlay />);

      screen.getByRole('button', { name: /copy to clipboard/i }).click();

      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /copy failed/i }),
        ).toBeInTheDocument(),
      );
    });
  });

  describe('with no unsaved changes', () => {
    beforeEach(() => {
      useAppStore.setState({ isDirty: false });
      useHostLivenessMock.mockReturnValue(false);
    });

    it('says it is safe to close, and does not offer Download/Copy', () => {
      render(<HostGoneOverlay />);

      expect(screen.getByText(/you can close this tab/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /download/i }),
      ).not.toBeInTheDocument();
    });

    it('makes a best-effort attempt to close the window itself', async () => {
      render(<HostGoneOverlay />);

      await waitFor(() => expect(window.close).toHaveBeenCalledTimes(1));
    });
  });
});
