import { supportsReasoning, getModelProvider, supportsExtendedThinking, type Provider } from './models.js';
import { listDirTree } from './dirTree.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { ChatStore, type StoredChat, type AnthropicConversationItem } from './chatStore.js';
import type { OpenAIResponseItem, OpenAIUserContent } from '../types/chat.js';
import type Anthropic from '@anthropic-ai/sdk';
import { MODELS } from './models.js';

import {
  type CompactionConfig,
  DEFAULT_OPENAI_COMPACTION_CONFIG,
  DEFAULT_ANTHROPIC_COMPACTION_CONFIG,
  compactOpenAIHistory,
  compactAnthropicHistory,
  needsOpenAICompaction,
  needsAnthropicCompaction,
  getOpenAIMetrics,
  getAnthropicMetrics,
  createOpenAISummarizer,
  createAnthropicSummarizer,
  createFallbackSummarizer,
  type AnthropicSummarizer,
} from './compaction/index.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type AgentSessionEventChannel =
  | 'ai:agent:monitor'
  | 'ai:chatStream:chunk'
  | 'ai:chatStream:error'
  | 'ai:chatStream:done'
  | 'ai:tool:start'
  | 'ai:tool:args'
  | 'ai:tool:exec'
  | 'ai:tool:result'
  | 'ai:reasoning:summary_done';

export type AgentSessionConfirmationRequest = {
  id: string;
  name: string;
  arguments: string;
  preview?: any;
  sessionId: string | null;
  workingDir: string;
  autoMode: boolean;
};

export interface AgentSessionTransport {
  emit(channel: AgentSessionEventChannel, payload?: any): void;
  requestConfirmation(request: AgentSessionConfirmationRequest): Promise<boolean>;
}

type ToolHandler = (args: any) => Promise<any>;

type RunOpts = {
  preamble?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  autoCompaction?: boolean;
  compactionConfig?: Partial<CompactionConfig>;
};

type AnthropicSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

// ============================================================================
// Configuration Constants
// ============================================================================

const parseEnvMs = (keys: string[], fallback: number): number => {
  for (const key of keys) {
    const val = process.env[key]?.trim();
    if (val) {
      const parsed = Number(val);
      if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    }
  }
  return fallback;
};

const RETRY_BUDGET_MS = parseEnvMs(['AGENT_RETRY_MAX_MS', 'AGENT_RETRY_MAX_DURATION_MS'], 5 * 60 * 1000);
const RETRY_BASE_DELAY_MS = parseEnvMs(['AGENT_RETRY_BASE_DELAY_MS'], 1_000);
const RETRY_MAX_DELAY_MS = parseEnvMs(['AGENT_RETRY_MAX_DELAY_MS'], 60_000);
const RATE_LIMIT_FLOOR_DELAY_MS = parseEnvMs(['AGENT_RATE_LIMIT_FLOOR_MS'], 5_000);
const RATE_LIMIT_MAX_DELAY_MS = parseEnvMs(['AGENT_RATE_LIMIT_MAX_MS'], 60_000);
const RESPONSE_POLL_TIMEOUT_MS = parseEnvMs(['AGENT_RESPONSE_POLL_TIMEOUT_MS'], 0);

const TOOL_PREVIEW_LIMIT = 2_000;

// ============================================================================
// Utility Functions
// ============================================================================

const cloneDeep = <T>(obj: T): T => {
  if (typeof (globalThis as any).structuredClone === 'function') {
    try { return (globalThis as any).structuredClone(obj); } catch {}
  }
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
};

const safeStringify = (val: any): string => {
  try { return JSON.stringify(val); } catch { return ''; }
};

