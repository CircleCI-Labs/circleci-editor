import type { Page, Route } from '@playwright/test';

/**
 * A distinctive comment line kept at the top of `FIXTURE_CONFIG`. Specs
 * assert this exact text survives a full load -> edit -> save round trip
 * through the real, built app -- the single most important guarantee this
 * editor makes, per `docs/ARCHITECTURE.md`'s AST-mutation approach.
 */
export const FIXTURE_COMMENT =
  '# Managed by the platform team -- do not edit by hand.';

/**
 * A realistic multi-job config: comments (including `FIXTURE_COMMENT`), an
 * orb reference, and a `requires` chain across three jobs, so specs have
 * something worth rendering in the YAML/DAG panes.
 */
export const FIXTURE_CONFIG = `${FIXTURE_COMMENT}
version: 2.1

orbs:
  node: circleci/node@5.2.0

jobs:
  build:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: pnpm install
      - run: pnpm build

  test:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: pnpm test

  deploy:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: ./deploy.sh

workflows:
  build_test_deploy:
    jobs:
      - build
      - test:
          requires:
            - build
      - deploy:
          requires:
            - test
          filters:
            branches:
              only: main
`;

export const FIXTURE_CONFIG_PATH = '/home/dev/widgets/.circleci/config.yml';

export const FIXTURE_JOB_NAMES = ['build', 'test', 'deploy'];

/**
 * Issue #88: "as complexity grows" was the owner's own framing of the
 * palette/inspector crowding problem -- fixing it against `FIXTURE_CONFIG`'s
 * three jobs alone would prove nothing about a real pipeline. Builds a
 * config with `jobCount` jobs across a few parallel "lanes" (a lane of jobs
 * each requiring the one before it, several lanes fanning out from a shared
 * `setup` job), which is enough for ELK to lay out a graph that's
 * genuinely wide *and* tall -- unlike a single linear chain, which is only
 * ever one node tall regardless of `jobCount` and so would under-test how
 * much vertical room the canvas actually has.
 */
export function buildLargeWorkflowConfig(jobCount: number): string {
  const laneCount = Math.max(2, Math.round(Math.sqrt(jobCount)));
  const jobsPerLane = Math.ceil(jobCount / laneCount);

  const jobNames: string[] = ['setup'];
  const lanes: string[][] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const laneJobs: string[] = [];
    for (let step = 0; step < jobsPerLane; step++) {
      if (jobNames.length - 1 >= jobCount) break; // -1: don't count `setup`
      const name = `lane-${lane}-job-${step}`;
      laneJobs.push(name);
      jobNames.push(name);
    }
    lanes.push(laneJobs);
  }

  const jobsYaml = jobNames
    .map(
      (name) => `  ${name}:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: echo ${name}`,
    )
    .join('\n');

  const workflowJobsYaml = [
    '      - setup',
    ...lanes.flatMap((laneJobs) =>
      laneJobs.map((name, index) =>
        index === 0
          ? `      - ${name}:\n          requires:\n            - setup`
          : `      - ${name}:\n          requires:\n            - ${laneJobs[index - 1]}`,
      ),
    ),
  ].join('\n');

  return `version: 2.1

jobs:
${jobsYaml}

workflows:
  large_workflow:
    jobs:
${workflowJobsYaml}
`;
}

/** Mirrors the host's `ValidateResponse` shape (see `web/src/lib/rpc/client.ts`). */
export interface ValidateStub {
  available: boolean;
  source: string;
  valid: boolean;
  errors?: { message: string }[];
  reason?: string;
  outputYaml?: string;
}

export const VALID_STUB: ValidateStub = {
  available: true,
  source: 'circleci-api',
  valid: true,
};

/**
 * Mirrors the host's `policyResponse` shape (issue #215; see
 * `internal/host/policy.go` and `PolicyDecisionResponse`).
 */
