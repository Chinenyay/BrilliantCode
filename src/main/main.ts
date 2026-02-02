import { app, BrowserWindow, ipcMain, WebContentsView, dialog, Menu, session as electronSession, nativeImage, shell } from 'electron';
import type { IpcMainEvent } from 'electron';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as pty from 'node-pty';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { toolsSchema , createToolHandlers } from '../agent/tools.js';
import { clearTodos } from '../agent/todoStore.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AgentSessionManager } from './agentSessionManager.js';
import { ChatStore } from '../agent/chatStore.js';
import type { WorkspaceChangesSnapshot } from '../agent/chatStore.js';
import {
  computeWorkspaceBaselineChanges,
  deleteWorkspaceBaseline,
  diffWorkspaceBaseline,
  ensureWorkspaceBaseline,
  undoWorkspaceBaselineAll,
  undoWorkspaceBaselineFile,
} from './workspaceBaseline.js';
import { MODELS, getModelProvider, setCustomModels, isBuiltinModel, type Provider } from '../agent/models.js';
import type { OpenAIResponseItem } from '../types/chat.js';
import { listDirTree } from '../agent/dirTree.js';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as dotenv from 'dotenv';
import { McpHost, normalizeServerConfig } from './mcpHost.js';
import * as apiKeys from '../services/api-keys.js';
import * as versionCheck from '../services/version-check.js';
import { setupAutoUpdater, checkForUpdates as checkAutoUpdates } from '../services/auto-updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.hh',
  '.rs',
  '.py',
  '.rb',
  '.go',
  '.php',
  '.java',
  '.cs',
  '.swift',
  '.scala',
  '.kt',
  '.kts',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.psm1',
  '.sql',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.dotenv',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.dockerignore',
  '.dockerfile',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
  '.astro',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.tex',
  '.mdx',
  '.lit',
  '.log',
  '.license',
  '.gradle',
  '.properties',
  '.bat',
  '.txtproj',
]);

const BINARY_FILE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.icns',
  '.tiff',
  '.tif',
  '.webp',
  '.heic',
  '.psd',
  '.ai',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.aac',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.dmg',
  '.app',
  '.exe',
  '.dll',
  '.so',
  '.bin',
  '.class',
  '.o',
  '.obj',
  '.wasm',
  '.suo',
]);

type GitChangeFile = {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
};

function stableFingerprintForWorkspaceChanges(files: GitChangeFile[], totals?: { files: number; additions: number; deletions: number }): string {
  try {
    const normalized = [...files]
      .map((f) => ({
        path: typeof f?.path === 'string' ? f.path : '',
        status: typeof f?.status === 'string' ? f.status : '',
        additions: f?.additions === null || f?.additions === undefined ? null : Number(f.additions),
        deletions: f?.deletions === null || f?.deletions === undefined ? null : Number(f.deletions),
      }))
      .filter((f) => !!f.path)
      .map((f) => ({
        ...f,
        additions: typeof f.additions === 'number' && Number.isFinite(f.additions) ? Math.max(0, Math.floor(f.additions)) : null,
        deletions: typeof f.deletions === 'number' && Number.isFinite(f.deletions) ? Math.max(0, Math.floor(f.deletions)) : null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
    const payload = { totals: totals || null, files: normalized };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } catch {
    const joined = files
      .map((f) => `${f.path}|${f.status}|${f.additions ?? ''}|${f.deletions ?? ''}`)
      .sort()
      .join('\n');
    return crypto.createHash('sha256').update(joined).digest('hex');
  }
}

function runGit(cwd: string, args: string[], opts?: { timeoutMs?: number }): { ok: boolean; stdout: string; stderr: string; code: number } {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      timeout: Math.max(0, Math.floor(opts?.timeoutMs ?? 8000)),
      windowsHide: true,
    });
    const code = typeof res.status === 'number' ? res.status : 1;
    const stdout = typeof res.stdout === 'string' ? res.stdout : String(res.stdout ?? '');
    const stderr = typeof res.stderr === 'string' ? res.stderr : String(res.stderr ?? '');
    return { ok: code === 0, stdout, stderr, code };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error ?? 'git failed'), code: 1 };
  }
}

function parseGitPorcelainZ(raw: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  if (!raw) return out;
  const parts = raw.split('\u0000');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.length < 4) continue;
    // Format: XY<space>path
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const x = status[0] || ' ';
    const y = status[1] || ' ';
    const kind = (y !== ' ' ? y : x).trim() || '?';
    if (kind === 'R' || kind === 'C') {
      // When using -z, rename/copy entries have two paths: "R  new\0old\0"
      const newPath = path;
      const oldPath = parts[i + 1] || '';
      i += 1;
      out.push({ path: newPath || oldPath, status: kind });
    } else {
      out.push({ path, status: kind });
    }
  }
  return out.filter(e => !!e.path);
}

function parseNumstat(raw: string): { additions: number | null; deletions: number | null } | null {
  const line = raw.split(/\r?\n/).find(Boolean);
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const addRaw = parts[0];
  const delRaw = parts[1];
  const addNum = addRaw === '-' ? null : Number(addRaw);
  const delNum = delRaw === '-' ? null : Number(delRaw);
  return {
    additions: typeof addNum === 'number' && Number.isFinite(addNum) ? Math.max(0, Math.floor(addNum)) : null,
    deletions: typeof delNum === 'number' && Number.isFinite(delNum) ? Math.max(0, Math.floor(delNum)) : null,
  };
}

async function countFileLines(absPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    if (!normalized) return 0;
    const segments = normalized.split('\n');
    return normalized.endsWith('\n') ? segments.length - 1 : segments.length;
  } catch {
    return 0;
  }
}

function isTextLikeFile(filePath: string, buffer: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  if (BINARY_FILE_EXTENSIONS.has(ext)) return false;
  if (buffer.length === 0) return true;
  const sampleLength = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32) || byte === 127) suspicious += 1;
  }
  return suspicious / sampleLength <= 0.3;
}

function hydrateProcessEnvFromUserShell(): void {
  if (process.platform === 'win32') return;
  const shellFromEnv = typeof process.env.SHELL === 'string' ? process.env.SHELL.trim() : '';
  let fallbackShell = '';
  try { fallbackShell = os.userInfo().shell || ''; } catch {}
  const shellPath = shellFromEnv || fallbackShell || '/bin/bash';
  const attempts: string[][] = [
    ['-ilc', 'env'],
    ['-lc', 'env'],
    ['-ic', 'env'],
    ['-c', 'env'],
  ];
  let failure: unknown;
  for (const args of attempts) {
    try {
      const result = spawnSync(shellPath, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 6000,
        env: process.env,
      });
      if (result.error || result.status !== 0) {
        failure = result.error || result.stderr || result.status;
        continue;
      }
      const output = typeof result.stdout === 'string' ? result.stdout : '';
      if (!output.trim()) {
        failure = 'empty stdout';
        continue;
      }
      const pairs = output.split(/\r?\n/);
      const skip = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);
      for (const line of pairs) {
        if (!line || line.includes('\u0000')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx);
        if (!key || skip.has(key)) continue;
        const value = line.slice(idx + 1);
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
      return;
    } catch (error) {
      failure = error;
    }
  }
  if (failure) {
    console.warn('Unable to hydrate shell environment for terminals:', failure);
  }
}

function loadEnvironment(): void {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '../../.env'),
  ];

  if (app.isPackaged) {
    candidates.unshift(path.join(process.resourcesPath, '.env'));
  }

  for (const candidate of candidates) {
    if (!candidate || !fsSync.existsSync(candidate)) continue;
    dotenv.config({ path: candidate, override: false });
    break;
  }
}

hydrateProcessEnvFromUserShell();
loadEnvironment();

const BRAND_NAME = 'BrilliantCode';
const BRAND_SITE = 'https://brilliantai.co';
const BRAND_ICON_PATH = path.join(__dirname, '../assets/branding/brilliant-ai-logo-small.png');
let BRAND_ICON_IMAGE: Electron.NativeImage | null = null;

function getBrandIcon(): Electron.NativeImage | string | undefined {
  if (BRAND_ICON_IMAGE && !BRAND_ICON_IMAGE.isEmpty()) return BRAND_ICON_IMAGE;
  return fsSync.existsSync(BRAND_ICON_PATH) ? BRAND_ICON_PATH : undefined;
}

const preloadPath = (() => {
  try {
    const cjs = path.join(__dirname, '../preload/preload.cjs');
    const js = path.join(__dirname, '../preload/preload.js');
    if (fsSync.existsSync(cjs)) return cjs;
    if (fsSync.existsSync(js)) return js;
  } catch {}
  return path.join(__dirname, '../preload/preload.js');
})();

// Global MCP host manager (holds per-window state internally)
const mcpHost = new McpHost();
const chatStore = new ChatStore();
const agentSessionManager = new AgentSessionManager(chatStore);

// Track child views and split ratios per window
const childViews: Map<number, Electron.WebContentsView> = new Map(); // win.id -> WebContentsView
const splitRatios: Map<number, number> = new Map(); // win.id -> number (0..1)
// Track the current working directory per window (single source of truth for that window)
const windowWorkingDirs: Map<number, string> = new Map(); // win.id -> cwd
// Track active chat session per window (used for additional working directory resolution outside AI runs)
const windowActiveSessionIds: Map<number, string> = new Map(); // win.id -> sessionId
const windowAdditionalWorkingDirs: Map<number, string | null> = new Map(); // win.id -> additional dir
const windowAgentModes: Map<number, 'chat' | 'agent' | 'agent_full'> = new Map();
const previewCommandResolvers = new Map<string, { resolve: (value: any) => void; timeout: NodeJS.Timeout | null }>();
const DEFAULT_TERMINAL_ID = 'default';
const htmlPreviewWindows = new Set<BrowserWindow>();

const DEFAULT_TOOL_TEXT_LIMIT = 120_000;
const TERMINAL_TEXT_LIMIT = 120_000;

type ClampResult = { text: string; clamped: boolean; omitted: number };

function clampToolText(raw: unknown, limit: number = DEFAULT_TOOL_TEXT_LIMIT): ClampResult {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (text.length <= limit) {
    return { text, clamped: false, omitted: 0 };
  }
  const omitted = Math.max(0, text.length - limit);
  const suffix = `\n… (truncated ${omitted} character${omitted === 1 ? '' : 's'})`;
  return {
    text: text.slice(0, limit) + suffix,
    clamped: true,
    omitted,
  };
}

const sortToolsByName = (schema: any[]): any[] => {
  if (!Array.isArray(schema)) return [];
  return schema
    .map((tool, index) => ({
      tool,
      index,
      name: typeof tool?.name === 'string' ? tool.name.toLowerCase() : '',
    }))
    .sort((a, b) => {
      if (a.name === b.name) return a.index - b.index;
      return a.name < b.name ? -1 : 1;
    })
    .map(entry => entry.tool);
};

let welcomeWindow: Electron.BrowserWindow | null = null;

type LayoutMode = 'split' | 'agent' | 'browser';
const windowLayoutModes = new Map<number, LayoutMode>();
let lastFocusedWindowId: number | null = null;
let menuLayoutMode: LayoutMode = 'split';

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

function focusPrimaryWindow(): void {
  const windows = BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed());
  if (!windows.length) return;
  const primary = windows.find((win) => win.isVisible()) ?? windows[0];
  try {
    if (primary.isMinimized()) primary.restore();
    primary.focus();
  } catch {}
}

const pendingStartupOpenUrls: string[] = [];

app.on('second-instance', (_event, _commandLine) => {
  focusPrimaryWindow();
});

app.on('open-url', (event, url) => {
  try { event.preventDefault(); } catch {}
  pendingStartupOpenUrls.push(url);
  focusPrimaryWindow();
});

ipcMain.on('preview:command:result', (_event, payload: any) => {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
  if (!requestId) return;
  const entry = previewCommandResolvers.get(requestId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  previewCommandResolvers.delete(requestId);
  try {
    entry.resolve(payload?.result ?? { ok: false, error: 'no-result' });
  } catch {}
});

type TerminalRecord = {
  id: string;
  pty: pty.IPty;
  cols: number;
  rows: number;
  cwd: string;
};

const windowTerminals: Map<number, Map<string, TerminalRecord>> = new Map();
const windowTerminalCounters: Map<number, number> = new Map();

// Track recent terminal output per window/terminal for read_terminal tool
type TermBuf = { chunks: string[]; size: number };
const windowTermBufs: Map<number, Map<string, TermBuf>> = new Map();
const MAX_TERM_BUF_BYTES = 200_000; // ~200KB of recent output per terminal

const suppressedTerminalExitNotices: Map<number, Set<string>> = new Map();

function suppressTerminalExitNotice(winId: number, terminalId: string): void {
  if (!terminalId) return;
  let set = suppressedTerminalExitNotices.get(winId);
  if (!set) {
    set = new Set();
    suppressedTerminalExitNotices.set(winId, set);
  }
  set.add(terminalId);
}

function consumeTerminalExitNotice(winId: number, terminalId: string): boolean {
  const set = suppressedTerminalExitNotices.get(winId);
  if (!set) return false;
  const had = set.delete(terminalId);
  if (set.size === 0) {
    suppressedTerminalExitNotices.delete(winId);
  }
  return had;
}

const deriveTitleFromHistory = (history: OpenAIResponseItem[]): string | null => {
  if (!Array.isArray(history)) return null;
  for (const item of history) {
    if (item?.role === 'user' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'input_text') {
          const text = String(block.text || '').trim().replace(/\s+/g, ' ');
          if (!text) continue;
          if (text.toLowerCase().startsWith('image path:')) continue;
          return text.length > 60 ? `${text.slice(0, 57)}…` : text;
        }
      }
    }
  }
  return null;
};

function ensureTermBuf(winId: number, terminalId: string): TermBuf {
  let winBuf = windowTermBufs.get(winId);
  if (!winBuf) {
    winBuf = new Map();
    windowTermBufs.set(winId, winBuf);
  }
  let buf = winBuf.get(terminalId);
  if (!buf) {
    buf = { chunks: [], size: 0 };
    winBuf.set(terminalId, buf);
  }
  return buf;
}

function appendTerm(winId: number, terminalId: string, data: string): void {
  if (!data) return;
  const buf = ensureTermBuf(winId, terminalId);
  buf.chunks.push(data);
  buf.size += data.length;
  while (buf.size > MAX_TERM_BUF_BYTES && buf.chunks.length > 1) {
    const removed = buf.chunks.shift() || '';
    buf.size -= removed.length;
  }
}

function readTermText(winId: number, terminalId: string = DEFAULT_TERMINAL_ID): string {
  const winBuf = windowTermBufs.get(winId);
  if (!winBuf) return '';
  const buf = winBuf.get(terminalId);
  if (!buf) return '';
  return buf.chunks.join('');
}

type PreviewHistoryEntry = { url: string; t: number };
const windowPreviewHistory: Map<number, PreviewHistoryEntry[]> = new Map();
const MAX_PREVIEW_HISTORY = 40;

function recordPreviewNavigation(winId: number, url: string): void {
  const entry: PreviewHistoryEntry = { url, t: Date.now() };
  let history = windowPreviewHistory.get(winId);
  if (!history) {
    history = [];
    windowPreviewHistory.set(winId, history);
  }
  history.push(entry);
  while (history.length > MAX_PREVIEW_HISTORY) history.shift();
}

const DEFAULT_SHELL_COMMAND = process.platform === 'win32'
  ? 'powershell.exe'
  : process.env.SHELL || '/bin/bash';

let cachedTerminalHost: string | null = null;

function resolveTerminalHost(): string {
  if (cachedTerminalHost) return cachedTerminalHost;

  const raw = String(os.hostname() || '').trim();
  if (raw && raw.toLowerCase() !== 'unknown') {
    cachedTerminalHost = raw;
    return raw;
  }

  if (process.platform === 'darwin') {
    const local = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' });
    const localHost = String(local.stdout || '').trim();
    if (localHost) {
      cachedTerminalHost = localHost;
      return localHost;
    }

    const computer = spawnSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' });
    const computerHost = String(computer.stdout || '').trim().replace(/\s+/g, '-');
    if (computerHost) {
      cachedTerminalHost = computerHost;
      return computerHost;
    }
  }

  cachedTerminalHost = 'localhost';
  return cachedTerminalHost;
}

function ensureTerminalMap(winId: number): Map<string, TerminalRecord> {
  let map = windowTerminals.get(winId);
  if (!map) {
    map = new Map();
    windowTerminals.set(winId, map);
  }
  return map;
}

function getTerminalRecord(winId: number, terminalId: string): TerminalRecord | undefined {
  const map = windowTerminals.get(winId);
  if (!map) return undefined;
  return map.get(terminalId);
}

function nextTerminalId(winId: number): string {
  const current = windowTerminalCounters.get(winId) ?? 0;
  const next = current + 1;
  windowTerminalCounters.set(winId, next);
  return `term-${next}`;
}

function isPathInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveTerminalCwd(winId: number, requested?: string): { ok: boolean; cwd?: string; error?: string } {
  const base = windowWorkingDirs.get(winId) || process.cwd();
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return { ok: true, cwd: base };

  const roots = getAllowedRootsForWindow(winId);
  const resolved = resolvePathInAllowedRoots(roots, raw, { intent: 'read' });
  if (!resolved.ok || !resolved.abs) {
    return { ok: false, error: resolved.error || 'invalid cwd' };
  }
  return { ok: true, cwd: resolved.abs };
}

function sendTerminalData(win: Electron.BrowserWindow, terminalId: string, data: string): void {
  const payload = { terminalId, data };
  try { win.webContents.send('terminal:data', payload); } catch {}
  const child = childViews.get(win.id);
  if (child) {
    try { child.webContents.send('terminal:data', payload); } catch {}
  }
}

function notifyTerminalCreated(win: Electron.BrowserWindow, terminalId: string, cwd: string): void {
  const payload = { terminalId, cwd };
  try { win.webContents.send('terminal:created', payload); } catch {}
  const child = childViews.get(win.id);
  if (child) {
    try { child.webContents.send('terminal:created', payload); } catch {}
  }
}

function notifyTerminalClosed(win: Electron.BrowserWindow, terminalId: string, code?: number, signal?: number): void {
  const payload = { terminalId, code, signal };
  try { win.webContents.send('terminal:closed', payload); } catch {}
  const child = childViews.get(win.id);
  if (child) {
    try { child.webContents.send('terminal:closed', payload); } catch {}
  }
}

