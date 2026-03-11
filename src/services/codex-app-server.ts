import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export type CodexAuthMode = 'none' | 'apikey' | 'chatgpt' | 'chatgptAuthTokens';

export interface CodexAccount {
  type: Exclude<CodexAuthMode, 'none'>;
  email?: string;
  id?: string;
  planType?: string;
}

export interface CodexAuthState {
  account?: CodexAccount | null;
  authMode: CodexAuthMode;
  requiresOpenaiAuth?: boolean;
}

export interface CodexLoginStartResult {
  loginId: string;
  authUrl: string;
}

export interface CodexLoginCompletedEvent {
  loginId: string;
  success: boolean;
  error?: string;
}

export interface CodexAccountUpdatedEvent {
  authMode: Exclude<CodexAuthMode, 'none'> | null;
  account?: CodexAccount;
}

export interface CodexThreadItem {
  type: string;
  [key: string]: any;
}

export interface CodexTurnError {
  message: string;
  additionalDetails?: string | null;
  codexErrorInfo?: Record<string, unknown> | null;
}

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress' | string;
  items?: CodexThreadItem[];
  error?: CodexTurnError | null;
}

export interface CodexThread {
  id: string;
  cwd?: string;
  modelProvider?: string;
  turns?: CodexTurn[];
  [key: string]: any;
}

export interface CodexThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: 'none' | 'friendly' | 'pragmatic' | null;
  ephemeral?: boolean | null;
  experimentalRawEvents?: boolean;
}

export interface CodexThreadStartResult {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  cwd: string;
}

export interface CodexThreadReadResult {
  thread: CodexThread;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: Array<Record<string, unknown>>;
  cwd?: string | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
  sandboxPolicy?: Record<string, unknown> | null;
  model?: string | null;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  summary?: 'auto' | 'concise' | 'detailed' | 'none' | null;
  personality?: 'none' | 'friendly' | 'pragmatic' | null;
  outputSchema?: Record<string, unknown> | null;
  collaborationMode?: string | null;
}

export interface CodexTurnStartResult {
  turn: CodexTurn;
}

export type CodexJsonRpcId = string | number;

export interface CodexServerRequest {
  jsonrpc?: '2.0';
  method: string;
  id: CodexJsonRpcId;
  params?: any;
}

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  method: string;
  id?: CodexJsonRpcId;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: CodexJsonRpcId;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: any;
}

function toCodexProcessError(error: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error ?? 'Unknown Codex app-server error'));
  const code = (base as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new Error('Codex CLI is not installed or is not on PATH. Install Codex to use ChatGPT sign-in, or continue with an OpenAI API key.');
  }
  return base;
}

/**
 * Client for communicating with the Codex app-server.
 * Implements the official Codex app-server protocol for authentication and session management.
 */
