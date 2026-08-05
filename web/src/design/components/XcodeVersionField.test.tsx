import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  xcodeVersionsFetchStub,
  xcodeVersionsFixture,
} from '~/lib/xcodeVersions/testFixtures';
import type { XcodeVersionsResponse } from '~/lib/xcodeVersions/types';
import { __resetXcodeVersionsCacheForTests } from '~/lib/xcodeVersions/useXcodeVersions';

import { XcodeVersionField } from './XcodeVersionField';

/**
 * `XcodeVersionField`'s own tests (issue #211, closing #203). The grouping and
 * ordering rules are unit-tested without a render in
 * `~/lib/xcodeVersions/xcodeVersionOptions.test.ts`; what is left for here is what
 * the *control* does -- which options appear, what it commits and when, and the
 * things it must say out loud.
 */
function stubFetch(response: XcodeVersionsResponse = xcodeVersionsFixture()) {
  __resetXcodeVersionsCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(xcodeVersionsFetchStub({}, response)),
  );
}

/** Resolves `useXcodeVersions`' one fetch, after which the options exist. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function optionValues(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll('option'), (o) => o.value);
}

function groupLabels(select: HTMLElement): string[] {
  return Array.from(
    select.querySelectorAll('optgroup'),
    (g) => g.getAttribute('label') ?? '',
  );
}

function renderField(
  props: Partial<Parameters<typeof XcodeVersionField>[0]> = {},
) {
  return render(
    <XcodeVersionField
      id="xcode"
      ariaLabel="Xcode version"
      value="26.5"
      onChange={vi.fn<(next: string) => void>()}
      {...props}
    />,
  );
}

beforeEach(() => {
  __resetXcodeVersionsCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('XcodeVersionField', () => {
  it('offers the versions CircleCI’s table lists, grouped by pre-release status', async () => {
    stubFetch();
    renderField();
    await flush();

    const select = screen.getByRole('combobox', { name: 'Xcode version' });
    expect(groupLabels(select)).toEqual([
      'Supported',
      'Pre-release (not frozen -- may change)',
    ]);
    expect(optionValues(select)).toEqual([
      '26.5',
      '26.4.1',
      '16.4.0',
      '27.0',
      '26.6',
      '__custom__',
    ]);
  });

  it('never offers 15.3.0, the version this field used to be pre-filled with', async () => {
    // Issue #203 at the surface a user actually touches. The old control was a text
    // input placeheld with `15.3.0`; there is now no path through this field that
    // suggests it, because it is not in CircleCI's table.
    stubFetch();
    renderField();
    await flush();

    expect(
      optionValues(screen.getByRole('combobox', { name: 'Xcode version' })),
    ).not.toContain('15.3.0');
  });

  it('commits the chosen version, verbatim', async () => {
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Xcode version' }), {
      target: { value: '26.4.1' },
    });
    expect(onChange).toHaveBeenCalledWith('26.4.1');
  });

  it('warns, in place, when the chosen version is a pre-release', async () => {
    // A labelled option group is not enough on its own: someone who picked a beta
    // has still not necessarily read what "not frozen" means for their build. The
    // consequence is stated next to the field, not only in a tooltip.
    stubFetch();
    renderField({ value: '27.0' });
    await flush();

    expect(
      screen.getByText(/CircleCI lists Xcode 27\.0 as a beta/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not\s+frozen/)).toBeInTheDocument();
  });

  it('says nothing of the kind for a supported version', async () => {
    stubFetch();
    renderField({ value: '26.5' });
    await flush();

    expect(screen.queryByText(/not frozen/)).not.toBeInTheDocument();
    // And it names CircleCI's own wording for the row it is on.
    expect(screen.getByText(/Xcode 26\.5 \(17F42\)/)).toBeInTheDocument();
  });

  it('keeps a free-text escape hatch, for a version newer than our snapshot', async () => {
    // A new Xcode must be writable before the seven-day docs refresh notices it.
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Xcode version' }), {
      target: { value: '__custom__' },
    });
    const custom = screen.getByLabelText('Custom Xcode version');
    fireEvent.change(custom, { target: { value: '27.1' } });
    // Default `customCommit` is 'blur', so nothing yet -- in the inspector each
    // commit is a YAML mutation and an undo entry.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(custom);
    expect(onChange).toHaveBeenCalledWith('27.1');
  });

  it('commits free text as it is typed when the caller asks for it', async () => {
    // `ConfigureJobDialog` writes nothing until "Create job", so waiting for a blur
    // that clicking the button may never produce would drop what was typed.
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange, customCommit: 'change' });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Xcode version' }), {
      target: { value: '__custom__' },
    });
    fireEvent.change(screen.getByLabelText('Custom Xcode version'), {
      target: { value: '27.1' },
    });
    expect(onChange).toHaveBeenCalledWith('27.1');
  });

  it('shows a version the table does not list rather than dropping it', async () => {
    // Including, specifically, a config that already says `xcode: 15.3.0` -- very
    // possibly written by this editor before the fix. The field must show what the
    // file says; it just must not suggest it.
    stubFetch();
    renderField({ value: '15.3.0' });
    await flush();

    expect(screen.getByLabelText('Custom Xcode version')).toHaveValue('15.3.0');
  });

  it('says so when the list is not the current documentation’s', async () => {
    // An empty dropdown is worse than a dated one; a dated one presented as current
    // is worse than either.
    stubFetch({
      versions: [{ version: '26.5' }],
      default: '26.5',
      derived: false,
      reason: 'showing the list embedded in this release instead',
    });
    renderField();
    await flush();

    expect(
      screen.getByText(/embedded in this release instead/),
    ).toBeInTheDocument();
  });

  it('falls back to the config’s own value plus free text when the host offers nothing', async () => {
    // No `fallbackValues` equivalent exists here, on purpose: there is no literal
    // Xcode version anywhere in this repository to fall back *to*.
    stubFetch({
      versions: [],
      default: '',
      derived: false,
      reason: "This app's own local server didn't return the table",
    });
    renderField({ value: '26.4.1' });
    await flush();

    const select = screen.getByRole('combobox', { name: 'Xcode version' });
    expect(optionValues(select)).toEqual(['26.4.1', '__custom__']);
    expect(screen.getByText(/didn.t return the table/)).toBeInTheDocument();
  });

  it('always names the supported-Xcode table as its source', async () => {
    stubFetch();
    renderField();
    await flush();

    const link = screen.getByRole('link', {
      name: /CircleCI’s supported-Xcode table/,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://circleci.com/docs/guides/execution-managed/using-macos/#supported-xcode-versions',
    );
  });
});