function createTerminalForWindow(
  win: Electron.BrowserWindow,
  options: { id?: string; cwd?: string; cols?: number; rows?: number },
): { ok: boolean; id?: string; error?: string; cwd?: string } {
  const terminalId = options.id ?? nextTerminalId(win.id);
  const existing = getTerminalRecord(win.id, terminalId);
  if (existing) {
    return { ok: false, error: `terminal ${terminalId} already exists` };
  }

  const cwdResult = resolveTerminalCwd(win.id, options.cwd);
  if (!cwdResult.ok || !cwdResult.cwd) {
    return { ok: false, error: cwdResult.error || 'invalid cwd' };
  }

  const colsRaw = Number.isFinite(options.cols) ? Math.floor(options.cols as number) : NaN;
  const rowsRaw = Number.isFinite(options.rows) ? Math.floor(options.rows as number) : NaN;
  const cols = colsRaw > 0 ? Math.min(colsRaw, 320) : 80;
  const rows = rowsRaw > 0 ? Math.min(rowsRaw, 120) : 24;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    PROMPT_EOL_MARK: '',
  };

  const terminalHost = resolveTerminalHost();
  const existingHost = String(env.HOST || '').trim();
  const existingHostname = String(env.HOSTNAME || '').trim();
  if (!existingHost || existingHost.toLowerCase() === 'unknown') env.HOST = terminalHost;
  if (!existingHostname || existingHostname.toLowerCase() === 'unknown') env.HOSTNAME = terminalHost;

  const ptyProcess = pty.spawn(DEFAULT_SHELL_COMMAND, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwdResult.cwd,
    env,
  });

  const record: TerminalRecord = {
    id: terminalId,
    pty: ptyProcess,
    cols,
    rows,
    cwd: cwdResult.cwd,
  };

  ensureTerminalMap(win.id).set(terminalId, record);

  ptyProcess.onData((chunk: string) => {
    appendTerm(win.id, terminalId, chunk);
    sendTerminalData(win, terminalId, chunk);
  });

  ptyProcess.onExit((ev) => {
    // IMPORTANT: Terminals can be "reset" (notably the default terminal during workspace switches).
    // In that case we may spawn a new PTY with the same terminalId before the old PTY emits its
    // exit event. Guard against the old PTY deleting the new PTY record.
    const suppressed = consumeTerminalExitNotice(win.id, terminalId);

    const map = windowTerminals.get(win.id);
    const current = map?.get(terminalId);
    if (current && current.pty !== ptyProcess) {
      // Stale exit from an old PTY instance for the same terminalId.
      // Do not delete state or emit terminal:closed (would break the new instance).
      return;
    }

    map?.delete(terminalId);
    const winBuf = windowTermBufs.get(win.id);
    winBuf?.delete(terminalId);

    if (!suppressed) {
      const exitMsg = `\r\n[Terminal ${terminalId} exited]\r\n`;
      appendTerm(win.id, terminalId, exitMsg);
      sendTerminalData(win, terminalId, exitMsg);
      notifyTerminalClosed(win, terminalId, ev?.exitCode, ev?.signal);
    }
  });

  notifyTerminalCreated(win, terminalId, cwdResult.cwd);

  return { ok: true, id: terminalId, cwd: cwdResult.cwd };
}

function resetDefaultTerminal(win: Electron.BrowserWindow, cwd: string): void {
  const map = ensureTerminalMap(win.id);
  const existing = map.get(DEFAULT_TERMINAL_ID);
  if (existing) {
    suppressTerminalExitNotice(win.id, DEFAULT_TERMINAL_ID);
    try { existing.pty.kill(); } catch {}
    map.delete(DEFAULT_TERMINAL_ID);
  }
  const bufMap = windowTermBufs.get(win.id);
  bufMap?.delete(DEFAULT_TERMINAL_ID);
  createTerminalForWindow(win, { id: DEFAULT_TERMINAL_ID, cwd });
}

// Track the active <webview> webContents per window id
const webviewByWindow: Map<number, Electron.WebContents> = new Map();
// Track current Preview URL/title per window for synergy
const currentPreviewByWindow: Map<number, { url: string; title?: string; ts: number }> = new Map();

function attachWebviewDebugging(win: Electron.BrowserWindow, contents: Electron.WebContents): void {
  try { webviewByWindow.set(win.id, contents); } catch {}
  windowPreviewHistory.set(win.id, []);

  const updateTitle = () => {
    const cur = currentPreviewByWindow.get(win.id);
    currentPreviewByWindow.set(win.id, { url: cur?.url || '', title: contents.getTitle?.() || undefined, ts: Date.now() });
  };

  const onNav = (url: string) => {
    const normalized = String(url || '');
    currentPreviewByWindow.set(win.id, { url: normalized, title: contents.getTitle?.() || undefined, ts: Date.now() });
    recordPreviewNavigation(win.id, normalized);
  };

  try {
    contents.on('did-navigate', (_e, url) => { try { onNav(url); } catch {} });
    contents.on('did-navigate-in-page', (_e, url) => { try { onNav(url); } catch {} });
    contents.on('page-title-updated', () => { try { updateTitle(); } catch {} });
  } catch {}

  try {
    const initialUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (initialUrl) onNav(initialUrl);
  } catch {}

  contents.once('destroyed', () => {
    try { if (webviewByWindow.get(win.id) === contents) webviewByWindow.delete(win.id); } catch {}
  });
}

type CustomModelSetting = { key: string; name?: string; apiName?: string; provider?: Provider; type?: string };
type AppSettings = {
  lastWorkingDir?: string;
  promptCacheSeed?: string;
  customModels?: CustomModelSetting[];
  hiddenModels?: string[];
};
let settingsPath = '';
let hiddenModelKeys = new Set<string>();

const buildModelList = (keys: string[]): { key: string; name: string; provider: Provider; type: string; source: 'builtin' | 'custom' }[] => {
  return keys
    .map(key => {
      const model = MODELS[key];
      if (!model) return null;
      return {
        key,
        name: model.name,
        provider: model.provider,
        type: model.type,
        source: isBuiltinModel(key) ? 'builtin' : 'custom',
      };
    })
    .filter((entry): entry is { key: string; name: string; provider: Provider; type: string; source: 'builtin' | 'custom' } => Boolean(entry));
};

const listVisibleModels = (): { key: string; name: string; provider: Provider; type: string; source: 'builtin' | 'custom' }[] => {
  const keys = Object.keys(MODELS).filter(key => !hiddenModelKeys.has(key));
  return buildModelList(keys);
};

const listHiddenModels = (): { key: string; name: string; provider: Provider; type: string; source: 'builtin' | 'custom' }[] => {
  return buildModelList([...hiddenModelKeys]);
};
async function loadSettings(): Promise<AppSettings> {
  try {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (!fsSync.existsSync(settingsPath)) return {};
    const raw = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(raw || '{}') as AppSettings;
  } catch {
    return {};
  }
}
async function saveSettings(s: AppSettings): Promise<void> {
  try {
    if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save settings:', err);
  }
}

async function getCustomModelsFromSettings(): Promise<CustomModelSetting[]> {
  try {
    const s = await loadSettings();
    if (!Array.isArray(s.customModels)) return [];
    return s.customModels.filter(m => m && typeof m.key === 'string');
  } catch {
    return [];
  }
}

async function getHiddenModelsFromSettings(): Promise<string[]> {
  try {
    const s = await loadSettings();
    if (!Array.isArray(s.hiddenModels)) return [];
    return s.hiddenModels.filter(key => typeof key === 'string' && key.trim());
  } catch {
    return [];
  }
}

async function persistCustomModels(list: CustomModelSetting[]): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, customModels: list });
  setCustomModels(list);
}

async function persistHiddenModels(list: string[]): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, hiddenModels: list });
}

// Prompt caching (OpenAI Responses API): enable a stable prompt_cache_key and request
// cache retention.
// If the upstream rejects these fields, we automatically fall back.
const PROMPT_CACHE_RETENTION = '24h';
let promptCachingSupported: boolean | null = null; // null=unknown, false=unsupported, true=supported
let promptCacheKeyMemo: string | null = null;

const toHexSha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const hasPromptCachingFields = (params: any): boolean => {
  if (!params || typeof params !== 'object') return false;
  return typeof (params as any).prompt_cache_key === 'string' || typeof (params as any).prompt_cache_retention === 'string';
};

const stripPromptCachingFields = <T extends Record<string, any>>(params: T): T => {
  if (!params || typeof params !== 'object') return params;
  const clone: any = { ...params };
  delete clone.prompt_cache_key;
  // Also strip retention if some caller set it; Azure doesn't support it.
  delete clone.prompt_cache_retention;
  return clone as T;
};

const isPromptCachingParamError = (error: any): boolean => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status && status !== 400 && status !== 422) return false;

  const message = String(
    error?.message
    ?? error?.error?.message
    ?? error?.response?.data?.error?.message
    ?? error?.response?.data?.message
    ?? ''
  ).toLowerCase();

  // Broad matching for various upstreams.
  const mentionsField = message.includes('prompt_cache_key') || message.includes('prompt_cache_retention') || message.includes('prompt cache');
  if (!mentionsField) return false;

  const looksLikeValidation = message.includes('unknown')
    || message.includes('unrecognized')
    || message.includes('unexpected')
    || message.includes('invalid')
    || message.includes('additional properties')
    || message.includes('not allowed');

  return looksLikeValidation;
};

const getOrCreatePromptCacheSeed = async (): Promise<string> => {
  try {
    const current = await loadSettings();
    const existing = typeof current.promptCacheSeed === 'string' ? current.promptCacheSeed.trim() : '';
    if (existing) return existing;

    const seed = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    await saveSettings({ ...current, promptCacheSeed: seed });
    return seed;
  } catch {
    return typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

const getPromptCacheKey = async (): Promise<string> => {
  if (promptCacheKeyMemo) return promptCacheKeyMemo;

  const seed = await getOrCreatePromptCacheSeed();

  // Hash to avoid sending raw identifiers.
  promptCacheKeyMemo = toHexSha256(`brilliantcode:${seed}`);
  return promptCacheKeyMemo;
};

const applyPromptCachingDefaults = async <T extends Record<string, any>>(params: T): Promise<T> => {
  if (!params || typeof params !== 'object') return params;
  if (promptCachingSupported === false) return params;

  // Ensure we always send a stable prompt_cache_key.
  const next: any = { ...params };
  if (typeof next.prompt_cache_key !== 'string' || !next.prompt_cache_key.trim()) {
    next.prompt_cache_key = await getPromptCacheKey();
  }

  // Request retention by default (if the upstream rejects these fields, we retry without them).
  if (typeof next.prompt_cache_retention !== 'string' || !next.prompt_cache_retention.trim()) {
    next.prompt_cache_retention = PROMPT_CACHE_RETENTION;
  }

  return next as T;
};

type ResponsesCreateParams = Parameters<OpenAI['responses']['create']>[0];
type ResponsesStreamParams = Parameters<OpenAI['responses']['stream']>[0];
type ResponsesRetrieveArgs = Parameters<OpenAI['responses']['retrieve']>;

const parseEnvInt = (keys: string[], fallback: number): number => {
  for (const key of keys) {
    const raw = process.env[key];
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
};

const createRequestGate = (limit: number) => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return async <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve().then(fn);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => queue.push(() => {
      active += 1;
      resolve();
    }));
  };

  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
};

const MODEL_REQUEST_CONCURRENCY = parseEnvInt(['AGENT_MAX_CONCURRENT_REQUESTS', 'AGENT_MODEL_CONCURRENCY'], 1);
const withModelRequestGate = createRequestGate(MODEL_REQUEST_CONCURRENCY);

const llmClient = (() => {
    const buildOpenAIClient = async (): Promise<OpenAI> => {
        const { key } = await apiKeys.getApiKey('openai');
        if (!key) {
            throw new Error('OpenAI API key is not configured. Use AI → API Keys… to set OPENAI_API_KEY.');
        }
        return new OpenAI({
            apiKey: key,
        });
    };

    const buildOpenAICompatClient = async (): Promise<OpenAI> => {
        const { key } = await apiKeys.getApiKey('openai_compat');
        const { url: baseUrl } = await apiKeys.getOpenAICompatBaseUrl();
        if (!key) {
            throw new Error('OpenAI-compatible API key is not configured. Use AI → API Keys… to set OPENAI_COMPAT_API_KEY.');
        }
        return new OpenAI({
            apiKey: key,
            baseURL: baseUrl || undefined,
        });
    };

    const buildAnthropicClient = async (): Promise<Anthropic> => {
        const { key } = await apiKeys.getApiKey('anthropic');
        if (!key) {
            throw new Error('Anthropic API key is not configured. Use AI → API Keys… to set ANTHROPIC_API_KEY.');
        }

        return new Anthropic({
            apiKey: key,
        });
    };

    const withFreshOpenAIClient = async <T>(
        provider: 'openai' | 'openai_compat',
        invoke: (client: OpenAI) => Promise<T> | T,
        retries = 1
    ): Promise<T> => {
        const client = provider === 'openai_compat' ? await buildOpenAICompatClient() : await buildOpenAIClient();
        try {
            return await Promise.resolve(invoke(client));
        } catch (error: any) {
            const status = error?.status ?? error?.statusCode ?? error?.response?.status;
            void status;
            void retries;
            throw error;
        }
    };

    const withFreshAnthropicClient = async <T>(
        invoke: (client: Anthropic) => Promise<T> | T,
        retries = 1
    ): Promise<T> => {
        const client = await buildAnthropicClient();
        try {
            return await Promise.resolve(invoke(client));
        } catch (error: any) {
            const status = error?.status ?? error?.statusCode ?? error?.response?.status;
            void status;
            void retries;
            throw error;
        }
    };

    return {
        responses: {
            create: async (params: ResponsesCreateParams) => withModelRequestGate(async () => {
                const modelName = (params as any)?.model || '';
                const provider = getModelProvider(modelName);

                if (provider === 'anthropic') {
                    // Use the Anthropic client when the chosen model is Anthropic.
                    return await withFreshAnthropicClient(async client =>
                        await client.messages.create(params as any)
                    ) as any;
                }

                // OpenAI: apply prompt caching best practices by default.
                const enriched = await applyPromptCachingDefaults(params as any);
                const openAiProvider: 'openai' | 'openai_compat' =
                    provider === 'openai_compat' ? 'openai_compat' : 'openai';

                try {
                    const res = await withFreshOpenAIClient(openAiProvider, client => client.responses.create(enriched as any));
                    promptCachingSupported = promptCachingSupported ?? true;
                    return res as any;
                } catch (error: any) {
                    if (promptCachingSupported !== false && isPromptCachingParamError(error)) {
                        // Upstream rejected caching params. Disable for this app run and retry once.
                        promptCachingSupported = false;
                        const stripped = stripPromptCachingFields(enriched as any);
                        return await withFreshOpenAIClient(openAiProvider, client => client.responses.create(stripped as any)) as any;
                    }
                    throw error;
                }
            }),
            retrieve: (...args: ResponsesRetrieveArgs) => withModelRequestGate(() =>
                withFreshOpenAIClient('openai', client => client.responses.retrieve(...args))
            ),
            stream: (params: ResponsesStreamParams) => withModelRequestGate(async () => {
                const modelName = (params as any)?.model || '';
                const provider = getModelProvider(modelName);
                if (provider === 'anthropic') {
                    // Anthropic streaming is not wired via Responses.stream.
                    return await withFreshOpenAIClient('openai', client => client.responses.stream(params as any)) as any;
                }

                const enriched = await applyPromptCachingDefaults(params as any);
                const openAiProvider: 'openai' | 'openai_compat' =
                    provider === 'openai_compat' ? 'openai_compat' : 'openai';
                try {
                    const res = await withFreshOpenAIClient(openAiProvider, client => client.responses.stream(enriched as any));
                    promptCachingSupported = promptCachingSupported ?? true;
                    return res as any;
                } catch (error: any) {
                    if (promptCachingSupported !== false && isPromptCachingParamError(error)) {
                        promptCachingSupported = false;
                        const stripped = stripPromptCachingFields(enriched as any);
                        return await withFreshOpenAIClient(openAiProvider, client => client.responses.stream(stripped as any)) as any;
                    }
                    throw error;
                }
            }),
            poll: (path: string) => withModelRequestGate(async () => withFreshOpenAIClient('openai', async client => {
                if (typeof path !== 'string' || !path.trim()) {
                    throw new Error('Invalid poll path');
                }
                const trimmed = path.trim();
                const base =
                    typeof client.baseURL === 'string' && client.baseURL.trim()
                        ? client.baseURL.trim().replace(/\/+$/, '')
                        : '';

                const absolute = (() => {
                    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                        return trimmed;
                    }
                    if (!base) {
                        throw new Error('Client baseURL is not configured for polling.');
                    }

                    if (trimmed.startsWith('/')) {
                        let origin = '';
                        try {
                            origin = new URL(base).origin;
                        } catch {
                            const match = base.match(/^https?:\/\/[^/]+/i);
                            origin = match ? match[0] : '';
                        }
                        if (!origin) {
                            throw new Error('Unable to resolve base origin for polling.');
                        }
                        return `${origin}${trimmed}`;
                    }

                    return `${base}/${trimmed}`;
                })();

                const response = await client.get(absolute).asResponse();
                const contentType = response.headers.get('content-type') ?? '';
                const bodyText = await response.text();

                const parseBody = (): any => {
                    if (!bodyText) return null;
                    if (contentType.toLowerCase().includes('json')) {
                        try {
                            return JSON.parse(bodyText);
                        } catch {
                            return bodyText;
                        }
                    }
                    return bodyText;
                };

                const payload = parseBody();

                if (!response.ok) {
                    const detail =
                        payload && typeof payload === 'object'
                            ? (payload.detail ?? payload.error ?? payload.message ?? null)
                            : null;
                    const message =
                        typeof detail === 'string' && detail.trim()
                            ? detail.trim()
                            : bodyText.trim()
                                ? bodyText.trim()
                                : `${response.status} status code`;
                    const error = new Error(message);
                    (error as any).status = response.status;
                    if (detail) {
                        (error as any).detail = detail;
                    }
                    (error as any).body = payload;
                    throw error;
                }

                return payload;
            })),
        },
        reset(): void {
            // No cached clients to reset - using fresh clients with token refresh
        },
    };
})();

const client = llmClient;

// ---------------- API keys IPC surface ----------------
ipcMain.handle('api-keys:status', async () => {
  try {
    const status = await apiKeys.getApiKeysStatus();
    return { ok: true, status };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to load API key status.' };
  }
});

ipcMain.handle('api-keys:set', async (_event: Electron.IpcMainInvokeEvent, payload: { provider?: string; apiKey?: string }) => {
  try {
    const provider = payload?.provider === 'anthropic'
      ? 'anthropic'
      : payload?.provider === 'openai_compat'
        ? 'openai_compat'
        : 'openai';
    const apiKeyValue = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
    await apiKeys.setApiKey(provider, apiKeyValue);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to save API key.' };
  }
});