export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private initialized = false;

  /**
   * Start the Codex app-server subprocess and initialize the connection.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Codex app-server is already running');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        this.process = spawn('codex', ['app-server'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stdin) {
          throw new Error('Failed to create Codex app-server stdio streams');
        }

        this.rl = readline.createInterface({ input: this.process.stdout });

        this.rl.on('line', (line) => {
          try {
            this.handleMessage(JSON.parse(line));
          } catch (err) {
            console.error('[codex-app-server] Failed to parse message:', line, err);
          }
        });

        this.process.on('error', (err) => {
          const wrapped = toCodexProcessError(err);
          if (this.listenerCount('error') > 0) {
            this.emit('error', wrapped);
          } else {
            console.error('[codex-app-server] Process error:', wrapped);
          }
          if (!this.initialized) {
            settleReject(wrapped);
          }
        });

        this.process.on('exit', (code, signal) => {
          this.cleanup();
          this.emit('exit', { code, signal });
        });

        // Listen for stderr for debugging
        if (this.process.stderr) {
          this.process.stderr.on('data', (data) => {
            console.error('[codex-app-server stderr]:', data.toString());
          });
        }

        // Initialize the connection
        this.initialize()
          .then(() => {
            this.initialized = true;
            settleResolve();
          })
          .catch((error) => settleReject(toCodexProcessError(error)));
      } catch (err) {
        settleReject(toCodexProcessError(err));
      }
    });
  }

  /**
   * Stop the Codex app-server subprocess.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    // Try graceful shutdown first
    try {
      await this.request('shutdown', {});
    } catch {
      // Ignore errors during shutdown request
    }

    this.cleanup();
  }

  /**
   * Check if the app-server is running.
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get current authentication state.
   */
  async getAuthState(options?: { refreshToken?: boolean }): Promise<CodexAuthState> {
    const result = await this.request('account/read', { refreshToken: options?.refreshToken ?? false });
    return {
      account: result.account,
      authMode: result.account?.type ?? 'none',
      requiresOpenaiAuth: result.requiresOpenaiAuth === true,
    };
  }

  /**
   * Start the ChatGPT login flow.
   * Returns an authUrl that should be opened in a browser.
   * Listen for 'login:completed' and 'account:updated' events for completion.
   */
  async startChatGPTLogin(): Promise<CodexLoginStartResult> {
    const result = await this.request('account/login/start', { type: 'chatgpt' });
    return {
      loginId: result.loginId,
      authUrl: result.authUrl,
    };
  }

  /**
   * Log out from the current session.
   */
  async logout(): Promise<void> {
    await this.request('account/logout');
  }

  async startThread(params: CodexThreadStartParams): Promise<CodexThreadStartResult> {
    return await this.request('thread/start', {
      experimentalRawEvents: false,
      ...params,
    });
  }

  async readThread(params: { threadId: string; includeTurns: boolean }): Promise<CodexThreadReadResult> {
    return await this.request('thread/read', params);
  }

  async startTurn(params: CodexTurnStartParams): Promise<CodexTurnStartResult> {
    return await this.request('turn/start', params);
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<void> {
    await this.request('turn/interrupt', params);
  }

  respond(id: CodexJsonRpcId, result?: any): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result: result ?? {},
    } as JsonRpcResponse as JsonRpcRequest);
  }

  respondError(id: CodexJsonRpcId, error: { code?: number; message: string; data?: any }): void {
    if (!this.process?.stdin) {
      throw new Error('Codex app-server is not running');
    }

    const payload: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code: typeof error.code === 'number' ? error.code : -32000,
        message: error.message || 'Unknown Codex app-server request error',
        data: error.data,
      },
    };

    this.process.stdin.write(JSON.stringify(payload) + '\n');
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'brilliantcode',
        title: 'BrilliantCode',
        version: '1.0.0',
      },
    });

    this.send({
      method: 'initialized',
      params: {},
    });
  }

  private send(msg: JsonRpcRequest): void {
    if (!this.process?.stdin) {
      throw new Error('Codex app-server is not running');
    }

    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async request<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });

      this.send({
        jsonrpc: '2.0',
        method,
        id,
        params,
      });
    });
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification | CodexServerRequest): void {
    // Handle response to a request
    if ('id' in msg && typeof msg.id === 'number' && this.pending.has(msg.id) && !('method' in msg && msg.method)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)!;
      const response = msg as JsonRpcResponse;
      clearTimeout(timer);
      this.pending.delete(msg.id);

      if (response.error) {
        reject(new Error(response.error.message ?? 'Unknown error'));
      } else {
        resolve(response.result);
      }
      return;
    }

    // Handle notifications
    if ('method' in msg && msg.method) {
      if ('id' in msg && typeof msg.id !== 'undefined') {
        this.handleServerRequest(msg as CodexServerRequest);
        return;
      }
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleServerRequest(request: CodexServerRequest): void {
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      this.respondError(request.id, {
        code: -32601,
        message: 'ChatGPT auth token refresh is not implemented by BrilliantCode.',
      });
      return;
    }

    if (this.listenerCount('request') === 0) {
      this.respondError(request.id, {
        code: -32601,
        message: `Unhandled Codex app-server request: ${request.method}`,
      });
      return;
    }

    this.emit('request', request);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    switch (method) {
      case 'account/login/completed':
        this.emit('login:completed', params as CodexLoginCompletedEvent);
        break;

      case 'account/updated':
        this.emit('account:updated', params as CodexAccountUpdatedEvent);
        break;

      default:
        // Emit unknown notifications for debugging
        this.emit('notification', { method, params });
        break;
    }
  }

  private cleanup(): void {
    // Clear all pending requests
    for (const [id, { reject }] of this.pending.entries()) {
      try {
        clearTimeout(this.pending.get(id)?.timer);
      } catch {}
      reject(new Error('Codex app-server process terminated'));
    }
    this.pending.clear();

    // Close readline interface
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    // Kill process if still running
    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.process = null;
    this.initialized = false;
  }
}

// Singleton instance for the main process
let sharedClient: CodexAppServerClient | null = null;

/**
 * Get or create the shared Codex app-server client instance.
 */
export function getSharedCodexClient(): CodexAppServerClient {
  if (!sharedClient) {
    sharedClient = new CodexAppServerClient();
  }
  return sharedClient;
}

/**
 * Stop and clean up the shared Codex app-server client.
 */
export async function stopSharedCodexClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.stop();
    sharedClient = null;
  }
}
