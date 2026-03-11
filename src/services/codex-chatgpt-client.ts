import { getSharedCodexClient } from './codex-app-server.js';
import { getCodexAccessToken } from './codex-token.js';
import type { AgentSessionClientBindings } from '../agent/session.js';

type CreateCodexChatGPTClientOptions = {
  sessionId?: string;
  workingDir?: string;
  model?: string;
  autoMode?: boolean;
};

type CodexChatGPTClient = {
  bindAgentSession?: (bindings: AgentSessionClientBindings) => void;
  responses: {
    create: (params: any) => Promise<any>;
    stream: (_params: any) => Promise<never>;
    retrieve: (_responseId: string) => Promise<never>;
    poll: (_path: string) => Promise<never>;
  };
};

type BackendEvent = {
  event: string;
  data: any;
};

const CODEX_BACKEND_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';
const sessionRequests = new Map<string, AbortController>();

function isChatGPTAuthMode(value: unknown): boolean {
  return value === 'chatgpt' || value === 'chatgptAuthTokens';
}

async function ensureCodexClientStarted(): Promise<ReturnType<typeof getSharedCodexClient>> {
  const client = getSharedCodexClient();
  if (!client.isRunning()) {
    await client.start();
  }
  return client;
}

async function refreshCodexAccessToken(): Promise<void> {
  const client = getSharedCodexClient();
  if (!client.isRunning()) {
    throw new Error('ChatGPT sign-in is not active. Choose "Sign in with ChatGPT" to refresh the session.');
  }
  await client.getAuthState({ refreshToken: true });
}

async function getUsableCodexAccessToken(): Promise<string> {
  const existingToken = await getCodexAccessToken();
  if (existingToken) {
    return existingToken;
  }

  try {
    await refreshCodexAccessToken();
  } catch {
    // Fall through and report the missing token below.
  }

  const refreshedToken = await getCodexAccessToken();
  if (refreshedToken) {
    return refreshedToken;
  }

  throw new Error('ChatGPT sign-in is not configured or no usable Codex access token is available.');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';

    if ((type === 'input_text' || type === 'output_text' || type === 'text')
      && typeof record.text === 'string'
      && record.text.trim()) {
      parts.push(record.text.trim());
    }
  }

  return parts.join('\n').trim();
}

function extractInstructions(params: any): string {
  if (typeof params?.instructions === 'string' && params.instructions.trim()) {
    return params.instructions.trim();
  }

  const input = Array.isArray(params?.input) ? params.input : [];
  const parts: string[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : '';
    if (role !== 'developer' && role !== 'system') continue;
    const text = extractText(record.content);
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim() || DEFAULT_INSTRUCTIONS;
}

function normalizeReasoningParts(
  parts: unknown,
  expectedType: 'summary_text' | 'reasoning_text',
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const normalized = parts.reduce<Array<Record<string, unknown>>>((acc, part) => {
      let next: Record<string, unknown> | null = null;
      if (typeof part === 'string') {
        const text = part.trim();
        next = text ? { type: expectedType, text } : null;
      } else if (part && typeof part === 'object') {
        const record = { ...(part as Record<string, unknown>) };
        const text = typeof record.text === 'string' ? record.text.trim() : '';
        if (text) {
          next = {
            ...record,
            text,
            type: expectedType,
          };
        }
      }

      if (next) {
        acc.push(next);
      }
      return acc;
    }, []);

  return normalized;
}

function normalizeMessageContentPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') {
    return part;
  }

  const record = { ...(part as Record<string, unknown>) };
  const type = typeof record.type === 'string' ? record.type : '';

  if (type === 'input_image') {
    const normalized: Record<string, unknown> = { type: 'input_image' };
    if (typeof record.image_url === 'string' && record.image_url.trim()) {
      normalized.image_url = record.image_url.trim();
    }
    if (record.file_id == null || typeof record.file_id === 'string') {
      if (typeof record.file_id === 'string' ? record.file_id.trim() : record.file_id === null) {
        normalized.file_id = record.file_id;
      }
    }
    if (record.detail === 'low' || record.detail === 'high' || record.detail === 'auto') {
      normalized.detail = record.detail;
    }
    return normalized;
  }

  return record;
}

function normalizeBackendItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const record = { ...(item as Record<string, unknown>) };
  if (Array.isArray(record.content)) {
    record.content = record.content.map(normalizeMessageContentPart);
  }
  if (record.type !== 'reasoning') {
    return record;
  }

  const normalizedSummary = normalizeReasoningParts(record.summary, 'summary_text');
  if (normalizedSummary) {
    record.summary = normalizedSummary;
  }

  const normalizedContent = normalizeReasoningParts(record.content, 'reasoning_text');
  if (normalizedContent) {
    record.content = normalizedContent;
  }

  return record;
}

function buildBackendInput(params: any): any[] {
  const input = Array.isArray(params?.input) ? params.input : [];
  return input.filter((item: unknown) => {
    if (!item || typeof item !== 'object') return true;
    const role = typeof (item as Record<string, unknown>).role === 'string'
      ? String((item as Record<string, unknown>).role)
      : '';
    return role !== 'developer' && role !== 'system';
  }).map(normalizeBackendItem);
}

function buildBackendRequest(params: any): Record<string, unknown> {
  const request: Record<string, unknown> = {
    ...params,
    instructions: extractInstructions(params),
    input: buildBackendInput(params),
    store: false,
    stream: true,
  };

  delete request.max_output_tokens;
  delete request.prompt_cache_key;
  delete request.prompt_cache_retention;

  return request;
}

