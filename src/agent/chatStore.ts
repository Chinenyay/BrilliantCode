import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { OpenAIResponseItem } from '../types/chat.js';
import type { Provider } from './models.js';

// Stored chat session representation in the filesystem
// Each workspace (working directory) has its own chat store file, identified
// by a hash of the absolute path. The store file contains multiple chat sessions.

export type StoredChatRuntime = {
  status: 'idle' | 'running' | 'completed' | 'error';
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
};

export type AnthropicConversationItem =
  | Anthropic.MessageParam
  | {
      type: 'tool_result';
      role: 'user';
      content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
    };

export type WorkspaceChangesFile = {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
};

export type WorkspaceChangesSnapshot = {
  updatedAt: number;
  runId?: string;
  totals: { files: number; additions: number; deletions: number };
  files: WorkspaceChangesFile[];
  anchorAssistantMessageIndex?: number;
  page?: { offset: number; limit: number; hasMore: boolean };
};

export type StoredChat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: Provider;
  history: OpenAIResponseItem[] | AnthropicConversationItem[];
  runtime?: StoredChatRuntime;
  additionalWorkingDir?: string;
  workspaceChanges?: WorkspaceChangesSnapshot;
};

const ROOT_DIR = path.join(os.homedir(), '.brilliantcode');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

const CURRENT_VERSION = 4;

type PersistedSessions = {
  version: number;
  sessions: StoredChat[];
};

function applyBackspaces(input: string): string {
  let s = String(input ?? '');
  let prev: string | null = null;
  while (s !== prev) {
    prev = s;
    s = s.replace(/.[\x08]/g, '');
  }
  s = s.replace(/[\x08]/g, '');
  return s;
}

function stripOtherControls(input: string): string {
  const s = String(input ?? '');
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function clampText(input: string, limit = 12000): string {
  const s = String(input ?? '');
  if (s.length <= limit) return s;
  const omitted = s.length - limit;
  return s.slice(0, limit) + `\n… (truncated ${omitted} characters)`;
}

function sanitizeLargeTextBlob(input: any, limit = 12000): string {
  if (typeof input !== 'string') return '';
  const applied = applyBackspaces(input);
  const stripped = stripOtherControls(applied);
  return clampText(stripped, limit);
}

const MAX_PERSISTED_IMAGE_CHARS = 20_000;

function isBase64DataUrl(value: string): boolean {
  return /^data:[^;]+;base64,/i.test(value);
}

function looksLikeBareBase64(value: string): boolean {
  if (!value || value.length < 2000) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function imagePlaceholder(label?: string): string {
  const base = '[image omitted]';
  return label ? `${base} ${label}` : base;
}

function scrubOpenAIUserContent(content: any): any {
  if (!Array.isArray(content)) return content;
  const out: any[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part as any).type === 'input_image') {
      const url = typeof (part as any).image_url === 'string' ? String((part as any).image_url) : '';
      const filename = typeof (part as any).filename === 'string' ? String((part as any).filename) : '';
      const shouldOmit =
        (url && isBase64DataUrl(url) && url.length > MAX_PERSISTED_IMAGE_CHARS)
        || (url && looksLikeBareBase64(url) && url.length > MAX_PERSISTED_IMAGE_CHARS);

      if (shouldOmit) {
        out.push({ type: 'input_text', text: imagePlaceholder(filename ? `(${filename})` : undefined) });
        continue;
      }
    }
    out.push(part);
  }

  if (!out.some(p => p && typeof p === 'object' && (p as any).type === 'input_text')) {
    out.unshift({ type: 'input_text', text: '' });
  }

  return out;
}

