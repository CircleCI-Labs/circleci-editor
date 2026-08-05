import { expect, test } from '@playwright/test';

import { invalidStub, mockHostApi } from './fixtures';

/** A config whose Slack orb pins a version that was never published -- the owner's own case in #210. */
function configWithBadOrbVersion(): string {
  return `version: 2.1
orbs:
  slack: circleci/slack@4.12.5
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;
}

/** CircleCI's own wording for an orb reference the registry cannot resolve. */
const ORB_NOT_FOUND = [
  'Cannot find circleci/slack@4.12.5 in the orb registry. Check that the namespace, orb name and version are correct.',
];

/**
 * The AI pane (issue #92), driven against the real built app with the host
 * API stubbed (see `fixtures.ts`). Three properties matter enough to cover
 * end to end, not just in unit tests:
 *
 *  1. With no key configured, the pane degrades honestly: it explains how
 *     to add one and stays inert, rather than looking broken.
 *  2. Configuring a key is a real round trip through `PUT /api/ai/key`,
 *     and the key never reappears anywhere in the page afterwards.
 *  3. A proposed config change is shown as a diff, and only reaches the
 *     open document -- visible in the YAML editor -- once the user
 *     explicitly approves it.
 */
test.describe('AI pane', () => {
  test('with no key configured, explains how to add one and keeps the composer inert', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'AI Assistant' }),
    ).toBeVisible();
    await expect(page.getByText('No key')).toBeVisible();

    // Settings auto-opens with nothing configured -- the "explains how"
    // half of the degrade -- without a second click.
    await expect(page.getByText('AI provider keys')).toBeVisible();

    const input = page.getByPlaceholder('Add an API key in Settings first…');
    await expect(input).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toBeDisabled();
  });

  test('configuring a key round-trips through the host and never reappears on the page', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page);
    await page.goto('/');

    const sentinelKey = 'sk-ant-e2e-test-sentinel-should-never-reappear';
    await page.getByPlaceholder('Anthropic API key').fill(sentinelKey);
    await page.getByRole('button', { name: 'Save key' }).click();

    await expect.poll(() => hostApi.getLastAiKeySet()).toBe(sentinelKey);
    const providerRow = page.getByTestId('ai-provider-anthropic');
    await expect(
      providerRow.getByText('Configured', { exact: true }),
    ).toBeVisible();

    const pageText = await page.locator('body').innerText();
    expect(pageText).not.toContain(sentinelKey);

    // "Easy to remove" (issue #92): removing it round-trips through DELETE
    // and the provider reverts to "Not configured".
    await providerRow.getByRole('button', { name: 'Remove key' }).click();
    await expect.poll(() => hostApi.getAiKeyDeleteCount()).toBeGreaterThan(0);
    await expect(providerRow.getByText('Not configured')).toBeVisible();
  });

  test('chatting with a configured provider sends repo context and renders the reply', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    hostApi.setAiChatResponse({
      available: true,
      content: 'The build job checks out and runs steps.',
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await expect(input).toBeEnabled();
    await input.fill('what does the build job do?');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(
      page.getByText('The build job checks out and runs steps.'),
    ).toBeVisible();
  });

  test('renders the reply as Markdown, with fenced YAML highlighted, and no HTML from the model', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    // Issue #156, in the real built app: Markdown structure renders, and the
    // hostile payloads render as text with no element and no anchor.
    hostApi.setAiChatResponse({
      available: true,
      content: [
        '## Caching',
        '',
        'Use **save_cache** with a `key`:',
        '',
        '```yaml',
        'steps:',
        '  - save_cache: # keyed on the lockfile',
        '      key: v1-deps',
        '```',
        '',
        '- one',
        '- two',
        '',
        '<script>window.__pwned = true</script>',
        '',
        '<img src=x onerror="window.__pwned = true">',
        '',
        '[do not click](javascript:window.__pwned = true)',
        '',
        '[real docs](https://circleci.com/docs/reference/configuration-reference/)',
      ].join('\n'),
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await input.fill('how do I cache dependencies?');
    await page.getByRole('button', { name: 'Send message' }).click();

    const bubble = page.getByTestId('markdown');
    await expect(bubble).toBeVisible();

    // Structure, not literal punctuation.
    await expect(
      bubble.getByRole('heading', { name: 'Caching' }),
    ).toBeVisible();
    await expect(
      bubble.locator('strong', { hasText: 'save_cache' }),
    ).toBeVisible();
    await expect(bubble.locator('li')).toHaveCount(2);
    await expect(bubble.locator('pre')).toHaveCount(1);
    await expect(await bubble.innerText()).not.toContain('**');

    // The YAML fence is highlighted by the same tokenizer the editor uses, so
    // at least one span in it carries a colour.
    const coloured = await bubble
      .locator('pre span')
      .evaluateAll(
        (spans) =>
          spans.filter((span) => (span as HTMLElement).style.color !== '')
            .length,
      );
    expect(coloured).toBeGreaterThan(0);

    // Nothing the model wrote became markup, and nothing ran.
    await expect(bubble.locator('script')).toHaveCount(0);
    await expect(bubble.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => '__pwned' in window)).toBe(false);

    // Exactly one link -- the http(s) one -- and it is safe.
    const links = bubble.locator('a');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(links).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/',
    );
    // The de-linked label is still readable as text.
    await expect(bubble).toContainText('do not click');
  });

  test('only trusted hosts become links, in the body and in the sources, and the rest are shown unlinked', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    // Issue #187, in the real built app: the exact shape of the owner's report
    // -- a Slack link and a look-alike domain arriving alongside real CircleCI
    // citations.
    hostApi.setAiChatResponse({
      available: true,
      content: [
        'See [the reference](https://circleci.com/docs/reference/configuration-reference/)',
        'and the [slack-orb wiki](https://github.com/CircleCI-Public/slack-orb/wiki).',
        '',
        'Ask in [our Slack](https://app.slack.com/client/T00000000/C00000000) or',
        'read [these docs](https://circleci.com.evil.example/docs/).',
      ].join('\n'),
      sources: [
        {
          url: 'https://circleci.com/docs/guides/orchestrate/workflows/',
          title: 'Use workflows',
        },
        {
          url: 'https://app.slack.com/client/T00000000/C00000000',
          title: 'Ask in #ci',
        },
        { url: 'https://circleci.com.evil.example/docs/guides/' },
      ],
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await input.fill('where do I read about workflows?');
    await page.getByRole('button', { name: 'Send message' }).click();

    const bubble = page.getByTestId('markdown');
    await expect(bubble).toBeVisible();

    // Body: two anchors, both CircleCI-owned. The Slack link and the look-alike
    // domain are text, and neither URL appears in any attribute.
    await expect(bubble.locator('a')).toHaveCount(2);
    expect(
      await bubble
        .locator('a')
        .evaluateAll((anchors) =>
          anchors.map((anchor) => anchor.getAttribute('href')),
        ),
    ).toEqual([
      'https://circleci.com/docs/reference/configuration-reference/',
      'https://github.com/CircleCI-Public/slack-orb/wiki',
    ]);
    const bubbleHtml = await bubble.innerHTML();
    expect(bubbleHtml).not.toContain('app.slack.com/client');
    expect(bubbleHtml).not.toContain('circleci.com.evil.example/docs/"');
    // Refused, not hidden.
    await expect(bubble).toContainText('our Slack');
    await expect(bubble).toContainText('not linked: app.slack.com');
    await expect(bubble).toContainText('not linked: circleci.com.evil.example');

    // Sources: one link, two unlinked rows, and a line saying so.
    const sources = page.getByTestId('ai-sources');
    await expect(sources.locator('a')).toHaveCount(1);
    await expect(sources.locator('a')).toHaveAttribute(
      'href',
      'https://circleci.com/docs/guides/orchestrate/workflows/',
    );
    await expect(page.getByTestId('ai-source-unlinked')).toHaveCount(2);
    await expect(sources).toContainText('app.slack.com/client');
    await expect(sources).toContainText('circleci.com.evil.example');
    await expect(sources).toContainText('2 sources are shown without a link');
  });

  test('sources are titled rows, deduplicated, with image assets never shown', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    hostApi.setAiChatResponse({
      available: true,
      content: 'Workspaces move data between jobs in the same workflow.',
      sources: [
        {
          url: 'https://circleci.com/docs/guides/execution-managed/persist-data/',
          title: 'Persist data and share it between jobs',
        },
        // A duplicate spelling of the same page, and an image asset: one row
        // must survive, and it must not be the asset.
        {
          url: 'https://circleci.com/docs/guides/execution-managed/persist-data',
        },
        { url: 'https://circleci.com/docs/guides/_images/workspace.png' },
      ],
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await input.fill('what is a workspace?');
    await page.getByRole('button', { name: 'Send message' }).click();

    const sources = page.getByTestId('ai-sources');
    await expect(sources).toBeVisible();
    await expect(sources.locator('a')).toHaveCount(1);
    await expect(sources).toContainText(
      'Persist data and share it between jobs',
    );
    await expect(sources).toContainText(
      'circleci.com/docs/guides/execution-managed/persist-data/',
    );
    await expect(sources).not.toContainText('workspace.png');

    // Keyboard reachable, as an ordinary link: tabbing from the transcript
    // reaches it and Enter would follow it.
    await sources.locator('a').focus();
    await expect(sources.locator('a')).toBeFocused();
  });

  /**
   * Issues #186 and #209, and the properties jsdom cannot check: these are about
   * real, measured pixels.
   *
   * A taller viewport than the suite's default on purpose, and the reason is a
   * finding rather than a convenience: `graph-focus` gives the AI pane 28% of the
   * window height, which on the 720px-tall default leaves a 99px pane column --
   * less than the composer's own minimum plus its furniture, so the box is pinned
   * at its minimum and *no* growing or dragging is possible at all. That is honest
   * behaviour for a pane that small (it is covered on its own below, and on the
   * real "Fix with AI" path in `diagnostics.spec.ts`), but it means the growth
   * these issues ask for can only be *measured* on a window where the pane has
   * room. 1200px tall is an ordinary external monitor. The pane's default share is
   * #205, still open.
   */
  test.describe('the composer, on a window where the AI pane has room (issues #186/#209)', () => {
    test.use({ viewport: { width: 1280, height: 1200 } });

    test('the composer grows with a long draft, can be resized by keyboard, and remembers the size', async ({
      page,
    }) => {
      await mockHostApi(page, { aiConfigured: true });
      await page.goto('/');

      const composer = page.getByLabel('Message the AI assistant');
      const transcript = page.getByTestId('ai-transcript');
      await expect(composer).toBeEnabled();

      const heightOf = async (locator: typeof composer) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error('no bounding box');
        return box.height;
      };

      const atRest = await heightOf(composer);
      const transcriptAtRest = await heightOf(transcript);

      // A prompt the shape "Fix with AI" seeds: many short lines.
      const longPrompt = [
        'My CircleCI config is failing validation and I would like help fixing it.',
        '',
        'Reported by: CircleCI compiler',
        'Location: line 13, column 5 (quoted by the validator itself)',
        '',
        'Error:',
        '```',
        ...Array.from({ length: 20 }, (_, index) => `detail line ${index + 1}`),
        '```',
      ].join('\n');
      await composer.fill(longPrompt);

      // It grew on its own -- no gesture, no discovery of a handle.
      const grown = await heightOf(composer);
      expect(grown).toBeGreaterThan(atRest + 20);
      // ...and it left a line of conversation behind, which is all
      // `TRANSCRIPT_RESERVE_PX` ever promised. #186 asserted a larger remainder
      // here, on the reasoning that the draft-preview card was a better use of the
      // space; #209 deleted that card, so the box is now the only thing that can
      // show an unsent draft and it takes the room instead.
      const transcriptWhileGrown = await heightOf(transcript);
      expect(transcriptWhileGrown).toBeGreaterThan(20);

      // The whole draft is readable in the input, and the input says how much of it
      // there is -- the requirement from #186, met by the box rather than by a
      // second surface. The deleted surface is gone.
      await expect(page.getByTestId('ai-draft-preview')).toHaveCount(0);
      await expect(composer).toHaveValue(/detail line 20/);

      // Resizable without a mouse: the separator takes focus and End goes to the
      // top of its range.
      const handle = page.getByTestId('ai-composer-resize');
      await handle.focus();
      await expect(handle).toBeFocused();
      await page.keyboard.press('End');
      const maximised = await heightOf(composer);
      expect(maximised).toBeGreaterThanOrEqual(grown);
      const persisted = await page.evaluate(() =>
        window.localStorage.getItem('vce.aiComposer'),
      );
      expect(persisted).toContain('"heightPx"');

      // And the size survives a reload -- with an empty composer, which is the
      // case that proves it is the *stored* size rather than auto-grow.
      await page.reload();
      const afterReload = page.getByLabel('Message the AI assistant');
      await expect(afterReload).toBeEnabled();
      await expect(afterReload).toHaveValue('');
      expect(await heightOf(afterReload)).toBeGreaterThan(atRest + 20);
      // The transcript is still usable at that size, on the same window -- the
      // reserve, this time against a deliberate drag rather than against auto-grow.
      expect(await heightOf(page.getByTestId('ai-transcript'))).toBeGreaterThan(
        20,
      );
      // An empty composer leaves the transcript more room than a grown one does,
      // which is the "hands the space back" half of not stealing it.
      expect(transcriptAtRest).toBeGreaterThan(transcriptWhileGrown);
    });
  });

  /**
   * Issue #209's other half, on the window the owner actually reported from.
   *
   * The composer is the one row a user must always be able to reach, and before
   * #209 it was the row that lost: the pane's column needed 133px, had 99, and the
   * bottom 26px of the message box -- the Send button included -- sat below the
   * pane's own fold, inside a *second* scroll region that #88 forbids.
   */
  test('on the default preset the message box is fully visible, and the pane still has one scroll region', async ({
    page,
  }) => {
    await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');
    const composer = page.getByLabel('Message the AI assistant');
    await expect(composer).toBeEnabled();

    // The whole composer, Send button included, is inside the pane's own box.
    const overflow = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="pane-ai"]');
      const send = document.querySelector('button[aria-label="Send message"]');
      if (!pane || !send) throw new Error('missing pane or send button');
      const paneBox = pane.getBoundingClientRect();
      const sendBox = send.getBoundingClientRect();
      return Math.round(sendBox.bottom - paneBox.bottom);
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // ...and it is not visible because the pane grew a scrollbar to reach it.
    const scrollers = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="pane-ai"]');
      if (!pane) throw new Error('no ai pane');
      let count = 0;
      for (const element of [pane, ...Array.from(pane.querySelectorAll('*'))]) {
        const style = getComputedStyle(element);
        if (
          /auto|scroll/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2
        ) {
          count += 1;
        }
      }
      return count;
    });
    // At most one: the transcript. Never the pane wrapper as well (#88).
    expect(scrollers).toBeLessThanOrEqual(1);
  });

  /**
   * Issue #207 on the window it was reported from. At this size the transcript is a
   * ~24px slit (measured -- see `composerSize`'s header, and #205), so what can be
   * asserted here is not "the reply is legible" but the property that actually
   * changed: the slit shows the *end* of the newest reply rather than the top of the
   * conversation. Before this, the first exchange left the answer entirely below the
   * fold, and it read as the assistant not having replied.
   */
  test('scrolls the transcript to the newest reply even where the pane is a slit', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    hostApi.setAiChatResponse({
      available: true,
      content: Array.from(
        { length: 40 },
        (_, index) => `Point ${index + 1}.`,
      ).join('\n'),
    });
    await page
      .getByPlaceholder('Ask the assistant to edit your pipeline…')
      .fill('explain everything');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Point 40.')).toBeAttached();

    const transcript = page.getByTestId('ai-transcript');
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(4);
    // ...and it genuinely had somewhere to scroll to, so this is not a vacuous pass.
    expect(
      await transcript.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
  });

  /**
   * Issue #207: the transcript never scrolled to the newest message, so a reply --
   * and its Sources footer, and any "Review change…" affordance -- could render
   * below the fold while the pane still showed the top of the conversation. On the
   * default pane height that happened on the *first* exchange, and it read as the
   * assistant not having replied.
   */
  test.describe('scrolling to the newest message (issue #207)', () => {
    // A taller window than the suite's default, for the same reason the composer
    // tests above use one: on `graph-focus` at 720px the transcript is a ~24px slit
    // (measured), so *whether a given line is on screen* is not a question that
    // window can answer. The scroll position itself is asserted at the default size
    // too -- see the default-preset test above.
    test.use({ viewport: { width: 1280, height: 1200 } });

    test('keeps the newest reply in view, and stops doing so once the user scrolls up', async ({
      page,
    }) => {
      const hostApi = await mockHostApi(page, { aiConfigured: true });
      await page.goto('/');

      const input = page.getByPlaceholder(
        'Ask the assistant to edit your pipeline…',
      );
      const transcript = page.getByTestId('ai-transcript');

      // Long enough that the transcript must scroll to show the end of it.
      const marker = 'THE-LAST-LINE-OF-THE-REPLY';
      hostApi.setAiChatResponse({
        available: true,
        content: [
          ...Array.from({ length: 40 }, (_, index) => `Point ${index + 1}.`),
          '',
          marker,
        ].join('\n'),
      });

      await input.fill('explain everything');
      await page.getByRole('button', { name: 'Send message' }).click();

      // The end of the reply is what the transcript is showing -- not the top of the
      // conversation, which is the whole of #207.
      await expect(page.getByText(marker)).toBeInViewport();
      const atBottom = await transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight <= 4,
      );
      expect(atBottom).toBe(true);

      // Scrolled up to read history: the "jump to newest" affordance appears, and it
      // is an ordinary button, so the keyboard reaches it.
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      const jump = page.getByTestId('ai-scroll-to-newest');
      await expect(jump).toBeVisible();

      // A second reply must not yank the view out from under the reader.
      hostApi.setAiChatResponse({
        available: true,
        content: 'A short second reply.',
      });
      await input.fill('and again');
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.getByText('A short second reply.')).toBeAttached();
      expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);

      // ...and the way back is one click, after which sticking resumes.
      await jump.click();
      await expect(jump).toBeHidden();
      await expect(page.getByText('A short second reply.')).toBeInViewport();
    });
  });

  /** Issue #192: "thinking" is a message in the transcript, not a detached spinner. */
  test('shows "Thinking…" as a message in the thread while a reply is in flight', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    // Held open, so the in-flight state is observable at all.
    let release: (() => void) | undefined;
    await page.route('**/api/ai/chat', async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: { available: true, content: 'Here is the answer.' },
      });
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await input.fill('what does the build job do?');
    await page.getByRole('button', { name: 'Send message' }).click();

    const thinking = page.getByTestId('ai-thinking');
    await expect(thinking).toBeVisible();
    // Inside the transcript, in the place its answer will appear -- not beside it.
    expect(
      await thinking.evaluate((element) =>
        Boolean(element.closest('[data-testid="ai-transcript"]')),
      ),
    ).toBe(true);
    // Announced without stealing focus.
    await expect(thinking).toHaveAttribute('role', 'status');

    release?.();
    await expect(page.getByText('Here is the answer.')).toBeVisible();
    await expect(thinking).toBeHidden();
    // `hostApi` is still the thing that served the rest of this page.
    expect(hostApi.getSaveCount()).toBe(0);
  });

  /**
   * Issue #210, in the real built app, on the owner's own case.
   *
   * Their report, after running "Fix with AI" on an invalid Slack orb reference:
   * *"the sources are completely off. Yes, you list out the orb registry, but the
   * first one is the Slack Block Kit builder. I don't think that has any reference
   * here. The next one is semantic versioning, then orb version, then node, and
   * then reusable config."*
   *
   * Before: five rows, led by a page about composing Slack messages. After: four,
   * led by the orb the error actually names.
   */
  test('cites the orb the error names, not the product it integrates with', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, {
      config: configWithBadOrbVersion(),
      validate: invalidStub(ORB_NOT_FOUND),
      aiConfigured: true,
      // The registry knows this orb, and its version list is what puts "latest
      // published: 5.1.1" in the citation and the real versions in the prompt.
      orbSource: {
        available: true,
        name: 'circleci/slack',
        version: '5.1.1',
        source: 'description: Slack orb\n',
        versions: ['5.1.1', '5.0.0', '4.13.7'],
        latestVersion: '5.1.1',
      },
    });
    await page.goto('/');

    // The owner's five sources, in the owner's order.
    hostApi.setAiChatResponse({
      available: true,
      content: 'That version was never published — 5.1.1 is the newest.',
      sources: [
        {
          url: 'https://app.slack.com/block-kit-builder',
          title: 'Block Kit Builder',
        },
        { url: 'https://semver.org/', title: 'Semantic Versioning' },
        {
          url: 'https://circleci.com/docs/reference/reusing-config/',
          title: 'Reusable config',
        },
      ],
    });

    // Seed from the real diagnostic, then send it -- the classification that aims
    // the citations is the strip's, not this test's.
    await page
      .getByTestId('diagnostics-strip')
      .getByRole('button', { name: 'Fix with AI' })
      .click();
    await page.getByRole('button', { name: 'Send message' }).click();

    const sources = page.getByTestId('ai-sources');
    await expect(sources).toBeVisible();

    // The orb's own registry page leads, built from the namespace we parsed.
    const rows = sources.locator('li');
    await expect(rows.first()).toContainText(
      'circleci/slack orb in the registry',
    );
    await expect(sources.locator('a').first()).toHaveAttribute(
      'href',
      'https://circleci.com/developer/orbs/orb/circleci/slack',
    );
    // Then the two vendored Orbs pages.
    await expect(sources).toContainText('Orbs introduction');
    await expect(sources).toContainText('Orb concepts');
    // Four rows, not five, and the Block Kit builder is not among them.
    await expect(rows).toHaveCount(4);
    await expect(sources).not.toContainText('Block Kit');
    await expect(page.getByTestId('ai-sources-dropped')).toContainText(
      'not shown',
    );
    // The rows this editor attached say so, so they are never mistaken for
    // evidence that the model was grounded.
    await expect(page.getByTestId('ai-source-editor')).toHaveCount(3);
  });

  test('a proposed change is shown as a diff and only reaches the editor once approved', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, { aiConfigured: true });
    await page.goto('/');

    hostApi.setAiChatResponse({
      available: true,
      content:
        'Sure, adding a lint job.\n\n```action\n{"type": "addJob", "name": "lint"}\n```',
    });

    const input = page.getByPlaceholder(
      'Ask the assistant to edit your pipeline…',
    );
    await input.fill('add a lint job');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page.getByText('Add job "lint"')).toBeVisible();

    // Not applied yet: the editor must not already show it before approval.
    const editorTextBefore = await page.locator('.cm-content').innerText();
    expect(editorTextBefore).not.toContain('lint:');

    await page.getByRole('button', { name: 'Review change…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/lint:/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Apply to editor' }).click();
    await expect(dialog).toBeHidden();

    const editorTextAfter = await page.locator('.cm-content').innerText();
    expect(editorTextAfter).toContain('lint:');

    // Still not written to disk -- that remains the ordinary, separate
    // Save step. This dialog only ever touched the open document.
    expect(hostApi.getSaveCount()).toBe(0);
  });
});