export interface PolicyStub {
  available: boolean;
  source: string;
  reason?: string;
  status?: string;
  enabledRules?: string[];
  hardFailures?: { rule: string; reason: string }[];
  softFailures?: { rule: string; reason: string }[];
  decisionReason?: string;
  orgSlug?: string;
  policyContext?: string;
  metadataSent?: string[];
  /** Issue #25. Defaults to `true` below -- a spec exercising the source-only path overrides it explicitly rather than every other spec having to opt into the steady state. */
  compiledConfigIncluded?: boolean;
  compiledConfigReason?: string;
}

/**
 * The default `POST /api/policy/decide` body: a HARD_FAIL carrying both a
 * blocking and a non-blocking violation, copied in shape from a real decision
 * (see `internal/circleci/policy_test.go`, whose fixtures came off the live
 * endpoint). The blocking one names a job the fixture config actually has, so
 * it is locatable; the non-blocking one is prose about an image, which is the
 * commonest real shape and is deliberately *not* locatable.
 */
export const POLICY_HARD_FAIL_STUB: PolicyStub = {
  available: true,
  source: 'api',
  status: 'HARD_FAIL',
  enabledRules: [
    'required_jobs_in_workflow',
    'use_official_docker_image',
    'check_orb_version',
  ],
  hardFailures: [
    {
      rule: 'required_jobs_in_workflow',
      reason: "Job 'build' must not run before the security scan",
    },
  ],
  softFailures: [
    {
      rule: 'use_official_docker_image',
      reason:
        'nginx:latest is not an approved Docker image. Please only use images approved by our organization',
    },
  ],
  orgSlug: 'gh/example',
  policyContext: 'config',
  metadataSent: ['project_id', 'vcs.branch'],
  compiledConfigIncluded: true,
};

export function invalidStub(messages: string[]): ValidateStub {
  return {
    available: true,
    source: 'circleci-api',
    valid: false,
    errors: messages.map((message) => ({ message })),
  };
}

export function unavailableStub(reason: string): ValidateStub {
  return {
    available: false,
    source: 'unavailable',
    valid: false,
    reason,
  };
}