function scrubOpenAIFunctionCallOutput(output: any): any {
  if (Array.isArray(output)) {
    const hasImage = output.some((p: any) => {
      if (!p || typeof p !== 'object') return false;
      if (String(p.type || '').toLowerCase() === 'input_image') return true;
      const u = typeof p.image_url === 'string' ? p.image_url : '';
      return typeof u === 'string' && isBase64DataUrl(u) && u.length > MAX_PERSISTED_IMAGE_CHARS;
    });
    if (hasImage) {
      const filenames = output
        .map((p: any) => (typeof p?.filename === 'string' ? p.filename : ''))
        .filter(Boolean)
        .slice(0, 3);
      return imagePlaceholder(filenames.length ? `(tool output: ${filenames.join(', ')})` : '(tool output)');
    }
  }

  if (output && typeof output === 'object') {
    const seen = new Set<any>();
    const walk = (v: any, depth: number): any => {
      if (!v || depth <= 0) return v;
      if (typeof v === 'string') {
        if (isBase64DataUrl(v) && v.length > MAX_PERSISTED_IMAGE_CHARS) return imagePlaceholder('(data-url)');
        if (looksLikeBareBase64(v) && v.length > MAX_PERSISTED_IMAGE_CHARS) return imagePlaceholder('(base64)');
        return v;
      }
      if (typeof v !== 'object') return v;
      if (seen.has(v)) return v;
      seen.add(v);
      if (Array.isArray(v)) return v.map(item => walk(item, depth - 1));
      for (const k of Object.keys(v)) {
        try {
          (v as any)[k] = walk((v as any)[k], depth - 1);
        } catch {}
      }
      return v;
    };
    return walk(output, 4);
  }

  return output;
}

function scrubAnthropicContentBlocks(content: any): any {
  if (!Array.isArray(content)) return content;
  const out: any[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (String((block as any).type || '').toLowerCase() === 'image') {
      const source = (block as any).source;
      const data = typeof source?.data === 'string' ? source.data : '';
      const shouldOmit = data && data.length > MAX_PERSISTED_IMAGE_CHARS;
      if (shouldOmit) {
        out.push({ type: 'text', text: imagePlaceholder('(anthropic image)') });
        continue;
      }
    }

    out.push(block);
  }

  return out;
}

const sanitizeOpenAIHistoryItem = (item: OpenAIResponseItem): OpenAIResponseItem => {
  if (!item || typeof item !== 'object') return {} as OpenAIResponseItem;
  const sc = (globalThis as any).structuredClone;
  let clone: OpenAIResponseItem | undefined;
  if (typeof sc === 'function') {
    try { clone = sc(item) as OpenAIResponseItem; } catch {}
  }
  if (!clone) {
    try { clone = JSON.parse(JSON.stringify(item)) as OpenAIResponseItem; }
    catch { clone = { ...(item as Record<string, any>) } as OpenAIResponseItem; }
  }

  delete (clone as any).timestamp;

  try {
    const type = String((clone as any).type || '').toLowerCase();
    const role = String((clone as any).role || '').toLowerCase();

    if (role === 'user' && Array.isArray((clone as any).content)) {
      (clone as any).content = scrubOpenAIUserContent((clone as any).content);
    }

    if (type === 'function_call_output') {
      const out = (clone as any).output;
      if (typeof out === 'string') {
        (clone as any).output = sanitizeLargeTextBlob(out, 12000);
      } else {
        (clone as any).output = scrubOpenAIFunctionCallOutput(out);
      }
    }

    if (type === 'function_call') {
      if (typeof (clone as any).arguments === 'string') {
        (clone as any).arguments = sanitizeLargeTextBlob((clone as any).arguments, 8000);
      }
    }
  } catch {}

  return clone;
};

const sanitizeAnthropicHistoryItem = (item: AnthropicConversationItem): AnthropicConversationItem => {
  if (!item || typeof item !== 'object') return {} as AnthropicConversationItem;
  const sc = (globalThis as any).structuredClone;
  let clone: AnthropicConversationItem | undefined;
  if (typeof sc === 'function') {
    try { clone = sc(item) as AnthropicConversationItem; } catch {}
  }
  if (!clone) {
    try { clone = JSON.parse(JSON.stringify(item)) as AnthropicConversationItem; }
    catch { clone = { ...(item as Record<string, any>) } as AnthropicConversationItem; }
  }

  delete (clone as any).timestamp;

  try {
    if (Array.isArray((clone as any).content)) {
      (clone as any).content = scrubAnthropicContentBlocks((clone as any).content);

      if ((clone as any).type === 'tool_result') {
        for (const block of (clone as any).content) {
          if (block?.type === 'tool_result' && typeof block.content === 'string') {
            block.content = sanitizeLargeTextBlob(block.content, 12000);
          }
        }
      }
    }
  } catch {}

  return clone;
};

