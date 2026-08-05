import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '~/state/appStore';

// Only the editor component is stubbed; every other export is passed through
// from the real module -- see `App.test.tsx`'s identical mock for why
// (replacing the module wholesale breaks the moment the pane imports another
// CodeMirror export). `readOnly` is forwarded onto the stand-in `<textarea>`
// so the compiled view's read-only-ness is actually observable in a test,
// not just asserted by trusting the prop was passed.
vi.mock('@uiw/react-codemirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uiw/react-codemirror')>();
  return {
    ...actual,
    __esModule: true,
    default: ({
      value,
      onChange,
      readOnly,
      'aria-label': ariaLabel,
    }: {
      value: string;
      onChange?: (value: string) => void;
      readOnly?: boolean;
      'aria-label'?: string;
    }) => (
      <textarea
        aria-label={ariaLabel}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      />
    ),
  };
});

import { YamlPane } from './YamlPane';

const BASE_STATE = {
  text: 'version: 2.1\njobs:\n  build:\n    docker: []\n',
  // Matches `text` by default -- i.e. nothing unsaved, consistent with
  // `isDirty: false` below. Issue #287's tests override this per-case to
  // exercise the Diff view's actual comparison.
  savedText: 'version: 2.1\njobs:\n  build:\n    docker: []\n',
  configPath: '/repo/.circleci/config.yml',
  isDirty: false,
  parseError: null,
  status: 'ready' as const,
  autosave: false,
  validation: { state: 'idle' as const, errors: [] },
};