ipcMain.handle('api-keys:clear', async (_event: Electron.IpcMainInvokeEvent, payload: { provider?: string }) => {
  try {
    const provider = payload?.provider === 'anthropic'
      ? 'anthropic'
      : payload?.provider === 'openai_compat'
        ? 'openai_compat'
        : 'openai';
    await apiKeys.setApiKey(provider, '');
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to clear API key.' };
  }
});

ipcMain.handle('api-keys:set-compat-base-url', async (_event: Electron.IpcMainInvokeEvent, payload: { baseUrl?: string }) => {
  try {
    const baseUrlValue = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
    await apiKeys.setOpenAICompatBaseUrl(baseUrlValue);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to save OpenAI-compatible base URL.' };
  }
});

ipcMain.handle('api-keys:clear-compat-base-url', async () => {
  try {
    await apiKeys.setOpenAICompatBaseUrl('');
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to clear OpenAI-compatible base URL.' };
  }
});


// ---------------- Version Check IPC surface ----------------
ipcMain.handle('version:check', async () => {
  console.log('[ipc:version:check] Handler called');
  try {
    const result = await versionCheck.checkForUpdate();
    console.log('[ipc:version:check] Result:', result);
    return { ok: true, ...result };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to check for updates' };
  }
});

ipcMain.handle('version:current', async () => {
  console.log('[ipc:version:current] Handler called');
  try {
    const version = versionCheck.getCurrentVersion();
    return { ok: true, version };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to get current version' };
  }
});

ipcMain.handle('version:openDownload', async (_event: Electron.IpcMainInvokeEvent, url: string) => {
  try {
    if (!url) return { ok: false, error: 'No URL provided' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Failed to open download link' };
  }
});

// ---------------- MCP IPC surface ----------------
ipcMain.handle('mcp:list', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const cwd = windowWorkingDirs.get(win.id) || process.cwd();
  await mcpHost.prepare(win.id, cwd);
  return { ok: true, ...mcpHost.getStatus(win.id), list: mcpHost.listConfigured(win.id) };
});

ipcMain.handle('mcp:connect', async (event: Electron.IpcMainInvokeEvent, name: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const cwd = windowWorkingDirs.get(win.id) || process.cwd();
  await mcpHost.prepare(win.id, cwd);
  const result = await mcpHost.connect(win.id, String(name || ''), win);
  buildAndSetMenu();
  return result;
});

ipcMain.handle('mcp:disconnect', async (event: Electron.IpcMainInvokeEvent, name: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const result = await mcpHost.disconnect(win.id, String(name || ''));
  buildAndSetMenu();
  return result;
});

function getMcpUserConfigPath(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return null;
  return path.join(home, '.brilliantcode', 'mcp.json');
}

function readJsonSafe(file: string): any {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return {}; }
}

function ensureMcpConfigShape(raw: any): { root: Record<string, any>; store: Record<string, any> } {
  const base = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};
  let store: Record<string, any>;
  if (base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)) {
    store = { ...base.mcpServers };
  } else {
    store = {};
    for (const [key, value] of Object.entries(base)) {
      if (key === 'mcpServers') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        store[key] = value;
        delete base[key];
      }
    }
  }
  base.mcpServers = store;
  return { root: base, store };
}

ipcMain.handle('mcp:user:get', async (event: Electron.IpcMainInvokeEvent) => {
  const file = getMcpUserConfigPath();
  if (!file) return { ok: false, error: 'no-home' };
  const cfg = readJsonSafe(file);
  const { root, store } = ensureMcpConfigShape(cfg);
  return { ok: true, path: file, config: store, raw: root };
});

ipcMain.handle('mcp:user:upsert', async (event: Electron.IpcMainInvokeEvent, payload: { name: string; config: any }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const file = getMcpUserConfigPath();
  if (!file) return { ok: false, error: 'no-home' };
  try {
    const dir = path.dirname(file);
    try { fsSync.mkdirSync(dir, { recursive: true }); } catch {}
    const current = readJsonSafe(file);
    const { root, store } = ensureMcpConfigShape(current);
    const name = String(payload?.name || '').trim();
    const cfg = payload?.config || {};
    if (!name) return { ok: false, error: 'name-required' };
    const normalized = normalizeServerConfig(cfg);
    if (!normalized.command) return { ok: false, error: 'command-required' };
    store[name] = normalized;
    root.mcpServers = store;
    await fs.writeFile(file, JSON.stringify(root, null, 2), 'utf8');
    // Refresh MCP host view of config for this window
    const cwd = win ? (windowWorkingDirs.get(win.id) || process.cwd()) : process.cwd();
    await mcpHost.prepare(win?.id || 0, cwd);
    buildAndSetMenu();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('mcp:user:delete', async (event: Electron.IpcMainInvokeEvent, name: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const file = getMcpUserConfigPath();
  if (!file) return { ok: false, error: 'no-home' };
  try {
    const current = readJsonSafe(file);
    const { root, store } = ensureMcpConfigShape(current);
    const key = String(name || '').trim();
    if (!key) return { ok: false, error: 'name-required' };
    if (store && Object.prototype.hasOwnProperty.call(store, key)) {
      delete store[key];
    } else if (root && Object.prototype.hasOwnProperty.call(root, key)) {
      delete (root as Record<string, any>)[key];
    }
    root.mcpServers = store;
    await fs.writeFile(file, JSON.stringify(root, null, 2), 'utf8');
    const cwd = win ? (windowWorkingDirs.get(win.id) || process.cwd()) : process.cwd();
    await mcpHost.prepare(win?.id || 0, cwd);
    buildAndSetMenu();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.on('mcp:show-add-dialog', (event: Electron.IpcMainEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  showAddMcpServerDialog(win);
});

ipcMain.on('api-keys:show-dialog', (event: Electron.IpcMainEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  showApiKeysDialog(win);
});

// Resolve a renderer HTML asset either from built dist or from src (dev)
function resolveRendererHtml(file: string): string {
  const dist = path.join(__dirname, '../renderer', file);
  const src = path.join(__dirname, '../../src/renderer', file);
  return fsSync.existsSync(dist) ? dist : src;
}

function closeWelcomeWindow(): void {
  if (!welcomeWindow) return;
  const win = welcomeWindow;
  welcomeWindow = null;
  try {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  } catch {}
}

async function createWelcomeWindow(): Promise<Electron.BrowserWindow> {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus();
    return welcomeWindow;
  }

  const win = new BrowserWindow({
    width: 880,
    height: 620,
    resizable: false,
    maximizable: false,
    minimizable: true,
    show: true,
    backgroundColor: '#080808',
    title: 'Welcome to BrilliantCode',
    autoHideMenuBar: true,
    icon: getBrandIcon(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    }
  });

  win.on('closed', () => {
    if (welcomeWindow === win) {
      welcomeWindow = null;
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  try {
    if (devUrl) {
      const base = devUrl.endsWith('/') ? devUrl : `${devUrl}/`;
      const url = new URL('welcome.html', base);
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(resolveRendererHtml('welcome.html'));
    }
  } catch (error) {
    console.error('Failed to load welcome page, showing fallback markup.', error);
    const html = `<!doctype html><meta charset="utf-8"><title>Welcome</title><style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0a;color:#fff;display:grid;place-items:center;height:100vh}main{max-width:520px;padding:32px;border-radius:14px;background:#111;border:1px solid rgba(255,255,255,0.08);box-shadow:0 20px 50px rgba(0,0,0,0.4);text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:14px;color:#bbb;margin:0 0 18px}button{padding:10px 18px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}button:disabled{opacity:0.6;cursor:not-allowed}</style><main><h1>Welcome to BrilliantCode</h1><p>The welcome page failed to load from disk. Use the Sign in button to continue.</p><button id="signin" type="button">Sign in</button><script>document.getElementById('signin').addEventListener('click',()=>{window.auth?.login?.();});</script></main>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  }

  welcomeWindow = win;
  return win;
}

// Resize the child WebContents to occupy the right pane while respecting the
// divider gutter and minimum widths.
function layoutChild(win: Electron.BrowserWindow): void {
    const view = childViews.get(win.id);
    if (!view || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const ratio = splitRatios.get(win.id) ?? 0.5; // default 50% for child view (right pane)
    const DIVIDER = 4; // must match .divider width in CSS
    const LEFT_MIN = 200;
    const RIGHT_MIN = 200;
    const HIT_GUTTER = 6; // extra gap next to divider to ensure a reliable grab area

    // Compute available content width excluding divider, clamp the right pane
    const avail = Math.max(0, width - DIVIDER);
    const desiredRight = Math.round(avail * ratio);
    const maxRight = Math.max(RIGHT_MIN, avail - LEFT_MIN);
    const viewWidth = Math.min(Math.max(RIGHT_MIN, desiredRight), maxRight);

    // Reserve a small gutter beside the divider so the child view never overlaps it
    const boundsWidth = Math.max(RIGHT_MIN, viewWidth - HIT_GUTTER);
    const x = Math.max(0, width - boundsWidth);
    view.setBounds({ x, y: 0, width: boundsWidth, height });
}

function getChildView(win: Electron.BrowserWindow): Electron.WebContentsView | undefined {
  return childViews.get(win.id);
}

// Send a text file's content to the child view's code tab so the user can
// inspect artifacts the model touched.
async function showCodeInChild(win: Electron.BrowserWindow, filePath: string): Promise<{ ok: boolean; error?: string }>{
  const view = getChildView(win);
  if (!view) return { ok: false, error: 'no-view' };
  try {
    const roots = getAllowedRootsForWindow(win.id);
    const safePath = resolvePathInAllowedRoots(roots, filePath, { intent: 'read' });
    if (!safePath.ok || !safePath?.abs) return { ok: false, error: safePath.error || 'invalid-path' };
    const resolved = safePath.abs;
    if (!fsSync.existsSync(resolved)) return { ok: false, error: 'not-found' };

    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      view.webContents.send('child:show-code', { path: resolved, rel: safePath.rel, isDirectory: true, content: '' });
      return { ok: true };
    }

    let content = '';
    try { content = await fs.readFile(resolved, 'utf8'); }
    catch { content = '<binary or unreadable file>'; }
    view.webContents.send('child:show-code', { path: resolved, rel: safePath.rel, content, isDirectory: false });
    return { ok: true };
  } catch (e) {
    console.error('showCodeInChild failed', e);
    return { ok: false, error: String(e) };
  }
}
// Preview a specific local file path in the right-side view
async function previewPathInView(win: Electron.BrowserWindow, filePath: string): Promise<{ ok: boolean; error?: string }>{
  const view = getChildView(win);
  if (!view) return { ok: false, error: 'no-view' };
  try {
    const roots = getAllowedRootsForWindow(win.id);
    const safePath = resolvePathInAllowedRoots(roots, filePath, { intent: 'read' });
    if (!safePath.ok || !safePath?.abs) return { ok: false, error: safePath.error || 'invalid-path' };
    const resolved = safePath.abs;
    if (!fsSync.existsSync(resolved)) return { ok: false, error: 'not-found' };
    const ext = path.extname(resolved).toLowerCase();
    if (['.html', '.htm'].includes(ext)) {
      const preview = new BrowserWindow({
        width: 960,
        height: 720,
        show: true,
        autoHideMenuBar: true,
        title: `Preview: ${path.basename(resolved)}`,
        backgroundColor: '#111111',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        }
      });
      htmlPreviewWindows.add(preview);
      preview.on('closed', () => {
        htmlPreviewWindows.delete(preview);
      });
      preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await preview.loadFile(resolved);
      return { ok: true };
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf'].includes(ext)) {
      await view.webContents.loadURL(pathToFileURL(resolved).toString());
      return { ok: true };
    }
    // Text-like fallback (pretty-print JSON)
    const raw = await fs.readFile(resolved, 'utf8');
    const escapeHtml = (s: string): string => s.replace(/[&<>]/g, (substr: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[substr as '&' | '<' | '>'] ?? substr));
    let bodyText: string;
    if (ext === '.json') {
      try { bodyText = JSON.stringify(JSON.parse(raw), null, 2); }
      catch { bodyText = raw; }
    } else {
      bodyText = raw;
    }
    const safe = escapeHtml(bodyText);
    const title = path.basename(resolved);
    const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>html,body{height:100%;margin:0;background:#111;color:#eee;font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px} pre{white-space:pre-wrap;word-break:break-word}</style><pre>${safe}</pre>`;
    await view.webContents.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    return { ok: true };
  } catch (e) {
    console.error('previewPathInView failed', e);
    return { ok: false, error: String(e) };
  }
}

const PREVIEWABLE_FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.html', '.htm']);

function resolveWorkspacePreviewUrl(
  win: Electron.BrowserWindow,
  rawUrl: string
): { ok: boolean; url?: string; abs?: string; error?: string } {
  const prefix = 'workspace://';
  if (!rawUrl.startsWith(prefix)) return { ok: false };
  const relPath = rawUrl.slice(prefix.length).replace(/^\/+/, '');
  const roots = getAllowedRootsForWindow(win.id);
  const safe = resolvePathInAllowedRoots(roots, relPath, { intent: 'read' });
  if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
  if (!fsSync.existsSync(safe.abs)) return { ok: false, error: 'Path not found' };
  const ext = path.extname(safe.abs).toLowerCase();
  const asUrl = PREVIEWABLE_FILE_EXTS.has(ext) ? pathToFileURL(safe.abs).toString() : safe.abs;
  return { ok: true, url: asUrl, abs: safe.abs };
}

// Spin up the primary BrowserWindow plus the docked child view/pty. Called on
// app launch and when macOS reactivates the app with no windows open.
async function createWindow() {
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL);

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    useContentSize: true,
    backgroundColor: '#000000',
    title: BRAND_NAME,
    icon: getBrandIcon(),
    show: false,
    webPreferences: {
      webviewTag: true,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // Load renderer via Vite dev server if configured, otherwise from dist/src
  try {
    const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      win.loadURL(new URL('index.html', devUrl.endsWith('/') ? devUrl : devUrl + '/').toString());
    } else {
      win.loadFile(resolveRendererHtml('index.html'));
    }
  } catch {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (isDev) {
    // Open DevTools in a separate window so it isn't obscured by child views
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Decide initial working dir for this window based on persisted settings
  let initialSettings: AppSettings = {};
  try { initialSettings = await loadSettings(); } catch {}
  const initialCwd = initialSettings.lastWorkingDir && fsSync.existsSync(initialSettings.lastWorkingDir)
    ? initialSettings.lastWorkingDir
    : process.cwd();

  // Child view that renders the welcome page and an internal browser via <webview>
  const childWindow = new WebContentsView({
    webPreferences: {
      // Allow <webview> inside childIndex.html to render external/public sites
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: preloadPath,
    }
  } as any);

  try {
    const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      const url = new URL('childIndex.html', devUrl.endsWith('/') ? devUrl : devUrl + '/');
      url.searchParams.set('cwd', initialCwd);
      childWindow.webContents.loadURL(url.toString());
    } else {
      // loadFile supports a search option for query params
      childWindow.webContents.loadFile(resolveRendererHtml('childIndex.html'), {
        search: `?cwd=${encodeURIComponent(initialCwd)}`
      });
    }
  } catch (err) {
    console.error('Failed to load child view HTML, falling back to inline data URL.');
    const html = `<!doctype html><meta charset="utf-8"><title>Welcome</title><style>html,body{height:100%;margin:0;background:#0b0b0b;color:#eee;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center} .card{max-width:560px;padding:24px;border:1px solid #2a2a2a;border-radius:12px;background:#111;box-shadow:0 6px 30px rgba(0,0,0,.35)} h1{margin:0 0 8px;font-size:18px} p{margin:0 0 12px;color:#bbb}</style><div class="card"><h1>Welcome</h1><p>Your welcome page failed to load from disk. This is a safe fallback.</p></div>`;
    childWindow.webContents.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  }

  win.contentView.addChildView(childWindow);
  childViews.set(win.id, childWindow);
  // Initialize per-window working dir
  windowWorkingDirs.set(win.id, initialCwd);
  windowAgentModes.set(win.id, 'chat');
  windowLayoutModes.set(win.id, 'split');
  // Initialize MCP host with this window's working dir
  try { await mcpHost.prepare(win.id, initialCwd); } catch {}

  // Open child DevTools for debugging nested page (can be removed later)
  if (isDev) {
    try { childWindow.webContents.openDevTools({ mode: 'detach' }); } catch {}
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    closeWelcomeWindow();
    
    // Initialize auto-updater after window is ready
    setupAutoUpdater(win);
    
    // Check for updates after a short delay (let the app settle first)
    setTimeout(() => {
      if (!win.isDestroyed()) {
        checkAutoUpdates().catch((err) => {
          console.error('[auto-updater] Initial update check failed:', err);
        });
      }
    }, 5000);
  });

  win.on('focus', () => {
    if (win.isDestroyed()) return;
    lastFocusedWindowId = win.id;
    menuLayoutMode = windowLayoutModes.get(win.id) ?? 'split';
    buildAndSetMenu();
  });

  // Bounds are driven by renderer DOM via setRightBounds.
  // We no longer call layoutChild here to avoid dueling updates.

  childWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Child view failed to load:', {code, desc, url});
  });

  // Subscribe to <webview> attachments inside the child view and wire debugging
  try {
    childWindow.webContents.on('did-attach-webview', (_event: any, wc: Electron.WebContents) => {
      const parentWin = win; // child belongs to this BrowserWindow
      attachWebviewDebugging(parentWin, wc);
    });
  } catch {}

  // Wait for child view to be ready before creating default terminal
  // This ensures the renderer can receive terminal:created notifications
  const createDefaultTerminalWhenReady = () => {
    const defaultTerminal = createTerminalForWindow(win, { id: DEFAULT_TERMINAL_ID, cwd: initialCwd });
    if (!defaultTerminal.ok) {
      console.error('Failed to initialize default terminal:', defaultTerminal.error);
    }
  };

  // Use did-finish-load to ensure the child renderer is ready
  if (childWindow.webContents.isLoading()) {
    childWindow.webContents.once('did-finish-load', createDefaultTerminalWhenReady);
  } else {
    // Already loaded (unlikely but handle it)
    createDefaultTerminalWhenReady();
  }

  win.on('closed', () => {
    agentSessionManager.detachWindow(win.id);
    const terminals = windowTerminals.get(win.id);
    if (terminals) {
      for (const record of terminals.values()) {
        try { record.pty.kill(); } catch {}
      }
      windowTerminals.delete(win.id);
    }
    childViews.delete(win.id);
    splitRatios.delete(win.id);
    windowWorkingDirs.delete(win.id);
    windowAgentModes.delete(win.id);
    windowTermBufs.delete(win.id);
    windowTerminalCounters.delete(win.id);
    windowLayoutModes.delete(win.id);
    currentPreviewByWindow.delete(win.id);
    windowPreviewHistory.delete(win.id);
    try { if (webviewByWindow.get(win.id)) webviewByWindow.delete(win.id); } catch {}
    if (lastFocusedWindowId === win.id) {
      lastFocusedWindowId = null;
      menuLayoutMode = 'split';
      try { buildAndSetMenu(); } catch {}
    }
  });
}

type PreviewCommand = { action: string; params?: any; requestId?: string };

function generatePreviewRequestId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const PREVIEW_COMMAND_TIMEOUT_MS = (() => {
  const fallback = 15_000;
  const keys = ['AGENT_PREVIEW_COMMAND_TIMEOUT_MS', 'PREVIEW_COMMAND_TIMEOUT_MS'];
  for (const key of keys) {
    if (!key) continue;
    const raw = process.env[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) continue;
    if (parsed <= 0) return 0;
    return Math.floor(parsed);
  }
  return fallback;
})();

async function sendPreviewCommand(win: Electron.BrowserWindow, command: PreviewCommand, timeoutMs = PREVIEW_COMMAND_TIMEOUT_MS): Promise<any> {
  const view = childViews.get(win.id);
  if (!view) return { ok: false, error: 'no-view' };
  const requestId = command.requestId ?? generatePreviewRequestId();
  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        previewCommandResolvers.delete(requestId);
        resolve({ ok: false, error: 'preview-timeout' });
      }, timeoutMs);
    }
    previewCommandResolvers.set(requestId, { resolve, timeout });
    try {
      view.webContents.send('preview:command', { ...command, requestId });
    } catch (error: any) {
      if (timeout) clearTimeout(timeout);
      previewCommandResolvers.delete(requestId);
      resolve({ ok: false, error: error?.message || String(error) });
    }
  });
}

