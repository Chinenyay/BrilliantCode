export {};

import type { OpenAIResponseItem } from './chat';

declare global {
  interface Window {
    layout?: {
      setSplit?: (ratio: number) => void;
      setRightBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void;
      onMode?: (handler: (mode: 'split' | 'agent' | 'browser') => void) => () => void;
      notifyModeChange?: (mode: 'split' | 'agent' | 'browser') => void;
    };
    agent?: {
      setMode?: (mode: 'chat' | 'agent' | 'agent_full') => void;
    };
    auth?: {
      status: () => Promise<{ ok: boolean; authenticated: boolean; profile?: Record<string, unknown> | null; error?: string }>;
      login: () => Promise<{ ok: boolean; authenticated?: boolean; profile?: Record<string, unknown> | null; error?: string }>;
      logout: () => Promise<{ ok: boolean; authenticated?: boolean; profile?: Record<string, unknown> | null; error?: string }>;
      onStateChange?: (handler: (state: { authenticated: boolean; profile: Record<string, unknown> | null }) => void) => () => void;
    };
    apiKeys?: {
      status: () => Promise<{
        ok: boolean;
        status?: {
          openai: {
            configured: boolean;
            source: 'keytar' | 'env' | null;
          };
          openaiCompat: {
            configured: boolean;
            source: 'keytar' | 'env' | null;
            baseUrl: { configured: boolean; source: 'keytar' | 'env' | null; value?: string };
          };
          anthropic: { configured: boolean; source: 'keytar' | 'env' | null };
        };
        error?: string;
      }>;
      set: (provider: 'openai' | 'openai_compat' | 'anthropic', apiKey: string) => Promise<{ ok: boolean; error?: string }>;
      clear: (provider: 'openai' | 'openai_compat' | 'anthropic') => Promise<{ ok: boolean; error?: string }>;
      setCompatBaseUrl: (baseUrl: string) => Promise<{ ok: boolean; error?: string }>;
      clearCompatBaseUrl: () => Promise<{ ok: boolean; error?: string }>;
      showDialog?: () => void;
    };
    billing?: {
      status: () => Promise<{ ok: boolean; state?: {
        ok: boolean;
        checkedAt: number;
        authenticated: boolean;
        hasActiveSubscription: boolean;
        plan?: string;
        subscriptionStatus?: string;
        creditsTotal?: number;
        creditsUsed?: number;
        subscribeUrl?: string;
        error?: string;
      }; error?: string }>;
      refresh: () => Promise<{ ok: boolean; state?: {
        ok: boolean;
        checkedAt: number;
        authenticated: boolean;
        hasActiveSubscription: boolean;
        plan?: string;
        subscriptionStatus?: string;
        creditsTotal?: number;
        creditsUsed?: number;
        subscribeUrl?: string;
        error?: string;
      }; error?: string }>;
      openSubscribe: () => Promise<{ ok: boolean; url?: string; error?: string }>;
      pricing: () => Promise<{ ok: boolean; plans?: Array<{
        id?: string;
        name: string;
        price: number;
        currency: string;
        interval: string;
        description?: string;
        features: string[];
        cta_label?: string;
        cta_href?: string | null;
        badge?: string | null;
        highlight?: boolean;
        monthly_credits?: number | null;
        plan_type?: string;
      }>; showPricing?: boolean; error?: string }>;
      checkout: (plan: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
      onStateChange?: (handler: (state: {
        ok: boolean;
        checkedAt: number;
        authenticated: boolean;
        hasActiveSubscription: boolean;
        plan?: string;
        subscriptionStatus?: string;
        creditsTotal?: number;
        creditsUsed?: number;
        subscribeUrl?: string;
        error?: string;
      }) => void) => () => void;
    };
    ai: {
      pickImages: () => Promise<{ ok: boolean; canceled?: boolean; files?: { id?: string; name?: string; mime: string; base64: string }[]; error?: string }>;
      sessions: {
        list: () => Promise<{ ok: boolean; sessions?: any[]; error?: string }>;
        get: (sessionId: string) => Promise<{ ok: boolean; session?: any; error?: string }>;
        create: (opts?: { title?: string; model?: string }) => Promise<{ ok: boolean; session?: any; error?: string }>;
        delete: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        rename: (sessionId: string, title: string) => Promise<{ ok: boolean; session?: any; error?: string }>;
      };
      models: {
        list: () => Promise<{ ok: boolean; models?: any[]; error?: string }>;
        hidden: () => Promise<{ ok: boolean; models?: any[]; error?: string }>;
        add: (payload: { key: string; name?: string; provider?: 'openai' | 'openai_compat' | 'anthropic'; type?: string }) =>
          Promise<{ ok: boolean; models?: any[]; error?: string }>;
        remove: (key: string) => Promise<{ ok: boolean; models?: any[]; error?: string }>;
      };
      chatStream: (
        messages: OpenAIResponseItem[],
        options: Record<string, unknown> | undefined,
        onToken?: (delta: string) => void,
        onError?: (error: unknown) => void,
        onDone?: () => void,
        onToolEvent?: (type: 'start' | 'args' | 'exec' | 'result', payload: any) => void,
        onReasoningEvent?: (type: 'reset' | 'summary_delta' | 'summary_done' | 'text_delta' | 'text_done', payload?: any) => void,
        onConfirmEvent?: (payload: { kind: 'request' | 'resolved'; payload: any }) => void,
        onNoticeEvent?: (payload: any) => void,
        onMonitorEvent?: (payload: any) => void,
      ) => () => void;
      stop: (sessionId: string) => void;
      cancelTool: (sessionId: string, id: string) => void;
      confirmResponse: (payload: { sessionId: string; id: string; allow: boolean }) => void;
      session: {
        attach: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        detach: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        status: (sessionId: string) => Promise<{ ok: boolean; status?: any; error?: string }>;
      };
      onNotice?: (handler: (payload: any) => void) => () => void;
      onAgentMonitor?: (handler: (payload: any) => void) => () => void;
    };
    workspace: {
      get: () => Promise<{ ok: boolean; cwd?: string; persisted?: boolean }>;
      choose: () => Promise<{ ok: boolean; canceled?: boolean; cwd?: string }>;
      set: (cwd: string) => Promise<{ ok: boolean; cwd?: string }>;
      createProject: (payload: { name: string }) => Promise<{ ok: boolean; cwd?: string; error?: string }>;
      onChanged: (cb: (cwd: string) => void) => () => void;
    };
    viewer: {
      openFile: () => Promise<{ canceled: boolean; filePath?: string; error?: string }>;
      openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      openFileSpec: (payload: { file: string; line?: number; col?: number; baseDir?: string }) =>
        Promise<{ canceled?: boolean; ok?: boolean; filePath?: string; error?: string }>;
    };
    preview?: {
      open: (url: string, opts?: { focus?: boolean; tabId?: string; openNewTab?: boolean }) => Promise<{ ok: boolean; tab?: { id: string; title: string; url: string }; error?: string }>;
    };
    pty?: {
      onData: (
        cbOrTerminal: string | ((data: string, terminalId: string) => void),
        cb?: (data: string, terminalId: string) => void,
      ) => (() => void) | void;
      write: (data: string, terminalId?: string) => void;
      resize: (cols: number, rows: number, terminalId?: string) => void;
      cwdChanged?: (cwd: string, terminalId?: string) => void;
      list?: () => Promise<{ ok: boolean; terminals?: { id: string; cwd: string; cols: number; rows: number }[]; error?: string }>;
      read?: (terminalId?: string, opts?: { bytes?: number }) => Promise<{ ok: boolean; text?: string; terminalId?: string; error?: string }>;
      create?: (opts?: { cwd?: string; cols?: number; rows?: number }) => Promise<{ ok: boolean; terminalId?: string; cwd?: string; error?: string }>;
      dispose?: (terminalId: string) => Promise<{ ok: boolean; error?: string }>;
      onCreated?: (handler: (payload: { terminalId: string; cwd?: string }) => void) => () => void;
      onClosed?: (handler: (payload: { terminalId: string; code?: number; signal?: number }) => void) => () => void;
    };
    files?: {
      list: (payload?: { dir?: string }) => Promise<{ ok: boolean; entries?: { name: string; type: 'dir' | 'file' }[]; path?: string; root?: string; error?: string }>;
      read: (payload: { path: string }) => Promise<{ ok: boolean; content?: string; encoding?: string; isBinary?: boolean; error?: string }>;
      openExternal: (payload: { path: string }) => Promise<{ ok: boolean; error?: string }>;
      create: (payload: { path: string; content?: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
      delete: (payload: { path: string }) => Promise<{ ok: boolean; error?: string }>;
      createDir: (payload: { path: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
      rename: (payload: { from: string; to: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
      write: (payload: { path: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
    };
    todos?: {
      reset: (sessionId: string) => Promise<{ message: string; todos: Record<number, { status: string; content: string }>; count: number }>;
    };
    child?: {
      onShowCode?: (cb: (payload: { path: string; content: string }) => void) => void;
      onSetPreviewUrl?: (cb: (payload: { url: string; focus?: boolean }) => void) => void;
      onPreviewCommand?: (cb: (payload: any) => void) => void;
      emitPreviewCommandResult?: (payload: any) => void;
    };
    appVersion?: {
      check: () => Promise<{
        ok: boolean;
        updateAvailable?: boolean;
        currentVersion?: string;
        latestVersion?: string;
        message?: string;
        downloadLink?: string;
        error?: string;
      }>;
      getCurrent: () => Promise<{ ok: boolean; version?: string; error?: string }>;
      openDownload: (url: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}
