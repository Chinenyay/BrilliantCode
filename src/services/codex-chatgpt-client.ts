import { createHash } from 'node:crypto';
import {
  getSharedCodexClient,
  type CodexAppServerClient,
  type CodexThreadItem,
  type CodexTurn,
} from './codex-app-server.js';

type CreateCodexChatGPTClientOptions = {
  sessionId?: string;
  workingDir: string;
  model: string;
  autoMode: boolean;
};

type SessionThreadState = {
  threadId: string;
  workingDir: string;
  model: string;
};

type SessionTurnState = {
  threadId: string;
  turnId: string;
};

const sessionThreads = new Map<string, SessionThreadState>();
const sessionTurns = new Map<string, SessionTurnState>();
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const HISTORY_CONTEXT_LIMIT = 16_000;

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function trimText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const omitted = value.length - limit;
  return `${value.slice(0, limit)}\n... (truncated ${omitted} characters)`;
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
      continue;
    }

    if ((type === 'input_image' || type === 'image') && typeof record.image_url === 'string') {
      parts.push('[image]');
    }
  }

  return parts.join('\n').trim();
}

function normalizeUserContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'text', text, text_elements: [] }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';

    if (type === 'input_text' && typeof record.text === 'string' && record.text.trim()) {
      out.push({
        type: 'text',
        text: record.text.trim(),
        text_elements: [],
      });
      continue;
    }

    if (type === 'input_image' && typeof record.image_url === 'string' && record.image_url.trim()) {
      out.push({
        type: 'image',
        url: record.image_url.trim(),
      });
    }
  }

  return out;
}

function extractDeveloperInstructions(input: unknown): string {
  if (!Array.isArray(input)) return '';

  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.role !== 'developer') continue;
    const text = extractText(record.content);
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

function findLastUserMessage(input: unknown): { index: number; item: Record<string, unknown> | null } {
  if (!Array.isArray(input)) {
    return { index: -1, item: null };
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const entry = input[index];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.role === 'user') {
      return { index, item: record };
    }
  }

  return { index: -1, item: null };
}

function buildHistoricalContext(input: unknown, lastUserIndex: number): string {
  if (!Array.isArray(input) || lastUserIndex <= 0) {
    return '';
  }

  const lines: string[] = [];
  for (let index = 0; index < lastUserIndex; index += 1) {
    const entry = input[index];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    if (record.role === 'developer') continue;

    if (record.role === 'user') {
      const text = extractText(record.content);
      if (text) lines.push(`User: ${text}`);
      continue;
    }

    if (record.role === 'assistant') {
      const text = extractText(record.content);
      if (text) lines.push(`Assistant: ${text}`);
      continue;
    }

    if (record.type === 'function_call_output') {
      const text = typeof record.output === 'string'
        ? record.output.trim()
        : '';
      if (text) lines.push(`Tool result: ${text}`);
    }
  }

  const transcript = lines.join('\n').trim();
  return transcript ? trimText(transcript, HISTORY_CONTEXT_LIMIT) : '';
}

function buildTurnInput(params: any, reuseExistingThread: boolean): Array<Record<string, unknown>> {
  const { index, item } = findLastUserMessage(params?.input);
  if (!item) {
    throw new Error('No user message found for Codex app-server turn.');
  }

  const current = normalizeUserContent(item.content);
  if (reuseExistingThread) {
    return current.length ? current : [{ type: 'text', text: '', text_elements: [] }];
  }

  const historicalContext = buildHistoricalContext(params?.input, index);
  if (!historicalContext) {
    return current.length ? current : [{ type: 'text', text: '', text_elements: [] }];
  }

  return [
    {
      type: 'text',
      text: [
        'Conversation context from the existing BrilliantCode session:',
        historicalContext,
        '',
        'Continue from that context and answer the latest user request below.',
      ].join('\n'),
      text_elements: [],
    },
    ...(current.length ? current : [{ type: 'text', text: '', text_elements: [] }]),
  ];
}

function buildResponseFromTurn(turn: CodexTurn): any {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const output: any[] = [];
  const outputTextParts: string[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as CodexThreadItem;

    if (typedItem.type === 'reasoning') {
      const summary = Array.isArray(typedItem.summary)
        ? typedItem.summary
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .map((text) => ({ text }))
        : [];

      if (summary.length) {
        output.push({
          type: 'reasoning',
          summary,
        });
      }
      continue;
    }

    if (typedItem.type === 'agentMessage' && typeof typedItem.text === 'string' && typedItem.text.trim()) {
      const text = typedItem.text.trim();
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      });
      outputTextParts.push(text);
    }
  }

  return {
    id: `codex-${turn.id}`,
    status: 'completed',
    output,
    output_text: outputTextParts.join('\n\n'),
  };
}

async function ensureClientStarted(client: CodexAppServerClient): Promise<void> {
  if (!client.isRunning()) {
    await client.start();
  }
}

