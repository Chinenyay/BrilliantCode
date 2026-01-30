import { contextBridge, ipcRenderer } from 'electron';
import type { OpenAIResponseItem } from '../types/chat.js';

// Preload script exposes a tightly scoped surface area to the renderer. Every
// method below maps to an IPC channel in main.ts so the UI can remain in an
// isolated context without direct `ipcRenderer` access.

contextBridge.exposeInMainWorld('pty', {
  onData: (
    identifierOrCb: string | ((data: string, terminalId: string) => void),
    maybeCb?: (data: string, terminalId: string) => void,
  ): (() => void) | void => {
    let terminalId = 'default';
    let cb: ((data: string, terminalId: string) => void) | undefined;
    if (typeof identifierOrCb === 'string' && typeof maybeCb === 'function') {
      terminalId = identifierOrCb.trim() || 'default';
      cb = maybeCb;
    } else if (typeof identifierOrCb === 'function') {
      cb = identifierOrCb;
    }
    if (!cb) return;
    const listener = (_e: Electron.IpcRendererEvent, payload: any) => {
      let incomingId = 'default';
      let data: string | undefined;
      if (typeof payload === 'object' && payload !== null) {
        if (typeof payload.terminalId === 'string' && payload.terminalId.trim()) {
          incomingId = payload.terminalId.trim();
        }
        if (typeof payload.data === 'string') {
          data = payload.data;
        }
      } else if (typeof payload === 'string') {
        data = payload;
      }
      if (terminalId !== '*' && incomingId !== terminalId) return;
      if (typeof data !== 'string') return;
      try { cb(data, incomingId); } catch {}
    };
    ipcRenderer.on('terminal:data', listener);
    return () => { ipcRenderer.removeListener('terminal:data', listener); };
  },
  write: (data: string, terminalId = 'default'): void => {
    if (!data) return;
    ipcRenderer.send('terminal:write', { terminalId, data });
  },
  resize: (cols: number, rows: number, terminalId = 'default'): void => {
    ipcRenderer.send('terminal:resize', { terminalId, cols, rows });
  },
  // Notify main process when the terminal's cwd changes (parsed from OSC 7)
  cwdChanged: (cwd: string, terminalId = 'default'): void => {
    if (!cwd) return;
    ipcRenderer.send('terminal:cwdChanged', { terminalId, cwd });
  },
  list: (): Promise<{ ok: boolean; terminals?: { id: string; cwd: string; cols: number; rows: number }[]; error?: string }> =>
    ipcRenderer.invoke('terminal:list'),
  read: (terminalId?: string, opts?: { bytes?: number }): Promise<{ ok: boolean; text?: string; terminalId?: string; error?: string }> =>
    ipcRenderer.invoke('terminal:read', { terminalId, bytes: opts?.bytes }),
  create: (opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{ ok: boolean; terminalId?: string; cwd?: string; error?: string }> =>
    ipcRenderer.invoke('terminal:create', opts || {}),
  dispose: (terminalId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:dispose', { terminalId }),
  onCreated: (handler: (payload: { terminalId: string; cwd?: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => {
      if (!payload || typeof payload.terminalId !== 'string') return;
      try { handler(payload); } catch {}
    };
    ipcRenderer.on('terminal:created', listener);
    return () => { ipcRenderer.removeListener('terminal:created', listener); };
  },
  onClosed: (handler: (payload: { terminalId: string; code?: number; signal?: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => {
      if (!payload || typeof payload.terminalId !== 'string') return;
      try { handler(payload); } catch {}
    };
    ipcRenderer.on('terminal:closed', listener);
    return () => { ipcRenderer.removeListener('terminal:closed', listener); };
  },
});

contextBridge.exposeInMainWorld('apiKeys', {
  status: (): Promise<{ ok: boolean; status?: { openai: { configured: boolean; source: 'keytar' | 'env' | null; baseUrl: { configured: boolean; source: 'keytar' | 'env' | null; value?: string } }; anthropic: { configured: boolean; source: 'keytar' | 'env' | null } }; error?: string }> =>
    ipcRenderer.invoke('api-keys:status'),
  set: (provider: 'openai' | 'anthropic', apiKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('api-keys:set', { provider, apiKey }),
  clear: (provider: 'openai' | 'anthropic'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('api-keys:clear', { provider }),
  setBaseUrl: (baseUrl: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('api-keys:set-base-url', { baseUrl }),
  clearBaseUrl: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('api-keys:clear-base-url'),
  showDialog: (): void => ipcRenderer.send('api-keys:show-dialog'),
});

contextBridge.exposeInMainWorld('layout', {
  setSplit: (ratio: number): void => ipcRenderer.send('layout:set-split', ratio),
  setRightBounds: (bounds: { x: number; y: number; width: number; height: number }): void =>
    ipcRenderer.send('layout:set-right-bounds', bounds),
  onMode: (handler: (mode: 'split' | 'agent' | 'browser') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => {
      const mode = typeof payload === 'string' ? payload : payload?.mode;
      if (mode === 'split' || mode === 'agent' || mode === 'browser') {
        try { handler(mode); } catch {}
      }
    };
    ipcRenderer.on('layout:set-mode', listener);
    return () => ipcRenderer.removeListener('layout:set-mode', listener);
  },
  notifyModeChange: (mode: 'split' | 'agent' | 'browser'): void => {
    ipcRenderer.send('layout:modeChanged', mode);
  },
  setTheme: (theme: 'dark' | 'light'): void => {
    ipcRenderer.send('layout:setTheme', theme);
  },
  onTheme: (handler: (theme: 'dark' | 'light') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'dark' | 'light') => {
      if (theme === 'dark' || theme === 'light') {
        try { handler(theme); } catch {}
      }
    };
    ipcRenderer.on('layout:theme-changed', listener);
    return () => ipcRenderer.removeListener('layout:theme-changed', listener);
  }
});

contextBridge.exposeInMainWorld('agent', {
  setMode: (mode: 'chat' | 'agent' | 'agent_full'): void => {
    if (mode === 'chat' || mode === 'agent' || mode === 'agent_full') {
      ipcRenderer.send('agent:modeChanged', mode);
    }
  },
});

// Expose viewer API to select a local file and preview it in the right pane
contextBridge.exposeInMainWorld('viewer', {
  openFile: (): Promise<{ canceled: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('viewer:open-file'),
  openPath: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('viewer:open-path', filePath),
  readFileBase64: (payload: { path: string }): Promise<{ ok: boolean; mime?: string; base64?: string; path?: string; error?: string }> =>
    ipcRenderer.invoke('viewer:read-file-base64', payload),
  showText: (payload: { title: string; content: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('viewer:show-text', payload),
  openFileSpec: (payload: { file: string; line?: number; col?: number; baseDir?: string }): Promise<{ canceled?: boolean; ok?: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('viewer:open-file-spec', payload)
});

contextBridge.exposeInMainWorld('preview', {
  open: (url: string, opts?: { focus?: boolean; tabId?: string; openNewTab?: boolean }): Promise<{ ok: boolean; tab?: { id: string; title: string; url: string }; error?: string }> =>
    ipcRenderer.invoke('preview:open-url', { url, focus: opts?.focus, tabId: opts?.tabId, openNewTab: opts?.openNewTab }),
});

// Workspace selection + persistence
contextBridge.exposeInMainWorld('workspace', {
  get: (): Promise<{ ok: boolean; cwd?: string; persisted?: boolean }> => ipcRenderer.invoke('workspace:get'),
  choose: (): Promise<{ ok: boolean; canceled?: boolean; cwd?: string }> => ipcRenderer.invoke('workspace:choose'),
  set: (cwd: string): Promise<{ ok: boolean; cwd?: string }> => ipcRenderer.invoke('workspace:set', cwd),
  pickFolder: (): Promise<{ ok: boolean; canceled?: boolean; path?: string }> => ipcRenderer.invoke('workspace:pickFolder'),
  createProject: (payload: { name: string }): Promise<{ ok: boolean; cwd?: string; error?: string }> =>
    ipcRenderer.invoke('workspace:create-project', payload),
  captureBaseline: (payload: { sessionId: string; runId: string }): Promise<{ ok: boolean; created?: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:baseline:capture', payload),
  changes: (payload?: { sessionId?: string; runId?: string; limit?: number; offset?: number }): Promise<{
    ok: boolean;
    git?: boolean;
    files?: { path: string; status: string; additions?: number | null; deletions?: number | null }[];
    totals?: { files: number; additions: number; deletions: number };
    fingerprint?: string;
    page?: { offset: number; limit: number; hasMore: boolean };
    error?: string;
  }> => ipcRenderer.invoke('workspace:changes', payload),
  diff: (payload: { path?: string; sessionId?: string; runId?: string }): Promise<{ ok: boolean; diff?: string; error?: string }> =>
    ipcRenderer.invoke('workspace:diff', payload),
  undoFile: (payload: { path: string; sessionId?: string; runId?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:undo-file', payload),
  undoAll: (payload?: { sessionId?: string; runId?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:undo-all', payload),
  onChanged: (cb: (cwd: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cwd: string) => cb(cwd);
    ipcRenderer.on('workspace:changed', handler);
    return () => ipcRenderer.removeListener('workspace:changed', handler);
  }
});

// File system helpers for child view browser/editor
contextBridge.exposeInMainWorld('files', {
  list: (payload: { dir?: string } = {}): Promise<{ ok: boolean; entries?: any[]; path?: string; root?: string; error?: string }> =>
    ipcRenderer.invoke('child:list-files', payload),
  read: (payload: { path: string }): Promise<{ ok: boolean; content?: string; encoding?: string; isBinary?: boolean; error?: string }> =>
    ipcRenderer.invoke('child:read-file', payload),
  openExternal: (payload: { path: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('child:open-external', payload),
  create: (payload: { path: string; content?: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('child:create-file', payload),
  delete: (payload: { path: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('child:delete-path', payload),
  createDir: (payload: { path: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('child:create-directory', payload),
  rename: (payload: { from: string; to: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('child:rename-path', payload),
  write: (payload: { path: string; content: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('child:write-file', payload)
});

// Child view control events (from main process)
contextBridge.exposeInMainWorld('child', {
  onShowCode: (cb: (payload: { path: string; content: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { path: string; content: string }) => cb(payload);
    ipcRenderer.on('child:show-code', handler);
    return () => ipcRenderer.removeListener('child:show-code', handler);
  },
  onSetPreviewUrl: (cb: (payload: { url: string; focus?: boolean }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { url: string; focus?: boolean }) => cb(payload);
    ipcRenderer.on('child:set-url', handler);
    return () => ipcRenderer.removeListener('child:set-url', handler);
  },
  onPreviewCommand: (cb: (payload: any) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on('preview:command', handler);
    return () => ipcRenderer.removeListener('preview:command', handler);
  },
  emitPreviewCommandResult: (payload: any): void => {
    ipcRenderer.send('preview:command:result', payload);
  },
  // Switch active tab in child view (terminal, preview, code)
  switchTab: (tab: 'terminal' | 'preview' | 'code'): void => {
    ipcRenderer.send('child:switch-tab', { tab });
  },
  onSwitchTab: (cb: (payload: { tab: 'terminal' | 'preview' | 'code' }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { tab: 'terminal' | 'preview' | 'code' }) => cb(payload);
    ipcRenderer.on('child:switch-tab', handler);
    return () => ipcRenderer.removeListener('child:switch-tab', handler);
  }
});

// Expose AI inference API

// AI streaming bridge: the renderer hands us callbacks and we subscribe to the
// relevant IPC events. Cleanup ensures we release listeners once the stream
// finishes or errors out.
contextBridge.exposeInMainWorld("ai", {
  pickImages: (): Promise<{ ok: boolean; canceled?: boolean; files?: { id?: string; name?: string; path?: string; mime: string; base64: string }[]; error?: string }> =>
    ipcRenderer.invoke('ai:pick-images'),
  sessions: {
    list: (): Promise<{ ok: boolean; sessions?: any[]; error?: string }> => ipcRenderer.invoke('ai:sessions:list'),
    get: (sessionId: string): Promise<{ ok: boolean; session?: any; error?: string }> => ipcRenderer.invoke('ai:sessions:get', sessionId),
    create: (opts?: { title?: string; model?: string }): Promise<{ ok: boolean; session?: any; error?: string }> => ipcRenderer.invoke('ai:sessions:create', opts),
    delete: (sessionId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:sessions:delete', sessionId),
    rename: (sessionId: string, title: string): Promise<{ ok: boolean; session?: any; error?: string }> =>
      ipcRenderer.invoke('ai:sessions:rename', { sessionId, title }),
    setAdditionalWorkingDir: (sessionId: string, additionalWorkingDir: string | undefined): Promise<{ ok: boolean; session?: any; error?: string }> =>
      ipcRenderer.invoke('ai:sessions:setAdditionalWorkingDir', { sessionId, additionalWorkingDir }),
    setWorkspaceChanges: (sessionId: string, workspaceChanges: any | undefined): Promise<{ ok: boolean; session?: any; error?: string }> =>
      ipcRenderer.invoke('ai:sessions:setWorkspaceChanges', { sessionId, workspaceChanges }),
    setActive: (sessionId: string | undefined): Promise<{ ok: boolean; additionalWorkingDir?: string | null; error?: string }> =>
      ipcRenderer.invoke('ai:sessions:setActive', { sessionId }),
  },
  models: {
    list: (): Promise<{ ok: boolean; models?: any[]; error?: string }> => ipcRenderer.invoke('ai:models:list'),
    add: (payload: { key: string; name?: string; provider?: 'openai' | 'anthropic'; type?: string }): Promise<{ ok: boolean; models?: any[]; error?: string }> =>
      ipcRenderer.invoke('ai:models:add', payload),
    remove: (key: string): Promise<{ ok: boolean; models?: any[]; error?: string }> =>
      ipcRenderer.invoke('ai:models:remove', { key }),
  },
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
  ): () => void => {
    const targetSessionId = typeof options?.sessionId === 'string' ? String(options.sessionId) : undefined;
    const targetRunId = typeof options?.runId === 'string' ? String(options.runId) : undefined;

    const parseEnvelope = <T = any>(incoming: any): { sessionId?: string; runId?: string; payload: T } => {
      if (incoming && typeof incoming === 'object' && incoming !== null) {
        const rawSession = typeof (incoming as any).sessionId === 'string' ? String((incoming as any).sessionId) : undefined;
        const rawRun = typeof (incoming as any).runId === 'string' ? String((incoming as any).runId) : undefined;
        if (Object.prototype.hasOwnProperty.call(incoming, 'payload')) {
          return { sessionId: rawSession, runId: rawRun, payload: (incoming as { payload: T }).payload };
        }
        if (rawSession || rawRun) {
          return { sessionId: rawSession, runId: rawRun, payload: incoming as T };
        }
      }
      return { payload: incoming as T };
    };

    const acceptEvent = (incoming: any): { allowed: boolean; payload: any } => {
      const { sessionId, runId, payload } = parseEnvelope(incoming);
      if (targetSessionId && sessionId !== targetSessionId) {
        return { allowed: false, payload };
      }
      if (targetRunId) {
        if (!runId || runId !== targetRunId) {
          return { allowed: false, payload };
        }
      }
      return { allowed: true, payload };
    };

    const onChunk = (_evt: Electron.IpcRendererEvent, incoming: any) => {
      const { allowed, payload } = acceptEvent(incoming);
      if (!allowed) return;
      if (onToken && typeof payload === 'string') onToken(payload);
    };

    const onComplete = (_evt: Electron.IpcRendererEvent, incoming: any) => {
      const { allowed } = acceptEvent(incoming);
      if (!allowed) return;
      cleanup();
      if (onDone) onDone();
    };

    const onErr = (_evt: Electron.IpcRendererEvent, incoming: any) => {
      const { allowed, payload } = acceptEvent(incoming);
      if (!allowed) return;
      cleanup();
      if (onError) onError(payload);
    };

    // Tool-call UI event relays
    const onToolStart = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onToolEvent) onToolEvent('start', data);
    };
    const onToolArgs = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onToolEvent) onToolEvent('args', data);
    };
    const onToolExec = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onToolEvent) onToolEvent('exec', data);
    };
    const onToolResult = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onToolEvent) onToolEvent('result', data);
    };

    // Reasoning event relays
    const onReasoningReset = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed } = acceptEvent(payload);
      if (!allowed) return;
      if (onReasoningEvent) onReasoningEvent('reset');
    };
    const onReasoningSummaryDelta = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onReasoningEvent) onReasoningEvent('summary_delta', data);
    };
    const onReasoningSummaryDone = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onReasoningEvent) onReasoningEvent('summary_done', data);
    };
    const onReasoningTextDelta = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onReasoningEvent) onReasoningEvent('text_delta', data);
    };
    const onReasoningTextDone = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onReasoningEvent) onReasoningEvent('text_done', data);
    };

    // Inline confirmation request relay
    const onConfirmRequest = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onConfirmEvent) onConfirmEvent({ kind: 'request', payload: data });
    };

    const onConfirmResolved = (_evt: Electron.IpcRendererEvent, payload: any) => {
      const { allowed, payload: data } = acceptEvent(payload);
      if (!allowed) return;
      if (onConfirmEvent) onConfirmEvent({ kind: 'resolved', payload: data });
    };

    const onNotice = (_evt: Electron.IpcRendererEvent, payload: any) => {
      try {
        const { payload: value } = parseEnvelope(payload);
        if (onNoticeEvent) onNoticeEvent(value);
      } catch {}
    };

    const onMonitor = (_evt: Electron.IpcRendererEvent, payload: any) => {
      try {
        const { payload: value } = parseEnvelope(payload);
        if (onMonitorEvent) onMonitorEvent(value);
      } catch {}
    };

    const cleanup = () => {
      ipcRenderer.removeListener("ai:chatStream:chunk", onChunk);
      ipcRenderer.removeListener("ai:chatStream:done", onComplete);
      ipcRenderer.removeListener("ai:chatStream:error", onErr);
      ipcRenderer.removeListener("ai:tool:start", onToolStart);
      ipcRenderer.removeListener("ai:tool:args", onToolArgs);
      ipcRenderer.removeListener("ai:tool:exec", onToolExec);
      ipcRenderer.removeListener("ai:tool:result", onToolResult);

      ipcRenderer.removeListener("ai:reasoning:summary_done", onReasoningSummaryDone);

      ipcRenderer.removeListener("ai:confirm:request", onConfirmRequest);
      ipcRenderer.removeListener("ai:confirm:resolved", onConfirmResolved);
      ipcRenderer.removeListener("ai:notice", onNotice);
      ipcRenderer.removeListener('ai:agent:monitor', onMonitor);
    };

    ipcRenderer.on("ai:chatStream:chunk", onChunk);
    ipcRenderer.on("ai:chatStream:done", onComplete);
    ipcRenderer.on("ai:chatStream:error", onErr);
    ipcRenderer.on("ai:tool:start", onToolStart);
    ipcRenderer.on("ai:tool:args", onToolArgs);
    ipcRenderer.on("ai:tool:exec", onToolExec);
    ipcRenderer.on("ai:tool:result", onToolResult);

    ipcRenderer.on("ai:reasoning:summary_done", onReasoningSummaryDone);

    ipcRenderer.on("ai:confirm:request", onConfirmRequest);
    ipcRenderer.on("ai:confirm:resolved", onConfirmResolved);
    ipcRenderer.on("ai:notice", onNotice);
    ipcRenderer.on('ai:agent:monitor', onMonitor);

    // Note: main process expects a single payload object with { messages }
    ipcRenderer.send("ai:chatStream", { messages, options });
    return cleanup;
  },
  stop: (sessionId: string): void => {
    if (!sessionId) return;
    ipcRenderer.send('ai:stop', { sessionId });
  },
  cancelTool: (sessionId: string, callId: string) => {
    if (!sessionId || !callId) return;
    ipcRenderer.send('ai:tool:cancel', { sessionId, callId });
  },
  confirmResponse: (payload: { sessionId: string; id: string; allow: boolean }) => {
    if (!payload?.sessionId || !payload?.id) return;
    ipcRenderer.send('ai:confirm:response', payload);
  },
  session: {
    attach: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:session:attach', { sessionId }),
    detach: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:session:detach', { sessionId }),
    status: (sessionId: string): Promise<{ ok: boolean; status?: any; error?: string }> =>
      ipcRenderer.invoke('ai:session:status', { sessionId }),
  },
  onNotice: (handler: (payload: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => {
      try {
        const value = payload && typeof payload === 'object' && payload !== null && Object.prototype.hasOwnProperty.call(payload, 'payload')
          ? (payload as { payload: any }).payload
          : payload;
        handler(value);
      } catch {}
    };
    ipcRenderer.on('ai:notice', listener);
    return () => { ipcRenderer.removeListener('ai:notice', listener); };
  },
  onAgentMonitor: (handler: (payload: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => {
      try {
        const value = payload && typeof payload === 'object' && payload !== null && Object.prototype.hasOwnProperty.call(payload, 'payload')
          ? (payload as { payload: any }).payload
          : payload;
        handler(value);
      } catch {}
    };
    ipcRenderer.on('ai:agent:monitor', listener);
    return () => { ipcRenderer.removeListener('ai:agent:monitor', listener); };
  },
});

contextBridge.exposeInMainWorld('todos', {
  reset: (sessionId: string): Promise<{ message: string; todos: Record<number, { status: string; content: string }>; count: number }> =>
    ipcRenderer.invoke('todos:reset', { sessionId }),
});

// Minimal MCP management surface for the renderer
contextBridge.exposeInMainWorld('mcp', {
  list: (): Promise<{ ok: boolean; workingDir?: string; servers?: any[]; config?: any; list?: any; error?: string }> =>
    ipcRenderer.invoke('mcp:list'),
  connect: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:connect', name),
  disconnect: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:disconnect', name),
  userGet: (): Promise<{ ok: boolean; path?: string; config?: any; error?: string }> =>
    ipcRenderer.invoke('mcp:user:get'),
  userUpsert: (name: string, config: any): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:user:upsert', { name, config }),
  userDelete: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:user:delete', name),
  showAddDialog: (): void => ipcRenderer.send('mcp:show-add-dialog'),
});

contextBridge.exposeInMainWorld('electronAPI', {
  showAddMcpDialog: (): void => ipcRenderer.send('mcp:show-add-dialog'),
  log: (message: string): void => ipcRenderer.send('debug:log', message),
});

// Version check API for auto-update notifications (legacy - kept for compatibility)
contextBridge.exposeInMainWorld('appVersion', {
  check: (): Promise<{
    ok: boolean;
    updateAvailable?: boolean;
    currentVersion?: string;
    latestVersion?: string;
    message?: string;
    downloadLink?: string;
    error?: string;
  }> => ipcRenderer.invoke('version:check'),
  
  getCurrent: (): Promise<{ ok: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('version:current'),
  
  openDownload: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('version:openDownload', url),
});

// Auto-update API using electron-updater
contextBridge.exposeInMainWorld('autoUpdate', {
  // Check for updates
  check: (): Promise<{
    ok: boolean;
    updateAvailable?: boolean;
    currentVersion?: string;
    latestVersion?: string;
    updateInfo?: any;
    error?: string;
  }> => ipcRenderer.invoke('auto-update:check'),
  
  // Download the available update
  download: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('auto-update:download'),
  
  // Install the downloaded update (quits and restarts app)
  install: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('auto-update:install'),
  
  // Get current update status
  getStatus: (): Promise<{
    ok: boolean;
    status?: string;
    currentVersion?: string;
    latestVersion?: string;
    error?: string;
  }> => ipcRenderer.invoke('auto-update:status'),
  
  // Get current app version
  getVersion: (): Promise<{ ok: boolean; version?: string }> =>
    ipcRenderer.invoke('auto-update:version'),
  
  // Listen for status updates from main process
  onStatus: (callback: (payload: {
    status: string;
    info?: any;
    progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number };
    error?: string;
    currentVersion?: string;
    latestVersion?: string;
  }) => void): (() => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('auto-update:status', handler);
    return () => {
      ipcRenderer.removeListener('auto-update:status', handler);
    };
  },
});