ipcMain.on('debug:log', (event, message) => {
  console.log('[Renderer Log]', message);
});

ipcMain.on('debug:log', (event, message) => {
  console.log('[Renderer Log]', message);
});

ipcMain.on('layout:set-split', (event: Electron.IpcMainEvent, value: number) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin) return;
  const ratio = typeof value === 'number' && value > 1 ? value / 100 : value;
  // Allow full collapse/expand; store for reference only
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0.5));
  splitRatios.set(senderWin.id, clamped);
});

ipcMain.on('layout:setTheme', (event: Electron.IpcMainEvent, theme: 'dark' | 'light') => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin) return;
  const child = childViews.get(senderWin.id);
  // Relay theme to child view
  if (child) {
    try { child.webContents.send('layout:theme-changed', theme); } catch {}
  }
});

ipcMain.on('layout:modeChanged', (event: Electron.IpcMainEvent, payload: any) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const mode = typeof payload === 'string' ? payload : payload?.mode;
  if (mode !== 'split' && mode !== 'agent' && mode !== 'browser') return;
  windowLayoutModes.set(win.id, mode as LayoutMode);
  if (win.isFocused()) {
    lastFocusedWindowId = win.id;
    menuLayoutMode = mode as LayoutMode;
    try { buildAndSetMenu(); } catch {}
  }
});

// Relay tab switch commands from main renderer to child view
ipcMain.on('child:switch-tab', (event: Electron.IpcMainEvent, payload: { tab: 'terminal' | 'preview' | 'code' }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const child = childViews.get(win.id);
  if (!child) return;
  try { child.webContents.send('child:switch-tab', payload); } catch {}
});

ipcMain.on('agent:modeChanged', (event: Electron.IpcMainEvent, payload: any) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const mode = typeof payload === 'string' ? payload : payload?.mode;
  if (mode !== 'chat' && mode !== 'agent' && mode !== 'agent_full') return;
  windowAgentModes.set(win.id, mode);
});

// Accept cwd updates from the renderer (parsed from OSC 7 sequences)
ipcMain.on('terminal:cwdChanged', (event: Electron.IpcMainEvent, payload: any) => {
  try {
    const { win } = resolveWindowForSender(event.sender);
    if (!win) return;
    let terminalId = DEFAULT_TERMINAL_ID;
    let cwd: string | undefined;
    if (typeof payload === 'object' && payload !== null) {
      if (typeof payload.terminalId === 'string' && payload.terminalId.trim()) {
        terminalId = payload.terminalId.trim();
      }
      if (typeof payload.cwd === 'string') {
        cwd = payload.cwd;
      }
    } else if (typeof payload === 'string') {
      cwd = payload;
    }
    if (!cwd) return;
    const normalized = path.resolve(cwd);

    // Clamp cwd updates to allowed roots (workspace + additional) unless in agent_full
    const roots = getAllowedRootsForWindow(win.id);
    const allowed = roots.allowExternal
      || isPathInside(path.resolve(roots.workspaceRoot), normalized)
      || (roots.additionalRoot ? isPathInside(path.resolve(roots.additionalRoot), normalized) : false);
    if (!allowed) return;

    const record = getTerminalRecord(win.id, terminalId);
    if (record) {
      record.cwd = normalized;
    }
    if (terminalId === DEFAULT_TERMINAL_ID) {
      windowWorkingDirs.set(win.id, normalized);
      console.log('cwd updated from renderer:', normalized);
      try { mcpHost.prepare(win.id, normalized); } catch {}
    }
  } catch {}
});

ipcMain.on('terminal:write', (event: Electron.IpcMainEvent, payload: any, maybeData?: any) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return;
  let terminalId = DEFAULT_TERMINAL_ID;
  let data: string | undefined;
  if (typeof payload === 'object' && payload !== null) {
    if (typeof payload.terminalId === 'string' && payload.terminalId.trim()) {
      terminalId = payload.terminalId.trim();
    }
    if (typeof payload.data === 'string') {
      data = payload.data;
    }
  } else if (typeof payload === 'string') {
    data = payload;
  }
  if (data === undefined && typeof maybeData === 'string') {
    data = maybeData;
  }
  if (typeof data !== 'string' || data.length === 0) return;
  const record = getTerminalRecord(win.id, terminalId);
  if (!record) return;
  try { record.pty.write(data); } catch {}
});

ipcMain.on('terminal:resize', (event: Electron.IpcMainEvent, payload: any, maybeRows?: any) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return;
  let terminalId = DEFAULT_TERMINAL_ID;
  let cols: number | undefined;
  let rows: number | undefined;
  if (typeof payload === 'object' && payload !== null) {
    if (typeof payload.terminalId === 'string' && payload.terminalId.trim()) {
      terminalId = payload.terminalId.trim();
    }
    if (Number.isFinite(payload.cols)) cols = Math.floor(payload.cols);
    if (Number.isFinite(payload.rows)) rows = Math.floor(payload.rows);
  } else {
    if (Number.isFinite(payload)) cols = Math.floor(payload);
    if (Number.isFinite(maybeRows)) rows = Math.floor(maybeRows);
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  const record = getTerminalRecord(win.id, terminalId);
  if (!record) return;
  try { record.pty.resize(cols as number, rows as number); } catch {}
  record.cols = cols as number;
  record.rows = rows as number;
});

ipcMain.handle('terminal:list', (event: Electron.IpcMainInvokeEvent) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return { ok: false, error: 'No window' };
  const records = Array.from(ensureTerminalMap(win.id).values()).map(rec => ({
    id: rec.id,
    cwd: rec.cwd,
    cols: rec.cols,
    rows: rec.rows,
  }));
  return { ok: true, terminals: records };
});

ipcMain.handle('terminal:read', (event: Electron.IpcMainInvokeEvent, payload: { terminalId?: string; bytes?: number }) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return { ok: false, error: 'No window' };
  const terminalId = typeof payload?.terminalId === 'string' && payload.terminalId.trim()
    ? payload.terminalId.trim()
    : DEFAULT_TERMINAL_ID;
  let text = readTermText(win.id, terminalId) || '';
  if (Number.isFinite(payload?.bytes) && (payload?.bytes as number) > 0) {
    const limit = Math.max(1, Math.floor(payload!.bytes as number));
    text = text.slice(-limit);
  }
  return { ok: true, terminalId, text };
});

ipcMain.handle('terminal:create', (event: Electron.IpcMainInvokeEvent, payload: { cwd?: string; cols?: number; rows?: number }) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return { ok: false, error: 'No window' };
  const result = createTerminalForWindow(win, {
    cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
    cols: Number.isFinite(payload?.cols) ? Math.floor(payload!.cols as number) : undefined,
    rows: Number.isFinite(payload?.rows) ? Math.floor(payload!.rows as number) : undefined,
  });
  return result;
});

ipcMain.handle('terminal:dispose', (event: Electron.IpcMainInvokeEvent, payload: { terminalId: string }) => {
  const { win } = resolveWindowForSender(event.sender);
  if (!win) return { ok: false, error: 'No window' };
  const terminalId = typeof payload?.terminalId === 'string' && payload.terminalId.trim()
    ? payload.terminalId.trim()
    : '';
  if (!terminalId) return { ok: false, error: 'terminalId is required' };
  if (terminalId === DEFAULT_TERMINAL_ID) return { ok: false, error: 'default terminal cannot be closed' };
  const record = getTerminalRecord(win.id, terminalId);
  if (!record) return { ok: false, error: 'terminal not found' };
  try { record.pty.kill(); } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error ?? 'failed to dispose') };
  }
  return { ok: true };
});

// Directly set right view bounds from renderer's measured DOM rect
ipcMain.on('layout:set-right-bounds', (event: Electron.IpcMainEvent, bounds: { x: number; y: number; width: number; height: number }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const view = childViews.get(win.id);
  if (!view) return;
  const x = Math.max(0, Math.round(bounds?.x ?? 0));
  const y = Math.max(0, Math.round(bounds?.y ?? 0));
  const width = Math.max(1, Math.round(bounds?.width ?? 1));
  const height = Math.max(1, Math.round(bounds?.height ?? 1));
  try { view.setBounds({ x, y, width, height }); } catch {}
});

// Handle file open request: show dialog, then preview file in right pane
ipcMain.handle('viewer:open-file', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { canceled: true };

  const result = await dialog.showOpenDialog(win, {
    title: 'Select a file to preview',
    properties: ['openFile'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Text', extensions: ['txt', 'log', 'json', 'csv'] }
    ]
  });

  if (result.canceled || !result.filePaths?.length) return { canceled: true };

  const filePath = result.filePaths[0];
  const res = await showCodeInChild(win, filePath);
  return res.ok ? { canceled: false, filePath } : { canceled: true, error: res.error };
});

