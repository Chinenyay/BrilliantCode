// Tool adapter layer between the UI/LLM agent and low-level helpers. Every
// exported handler validates inputs, enforces sandbox boundaries, and returns
// a predictable JSON envelope so the renderer can show progress updates.

import { createFile, createDiff, grepSearch, generateImageFile, waitForDuration, brilliantSearch } from './functions.js';
import {
  addTodo,
  updateTodoContent,
  updateTodoStatus,
  clearTodos,
  listTodos,
} from './todoStore.js';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';

const WAIT_TOOL_CLAMP_MS = (() => {
  const fallback = 5 * 60 * 1000;
  const keys = ['AGENT_WAIT_TOOL_MAX_MS', 'AGENT_WAIT_MAX_MS', 'AGENT_WAIT_TOOL_CLAMP_MS'];
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

const WAIT_TOOL_DURATION_DESCRIPTION =
  WAIT_TOOL_CLAMP_MS > 0
    ? `Milliseconds to wait (values above ${WAIT_TOOL_CLAMP_MS} are clamped).`
    : 'Milliseconds to wait (no clamp is applied).';

type ToolContext = {
  workspaceRoot: string;
  additionalRoot: string | null;
  allowExternal: boolean;
};

type ScopedPath = { scope: 'workspace' | 'additional' | null; path: string };

function parseScopedPath(input: string): ScopedPath {
  const raw = String(input ?? '');
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

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function existsSyncSafe(p: string): boolean {
  try { return fsSync.existsSync(p); } catch { return false; }
}

function resolveToolPath(
  ctx: ToolContext,
  inputPath: string,
  intent: 'read' | 'write' | 'search'
): { ok: boolean; abs?: string; error?: string; chosenRoot?: 'workspace' | 'additional' | 'external' } {
  const normalizedCtx: ToolContext = {
    workspaceRoot: path.resolve(ctx?.workspaceRoot || process.cwd()),
    additionalRoot: ctx?.additionalRoot ? path.resolve(ctx.additionalRoot) : null,
    allowExternal: !!ctx?.allowExternal,
  };

  const parsed = parseScopedPath(inputPath);
  const raw = parsed.path;
  if (!raw) return { ok: false, error: 'path is required.' };

  const workspaceRoot = normalizedCtx.workspaceRoot;
  const additionalRoot = normalizedCtx.additionalRoot;

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (normalizedCtx.allowExternal) {
      return { ok: true, abs, chosenRoot: 'external' };
    }
    if (isInside(workspaceRoot, abs)) return { ok: true, abs, chosenRoot: 'workspace' };
    if (additionalRoot && isInside(additionalRoot, abs)) return { ok: true, abs, chosenRoot: 'additional' };
    return { ok: false, error: `Path escapes allowed directories: ${inputPath}` };
  }

  if (parsed.scope === 'workspace') {
    const abs = path.resolve(workspaceRoot, raw);
    return { ok: true, abs, chosenRoot: 'workspace' };
  }
  if (parsed.scope === 'additional') {
    if (!additionalRoot) return { ok: false, error: 'No additional working directory is set.' };
    const abs = path.resolve(additionalRoot, raw);
    return { ok: true, abs, chosenRoot: 'additional' };
  }

  const absW = path.resolve(workspaceRoot, raw);
  const absA = additionalRoot ? path.resolve(additionalRoot, raw) : null;

  const existsW = existsSyncSafe(absW);
  const existsA = absA ? existsSyncSafe(absA) : false;

  if (intent === 'read' || intent === 'search') {
    if (existsW && !existsA) return { ok: true, abs: absW, chosenRoot: 'workspace' };
    if (!existsW && existsA && absA) return { ok: true, abs: absA, chosenRoot: 'additional' };
    if (existsW && existsA) return { ok: true, abs: absW, chosenRoot: 'workspace' };
    return { ok: true, abs: absW, chosenRoot: 'workspace' };
  }

  if (existsW && !existsA) return { ok: true, abs: absW, chosenRoot: 'workspace' };
  if (!existsW && existsA && absA) return { ok: true, abs: absA, chosenRoot: 'additional' };
  if (existsW && existsA) return { ok: true, abs: absW, chosenRoot: 'workspace' };

  const parentW = path.dirname(absW);
  const parentA = absA ? path.dirname(absA) : null;
  const parentExistsW = existsSyncSafe(parentW);
  const parentExistsA = parentA ? existsSyncSafe(parentA) : false;

  if (!parentExistsW && parentExistsA && absA) return { ok: true, abs: absA, chosenRoot: 'additional' };
  return { ok: true, abs: absW, chosenRoot: 'workspace' };
}

const DEFAULT_TEXT_RESPONSE_LIMIT = 120_000;
const READ_FILE_RESPONSE_LIMIT = 120_000;
const GREP_STDOUT_LIMIT = 120_000;
const GREP_STDERR_LIMIT = 6_000;

type ClampResult = { text: string; clamped: boolean; omitted: number };

function clampToolText(raw: unknown, limit: number = DEFAULT_TEXT_RESPONSE_LIMIT): ClampResult {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (text.length <= limit) {
    return { text, clamped: false, omitted: 0 };
  }
  const omitted = text.length - limit;
  const suffix = `\n… (truncated ${omitted} character${omitted === 1 ? '' : 's'})`;
  return {
    text: text.slice(0, limit) + suffix,
    clamped: true,
    omitted,
  };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// -------------------- createFile --------------------
type CreateFileArgs = { filePath: string; content: string };
const makeCreateFileAdapter = (ctx: ToolContext) => async (args: CreateFileArgs) => {
  const { filePath, content } = args || ({} as CreateFileArgs);
  if (!filePath?.trim()) return { ok: false, error: 'filePath is required.' };
  const safe = resolveToolPath(ctx, filePath, 'write');
  if (!safe.ok) return { ok: false, error: safe.error };

  const result = await createFile(safe.abs as string, content ?? '', 'utf8');
  const preview = clampToolText(content ?? '', READ_FILE_RESPONSE_LIMIT);
  return {
    ok: !!result.succeeded,
    message: result.message,
    error: result.error,
    path: filePath,
    content: preview.text,
    truncated: preview.clamped,
    omittedChars: preview.omitted,
  };
};

// -------------------- createDiff --------------------
type CreateDiffArgs = { filePath: string; oldText: string; newText: string };
const makeCreateDiffAdapter = (ctx: ToolContext) => async (args: CreateDiffArgs) => {
  const { filePath, oldText, newText } = args || ({} as CreateDiffArgs);
  if (!filePath?.trim()) return { ok: false, madeChanges: false, error: 'filePath is required.' };
  if (oldText === undefined || oldText === null || oldText === '') {
    return { ok: false, madeChanges: false, error: 'oldText must be a non-empty string.' };
  }
  const safe = resolveToolPath(ctx, filePath, 'write');
  if (!safe.ok) return { ok: false, madeChanges: false, error: safe.error };
  const res = await createDiff(safe.abs as string, oldText, newText, 'utf8');
  const oldClamp = clampToolText(oldText, DEFAULT_TEXT_RESPONSE_LIMIT);
  const newClamp = clampToolText(newText, DEFAULT_TEXT_RESPONSE_LIMIT);
  return {
    ok: !!res.succeeded,
    madeChanges: !!res.madeChanges,
    message: res.message,
    error: res.error,
    path: filePath,
    truncated: oldClamp.clamped || newClamp.clamped,
    preview: {
      oldText: oldClamp.text,
      newText: newClamp.text,
      oldTextTruncated: oldClamp.clamped,
      newTextTruncated: newClamp.clamped,
      oldTextOmittedChars: oldClamp.omitted,
      newTextOmittedChars: newClamp.omitted,
    },
  };
};

// -------------------- readFile --------------------
type ReadFileArgs = { filePath: string };
const makeReadFileAdapter = (ctx: ToolContext) => async (args: ReadFileArgs) => {
  const { filePath } = args || ({} as ReadFileArgs);
  if (!filePath?.trim()) return { ok: false, error: 'filePath is required.' };
  const safe = resolveToolPath(ctx, filePath, 'read');
  if (!safe.ok) return { ok: false, error: safe.error };
  const enc: BufferEncoding = 'utf8';
  try {
    const rawContent = await fs.readFile(safe.abs as string, enc);
    const { text, clamped, omitted } = clampToolText(rawContent, READ_FILE_RESPONSE_LIMIT);
    return {
      ok: true,
      content: text,
      encoding: enc,
      path: filePath,
      truncated: clamped,
      omittedChars: omitted,
      originalLength: typeof rawContent === 'string' ? rawContent.length : 0,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), path: filePath };
  }
};

// -------------------- getFileSize --------------------
type GetFileSizeArgs = { filePath: string };
const makeGetFileSizeAdapter = (ctx: ToolContext) => async (args: GetFileSizeArgs) => {
  const { filePath } = args || ({} as GetFileSizeArgs);
  if (!filePath?.trim()) return { ok: false, error: 'filePath is required.' };
  const safe = resolveToolPath(ctx, filePath, 'read');
  if (!safe.ok) return { ok: false, error: safe.error };
  const enc: BufferEncoding = 'utf8';
  try {
    const content = await fs.readFile(safe.abs as string, enc);
    const text = content.toString();
    const normalized = text.replace(/\r\n/g, '\n');
    let lineCount = 0;
    if (normalized.length) {
      const segments = normalized.split('\n');
      lineCount = normalized.endsWith('\n') ? segments.length - 1 : segments.length;
      if (segments.length === 1 && segments[0] === '') lineCount = 0;
    }
    const wordMatches = text.match(/\S+/g);
    const wordCount = wordMatches ? wordMatches.length : 0;
    return { ok: true, path: filePath, lineCount, wordCount, encoding: enc };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), path: filePath };
  }
};

