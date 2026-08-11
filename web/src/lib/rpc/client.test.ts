import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  deleteAiKey,
  deleteAiMcp,
  getAiMcpStatus,
  getAiStatus,
  getConfig,
  getDockerTags,
  getOrbSource,
  getSchema,
  postAiChat,
  postValidate,
  putAiKey,
  putAiMcp,
  putConfig,
  searchOrbs,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('rpc client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a successful getConfig body', async () => {
    const payload = {
      path: '/repo/.circleci/config.yml',
      contents: 'version: 2.1\n',
      exists: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getConfig();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('throws a typed ApiError with status and message on a non-2xx error envelope', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(500, { error: { message: 'disk is full' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getConfig()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'disk is full',
    });
  });

  it('is thrown as an instance of ApiError', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(400, { error: { message: 'bad request' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await putConfig('version: 2.1\n');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
  });

  it('falls back to a generic message when the body is not the error envelope shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('not json', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getConfig()).rejects.toMatchObject({ status: 502 });
  });

  it('postValidate POSTs contents and parses an "available" validation result', async () => {
    const payload = {
      available: true,
      source: 'api',
      valid: false,
      errors: [{ message: 'job "broken" not found: [#/jobs/broken]' }],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postValidate('version: 2.1\n');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/validate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ contents: 'version: 2.1\n' }),
      }),
    );
  });

  it('postValidate parses an "unavailable" result without treating it as invalid', async () => {
    const payload = {
      available: false,
      source: 'unavailable',
      valid: false,
      reason: 'no CircleCI API token available; validation requires a token',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postValidate('version: 2.1\n');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('token');
  });

  it('postValidate rejects with ApiError on a transport failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(502, {
        error: { message: 'CircleCI API rejected the configured token' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postValidate('version: 2.1\n')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });
  });

  it('searchOrbs GETs the search endpoint with q/limit and parses an "available" result', async () => {
    const payload = {
      available: true,
      status: { ready: true, complete: true, count: 6400, warming: false },
      results: [
        {
          name: 'circleci/node',
          private: false,
          certified: true,
          latestVersion: '5.2.0',
          versions: ['5.2.0'],
          matchedOn: 'exact-name',
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchOrbs('node', 10);

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orbs/search?q=node&limit=10',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('searchOrbs parses an "unavailable" result without treating it as zero results', async () => {
    const payload = {
      available: false,
      source: 'unavailable',
      reason: 'no CircleCI API token available; orb search requires a token',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchOrbs('node');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('token');
    expect(result.results).toBeUndefined();
  });

  it('searchOrbs throws ApiError on a non-2xx error envelope', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(500, { error: { message: 'orb cache unavailable' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchOrbs('node')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('getOrbSource GETs the source endpoint with name/version and parses success', async () => {
    const payload = {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source: 'version: 2.1\n',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getOrbSource('circleci/node', '5.2.0');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orbs/source?name=circleci%2Fnode&version=5.2.0',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('getOrbSource omits the version param when not given', async () => {
    const payload = {
      available: true,
      name: 'circleci/node',
      version: '5.2.0',
      source: 'version: 2.1\n',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    await getOrbSource('circleci/node');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orbs/source?name=circleci%2Fnode',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('getOrbSource throws ApiError with the not-found message on a 404', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(404, {
        error: { message: 'orb not found: circleci/nope' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getOrbSource('circleci/nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'orb not found: circleci/nope',
    });
  });

  it('getSchema GETs /api/schema and returns the parsed body verbatim', async () => {
    const payload = { properties: { jobs: {} } };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getSchema();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/schema',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('getSchema throws ApiError on a non-2xx response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSchema()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('getAiStatus GETs /api/ai/status and parses the provider/storage payload', async () => {
    const payload = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          configured: false,
          model: 'claude-sonnet-5',
        },
      ],
      storage: {
        backend: 'keychain',
        location: 'macOS Keychain (service "circleci-editor")',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAiStatus();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/status',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('putAiKey PUTs the provider and key and never echoes the key back through its own request assertion mistake', async () => {
    const payload = {
      provider: 'anthropic',
      configured: true,
      storage: {
        backend: 'file',
        location: '/home/dev/.config/circleci-editor/keys.json',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await putAiKey('anthropic', 'sk-ant-test-key');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/key',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-test-key' }),
      }),
    );
  });

  it('deleteAiKey DELETEs with the provider as a query parameter', async () => {
    const payload = {
      provider: 'anthropic',
      configured: false,
      storage: {
        backend: 'file',
        location: '/home/dev/.config/circleci-editor/keys.json',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deleteAiKey('anthropic');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/key?provider=anthropic',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('getAiMcpStatus GETs the mcp endpoint and parses an unconfigured result', async () => {
    const payload = { configured: false };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAiMcpStatus();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/mcp',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('putAiMcp PUTs the url alone -- there is no token to send', async () => {
    const payload = {
      configured: true,
      url: 'https://circleci.mcp.kapa.ai/sse',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await putAiMcp('https://circleci.mcp.kapa.ai/sse');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/mcp',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ url: 'https://circleci.mcp.kapa.ai/sse' }),
      }),
    );
  });

  it('deleteAiMcp DELETEs the mcp endpoint', async () => {
    const payload = { configured: false };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deleteAiMcp();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/mcp',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('postAiChat parses "sources" alongside content when the docs MCP server was used', async () => {
    const payload = {
      available: true,
      content: 'A resource class controls the compute tier a job runs on.',
      model: 'claude-sonnet-5',
      sources: [
        'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postAiChat(
      'anthropic',
      [{ role: 'user', content: 'what is a resource class?' }],
      {
        configPath: '',
        configText: '',
        jobNames: [],
        workflowNames: [],
        validationErrors: [],
        otherFiles: [],
        skippedFiles: [],
        policyViolations: [],
      },
    );

    expect(result.sources).toEqual([
      'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
    ]);
  });

  it('postAiChat POSTs provider/messages/context and parses an "available" reply', async () => {
    const payload = {
      available: true,
      content: 'The build job installs dependencies and runs the build script.',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 120, outputTokens: 18 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const context = {
      configPath: '/repo/.circleci/config.yml',
      configText: 'version: 2.1\n',
      jobNames: ['build'],
      workflowNames: ['main'],
      validationErrors: [],
      otherFiles: [],
      skippedFiles: [],
      policyViolations: [],
    };
    const result = await postAiChat(
      'anthropic',
      [{ role: 'user', content: 'what does build do?' }],
      context,
    );

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'anthropic',
          messages: [{ role: 'user', content: 'what does build do?' }],
          context,
        }),
      }),
    );
  });

  it('postAiChat parses an "unavailable" result without treating it as an empty reply', async () => {
    const payload = {
      available: false,
      reason:
        "no API key configured for Anthropic; add one in the AI pane's settings first",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postAiChat(
      'anthropic',
      [{ role: 'user', content: 'hi' }],
      {
        configPath: '',
        configText: '',
        jobNames: [],
        workflowNames: [],
        validationErrors: [],
        otherFiles: [],
        skippedFiles: [],
        policyViolations: [],
      },
    );

    expect(result.available).toBe(false);
    expect(result.reason).toContain('API key');
    expect(result.content).toBeUndefined();
  });

  it('postAiChat throws ApiError on a provider auth failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(502, {
        error: { message: 'Anthropic rejected the configured API key' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      postAiChat('anthropic', [{ role: 'user', content: 'hi' }], {
        configPath: '',
        configText: '',
        jobNames: [],
        workflowNames: [],
        validationErrors: [],
        otherFiles: [],
        skippedFiles: [],
        policyViolations: [],
      }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 502 });
  });

  it('getDockerTags GETs the docker-tags endpoint with the bare image name and parses an "available" result', async () => {
    const payload = {
      available: true,
      tags: ['20.11.0', '20.10.0'],
      fetchedAt: '2026-07-20T12:00:00Z',
      live: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getDockerTags('node');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/docker-tags?image=node',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('getDockerTags parses an "unavailable" result without treating it as zero tags', async () => {
    const payload = {
      available: false,
      reason:
        'could not reach Docker Hub and no previously cached tag list is available for this image',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getDockerTags('node');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('Docker Hub');
    expect(result.tags).toBeUndefined();
  });

  it('getDockerTags throws ApiError on a non-2xx error envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, {
        error: {
          message: 'missing or invalid required query parameter: image',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDockerTags('')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
    });
  });

  // Each of these re-imports the module fresh (vi.resetModules + a dynamic
  // import) rather than using the top-level imports every other test in this
  // file shares. The CSRF token lives in module-level state (see
  // client.ts's own `csrfToken` doc comment), which makes these three tests
  // order-dependent on each other -- and on every other test in this file --
  // unless each one starts from a module that has never seen a getMeta call.
  describe('CSRF token', () => {
    it('does not attach a token to a mutating request before getMeta has ever resolved', async () => {
      vi.resetModules();
      const fresh = await import('./client');

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(200, { path: '/x', bytes: 1 }));
      vi.stubGlobal('fetch', fetchMock);

      await fresh.putConfig('version: 2.1\n');

      const [, init] = fetchMock.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('X-CircleCI-Editor-CSRF-Token');
    });

    it('attaches the token getMeta returned to every subsequent mutating request', async () => {
      vi.resetModules();
      const fresh = await import('./client');

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(200, { csrfToken: 'launch-token-abc123' }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { path: '/x', bytes: 1 }));
      vi.stubGlobal('fetch', fetchMock);

      await fresh.getMeta();
      await fresh.putConfig('version: 2.1\n');

      const [, putInit] = fetchMock.mock.calls[1]!;
      const headers = putInit?.headers as Record<string, string>;
      expect(headers['X-CircleCI-Editor-CSRF-Token']).toBe(
        'launch-token-abc123',
      );
    });

    it('never attaches the token to a GET request, even after getMeta has resolved', async () => {
      vi.resetModules();
      const fresh = await import('./client');

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(200, { csrfToken: 'launch-token-abc123' }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { path: '/x', contents: '', exists: true }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await fresh.getMeta();
      await fresh.getConfig();

      const [, getInit] = fetchMock.mock.calls[1]!;
      const headers = getInit?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('X-CircleCI-Editor-CSRF-Token');
    });
  });
});