const sanitizeHistoryItem = (item: OpenAIResponseItem | AnthropicConversationItem, provider: Provider): OpenAIResponseItem | AnthropicConversationItem => {
  if (provider === 'anthropic') {
    return sanitizeAnthropicHistoryItem(item as AnthropicConversationItem);
  } else {
    return sanitizeOpenAIHistoryItem(item as OpenAIResponseItem);
  }
};

const sanitizeHistory = (history: OpenAIResponseItem[] | AnthropicConversationItem[], provider: Provider): OpenAIResponseItem[] | AnthropicConversationItem[] => {
  return history.map(item => sanitizeHistoryItem(item, provider));
};

const cloneHistory = (history: OpenAIResponseItem[] | AnthropicConversationItem[], provider: Provider): OpenAIResponseItem[] | AnthropicConversationItem[] => {
  const sc = (globalThis as any).structuredClone;
  if (typeof sc === 'function') {
    try {
      return sanitizeHistory(sc(history), provider);
    } catch {}
  }
  try {
    return sanitizeHistory(JSON.parse(JSON.stringify(history)), provider);
  } catch {
    return sanitizeHistory(history, provider);
  }
};

const cloneHistoryItem = (item: OpenAIResponseItem | AnthropicConversationItem, provider: Provider): OpenAIResponseItem | AnthropicConversationItem => {
  const copy = cloneHistory([item], provider);
  return copy[0] ?? sanitizeHistoryItem(item, provider);
};