// -------------------- grepSearch --------------------
type GrepSearchArgs = {
  pattern: string;
  files: string;
  caseInsensitive?: boolean;
  recursive?: boolean;
  lineNumbers?: boolean;
  timeout?: number;
  matchCase?: 'smart' | 'insensitive' | 'sensitive';
  literal?: boolean;
  noMessages?: boolean;
};

function looksAbsoluteOrRooted(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

const makeGrepSearchAdapter = (ctx: ToolContext) => async (args: GrepSearchArgs & { _abortSignal?: AbortSignal }) => {
  const {
    pattern,
    files,
    caseInsensitive = true,
    recursive = false,
    lineNumbers = false,
    timeout,
    matchCase,
    literal = false,
    noMessages = false,
  } = args || ({} as GrepSearchArgs);

  if (!pattern?.trim()) return { ok: false, error: 'pattern is required.' };
  if (!files?.trim()) return { ok: false, error: 'files is required.' };

  const parsed = parseScopedPath(files);
  const filesPath = parsed.path;
  if (looksAbsoluteOrRooted(filesPath)) return { ok: false, error: 'Absolute paths are not allowed for files.' };

  const workspaceRoot = path.resolve(ctx.workspaceRoot || process.cwd());
  const additionalRoot = ctx.additionalRoot ? path.resolve(ctx.additionalRoot) : null;

  const targets: Array<{ label: 'workspace' | 'additional'; cwd: string }> = [];
  if (parsed.scope === 'workspace') {
    targets.push({ label: 'workspace', cwd: workspaceRoot });
  } else if (parsed.scope === 'additional') {
    if (!additionalRoot) return { ok: false, error: 'No additional working directory is set.' };
    targets.push({ label: 'additional', cwd: additionalRoot });
  } else {
    targets.push({ label: 'workspace', cwd: workspaceRoot });
    if (additionalRoot) targets.push({ label: 'additional', cwd: additionalRoot });
  }

  const runs = await Promise.all(targets.map(async (t) => {
    const res = await grepSearch(
      pattern,
      filesPath,
      caseInsensitive,
      recursive,
      lineNumbers,
      timeout,
      matchCase,
      literal,
      noMessages,
      t.cwd,
      args?._abortSignal,
    );
    return { target: t, res };
  }));

  const sections: string[] = [];
  const errSections: string[] = [];

  let anyMatch = false;
  let anyTimedOut = false;
  let anyTruncated = false;
  let hardError: string | undefined;

  for (const run of runs) {
    const { res, target } = run;
    const baseName = path.basename(target.cwd || '') || target.label;
    const workspaceName = path.basename(workspaceRoot) || 'workspace';
    const additionalName = additionalRoot ? (path.basename(additionalRoot) || 'additional') : '';
    const needsSuffix = additionalRoot && workspaceName && additionalName && workspaceName === additionalName;
    const suffix = needsSuffix ? ` (${target.label})` : '';
    const labelHeader = `--- ${baseName}${suffix} ---`;

    const stdoutText = String(res.stdout ?? '').trimEnd();
    const stderrText = String(res.stderr ?? '').trimEnd();

    if (res.returncode === 0) {
      anyMatch = true;
    } else if (res.returncode !== 1 || (stderrText && stderrText.trim())) {
      hardError = hardError || (stderrText || `grep search failed with code ${res.returncode}.`);
    }

    if (res.timedOut) anyTimedOut = true;
    if (res.truncated) anyTruncated = true;

    if (stdoutText) {
      sections.push(labelHeader);
      sections.push(stdoutText);
    }
    if (stderrText) {
      errSections.push(labelHeader);
      errSections.push(stderrText);
    }
  }

  const combinedStdout = sections.join('\n') + (sections.length ? '\n' : '');
  const combinedStderr = errSections.join('\n') + (errSections.length ? '\n' : '');

  const stdoutClamp = clampToolText(combinedStdout, GREP_STDOUT_LIMIT);
  const stderrClamp = clampToolText(combinedStderr, GREP_STDERR_LIMIT);

  let error: string | undefined;
  if (anyTruncated || stdoutClamp.clamped || stderrClamp.clamped) {
    error = 'Search output exceeded the allowed size and was truncated. Narrow the scope or refine the pattern.';
  } else if (anyTimedOut) {
    error = 'Search timed out before completing.';
  } else if (hardError) {
    error = hardError;
  } else if (!anyMatch) {
    error = 'No matches found.';
  }

  const ok = anyMatch && !error;

  return {
    ok,
    error,
    stdout: stdoutClamp.text,
    stderr: stderrClamp.text,
    returncode: anyMatch ? 0 : 1,
    timedOut: anyTimedOut,
    truncated: anyTruncated || stdoutClamp.clamped || stderrClamp.clamped,
    stdoutTruncated: stdoutClamp.clamped,
    stderrTruncated: stderrClamp.clamped,
    stdoutOmittedChars: stdoutClamp.omitted,
    stderrOmittedChars: stderrClamp.omitted,
    baseDir: workspaceRoot,
    bases: targets,
  };
};

// -------------------- generateImage --------------------
type ImageSizeOption = 'auto' | '256x256' | '512x512' | '1024x1024' | '1536x1024' | '1024x1536' | '1792x1024' | '1024x1792';
type GenerateImageArgs = { prompt: string; outputPath: string; size?: string; quality?: string };
const makeGenerateImageAdapter = (ctx: ToolContext) => async (args: GenerateImageArgs) => {
  const prompt = String(args?.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required.' };

  const rawPath = String(args?.outputPath ?? '').trim();
  if (!rawPath) return { ok: false, error: 'outputPath is required.' };

  const safe = resolveToolPath(ctx, rawPath, 'write');
  if (!safe.ok || !safe.abs) return { ok: false, error: safe.error };

  const allowedSizes = new Set<ImageSizeOption>([
    'auto',
    '256x256',
    '512x512',
    '1024x1024',
    '1536x1024',
    '1024x1536',
    '1792x1024',
    '1024x1792',
  ]);
  const sizeRaw = typeof args?.size === 'string' ? args.size.trim().toLowerCase() : '';
  const size = sizeRaw && allowedSizes.has(sizeRaw as ImageSizeOption) ? (sizeRaw as ImageSizeOption) : undefined;

  const qualityRaw = typeof args?.quality === 'string' ? args.quality.trim().toLowerCase() : '';
  const quality = qualityRaw === 'standard' || qualityRaw === 'high' ? (qualityRaw as 'standard' | 'high') : undefined;

  const res = await generateImageFile(prompt, safe.abs as string, {
    size,
    quality,
  });

  return {
    ok: !!res.succeeded,
    error: res.error,
    path: res.path,
    message: res.message,
    base64: res.base64,
    mime: res.mime,
  };
};

// -------------------- BrilliantAI search --------------------
type BrilliantAiSearchArgs = { query: string; start?: number };

async function brilliantAiSearchAdapter(args: BrilliantAiSearchArgs) {
  const query = String(args?.query ?? '').trim();
  if (!query) return { ok: false, error: 'query is required.' };

  const start = typeof args?.start === 'number' && Number.isFinite(args.start)
    ? Math.max(1, Math.floor(args.start))
    : 1;

  const result = await brilliantSearch(query, { start });

  if (!result.succeeded) {
    return {
      ok: false,
      error: result.error || 'Search failed.',
      query,
      start,
    };
  }

  const summarySource = result.results ?? result.raw ?? {};
  const { text, clamped, omitted } = clampToolText(
    JSON.stringify(summarySource, null, 2),
    DEFAULT_TEXT_RESPONSE_LIMIT,
  );

  return {
    ok: true,
    query,
    start,
    summary: text,
    truncated: clamped,
    omittedChars: omitted,
    results: result.results ?? null,
    raw: result.raw ?? null,
  };
}

// -------------------- todo tools --------------------
type AddTodoArgs = { content: string };
const makeAddTodoAdapter = (sessionId: string | null | undefined) => async (args: AddTodoArgs) => {
  const content = (args?.content ?? '') as string;
  return addTodo(sessionId, content);
};

type UpdateTodoItemArgs = { index: number; content: string };
const makeUpdateTodoItemAdapter = (sessionId: string | null | undefined) => async (args: UpdateTodoItemArgs) => {
  const index = args?.index as number;
  const content = (args?.content ?? '') as string;
  return updateTodoContent(sessionId, index, content);
};

type UpdateTodoStatusArgs = { index: number; status: string };
const makeUpdateTodoStatusAdapter = (sessionId: string | null | undefined) => async (args: UpdateTodoStatusArgs) => {
  const index = args?.index as number;
  const status = (args?.status ?? '') as string;
  return updateTodoStatus(sessionId, index, status);
};

const makeClearTodosAdapter = (sessionId: string | null | undefined) => async () => {
  return clearTodos(sessionId);
};

const makeListTodosAdapter = (sessionId: string | null | undefined) => async () => {
  return listTodos(sessionId);
};

// -------------------- wait tool --------------------
type WaitToolArgs = { durationMs: number };
async function waitToolAdapter(args: WaitToolArgs) {
  const parsed = Number(args?.durationMs);
  const result = await waitForDuration(parsed);
  const requestedMs = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  return {
    ok: !!result.succeeded,
    message: result.message,
    error: result.error,
    requestedMs,
    waitedMs: result.waitedMs,
    clampedMs: result.clampedMs,
  };
}

// -------------------- Tool registry and schema --------------------
type ToolHandler = (args: any) => Promise<any>;

type CreateToolHandlersOptions = Partial<ToolContext> & { sessionId?: string | null };

function createToolHandlers(opts: CreateToolHandlersOptions = {}): Record<string, ToolHandler> {
  const ctx: ToolContext = {
    workspaceRoot: String(opts.workspaceRoot ?? process.cwd()),
    additionalRoot: opts.additionalRoot ? String(opts.additionalRoot) : null,
    allowExternal: !!opts.allowExternal,
  };

  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : undefined;

  return {
    create_file: makeCreateFileAdapter(ctx),
    create_diff: makeCreateDiffAdapter(ctx),
    read_file: makeReadFileAdapter(ctx),
    get_file_size: makeGetFileSizeAdapter(ctx),
    grep_search: makeGrepSearchAdapter(ctx),
    google_search: brilliantAiSearchAdapter,
    generate_image_tool: makeGenerateImageAdapter(ctx),

    add_todo_tool: makeAddTodoAdapter(sessionId),
    update_todo_item_tool: makeUpdateTodoItemAdapter(sessionId),
    update_todo_status_tool: makeUpdateTodoStatusAdapter(sessionId),
    clear_todos_tool: makeClearTodosAdapter(sessionId),
    list_todos_tool: makeListTodosAdapter(sessionId),

    wait_tool: waitToolAdapter,
  };
}

const toolHandlers: Record<string, ToolHandler> = createToolHandlers();

const toolsSchemaOAI = [
  {
    type: 'function',
    name: 'create_file',
    description: 'Create a file and write content to it (inside app base directory).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: 'Relative path under the app base directory.' },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    type: 'function',
    name: 'create_diff',
    description: 'Replace all occurrences of oldText with newText in a file (inside app base directory).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: "Relative path under the app base directory." },
        oldText: { type: 'string', description: 'Text to be replaced.' },
        newText: { type: 'string', description: 'Replacement text.' },
      },
      required: ['filePath', 'oldText', 'newText'],
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a text file inside the app base directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: 'Relative path under the app base directory.' },
      },
      required: ['filePath'],
    },
  },
  {
    type: 'function',
    name: 'get_file_size',
    description: 'Count total words and lines for a file inside the app base directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string' },
      },
      required: ['filePath'],
    },
  },
  {
    type: 'function',
    name: 'grep_search',
    description: 'Search for a pattern within files under the app base directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string' },
        files: { type: 'string', description: 'Relative glob or directory. Absolute paths not allowed.' },
        caseInsensitive: { type: 'boolean', default: true, description: 'Whether the search is case insensitive.' },
        recursive: { type: 'boolean', default: true, description: 'Whether to search recursively.' },
        lineNumbers: { type: 'boolean', default: true, description: 'Whether to include line numbers in the output.' },
        timeout: { type: 'number', description: 'Timeout for the search in milliseconds.' },
        matchCase: { type: 'string', enum: ['smart', 'insensitive', 'sensitive'], description: 'Case matching strategy.' },
        literal: { type: 'boolean', default: false, description: 'Whether to treat the pattern as a literal string.' },
        noMessages: { type: 'boolean', default: false, description: 'Whether to suppress all output messages.' },
      },
      required: ['pattern', 'files', 'caseInsensitive', 'recursive', 'lineNumbers', 'literal', 'noMessages'],
    },
  },
  {
    type: 'function',
    name: 'google_search',
    description: 'Perform a web search via Google Custom Search through the BrilliantAI backend and return structured results.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        start: {
          type: 'integer',
          minimum: 1,
          description: 'Start index of search results (Google CSE semantics).',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'generate_image_tool',
    description: 'Generates an image based on a text prompt and saves it to a file inside the app base directory. Use this tool always when creating images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Text description for the image.' },
        outputPath: { type: 'string', description: 'Relative path under the workspace where the image will be written.' },
        size: {
          type: 'string',
          enum: ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
          description: 'Optional image size (defaults to provider preset).',
        },
        quality: { type: 'string', enum: ['standard', 'high'], description: 'Optional render quality (default high).' },
      },
      required: ['prompt', 'outputPath', 'size', 'quality'],
    },
  },
  {
    type: 'function',
    name: 'add_todo_tool',
    description: 'Add a todo item with status "todo" to the shared task list.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'Todo text to add.' },
      },
      required: ['content'],
    },
  },
  {
    type: 'function',
    name: 'update_todo_item_tool',
    description: 'Update the text/content of an existing todo item by index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'integer', minimum: 1, description: 'Todo index to update.' },
        content: { type: 'string', description: 'New todo content.' },
      },
      required: ['index', 'content'],
    },
  },
  {
    type: 'function',
    name: 'update_todo_status_tool',
    description: 'Update the status of a todo item (todo, in_progress, done).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'integer', minimum: 1, description: 'Todo index to update.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'], description: 'New status.' },
      },
      required: ['index', 'status'],
    },
  },
  {
    type: 'function',
    name: 'clear_todos_tool',
    description: 'Clear all todo items from the shared task list.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_todos_tool',
    description: 'Return the current todo collection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'wait_tool',
    description: 'Block for the requested number of milliseconds before returning.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationMs: {
          type: 'integer',
          minimum: 1,
          description: WAIT_TOOL_DURATION_DESCRIPTION,
        },
      },
      required: ['durationMs'],
    },
  },
];


export {
  createToolHandlers,
  toolHandlers,
  toolsSchemaOAI,
  toolsSchemaOAI as toolsSchema,
};