function createRequestError(status: number, detail: string, data?: unknown): Error {
  const error = new Error(detail || `ChatGPT Codex backend request failed with status ${status}.`) as Error & {
    status?: number;
    statusCode?: number;
    response?: { status: number; data?: unknown };
  };
  error.status = status;
  error.statusCode = status;
  error.response = { status, data };
  return error;
}

function parseBackendEvent(chunk: string): BackendEvent | null {
  const lines = chunk.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const rawData = dataLines.join('\n');
  if (!rawData || rawData === '[DONE]') {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(rawData),
    };
  } catch {
    return null;
  }
}

function extractErrorDetail(data: any, fallbackStatus: number): string {
  const detail = typeof data?.detail === 'string'
    ? data.detail
    : typeof data?.error?.message === 'string'
      ? data.error.message
      : typeof data?.message === 'string'
        ? data.message
        : '';
  return detail || `ChatGPT Codex backend request failed with status ${fallbackStatus}.`;
}

async function parseBackendResponseStream(response: Response): Promise<any> {
  if (!response.body) {
    throw new Error('ChatGPT Codex backend response body was empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latestResponse: any = null;
  let completedResponse: any = null;
  let failedEvent: any = null;

  const consumeChunk = (chunk: string): void => {
    const parsed = parseBackendEvent(chunk);
    if (!parsed) return;

    const payload = parsed.data;
    if (payload?.response && typeof payload.response === 'object') {
      latestResponse = payload.response;
    }

    if (payload?.type === 'response.completed' && payload.response) {
      completedResponse = payload.response;
      return;
    }

    if (payload?.type === 'response.failed' || payload?.type === 'error') {
      failedEvent = payload;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || typeof match.index !== 'number') break;
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (rawEvent.trim()) {
          consumeChunk(rawEvent);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeChunk(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  if (failedEvent) {
    const responseStatus = typeof latestResponse?.status_code === 'number' ? latestResponse.status_code : 500;
    throw createRequestError(responseStatus, extractErrorDetail(failedEvent, responseStatus), failedEvent);
  }

  if (completedResponse) {
    return completedResponse;
  }

  if (latestResponse) {
    return latestResponse;
  }

  throw new Error('ChatGPT Codex backend stream ended before returning a response.');
}

async function fetchBackendResponse(
  request: Record<string, unknown>,
  opts?: { allowRefresh?: boolean; signal?: AbortSignal },
): Promise<any> {
  const token = await getUsableCodexAccessToken();
  const response = await fetch(CODEX_BACKEND_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(request),
    signal: opts?.signal,
  });

  if (!response.ok) {
    let data: any = null;
    try {
      const text = await response.text();
      if (!text) {
        data = null;
      } else {
        try {
          data = JSON.parse(text);
        } catch {
          data = { detail: text };
        }
      }
    } catch {
      data = null;
    }

    if (response.status === 401 && opts?.allowRefresh !== false) {
      await refreshCodexAccessToken();
      return fetchBackendResponse(request, { allowRefresh: false, signal: opts?.signal });
    }

    throw createRequestError(
      response.status,
      extractErrorDetail(data, response.status),
      data,
    );
  }

  return parseBackendResponseStream(response);
}

export async function hasCodexChatGPTAuth(): Promise<boolean> {
  const token = await getCodexAccessToken();
  if (token) {
    return true;
  }

  const client = getSharedCodexClient();
  if (!client.isRunning()) {
    return false;
  }

  try {
    const auth = await client.getAuthState();
    return isChatGPTAuthMode(auth.authMode);
  } catch {
    return false;
  }
}

export function clearCodexChatGPTSession(sessionId?: string): void {
  if (sessionId) {
    const active = sessionRequests.get(sessionId);
    if (active) {
      active.abort();
      sessionRequests.delete(sessionId);
    }
    return;
  }

  for (const controller of sessionRequests.values()) {
    controller.abort();
  }
  sessionRequests.clear();
}

export async function interruptCodexChatGPTTurn(sessionId: string): Promise<boolean> {
  const active = sessionRequests.get(sessionId);
  if (!active) {
    return false;
  }

  active.abort();
  sessionRequests.delete(sessionId);
  return true;
}

export function createCodexChatGPTClient(opts: CreateCodexChatGPTClientOptions = {}): CodexChatGPTClient {
  return {
    bindAgentSession: (_bindings: AgentSessionClientBindings) => {},
    responses: {
      create: async (params: any) => {
        const request = buildBackendRequest(params);
        const controller = new AbortController();

        if (opts.sessionId) {
          sessionRequests.set(opts.sessionId, controller);
        }

        try {
          return await fetchBackendResponse(request, { signal: controller.signal });
        } finally {
          if (opts.sessionId && sessionRequests.get(opts.sessionId) === controller) {
            sessionRequests.delete(opts.sessionId);
          }
        }
      },
      stream: async () => {
        throw new Error('Streaming response helpers are not implemented for ChatGPT-authenticated Codex backend sessions.');
      },
      retrieve: async () => {
        throw new Error('Response retrieval is not implemented for ChatGPT-authenticated Codex backend sessions.');
      },
      poll: async () => {
        throw new Error('Response polling is not implemented for ChatGPT-authenticated Codex backend sessions.');
      },
    },
  };
}