const clampString = (str: string, limit: number): string => {
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}… (truncated)`;
};

let anthropicCacheControlSupported: boolean | null = null;

const isAnthropicCacheControlError = (error: any): boolean => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status && status !== 400 && status !== 422) return false;

  const message = String(
    error?.message
    ?? error?.error?.message
    ?? error?.response?.data?.error?.message
    ?? error?.response?.data?.message
    ?? ''
  ).toLowerCase();

  const mentionsField = message.includes('cache_control') || message.includes('cache control') || message.includes('cache-control');
  if (!mentionsField) return false;

  const looksLikeValidation = message.includes('unknown')
    || message.includes('unrecognized')
    || message.includes('unexpected')
    || message.includes('invalid')
    || message.includes('additional properties')
    || message.includes('not allowed');

  return looksLikeValidation;
};


// ============================================================================
// Image Handling
// ============================================================================

const isDataUrl = (s: string): boolean => /^data:[^;]+;base64,/.test(s);

const normalizeImageContent = (content: any): any => {
  if (!Array.isArray(content)) return content;

  return content.map(part => {
    if (!part || typeof part !== 'object') return part;

    if (part.type === 'input_image') {
      const url = part.image_url || '';

      if (isDataUrl(url)) return part;

      if (url && !url.startsWith('http')) {
        const mimeType = part.mime_type || 'image/png';
        return {
          type: 'input_image',
          image_url: `data:${mimeType};base64,${url}`,
          filename: part.filename,
          detail: part.detail
        };
      }
    }

    return part;
  });
};

const tryParseJson = (str: string): any => {
  try { return JSON.parse(str); } catch { return null; }
};

const parseToolArguments = (
  argsJson: string
): {
  value: any;
  error: Error | null;
  repaired: boolean;
  normalizedSource?: string;
  originalError?: Error | null;
  repairError?: Error | null;
} => {
  if (typeof argsJson !== 'string' || !argsJson.trim()) {
    return { value: {}, error: null, repaired: false, normalizedSource: '{}' };
  }

  let originalError: Error | null = null;

  try {
    const parsed = JSON.parse(argsJson);
    return { value: parsed, error: null, repaired: false, normalizedSource: argsJson };
  } catch (err) {
    originalError = err instanceof Error ? err : new Error(String(err));
  }

  try {
    const repairedSource = jsonrepair(argsJson);
    const parsed = JSON.parse(repairedSource);
    return {
      value: parsed,
      error: null,
      repaired: true,
      normalizedSource: repairedSource,
      originalError,
    };
  } catch (repairErr) {
    const repairError = repairErr instanceof Error ? repairErr : new Error(String(repairErr));
    return {
      value: {},
      error: originalError,
      repaired: false,
      originalError,
      repairError,
    };
  }
};

// ============================================================================
// Anthropic Conversion Helpers
// ============================================================================

const toAnthropicTextBlock = (text: any): Anthropic.TextBlockParam | null => {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const normalized = raw.trim();
  if (!normalized) return null;
  return { type: 'text', text: normalized };
};

const sanitizeAnthropicContentBlocks = (
  blocks: Anthropic.ContentBlockParam[] | null | undefined,
  placeholder = '[empty]'
): { blocks: Anthropic.ContentBlockParam[]; changed: boolean } => {
  const normalized: Anthropic.ContentBlockParam[] = [];
  let changed = false;
  const parts = Array.isArray(blocks) ? blocks : [];

  for (const block of parts) {
    if (!block || typeof block !== 'object') continue;
    if ((block as any).type === 'text') {
      const text = typeof (block as any).text === 'string' ? (block as any).text.trim() : '';
      if (!text) {
        changed = true;
        continue;
      }
      normalized.push({ type: 'text', text });
      continue;
    }
    normalized.push(block as Anthropic.ContentBlockParam);
  }

  if (!normalized.length) {
    normalized.push({ type: 'text', text: placeholder });
    changed = true;
  }

  return { blocks: normalized, changed };
};

const toAnthropicImageBlock = (part: any): Anthropic.ImageBlockParam | null => {
  if (!part || typeof part !== 'object') return null;
  const rawUrl = typeof part.image_url === 'string' ? part.image_url : '';
  if (!rawUrl) return null;

  const defaultMime = typeof part.mime_type === 'string' && part.mime_type.trim()
    ? part.mime_type.trim()
    : 'image/png';

  let mediaType = defaultMime;
  let data = '';

  const dataUrlMatch = rawUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1] || defaultMime;
    data = dataUrlMatch[2] || '';
  } else if (/^[A-Za-z0-9+/=]+$/.test(rawUrl)) {
    data = rawUrl;
  }

  if (!data) return null;

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data
    }
  };
};

const normalizeAnthropicUserContent = (
  content: OpenAIUserContent[] | any
): { blocks: Anthropic.ContentBlockParam[]; changed: boolean } => {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const parts = Array.isArray(content) ? content : [];
  let changed = false;

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'input_text') {
      const textBlock = toAnthropicTextBlock((part as any).text);
      if (textBlock) {
        blocks.push(textBlock);
        changed = true;
      }
      continue;
    }

    if (part.type === 'input_image') {
      const image = toAnthropicImageBlock(part);
      if (image) {
        blocks.push(image);
        changed = true;
      }
      continue;
    }

    if (part.type === 'text' || part.type === 'image' || part.type === 'thinking' || part.type === 'tool_use' || part.type === 'tool_result') {
      blocks.push(part as Anthropic.ContentBlockParam);
    }
  }

  const sanitized = sanitizeAnthropicContentBlocks(blocks, '[empty]');
  return { blocks: sanitized.blocks, changed: changed || sanitized.changed };
};

const convertOpenAIToAnthropicItem = (
  item: OpenAIResponseItem | AnthropicConversationItem
): { converted: AnthropicConversationItem | null; changed: boolean } => {
  if ((item as any)?.role === 'user') {
    const { blocks, changed } = normalizeAnthropicUserContent((item as any).content);
    return { converted: { role: 'user', content: blocks }, changed: true };
  }

  if ((item as any)?.role === 'assistant') {
    const content = (item as any).content;
    if (Array.isArray(content)) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      let changed = false;
      for (const part of content) {
        if (part?.type === 'output_text') {
          const textBlock = toAnthropicTextBlock((part as any).text);
          if (textBlock) {
            blocks.push(textBlock);
            changed = true;
          }
        } else if (part?.type === 'text' || part?.type === 'thinking' || part?.type === 'tool_use') {
          blocks.push(part as Anthropic.ContentBlockParam);
        }
      }
      const sanitized = sanitizeAnthropicContentBlocks(blocks, '[empty assistant message]');
      return { converted: { role: 'assistant', content: sanitized.blocks }, changed: true };
    }
    if (typeof content === 'string') {
      const textBlock = toAnthropicTextBlock(content);
      if (!textBlock) return { converted: null, changed: true };
      return { converted: { role: 'assistant', content: [textBlock] }, changed: true };
    }
    return { converted: item as AnthropicConversationItem, changed: false };
  }

  if ((item as any)?.type === 'function_call_output') {
    const callId = typeof (item as any).call_id === 'string' ? (item as any).call_id : '';
    const output = typeof (item as any).output === 'string'
      ? (item as any).output
      : (item as any).output == null ? '' : String((item as any).output);
    if (!callId) return { converted: null, changed: false };
    return {
      converted: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: output
        }]
      },
      changed: true
    };
  }

  if ((item as any)?.type === 'tool_result') {
    const content = Array.isArray((item as any).content) ? (item as any).content : [];
    const cleaned = content.map((block: any) => {
      if (block?.type === 'tool_result') return block;
      return null;
    }).filter(Boolean) as Anthropic.ToolResultBlockParam[];
    return { converted: { role: 'user', content: cleaned }, changed: true };
  }

  return { converted: null, changed: false };
};

const normalizeHistoryForAnthropic = (
  history: (OpenAIResponseItem | AnthropicConversationItem)[]
): { history: AnthropicConversationItem[]; changed: boolean } => {
  const normalized: AnthropicConversationItem[] = [];
  let changed = false;

  for (const item of history || []) {
    const { converted, changed: itemChanged } = convertOpenAIToAnthropicItem(item);
    if (converted) {
      const content = (converted as any).content;
      if (content) {
        const sanitized = sanitizeAnthropicContentBlocks(content as Anthropic.ContentBlockParam[], '[empty]');
        (converted as any).content = sanitized.blocks;
        if (sanitized.changed) changed = true;
      }
      normalized.push(converted);
    }
    if (itemChanged) changed = true;
  }

  return { history: normalized, changed };
};

// ============================================================================
// History Management
// ============================================================================

const extractText = (item: OpenAIResponseItem): string => {
  if (typeof item.content === 'string') return item.content;

  if (Array.isArray(item.content)) {
    return item.content
      .map(part => {
        if (part && typeof part === 'object') {
          if ('text' in part) return (part as any).text;
          if (part.type === 'input_image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }

  if (typeof item.output === 'string') return item.output;
  if (typeof item.arguments === 'string') return item.arguments;

  return '';
};

// ============================================================================
// System Prompt Building
// ============================================================================

async function findAgentsMdFiles(root: string, opts?: { maxFiles?: number; maxDepth?: number }): Promise<string[]> {
  const maxFiles = opts?.maxFiles ?? 5;
  const maxDepth = opts?.maxDepth ?? 6;
  const found: string[] = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.vercel', '.turbo', '.venv', 'venv']);

  const isAgents = (name: string) => name.toLowerCase() === 'agents.md';

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= maxFiles) return;
    if (depth > maxDepth) return;
    let dirents: import('fs').Dirent[] = [];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (found.length >= maxFiles) break;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (ignoreDirs.has(d.name)) continue;
        await walk(full, depth + 1);
      } else if (d.isFile() && isAgents(d.name)) {
        found.push(full);
      }
    }
  };

  try {
    const stat = await fs.stat(root);
    if (stat.isDirectory()) {
      const rootCandidate = path.join(root, 'AGENTS.md');
      try { const st = await fs.stat(rootCandidate); if (st.isFile()) found.push(rootCandidate); } catch {}
      const rootCandidateLower = path.join(root, 'agents.md');
      try { const st = await fs.stat(rootCandidateLower); if (st.isFile() && !found.includes(rootCandidate)) found.push(rootCandidateLower); } catch {}
      await walk(root, 0);
    } else if (stat.isFile() && root.toLowerCase().endsWith('agents.md')) {
      found.push(root);
    }
  } catch {}

  const seen = new Set<string>();
  return found.filter(p => (seen.has(p) ? false : (seen.add(p), true)));
}

async function buildAgentsMdSection(workingDir: string): Promise<string> {
  const files = await findAgentsMdFiles(workingDir, { maxFiles: 6, maxDepth: 8 });
  if (files.length === 0) return '';

  const clamp = (s: string, max = 2000) => (s.length > max ? s.slice(0, max) + '\n…(truncated)…' : s);

  const parts: string[] = [];
  parts.push('AGENTS.md files detected. Treat them as additional instructions (do not override direct user prompts).');
  for (const f of files) {
    let txt = '';
    try { txt = await fs.readFile(f, 'utf8'); } catch { txt = ''; }
    parts.push(`-- ${f}:\n${clamp(txt)}`);
  }
  return parts.join('\n');
}

function buildSystemPrompt(workingDir: string, dirLines: string[], extra?: string): string {
  return [
    `You are BrilliantCode, created by BrilliantAI, "https://brilliantai.co", you are an autonomous AI Engineer working inside an Electron IDE`,
    `You terminal access gives you same level of access as a human developer would have inside this IDE, inclusing using installed CLIs, git etc.`,
    `- Integrated terminals you can manage via tools:`,
    `    • create_terminal({ cwd?, cols?, rows? }) -> returns a terminal id (default terminal id is "default").`,
    `    • terminal_input({ text, newline?, terminal_id? }) # send input to a specific terminal (defaults to "default").`,
    `    • read_terminal({ lines?, bytes?, stripAnsi?, terminal_id? }) # tail output from a terminal.`,
    `    • summarize_terminal_output({ lines?, bytes?, stripAnsi?, terminal_id?, prompt }) # read recent terminal output and summarize it into a few actionable lines (uses gpt-5-mini).`,
    `    • close_terminal({ terminal_id }) # close/dispose a terminal by id. Use to clean up terminals no longer needed. Cannot close "default".`,
    `    • detect_dev_server({ bytes?, terminal_id? })  # scan a terminal for running localhost servers and ports.`,
    `- File manipulation tools (all paths relative to project root):`,
    `    • create_file({ filePath, content })  # create a new file or overwrite an existing one with the given content. Use for writing new code, configs, documentation, etc.`,
    `    • create_diff({ filePath, oldText, newText })  # replace all occurrences of oldText with newText in a file. Preferred for surgical edits—avoids rewriting entire files.`,
    `    • read_file({ filePath })  # read the full contents of a text file.`,
    `    • grep_search({ pattern, files, ... })  # search for a pattern within files. Primary tool for reading large files—extract relevant sections to conserve context.`,
    `    • get_file_size({ filePath })  # count words and lines of a file. Use before deciding between grep_search or read_file.`,
    `- Preview panel/browser tools:`,
    `    • set_preview_url({ url, tabId?, openNewTab?, focus? })  # navigate the Preview panel to a URL (http(s) or local file path). Returns tabId for tab management.`,
    `    • preview_file({ path })  # open a local file (HTML, image, PDF, or text) in the Preview panel for visual inspection.`,
    `    • screenshot_preview()  # captures a PNG of the current Preview webview contents.`,
    `    • get_preview_info({ historyCount? })  # current Preview URL/title and recent navigation history.`,
    `    • list_preview_tabs()  # list all open preview browser tabs (id, title, URL).`,
    `    • get_active_preview_tab()  # return the currently active preview tab.`,
    `    • activate_preview_tab({ tabId, focus? })  # switch to an existing preview tab.`,
    `    • refresh_preview_tab({ tabId?, focus? })  # reload the current URL in a preview tab.`,
    `    • close_preview_tab({ tabId, focus? })  # close a preview tab by id.`,
    `- Frontend inspection tools:`,
    `    • visit_url({ url })  # visits a URL using the in-built browser and returns a screenshot, page text, and links. Single-shot with NO scroll, click, or interaction—only captures what's visible on initial load. Follow links by calling visit_url again with different URLs.`,
    `- Web/internet tools:`,
    `    • google_search({ query, start? })  # perform a Google web search via the BrilliantAI backend and return structured results (use this for internet knowledge, not local file search).`,
    `When searching for information, use a combination of google_search and visit_url to find and read relevant web pages and follow links as needed.`,
    `Always use the provided tools. Note: there is NO direct DOM manipulation, scrolling, clicking, or keyboard control available for web pages.`,
    `Synergy: Before starting any dev server, call get_preview_info to see if one is already open in the Preview. If it is, reuse it. If you do start one, call detect_dev_server to find the actual URL/port and then set_preview_url to it.`,

    `Project root: ${workingDir}.`,
    `Directory tree (truncated):`,
    dirLines.join('\n'),
    ``,
    `You also have access to in-memory TODO tools to track tasks during this session.`,
    `- Todos are stored in a dictionary keyed by integer indices starting at 1.`,
    `- Each todo item has: status ('todo' | 'in_progress' | 'done') and content (string).`,
    `- Use these tools to manage tasks:`,
    `    • add_todo_tool(content)`,
    `    • update_todo_item_tool(index, content)`,
    `    • update_todo_status_tool(index, status)  # status one of: 'todo', 'in_progress', 'done' (aliases accepted)`,
    `    • list_todos_tool()`,
    `    • clear_todos_tool()`,
    `Guidance:`,
    `- Before calling a tool, explain why you are calling it.`,
    `- If you are unclear on a user's prompt, ask clarifying questions before starting work`,
    `- Do not execute commands you consider unsafe without explicit user confirmation.`,
    `- When the user specifies tasks or sub-tasks, add them as todos with add_todo_tool.`,
    `- Update statuses as you make progress: 'todo' -> 'in_progress' -> 'done'.`,
    `- Keep indices stable; do not reuse indices after completion; only clear via clear_todos_tool when appropriate.`,
    `- Periodically call list_todos_tool to summarize current plan/progress back to the user.`,
    `- Use set_preview_url to demonstrate artifacts you created. Manage multiple preview tabs with the preview tab tools (list, activate, refresh, close).`,
    `- Use visit_url and google_search for web browsing and internet searches; avoid curl for fetching web pages when these tools suffice.`,
    `- When referencing workspace files in Markdown, link them with the workspace:// protocol and include a line range when relevant (e.g., [src/main.ts L100–L120](workspace://src/main.ts#L100-L120)). The app will auto-show those lines inline.`,
    `- Only read AGENTS.md files if it is present in the Directory tree given above`,
    `- If AGENTS.md files are present, treat their contents as additional workspace instructions (tips, conventions, run/test commands). They DO NOT override direct user prompts.`,
    `- Apply AGENTS.md by scope: a file applies to the directory it lives in and all subdirectories. Deeper files take precedence when instructions conflict.`,
    `- When AGENTS.md includes suggested commands (e.g., fenced bash blocks or lines starting with '), proactively run them via 'terminal_input' when relevant. In chat mode, request confirmation for potentially destructive actions.`,
    `- When asked to perform operations such as deploying websites to azure, gcp or aws, use the appropriate commands like az for azure, run them via terminal to perform the requested operations.`,
    `Tool choice policy:`,
    `- Use create_file to write new files (code, configs, docs). Use create_diff for targeted edits to existing files—preferred when only small portions need changes to preserve context and avoid accidental overwrites.`,
    `- Use get_file_size first to check file length, then grep_search for large files (extract relevant sections) or read_file for small files when full content is needed.`,
    `- Use set_preview_url or preview_file to visually inspect local HTML pages, images, PDFs—especially useful after generating or modifying front-end assets.`,
    `- Use terminal_input (and create_terminal) for shell commands of any kind, especially long-running, interactive, or state-changing flows (e.g., 'npm install', 'npm run dev', 'docker compose up', 'python -m http.server').`,
    `- When a command produces long/noisy terminal output (e.g., npm/yarn/pnpm installs, builds, test runs), prefer summarize_terminal_output({ ...read_terminal args..., prompt }) to extract only the actionable errors/warnings/next steps. Use read_terminal only when you need the raw log for a specific detail.`,
    `- When finished with a task, clean up any terminals you created that are no longer needed using close_terminal. Keep terminals running only for active servers/watchers the user needs.`,
    `- Use wait_tool when you need to monitor a very long running terminal operation, for example training a model.`,
    `- Use generate_image_tool for all image generation needs such as creating assets for a web page or application, avoid creating svgs except when explicitly requested by the user, instead prefer generating png or jpg images using this generate_image_tool.`,
    `- VERY IMPORTANT: Except when absolutely necessary, avoid using terminal to write or modify files or read files and instead use the appropriate tools described above for file manipulation. This is to avoid issues with file encoding, line endings, accidental overwrites, and loss of context.`,
    `Python Guidance`,
    `- When working with python, except stated otherwise in user instructions, user files etc, prefer to use uv for managing python environments and installations. You can install uv if not currently installed`,
    `Final Answer Guidance:`,
    `- In your final answers to the user or follow up questions, be concise and to the point, and properly use workspace:// links to reference files you have created or modified, and cite any websites you used via google_search or visit_url calls.`,
    extra ? `\n${extra}` : ''
  ].join('\n');
}

