import { defineConfig, devices } from '@playwright/test';

/**
 * Issues #206/#165: this port used to be a hard-coded 4173 paired with
 * `reuseExistingServer`, so a run started while *another* checkout of this
 * repo already had a preview server on 4173 silently tested *that* checkout's
 * bundle -- and the failure mode there is a *pass*, which is the dangerous
 * direction. An env-var override (`VCE_E2E_PORT`) alone does not fix that: it
 * only helps whoever remembers to set it, and the default -- what every plain
 * `pnpm test:e2e` and every worktree that doesn't opt in actually runs -- was
 * left exactly as broken as before.
 *
 * So the port is ephemeral by default, derived from this process's own pid.
 * Concurrent runs get different pids and so, overwhelmingly likely, different
 * ports, with no coordination required between worktrees or agents. Should
 * two runs' pids collide into the same port anyway, `reuseExistingServer`
 * below is unconditionally off, so the second run's `--strictPort` fails to
 * bind and the run errors out loudly instead of quietly attaching to the
 * first run's server -- collision becomes a startup failure, never a mistaken
 * pass. `VCE_E2E_PORT` still overrides the ephemeral choice, for anyone who
 * wants a fixed, memorable port to point a manual browser tab at while
 * debugging a spec.
 */
function ephemeralPort(): number {
  // 500 slots above the historical 4173 is comfortably more concurrent
  // worktrees than one machine has ever run at once here; nothing below
  // relies on the exact width, just on it being "enough to make collision
  // rare" -- collision is handled safely either way (see above).
  return 4173 + (process.pid % 500);
}
const PORT = Number(process.env.VCE_E2E_PORT ?? ephemeralPort());
/**
 * Playwright re-imports this file fresh in every worker process it spawns --
 * under `fullyParallel` that can mean one OS process per test, each with its
 * own `pid` -- so deriving the port from `process.pid` alone would give the
 * webServer one port (chosen by whichever process resolved the config first,
 * to decide what to launch) and each worker a *different* one for `baseURL`,
 * which is a guaranteed `ERR_CONNECTION_REFUSED`, not a fix (caught by the
 * repeated-run check in this PR before it shipped). Writing the resolved
 * value back into `process.env` here means every worker process, which
 * inherits its environment from the process that spawned it, sees
 * `VCE_E2E_PORT` already set and reuses this exact value instead of deriving
 * its own -- so the whole run, however many processes it ends up as, agrees
 * on one port.
 */
if (process.env.VCE_E2E_PORT === undefined) {
  process.env.VCE_E2E_PORT = String(PORT);
}
const baseURL = `http://localhost:${PORT}`;

/**
 * Browser E2E harness for the visual config editor.
 *
 * The app is a localhost-only tool with no auth, so there's no login flow
 * to worry about. Specs drive the *real built app* (via `vite preview`)
 * against a stubbed host API -- the Go host itself is already covered by
 * Go tests under `internal/host`, so these tests intercept `**\/api/**`
 * with `page.route` (see `e2e/fixtures.ts`) instead of requiring a Go
 * build alongside the web one.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  /**
   * Pinned to 2, not left at Playwright's default (which is CPU-count based
   * and lands on 3 or more on most machines here).
   *
   * At 3 workers the `vite preview` server below has been observed to
   * disappear partway through a run. Every spec that had not yet loaded the
   * page then failed with `ERR_CONNECTION_REFUSED` -- in the observed run, 6
   * specs across two unrelated files while 38 passed. That is the expensive
   * kind of flake: the specs that "fail" have nothing to do with the cause,
   * so it reads as a real regression in whatever area happened to be next in
   * the queue.
   *
   * At 2 workers the whole suite passes consistently and repeatedly, and the
   * specs that failed in a bad run pass on their own at any worker count --
   * so this is the preview server under concurrent load, not the specs.
   *
   * This is a workaround, not the fix: the server should be able to serve
   * three clients, and why it does not is worth finding out. Raising this for
   * speed without answering that question re-enters the same failure, which
   * is why the number is written down here rather than left implicit.
   */
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
        ['list'],
      ]
    : [
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['list'],
      ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Deliberately `vite build` rather than the `build` package script:
    // the latter runs `tsc --noEmit` first, which is a separate concern
    // (covered by the `check`/`test-web` CI jobs and `pnpm typecheck`) that
    // these specs don't need and shouldn't be coupled to -- they only need
    // a real, servable bundle. Using the raw Vite commands keeps the E2E
    // suite runnable even while other work in `src/` is mid-flight and not
    // yet type-clean.
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: baseURL,
    // Unconditionally off. Whatever is already answering on this port cannot
    // be verified to be *this* run's build -- that unverifiable trust was the
    // entire defect in #206/#165 -- so there is no safe condition under which
    // to reuse it. `--strictPort` then turns an occupied port into a loud
    // startup failure instead of a silent handoff to whatever is listening.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
