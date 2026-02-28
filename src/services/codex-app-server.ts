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

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  method: string;
  id?: number;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: any;
}

/**
 * Client for communicating with the Codex app-server.
 * Implements the official Codex app-server protocol for authentication and session management.
 */
export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private initialized = false;

  /**
   * Start the Codex app-server subprocess and initialize the connection.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Codex app-server is already running');
    }

    return new Promise((resolve, reject) => {
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
          this.emit('error', err);
          if (!this.initialized) {
            reject(new Error(`Failed to start Codex app-server: ${err.message}`));
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
            resolve();
          })
          .catch(reject);
      } catch (err) {
        reject(err);
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
      this.pending.set(id, { resolve, reject });

      this.send({
        jsonrpc: '2.0',
        method,
        id,
        params,
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // Handle response to a request
    if ('id' in msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message ?? 'Unknown error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Handle notifications
    if ('method' in msg && msg.method) {
      this.handleNotification(msg as JsonRpcNotification);
    }
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