type SystemPromptParts = { combined: string; staticPrompt: string; dynamicPrompt: string };

function buildStaticSystemPrompt(): string {
  return [
    `You are BrilliantCode, created by BrilliantAI, "https://brilliantai.co", you are an autonomous AI Engineer working inside an Electron IDE`,
    `You terminal access gives you same level of access as a human developer would have inside this IDE, inclusing using installed CLIs, git etc.`,
    `- Integrated terminals you can manage via tools:`,
    `    • create_terminal({ cwd?, cols?, rows? }) -> returns a terminal id (default terminal id is "default").`,
    `    • terminal_input({ text, newline?, terminal_id? }) # send input to a specific terminal (defaults to "default").`,
    `    • read_terminal({ lines?, bytes?, stripAnsi?, terminal_id? }) # tail output from a terminal.`,
    `    • summarize_terminal_output({ lines?, bytes?, stripAnsi?, terminal_id?, prompt }) # read recent terminal output and summarize it into a few actionable lines (uses gpt-5-mini).`,
    `    • close_terminal({ terminal_id }) # close/dispose a terminal by id. Use to clean up terminals no longer needed. Cannot close "default".`,
    `    • detect_dev_server({ bytes?, terminal_id? })  # scan a terminal for running localhost servers and ports.`,
    `- File manipulation tools (all paths relative to project root):`,
    `    • create_file({ filePath, content })  # create a new file or overwrite an existing one with the given content. Use for writing new code, configs, documentation, etc.`,
    `    • create_diff({ filePath, oldText, newText })  # replace all occurrences of oldText with newText in a file. Preferred for surgical edits—avoids rewriting entire files.`,
    `    • read_file({ filePath })  # read the full contents of a text file.`,
    `    • grep_search({ pattern, files, ... })  # search for a pattern within files. Primary tool for reading large files—extract relevant sections to conserve context.`,
    `    • get_file_size({ filePath })  # count words and lines of a file. Use before deciding between grep_search or read_file.`,
    `- Preview panel/browser tools:`,
    `    • set_preview_url({ url, tabId?, openNewTab?, focus? })  # navigate the Preview panel to a URL (http(s) or local file path). Returns tabId for tab management.`,
    `    • preview_file({ path })  # open a local file (HTML, image, PDF, or text) in the Preview panel for visual inspection.`,
    `    • screenshot_preview()  # captures a PNG of the current Preview webview contents.`,
    `    • get_preview_info({ historyCount? })  # current Preview URL/title and recent navigation history.`,
    `    • list_preview_tabs()  # list all open preview browser tabs (id, title, current URL).`,
    `    • get_active_preview_tab()  # return the currently active preview tab.`,
    `    • activate_preview_tab({ tabId, focus? })  # switch to an existing preview tab.`,
    `    • refresh_preview_tab({ tabId?, focus? })  # reload the current URL in a preview tab.`,
    `    • close_preview_tab({ tabId, focus? })  # close a preview tab by id.`,
    `- Frontend inspection tools:`,
    `    • visit_url({ url })  # visits a URL using the in-built browser and returns a screenshot, page text, and links. Single-shot with NO scroll, click, or interaction—only captures what's visible on initial load. Follow links by calling visit_url again with different URLs.`,
    `- Web/internet tools:`,
    `    • google_search({ query, start? })  # perform a Google web search via the BrilliantAI backend and return structured results (use this for internet knowledge, not local file search).`,
    `When searching for information, use a combination of google_search and visit_url to find and read relevant web pages and follow links as needed.`,
    `Always use the provided tools. Note: there is NO direct DOM manipulation, scrolling, clicking, or keyboard control available for web pages.`,
    `Synergy: Before starting any dev server, call get_preview_info to see if one is already open in the Preview. If it is, reuse it. If you do start one, call detect_dev_server to find the actual URL/port and then set_preview_url to it.`,

    `You also have access to in-memory TODO tools to track tasks during this session.`,
    `- Todos are stored in a dictionary keyed by integer indices starting at 1.`,
    `- Each todo item has: status ('todo' | 'in_progress' | 'done') and content (string).`,
    `- Use these tools to manage tasks:`,
    `    • add_todo_tool(content)`,
    `    • update_todo_item_tool(index, content)`,
    `    • update_todo_status_tool(index, status)  # status one of: 'todo', 'in_progress', 'done' (aliases accepted)`,
    `    • list_todos_tool()`,
    `    • clear_todos_tool()`,
    `Guidance:`,
    `- Before calling a tool, explain why you are calling it.`,
    `- If you are unclear on a user's prompt, ask clarifying questions before starting work`,
    `- Do not execute commands you consider unsafe without explicit user confirmation.`,
    `- When the user specifies tasks or sub-tasks, add them as todos with add_todo_tool.`,
    `- Update statuses as you make progress: 'todo' -> 'in_progress' -> 'done'.`,
    `- Keep indices stable; do not reuse indices after completion; only clear via clear_todos_tool when appropriate.`,
    `- Periodically call list_todos_tool to summarize current plan/progress back to the user.`,
    `- Use set_preview_url to demonstrate artifacts you created. Manage multiple preview tabs with the preview tab tools (list, activate, refresh, close).`,
    `- Use visit_url and google_search for web browsing and internet searches; avoid curl for fetching web pages when these tools suffice.`,
    `- When referencing workspace files in Markdown, link them with the workspace:// protocol and include a line range when relevant (e.g., [src/main.ts L100–L120](workspace://src/main.ts#L100-L120)). The app will auto-show those lines inline.`,
    `- Only read AGENTS.md files if it is present in the Directory tree given above`,
    `- If AGENTS.md files are present, treat their contents as additional workspace instructions (tips, conventions, run/test commands). They DO NOT override direct user prompts.`,
    `- Apply AGENTS.md by scope: a file applies to the directory it lives in and all subdirectories. Deeper files take precedence when instructions conflict.`,
    `- When AGENTS.md includes suggested commands (e.g., fenced bash blocks or lines starting with '), proactively run them via 'terminal_input' when relevant. In chat mode, request confirmation for potentially destructive actions.`,
    `- When asked to perform operations such as deploying websites to azure, gcp or aws, use the appropriate commands like az for azure, run them via terminal to perform the requested operations.`,
    `Tool choice policy:`,
    `- Use create_file to write new files (code, configs, docs). Use create_diff for targeted edits to existing files—preferred when only small portions need changes to preserve context and avoid accidental overwrites.`,
    `- Use get_file_size first to check file length, then grep_search for large files (extract relevant sections) or read_file for small files when full content is needed.`,
    `- Use set_preview_url or preview_file to visually inspect local HTML pages, images, PDFs—especially useful after generating or modifying front-end assets.`,
    `- Use terminal_input (and create_terminal) for shell commands of any kind, especially long-running, interactive, or state-changing flows (e.g., 'npm install', 'npm run dev', 'docker compose up', 'python -m http.server').`,
    `- When a command produces long/noisy terminal output (e.g., npm/yarn/pnpm installs, builds, test runs), prefer summarize_terminal_output({ ...read_terminal args..., prompt }) to extract only the actionable errors/warnings/next steps. Use read_terminal only when you need the raw log for a specific detail.`,
    `- When finished with a task, clean up any terminals you created that are no longer needed using close_terminal. Keep terminals running only for active servers/watchers the user needs.`,
    `- Use wait_tool when you need to monitor a very long running terminal operation, for example training a model.`,
    `- Use generate_image_tool for all image generation needs such as creating assets for a web page or application, avoid creating svgs except when explicitly requested by the user, instead prefer generating png or jpg images using this generate_image_tool.`,
    `- VERY IMPORTANT: Except when absolutely necessary, avoid using terminal to write or modify files or read files and instead use the appropriate tools described above for file manipulation. This is to avoid issues with file encoding, line endings, accidental overwrites, and loss of context.`,
    `Python Guidance`,
    `- When working with python, except stated otherwise in user instructions, user files etc, prefer to use uv for managing python environments and installations. You can install uv if not currently installed`,
    `Final Answer Guidance:`,
    `- In your final answers to the user or follow up questions, be concise and to the point, and properly use workspace:// links to reference files you have created or modified, and cite any websites you used via google_search or visit_url calls.`,
  ].join('\n');
}