describe('YamlPane', () => {
  beforeEach(() => {
    // `getSchema()` fires on mount (see the pane's own effect) and is left
    // to fail silently -- stubbed to reject outright so these tests never
    // make a real network call and never depend on its result.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in tests'))),
    );
    useAppStore.setState(BASE_STATE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the Source view, with Compiled available but not yet selected', () => {
    render(<YamlPane />);

    const group = screen.getByRole('group', { name: /config view/i });
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Compiled' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(group).toBeInTheDocument();
    expect(screen.getByLabelText(/yaml config editor/i)).toHaveValue(
      BASE_STATE.text,
    );
  });

  it('shows the compiled config -- read-only -- once validation has succeeded', () => {
    useAppStore.setState({
      validation: {
        state: 'valid',
        errors: [],
        outputYaml:
          'version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/node:20.0\n',
      },
    });
    render(<YamlPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    expect(screen.getByText(/compiled \(read-only\)/i)).toBeInTheDocument();
    const compiled = screen.getByLabelText(/compiled circleci config/i);
    expect(compiled).toHaveValue(
      'version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/node:20.0\n',
    );
    expect(compiled).toHaveAttribute('readonly');
  });

  // `available` (this host has a CIRCLE_TOKEN) and `valid` (this config
  // compiled successfully) are deliberately different axes -- see
  // `internal/host/validate.go`'s own doc comment -- so "no token" and
  // "config is broken" must read as different messages, not both as a
  // generic "unavailable".
  it('explains a missing token honestly, distinct from an invalid config', () => {
    useAppStore.setState({
      validation: {
        state: 'unavailable',
        errors: [],
        reason: 'no CircleCI API token available; validation requires a token',
      },
    });
    render(<YamlPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    expect(
      screen.getByText(/no circleci api token available/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/doesn.t compile yet/i)).not.toBeInTheDocument();
  });

  it('explains an invalid config distinctly, pointing back at the errors below rather than claiming "unavailable"', () => {
    useAppStore.setState({
      validation: {
        state: 'invalid',
        errors: [{ message: 'job "build" requires "nonexistent"' }],
      },
    });
    render(<YamlPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    expect(screen.getByText(/doesn.t compile yet/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/no circleci api token/i),
    ).not.toBeInTheDocument();
    // The compiler-errors panel underneath (shared with the Source view) is
    // still there to explain *why* -- it isn't gated on which view is active.
    expect(
      screen.getByText(/job "build" requires "nonexistent"/i),
    ).toBeInTheDocument();
  });

  it('reports a failed validation request distinctly from an invalid config', () => {
    useAppStore.setState({
      validation: { state: 'error', errors: [], reason: 'network error' },
    });
    render(<YamlPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    // "validation request failed" also appears in the (view-independent)
    // error banner underneath -- assert the Compiled message specifically,
    // not just that the phrase exists somewhere on the page.
    expect(
      screen.getByText(
        /compiled view unavailable -- the validation request failed/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/network error/i).length).toBeGreaterThan(0);
  });

  it('never lets a local YAML parse error be mistaken for a compiler-side problem', () => {
    useAppStore.setState({
      parseError: 'Unexpected token at line 2, column 1',
    });
    render(<YamlPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    expect(
      screen.getByText(/fix the yaml parse error in source view/i),
    ).toBeInTheDocument();
  });

  // Regression test: `PaneSlot`'s collapse/expand already established the
  // convention of `hidden`, never an unmount, so a user's in-progress
  // cursor/scroll position survives a round trip -- the Source/Compiled
  // toggle follows the same rule for the source editor.
  it('keeps the source editor mounted (not unmounted) while Compiled is showing', () => {
    useAppStore.setState({
      validation: { state: 'valid', errors: [], outputYaml: 'version: 2.1\n' },
    });
    render(<YamlPane />);

    const sourceEditor = screen.getByLabelText(/^yaml config editor$/i);
    fireEvent.click(screen.getByRole('button', { name: 'Compiled' }));

    expect(sourceEditor).toBeInTheDocument();
    expect(sourceEditor).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(sourceEditor).toBeVisible();
  });

  // Issue #287: a third mode, alongside Source and Compiled, diffing the
  // working buffer against what's on disk -- reusing the same `DiffView`
  // component (and the `unifiedDiff` computation) `SaveDialog` and
  // `ProposeChangeDialog` already render, rather than a fourth thing to
  // find (a dialog or a separate pane).
  describe('the Diff view', () => {
    it('is available from the toggle, alongside Source and Compiled', () => {
      render(<YamlPane />);

      const group = screen.getByRole('group', { name: /config view/i });
      expect(screen.getByRole('button', { name: 'Diff' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(group).toBeInTheDocument();
    });

    it('states "no changes" plainly rather than rendering an empty pane, when the buffer matches disk', () => {
      render(<YamlPane />);

      fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

      expect(screen.getByRole('button', { name: 'Diff' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const diffView = within(screen.getByTestId('yaml-diff-view'));
      expect(
        diffView.getByText(/no changes -- this file matches what's on disk/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/diff vs\. disk/i)).toHaveTextContent(
        'no changes',
      );
    });

    it('renders a real unified diff -- unchanged lines, and only the changed one marked -- against what is on disk, not the last save dialog or AI approval', () => {
      useAppStore.setState({
        savedText:
          'version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/node:18.0\n',
        text: 'version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/node:20.0\n',
        isDirty: true,
      });
      render(<YamlPane />);

      fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

      // The minimal-diff promise, made visible: a one-line change produces
      // one added and one removed line, not a wholesale rewrite.
      expect(screen.getByText(/diff vs\. disk/i)).toHaveTextContent('+1 -1');
      // Scoped to the diff view itself -- the hidden source `<textarea>`
      // mounted alongside it (see the `hidden` comment on the source
      // wrapper) carries the same substrings in its own (unchanged) value,
      // which would otherwise make an unscoped query ambiguous.
      const diffView = within(screen.getByTestId('yaml-diff-view'));
      expect(diffView.getByText(/cimg\/node:18\.0/)).toBeInTheDocument();
      expect(diffView.getByText(/cimg\/node:20\.0/)).toBeInTheDocument();
      // Unchanged context lines (issue #287's whole point) still render --
      // the surrounding structure is not swallowed by the diff.
      expect(diffView.getByText('jobs:')).toBeInTheDocument();
    });

    it('still shows the diff against a parse error, since a text diff needs no successful parse', () => {
      useAppStore.setState({
        savedText: 'version: 2.1\n',
        text: 'version: 2.1\n  bad indent\n',
        isDirty: true,
        parseError: 'Unexpected token at line 2, column 1',
      });
      render(<YamlPane />);

      fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

      const diffView = within(screen.getByTestId('yaml-diff-view'));
      expect(diffView.getByText(/bad indent/)).toBeInTheDocument();
    });

    it('is mounted only while selected, the same as Compiled', () => {
      render(<YamlPane />);

      const sourceEditor = screen.getByLabelText(/^yaml config editor$/i);
      fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

      expect(sourceEditor).toBeInTheDocument();
      expect(sourceEditor).not.toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: 'Source' }));
      expect(sourceEditor).toBeVisible();
    });
  });
});
