import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_RESOURCE_CLASSES,
  resourceClassesFetchStub,
} from '~/lib/resourceClasses/testFixtures';
import { __resetResourceClassesCacheForTests } from '~/lib/resourceClasses/useResourceClasses';

import { ResourceClassField } from './ResourceClassField';

/**
 * `ResourceClassField`'s own tests (issue #181). The filtering and grouping
 * rules are unit-tested without a render in
 * `~/lib/resourceClasses/resourceClassOptions.test.ts`; what is left for here is
 * what the *control* does -- which options and controls appear, what it commits
 * and when, and the two things it must say out loud.
 */
function stubFetch(response = FIXTURE_RESOURCE_CLASSES) {
  __resetResourceClassesCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(resourceClassesFetchStub({}, response)),
  );
}

/** Resolves `useResourceClasses`' one fetch, after which the options exist. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function optionValues(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll('option'), (o) => o.value);
}

/**
 * Always passes `ariaLabel`, because in the app the accessible name comes from
 * the surrounding `Field`'s `<label htmlFor>` -- which these tests render
 * without. Naming it here keeps every query below going through the same
 * accessible name a user's screen reader would hear.
 */
function renderField(
  props: Partial<Parameters<typeof ResourceClassField>[0]> = {},
) {
  return render(
    <ResourceClassField
      id="rc"
      ariaLabel="Resource class"
      value="medium"
      onChange={vi.fn<(next: string) => void>()}
      scope={{ kind: 'docker' }}
      {...props}
    />,
  );
}

beforeEach(() => {
  __resetResourceClassesCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetResourceClassesCacheForTests();
});