function buildDynamicSystemPrompt(workingDir: string, dirLines: string[], extra?: string): string {
  const parts: string[] = [];
  parts.push(`Project root: ${workingDir}.`);
  parts.push(`Directory tree (truncated):`);
  parts.push(dirLines.join('\n'));
  if (extra && extra.trim()) {
    parts.push('');
    parts.push(extra.trim());
  }
  return parts.join('\n');
}

function buildSystemPromptParts(workingDir: string, dirLines: string[], extra?: string): SystemPromptParts {
  const staticPrompt = buildStaticSystemPrompt();
  const dynamicPrompt = buildDynamicSystemPrompt(workingDir, dirLines, extra);
  const combined = [staticPrompt, dynamicPrompt].filter(Boolean).join('\n\n');
  return { combined, staticPrompt, dynamicPrompt };
}

// ============================================================================
// Retry Logic
// ============================================================================

const readHeader = (headers: any, name: string): string => {
  if (!headers) return '';
  const target = name.toLowerCase();
  if (typeof headers.get === 'function') {
    try {
      const value = headers.get(name) ?? headers.get(target);
      if (typeof value === 'string' && value.trim()) return value;
    } catch {}
  }
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== target) continue;
      const raw = (headers as any)[key];
      if (typeof raw === 'string' && raw.trim()) return raw;
      if (Array.isArray(raw) && raw.length) return String(raw[0] ?? '').trim();
    }
  }
  return '';
};

const parseRetryAfterMs = (value: string, assumeSeconds = true): number | null => {
  const normalized = (value || '').trim();
  if (!normalized) return null;

  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return assumeSeconds ? Math.floor(numeric * 1000) : Math.floor(numeric);
  }

  const dateMs = Date.parse(normalized);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    if (diff > 0) return diff;
  }

  return null;
};

const extractRetryAfterMs = (error: any): number | null => {
  const headers = error?.response?.headers ?? error?.headers;
  if (!headers) return null;

  const candidates: Array<number | null> = [];

  candidates.push(parseRetryAfterMs(readHeader(headers, 'retry-after'), true));
  candidates.push(parseRetryAfterMs(readHeader(headers, 'retry-after-ms'), false));
  candidates.push(parseRetryAfterMs(readHeader(headers, 'x-ms-retry-after-ms'), false));
  candidates.push(parseRetryAfterMs(readHeader(headers, 'x-ratelimit-reset'), true));
  candidates.push(parseRetryAfterMs(readHeader(headers, 'x-ratelimit-reset-requests'), true));
  candidates.push(parseRetryAfterMs(readHeader(headers, 'x-ratelimit-reset-tokens'), true));

  const usable = candidates.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!usable.length) return null;
  return Math.max(...usable);
};

const computeRetryDelayMs = (
  error: any,
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  const isRateLimit = status === 429 || error?.type === 'rate_limit_error';

  const expDelay = Math.min(baseDelay * Math.pow(2, attempt), isRateLimit ? RATE_LIMIT_MAX_DELAY_MS : maxDelay);
  const jitter = Math.random() * expDelay * 0.3;
  let delay = expDelay + jitter;

  const retryAfterMs = extractRetryAfterMs(error);
  if (retryAfterMs !== null) {
    delay = Math.max(delay, retryAfterMs);
  } else if (isRateLimit) {
    delay = Math.max(delay, RATE_LIMIT_FLOOR_DELAY_MS);
  }

  return Math.min(delay, isRateLimit ? RATE_LIMIT_MAX_DELAY_MS : maxDelay);
};

const isTransientError = (error: any): boolean => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (typeof status === 'number') {
    if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
    if ([400, 401, 403, 404, 422].includes(status)) return false;
  }

  const code = error?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)) {
    return true;
  }

  const errorType = error?.type;
  if (errorType === 'overloaded_error' || errorType === 'rate_limit_error') {
    return true;
  }

  const msg = String(error?.message || '').toLowerCase();
  const hints = ['network', 'timeout', 'unavailable', 'bad gateway', 'rate limit', 'overloaded'];
  return hints.some(h => msg.includes(h));
};