// Preview a path specification from the renderer (supports baseDir + :line:col, line/col unused for now)
ipcMain.handle('viewer:open-file-spec', async (event: Electron.IpcMainInvokeEvent, payload: { file: string; line?: number; col?: number; baseDir?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const { file, baseDir } = payload || {} as any;
  if (!file) return { ok: false, error: 'no-file' };
  const roots = getAllowedRootsForWindow(win.id);

  // Important: preserve scoped paths like "additional:README.md".
  // Only join against baseDir/workspaceRoot when the incoming value is a normal relative/absolute path.
  const parsed = parseScopedPath(String(file));
  const full = path.isAbsolute(parsed.path)
    ? parsed.path
    : parsed.scope
      ? `${parsed.scope}:${parsed.path}`
      : baseDir
        ? path.resolve(baseDir, parsed.path)
        : path.resolve(roots.workspaceRoot || process.cwd(), parsed.path);

  const resolved = resolvePathInAllowedRoots(roots, full, { intent: 'read' });
  if (!resolved.ok || !resolved.abs) return { ok: false, error: resolved.error || 'invalid-path' };
  const res = await showCodeInChild(win, resolved.abs);
  return res;
});

// Preview a path provided by the renderer (e.g., clicking a filename in the terminal)
ipcMain.handle('viewer:open-path', async (event: Electron.IpcMainInvokeEvent, filePath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  return showCodeInChild(win, filePath);
});

ipcMain.handle('viewer:read-file-base64', async (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!win || !cwd) return { ok: false, error: 'No workspace selected' };
    const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
    if (!rawPath) return { ok: false, error: 'path is required' };
    const roots = getAllowedRootsForWindow(win.id);
    const safe = resolvePathInAllowedRoots(roots, rawPath, { intent: 'read' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    const data = await fs.readFile(safe.abs);
    const base64 = data.toString('base64');
    const ext = (path.extname(safe.abs) || '').toLowerCase();
    const mime = ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.bmp'
              ? 'image/bmp'
              : ext === '.svg'
                ? 'image/svg+xml'
                : 'application/octet-stream';
    return { ok: true, mime, base64, path: safe.rel };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('viewer:show-text', async (event: Electron.IpcMainInvokeEvent, payload: { title?: string; content?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
  if (!title) return { ok: false, error: 'title is required' };
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const view = getChildView(win);
  if (!view) return { ok: false, error: 'no-view' };
  try {
    view.webContents.send('child:show-code', { path: title, content, isDirectory: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error ?? 'failed') };
  }
});

ipcMain.handle('preview:open-url', async (event: Electron.IpcMainInvokeEvent, payload: { url?: string; focus?: boolean; tabId?: string; openNewTab?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'no-window' };
  const url = typeof payload?.url === 'string' ? payload.url : '';
  if (!url) return { ok: false, error: 'url-required' };
  return sendPreviewCommand(win, {
    action: 'navigate',
    params: {
      url,
      focus: payload?.focus,
      tabId: typeof payload?.tabId === 'string' ? payload.tabId : undefined,
      openNewTab: payload?.openNewTab,
    },
  });
});

ipcMain.handle('child:list-files', async (event: Electron.IpcMainInvokeEvent, payload: { dir?: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    const relInput = (payload?.dir ?? '.').trim() || '.';
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, relInput, { intent: 'read' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    const stat = await fs.stat(safe.abs);
    if (!stat.isDirectory()) return { ok: false, error: 'Not a directory' };
    const dirents = await fs.readdir(safe.abs, { withFileTypes: true });
    const entries = dirents
      .filter(de => de.name !== '.DS_Store')
      .map(de => ({ name: de.name, type: de.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return a.type === 'dir' ? -1 : 1;
      });
    const rootsForReturn = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    return { ok: true, entries, path: safe.rel, root: rootsForReturn.workspaceRoot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:read-file', async (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    if (!payload?.path) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, payload.path, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    const data = await fs.readFile(safe.abs);
    const textLike = isTextLikeFile(safe.abs, data);
    if (!textLike) {
      return { ok: true, isBinary: true };
    }
    return { ok: true, content: data.toString('utf8'), encoding: 'utf8', isBinary: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:open-external', async (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    if (!payload?.path) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, payload.path, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    const result = await shell.openPath(safe.abs);
    if (typeof result === 'string' && result.trim()) {
      return { ok: false, error: result.trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:write-file', async (event: Electron.IpcMainInvokeEvent, payload: { path: string; content: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    if (!payload?.path) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, payload.path, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    await fs.mkdir(path.dirname(safe.abs), { recursive: true });
    await fs.writeFile(safe.abs, payload.content, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:create-file', async (event: Electron.IpcMainInvokeEvent, payload: { path: string; content?: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    const target = (payload?.path ?? '').trim();
    if (!target) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, target, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    try {
      await fs.stat(safe.abs);
      return { ok: false, error: 'File already exists' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    }
    await fs.mkdir(path.dirname(safe.abs), { recursive: true });
    await fs.writeFile(safe.abs, payload?.content ?? '', 'utf8');
    return { ok: true, path: safe.rel ?? target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:delete-path', async (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    const target = (payload?.path ?? '').trim();
    if (!target) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, target, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    const stat = await fs.stat(safe.abs);
    if (stat.isDirectory()) {
      await fs.rm(safe.abs, { recursive: true, force: false });
    } else {
      await fs.unlink(safe.abs);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:create-directory', async (event: Electron.IpcMainInvokeEvent, payload: { path: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    const target = (payload?.path ?? '').trim();
    if (!target) return { ok: false, error: 'path is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safe = resolvePathInAllowedRoots(roots, target, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };
    try {
      const existing = await fs.stat(safe.abs);
      if (existing.isDirectory()) return { ok: false, error: 'Directory already exists' };
      return { ok: false, error: 'A file with that name already exists' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    }
    await fs.mkdir(path.dirname(safe.abs), { recursive: true });
    await fs.mkdir(safe.abs, { recursive: false });
    return { ok: true, path: safe.rel ?? target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('child:rename-path', async (event: Electron.IpcMainInvokeEvent, payload: { from: string; to: string }) => {
  try {
    const { win, cwd } = resolveWindowForSender(event.sender);
    if (!cwd) return { ok: false, error: 'No workspace selected' };
    const fromInput = (payload?.from ?? '').trim();
    const toInput = (payload?.to ?? '').trim();
    if (!fromInput) return { ok: false, error: 'from is required' };
    if (!toInput) return { ok: false, error: 'to is required' };
    const roots = win ? getAllowedRootsForWindow(win.id) : { workspaceRoot: cwd, additionalRoot: null, allowExternal: false };
    const safeFrom = resolvePathInAllowedRoots(roots, fromInput, { intent: 'write' });
    if (!safeFrom.ok || !safeFrom.abs) return { ok: false, error: safeFrom.error };
    const safeTo = resolvePathInAllowedRoots(roots, toInput, { intent: 'write' });
    if (!safeTo.ok || !safeTo.abs) return { ok: false, error: safeTo.error };
    if (!roots.allowExternal && safeFrom.root && safeTo.root && safeFrom.root !== safeTo.root) {
      return { ok: false, error: 'Renaming across workspace/additional roots is not supported' };
    }
    if (safeFrom.abs === safeTo.abs) return { ok: true, path: safeTo.rel ?? toInput };
    const stat = await fs.stat(safeFrom.abs);
    if (stat.isDirectory()) {
      return { ok: false, error: 'Renaming directories is not supported yet' };
    }
    try {
      const existing = await fs.stat(safeTo.abs);
      if (existing) return { ok: false, error: 'Destination already exists' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    }
    await fs.mkdir(path.dirname(safeTo.abs), { recursive: true });
    await fs.rename(safeFrom.abs, safeTo.abs);
    return { ok: true, path: safeTo.rel ?? toInput };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Main entry point for inference requests coming from the renderer. The
// handler configures model + workspace options and hands work off to the
// AgentSessionManager, which keeps runs alive independently of the UI.
ipcMain.on('ai:chatStream', async (ipcEvent: IpcMainEvent, payload: {
    messages: OpenAIResponseItem[];
    options?: {
        model?: string;
        preamble?: string;
        workingDir?: string;
        additionalWorkingDir?: string;
        autoMode?: boolean;
        reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
        sessionId?: string;
        resume?: boolean;
        runId?: string;
    };
}) => {
    const options = (payload?.options ?? {}) as Record<string, any>;
    try {
        const wc = ipcEvent.sender;
        const win = BrowserWindow.fromWebContents(wc);
        if (!win) throw new Error('No window for sender');

        const modelFromOptions = options.model;
        const fallbackModel = process.env.BRILLIANTCODE_DEFAULT_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT;
        const model = modelFromOptions || fallbackModel;
        if (!model) throw new Error('Missing model (set BRILLIANTCODE_DEFAULT_MODEL or pass options.model)');

        // OpenAI and Anthropic use user-provided API keys (AI → API Keys…).

        // Working dir: prefer provided, else current known per-window, else process.cwd
        const fallbackWinCwd = windowWorkingDirs.get(win.id) || process.cwd();
        const workingDir = options.workingDir || fallbackWinCwd;
        const resolvedWorkingDir = path.resolve(workingDir);
        const agentMode = windowAgentModes.get(win.id) || 'chat';
        const allowExternal = agentMode === 'agent_full';

        // Additional working directory if provided
        const additionalWorkingDir = options.additionalWorkingDir;
        const resolvedAdditionalDir = additionalWorkingDir ? path.resolve(additionalWorkingDir) : null;

        console.log('AI workingDir chosen:', resolvedWorkingDir, 'additional dir:', resolvedAdditionalDir, 'allowExternal:', allowExternal);

        const autoMode = options.autoMode !== false;
        const resumeOnly = options.resume === true;
        const runId = typeof options.runId === 'string' ? options.runId : undefined;

        // Extend tool schema and handlers with environment-aware actions
        const extraToolsSchema = [
          {
            type: 'function',
            name: 'set_preview_url',
            description: 'Navigate the right-hand Preview panel to a URL or local file path, optionally targeting a specific browser tab.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', description: 'http(s) URL, file:// URL, or workspace-relative path.' },
                focus: { type: 'boolean', description: 'Whether to switch UI to the Preview tab (default true).' },
                tabId: { type: 'string', description: 'Existing preview tab id to reuse. When omitted, the active tab is used.' },
                openNewTab: { type: 'boolean', description: 'If true, open the URL in a new tab (returned tabId represents the new tab).' },
              },
              required: ['url'],
            },
          },
          {
            type: 'function',
            name: 'list_preview_tabs',
            description: 'List all open preview browser tabs (id, title, current URL).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {},
            },
          },
          {
            type: 'function',
            name: 'get_active_preview_tab',
            description: 'Return the currently active preview browser tab (id, title, URL).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {},
            },
          },
          {
            type: 'function',
            name: 'activate_preview_tab',
            description: 'Activate an existing preview browser tab.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tabId: { type: 'string', description: 'Preview tab id to activate.' },
                focus: { type: 'boolean', description: 'Whether to switch UI to the Preview tab (default true).' },
              },
              required: ['tabId'],
            },
          },
          {
            type: 'function',
            name: 'close_preview_tab',
            description: 'Close a preview browser tab by id.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tabId: { type: 'string', description: 'Preview tab id to close.' },
                focus: { type: 'boolean', description: 'Whether to switch UI to the Preview tab after closing (default true).' },
              },
              required: ['tabId'],
            },
          },
          {
            type: 'function',
            name: 'refresh_preview_tab',
            description: 'Reload the current URL in a preview browser tab.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tabId: { type: 'string', description: 'Preview tab id to refresh (defaults to active tab).' },
                focus: { type: 'boolean', description: 'Whether to switch UI to the Preview tab (default true).' },
              },
            },
          },
          {
            type: 'function',
            name: 'preview_file',
            description: 'Preview a local file in the right-hand panel (HTML, image, PDF, or text).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
              },
              required: ['path'],
            },
          },
          {
            type: 'function',
            name: 'terminal_input',
            description: 'Send raw input to the integrated terminal PTY (use \r for Enter if needed). Use this for long-running, interactive, or state-changing commands (servers, watchers, installers).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', description: 'Text to write to PTY.' },
                newline: { type: 'boolean', description: 'Append a carriage return (Enter) after text.' },
                terminal_id: { type: 'string', description: 'Target terminal id (default "default").' },
              },
              required: ['text'],
            },
          },
          {
            type: 'function',
            name: 'read_terminal',
            description: 'Read recent output from the integrated terminal (tail).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                lines: { type: 'number', description: 'Number of trailing lines to return (default 200). Ignored if bytes is provided.' },
                bytes: { type: 'number', description: 'Number of trailing bytes to return.' },
                stripAnsi: { type: 'boolean', description: 'Strip ANSI escape sequences (default true).' },
                terminal_id: { type: 'string', description: 'Target terminal id (default "default").' },
              },
            },
          },
          {
            type: 'function',
            name: 'summarize_terminal_output',
            description: 'Read recent output from the integrated terminal and summarize it into a few actionable lines (uses gpt-5-mini).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                prompt: { type: 'string', description: 'What you want from the summary (e.g., errors + next steps, URLs/ports, warnings, etc.).' },
                lines: { type: 'number', description: 'Number of trailing lines to summarize (default 200). Ignored if bytes is provided.' },
                bytes: { type: 'number', description: 'Number of trailing bytes to summarize.' },
                stripAnsi: { type: 'boolean', description: 'Strip ANSI escape sequences (default true).' },
                terminal_id: { type: 'string', description: 'Target terminal id (default "default").' },
              },
              required: ['prompt'],
            },
          },
          {
            type: 'function',
            name: 'create_terminal',
            description: 'Create a new integrated terminal PTY and return its identifier. Use a dedicated terminal for servers, watchers, or any long-running tasks.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cwd: { type: 'string', description: 'Workspace-relative path to start in (default current working directory).' },
                cols: { type: 'number', description: 'Initial terminal columns (default 80).' },
                rows: { type: 'number', description: 'Initial terminal rows (default 24).' },
              },
            },
          },
          {
            type: 'function',
            name: 'close_terminal',
            description: 'Close/dispose an integrated terminal PTY by id. Use to clean up terminals that are no longer needed. The default terminal cannot be closed.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                terminal_id: { type: 'string', description: 'Terminal id to close (required). Cannot close the "default" terminal.' },
              },
              required: ['terminal_id'],
            },
          },
          {
            type: 'function',
            name: 'get_preview_info',
            description: 'Return the current Preview webview URL, title and recent navigation history.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                historyCount: { type: 'number', description: 'Max number of recent navigations to return (default 10).' },
              },
            },
          },
          {
            type: 'function',
            name: 'screenshot_preview',
            description: 'Capture a screenshot of the child Preview webview (PNG).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fullPage: { type: 'boolean', description: 'Currently same as viewport (webview bounds).' },
              },
              required: [],
            },
          },
          {
            type: 'function',
            name: 'visit_url',
            description: 'Visit a URL using the built-in preview browser and return a screenshot, text, and links.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', description: 'The http(s) URL of the website to visit.' },
              },
              required: ['url'],
            },
          },
          {
            type: 'function',
            name: 'detect_dev_server',
            description: 'Inspect recent terminal output for running dev servers and return discovered localhost URLs/ports and framework hints.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bytes: { type: 'number', description: 'Scan last N bytes of terminal output (default 120000).' },
                terminal_id: { type: 'string', description: 'Terminal id to inspect (default "default").' },
              },
            },
          },
        ] as any[];

        const extraHandlers: Record<string, (args: any) => Promise<any>> = {
          set_preview_url: async (args: { url: string; focus?: boolean; tabId?: string; openNewTab?: boolean }) => {
            const url = typeof args?.url === 'string' ? args.url : '';
            if (!url.trim()) return { ok: false, error: 'url is required' };
            if (url.startsWith('workspace://')) {
              const resolved = resolveWorkspacePreviewUrl(win, url);
              if (!resolved.ok || !resolved.url) {
                return { ok: false, error: resolved.error || 'Invalid workspace URL' };
              }
              return await sendPreviewCommand(win, {
                action: 'navigate',
                params: {
                  url: resolved.url,
                  focus: args?.focus,
                  tabId: typeof args?.tabId === 'string' ? args.tabId : undefined,
                  openNewTab: args?.openNewTab,
                },
              });
            }
            return await sendPreviewCommand(win, {
              action: 'navigate',
              params: {
                url,
                focus: args?.focus,
                tabId: typeof args?.tabId === 'string' ? args.tabId : undefined,
                openNewTab: args?.openNewTab,
              },
            });
          },
          list_preview_tabs: async () => sendPreviewCommand(win, { action: 'list' }),
          get_active_preview_tab: async () => sendPreviewCommand(win, { action: 'get_active' }),
          activate_preview_tab: async (args: { tabId: string; focus?: boolean }) => {
            const tabId = typeof args?.tabId === 'string' ? args.tabId : '';
            if (!tabId.trim()) return { ok: false, error: 'tabId is required' };
            return await sendPreviewCommand(win, { action: 'activate', params: { tabId, focus: args?.focus } });
          },
          close_preview_tab: async (args: { tabId: string; focus?: boolean }) => {
            const tabId = typeof args?.tabId === 'string' ? args.tabId : '';
            if (!tabId.trim()) return { ok: false, error: 'tabId is required' };
            return await sendPreviewCommand(win, { action: 'close', params: { tabId, focus: args?.focus } });
          },
          refresh_preview_tab: async (args: { tabId?: string; focus?: boolean }) => {
            return await sendPreviewCommand(win, {
              action: 'refresh',
              params: {
                tabId: typeof args?.tabId === 'string' ? args.tabId : undefined,
                focus: args?.focus,
              },
            });
          },
          preview_file: async (args: { path: string }) => {
            const p = String(args?.path ?? '');
            if (!p) return { ok: false, error: 'path is required' };

            // If this looks like a local path (workspace/additional relative or absolute), resolve it first.
            if (p.startsWith('workspace://')) {
              const resolved = resolveWorkspacePreviewUrl(win, p);
              if (!resolved.ok || !resolved.url) {
                return { ok: false, error: resolved.error || 'Invalid workspace URL' };
              }
              const result = await sendPreviewCommand(win, { action: 'navigate', params: { url: resolved.url, focus: true } });
              if (result?.ok) return result;
              return await previewPathInView(win, resolved.abs || resolved.url);
            }
            const looksLikeUrl = /^([a-z][a-z0-9+.-]*):\/\//i.test(p);
            if (!looksLikeUrl) {
              const roots = getAllowedRootsForWindow(win.id);
              const safe = resolvePathInAllowedRoots(roots, p, { intent: 'read' });
              if (safe.ok && safe.abs && fsSync.existsSync(safe.abs)) {
                const ext = path.extname(safe.abs).toLowerCase();
                const asUrl = PREVIEWABLE_FILE_EXTS.has(ext)
                  ? pathToFileURL(safe.abs).toString()
                  : safe.abs;
                const result = await sendPreviewCommand(win, { action: 'navigate', params: { url: asUrl, focus: true } });
                if (result?.ok) return result;
                return await previewPathInView(win, safe.abs);
              }
            }

            const result = await sendPreviewCommand(win, { action: 'navigate', params: { url: p, focus: true } });
            if (result?.ok) return result;
            // Fallback to direct preview loader if the preview panel rejected the request
            return await previewPathInView(win, p);
          },
          terminal_input: async (args: { text: string; newline?: boolean; terminal_id?: string }) => {
            const t = String(args?.text ?? '');
            if (!t) return { ok: false, error: 'text is required' };
            const terminalId = typeof args?.terminal_id === 'string' && args.terminal_id.trim()
              ? args.terminal_id.trim()
              : DEFAULT_TERMINAL_ID;
            const record = getTerminalRecord(win.id, terminalId);
            if (!record) return { ok: false, error: `terminal ${terminalId} not found` };
            try {
              const data = args?.newline ? (t + '\r') : t;
              record.pty.write(data);
              return { ok: true, terminalId };
            } catch (e: any) {
              return { ok: false, error: e?.message || String(e) };
            }
          },
          read_terminal: async (args: { lines?: number; bytes?: number; stripAnsi?: boolean; terminal_id?: string }) => {
            const terminalId = typeof args?.terminal_id === 'string' && args.terminal_id.trim()
              ? args.terminal_id.trim()
              : DEFAULT_TERMINAL_ID;
            const raw = readTermText(win.id, terminalId) || '';
            const strip = args?.stripAnsi !== false;
            const normalized = (() => {
              const s = strip
                ? raw.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI
                      .replace(/\u001b\][^\u0007]*\u0007/g, '')       // OSC
                      .replace(/\u001b[PX^_].*?\u001b\\/g, '')        // DCS/PM/APC
                : raw;
              // Normalize CRLF/CR to LF for line splitting
              return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            })();
            let text = normalized;
            let used: 'bytes' | 'lines' | 'all' = 'all';
            if (Number.isFinite(args?.bytes) && (args?.bytes as number) > 0) {
              const b = Math.floor(args?.bytes as number);
              text = normalized.slice(-b);
              used = 'bytes';
            } else {
              const n = Number.isFinite(args?.lines) && (args?.lines as number) > 0 ? Math.floor(args?.lines as number) : 200;
              const parts = normalized.split('\n');
              text = parts.slice(-n).join('\n');
              used = 'lines';
            }
            const totalLength = text.length;
            const clamp = clampToolText(text, TERMINAL_TEXT_LIMIT);
            return {
              ok: true,
              mode: used,
              text: clamp.text,
              terminalId,
              truncated: clamp.clamped,
              omittedChars: clamp.omitted,
              totalLength,
            };
          },
          summarize_terminal_output: async (args: { prompt: string; lines?: number; bytes?: number; stripAnsi?: boolean; terminal_id?: string }) => {
            const instruction = String(args?.prompt ?? '').trim();
            if (!instruction) return { ok: false, error: 'prompt is required' };

            const terminalId = typeof args?.terminal_id === 'string' && args.terminal_id.trim()
              ? args.terminal_id.trim()
              : DEFAULT_TERMINAL_ID;

            const raw = readTermText(win.id, terminalId) || '';
            const strip = args?.stripAnsi !== false;
            const normalized = (() => {
              const s = strip
                ? raw.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI
                      .replace(/\u001b\][^\u0007]*\u0007/g, '')       // OSC
                      .replace(/\u001b[PX^_].*?\u001b\\/g, '')        // DCS/PM/APC
                : raw;
              // Normalize CRLF/CR to LF for line splitting
              return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            })();

            let text = normalized;
            let used: 'bytes' | 'lines' | 'all' = 'all';
            if (Number.isFinite(args?.bytes) && (args?.bytes as number) > 0) {
              const b = Math.floor(args?.bytes as number);
              text = normalized.slice(-b);
              used = 'bytes';
            } else {
              const n = Number.isFinite(args?.lines) && (args?.lines as number) > 0 ? Math.floor(args?.lines as number) : 200;
              const parts = normalized.split('\n');
              text = parts.slice(-n).join('\n');
              used = 'lines';
            }

            const totalLength = text.length;
            const clamp = clampToolText(text, TERMINAL_TEXT_LIMIT);
            const terminalText = clamp.text;

            if (!terminalText.trim()) {
              return 'No recent terminal output to summarize.';
            }

            const SUMMARIZER_SYSTEM_PROMPT = `You are a terminal output summarizer for an AI coding agent.\n\nYour job: read the terminal output and produce a concise, actionable summary.\n\nRules:\n- Output 3–8 bullet points (plain text).\n- Lead with overall result (success/failure) and the most important errors/warnings.\n- Include concrete next steps (commands to run, files to inspect, config changes) when relevant.\n- Extract key details like package/script names, versions, paths, URLs/ports, and error codes.\n- Do NOT paste large logs. Quote only the minimal error line(s) needed.\n- If there is nothing important, output a single bullet: "- No issues detected."`;

            const userPrompt = [
              'Summarization request from the agent:',
              instruction,
              '',
              `Terminal output (most recent; mode=${used}; terminal_id=${terminalId}; truncated=${clamp.clamped ? 'true' : 'false'}):`,
              '```',
              terminalText,
              '```',
            ].join('\n');

            try {
              const response = await client.responses.create({
                model: 'gpt-5-mini',
                input: [
                  { role: 'developer', content: SUMMARIZER_SYSTEM_PROMPT },
                  { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                ],
                max_output_tokens: 350,
              });

              let summaryText = '';
              if (response.output_text) {
                summaryText = response.output_text;
              } else if (Array.isArray(response.output)) {
                for (const item of response.output) {
                  if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const part of item.content) {
                      if (part.type === 'output_text' || part.type === 'text') {
                        summaryText += part.text || '';
                      }
                    }
                  }
                }
              }

              summaryText = summaryText.trim();
              if (!summaryText) {
                throw new Error('Empty summary response from model');
              }

              if (clamp.clamped) {
                summaryText += `\n- Note: terminal input was truncated by ${clamp.omitted} characters (total selected length: ${totalLength}).`;
              }

              return summaryText;
            } catch (e: any) {
              const msg = e?.message || String(e);
              return `Error: Failed to summarize terminal output: ${msg}`;
            }
          },
          create_terminal: async (args: { cwd?: string; cols?: number; rows?: number }) => {
            const cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
            const cols = Number.isFinite(args?.cols) ? Math.floor(args!.cols as number) : undefined;
            const rows = Number.isFinite(args?.rows) ? Math.floor(args!.rows as number) : undefined;
            const result = createTerminalForWindow(win, { cwd, cols, rows });
            if (!result.ok) {
              return { ok: false, error: result.error || 'Failed to create terminal' };
            }
            const id = result.id ?? 'unknown';
            const base = windowWorkingDirs.get(win.id) || process.cwd();
            const cwdDisplay = result.cwd ? (() => {
              const rel = path.relative(base, result.cwd as string);
              return rel && !rel.startsWith('..') ? (rel || '.') : result.cwd;
            })() : '';
            try { win.webContents.send('ai:notice', { text: `Created terminal ${id}${cwdDisplay ? ` (cwd ${cwdDisplay})` : ''}` }); } catch {}
            return { ok: true, terminalId: id, cwd: result.cwd };
          },
          close_terminal: async (args: { terminal_id: string }) => {
            const terminalId = typeof args?.terminal_id === 'string' ? args.terminal_id.trim() : '';
            if (!terminalId) return { ok: false, error: 'terminal_id is required' };
            if (terminalId === DEFAULT_TERMINAL_ID) return { ok: false, error: 'The default terminal cannot be closed' };
            const record = getTerminalRecord(win.id, terminalId);
            if (!record) return { ok: false, error: `Terminal "${terminalId}" not found` };
            try {
              // We suppress the default exit notice (exit message text) but MUST still notify the UI
              // so the terminal tab is removed.
              suppressTerminalExitNotice(win.id, terminalId);
              try { record.pty.kill(); } catch {}

              // Proactively remove the record/buffer and emit terminal:closed now.
              const map = windowTerminals.get(win.id);
              map?.delete(terminalId);
              const winBuf = windowTermBufs.get(win.id);
              winBuf?.delete(terminalId);
              notifyTerminalClosed(win, terminalId);

              try { win.webContents.send('ai:notice', { text: `Closed terminal ${terminalId}` }); } catch {}
              return { ok: true, terminalId, message: `Terminal "${terminalId}" closed successfully` };
            } catch (e: any) {
              return { ok: false, error: e?.message || String(e) };
            }
          },
          get_preview_info: async (args: { historyCount?: number }) => {
            const cur = currentPreviewByWindow.get(win.id) || { url: '', title: undefined, ts: 0 };
            const historyCount = Number.isFinite(args?.historyCount) && (args!.historyCount as number) > 0 ? Math.floor(args!.historyCount as number) : 10;
            const history = windowPreviewHistory.get(win.id) || [];
            const hist = historyCount > 0 ? history.slice(-historyCount) : history.slice();
            const url = String(cur.url || '');
            const m = url.match(/:\/\/(?:\[[^\]]+\]|[^:/]+):(\d{2,5})/);
            const port = m ? Number(m[1]) : undefined;
            return { ok: true, url, title: cur.title || '', port, history: hist };
          },
          screenshot_preview: async (_args: { fullPage?: boolean }) => {
            const wc = webviewByWindow.get(win.id);
            if (!wc) return { ok: false, error: 'no-webview' };
            try {
              const img = await wc.capturePage();
              const base64 = img.toPNG().toString('base64');
              return { ok: true, mime: 'image/png', data: base64, message: 'Screenshot captured.' };
            } catch (e: any) {
              return { ok: false, error: e?.message || String(e) };
            }
          },
          visit_url: async (args: { url: string }) => {
            const raw = typeof args?.url === 'string' ? args.url : '';
            const url = raw.trim();
            if (!url) return { ok: false, error: 'url is required' };
            if (!/^https?:\/\//i.test(url)) {
              return { ok: false, error: 'url must start with http:// or https:// for safety' };
            }

            // Ask the preview panel to navigate first (respects tab management)
            const navResult = await sendPreviewCommand(win, {
              action: 'navigate',
              params: { url, focus: true },
            });
            if (!navResult || navResult.ok === false) {
              return { ok: false, error: navResult?.error || 'Failed to navigate preview' };
            }

            const wc = webviewByWindow.get(win.id);
            if (!wc) return { ok: false, error: 'no-webview' };

            try {
              // Capture screenshot
              const img = await wc.capturePage();
              const base64 = img.toPNG().toString('base64');

              // Extract text + links from the page context
              const pageData = await wc.executeJavaScript(
                `(() => {
                  try {
                    const clone = document.body ? document.body.cloneNode(true) : null;
                    if (!clone) return { text: '', links: [] };
                    const removeTags = ['script', 'style', 'svg', 'noscript', 'link'];
                    for (const tag of removeTags) {
                      const nodes = clone.querySelectorAll(tag);
                      nodes.forEach((el) => el.remove());
                    }
                    const text = clone.innerText || '';
                    const anchors = Array.from(clone.querySelectorAll('a'));
                    const links = anchors.map((el) => ({
                      text: (el.innerText || '').trim(),
                      href: el.getAttribute('href'),
                    }));
                    return { text, links };
                  } catch (e) {
                    return { text: '', links: [], error: String(e) };
                  }
                })();`,
                true,
              );

              const text = typeof pageData?.text === 'string' ? pageData.text : '';
              const links = Array.isArray(pageData?.links) ? pageData.links : [];

              return {
                ok: true,
                url,
                mime: 'image/png',
                data: base64,
                text,
                links,
              };
            } catch (e: any) {
              return { ok: false, error: e?.message || String(e) };
            }
          },
          detect_dev_server: async (args: { bytes?: number; terminal_id?: string }) => {
            const terminalId = typeof args?.terminal_id === 'string' && args.terminal_id.trim()
              ? args.terminal_id.trim()
              : DEFAULT_TERMINAL_ID;
            const raw = readTermText(win.id, terminalId) || '';
            const stripAnsi = (s: string) => s
              .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI
              .replace(/\u001b\][^\u0007]*\u0007/g, '')       // OSC
              .replace(/\u001b[PX^_].*?\u001b\\/g, '');       // DCS/PM/APC
            const text = stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const maxB = Number.isFinite(args?.bytes) && (args!.bytes as number) > 0 ? Math.floor(args!.bytes as number) : 120000;
            const slice = text.slice(-maxB);
            const urls = new Set<string>();
            const re = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\])(?::(\d{2,5}))?(?:\/[\w\-./?%&=+#]*)?)/gi;
            let m1: RegExpExecArray | null;
            while ((m1 = re.exec(slice)) !== null) {
              urls.add(m1[1].replace('0.0.0.0', 'localhost'));
            }
            // Heuristics for framework guess
            const lower = slice.toLowerCase();
            const guess = lower.includes('vite') ? 'vite'
              : lower.includes('next') ? 'nextjs'
              : lower.includes('webpack') ? 'webpack'
              : lower.includes('remix') ? 'remix'
              : lower.includes('astro') ? 'astro'
              : lower.includes('nuxt') ? 'nuxt'
              : lower.includes('angular') || lower.includes('ng serve') ? 'angular'
              : undefined;
            const list = Array.from(urls).map(u => {
              const pm = u.match(/:(\d{2,5})/);
              return { url: u, port: pm ? Number(pm[1]) : undefined };
            });
            return { ok: true, guess, endpoints: list, terminalId };
          },
        };

        const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
        if (!sessionId) throw new Error('Missing sessionId');

        // Merge schema and handlers per-window, including MCP servers (if connected)
        try { await mcpHost.prepare(win.id, resolvedWorkingDir); } catch {}
        const mcpAdapters = mcpHost.adaptersForWindow(win.id);
        const mergedSchema = sortToolsByName([...toolsSchema, ...extraToolsSchema, ...mcpAdapters.schema]);
        const baseToolHandlers = createToolHandlers({
          workspaceRoot: resolvedWorkingDir,
          additionalRoot: resolvedAdditionalDir,
          allowExternal,
          sessionId,
        });
        const mergedHandlers = { ...baseToolHandlers, ...extraHandlers, ...mcpAdapters.handlers };

        const newItems = Array.isArray(payload?.messages) ? (payload?.messages as OpenAIResponseItem[]) : [];
        const titleSeed = deriveTitleFromHistory(newItems);

        agentSessionManager.attach(sessionId, wc, win.id);

        if (!resumeOnly) {
          await agentSessionManager.run({
            sessionId,
            workingDir: resolvedWorkingDir,
            additionalWorkingDir: resolvedAdditionalDir || undefined,
            model,
            autoMode,
            client,
            toolsSchema: mergedSchema,
            toolHandlers: mergedHandlers,
            newItems,
            title: titleSeed || undefined,
            preamble: options.preamble,
            reasoningEffort: options.reasoning_effort,
            runId,
          });
        }
    } catch (err: unknown) {
        const msg = (err && typeof err === 'object' && 'message' in (err as object))
            ? String((err as { message?: unknown }).message)
            : String(err);
        const errorSessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
        const errorRunId = typeof options.runId === 'string' ? options.runId : undefined;
        const envelope = errorSessionId
            ? { sessionId: errorSessionId, runId: errorRunId, payload: msg }
            : msg;
        try { ipcEvent.sender.send('ai:chatStream:error', envelope); } catch {}
    }
});

