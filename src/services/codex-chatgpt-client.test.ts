import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  getCodexAccessToken: vi.fn(),
  sharedClient: {
    isRunning: vi.fn(() => true),
    start: vi.fn(async () => {}),
    getAuthState: vi.fn(async () => ({ authMode: 'chatgpt' })),
  },
}));

vi.mock('./codex-token.js', () => ({
  getCodexAccessToken: mocked.getCodexAccessToken,
}));

vi.mock('./codex-app-server.js', () => ({
  getSharedCodexClient: () => mocked.sharedClient,
}));

import {
  clearCodexChatGPTSession,
  createCodexChatGPTClient,
  hasCodexChatGPTAuth,
  interruptCodexChatGPTTurn,
} from './codex-chatgpt-client.js';

function buildSseResponse(payload: any): Response {
  const body = [
    'event: response.created',
    'data: ' + JSON.stringify({
      type: 'response.created',
      response: {
        id: 'resp_1',
        status: 'in_progress',
        output: [],
      },
    }),
    '',
    'event: response.completed',
    'data: ' + JSON.stringify({
      type: 'response.completed',
      response: payload,
    }),
    '',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createCodexChatGPTClient', () => {
  beforeEach(() => {
    mocked.getCodexAccessToken.mockReset();
    mocked.sharedClient.isRunning.mockReset();
    mocked.sharedClient.start.mockReset();
    mocked.sharedClient.getAuthState.mockReset();

    mocked.sharedClient.isRunning.mockReturnValue(true);
    mocked.sharedClient.start.mockResolvedValue(undefined);
    mocked.sharedClient.getAuthState.mockResolvedValue({ authMode: 'chatgpt' });

    clearCodexChatGPTSession();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearCodexChatGPTSession();
    vi.unstubAllGlobals();
  });

  it('maps developer messages to instructions and returns the completed backend response', async () => {
    mocked.getCodexAccessToken.mockResolvedValue('token-1');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));

      expect(body.instructions).toBe('You are an agent.');
      expect(body.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Run the tests' }] },
      ]);
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.prompt_cache_key).toBeUndefined();
      expect(body.prompt_cache_retention).toBeUndefined();

      return buildSseResponse({
        id: 'resp_123',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done' }],
          },
        ],
        output_text: 'Done',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createCodexChatGPTClient({ sessionId: 'session-1' });
    const response = await client.responses.create({
      model: 'gpt-5',
      input: [
        { role: 'developer', content: 'You are an agent.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Run the tests' }] },
      ],
      max_output_tokens: 256,
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: '24h',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual(expect.objectContaining({
      id: 'resp_123',
      status: 'completed',
      output_text: 'Done',
    }));
  });

  it('normalizes replayed reasoning items for the Codex backend schema', async () => {
    mocked.getCodexAccessToken.mockResolvedValue('token-1');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));

      expect(body.input).toEqual([
        { role: 'user', content: 'first prompt' },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'condensed reasoning' }],
          content: [{ type: 'reasoning_text', text: 'full reasoning text' }],
        },
        { role: 'user', content: 'second prompt' },
      ]);

      return buildSseResponse({
        id: 'resp_reasoning',
        status: 'completed',
        output: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createCodexChatGPTClient();
    await client.responses.create({
      model: 'gpt-5',
      input: [
        { role: 'user', content: 'first prompt' },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ text: 'condensed reasoning' }],
          content: [{ text: 'full reasoning text' }],
        },
        { role: 'user', content: 'second prompt' },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('strips unsupported input_image fields from replayed message content', async () => {
    mocked.getCodexAccessToken.mockResolvedValue('token-1');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));

      expect(body.input).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect this image' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,abc123',
              detail: 'low',
            },
          ],
        },
      ]);

      return buildSseResponse({
        id: 'resp_image',
        status: 'completed',
        output: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createCodexChatGPTClient();
    await client.responses.create({
      model: 'gpt-5',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect this image' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,abc123',
              mime_type: 'image/png',
              filename: 'capture.png',
              detail: 'low',
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the auth token and retries once when the backend returns 401', async () => {
    mocked.getCodexAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      if (auth === 'Bearer stale-token') {
        return new Response(JSON.stringify({ detail: 'expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }

      return buildSseResponse({
        id: 'resp_456',
        status: 'completed',
        output: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createCodexChatGPTClient();
    const response = await client.responses.create({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'hello' }],
    });

    expect(mocked.sharedClient.getAuthState).toHaveBeenCalledWith({ refreshToken: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response).toEqual(expect.objectContaining({
      id: 'resp_456',
      status: 'completed',
    }));
  });

  it('aborts in-flight session requests', async () => {
    mocked.getCodexAccessToken.mockResolvedValue('token-1');

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('signal is required'));
        return;
      }
      started();
      signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        (error as Error & { name: string }).name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCodexChatGPTClient({ sessionId: 'session-2' });
    const pending = client.responses.create({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'hello' }],
    });

    await startedPromise;

    await expect(interruptCodexChatGPTTurn('session-2')).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports ChatGPT auth as available when a cached Codex access token exists', async () => {
    mocked.getCodexAccessToken.mockResolvedValue('token-1');

    await expect(hasCodexChatGPTAuth()).resolves.toBe(true);
    expect(mocked.sharedClient.getAuthState).not.toHaveBeenCalled();
  });
});