const retry = async <T>(
  fn: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    timeBudgetMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: any) => boolean;
    computeDelayMs?: (error: any, attempt: number, baseDelayMs: number, maxDelayMs: number) => number;
  }
): Promise<T> => {
  const budgetMs = options?.timeBudgetMs ?? RETRY_BUDGET_MS;
  const baseDelay = options?.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const shouldRetry = options?.shouldRetry ?? isTransientError;
  const computeDelay = options?.computeDelayMs;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : null;

  let attempt = 0;

  const summarize = (error: any) => {
    const status = error?.status ?? error?.statusCode ?? error?.response?.status;
    const code = error?.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return { attempt: attempt + 1, status, code, message };
  };

  while (true) {
    try {
      return await fn();
    } catch (error) {
      try { console.warn('[AgentSession][retry] attempt failed', summarize(error)); } catch {}

      if (!shouldRetry(error)) {
        try { console.warn('[AgentSession][retry] not retrying (non-transient)', summarize(error)); } catch {}
        throw error;
      }

      if (deadline && Date.now() >= deadline) {
        try { console.warn('[AgentSession][retry] time budget exceeded', summarize(error)); } catch {}
        throw error;
      }

      let delay = computeDelay
        ? computeDelay(error, attempt, baseDelay, maxDelay)
        : computeRetryDelayMs(error, attempt, baseDelay, maxDelay);

      if (deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          try { console.warn('[AgentSession][retry] deadline reached before delay', summarize(error)); } catch {}
          throw error;
        }
        delay = Math.min(delay, remaining);
      }

      try {
        const err = error as { status?: number; statusCode?: number; response?: { status?: number } };
        const status = err.status ?? err.statusCode ?? err.response?.status;
        const retryAfter = extractRetryAfterMs(error);
        console.warn('[AgentSession][retry] scheduling retry', {
          attempt: attempt + 1,
          status,
          delayMs: Math.floor(delay),
          retryAfterMs: retryAfter ?? undefined,
        });
      } catch (caught: unknown) {
        const err = caught as { status?: number; statusCode?: number; response?: { status?: number } };
        const status = err.status ?? err.statusCode ?? err.response?.status;
        void status;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }
};

// ============================================================================
// Response Polling (for non-streaming models)
// ============================================================================

type WaitForResponseOpts = {
  isStopping?: () => boolean;
  timeoutMs?: number;
};

const waitForResponseCompletion = async (client: any, initial: any, opts?: WaitForResponseOpts): Promise<any> => {
  if (!initial || typeof initial !== 'object') return initial;

  const status = typeof initial?.status === 'string' ? initial.status.toLowerCase() : '';

  if (!status || status === 'completed' || status === 'succeeded' || status === 'success') {
    return initial;
  }

  const successStates = new Set(['completed', 'succeeded', 'success']);
  const progressStates = new Set(['queued', 'pending', 'in_progress', 'processing', 'running']);
  const failureStates = new Set(['failed', 'cancelled', 'canceled', 'rejected']);

  const responsesApi = client?.responses;
  if (!responsesApi) return initial;

  const unwrap = (value: any) => (value && typeof value === 'object' && value.result && typeof value.result === 'object'
    ? value.result
    : value);

  const responseId = typeof initial?.id === 'string' ? initial.id : '';
  let pollUrl = typeof initial?.poll_url === 'string' ? initial.poll_url.trim() : '';
  const supportsPoll = typeof (responsesApi as any)?.poll === 'function';
  const startedAt = Date.now();
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : RESPONSE_POLL_TIMEOUT_MS;
  let current = initial;

  while (!(opts?.isStopping && opts.isStopping())) {
    if (typeof current?.poll_url === 'string' && current.poll_url.trim()) {
      pollUrl = current.poll_url.trim();
    }

    const rawStatus = typeof current?.status === 'string' ? current.status : '';
    const status = rawStatus.toLowerCase();

    if (!status || successStates.has(status)) {
      return unwrap(current);
    }

    if (failureStates.has(status)) {
      const errorInfo = (current && typeof current === 'object'
        ? current.error ?? current.result?.error ?? current
        : undefined) ?? {};
      const statusCode = typeof (errorInfo as any)?.status_code === 'number'
        ? (errorInfo as any).status_code
        : typeof (current as any)?.status_code === 'number'
          ? (current as any).status_code
          : undefined;
      const detail = typeof (errorInfo as any)?.detail === 'string'
        ? (errorInfo as any).detail
        : typeof (errorInfo as any)?.message === 'string'
          ? (errorInfo as any).message
          : typeof (current as any)?.detail === 'string'
            ? (current as any).detail
            : undefined;
      const baseMessage = detail ?? `Model response ${status}`;
      const message = statusCode ? `Request failed (${statusCode}): ${baseMessage}` : baseMessage;
      throw new Error(message);
    }

    if (!progressStates.has(status)) {
      return current;
    }

    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for model response after ${timeoutMs}ms (last status: ${status || 'unknown'}).`);
    }

    const backoff = Math.min(2000 + Math.floor(Math.random() * 2000), 8000);
    await new Promise(resolve => setTimeout(resolve, backoff));

    try {
      current = await retry(() => {
        if (supportsPoll && pollUrl) {
          return (responsesApi as any).poll(pollUrl);
        }
        if (!responseId) {
          throw new Error('Response ID missing for polling');
        }
        return responsesApi.retrieve(responseId);
      }, {
        shouldRetry: isTransientError,
        timeBudgetMs: 30_000,
        baseDelayMs: 250,
        maxDelayMs: RETRY_MAX_DELAY_MS
      });
    } catch (error: any) {
      const statusCode = error?.status ?? error?.statusCode ?? error?.response?.status;
      if (statusCode === 404) {
        return current;
      }
      throw error;
    }
  }

  return current;
};

// ============================================================================
// Tool Execution
// ============================================================================

const executeToolCall = async (
  toolName: string,
  callId: string,
  argsJson: string,
  handler: ToolHandler,
  transport: AgentSessionTransport,
  signal?: AbortSignal
): Promise<{ result: string; data: any }> => {
  const {
    value: parsedArgsValue,
    error: parseError,
    repaired: argsRepaired,
    normalizedSource,
    originalError,
    repairError,
  } = parseToolArguments(argsJson);
  let args: any = {};

  if (!parseError && parsedArgsValue && typeof parsedArgsValue === 'object' && !Array.isArray(parsedArgsValue)) {
    args = parsedArgsValue;
  }

  if (!parseError && signal) {
    args._abortSignal = signal;
    if (args.opts && typeof args.opts === 'object') {
      args.opts.abortSignal = signal;
    }
  }

  const effectiveArgsJson = normalizedSource ?? argsJson;

  transport.emit('ai:tool:start', { id: callId, name: toolName });
  transport.emit('ai:tool:exec', {
    id: callId,
    name: toolName,
    arguments: argsJson,
    normalizedArguments: effectiveArgsJson,
    repaired: argsRepaired,
  });

  if (argsRepaired && originalError) {
    const rawArgsPreview = clampString(argsJson ?? '', TOOL_PREVIEW_LIMIT);
    console.warn('[AgentSession] Automatically repaired tool arguments', {
      toolName,
      callId,
      originalError: originalError.message,
      repairedArgumentsPreview: clampString(effectiveArgsJson ?? '', TOOL_PREVIEW_LIMIT),
      rawArguments: rawArgsPreview,
    });
  }

  if (parseError) {
    const errorMessage = `JSON parse error: ${parseError.message}`;
    const rawArgsPreview = clampString(argsJson ?? '', TOOL_PREVIEW_LIMIT);
    console.error('[AgentSession] Tool argument JSON parse error', parseError, {
      toolName,
      callId,
      rawArguments: rawArgsPreview,
      repairError: repairError?.message,
    });

    const data = {
      ok: false,
      error: errorMessage,
      parseError: {
        name: parseError.name,
        message: parseError.message,
      },
      rawArguments: argsJson,
      repairError: repairError
        ? {
            name: repairError.name,
            message: repairError.message,
          }
        : undefined,
    };

    transport.emit('ai:tool:result', {
      id: callId,
      name: toolName,
      result: errorMessage,
      data,
    });

    return { result: errorMessage, data };
  }

  let result: any;
  let error: any;

  try {
    result = await handler(args);
  } catch (e) {
    error = e;
    result = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  let data: any;
  let resultText: string;

  if (toolName === 'generate_image_tool' && result && typeof result === 'object' && typeof (result as any).base64 === 'string') {
    const base64 = String((result as any).base64 || '');
    const mime = typeof (result as any).mime === 'string' && (result as any).mime.trim()
      ? String((result as any).mime)
      : 'image/png';
    const path = typeof (result as any).path === 'string' ? String((result as any).path) : undefined;
    const message = typeof (result as any).message === 'string' ? String((result as any).message) : '';
    const errorText = typeof (result as any).error === 'string' ? String((result as any).error) : '';
    data = {
      ok: Boolean((result as any).ok),
      error: errorText || undefined,
      path,
      message,
      base64,
      mime,
    };
    resultText = errorText ? `Error: ${errorText}` : (message || (path ? `Image saved to ${path}` : 'Image generated.'));
  } else if ((toolName === 'screenshot_preview' || toolName === 'visit_url') && result && typeof result === 'object' && (result as any).data) {
    const mime = result.mime || 'image/png';
    const imageData = result.data;

    data = {
      mime,
      data: imageData,
      filename: result.filename,
      ...(toolName === 'visit_url' ? { url: result.url, text: result.text, links: result.links } : {}),
    };

    resultText = toolName === 'visit_url'
      ? `[Visited URL: ${result.url || ''}]`
      : '[Screenshot captured]';
  } else if (typeof result === 'string') {
    resultText = result;
    data = tryParseJson(result);
  } else if (result && typeof result === 'object') {
    data = cloneDeep(result);
    resultText = safeStringify(result);
  } else {
    resultText = typeof result === 'undefined' ? '' : String(result);
    data = result;
  }

  transport.emit('ai:tool:result', {
    id: callId,
    name: toolName,
    result: resultText,
    data
  });

  return { result: resultText, data };
};

// ============================================================================
// Confirmation Logic
// ============================================================================

const needsConfirmation = (toolName: string, autoMode: boolean): boolean => {
  if (autoMode) return false;
  return ['create_file', 'create_diff', 'terminal_input'].includes(toolName);
};

const buildPreview = (toolName: string, args: any): any => {
  if (toolName === 'create_file') {
    return {
      type: 'file',
      path: args.filePath || '',
      content: clampString(args.content || '', 1200),
      encoding: args.encoding
    };
  }

  if (toolName === 'create_diff') {
    return {
      type: 'diff',
      path: args.filePath || '',
      oldText: clampString(args.oldText || '', 800),
      newText: clampString(args.newText || '', 800)
    };
  }

  if (toolName === 'terminal_input') {
    return {
      type: 'terminal_input',
      text: clampString(args.text || '', 300),
      newline: !!args.newline,
      terminal_id: args.terminal_id || 'default'
    };
  }

  return undefined;
};

// ============================================================================
// Main Agent Session Class
// ============================================================================

export class AgentSession {
  private transport: AgentSessionTransport;
  private client: any;
  private toolsSchema: any[];
  private toolHandlers: Record<string, ToolHandler>;
  private model: string;
  private workingDir: string;
  private additionalWorkingDir: string | null;
  private autoMode: boolean;
  private chatStore: ChatStore;

  private systemPrompt: string | null = null;
  private systemPromptStatic: string | null = null;
  private systemPromptDynamic: string | null = null;
  private stopping = false;
  private abortControllers = new Map<string, AbortController>();

  constructor(args: {
    transport: AgentSessionTransport;
    client: any;
    toolsSchemaOAI?: any[];
    toolHandlers: Record<string, ToolHandler>;
    model: string;
    workingDir: string;
    additionalWorkingDir?: string;
    autoMode: boolean;
    chatStore: ChatStore;
  }) {
    this.transport = args.transport;
    this.client = args.client;
    this.toolsSchema = args.toolsSchemaOAI || [];
    this.toolHandlers = args.toolHandlers;
    this.model = args.model;
    this.workingDir = args.workingDir;
    this.additionalWorkingDir = args.additionalWorkingDir || null;
    this.autoMode = args.autoMode;
    this.chatStore = args.chatStore;
  }

  stop(): void {
    this.stopping = true;
    this.abortControllers.forEach(ac => {
      try { ac.abort(); } catch {}
    });
    this.abortControllers.clear();
  }

  setWorkingDir(dir: string): void {
    this.workingDir = dir;
    this.systemPrompt = null;
    this.systemPromptStatic = null;
    this.systemPromptDynamic = null;
  }

  private async ensureSystemPrompt(extra?: string): Promise<string> {
    if (this.systemPrompt) return this.systemPrompt;
    const tree = await listDirTree(this.workingDir);
    let agentsSection = '';
    try {
      agentsSection = await buildAgentsMdSection(this.workingDir);
    } catch {
      agentsSection = '';
    }

    let additionalDirSection = '';
    if (this.additionalWorkingDir) {
      try {
        const additionalTree = await listDirTree(this.additionalWorkingDir);
        additionalDirSection = [
          ``,
          `Additional working directory: ${this.additionalWorkingDir}`,
          `IMPORTANT: File tools (read_file, create_file, create_diff, get_file_size, generate_image_tool) work in BOTH the project root AND this additional directory.`,
          `grep_search searches BOTH directories by default. You may force a specific directory by prefixing the 'files' argument with 'workspace:' or 'additional:'.`,
          `Relative paths auto-resolve to the directory where the file exists. If ambiguous, the project root wins. You may force a specific directory with 'workspace:' or 'additional:' prefixes.`,
          `Directory tree (truncated):`,
          additionalTree.join('\n'),
          ``
        ].join('\n');
      } catch {
        additionalDirSection = '';
      }
    }

    const combinedExtra = [agentsSection, additionalDirSection, extra || ''].filter(Boolean).join('\n\n');
    const parts = buildSystemPromptParts(this.workingDir, tree, combinedExtra);
    this.systemPrompt = parts.combined;
    this.systemPromptStatic = parts.staticPrompt;
    this.systemPromptDynamic = parts.dynamicPrompt;
    return this.systemPrompt;
  }

  private emitError(message: string, error?: any): void {
    console.error('[AgentSession]', message, error);
    this.transport.emit('ai:chatStream:error', message);
  }

  // ============================================================================
  // Context Metrics Logging
  // ============================================================================

  private logContextMetrics(
    history: OpenAIResponseItem[] | AnthropicConversationItem[],
    provider: Provider,
    iteration: number,
    phase: string,
    configOverride?: Partial<CompactionConfig>
  ): void {
    try {
      const metrics = provider === 'openai'
        ? getOpenAIMetrics(history as OpenAIResponseItem[])
        : getAnthropicMetrics(history as AnthropicConversationItem[]);

      const base = provider === 'openai'
        ? { ...DEFAULT_OPENAI_COMPACTION_CONFIG }
        : { ...DEFAULT_ANTHROPIC_COMPACTION_CONFIG };

      const modelInfo = MODELS[this.model];
      if (typeof modelInfo?.contextWindowTokens === 'number' && Number.isFinite(modelInfo.contextWindowTokens)) {
        base.maxContextTokens = Math.max(1, Math.floor(modelInfo.contextWindowTokens));
      }
      if (typeof modelInfo?.compactionTargetTokens === 'number' && Number.isFinite(modelInfo.compactionTargetTokens)) {
        base.targetContextTokens = Math.max(1, Math.floor(modelInfo.compactionTargetTokens));
      }

      const config = { ...base, ...configOverride };

      const usagePercent = ((metrics.totalTokens / config.maxContextTokens) * 100).toFixed(1);
      const thresholdPercent = ((config.targetContextTokens / config.maxContextTokens) * 100).toFixed(0);

      console.log(`[AgentSession][Context] iteration=${iteration} phase=${phase} provider=${provider} ` +
        `tokens=${metrics.totalTokens.toLocaleString()}/${config.maxContextTokens.toLocaleString()} (${usagePercent}%) ` +
        `threshold=${thresholdPercent}% ` +
        `items=${history.length} ` +
        `[user=${metrics.userMessageTokens.toLocaleString()} assistant=${metrics.assistantTokens.toLocaleString()} ` +
        `toolCalls=${metrics.toolCallTokens.toLocaleString()} toolResults=${metrics.toolResultTokens.toLocaleString()} ` +
        `reasoning=${metrics.reasoningTokens.toLocaleString()}]`);

      this.transport.emit('ai:agent:monitor', {
        type: 'context_metrics',
        provider,
        iteration,
        phase,
        metrics: {
          totalTokens: metrics.totalTokens,
          maxTokens: config.maxContextTokens,
          targetTokens: config.targetContextTokens,
          usagePercent: parseFloat(usagePercent),
          historyItems: history.length,
          breakdown: {
            user: metrics.userMessageTokens,
            assistant: metrics.assistantTokens,
            toolCalls: metrics.toolCallTokens,
            toolResults: metrics.toolResultTokens,
            reasoning: metrics.reasoningTokens,
          }
        }
      });
    } catch (error) {
      console.warn('[AgentSession][Context] Failed to log metrics', error);
    }
  }

  // ============================================================================
  // Context Compaction
  // ============================================================================

  private async maybeCompactHistory(
    history: OpenAIResponseItem[] | AnthropicConversationItem[],
    provider: Provider,
    opts?: RunOpts
  ): Promise<OpenAIResponseItem[] | AnthropicConversationItem[]> {
    // Check if compaction is disabled
    if (opts?.autoCompaction === false) {
      return history;
    }

    if (provider === 'openai') {
      return this.maybeCompactOpenAIHistory(history as OpenAIResponseItem[], opts);
    } else {
      return this.maybeCompactAnthropicHistory(history as AnthropicConversationItem[], opts);
    }
  }

  private async maybeCompactOpenAIHistory(
    history: OpenAIResponseItem[],
    opts?: RunOpts
  ): Promise<OpenAIResponseItem[]> {
    const base: CompactionConfig = {
      ...DEFAULT_OPENAI_COMPACTION_CONFIG,
    };

    const modelInfo = MODELS[this.model];
    if (typeof modelInfo?.contextWindowTokens === 'number' && Number.isFinite(modelInfo.contextWindowTokens)) {
      base.maxContextTokens = Math.max(1, Math.floor(modelInfo.contextWindowTokens));
    }
    if (typeof modelInfo?.compactionTargetTokens === 'number' && Number.isFinite(modelInfo.compactionTargetTokens)) {
      base.targetContextTokens = Math.max(1, Math.floor(modelInfo.compactionTargetTokens));
    }

    const config: CompactionConfig = {
      ...base,
      ...opts?.compactionConfig,
    };

    if (!needsOpenAICompaction(history, config)) {
      return history;
    }

    console.log('[AgentSession] OpenAI context compaction triggered');

    const fallbackSummarizer = createFallbackSummarizer();
    let summarizer = fallbackSummarizer;
    let usingFallback = true;
    try {
      summarizer = createOpenAISummarizer({
        client: this.client,
        model: config.summaryModel,
      });
      usingFallback = false;
    } catch (error) {
      console.warn('[AgentSession] Failed to create OpenAI summarizer, using fallback', error);
    }

    const attemptCompaction = async (activeSummarizer: typeof summarizer, isFallback: boolean) => {
      const result = await compactOpenAIHistory(history, config, activeSummarizer);
      if (result.compacted) {
        console.log(`[AgentSession] OpenAI compaction complete (${isFallback ? 'fallback' : 'primary'}): ` +
          `${result.turnsSummarized} turns summarized, ${result.originalTokens} -> ${result.newTokens} tokens`);

        this.transport.emit('ai:agent:monitor', {
          type: 'compaction',
          provider: 'openai',
          turnsSummarized: result.turnsSummarized,
          originalTokens: result.originalTokens,
          newTokens: result.newTokens,
        });
      }
      return result.compacted ? result.history : history;
    };

    try {
      return await attemptCompaction(summarizer, usingFallback);
    } catch (error) {
      console.error('[AgentSession] OpenAI compaction failed, retrying with fallback summarizer', error);
      if (!usingFallback) {
        try {
          return await attemptCompaction(fallbackSummarizer, true);
        } catch (fallbackError) {
          console.error('[AgentSession] OpenAI fallback compaction failed, continuing with original history', fallbackError);
        }
      }
      return history;
    }
  }

  /**
   * Compact Anthropic history if needed.
   */
  private async maybeCompactAnthropicHistory(
    history: AnthropicConversationItem[],
    opts?: RunOpts
  ): Promise<AnthropicConversationItem[]> {
    const base: CompactionConfig = {
      ...DEFAULT_ANTHROPIC_COMPACTION_CONFIG,
    };

    const modelInfo = MODELS[this.model];
    if (typeof modelInfo?.contextWindowTokens === 'number' && Number.isFinite(modelInfo.contextWindowTokens)) {
      base.maxContextTokens = Math.max(1, Math.floor(modelInfo.contextWindowTokens));
    }
    if (typeof modelInfo?.compactionTargetTokens === 'number' && Number.isFinite(modelInfo.compactionTargetTokens)) {
      base.targetContextTokens = Math.max(1, Math.floor(modelInfo.compactionTargetTokens));
    }

    const config: CompactionConfig = {
      ...base,
      ...opts?.compactionConfig,
    };

    if (!needsAnthropicCompaction(history, config)) {
      return history;
    }

    console.log('[AgentSession] Anthropic context compaction triggered');

    const fallbackSummarizer: AnthropicSummarizer = createFallbackSummarizer();
    let summarizer: AnthropicSummarizer = fallbackSummarizer;
    let usingFallback = true;
    try {
      summarizer = createAnthropicSummarizer({
        client: this.client,
        model: config.summaryModel,
      });
      usingFallback = false;
    } catch (error) {
      console.warn('[AgentSession] Failed to create Anthropic summarizer, using fallback', error);
    }

    const attemptCompaction = async (activeSummarizer: AnthropicSummarizer, isFallback: boolean) => {
      const result = await compactAnthropicHistory(history, config, activeSummarizer);
      if (result.compacted) {
        console.log(`[AgentSession] Anthropic compaction complete (${isFallback ? 'fallback' : 'primary'}): ` +
          `${result.turnsSummarized} turns summarized, ${result.originalTokens} -> ${result.newTokens} tokens`);

        this.transport.emit('ai:agent:monitor', {
          type: 'compaction',
          provider: 'anthropic',
          turnsSummarized: result.turnsSummarized,
          originalTokens: result.originalTokens,
          newTokens: result.newTokens,
        });
      }
      return result.compacted ? result.history : history;
    };

    try {
      return await attemptCompaction(summarizer, usingFallback);
    } catch (error) {
      console.error('[AgentSession] Anthropic compaction failed, retrying with fallback summarizer', error);
      if (!usingFallback) {
        try {
          return await attemptCompaction(fallbackSummarizer, true);
        } catch (fallbackError) {
          console.error('[AgentSession] Anthropic fallback compaction failed, continuing with original history', fallbackError);
        }
      }
      return history;
    }
  }

  // ============================================================================
  // Core Request Logic
  // ============================================================================

  private async makeRequest(
    history: OpenAIResponseItem[] | AnthropicConversationItem[],
    systemPrompt: string,
    provider: Provider,
    opts?: RunOpts
  ): Promise<{ toolCalled: boolean; history: OpenAIResponseItem[] | AnthropicConversationItem[] }> {
    if (provider === 'anthropic') {
      return this.makeAnthropicRequest(history as AnthropicConversationItem[], systemPrompt, opts);
    } else {
      return this.makeOpenAIRequest(history as OpenAIResponseItem[], systemPrompt, opts);
    }
  }

  private async makeOpenAIRequest(
    history: OpenAIResponseItem[],
    systemPrompt: string,
    opts?: RunOpts
  ): Promise<{ toolCalled: boolean; history: OpenAIResponseItem[] }> {
    let messages = history.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const { display_text, ...rest } = item as any;
      return rest as OpenAIResponseItem;
    });
    const staticPrompt = this.systemPromptStatic;
    const dynamicPrompt = this.systemPromptDynamic;

    if (staticPrompt && dynamicPrompt) {
      messages.unshift({ role: 'developer', content: dynamicPrompt } as OpenAIResponseItem);
      messages.unshift({ role: 'developer', content: staticPrompt } as OpenAIResponseItem);
    } else if (systemPrompt) {
      messages.unshift({
        role: 'developer',
        content: systemPrompt
      } as OpenAIResponseItem);
    }

    const requestParams: any = {
      model: this.model,
      input: messages,
      tools: this.toolsSchema,
      tool_choice: 'auto',
      parallel_tool_calls: true
    };

    if (supportsReasoning(this.model)) {
      requestParams.reasoning = {
        effort: opts?.reasoningEffort ?? 'high',
        summary: 'auto'
      };
      requestParams.include = ['reasoning.encrypted_content'];
    }

    let toolCalled = false;
    const newHistory: OpenAIResponseItem[] = [];

    toolCalled = await this.handleNonStreamingRequest(requestParams, newHistory);

    return { toolCalled, history: newHistory };
  }

  private buildAnthropicSystemPrompt(
    systemPrompt: string,
    useCacheControl: boolean
  ): Anthropic.MessageCreateParams['system'] {
    const staticPrompt = this.systemPromptStatic;
    const dynamicPrompt = this.systemPromptDynamic;

    if (staticPrompt && dynamicPrompt) {
      const staticBlock: AnthropicSystemBlock = { type: 'text', text: staticPrompt };
      if (useCacheControl) {
        staticBlock.cache_control = { type: 'ephemeral' };
      }
      const dynamicBlock: AnthropicSystemBlock = { type: 'text', text: dynamicPrompt };
      return [staticBlock, dynamicBlock] as Anthropic.MessageCreateParams['system'];
    }

    return systemPrompt;
  }

  private async makeAnthropicRequest(
    history: AnthropicConversationItem[],
    systemPrompt: string,
    opts?: RunOpts
  ): Promise<{ toolCalled: boolean; history: AnthropicConversationItem[] }> {
    const messages: Anthropic.MessageParam[] = history.filter(
      (item): item is Anthropic.MessageParam => 'role' in item && item.role !== undefined
    );

    const modelInfo = MODELS[this.model];
    const modelName = modelInfo?.apiName || modelInfo?.name || this.model;
    const effort = opts?.reasoningEffort ?? 'high';
    const thinkingBudget = supportsExtendedThinking(this.model)
      ? this.getThinkingBudget(effort)
      : 0;
    const outputAllowance = 4096;
    const safeMaxTokens = 32000;
    const maxTokens = Math.min(
      safeMaxTokens,
      Math.max(thinkingBudget + outputAllowance, 12000)
    );

    const allowCacheControl = anthropicCacheControlSupported !== false;
    const params: Anthropic.MessageCreateParams = {
      model: modelName,
      max_tokens: maxTokens,
      messages,
      system: this.buildAnthropicSystemPrompt(systemPrompt, allowCacheControl),
      tools: this.buildAnthropicTools(),
    };

    if (supportsExtendedThinking(this.model)) {
      const adjustedBudget = Math.min(thinkingBudget, Math.max(1024, maxTokens - 1024));
      params.thinking = {
        type: 'enabled',
        budget_tokens: adjustedBudget
      };
    }

    let response: Anthropic.Message;
    try {
      response = await retry(() => this.client.responses.create(params as any)) as any;
      if (allowCacheControl) {
        anthropicCacheControlSupported = anthropicCacheControlSupported ?? true;
      }
    } catch (error) {
      if (allowCacheControl && anthropicCacheControlSupported !== false && isAnthropicCacheControlError(error)) {
        anthropicCacheControlSupported = false;
        const fallbackParams: Anthropic.MessageCreateParams = {
          ...params,
          system: this.buildAnthropicSystemPrompt(systemPrompt, false),
        };
        try {
          response = await retry(() => this.client.responses.create(fallbackParams as any)) as any;
        } catch (fallbackError) {
          this.emitError('Failed to create Anthropic request', fallbackError);
          throw fallbackError;
        }
      } else {
        this.emitError('Failed to create Anthropic request', error);
        throw error;
      }
    }

    const { toolCalled, history: newHistory } = await this.processAnthropicResponse(response);

    return { toolCalled, history: newHistory };
  }

  private buildAnthropicTools(): Anthropic.Tool[] {
    return this.toolsSchema.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }

  private getThinkingBudget(effort: 'low' | 'medium' | 'high' | 'xhigh'): number {
    switch (effort) {
      case 'low': return 1024;
      case 'medium': return 8000;
      case 'high': return 16000;
      case 'xhigh': return 24000;
      default: return 8000;
    }
  }

  private async processAnthropicResponse(
    response: Anthropic.Message
  ): Promise<{ toolCalled: boolean; history: AnthropicConversationItem[] }> {
    const newHistory: AnthropicConversationItem[] = [];
    let toolCalled = false;

    const { blocks: sanitizedContent } = sanitizeAnthropicContentBlocks(response.content as Anthropic.ContentBlockParam[], '[empty assistant message]');

    const assistantMessage: Anthropic.MessageParam = {
      role: 'assistant',
      content: sanitizedContent
    };
    newHistory.push(assistantMessage);

    for (const block of sanitizedContent) {
      if (block.type === 'thinking') {
        this.transport.emit('ai:reasoning:summary_done', { text: block.thinking });
      } else if (block.type === 'text') {
        this.transport.emit('ai:chatStream:chunk', block.text);
      } else if (block.type === 'tool_use') {
        toolCalled = true;
        this.transport.emit('ai:tool:args', {
          id: block.id,
          name: block.name,
          delta: JSON.stringify(block.input)
        });

        await this.handleAnthropicToolCall(block, newHistory);
      }
    }

    return { toolCalled, history: newHistory };
  }

  private async handleAnthropicToolCall(
    toolUse: Anthropic.ToolUseBlock,
    history: AnthropicConversationItem[]
  ): Promise<void> {
    const toolName = toolUse.name;
    const callId = toolUse.id;
    const argsJson = JSON.stringify(toolUse.input);

    if (needsConfirmation(toolName, this.autoMode)) {
      const preview = buildPreview(toolName, toolUse.input);

      const confirmed = await this.transport.requestConfirmation({
        id: callId,
        name: toolName,
        arguments: argsJson,
        preview,
        sessionId: null,
        workingDir: this.workingDir,
        autoMode: this.autoMode
      }).catch(() => false);

      if (!confirmed) {
        const toolResult: AnthropicConversationItem = {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: callId,
            content: 'Error: action cancelled by user'
          }]
        };
        history.push(toolResult);
        return;
      }
    }

    const handler = this.toolHandlers[toolName];
    if (!handler) {
      const toolResult: AnthropicConversationItem = {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: `Error: No handler for ${toolName}`
        }]
      };
      history.push(toolResult);
      return;
    }

    const ac = new AbortController();
    this.abortControllers.set(callId, ac);

    try {
      const { result } = await executeToolCall(
        toolName,
        callId,
        argsJson,
        handler,
        this.transport,
        ac.signal
      );

      const toolResult: AnthropicConversationItem = {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: result
        }]
      };
      history.push(toolResult);
    } finally {
      this.abortControllers.delete(callId);
    }
  }

  private async handleNonStreamingRequest(params: any, history: OpenAIResponseItem[]): Promise<boolean> {
    let response: any;

    try {
      response = await retry(() => this.client.responses.create(params));
      // Poll for completion (for non-streaming models like gpt-5-pro)
      response = await waitForResponseCompletion(this.client, response, {
        isStopping: () => this.stopping
      });
    } catch (error) {
      this.emitError('Failed to create request', error);
      throw error;
    }

    if (!response?.output) {
      throw new Error('Empty response from model');
    }

    let toolCalled = false;
    const outputItems = Array.isArray(response.output) ? response.output : [];

    // Emit reasoning if present (via summary_done event, not as regular chunk)
    // Also add reasoning items to history first to maintain correct order
    for (const item of outputItems) {
      if (item.type === 'reasoning') {
        history.push(item);
        const summaries = Array.isArray(item.summary)
          ? item.summary.map((s: any) => s.text).filter(Boolean).join('\n')
          : '';

        if (summaries) {
          // Emit as reasoning event so it doesn't interfere with assistant message
          this.transport.emit('ai:reasoning:summary_done', { text: summaries });
        }
      }
    }

    let emittedMessageText = false;

    for (const rawItem of outputItems) {
      const item = rawItem;

      // Skip reasoning items - already added to history above
      if (item.type === 'reasoning') continue;

      history.push(item);

      if (item.type === 'function_call') {
        toolCalled = true;
        const argsJson = typeof item.arguments === 'string'
          ? item.arguments
          : safeStringify(item.arguments);

        this.transport.emit('ai:tool:args', {
          id: item.call_id,
          name: item.name,
          delta: argsJson
        });

        await this.handleToolCall(item, history);
      } else if (item.type === 'message') {
        const text = extractText(item);
        if (text) {
          this.transport.emit('ai:chatStream:chunk', text);
          emittedMessageText = true;
        }
      }
    }

    // Fallback: emit aggregate text if available AND we haven't already emitted message text
    // This prevents double-emission for Anthropic responses where both message.content
    // and output_text contain the same data
    if (response.output_text && !emittedMessageText) {
      this.transport.emit('ai:chatStream:chunk', response.output_text);
    }

    return toolCalled;
  }

  private async handleToolCall(item: OpenAIResponseItem, history: OpenAIResponseItem[]): Promise<void> {
    const toolName = item.name || '';
    const callId = item.call_id || '';
    const argsJson = typeof item.arguments === 'string'
      ? item.arguments
      : safeStringify(item.arguments);

    // Check if confirmation needed
    if (needsConfirmation(toolName, this.autoMode)) {
      const args = tryParseJson(argsJson) || {};
      const preview = buildPreview(toolName, args);

      const confirmed = await this.transport.requestConfirmation({
        id: callId,
        name: toolName,
        arguments: argsJson,
        preview,
        sessionId: null,
        workingDir: this.workingDir,
        autoMode: this.autoMode
      }).catch(() => false);

      if (!confirmed) {
        history.push({
          type: 'function_call_output',
          call_id: callId,
          output: 'Error: action cancelled by user'
        } as OpenAIResponseItem);
        return;
      }
    }

    // Execute tool
    const handler = this.toolHandlers[toolName];
    if (!handler) {
      history.push({
        type: 'function_call_output',
        call_id: callId,
        output: `Error: No handler for ${toolName}`
      } as OpenAIResponseItem);
      return;
    }

    const ac = new AbortController();
    this.abortControllers.set(callId, ac);

    try {
      const { result, data } = await executeToolCall(
        toolName,
        callId,
        argsJson,
        handler,
        this.transport,
        ac.signal
      );

      // Special handling for screenshot_preview/visit_url - convert to input_image format
      if ((toolName === 'screenshot_preview' || toolName === 'visit_url') && data?.data) {
        const mime = data.mime || 'image/png';
        const imageData = data.data;

        history.push({
          type: 'function_call_output',
          call_id: callId,
          output: [{
            type: 'input_image',
            image_url: `data:${mime};base64,${imageData}`,
            filename: data.filename
          }]
        } as OpenAIResponseItem);
      } else {
        history.push({
          type: 'function_call_output',
          call_id: callId,
          output: result
        } as OpenAIResponseItem);
      }
    } finally {
      this.abortControllers.delete(callId);
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  async run(params: {
    sessionId: string;
    newItems?: (OpenAIResponseItem | AnthropicConversationItem)[];
    title?: string;
  }, opts?: RunOpts): Promise<void> {
    this.stopping = false;

    try {

    } catch {}

    const systemPrompt = await this.ensureSystemPrompt(opts?.preamble);

    // Load or create session
    let session = await this.chatStore.get(this.workingDir, params.sessionId);
    if (!session) {
      this.emitError(`Session ${params.sessionId} not found`);
      return;
    }

    let provider = session.provider;
    const modelProvider = getModelProvider(this.model);
    if (provider !== modelProvider) {
      // Allow empty sessions to adopt the newly selected model provider
      const hasHistory = Array.isArray(session.history) && session.history.length > 0;
      if (!hasHistory) {
        const updated = await this.chatStore.setProvider(this.workingDir, params.sessionId, modelProvider);
        if (updated) {
          session = updated;
          provider = updated.provider;
        } else {
          this.emitError(`Failed to update session provider to ${modelProvider}`);
          return;
        }
      } else {
        this.emitError(`Session provider (${provider}) does not match selected model provider (${modelProvider}). Start a new session for a different provider.`);
        return;
      }
    }

    // Provider-aware normalization of incoming items
    let incomingItems = params.newItems as (OpenAIResponseItem | AnthropicConversationItem)[] | undefined;
    if (provider === 'anthropic' && incomingItems?.length) {
      const { history: normalizedNewItems } = normalizeHistoryForAnthropic(incomingItems);
      incomingItems = normalizedNewItems;
    }

    // Append new items if provided
    if (incomingItems?.length) {
      const updated = await this.chatStore.appendHistory(this.workingDir, params.sessionId, incomingItems);
      if (updated) session = updated;
    }

    // Update title if needed
    if (params.title?.trim() && session.title === 'New Chat') {
      await this.chatStore.rename(this.workingDir, params.sessionId, params.title);
      session = await this.chatStore.get(this.workingDir, params.sessionId) ?? session;
    }

    let history = session.history || [];
    let dirty = false;

    // Normalize stored history for Anthropic runs (converts OpenAI-shaped input_* parts)
    if (provider === 'anthropic') {
      const { history: normalizedHistory, changed } = normalizeHistoryForAnthropic(history as any[]);
      if (changed) {
        history = normalizedHistory;
        dirty = true;
      } else {
        history = normalizedHistory;
      }
    }

    // Log initial context metrics
    this.logContextMetrics(history, provider, -1, 'session-start', opts?.compactionConfig);

    // Check for compaction before starting the agent loop
    try {
      const compactedHistory = await this.maybeCompactHistory(history, provider, opts);
      if (compactedHistory !== history) {
        history = compactedHistory;
        dirty = true;
        // Persist compacted history immediately
        await this.chatStore.setHistory(this.workingDir, params.sessionId, history, { updateTimestamp: false });
        console.log('[AgentSession] Persisted compacted history');
        // Log metrics after compaction
        this.logContextMetrics(history, provider, -1, 'post-compaction', opts?.compactionConfig);
      }
    } catch (compactionError) {
      console.warn('[AgentSession] Pre-loop compaction failed, continuing with original history', compactionError);
    }

    try {
      // Main agent loop
      let loopIteration = 0;
      const COMPACTION_CHECK_INTERVAL = 5; // Check every N iterations
      
      while (!this.stopping) {
        // Log current context size before making request
        this.logContextMetrics(history, provider, loopIteration, 'pre-request', opts?.compactionConfig);

        const { toolCalled, history: newHistory } = await this.makeRequest(
          history,
          systemPrompt,
          provider,
          opts
        );

        if (newHistory.length > 0) {
          history = [...history as any[], ...newHistory as any[]];
          dirty = true;

          this.logContextMetrics(history, provider, loopIteration, 'post-request', opts?.compactionConfig);

          try {
            await this.chatStore.setHistory(this.workingDir, params.sessionId, history, { updateTimestamp: false });
          } catch (incPersistErr) {
            console.warn('[AgentSession] Incremental persist failed', incPersistErr);
          }
        }

        loopIteration++;

        // Periodic compaction check during long-running loops
        if (toolCalled && loopIteration % COMPACTION_CHECK_INTERVAL === 0) {
          try {
            const compactedHistory = await this.maybeCompactHistory(history, provider, opts);
            if (compactedHistory !== history) {
              history = compactedHistory;
              // Persist compacted history
              await this.chatStore.setHistory(this.workingDir, params.sessionId, history, { updateTimestamp: false });
              console.log('[AgentSession] Mid-loop compaction completed and persisted');
            }
          } catch (midLoopCompactionError) {
            console.warn('[AgentSession] Mid-loop compaction failed, continuing', midLoopCompactionError);
          }
        }

        if (!toolCalled) break;
      }
    } finally {
      try {
        if (dirty) {
          await this.chatStore.setHistory(this.workingDir, params.sessionId, history);
        } else {
          await this.chatStore.touch(this.workingDir, params.sessionId);
        }
      } catch (persistErr) {
        console.warn('[AgentSession] Failed to persist chat history in finally', persistErr);
      }
    }

    this.transport.emit('ai:chatStream:done');
  }
}