ipcMain.on('ai:stop', (ipcEvent: IpcMainEvent, payload: { sessionId?: string }) => {
  try {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return;
    agentSessionManager.stop(sessionId);

    // If the UI is showing a persisted "running" state but there is no live run
    // (common after app restart), reconcile the stored runtime so the session
    // doesn't remain permanently "running".
    const { cwd } = resolveWindowForSender(ipcEvent.sender);
    if (!cwd) return;
    void (async () => {
      try {
        const liveStatus = agentSessionManager.getStatus(sessionId).status;
        if (liveStatus === 'running') return;
        const session = await chatStore.get(cwd, sessionId);
        const runtimeStatusRaw = (session as any)?.runtime?.status;
        const runtimeStatus = typeof runtimeStatusRaw === 'string' ? runtimeStatusRaw.toLowerCase() : '';
        if (runtimeStatus !== 'running') return;
        const now = Date.now();
        const startedAtRaw = Number((session as any)?.runtime?.startedAt) || Number((session as any)?.runtime?.updatedAt) || now;
        await chatStore.updateRuntime(cwd, sessionId, {
          status: 'error',
          startedAt: startedAtRaw,
          completedAt: now,
          updatedAt: now,
        });
      } catch {}
    })();
  } catch {}
});

// Allow renderer to cancel a running tool by call id so long-running commands
// respect the cancel button in the UI.
ipcMain.on('ai:tool:cancel', (_event: IpcMainEvent, payload: { sessionId?: string; callId?: string }) => {
  try {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    const callId = typeof payload?.callId === 'string' ? payload.callId : '';
    if (!sessionId || !callId) return;
    agentSessionManager.cancelTool(sessionId, callId);
  } catch {}
});

ipcMain.on('ai:confirm:response', (_event: IpcMainEvent, payload: { sessionId?: string; id?: string; allow?: boolean }) => {
  try {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    const confirmationId = typeof payload?.id === 'string' ? payload.id : '';
    if (!sessionId || !confirmationId) return;
    agentSessionManager.handleConfirmationResponse(sessionId, confirmationId, !!payload?.allow);
  } catch {}
});

ipcMain.handle('ai:session:attach', async (event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string }) => {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  const wc = event.sender;
  const win = BrowserWindow.fromWebContents(wc);
  if (!win) return { ok: false, error: 'No window for sender' };
  agentSessionManager.attach(sessionId, wc, win.id);
  return { ok: true };
});

ipcMain.handle('ai:session:detach', async (event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string }) => {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  const wc = event.sender;
  agentSessionManager.detach(sessionId, wc.id);
  return { ok: true };
});

ipcMain.handle('ai:session:status', async (_event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string }) => {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  const status = agentSessionManager.getStatus(sessionId);
  return { ok: true, status };
});

async function bootstrapApplication(): Promise<void> {
  await createWindow();
}

app.whenReady().then(async () => {
  try {
    app.setName(BRAND_NAME);
    if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
      try { app.setAppUserModelId(BRAND_NAME); } catch (error) {
        console.warn('Failed to set Windows AppUserModelID.', error);
      }
    }

    if (fsSync.existsSync(BRAND_ICON_PATH)) {
      const icon = nativeImage.createFromPath(BRAND_ICON_PATH);
      BRAND_ICON_IMAGE = icon.isEmpty() ? null : icon;
      if (process.platform === 'darwin' && app.dock && BRAND_ICON_IMAGE) {
        try { app.dock.setIcon(BRAND_ICON_IMAGE); } catch (error) {
          console.warn('Failed to set dock icon.', error);
        }
      }
    } else {
      console.warn(`Brand icon not found at ${BRAND_ICON_PATH}`);
    }
    if (typeof app.setAboutPanelOptions === 'function') {
      app.setAboutPanelOptions({
        applicationName: BRAND_NAME,
        applicationVersion: app.getVersion(),
        website: BRAND_SITE,
        copyright: `© ${new Date().getFullYear()} Brilliant AI`,
        iconPath: fsSync.existsSync(BRAND_ICON_PATH) ? BRAND_ICON_PATH : undefined,
      });
    }
  } catch (error) {
    console.warn('Failed to configure app branding.', error);
  }

  try {
    const custom = await getCustomModelsFromSettings();
    setCustomModels(custom);
  } catch (error) {
    console.warn('Failed to load custom models:', error);
  }

  try {
    const hidden = await getHiddenModelsFromSettings();
    hiddenModelKeys = new Set(hidden);
  } catch (error) {
    console.warn('Failed to load hidden models:', error);
  }

  await bootstrapApplication();
  while (pendingStartupOpenUrls.length) {
    pendingStartupOpenUrls.shift();
  }
  try { buildAndSetMenu(); } catch {}
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    try { BrowserWindow.getAllWindows().forEach(w => { try { mcpHost.stopAll(w.id); } catch {} }); } catch {}
    app.quit();
  }
});

// Image picker for attachments: returns base64 image data to the renderer
ipcMain.handle('ai:pick-images', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, canceled: true };
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach Images',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }
    ]
  });
  if (res.canceled || !res.filePaths?.length) return { ok: true, canceled: true, files: [] };

  const mimeForExt = (filePath: string): string => {
    const ext = (path.extname(filePath) || '').toLowerCase();
    switch (ext) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif': return 'image/gif';
      case '.webp': return 'image/webp';
      case '.bmp': return 'image/bmp';
      case '.svg': return 'image/svg+xml';
      default: return 'application/octet-stream';
    }
  };

  try {
    const files = await Promise.all(res.filePaths.map(async (fp) => {
      const data = await fs.readFile(fp);
      const base64 = data.toString('base64');
      return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: path.basename(fp),
        path: fp,
        mime: mimeForExt(fp),
        base64,
      };
    }));
    return { ok: true, canceled: false, files };
  } catch (e: any) {
    return { ok: false, canceled: true, error: e?.message || String(e) };
  }
});

// Workspace (working folder) selection + persistence flows surfaced in the
// renderer sidebar. The active path is stored on the BrowserWindow map and is
// also persisted to disk for the next launch.
async function assignWorkspaceToWindow(win: Electron.BrowserWindow, cwd: string, opts: { persist?: boolean } = {}): Promise<string> {
  const norm = path.resolve(cwd);
  windowWorkingDirs.set(win.id, norm);
  try { await mcpHost.prepare(win.id, norm); } catch {}
  try { resetDefaultTerminal(win, norm); } catch (error) {
    console.warn('Failed to reset default terminal for workspace:', error);
  }
  if (opts.persist !== false) {
    try {
      const current = await loadSettings();
      current.lastWorkingDir = norm;
      await saveSettings(current);
    } catch (error) {
      console.warn('Failed to persist workspace setting:', error);
    }
  }
  const child = childViews.get(win.id);
  try { child?.webContents.send('workspace:changed', norm); } catch {}
  return norm;
}

ipcMain.handle('workspace:get', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false };
  const cwd = windowWorkingDirs.get(win.id) || process.cwd();
  let persisted = false;
  try {
    const s = await loadSettings();
    persisted = !!(s.lastWorkingDir && fsSync.existsSync(s.lastWorkingDir));
  } catch {}
  return { ok: true, cwd, persisted };
});

ipcMain.handle('workspace:choose', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, canceled: true };
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Working Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  const chosen = res.filePaths[0];
  const assigned = await assignWorkspaceToWindow(win, chosen);
  return { ok: true, cwd: assigned };
});

// Pick a folder without changing the main workspace (for additional directories)
ipcMain.handle('workspace:pickFolder', async (event: Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, canceled: true };
  const res = await dialog.showOpenDialog(win, {
    title: 'Select Additional Working Directory',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('workspace:set', async (event: Electron.IpcMainInvokeEvent, cwd: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !cwd) return { ok: false };
  const assigned = await assignWorkspaceToWindow(win, cwd);
  return { ok: true, cwd: assigned };
});

ipcMain.handle('workspace:create-project', async (event: Electron.IpcMainInvokeEvent, payload: { name?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: 'No active window.' };

  const rawName = typeof payload?.name === 'string' ? payload.name : '';
  const trimmed = rawName.trim();
  if (!trimmed) return { ok: false, error: 'Project name is required.' };

  const stripped = trimmed.replace(/[^a-zA-Z0-9-_ ]+/g, '');
  const dashed = stripped.replace(/\s+/g, '-');
  let sanitized = dashed.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!sanitized) return { ok: false, error: 'Project name must include letters or numbers.' };
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    return { ok: false, error: 'Project name is reserved. Choose another name.' };
  }
  if (sanitized.length > 80) {
    sanitized = sanitized.slice(0, 80);
  }

  let homeDir = '';
  try { homeDir = os.homedir(); } catch {}
  if (!homeDir) return { ok: false, error: 'Unable to resolve home directory.' };

  const baseDir = path.join(homeDir, 'brilliantcode_projects');
  const projectPath = path.join(baseDir, sanitized);

  try {
    await fs.mkdir(baseDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return { ok: false, error: `Failed to prepare projects folder: ${message || 'Unknown error.'}` };
  }

  try {
    await fs.mkdir(projectPath, { recursive: false });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EEXIST') {
      return { ok: false, error: 'A project with that name already exists.' };
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return { ok: false, error: message || 'Failed to create project directory.' };
  }

  const assigned = await assignWorkspaceToWindow(win, projectPath);
  return { ok: true, cwd: assigned };
});

ipcMain.handle('workspace:baseline:capture', async (event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string; runId?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  if (!runId) return { ok: false, error: 'runId is required' };
  return ensureWorkspaceBaseline(cwd, sessionId, runId);
});

ipcMain.handle('workspace:changes', async (event: Electron.IpcMainInvokeEvent, payload?: { sessionId?: string; runId?: string; limit?: number; offset?: number }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!win || !cwd) return { ok: false, error: 'No window' };

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : undefined;
  if (sessionId && runId) {
    const limit = payload?.limit === undefined ? 20 : Math.max(0, Math.floor(Number(payload.limit) || 0));
    const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
    const baseline = await computeWorkspaceBaselineChanges(cwd, sessionId, runId, { limit, offset });
    if (!baseline.ok) return { ok: false, error: baseline.error || 'Failed to compute baseline changes' };
    const totals = baseline.totals || { files: 0, additions: 0, deletions: 0 };
    const files = (baseline.files || []) as GitChangeFile[];
    const fingerprint = typeof baseline.fingerprint === 'string' && baseline.fingerprint ? baseline.fingerprint : stableFingerprintForWorkspaceChanges(files, totals);
    return {
      ok: true,
      git: false,
      files,
      totals,
      fingerprint,
      page: { offset, limit, hasMore: offset + files.length < totals.files },
    };
  }

  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return { ok: true, git: false, files: [], totals: { files: 0, additions: 0, deletions: 0 } };
  }

  const statusRes = runGit(cwd, ['status', '--porcelain=v1', '-z']);
  if (!statusRes.ok) {
    return { ok: false, error: statusRes.stderr || 'Failed to read git status', git: true };
  }

  const entries = parseGitPorcelainZ(statusRes.stdout);
  const roots = getAllowedRootsForWindow(win.id);
  const files: GitChangeFile[] = [];
  let totalAdd = 0;
  let totalDel = 0;

  for (const entry of entries) {
    const relPath = entry.path;
    const safe = resolvePathInAllowedRoots(roots, relPath, { intent: 'read' });
    if (!safe.ok || !safe.abs) continue;

    const status = entry.status || '?';
    if (status === '?') {
      const lineCount = await countFileLines(safe.abs);
      files.push({ path: relPath, status: '?', additions: lineCount, deletions: 0 });
      totalAdd += lineCount;
      continue;
    }

    const num = runGit(cwd, ['diff', '--numstat', 'HEAD', '--', relPath]);
    const stats = num.ok ? parseNumstat(num.stdout) : null;
    const additions = stats?.additions ?? null;
    const deletions = stats?.deletions ?? null;
    files.push({ path: relPath, status, additions, deletions });
    if (typeof additions === 'number') totalAdd += additions;
    if (typeof deletions === 'number') totalDel += deletions;
  }

  const totals = { files: files.length, additions: totalAdd, deletions: totalDel };
  const limit = payload?.limit === undefined ? 20 : Math.max(0, Math.floor(Number(payload.limit) || 0));
  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const page = limit === 0 ? [] : files.slice(offset, offset + limit);
  const fingerprint = stableFingerprintForWorkspaceChanges(files, totals);
  return { ok: true, git: true, files: page, totals, fingerprint, page: { offset, limit, hasMore: offset + page.length < totals.files } };
});