async function ensureThread(
  client: CodexAppServerClient,
  opts: CreateCodexChatGPTClientOptions,
  params: any,
): Promise<{ threadId: string; reused: boolean }> {
  if (opts.sessionId) {
    const existing = sessionThreads.get(opts.sessionId);
    if (existing && existing.model === opts.model && existing.workingDir === opts.workingDir) {
      return { threadId: existing.threadId, reused: true };
    }
  }

  const developerInstructions = extractDeveloperInstructions(params?.input);
  const result = await client.startThread({
    model: opts.model,
    modelProvider: 'openai',
    cwd: opts.workingDir,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    developerInstructions: developerInstructions || null,
    experimentalRawEvents: false,
  });

  const threadId = result.thread?.id;
  if (!threadId) {
    throw new Error('Codex app-server did not return a thread id.');
  }

  if (opts.sessionId) {
    sessionThreads.set(opts.sessionId, {
      threadId,
      workingDir: opts.workingDir,
      model: opts.model,
    });
  }

  return { threadId, reused: false };
}

function createTurnWatcher(client: CodexAppServerClient, threadId: string): {
  waitForTurn: (turnId: string) => Promise<CodexTurn>;
  dispose: () => void;
} {
  const completedTurns = new Map<string, CodexTurn>();
  const turnItems = new Map<string, CodexThreadItem[]>();
  const waiters = new Map<string, { resolve: (turn: CodexTurn) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const resolveTurn = (turn: CodexTurn): void => {
    const mergedTurn: CodexTurn = {
      ...turn,
      items: turnItems.get(turn.id) ?? turn.items ?? [],
    };
    completedTurns.set(turn.id, mergedTurn);
    const waiter = waiters.get(turn.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(turn.id);
    waiter.resolve(mergedTurn);
  };

  const onNotification = (event: any) => {
    const method = typeof event?.method === 'string' ? event.method : '';
    const params = event?.params;
    if (!params || params.threadId !== threadId) {
      return;
    }

    if (method === 'item/completed' && typeof params.turnId === 'string' && params.item) {
      const existing = turnItems.get(params.turnId) ?? [];
      existing.push(params.item as CodexThreadItem);
      turnItems.set(params.turnId, existing);
      return;
    }

    if (method === 'turn/completed' && params.turn && typeof params.turn.id === 'string') {
      resolveTurn(params.turn as CodexTurn);
    }
  };

  client.on('notification', onNotification);

  return {
    waitForTurn: (turnId: string) => {
      const completed = completedTurns.get(turnId);
      if (completed) {
        return Promise.resolve(completed);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(turnId);
          reject(new Error(`Timed out waiting for Codex turn ${turnId} to complete.`));
        }, TURN_TIMEOUT_MS);
        waiters.set(turnId, { resolve, reject, timer });
      });
    },
    dispose: () => {
      client.removeListener('notification', onNotification);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Codex turn watcher disposed before completion.'));
      }
      waiters.clear();
    },
  };
}

export async function hasCodexChatGPTAuth(): Promise<boolean> {
  const client = getSharedCodexClient();
  await ensureClientStarted(client);
  const auth = await client.getAuthState();
  return auth.authMode === 'chatgpt' || auth.authMode === 'chatgptAuthTokens';
}

export function clearCodexChatGPTSession(sessionId?: string): void {
  if (sessionId) {
    sessionThreads.delete(sessionId);
    sessionTurns.delete(sessionId);
    return;
  }

  sessionThreads.clear();
  sessionTurns.clear();
}

export async function interruptCodexChatGPTTurn(sessionId: string): Promise<boolean> {
  const activeTurn = sessionTurns.get(sessionId);
  if (!activeTurn) {
    return false;
  }

  const client = getSharedCodexClient();
  await ensureClientStarted(client);
  await client.interruptTurn(activeTurn);
  sessionTurns.delete(sessionId);
  return true;
}

export function createCodexChatGPTClient(opts: CreateCodexChatGPTClientOptions): {
  responses: {
    create: (params: any) => Promise<any>;
  };
} {
  const sessionKey = opts.sessionId
    ? stableHash(`${opts.sessionId}:${opts.workingDir}:${opts.model}`)
    : null;

  return {
    responses: {
      create: async (params: any) => {
        if (!opts.autoMode) {
          throw new Error('ChatGPT sign-in currently requires Auto mode. Codex app-server approval requests are not wired into BrilliantCode yet.');
        }

        const client = getSharedCodexClient();
        await ensureClientStarted(client);

        const { threadId, reused } = await ensureThread(client, opts, params);
        const input = buildTurnInput(params, reused);
        const watcher = createTurnWatcher(client, threadId);
        const turnResult = await client.startTurn({
          threadId,
          input,
          cwd: opts.workingDir,
          model: opts.model,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
          effort: params?.reasoning?.effort ?? 'medium',
          summary: 'auto',
        });

        const turnId = turnResult.turn?.id;
        if (!turnId) {
          throw new Error('Codex app-server did not return a turn id.');
        }

        if (opts.sessionId) {
          sessionTurns.set(opts.sessionId, { threadId, turnId });
        }

        try {
          const turn = turnResult.turn?.status === 'completed'
            ? turnResult.turn
            : await watcher.waitForTurn(turnId);

          const response = buildResponseFromTurn(turn);
          if (sessionKey) {
            response.id = `${response.id}-${sessionKey.slice(0, 8)}`;
          }
          return response;
        } finally {
          watcher.dispose();
          if (opts.sessionId) {
            sessionTurns.delete(opts.sessionId);
          }
        }
      },
    },
  };
}