describe('ResourceClassField', () => {
  it('groups the classes by upstream table, in CircleCI’s own words', async () => {
    stubFetch();
    renderField({ scope: { environmentIds: ['x86', 'x86-gen2', 'arm'] } });
    await flush();

    const select = screen.getByRole('combobox', { name: 'Resource class' });
    expect(
      Array.from(select.querySelectorAll('optgroup'), (g) => g.label),
    ).toEqual(['x86', 'x86 (gen2)', 'Arm']);
    expect(optionValues(select)).toContain('arm.2xlarge');
    expect(optionValues(select)).toContain('xlarge.gen2');
  });

  it('shows the value it was given immediately, before the fetch resolves', () => {
    // No flush: the field must never blank out or flip a perfectly ordinary
    // class into a free-text box for the tick before the list arrives.
    stubFetch();
    renderField();

    expect(
      screen.getByRole('combobox', { name: 'Resource class' }),
    ).toHaveValue('medium');
    expect(
      screen.queryByLabelText('Custom resource class'),
    ).not.toBeInTheDocument();
  });

  it('narrows the list to one architecture, with no stragglers, and writes nothing', async () => {
    // Issue #212, the defect itself. This test used to assert that `medium` -- an
    // x86 class -- survived the Arm filter and stayed selected, on the reasoning
    // that a filter must not remove the selection it is filtering around. The
    // reasoning was right; the behaviour was not. A control labelled "Filters the
    // list below" visibly did not filter.
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Architecture' }), {
      target: { value: 'arm64' },
    });

    const select = screen.getByRole('combobox', { name: 'Resource class' });
    expect(optionValues(select)).toContain('arm.large');
    expect(optionValues(select)).not.toContain('small');
    expect(optionValues(select)).not.toContain('xlarge.gen2');
    // The x86 class the job is on is gone from the list, and the select is not
    // pretending to be on it.
    expect(optionValues(select)).not.toContain('medium');
    expect(select).not.toHaveValue('medium');
    // Opening a filter is not an edit. Nothing is written until the user asks.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names the invalidated class instead of hiding it, and says nothing changed', async () => {
    // The other half of the rule above: filtering the value out of the *list* must
    // not make it invisible. It is called out by name, which is a better way of
    // not losing sight of it than leaving it in a list it does not belong to.
    stubFetch();
    renderField({ value: 'medium' });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Architecture' }), {
      target: { value: 'arm64' },
    });

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('medium');
    expect(notice).toHaveTextContent(/not Arm \(arm64\)/);
    expect(notice).toHaveTextContent(/nothing in your config has changed/i);
  });

  it('offers the equivalent class, and only writes it when asked', async () => {
    // The owner's suggestion: `medium` -> `arm.medium`. It is a config mutation, so
    // it happens on an explicit press and nowhere else -- silently rewriting a
    // resource class because someone touched a filter would be worse than the
    // confusion it fixes.
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ value: 'medium', onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Architecture' }), {
      target: { value: 'arm64' },
    });

    const button = screen.getByRole('button', {
      name: /Switch to arm\.medium/,
    });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('arm.medium');
  });

  it('says what it changed once the switch has been made', async () => {
    // The mutation has to be visible, not inferred from a select's new value.
    // Re-rendered with the new value, as both real call sites do (the inspector
    // through `mutate`, the dialog through local state).
    stubFetch();
    const { rerender } = render(
      <ResourceClassField
        id="rc"
        ariaLabel="Resource class"
        value="medium"
        onChange={vi.fn<(next: string) => void>()}
        scope={{ kind: 'docker' }}
      />,
    );
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Architecture' }), {
      target: { value: 'arm64' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Switch to/ }));

    rerender(
      <ResourceClassField
        id="rc"
        ariaLabel="Resource class"
        value="arm.medium"
        onChange={vi.fn<(next: string) => void>()}
        scope={{ kind: 'docker' }}
      />,
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/Changed\s+medium\s+to\s+arm\.medium/);
    expect(notice).toHaveTextContent(/Undo reverts it/);
    expect(
      screen.getByRole('combobox', { name: 'Resource class' }),
    ).toHaveValue('arm.medium');
  });

  it('says there is no equivalent rather than offering the nearest size', async () => {
    // `small` is Docker-x86-only: CircleCI's Arm table has no counterpart. The
    // tempting answer is `arm.medium`, and it is wrong -- that is a *different*
    // machine, and quietly resizing someone's build is worse than saying "no".
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ value: 'small', onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Architecture' }), {
      target: { value: 'arm64' },
    });

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/no Arm \(arm64\) equivalent of\s+small/);
    expect(
      screen.queryByRole('button', { name: /Switch to/ }),
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores the full list, and the selection, when the filter is cleared', async () => {
    // Narrowing is a view, not a change: setting the filter back to "Any
    // architecture" must leave the field exactly as it was, with no trace of the
    // detour and nothing written.
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ value: 'medium', onChange });
    await flush();

    const architecture = screen.getByRole('combobox', { name: 'Architecture' });
    fireEvent.change(architecture, { target: { value: 'arm64' } });
    fireEvent.change(architecture, { target: { value: '' } });

    const select = screen.getByRole('combobox', { name: 'Resource class' });
    expect(select).toHaveValue('medium');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('warns about nothing while the class list is still in flight', async () => {
    // Before the fetch resolves every class looks out-of-architecture. Warning
    // then would be a flash of a wrong answer.
    stubFetch();
    renderField({ value: 'medium' });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await flush();
  });

  it('opens unfiltered, so every class the executor offers is visible', async () => {
    // The report behind issue #181 was "the Docker Arm ones don't look like
    // they're there". Opening pre-filtered to the current value's architecture
    // would have recreated exactly that.
    stubFetch();
    renderField({ value: 'medium' });
    await flush();

    expect(screen.getByRole('combobox', { name: 'Architecture' })).toHaveValue(
      '',
    );
    const select = screen.getByRole('combobox', { name: 'Resource class' });
    expect(optionValues(select)).toContain('medium');
    expect(optionValues(select)).toContain('arm.large');
  });

  it('offers no architecture filter where every class shares one', async () => {
    stubFetch();
    renderField({ value: 'm4pro.medium', scope: { kind: 'macos' } });
    await flush();

    // macOS's table states no architecture at all, so there is nothing to
    // narrow -- and a control whose every option shows the same list would be
    // worse than none.
    expect(
      screen.queryByRole('combobox', { name: 'Architecture' }),
    ).not.toBeInTheDocument();
  });

  it('keeps a free-text escape hatch, committed on blur by default', async () => {
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Resource class' }), {
      target: { value: '__custom__' },
    });
    const custom = screen.getByLabelText('Custom resource class');
    fireEvent.change(custom, { target: { value: 'arm.128xlarge' } });
    // Not committed yet: in the inspector each commit is a document mutation.
    expect(onChange).not.toHaveBeenCalled();

    // Enter blurs, which is the keyboard route to committing -- no mouse needed.
    fireEvent.keyDown(custom, { key: 'Enter' });
    fireEvent.blur(custom);
    expect(onChange).toHaveBeenCalledWith('arm.128xlarge');
  });

  it('commits free text as it is typed when the caller asks for it', async () => {
    const onChange = vi.fn<(next: string) => void>();
    stubFetch();
    renderField({ onChange, customCommit: 'change' });
    await flush();

    fireEvent.change(screen.getByRole('combobox', { name: 'Resource class' }), {
      target: { value: '__custom__' },
    });
    fireEvent.change(screen.getByLabelText('Custom resource class'), {
      target: { value: 'arm.128xlarge' },
    });
    // `ConfigureJobDialog` writes nothing until "Create job", so clicking that
    // button must not need to blur the field first.
    expect(onChange).toHaveBeenCalledWith('arm.128xlarge');
  });

  it('shows an existing value the tables do not list, rather than dropping it', async () => {
    stubFetch();
    renderField({ value: 'macos.m1.medium.gen1', scope: { kind: 'macos' } });
    await flush();

    // A class upstream has stopped documenting is still in someone's config, and
    // this control must not make it invisible.
    expect(screen.getByLabelText('Custom resource class')).toHaveValue(
      'macos.m1.medium.gen1',
    );
  });

  it('says so when the list is not the current documentation’s', async () => {
    stubFetch({
      environments: FIXTURE_RESOURCE_CLASSES.environments,
      derived: false,
      reason: 'the tables could not be read; showing the embedded list instead',
    });
    renderField();
    await flush();

    // A stale list presented as current is worse than an admitted one.
    expect(
      screen.getByText(/showing the embedded list instead/i),
    ).toBeInTheDocument();
  });

  it('falls back to the caller’s own class plus free text when the host offers nothing', async () => {
    stubFetch({ environments: [], derived: false, reason: 'no tables' });
    renderField({
      value: 'windows.medium',
      scope: { environmentIds: ['windows-execution-environment'] },
      fallbackClasses: ['windows.medium'],
    });
    await flush();

    const select = screen.getByRole('combobox', { name: 'Resource class' });
    // Not an empty dropdown -- the specific outcome issue #181 rules out.
    expect(optionValues(select)).toEqual(['windows.medium', '__custom__']);
    expect(screen.getByText(/no tables/i)).toBeInTheDocument();
  });

  it('always names the docs as the source and disclaims plan entitlement', async () => {
    stubFetch();
    renderField();
    await flush();

    const caveat = screen.getByText(/not your plan/i);
    expect(caveat.textContent).toMatch(/CircleCI’s resource-class tables/);
    expect(caveat.textContent).toMatch(/smaller plan/);
    // And it links out to the tables themselves, so the authority is one click
    // away rather than paraphrased.
    expect(
      screen.getByRole('link', { name: /resource-class tables/i }),
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
    );
  });

  it('offers "Not set" only where a job may legitimately have no resource_class', async () => {
    stubFetch();
    const { unmount } = renderField({ allowUnset: true });
    await flush();
    expect(
      optionValues(screen.getByRole('combobox', { name: 'Resource class' })),
    ).toContain('');
    unmount();

    renderField({ id: 'rc2' });
    await flush();
    expect(
      optionValues(screen.getByRole('combobox', { name: 'Resource class' })),
    ).not.toContain('');
  });
});