ipcMain.handle('workspace:diff', async (event: Electron.IpcMainInvokeEvent, payload: { path?: string; sessionId?: string; runId?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!win || !cwd) return { ok: false, error: 'No window' };

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  if (sessionId && runId) {
    const res = await diffWorkspaceBaseline(cwd, sessionId, runId, typeof payload?.path === 'string' ? payload.path.trim() : undefined);
    return res;
  }

  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'Not a git repository' };

  const pathArg = typeof payload?.path === 'string' ? payload.path.trim() : '';
  const args = ['diff', '--patch', '--no-color', '--unified=3', 'HEAD', '--'];
  if (pathArg) args.push(pathArg);
  const diff = runGit(cwd, args, { timeoutMs: 15_000 });
  if (diff.ok && diff.stdout) return { ok: true, diff: diff.stdout };

  if (pathArg) {
    const noIndex = runGit(cwd, ['diff', '--no-index', '--patch', '--no-color', '--unified=3', '/dev/null', '--', pathArg], { timeoutMs: 15_000 });
    if (noIndex.ok) return { ok: true, diff: noIndex.stdout };
  }

  return { ok: false, error: diff.stderr || 'Failed to generate diff' };
});

ipcMain.handle('workspace:undo-file', async (event: Electron.IpcMainInvokeEvent, payload: { path?: string; sessionId?: string; runId?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!win || !cwd) return { ok: false, error: 'No window' };
  const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (!rawPath) return { ok: false, error: 'path is required' };

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  if (sessionId && runId) {
    return undoWorkspaceBaselineFile(cwd, sessionId, runId, rawPath);
  }

  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'Not a git repository' };

  const tracked = runGit(cwd, ['ls-files', '--error-unmatch', '--', rawPath]);
  if (!tracked.ok) {
    const roots = getAllowedRootsForWindow(win.id);
    const safe = resolvePathInAllowedRoots(roots, rawPath, { intent: 'write' });
    if (!safe.ok || !safe.abs) return { ok: false, error: safe.error || 'invalid-path' };
    try {
      await fs.rm(safe.abs, { force: true, recursive: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error ?? 'Failed to delete file') };
    }
  }

  const res = runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rawPath], { timeoutMs: 15_000 });
  if (!res.ok) return { ok: false, error: res.stderr || 'Failed to restore file' };
  return { ok: true };
});