const safeId = (): string => {
  try {
    return randomUUID();
  } catch {
    return `chat-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }
};

const cloneSession = (session: StoredChat): StoredChat => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  provider: session.provider,
  history: cloneHistory(session.history, session.provider),
  runtime: session.runtime ? { ...session.runtime } : undefined,
  additionalWorkingDir: session.additionalWorkingDir,
  workspaceChanges: session.workspaceChanges ? sanitizeWorkspaceChanges(session.workspaceChanges) : undefined,
});

const sanitizeTitle = (title: unknown): string => {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return 'New Chat';
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
};

const sanitizeRuntime = (runtime: unknown): StoredChatRuntime | undefined => {
  if (!runtime || typeof runtime !== 'object') return undefined;
  const statusRaw = typeof (runtime as any).status === 'string' ? (runtime as any).status.toLowerCase() : '';
  const status: StoredChatRuntime['status'] =
    statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'error'
      ? statusRaw
      : 'idle';
  const updatedAt = Number((runtime as any).updatedAt) || Date.now();
  const startedAt = Number((runtime as any).startedAt) || undefined;
  const completedAt = Number((runtime as any).completedAt) || undefined;
  const result: StoredChatRuntime = { status, updatedAt };
  if (startedAt) result.startedAt = startedAt;
  if (completedAt) result.completedAt = completedAt;
  return result;
};

const sanitizeWorkspaceChangeStatus = (status: unknown): string => {
  const raw = typeof status === 'string' ? status.trim() : '';
  if (!raw) return '?';
  const ch = raw[0] || '?';
  if (/^[A-Z?]$/.test(ch)) return ch;
  return '?';
};

const sanitizeWorkspaceFilePath = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : '';
  const applied = applyBackspaces(raw);
  const stripped = stripOtherControls(applied).trim();
  if (!stripped) return '';
  return stripped.length > 500 ? `${stripped.slice(0, 497)}…` : stripped;
};

const sanitizeWorkspaceChanges = (value: unknown): WorkspaceChangesSnapshot | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const updatedAt = Number((value as any).updatedAt) || Date.now();
  const runIdRaw = typeof (value as any).runId === 'string' ? (value as any).runId.trim() : '';
  const runId = runIdRaw && runIdRaw.length <= 120 ? runIdRaw : undefined;
  const anchorRaw = (value as any).anchorAssistantMessageIndex;
  const anchorAssistantMessageIndex =
    typeof anchorRaw === 'number' && Number.isFinite(anchorRaw) ? Math.max(0, Math.floor(anchorRaw)) : undefined;
  const pageRaw = (value as any).page;
  const pageOffset = Math.max(0, Math.floor(Number(pageRaw?.offset) || 0));
  const pageLimit = Math.max(0, Math.floor(Number(pageRaw?.limit) || 0));
  const pageHasMore = Boolean(pageRaw?.hasMore);

  const totalsRaw = (value as any).totals;
  const totals = {
    files: Math.max(0, Math.floor(Number(totalsRaw?.files) || 0)),
    additions: Math.max(0, Math.floor(Number(totalsRaw?.additions) || 0)),
    deletions: Math.max(0, Math.floor(Number(totalsRaw?.deletions) || 0)),
  };

  const filesRaw = Array.isArray((value as any).files) ? (value as any).files : [];
  const files: WorkspaceChangesFile[] = [];
  for (const entry of filesRaw.slice(0, 300)) {
    if (!entry || typeof entry !== 'object') continue;
    const path = sanitizeWorkspaceFilePath((entry as any).path);
    if (!path) continue;
    const status = sanitizeWorkspaceChangeStatus((entry as any).status);
    const addRaw = (entry as any).additions;
    const delRaw = (entry as any).deletions;
    const additions = addRaw === null || addRaw === undefined ? null : Number(addRaw);
    const deletions = delRaw === null || delRaw === undefined ? null : Number(delRaw);
    files.push({
      path,
      status,
      additions: typeof additions === 'number' && Number.isFinite(additions) ? Math.max(0, Math.floor(additions)) : null,
      deletions: typeof deletions === 'number' && Number.isFinite(deletions) ? Math.max(0, Math.floor(deletions)) : null,
    });
  }

  totals.files = totals.files || files.length;
  const snapshot: WorkspaceChangesSnapshot = { updatedAt, totals, files };
  if (runId) snapshot.runId = runId;
  if (anchorAssistantMessageIndex !== undefined) snapshot.anchorAssistantMessageIndex = anchorAssistantMessageIndex;
  if (pageLimit > 0 || pageOffset > 0 || pageHasMore) snapshot.page = { offset: pageOffset, limit: pageLimit, hasMore: pageHasMore };
  return snapshot;
};

const resolveWorkspaceFile = (workingDir: string): string => {
  const normalized = path.resolve(workingDir || process.cwd());
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return path.join(SESSIONS_DIR, `${hash}.json`);
};

async function readFileSafe(filePath: string): Promise<PersistedSessions> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const version = Number(parsed.version) || 0;
      if (Array.isArray(parsed.sessions)) {
        const sessions = parsed.sessions
          .filter((entry: unknown): entry is Record<string, any> => typeof entry === 'object' && entry !== null)
          .map((entry: Record<string, any>) => {
            const rawHistory = Array.isArray(entry.history) ? entry.history : [];
            const provider: Provider = entry.provider === 'anthropic' ? 'anthropic' : 'openai';
            return {
              id: typeof entry.id === 'string' && entry.id ? entry.id : safeId(),
              title: sanitizeTitle(entry.title),
              createdAt: Number(entry.createdAt) || Date.now(),
              updatedAt: Number(entry.updatedAt) || Date.now(),
              provider,
              history: sanitizeHistory(rawHistory, provider),
              runtime: sanitizeRuntime(entry.runtime),
              additionalWorkingDir: typeof entry.additionalWorkingDir === 'string' && entry.additionalWorkingDir ? entry.additionalWorkingDir : undefined,
              workspaceChanges: sanitizeWorkspaceChanges(entry.workspaceChanges),
            } as StoredChat;
          });
        return { version: CURRENT_VERSION, sessions };
      }
    }
  } catch {}
  return { version: CURRENT_VERSION, sessions: [] };
}

async function writeFileSafe(filePath: string, payload: PersistedSessions): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

const emptySessions: PersistedSessions = { version: CURRENT_VERSION, sessions: [] };

export class ChatStore {
  private cache = new Map<string, PersistedSessions>();

  async list(workingDir: string): Promise<StoredChat[]> {
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    return data.sessions.map(cloneSession);
  }

  async get(workingDir: string, sessionId: string): Promise<StoredChat | null> {
    if (!sessionId) return null;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const found = data.sessions.find(session => session.id === sessionId);
    return found ? cloneSession(found) : null;
  }

  async create(workingDir: string, seed?: { title?: string; provider?: Provider }): Promise<StoredChat> {
    const now = Date.now();
    const session: StoredChat = {
      id: safeId(),
      title: sanitizeTitle(seed?.title),
      createdAt: now,
      updatedAt: now,
      provider: seed?.provider || 'openai',
      history: [],
    };
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    data.sessions.unshift(session);
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async delete(workingDir: string, sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(session => session.id !== sessionId);
    const changed = data.sessions.length !== before;
    if (changed) await this.persist(filePath, data);
    return changed;
  }

  async rename(workingDir: string, sessionId: string, title: string): Promise<StoredChat | null> {
    if (!sessionId) return null;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.title = sanitizeTitle(title);
    session.updatedAt = Date.now();
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async setProvider(workingDir: string, sessionId: string, provider: Provider): Promise<StoredChat | null> {
    if (!sessionId) return null;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    if (session.provider === provider) return cloneSession(session);
    session.provider = provider;
    session.updatedAt = Date.now();
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async setHistory(
    workingDir: string,
    sessionId: string,
    history: OpenAIResponseItem[] | AnthropicConversationItem[],
    opts?: { updateTimestamp?: boolean }
  ): Promise<StoredChat | null> {
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.history = cloneHistory(history, session.provider);
    if (opts?.updateTimestamp !== false) {
      session.updatedAt = Date.now();
    }
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async appendHistory(
    workingDir: string,
    sessionId: string,
    items: (OpenAIResponseItem | AnthropicConversationItem)[]
  ): Promise<StoredChat | null> {
    if (!items?.length) {
      return this.get(workingDir, sessionId);
    }
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    for (const item of items) {
      if (item && typeof item === 'object') {
        (session.history as any[]).push(cloneHistoryItem(item, session.provider));
      }
    }
    session.updatedAt = Date.now();
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  private async load(filePath: string): Promise<PersistedSessions> {
    const cached = this.cache.get(filePath);
    if (cached) {
      return cached;
    }
    const data = await readFileSafe(filePath);
    this.cache.set(filePath, data);
    return data;
  }

  private async persist(filePath: string, data: PersistedSessions): Promise<void> {
    this.cache.set(filePath, data);
    try {
      await writeFileSafe(filePath, data);
    } catch (error) {
      this.cache.delete(filePath);
      throw error;
    }
  }

  async touch(workingDir: string, sessionId: string): Promise<StoredChat | null> {
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.updatedAt = Date.now();
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async updateRuntime(
    workingDir: string,
    sessionId: string,
    runtime: StoredChatRuntime | undefined
  ): Promise<StoredChat | null> {
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.runtime = runtime ? sanitizeRuntime(runtime) : undefined;
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async setAdditionalWorkingDir(
    workingDir: string,
    sessionId: string,
    additionalWorkingDir: string | undefined
  ): Promise<StoredChat | null> {
    if (!sessionId) return null;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.additionalWorkingDir = additionalWorkingDir && typeof additionalWorkingDir === 'string' && additionalWorkingDir.trim() 
      ? additionalWorkingDir.trim() 
      : undefined;
    await this.persist(filePath, data);
    return cloneSession(session);
  }

  async setWorkspaceChanges(
    workingDir: string,
    sessionId: string,
    workspaceChanges: WorkspaceChangesSnapshot | undefined
  ): Promise<StoredChat | null> {
    if (!sessionId) return null;
    const filePath = resolveWorkspaceFile(workingDir);
    const data = await this.load(filePath);
    const session = data.sessions.find(entry => entry.id === sessionId);
    if (!session) return null;
    session.workspaceChanges = workspaceChanges ? sanitizeWorkspaceChanges(workspaceChanges) : undefined;
    session.updatedAt = Date.now();
    await this.persist(filePath, data);
    return cloneSession(session);
  }
}