/** Mirrors the host's `AiChatResponse` shape (see `web/src/lib/rpc/client.ts`). */
export interface AiChatStub {
  available: boolean;
  reason?: string;
  content?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Citations, in the normalized `{url, title}` shape the host sends (issue
   * #156). A stub may deliberately include something the host would have
   * filtered out -- an image asset, say -- to prove the frontend does not rely
   * on the host having done it.
   */
  sources?: { url: string; title?: string }[];
  grounded?: boolean;
  groundingReason?: string;
}

const AI_STORAGE_STUB = {
  backend: 'keychain' as const,
  location: 'macOS Keychain (service "circleci-editor")',
};

/**
 * The environment variable the real host would check for the stubbed
 * "anthropic" provider (see `keystore.KeyEnvVar`) -- not a secret, just the
 * name, so the AI status/key stubs below can report it exactly as the real
 * host does.
 */
const AI_ENV_VAR_STUB = 'VCE_AI_KEY_ANTHROPIC';

/**
 * The `source`/`envVar`/`storedKeyShadowed` triple every real
 * `GET /api/ai/status` and `PUT`/`DELETE /api/ai/key` response carries
 * (issue #7: the pane needs to distinguish an environment-supplied key from
 * a stored one to decide whether Remove would do anything). None of these
 * specs simulate `VCE_AI_KEY_ANTHROPIC` being set, so the stubbed provider is
 * always either genuinely stored or genuinely absent -- never shadowed.
 */
function aiKeySourceStub(configured: boolean) {
  return {
    source: configured ? 'store' : 'none',
    envVar: AI_ENV_VAR_STUB,
    storedKeyShadowed: false,
  };
}

/** One partial failure, as the host reports them (issue #150). */
export interface ProjectContextWarningStub {
  kind:
    | 'project'
    | 'settings'
    | 'organization'
    | 'contexts'
    | 'projectVariables'
    | 'contextVariables'
    | 'restrictions';
  headline: string;
  detail?: string;
  consequences?: string[];
}

/**
 * The shape of the `GET /api/project-context` stub, named so a spec can
 * override just the parts it cares about -- including `warnings`, which issue
 * #150's specs need and which a `typeof PROJECT_CONTEXT_STUB` type could not
 * express.
 */
export interface ProjectContextStub {
  available: boolean;
  reason?: string;
  projectSlug?: string;
  project?: {
    name: string;
    slug: string;
    organizationName: string;
    organizationSlug: string;
    vcsProvider: string;
    defaultBranch: string;
    /**
     * The host builds this from `slug` above (issue #182). Omit it to stub a
     * project CircleCI addresses by ID rather than by name -- a GitLab or
     * GitHub App project -- which the top bar must render as plain text even
     * when `GET /api/meta` carried a URL.
     */
    webUrl?: string;
    /**
     * The settings-page half of issue #248's link pair, built by the host the
     * same way as `webUrl`. Omit it alongside `webUrl` to stub an ID-addressed
     * project, for the same reason.
     */
    settingsUrl?: string;
  };
  settings?: {
    dynamicConfig: boolean;
    unversionedConfig: boolean;
    oss: boolean;
    buildForkPrs: boolean;
    passSecretsToForkPrs: boolean;
  };
  contexts: { id: string; name: string }[];
  projectVariables: { name: string }[];
  warnings?: ProjectContextWarningStub[];
}

/**
 * The default `GET /api/project-context` body (issue #105) for a stubbed host
 * that has a token. Entirely invented -- no real context name, variable name
 * or truncated preview appears anywhere in this repo.
 */
const PROJECT_CONTEXT_STUB: ProjectContextStub = {
  available: true,
  projectSlug: 'gh/example/widgets',
  project: {
    name: 'widgets',
    slug: 'gh/example/widgets',
    organizationName: 'example',
    organizationSlug: 'gh/example',
    vcsProvider: 'GitHub',
    defaultBranch: 'main',
    webUrl: 'https://app.circleci.com/projects/gh/example/widgets',
    settingsUrl: 'https://app.circleci.com/settings/project/gh/example/widgets',
  },
  settings: {
    dynamicConfig: false,
    unversionedConfig: true,
    oss: false,
    buildForkPrs: false,
    passSecretsToForkPrs: false,
  },
  contexts: [
    { id: 'ctx-build', name: 'build-secrets' },
    { id: 'ctx-deploy', name: 'deploy-prod' },
  ],
  projectVariables: [{ name: 'DEPLOY_TARGET' }, { name: 'WIDGETS_API_URL' }],
};

/** The default `GET /api/project-context/variables` body. Invented, as above. */
const CONTEXT_VARIABLES_STUB = {
  available: true,
  variables: [
    { name: 'AWS_ROLE', truncatedValue: 'arn:' },
    { name: 'AWS_ROLE_ARN', truncatedValue: 'arn:' },
  ],
  usability: 'unrestricted' as const,
};

export interface MockHostApiOptions {
  hasToken?: boolean;
  configExists?: boolean;
  validate?: ValidateStub;
  /** Whether `GET /api/ai/status` reports the (single, "anthropic") stubbed provider as already configured. Defaults to `false` -- the honest no-key starting state. */
  aiConfigured?: boolean;
  /** Overrides `FIXTURE_CONFIG` as the config the mocked `GET /api/config` returns. Issue #88's own scroll-region/canvas-width measurements need a much larger config than the three-job default -- see `buildLargeWorkflowConfig`. */
  config?: string;
  /** Overrides the stubbed `GET /api/project-context` body (issue #105). Ignored when `hasToken` is false, which serves the "explain, don't spin" response instead. */
  projectContext?: ProjectContextStub;
  /** Overrides the stubbed `POST /api/policy/decide` body (issue #215). Ignored when `hasToken` is false, which serves the host's own "no token, so no decision" answer instead. */
  policy?: PolicyStub;
  /** Overrides the project slug `GET /api/meta` reports. `''` is the "this config is not in a CircleCI-connected checkout" case (issue #149). */
  projectSlug?: string;
  /**
   * Overrides the deep link `GET /api/meta` carries (issue #149). Defaults to
   * the CircleCI web UI URL for `projectSlug`; pass `''` for the VCS types
   * whose web pages a slug cannot address, where the host sends none.
   */
  projectWebUrl?: string;
  /** Overrides the stubbed `GET /api/project-context/variables` body (issue #105). Ignored when `hasToken` is false. */
  contextVariables?: typeof CONTEXT_VARIABLES_STUB;
  /**
   * Overrides the git slice of `GET /api/meta` (issue #214): the branch to
   * show, where it came from, and the `origin` remote. Defaults to
   * `META_GIT_STUB` -- a checkout whose HEAD and CIRCLE_BRANCH agree, on
   * GitHub, which is the ordinary case and the one the app bar's furniture
   * budget is measured against. Pass `{}` for "not a git checkout", where none
   * of these cells render at all.
   */
  git?: MetaGitStub;
  /**
   * Overrides the stubbed `GET /api/orbs/source` body. Defaults to the
   * "unavailable, no token" answer -- which is what the diagnostics strip
   * (issue #148) needs in order to *decline* an orb-version suggestion, so a
   * spec asserting the opposite has to opt in explicitly.
   */
  orbSource?: OrbSourceStub;
}

/**
 * The git slice of `GET /api/meta` (issue #214). Mirrors the host's own fields;
 * see `internal/host/gitinfo.go` for what each one means and why the checkout's
 * HEAD beats `CIRCLE_BRANCH`.
 */
export interface MetaGitStub {
  branch?: string;
  branchSource?: 'checkout' | 'environment';
  envBranch?: string;
  repoWebUrl?: string;
  repoName?: string;
  repoHost?: string;
}

/**
 * The default checkout `GET /api/meta` reports: a branch read from the working
 * tree, agreeing with the injected one, pushing to GitHub. Invented, like every
 * other name in this file.
 */
export const META_GIT_STUB: MetaGitStub = {
  branch: 'main',
  branchSource: 'checkout',
  envBranch: 'main',
  repoWebUrl: 'https://github.com/example/widgets',
  repoName: 'example/widgets',
  repoHost: 'github.com',
};

/** Mirrors the host's `OrbSourceResponse` shape (see `web/src/lib/rpc/client.ts`). */
export interface OrbSourceStub {
  available: boolean;
  name?: string;
  version?: string;
  source: string;
  reason?: string;
  versions?: string[];
  latestVersion?: string;
}

export interface HostApiHandle {
  /** The body most recently written via `PUT /api/config`, or `null` if the app hasn't saved yet. */
  getSavedConfig: () => string | null;
  /** How many times `PUT /api/config` has been called. */
  getSaveCount: () => number;
  /** Replaces the stubbed `POST /api/validate` response used for subsequent requests. */
  setValidateResponse: (stub: ValidateStub) => void;
  /** Replaces the stubbed `POST /api/policy/decide` response used for subsequent requests (issue #215). */
  setPolicyResponse: (stub: PolicyStub) => void;
  /**
   * How many times `POST /api/policy/decide` has been called, and with what
   * config bodies. This is how a spec proves the two things that matter most
   * about a policy check: that nothing runs one unasked, and that what left
   * the browser is exactly the config on screen.
   */
  getPolicyChecks: () => string[];
  /** Replaces the stubbed `POST /api/ai/chat` response used for subsequent requests. */
  setAiChatResponse: (stub: AiChatStub) => void;
  /** The key most recently sent to `PUT /api/ai/key`, or `null` if none has been. Never logged anywhere else in this fixture -- reading it back is how a spec proves the browser sent the exact key it typed, without the fixture itself becoming another place the key sits around. */
  getLastAiKeySet: () => string | null;
  /** How many times `DELETE /api/ai/key` has been called. */
  getAiKeyDeleteCount: () => number;
  /**
   * Simulates the host process dying (issue #110): the currently-open
   * `/api/heartbeat` connection is aborted, and every subsequent one is
   * aborted too, exactly like a real dead process would leave every
   * reconnect attempt failing. Specs use this to drive
   * `HostGoneOverlay`/`useHostLiveness` without a real Go host to kill.
   */
  killHost: () => Promise<void>;
}

/**
 * Stubs the host's local JSON API via `page.route`, so specs can drive the
 * real built app (served by `vite preview`) without a Go host running
 * alongside it. Route handlers run in the test process, so the returned
 * handle's closures see every request synchronously -- no `page.evaluate`
 * needed to read back what the app tried to save.
 */
export async function mockHostApi(
  page: Page,
  options: MockHostApiOptions = {},
): Promise<HostApiHandle> {
  const {
    hasToken = true,
    configExists = true,
    projectSlug = 'gh/example/widgets',
  } = options;
  // The host derives this from the injected environment, so the default here
  // mirrors what it would build for `projectSlug` (see
  // `Environment.ProjectWebURL`); `''` is the no-link case.
  // Issue #214 moved this from `/pipelines/` to the project overview -- see
  // `Environment.ProjectWebURLForSlug` for the route and how it was verified.
  const projectWebUrl =
    options.projectWebUrl ??
    (projectSlug ? `https://app.circleci.com/projects/${projectSlug}` : '');
  const git = options.git ?? META_GIT_STUB;

  let currentConfig = options.config ?? FIXTURE_CONFIG;
  let savedConfig: string | null = null;
  let saveCount = 0;
  let validateStub: ValidateStub = options.validate ?? VALID_STUB;
  // Issue #247: this used to default to the hard-fail decision, on the
  // reasoning that nothing fired it without an explicit "Check policies"
  // click, so every *other* spec was unaffected by the default. Evaluation
  // now runs automatically in the background on every page load (that is
  // the point of #247), so a hard-fail default would tint a diagnostic line
  // and ring a DAG node on every spec in this suite that doesn't otherwise
  // care about policies -- which is exactly what broke when this changed
  // (`diagnostics.spec.ts`'s node/line counts). The default is now the
  // inert "no enabled rules" answer instead; `policy.spec.ts` passes
  // `POLICY_HARD_FAIL_STUB` explicitly wherever it wants one.
  let policyStub: PolicyStub = options.policy ?? {
    available: true,
    source: 'api',
    status: 'PASS',
    compiledConfigIncluded: true,
  };
  const policyChecks: string[] = [];
  // Issue #105. `const`, not `let`: no spec needs to vary these mid-run yet,
  // and the `hasToken: false` branch of each route already covers the
  // degradation case that matters.
  const projectContextStub = options.projectContext ?? PROJECT_CONTEXT_STUB;
  const contextVariablesStub =
    options.contextVariables ?? CONTEXT_VARIABLES_STUB;
  const orbSourceStub: OrbSourceStub = options.orbSource ?? {
    available: false,
    source: 'unavailable',
    reason: 'no CircleCI API token available',
  };
  let aiConfigured = options.aiConfigured ?? false;
  let aiChatStub: AiChatStub | null = null;
  let lastAiKeySet: string | null = null;
  let aiKeyDeleteCount = 0;
  let hostAlive = true;
  let pendingHeartbeatRoute: Route | null = null;

  // `/api/heartbeat` (see internal/host/heartbeat.go) is a Server-Sent
  // Events stream that's meant to stay open for as long as the tab is:
  // `route.fulfill` always completes a response, so there is no way to
  // hand it a real, never-ending body -- deliberately *not* resolving the
  // route at all (no fulfill/continue/abort call) is what leaves the
  // request pending exactly like a genuinely open connection, which is
  // what `useHostLiveness`'s optimistic default ("alive" until proven
  // otherwise) expects to see through a whole spec that never calls
  // `killHost`. `killHost` aborts that pending request -- and every
  // request the browser's own EventSource reconnect logic makes after
  // that -- reproducing "every attempt to reach the host now fails" the
  // same way a real dead process would.
  await page.route('**/api/heartbeat', async (route) => {
    if (!hostAlive) {
      await route.abort();
      return;
    }
    pendingHeartbeatRoute = route;
  });

  await page.route('**/api/meta', async (route) => {
    await route.fulfill({
      json: {
        version: 'e2e-test',
        configPath: FIXTURE_CONFIG_PATH,
        configExists,
        configFound: configExists,
        projectSlug,
        hasToken,
        host: 'localhost:8080',
        cwd: '/home/dev/widgets',
        // The real host's per-launch CSRF token (see internal/host/csrf.go),
        // which the client stashes for every subsequent mutating call. A
        // fixed string is fine here -- these specs stub every route rather
        // than enforcing the real host's CSRF middleware, so nothing checks
        // this value -- but it needs to be *present*, matching the real
        // response shape, for the client's own attach-it-on-every-mutation
        // logic to have something to attach.
        csrfToken: 'e2e-test-csrf-token',
        projectWebUrl,
        ...git,
      },
    });
  });

  await page.route('**/api/config', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { contents: string };
      savedConfig = body.contents;
      currentConfig = body.contents;
      saveCount += 1;
      await route.fulfill({
        json: { path: FIXTURE_CONFIG_PATH, bytes: body.contents.length },
      });
      return;
    }

    await route.fulfill({
      json: {
        path: FIXTURE_CONFIG_PATH,
        contents: currentConfig,
        exists: configExists,
      },
    });
  });

  // Issues #106/#102's shared directory index. Stubbed as a single-file
  // directory (just the fixture config) by default -- specs that actually
  // exercise the file switcher or the AI pane's multi-file context should
  // override this route themselves with their own multi-file listing,
  // the same way they already override `validate`/`aiChat` via the
  // returned handle rather than this fixture guessing every shape.
  await page.route('**/api/config-files**', async (route) => {
    const withContents = new URL(route.request().url()).searchParams.get(
      'contents',
    );
    await route.fulfill({
      json: {
        dir: '/home/dev/widgets/.circleci',
        primaryPath: FIXTURE_CONFIG_PATH,
        files: [
          {
            path: FIXTURE_CONFIG_PATH,
            relPath: 'config.yml',
            size: currentConfig.length,
            isPrimary: true,
            // The host classifies every file it lists (issue #135), and the
            // primary one is always a config. Specs that need a
            // *non*-config sibling override this route with their own
            // listing -- see `config-switcher.spec.ts`.
            isConfig: true,
            configReason: 'Declares version: 2.1.',
            ...(withContents ? { contents: currentConfig } : {}),
          },
        ],
      },
    });
  });

  await page.route('**/api/validate', async (route) => {
    await route.fulfill({ json: validateStub });
  });

  // Issue #215. Records the config each check posted, so a spec can assert
  // both that nothing was sent unasked and that what was sent is the text on
  // screen. Without a token the host answers "no decision, and here is why"
  // rather than a verdict, which is the state the UI must not render as a
  // pass -- so the fixture reproduces it exactly.
  await page.route('**/api/policy/decide', async (route) => {
    const body = route.request().postDataJSON() as { contents?: string };
    policyChecks.push(body?.contents ?? '');
    if (!hasToken) {
      await route.fulfill({
        json: {
          available: false,
          source: 'unavailable',
          reason:
            'no CircleCI API token available; a policy check needs a token',
        },
      });
      return;
    }
    await route.fulfill({ json: policyStub });
  });

  // Issue #148: the diagnostics strip asks this endpoint for an orb's real
  // published version list before it will offer to correct a version. The
  // default is the honest "no token, so we couldn't look" answer, which is
  // also exactly the case a spec needs in order to assert that *no*
  // suggestion is offered when the registry can't be reached.
  await page.route('**/api/orbs/source**', async (route) => {
    await route.fulfill({ json: orbSourceStub });
  });

  await page.route('**/api/orbs/search**', async (route) => {
    await route.fulfill({
      json: {
        query: new URL(route.request().url()).searchParams.get('q') ?? '',
        results: [],
      },
    });
  });

  await page.route('**/api/ai/status', async (route) => {
    await route.fulfill({
      json: {
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            configured: aiConfigured,
            model: 'claude-e2e-test-model',
            ...aiKeySourceStub(aiConfigured),
          },
        ],
        storage: AI_STORAGE_STUB,
      },
    });
  });

  await page.route('**/api/ai/key**', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { provider: string; key: string };
      aiConfigured = true;
      lastAiKeySet = body.key;
      await route.fulfill({
        json: {
          provider: body.provider,
          configured: true,
          storage: AI_STORAGE_STUB,
          ...aiKeySourceStub(true),
        },
      });
      return;
    }
    if (request.method() === 'DELETE') {
      aiConfigured = false;
      aiKeyDeleteCount += 1;
      await route.fulfill({
        json: {
          provider: 'anthropic',
          configured: false,
          storage: AI_STORAGE_STUB,
          ...aiKeySourceStub(false),
        },
      });
      return;
    }
    await route.fulfill({
      status: 405,
      json: { error: { message: 'method not allowed' } },
    });
  });

  await page.route('**/api/ai/chat', async (route) => {
    const response: AiChatStub =
      aiChatStub ??
      (aiConfigured
        ? { available: true, content: 'This is a stubbed e2e reply.' }
        : {
            available: false,
            reason:
              "no API key configured for Anthropic; add one in the AI pane's settings first",
          });
    await route.fulfill({ json: response });
  });

  // Issue #105's read-only project metadata. Keyed off the same `hasToken`
  // the `/api/meta` stub above reports on, so a spec that asks for a
  // token-less host gets a *consistently* token-less host -- the palette's
  // Contexts/Project sections explain themselves rather than erroring, which
  // is exactly the degradation `internal/host/projectcontext_test.go` covers
  // on the Go side.
  await page.route('**/api/project-context', async (route) => {
    if (!hasToken) {
      await route.fulfill({
        json: {
          available: false,
          reason:
            'No CircleCI API token is available, so this host cannot look up contexts, environment variable names or project settings.',
          contexts: [],
          projectVariables: [],
        },
      });
      return;
    }
    await route.fulfill({ json: projectContextStub });
  });

  await page.route('**/api/project-context/variables**', async (route) => {
    const contextId =
      new URL(route.request().url()).searchParams.get('contextId') ?? '';
    if (!hasToken) {
      await route.fulfill({
        json: {
          available: false,
          reason: 'No CircleCI API token is available.',
          variables: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: { ...contextVariablesStub, contextId },
    });
  });

  // Issue #181's resource classes, which the real host derives from the
  // CircleCI resource tables vendored into its binary. Stubbed with a small,
  // realistic subset rather than all ten tables: what the host extracts from the
  // real tables is pinned in `internal/guides/resourceclasses_test.go` against
  // the tables themselves, and a full copy here would be one more literal to
  // drift. Needs no token, exactly like the real endpoint.
  await page.route('**/api/resource-classes', async (route) => {
    await route.fulfill({
      json: {
        derived: true,
        environments: [
          {
            id: 'x86',
            label: 'x86',
            kind: 'docker',
            architecture: 'x86_64',
            generation: 'gen1',
            classes: [
              { name: 'small', architecture: 'x86_64', generation: 'gen1' },
              {
                name: 'medium',
                spec: 'vCPUs 2, RAM 4GB',
                architecture: 'x86_64',
                generation: 'gen1',
              },
              { name: 'xlarge', architecture: 'x86_64', generation: 'gen1' },
            ],
          },
          {
            id: 'x86-gen2',
            label: 'x86 (gen2)',
            kind: 'docker',
            architecture: 'x86_64',
            generation: 'gen2',
            classes: [
              {
                name: 'xlarge.gen2',
                architecture: 'x86_64',
                generation: 'gen2',
              },
            ],
          },
          {
            id: 'arm',
            label: 'Arm',
            kind: 'docker',
            architecture: 'arm64',
            generation: 'gen1',
            classes: [
              { name: 'arm.medium', architecture: 'arm64', generation: 'gen1' },
              {
                name: 'arm.2xlarge',
                architecture: 'arm64',
                generation: 'gen1',
              },
            ],
          },
          {
            id: 'macos-execution-environment',
            label: 'macOS execution environment',
            kind: 'macos',
            architecture: '',
            generation: 'gen1',
            classes: [
              { name: 'm4pro.medium', architecture: '', generation: 'gen1' },
            ],
          },
        ],
      },
    });
  });

  // Issue #211's supported-Xcode versions, which the real host derives from the
  // `xcode-silicon-vm.adoc` table vendored into its binary. Stubbed with a small
  // subset for the same reason the resource classes above are: what the host
  // extracts from the real table is pinned in
  // `internal/guides/xcodeversions_test.go` against the table itself, and the fact
  // that no TypeScript literal disagrees with it is pinned in
  // `web/src/lib/xcodeVersions/vendoredXcodeTable.test.ts`. A third copy here would
  // be one more thing to drift.
  //
  // Deliberately keeps a pre-release at the top and a supported version as
  // `default`, because that ordering is the point of the grouping: the table's
  // newest row is routinely a beta whose image upstream says is not frozen, and a
  // new job must not start on one.
  await page.route('**/api/xcode-versions', async (route) => {
    await route.fulfill({
      json: {
        derived: true,
        default: '26.5',
        versions: [
          {
            version: '27.0',
            label: 'Xcode 27.0 (27A5228h)',
            spec: 'macOS Version 26.5.1',
            resourceClasses: ['m4pro.medium'],
            prerelease: true,
            prereleaseKind: 'beta',
          },
          {
            version: '26.5',
            label: 'Xcode 26.5 (17F42)',
            spec: 'macOS Version 26.3.1',
            resourceClasses: ['m4pro.medium'],
          },
          {
            version: '26.4.1',
            label: 'Xcode 26.4.1 (17E202)',
            spec: 'macOS Version 26.3',
            resourceClasses: ['m4pro.medium'],
          },
        ],
      },
    });
  });

  // Issue #213's Docker Hub tag proxy. `tags` is the ranked handful the picker
  // recommends; `allTags` is what its combobox types over. Both are served because
  // they answer different questions -- see `internal/dockerhub.VersionTags`.
  //
  // No non-version tag appears in either, matching the real endpoint: the host
  // drops them, because CircleCI's own docs tell users to avoid mutable tags. The
  // `latest` warning fires on what a user *types*, never on something offered.
  await page.route('**/api/docker-tags**', async (route) => {
    await route.fulfill({
      json: {
        available: true,
        live: true,
        fetchedAt: '2026-07-29T12:00:00Z',
        tags: ['20.11.0', '20.10.0'],
        allTags: ['20.11.2', '20.11.0', '20.11.0-browsers', '20.10.0'],
      },
    });
  });

  // Issue #305's live machine-image catalog, mirroring a trimmed slice of the
  // real GET /api/v3/catalog/offerings response verified live on 2026-07-31 --
  // enough resource classes/images to exercise the picker's compatibility
  // filtering and deprecated-image flagging without pinning the whole ~20KB
  // catalog.
  await page.route('**/api/machine-offerings**', async (route) => {
    await route.fulfill({
      json: {
        available: true,
        live: true,
        stale: false,
        fetchedAt: '2026-07-31T12:00:00Z',
        linux: {
          medium: [
            'ubuntu-2204:current',
            'ubuntu-2204:edge',
            'ubuntu-2404:current',
            'ubuntu-2404:edge',
          ],
        },
        windows: {
          'windows.medium': [
            'windows-server-2022-gui:current',
            'windows-server-2022-gui:edge',
          ],
        },
        macos: {
          'm4pro.medium': ['xcode:26.5.0', 'xcode:current'],
        },
        deprecated: {
          linux: [],
          windows: [],
          macos: ['xcode:14.3.1'],
        },
      },
    });
  });

  return {
    getSavedConfig: () => savedConfig,
    getSaveCount: () => saveCount,
    setValidateResponse: (stub) => {
      validateStub = stub;
    },
    setPolicyResponse: (stub) => {
      policyStub = stub;
    },
    getPolicyChecks: () => [...policyChecks],
    setAiChatResponse: (stub) => {
      aiChatStub = stub;
    },
    getLastAiKeySet: () => lastAiKeySet,
    getAiKeyDeleteCount: () => aiKeyDeleteCount,
    killHost: async () => {
      hostAlive = false;
      if (pendingHeartbeatRoute) {
        await pendingHeartbeatRoute.abort();
        pendingHeartbeatRoute = null;
      }
    },
  };
}