ipcMain.handle('workspace:undo-all', async (event: Electron.IpcMainInvokeEvent, payload?: { sessionId?: string; runId?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!win || !cwd) return { ok: false, error: 'No window' };

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  if (sessionId && runId) {
    return undoWorkspaceBaselineAll(cwd, sessionId, runId);
  }

  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'Not a git repository' };

  const statusRes = runGit(cwd, ['status', '--porcelain=v1', '-z']);
  if (!statusRes.ok) return { ok: false, error: statusRes.stderr || 'Failed to read git status' };
  const entries = parseGitPorcelainZ(statusRes.stdout);
  const roots = getAllowedRootsForWindow(win.id);
  const untracked: string[] = [];
  for (const e of entries) {
    if (e.status === '?') {
      const safe = resolvePathInAllowedRoots(roots, e.path, { intent: 'write' });
      if (safe.ok && safe.abs) untracked.push(safe.abs);
    }
  }

  const restore = runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], { timeoutMs: 20_000 });
  if (!restore.ok) return { ok: false, error: restore.stderr || 'Failed to restore workspace' };

  for (const abs of untracked) {
    try { await fs.rm(abs, { force: true, recursive: true }); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('todos:reset', async (_event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string }) => {
  try {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      return { message: 'sessionId is required', todos: {}, count: 0 };
    }
    return await clearTodos(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to clear todos');
    return { message, todos: {}, count: 0 };
  }
});

ipcMain.handle('ai:sessions:list', async (event: Electron.IpcMainInvokeEvent) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  try {
    const sessions = await chatStore.list(cwd);
    const now = Date.now();
    for (const session of sessions) {
      const runtimeStatusRaw = (session as any)?.runtime?.status;
      const runtimeStatus = typeof runtimeStatusRaw === 'string' ? runtimeStatusRaw.toLowerCase() : '';
      if (runtimeStatus !== 'running') continue;

      const liveStatus = agentSessionManager.getStatus(session.id).status;
      if (liveStatus === 'running') continue;

      const startedAtRaw = Number((session as any)?.runtime?.startedAt) || Number((session as any)?.runtime?.updatedAt) || now;
      const snapshot = {
        status: 'error' as const,
        startedAt: startedAtRaw,
        completedAt: now,
        updatedAt: now,
      };
      try {
        const updated = await chatStore.updateRuntime(cwd, session.id, snapshot);
        if (updated) (session as any).runtime = (updated as any).runtime;
      } catch {}
    }
    return { ok: true, sessions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to list sessions');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:get', async (event: Electron.IpcMainInvokeEvent, sessionId: string) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  try {
    let session = await chatStore.get(cwd, sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    const runtimeStatusRaw = (session as any)?.runtime?.status;
    const runtimeStatus = typeof runtimeStatusRaw === 'string' ? runtimeStatusRaw.toLowerCase() : '';
    if (runtimeStatus === 'running') {
      const liveStatus = agentSessionManager.getStatus(session.id).status;
      if (liveStatus !== 'running') {
        const now = Date.now();
        const startedAtRaw = Number((session as any)?.runtime?.startedAt) || Number((session as any)?.runtime?.updatedAt) || now;
        const snapshot = {
          status: 'error' as const,
          startedAt: startedAtRaw,
          completedAt: now,
          updatedAt: now,
        };
        try {
          session = await chatStore.updateRuntime(cwd, session.id, snapshot);
        } catch {}
      }
    }
    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to load session');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:setActive', async (event: Electron.IpcMainInvokeEvent, payload: { sessionId?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!win || !cwd) return { ok: false, error: 'No workspace selected' };
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) {
    windowActiveSessionIds.delete(win.id);
    windowAdditionalWorkingDirs.set(win.id, null);
    return { ok: true };
  }
  try {
    const session = await chatStore.get(cwd, sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    windowActiveSessionIds.set(win.id, sessionId);
    const additional = typeof (session as any).additionalWorkingDir === 'string' && (session as any).additionalWorkingDir.trim()
      ? String((session as any).additionalWorkingDir).trim()
      : null;
    windowAdditionalWorkingDirs.set(win.id, additional);
    return { ok: true, additionalWorkingDir: additional };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to set active session');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:create', async (event: Electron.IpcMainInvokeEvent, payload?: { title?: string; model?: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  try {
    // Determine provider from model
    const provider = payload?.model ? getModelProvider(payload.model) : 'openai';
    const session = await chatStore.create(cwd, { title: payload?.title, provider });
    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to create session');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:delete', async (event: Electron.IpcMainInvokeEvent, sessionId: string) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  try {
    const removed = await chatStore.delete(cwd, sessionId);
    if (!removed) return { ok: false, error: 'Session not found' };
    try { await deleteWorkspaceBaseline(cwd, sessionId); } catch {}
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to delete session');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:rename', async (event: Electron.IpcMainInvokeEvent, payload: { sessionId: string; title: string }) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  const sessionId = payload?.sessionId;
  const title = payload?.title ?? '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  try {
    const session = await chatStore.rename(cwd, sessionId, title);
    if (!session) return { ok: false, error: 'Session not found' };
    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to rename session');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:setAdditionalWorkingDir', async (
  event: Electron.IpcMainInvokeEvent,
  payload: { sessionId: string; additionalWorkingDir: string | undefined }
) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  try {
    const session = await chatStore.setAdditionalWorkingDir(cwd, sessionId, payload.additionalWorkingDir);
    if (!session) return { ok: false, error: 'Session not found' };

    // Keep active-session additional root in sync for viewer/terminal/preview.
    if (win) {
      const active = windowActiveSessionIds.get(win.id);
      if (active === sessionId) {
        const additional = typeof (session as any).additionalWorkingDir === 'string' && (session as any).additionalWorkingDir.trim()
          ? String((session as any).additionalWorkingDir).trim()
          : null;
        windowAdditionalWorkingDirs.set(win.id, additional);
      }
    }

    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to update additional working directory');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:sessions:setWorkspaceChanges', async (
  event: Electron.IpcMainInvokeEvent,
  payload: { sessionId: string; workspaceChanges: WorkspaceChangesSnapshot | undefined }
) => {
  const { win, cwd } = resolveWindowForSender(event.sender);
  if (!cwd) return { ok: false, error: 'No workspace selected' };
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  try {
    const session = await chatStore.setWorkspaceChanges(cwd, sessionId, payload?.workspaceChanges);
    if (!session) return { ok: false, error: 'Session not found' };
    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to update workspace changes');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:models:list', async () => {
  try {
    return { ok: true, models: listVisibleModels() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to list models');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:models:hidden', async () => {
  try {
    return { ok: true, models: listHiddenModels() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to list hidden models');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:models:add', async (_event: Electron.IpcMainInvokeEvent, payload: { key?: string; name?: string; provider?: string; type?: string }) => {
  try {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    if (!key) return { ok: false, error: 'Model key is required.' };
    if (isBuiltinModel(key)) {
      if (hiddenModelKeys.has(key)) {
        hiddenModelKeys.delete(key);
        await persistHiddenModels([...hiddenModelKeys]);
      }
      return { ok: true, models: listVisibleModels() };
    }

    const provider: Provider =
      payload?.provider === 'anthropic'
        ? 'anthropic'
        : payload?.provider === 'openai_compat'
          ? 'openai_compat'
          : 'openai';
    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : key;
    const type = typeof payload?.type === 'string' && payload.type.trim() ? payload.type.trim() : 'reasoning';

    const list = await getCustomModelsFromSettings();
    const filtered = list.filter(m => m && m.key !== key);
    filtered.push({ key, name, provider, type });

    await persistCustomModels(filtered);

    if (hiddenModelKeys.has(key)) {
      hiddenModelKeys.delete(key);
      await persistHiddenModels([...hiddenModelKeys]);
    }

    return { ok: true, models: listVisibleModels() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to add model');
    return { ok: false, error: message };
  }
});

ipcMain.handle('ai:models:remove', async (_event: Electron.IpcMainInvokeEvent, payload: { key?: string }) => {
  try {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    if (!key) return { ok: false, error: 'Model key is required.' };
    if (isBuiltinModel(key)) {
      hiddenModelKeys.add(key);
      await persistHiddenModels([...hiddenModelKeys]);
    } else {
      const list = await getCustomModelsFromSettings();
      const filtered = list.filter(m => m && m.key !== key);

      await persistCustomModels(filtered);

      if (hiddenModelKeys.has(key)) {
        hiddenModelKeys.delete(key);
        await persistHiddenModels([...hiddenModelKeys]);
      }
    }

    return { ok: true, models: listVisibleModels() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to remove model');
    return { ok: false, error: message };
  }
});
function resolveWindowForSender(sender: Electron.WebContents): { win: Electron.BrowserWindow | null; cwd: string | null } {
  const directWin = BrowserWindow.fromWebContents(sender);
  if (directWin) {
    return { win: directWin, cwd: windowWorkingDirs.get(directWin.id) || process.cwd() };
  }
  for (const [winId, view] of childViews.entries()) {
    if (view.webContents === sender) {
      const parent = BrowserWindow.fromId(winId) ?? null;
      return { win: parent, cwd: windowWorkingDirs.get(winId) || process.cwd() };
    }
  }
  return { win: null, cwd: null };
}

function resolvePathInside(base: string, relativePath: string, opts?: { allowEscape?: boolean }): { ok: boolean; abs?: string; rel?: string; error?: string } {
  const rel = relativePath && relativePath !== '.' ? relativePath : '';
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
  const normalizedBase = path.resolve(base);
  const relOut = path.relative(normalizedBase, abs);
  const inside = !(relOut.startsWith('..') || (path.isAbsolute(relOut) && relOut !== '.'));
  if (!inside) {
    if (opts?.allowEscape) {
      const relValue = path.isAbsolute(rel) ? path.resolve(rel) : (rel || relOut || '.');
      return { ok: true, abs, rel: relValue };
    }
    return { ok: false, error: 'Path escapes workspace' };
  }
  const safeRel = relOut || '.';
  return { ok: true, abs, rel: safeRel };
}

type AllowedRoots = {
  workspaceRoot: string;
  additionalRoot: string | null;
  allowExternal: boolean;
};

type ScopedPath = { scope: 'workspace' | 'additional' | null; path: string };

function parseScopedPath(value: string): ScopedPath {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('workspace:')) {
    return { scope: 'workspace', path: trimmed.slice('workspace:'.length).replace(/^\/+/, '') };
  }
  if (lower.startsWith('additional:')) {
    return { scope: 'additional', path: trimmed.slice('additional:'.length).replace(/^\/+/, '') };
  }
  return { scope: null, path: trimmed };
}

function existsSyncSafe(p: string): boolean {
  try { return fsSync.existsSync(p); } catch { return false; }
}

function resolvePathInAllowedRoots(
  roots: AllowedRoots,
  inputPath: string,
  opts?: { intent?: 'read' | 'write' | 'search' }
): { ok: boolean; abs?: string; rel?: string; root?: 'workspace' | 'additional' | 'external'; error?: string } {
  const intent = opts?.intent || 'read';

  const normalizedRoots: AllowedRoots = {
    workspaceRoot: path.resolve(roots.workspaceRoot || process.cwd()),
    additionalRoot: roots.additionalRoot ? path.resolve(roots.additionalRoot) : null,
    allowExternal: !!roots.allowExternal,
  };

  const parsed = parseScopedPath(inputPath);
  const raw = parsed.path;
  if (!raw) return { ok: false, error: 'path is required' };

  const workspaceRoot = normalizedRoots.workspaceRoot;
  const additionalRoot = normalizedRoots.additionalRoot;

  const toRel = (rootKind: 'workspace' | 'additional', abs: string): string => {
    const base = rootKind === 'workspace' ? workspaceRoot : (additionalRoot || workspaceRoot);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    const safeRel = rel && rel !== '' ? rel : '.';
    return rootKind === 'additional' ? `additional:${safeRel}` : safeRel;
  };

  // Absolute
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (normalizedRoots.allowExternal) {
      return { ok: true, abs, rel: abs, root: 'external' };
    }
    if (isPathInside(workspaceRoot, abs)) {
      return { ok: true, abs, rel: toRel('workspace', abs), root: 'workspace' };
    }
    if (additionalRoot && isPathInside(additionalRoot, abs)) {
      return { ok: true, abs, rel: toRel('additional', abs), root: 'additional' };
    }
    return { ok: false, error: 'Path escapes workspace' };
  }

  // Explicit relative scope
  if (parsed.scope === 'workspace') {
    const abs = path.resolve(workspaceRoot, raw);
    return { ok: true, abs, rel: toRel('workspace', abs), root: 'workspace' };
  }
  if (parsed.scope === 'additional') {
    if (!additionalRoot) return { ok: false, error: 'No additional working directory is set' };
    const abs = path.resolve(additionalRoot, raw);
    return { ok: true, abs, rel: toRel('additional', abs), root: 'additional' };
  }

  // Auto relative
  const absW = path.resolve(workspaceRoot, raw);
  const absA = additionalRoot ? path.resolve(additionalRoot, raw) : null;
  const existsW = existsSyncSafe(absW);
  const existsA = absA ? existsSyncSafe(absA) : false;

  const choose = (rootKind: 'workspace' | 'additional', abs: string) => ({ ok: true, abs, rel: toRel(rootKind, abs), root: rootKind } as const);

  if (intent === 'read' || intent === 'search') {
    if (existsW && !existsA) return choose('workspace', absW);
    if (!existsW && existsA && absA) return choose('additional', absA);
    if (existsW && existsA) return choose('workspace', absW);
    return choose('workspace', absW);
  }

  // write/create
  if (existsW && !existsA) return choose('workspace', absW);
  if (!existsW && existsA && absA) return choose('additional', absA);
  if (existsW && existsA) return choose('workspace', absW);

  const parentW = path.dirname(absW);
  const parentA = absA ? path.dirname(absA) : null;
  const parentExistsW = existsSyncSafe(parentW);
  const parentExistsA = parentA ? existsSyncSafe(parentA) : false;

  if (!parentExistsW && parentExistsA && absA) return choose('additional', absA);
  return choose('workspace', absW);
}

function getAllowedRootsForWindow(winId: number): AllowedRoots {
  const workspaceRoot = windowWorkingDirs.get(winId) || process.cwd();
  const additionalRoot = windowAdditionalWorkingDirs.get(winId) || null;
  const allowExternal = windowAgentModes.get(winId) === 'agent_full';
  return { workspaceRoot, additionalRoot, allowExternal };
}

// ---------------- Application Menu (AI → Add MCP Server) ----------------
function targetWindowForLayout(): Electron.BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

function applyLayoutModeToWindow(win: Electron.BrowserWindow | null, mode: LayoutMode): void {
  if (!win) return;
  windowLayoutModes.set(win.id, mode);
  if (win.isFocused()) {
    lastFocusedWindowId = win.id;
    menuLayoutMode = mode;
  }
  try { win.webContents.send('layout:set-mode', { mode }); } catch {}
  buildAndSetMenu();
}

function resolvePreloadPath(): string {
  try {
    const cjs = path.join(__dirname, '../preload/preload.cjs');
    const js = path.join(__dirname, '../preload/preload.js');
    return fsSync.existsSync(cjs) ? cjs : js;
  } catch {
    return path.join(__dirname, '../preload/preload.js');
  }
}

function showAddMcpServerDialog(parent?: Electron.BrowserWindow | null): void {
  const preload = resolvePreloadPath();
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    modal: !!parent,
    width: 540,
    height: 520,
    resizable: false,
    title: 'Add MCP Server',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload }
  });
  const html = `<!doctype html>
  <meta charset="utf-8">
  <title>Add MCP Server</title>
  <style>
    body{background:#0b0b0b;color:#e6e6e6;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px}
    h1{font-size:16px;margin:0 0 12px}
    .row{margin-bottom:10px}
    label{display:block;font-size:11px;opacity:.9;margin-bottom:4px}
    input,textarea{width:100%;padding:8px;border-radius:8px;border:1px solid #333;background:#111;color:#eee}
    textarea{height:72px}
    .hint{font-size:11px;color:#a0a0a0;margin-top:4px}
    .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    button{padding:8px 12px;border-radius:8px;border:1px solid #444;background:#191919;color:#fff;cursor:pointer}
    button:hover{background:#222}
    .error{color:#f6b0b0;margin-top:8px;min-height:1em}
    .ok{color:#b5f1c9;margin-top:8px;min-height:1em}
  </style>
  <h1>Add MCP Server</h1>
  <div class=row>
    <label>Server Name</label>
    <input id=name placeholder="e.g., myserver" />
  </div>
  <div class=row>
    <label>Command</label>
    <input id=command placeholder="e.g., node" />
  </div>
  <div class=row>
    <label>Args (space-separated; quotes allowed)</label>
    <input id=args placeholder='e.g., /full/path/to/server.js' />
    <div class=hint>Provide the full path to your MCP server script. Example: /Users/you/my-server/server.js</div>
  </div>
  <div class=row>
    <label>CWD (optional; defaults to workspace)</label>
    <input id=cwd placeholder="." />
  </div>
  <div class=row>
    <label>Env (optional JSON object)</label>
    <textarea id=env placeholder='{"FOO":"bar"}'></textarea>
  </div>
  <div class=actions>
    <button id=cancel>Cancel</button>
    <button id=save>Save</button>
  </div>
  <div id=msg class=error></div>
  <script>
    const $ = (id)=>document.getElementById(id);
    const splitArgs = (s) => {
      if (!s) return [];
      const re = /\"([^\"]*)\"|'([^']*)'|\S+/g; const out=[]; let m; while((m=re.exec(s))){ out.push(m[1]??m[2]??m[0]); } return out;
    };
    $('cancel').addEventListener('click', ()=> window.close());
    $('save').addEventListener('click', async ()=>{
      const name = String($('name').value||'').trim();
      const command = String($('command').value||'').trim();
      const argsStr = String($('args').value||'').trim();
      const cwd = String($('cwd').value||'').trim();
      const envStr = String($('env').value||'').trim();
      const msg = $('msg'); msg.className='error'; msg.textContent='';

      console.log('Save clicked with values:', { name, command, argsStr, cwd, envStr });

      if (!name){ msg.textContent='Name is required'; return; }
      if (!command){ msg.textContent='Command is required'; return; }
      if (!argsStr){ msg.textContent='Args are required (path to your MCP server script)'; return; }

      let env = undefined;
      if (envStr){
        try{
          env = JSON.parse(envStr);
          if (typeof env !== 'object' || Array.isArray(env)) throw new Error('env must be an object');
        }catch(e){
          msg.textContent='Env must be valid JSON object';
          return;
        }
      }

      const args = splitArgs(argsStr);
      if (!args.length){ msg.textContent='Args must contain at least the server script path'; return; }

      console.log('Validation passed, calling MCP API with:', { name, command, args, cwd, env });

      // Check if MCP API is available
      if (!window.mcp || !window.mcp.userUpsert) {
        msg.textContent = 'MCP API not available. Please restart the application.';
        return;
      }

      try {
        msg.textContent = 'Saving...';
        const res = await window.mcp.userUpsert(name, { command, args, cwd: cwd||undefined, env });
        console.log('MCP API response:', res);

        if (!res || !res.ok){
          const errorMsg = (res && res.error) ? res.error : 'Failed to save - unknown error';
          msg.textContent = errorMsg;
          console.error('Save failed:', errorMsg);
          return;
        }

        msg.className='ok';
        msg.textContent='Saved successfully!';
        setTimeout(()=>window.close(), 800);
      } catch(e){
        const errorMsg = String(e&&e.message||e||'Unexpected error');
        msg.textContent = errorMsg;
        console.error('Save exception:', e);
      }
    });
  </script>`;
  try { win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64')); } catch {}
}

// ---------------- Application Menu (AI → API Keys) ----------------
function showApiKeysDialog(parent?: Electron.BrowserWindow | null): void {
  const preload = resolvePreloadPath();
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    modal: !!parent,
    width: 540,
    height: 520,
    resizable: false,
    title: 'API Keys',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload }
  });

  const html = `<!doctype html>
  <meta charset="utf-8">
  <title>API Keys</title>
  <style>
    body{background:#0b0b0b;color:#e6e6e6;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px}
    h1{font-size:16px;margin:0 0 8px}
    p{margin:0 0 12px;color:#bdbdbd}
    .row{margin:10px 0}
    .section{border:1px solid #1f1f1f;border-radius:10px;padding:10px 12px;margin:12px 0;background:#0f0f0f}
    .section-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#9a9a9a;margin:0 0 8px}
    label{display:flex;align-items:center;justify-content:space-between;font-size:11px;opacity:.95;margin-bottom:4px}
    input, select{width:100%;padding:8px;border-radius:8px;border:1px solid #333;background:#111;color:#eee}
    .status{font-size:11px;color:#a0a0a0}
    .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    button{padding:8px 12px;border-radius:8px;border:1px solid #444;background:#191919;color:#fff;cursor:pointer}
    button:hover{background:#222}
    .danger{border-color:#6b1b1b}
    .danger:hover{background:#2a1212}
    .error{color:#f6b0b0;margin-top:10px;min-height:1em}
    .ok{color:#b5f1c9;margin-top:10px;min-height:1em}
    .hint{font-size:11px;color:#a0a0a0;margin-top:6px}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;color:#d0d0d0}
  </style>
  <h1>API Keys</h1>
  <p>Keys are stored in your OS keychain (via keytar). You can also use environment variables for development.</p>

  <div class=section>
    <div class=section-title>Configured Keys</div>
    <div id=configuredKeys></div>
    <div id=configuredKeysEmpty class=hint>No keys configured yet.</div>
  </div>

  <div class=section>
    <div class=section-title>Add New API Key</div>
    <div class=row>
      <label for=provider>Provider</label>
      <select id=provider>
        <option value=openai>OpenAI</option>
        <option value=openai_compat>OpenAI-compatible (custom provider)</option>
        <option value=anthropic>Anthropic</option>
      </select>
    </div>
    <div class=row>
      <label id=apiKeyLabel>API Key</label>
      <input id=apiKey placeholder="sk-…" autocomplete="off" />
      <div id=apiKeyHint class=hint>Env fallback: <code>OPENAI_API_KEY</code></div>
    </div>
    <div class=row id=openaiCompatBaseRow>
      <label>Base URL (optional)</label>
      <input id=openaiCompatBase placeholder="https://openrouter.ai/api/v1" autocomplete="off" />
      <div class=hint>For OpenAI-compatible providers. Leave blank for api.openai.com</div>
    </div>
  </div>

  <div class=actions>
    <button id=close>Close</button>
    <button id=clear class=danger>Clear Stored Keys</button>
    <button id=save>Save</button>
  </div>
  <div id=msg class=error></div>

  <script>
    const $ = (id)=>document.getElementById(id);
    const msg = $('msg');
    const setMsg = (text, kind) => { msg.className = kind || 'error'; msg.textContent = text || ''; };
    const formatStatus = (st) => {
      if (!st || !st.configured) return '';
      const val = typeof st.value === 'string' && st.value.trim() ? st.value.trim() : null;
      const suffix = st.source ? (' (' + st.source + ')') : '';
      return val ? (val + suffix) : ('configured' + suffix);
    };

    const renderConfiguredKeys = (status) => {
      const list = $('configuredKeys');
      const empty = $('configuredKeysEmpty');
      if (!list) return;
      list.innerHTML = '';

      const entries = [];
      if (status && status.openai && status.openai.configured) {
        entries.push({ label: 'OpenAI', status: status.openai });
      }
      if (status && status.openaiCompat && status.openaiCompat.configured) {
        entries.push({ label: 'OpenAI-compatible', status: status.openaiCompat });
      }
      if (status && status.anthropic && status.anthropic.configured) {
        entries.push({ label: 'Anthropic', status: status.anthropic });
      }

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('label');
        label.textContent = entry.label + ' ';
        const span = document.createElement('span');
        span.className = 'status';
        span.textContent = formatStatus(entry.status);
        label.appendChild(span);
        row.appendChild(label);
        list.appendChild(row);
      }

      if (empty) {
        empty.style.display = entries.length ? 'none' : '';
      }
    };

    async function refresh(){
      try{
        if (!window.apiKeys || !window.apiKeys.status) {
          setMsg('API key bridge unavailable. Please restart the app.', 'error');
          return;
        }
        const res = await window.apiKeys.status();
        if (!res || !res.ok) {
          setMsg((res && res.error) ? res.error : 'Failed to read key status', 'error');
          return;
        }
        renderConfiguredKeys(res.status);
        const baseVal = res.status && res.status.openaiCompat && res.status.openaiCompat.baseUrl && res.status.openaiCompat.baseUrl.value;
        $('openaiCompatBase').value = baseVal || '';
      } catch(e){
        setMsg(String(e && e.message || e || 'Failed to refresh status'), 'error');
      }
    }

    const syncProviderUi = () => {
      const raw = $('provider').value;
      const provider = raw === 'anthropic' ? 'anthropic' : raw === 'openai_compat' ? 'openai_compat' : 'openai';
      const baseRow = $('openaiCompatBaseRow');
      const keyInput = $('apiKey');
      const keyHint = $('apiKeyHint');
      const keyLabel = $('apiKeyLabel');
      if (provider === 'anthropic') {
        baseRow.style.display = 'none';
        keyInput.placeholder = 'sk-ant-…';
        keyHint.innerHTML = 'Env fallback: <code>ANTHROPIC_API_KEY</code>';
        keyLabel.textContent = 'Anthropic API Key';
      } else if (provider === 'openai_compat') {
        baseRow.style.display = '';
        keyInput.placeholder = 'sk-…';
        keyHint.innerHTML = 'Env fallback: <code>OPENAI_COMPAT_API_KEY</code>';
        keyLabel.textContent = 'OpenAI-compatible API Key';
      } else {
        baseRow.style.display = 'none';
        keyInput.placeholder = 'sk-…';
        keyHint.innerHTML = 'Env fallback: <code>OPENAI_API_KEY</code>';
        keyLabel.textContent = 'OpenAI API Key';
      }
    };

    $('close').addEventListener('click', ()=> window.close());
    $('provider').addEventListener('change', syncProviderUi);

    $('save').addEventListener('click', async ()=>{
      try{
        setMsg('Saving…','error');
        const raw = $('provider').value;
        const provider = raw === 'anthropic' ? 'anthropic' : raw === 'openai_compat' ? 'openai_compat' : 'openai';
        const apiKey = String($('apiKey').value||'').trim();
        const openaiCompatBase = String($('openaiCompatBase').value||'').trim();

        if (provider === 'anthropic') {
          if (!apiKey) {
            setMsg('Enter an Anthropic API key to save.','error');
            return;
          }
          const r = await window.apiKeys.set('anthropic', apiKey);
          if (!r || !r.ok) throw new Error((r && r.error) ? r.error : 'Failed to save Anthropic key');
        } else if (provider === 'openai_compat') {
          if (!apiKey && !openaiCompatBase) {
            setMsg('Enter an OpenAI-compatible API key or base URL to save.','error');
            return;
          }
          if (apiKey) {
            const r = await window.apiKeys.set('openai_compat', apiKey);
            if (!r || !r.ok) throw new Error((r && r.error) ? r.error : 'Failed to save OpenAI-compatible key');
          }
          const rBase = await window.apiKeys.setCompatBaseUrl(openaiCompatBase);
          if (!rBase || !rBase.ok) throw new Error((rBase && rBase.error) ? rBase.error : 'Failed to save OpenAI-compatible base URL');
        } else {
          if (!apiKey) {
            setMsg('Enter an OpenAI API key to save.','error');
            return;
          }
          const r = await window.apiKeys.set('openai', apiKey);
          if (!r || !r.ok) throw new Error((r && r.error) ? r.error : 'Failed to save OpenAI key');
        }

        $('apiKey').value='';
        $('openaiCompatBase').value=openaiCompatBase;
        setMsg('Saved.','ok');
        await refresh();
      } catch(e){
        setMsg(String(e && e.message || e || 'Save failed'), 'error');
      }
    });

    $('clear').addEventListener('click', async ()=>{
      try{
        setMsg('Clearing…','error');
        const r1 = await window.apiKeys.clear('openai');
        if (!r1 || !r1.ok) throw new Error((r1 && r1.error) ? r1.error : 'Failed to clear OpenAI key');
        const rCompat = await window.apiKeys.clear('openai_compat');
        if (!rCompat || !rCompat.ok) throw new Error((rCompat && rCompat.error) ? rCompat.error : 'Failed to clear OpenAI-compatible key');
        const rBase = await window.apiKeys.clearCompatBaseUrl();
        if (!rBase || !rBase.ok) throw new Error((rBase && rBase.error) ? rBase.error : 'Failed to clear OpenAI-compatible base URL');
        const r2 = await window.apiKeys.clear('anthropic');
        if (!r2 || !r2.ok) throw new Error((r2 && r2.error) ? r2.error : 'Failed to clear Anthropic key');
        setMsg('Cleared stored keys.','ok');
        await refresh();
      } catch(e){
        setMsg(String(e && e.message || e || 'Clear failed'), 'error');
      }
    });

    syncProviderUi();
    void refresh();
  </script>`;

  try { win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64')); } catch {}
}

function formatMcpStatus(status?: string, connected?: boolean, tools?: number): string {
  const raw = status || (connected ? 'ready' : 'disconnected');
  const friendly = raw.replace(/[_-]+/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
  const toolCount = typeof tools === 'number' && tools > 0 ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : '';
  return `${friendly}${toolCount}`;
}

function handleManualUpdateCheck(): void {
  void (async () => {
    try {
      await checkAutoUpdates();
    } catch (error: any) {
      const message = error?.message || 'Unable to check for updates right now.';
      dialog.showErrorBox('Update Check Failed', message);
    }
  })();
}

function buildAndSetMenu(): void {
  const activeWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const activeWinId = activeWindow?.id ?? null;
  const servers = activeWinId != null ? mcpHost.listConfigured(activeWinId).servers : [];

  const serverItems: Electron.MenuItemConstructorOptions[] = [];
  if (servers.length) {
    const sorted = [...servers].sort((a, b) => {
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameA.localeCompare(nameB);
    });
    for (const server of sorted) {
      const label = server.name || '(unnamed server)';
      const statusLabel = formatMcpStatus(server.status, server.connected, server.tools);
      const errorLabel = server.error ? ` – ${server.error}` : '';
      serverItems.push({
        label: `${label} (${statusLabel})${errorLabel}`,
        type: 'checkbox',
        checked: !!server.connected,
        click: (menuItem, win) => {
          const target = win || activeWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
          if (!target) return;
          void (async () => {
            const cwd = windowWorkingDirs.get(target.id) || process.cwd();
            try { await mcpHost.prepare(target.id, cwd); } catch {}
            try {
              if (server.connected) {
                const res = await mcpHost.disconnect(target.id, server.name);
                if (!res.ok) dialog.showErrorBox('MCP Disconnect Failed', res.error || 'Unable to disconnect server');
              } else {
                const browserTarget = BrowserWindow.fromId(target.id) || undefined;
                const res = await mcpHost.connect(target.id, server.name, browserTarget);
                if (!res.ok) dialog.showErrorBox('MCP Connect Failed', res.error || 'Unable to connect server');
              }
            } catch (error: any) {
              const message = error?.message || String(error || 'Unexpected MCP error');
              dialog.showErrorBox('MCP Error', message);
            } finally {
              buildAndSetMenu();
            }
          })();
        },
      });
    }
  } else {
    serverItems.push({ label: 'No MCP servers configured', enabled: false });
  }

  const aiMenu: Electron.MenuItemConstructorOptions = {
    label: 'AI',
    submenu: [
      {
        label: 'API Keys…',
        click: () => {
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
          showApiKeysDialog(win);
        }
      },
      { type: 'separator' },
      {
        label: 'Add MCP Server…',
        click: () => {
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
          showAddMcpServerDialog(win);
        }
      },
      { type: 'separator' },
      {
        label: 'MCP Servers',
        submenu: serverItems,
      },
    ]
  };

  const isMac = process.platform === 'darwin';
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: isMac
      ? [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
        ]
      : [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ]
  };

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Split View',
        type: 'radio',
        checked: menuLayoutMode === 'split',
        click: () => applyLayoutModeToWindow(targetWindowForLayout(), 'split')
      },
      {
        label: 'Agent Only',
        type: 'radio',
        checked: menuLayoutMode === 'agent',
        click: () => applyLayoutModeToWindow(targetWindowForLayout(), 'agent')
      },
      {
        label: 'Browser Only',
        type: 'radio',
        checked: menuLayoutMode === 'browser',
        click: () => applyLayoutModeToWindow(targetWindowForLayout(), 'browser')
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' }
    ]
  };

  const template: Electron.MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => handleManualUpdateCheck(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }
  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      {
        label: 'Keyboard Shortcuts',
        click: () => {
          const shortcutInfo = `Keyboard Shortcuts

Tab Switching:
  ⌘1 / Ctrl+1    Switch to Terminal
  ⌘2 / Ctrl+2    Switch to Preview
  ⌘3 / Ctrl+3    Switch to Code

Layout:
  ⌘\\ / Ctrl+\\    Toggle Split/Browser-only mode

General:
  ⌘Enter / Ctrl+Enter    Send message
  Escape                  Close dialogs/menus

These shortcuts work from anywhere in the app.`;
          dialog.showMessageBox({
            type: 'info',
            title: 'Keyboard Shortcuts',
            message: 'BrilliantCode Keyboard Shortcuts',
            detail: shortcutInfo,
            buttons: ['OK']
          });
        }
      },
      { type: 'separator' },
      {
        label: 'Learn More',
        click: () => {
          shell.openExternal('https://brilliantai.co');
        }
      }
    ]
  };

  template.push(aiMenu);
  template.push(editMenu);
  template.push(viewMenu);
  template.push({ role: 'windowMenu' });
  template.push(helpMenu);

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
