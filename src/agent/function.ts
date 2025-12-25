import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import { access as fsAccess } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { AzureOpenAI, OpenAI } from 'openai';
import * as authService from '../services/auth-service.js';
type SpawnOptions = import('child_process').SpawnOptions;

// Low-level helpers invoked by tool adapters. These keep the logic focused on
// filesystem and process safety so the AgentSession can trust the returned
// envelopes regardless of the provider that called the tool.

function parseDurationMsEnv(keys: string[], fallback: number, allowZero = true): number {
    for (const key of keys) {
        if (!key) continue;
        const raw = process.env[key];
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) continue;
        if (parsed <= 0) {
            return allowZero ? 0 : fallback;
        }
        return Math.floor(parsed);
    }
    return fallback;
}

function parseDurationSecondsEnv(keys: string[], fallback: number, allowZero = true): number {
    const ms = parseDurationMsEnv(keys, fallback * 1000, allowZero);
    if (ms <= 0) return ms === 0 ? 0 : fallback;
    return Math.floor(ms / 1000);
}

export interface TaskResult {
    succeeded: boolean;
    message?: string;
    error?: string;
}

// create_file function
/**
 * Creates a new file and writes content to it if provided.
 *
 * Params:
@param filePath: Path to write file to.
@param content: Content to write to the file.
@param encoding: File encoding, default is utf-8.
 *
 * Returns:
 *  TaskResult containing succeeded, optional message, and optional error.
 */
async function createFile(
    filePath: string, 
    content: string, 
    encoding: BufferEncoding = "utf-8"): Promise<TaskResult> {
    try {
        if (!filePath?.trim()) {
            return { succeeded: false, error: "filePath is required." };
        }
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content ?? "", { encoding, flag: "wx" });
        
        return { succeeded: true, message: `File created successfully at ${filePath}` };

    } catch (err: any) {
        if (err?.code === "EEXIST") {
            return { succeeded: false, error: `File already exists at ${filePath}` };
        }
        return {
            succeeded: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Edit a file by replacing all exact matches of oldText with newText.
 * Mirrors the Python example semantics and return shape, adapted to TS.
 *
 * Params:
 * @param filePath: Path to the file to edit
 * @param oldText: Exact text to search for
 * @param newText: Replacement text
 * @param encoding: File encoding (default: 'utf-8')
 *
 * Returns:
 *  TaskResult plus madeChanges boolean indicating whether edits were made.
 */
async function createDiff(
    filePath: string,
    oldText: string,
    newText: string,
    encoding: BufferEncoding = "utf-8"
): Promise<TaskResult & { madeChanges: boolean }> {
    try {
        if (!filePath?.trim()) {
            return { succeeded: false, error: "filePath is required.", madeChanges: false };
        }
        if (oldText === undefined || oldText === null || oldText === "") {
            return { succeeded: false, error: "oldText must be a non-empty string.", madeChanges: false };
        }

        const content = await fs.readFile(filePath, { encoding });

        if (!content.includes(oldText)) {
            return {
                succeeded: false,
                message: undefined,
                error: `Search text not found in ${filePath}`,
                madeChanges: false,
            };
        }

        const frequency = content.split(oldText).length - 1;
        const newContent = content.replaceAll(oldText, newText);

        await fs.writeFile(filePath, newContent, { encoding });

        return {
            succeeded: true,
            message: `Successfully applied diff to ${filePath}. Replaced ${frequency} occurrence(s) of old text.`,
            error: undefined,
            madeChanges: true,
        };
    } catch (err: any) {
        if (err?.code === "ENOENT") {
            return {
                succeeded: false,
                message: undefined,
                error: `File not found: ${filePath}`,
                madeChanges: false,
            };
        }
        return {
            succeeded: false,
            message: undefined,
            error: `Failed to create diff for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
            madeChanges: false,
        };
    }
}

const WAIT_DURATION_LIMIT_MS = parseDurationMsEnv(
    ['AGENT_WAIT_TOOL_MAX_MS', 'AGENT_WAIT_MAX_MS', 'AGENT_WAIT_TOOL_CLAMP_MS'],
    5 * 60 * 1000,
);

async function waitForDuration(durationMs: number): Promise<TaskResult & { waitedMs?: number; clampedMs?: number }> {
    const raw = Number(durationMs);
    if (!Number.isFinite(raw)) {
        return { succeeded: false, error: "durationMs must be a finite number." };
    }
    const ms = Math.floor(raw);
    if (ms <= 0) {
        return { succeeded: false, error: "durationMs must be greater than zero." };
    }

    const waitLimit = WAIT_DURATION_LIMIT_MS > 0 ? WAIT_DURATION_LIMIT_MS : null;
    const capped = waitLimit ? Math.min(ms, waitLimit) : ms;
    await new Promise<void>((resolve) => {
        setTimeout(resolve, capped);
    });

    const messageParts = [`Waited ${capped}ms.`];
    if (waitLimit && capped < ms) {
        messageParts.push(`Clamped from ${ms}ms.`);
    }

    return {
        succeeded: true,
        message: messageParts.join(" "),
        waitedMs: capped,
        clampedMs: waitLimit && capped < ms ? waitLimit : undefined,
    };
}
const BRILLIANT_AI_HEADER = 'BrilliantCode';

function getFirstEnv(...keys: (string | undefined)[]): string {
    for (const key of keys) {
        if (!key) continue;
        const raw = process.env[key];
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (trimmed) return trimmed;
    }
    return '';
}

function resolveBrilliantBaseUrl(): string {
    const raw = getFirstEnv('BRILLIANT_AI_IMAGE_ENDPOINT', 'BRILLIANT_AI_ENDPOINT');
    if (!raw) return '';
    const trimmed = raw.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function extractStatusCode(error: any): number | undefined {
    return error?.status ?? error?.statusCode ?? error?.response?.status;
}

async function runWithBrilliantImageClient<T>(
    invoke: (client: OpenAI) => Promise<T> | T,
    retries = 1
): Promise<T> {
    const baseURL = resolveBrilliantBaseUrl();
    if (!baseURL) {
        throw new Error('BRILLIANT_AI_ENDPOINT is not configured.');
    }

    const token = await authService.ensureValidAccessToken();
    const origin = getFirstEnv('BRILLIANT_AI_ORIGIN') || 'https://brilliantai.co';
    const client = new OpenAI({
        apiKey: token,
        baseURL,
        defaultHeaders: {
            'X-Client-App': BRILLIANT_AI_HEADER,
            ...(origin ? { Origin: origin } : {}),
        },
    });

    try {
        return await Promise.resolve(invoke(client));
    } catch (error: any) {
        const status = extractStatusCode(error);
        if (status === 401 && retries > 0) {
            await authService.refreshTokens();
            return runWithBrilliantImageClient(invoke, retries - 1);
        }
        throw error;
    }
}

let cachedAzureImageClient: AzureOpenAI | null = null;

function getAzureImageClient(): AzureOpenAI | null {
    if (cachedAzureImageClient) return cachedAzureImageClient;

    const endpoint = getFirstEnv(
        'AZURE_OPENAI_IMAGES_ENDPOINT',
        'AZURE_OPENAI_IMAGE_ENDPOINT',
        'AZURE_OPENAI_ENDPOINT',
    );
    const apiKey = getFirstEnv(
        'AZURE_OPENAI_IMAGES_API_KEY',
        'AZURE_OPENAI_IMAGE_API_KEY',
        'AZURE_OPENAI_API_KEY',
    );
    const apiVersion = getFirstEnv(
        'AZURE_OPENAI_IMAGE_API_VERSION',
        'AZURE_OPENAI_API_VERSION',
    ) || '2025-04-01-preview';

    if (!endpoint || !apiKey) {
        return null;
    }

    cachedAzureImageClient = new AzureOpenAI({
        endpoint,
        apiKey,
        apiVersion,
    });

    return cachedAzureImageClient;
}

type ImageQualityOption = 'standard' | 'high';
type ImageSizeOption = 'auto' | '256x256' | '512x512' | '1024x1024' | '1536x1024' | '1024x1536' | '1792x1024' | '1024x1792';

type GenerateImageOptions = {
    size?: ImageSizeOption;
    quality?: ImageQualityOption;
};

function detectImageMime(buffer: Buffer, filePath?: string): string {
    if (buffer.length >= 12) {
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
        const riff = buffer.toString('ascii', 0, 4);
        const webp = buffer.toString('ascii', 8, 12);
        if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
        if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
    }
    const ext = (filePath ? path.extname(filePath) : '').toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.bmp': return 'image/bmp';
        case '.svg': return 'image/svg+xml';
        default: return 'image/png';
    }
}

async function generateImageFile(
    prompt: string,
    absolutePath: string,
    options: GenerateImageOptions = {}
): Promise<TaskResult & { path?: string; base64?: string; mime?: string }> {
    try {
        const trimmedPrompt = (prompt ?? '').trim();
        if (!trimmedPrompt) {
            return { succeeded: false, error: 'prompt is required.' };
        }

        const targetPath = path.resolve(absolutePath ?? '');
        if (!targetPath) {
            return { succeeded: false, error: 'absolutePath is required.' };
        }

        const dir = path.dirname(targetPath);
        await fs.mkdir(dir, { recursive: true });

        const brilliantBase = resolveBrilliantBaseUrl();
        let result:
            | Awaited<ReturnType<OpenAI['images']['generate']>>
            | Awaited<ReturnType<AzureOpenAI['images']['generate']>>;

        if (brilliantBase) {
            const model =
                getFirstEnv('BRILLIANT_AI_IMAGE_MODEL', 'BRILLIANT_AI_IMAGE_DEPLOYMENT', 'BRILLIANT_AI_IMAGE_NAME')
                || 'gpt-image-1.5';

            result = await runWithBrilliantImageClient((client) =>
                client.images.generate({
                    model,
                    prompt: trimmedPrompt,
                    ...(options.size ? { size: options.size } : {}),
                    ...(options.quality ? { quality: options.quality } : {}),
                    response_format: 'b64_json',
                }),
            );
        } else {
            const azureClient = getAzureImageClient();
            if (!azureClient) {
                return {
                    succeeded: false,
                    error: 'Image endpoint/key not configured. Set BRILLIANT_AI_* or AZURE_OPENAI_* image credentials.',
                };
            }

            const model =
                getFirstEnv('AZURE_OPENAI_IMAGE_DEPLOYMENT', 'AZURE_OPENAI_IMAGE_MODEL', 'AZURE_OPENAI_IMAGE_NAME')
                || 'gpt-image-1.5';

            result = await azureClient.images.generate({
                model,
                prompt: trimmedPrompt,
                ...(options.size ? { size: options.size } : {}),
                ...(options.quality ? { quality: options.quality } : {}),
                response_format: 'b64_json',
            });
        }

        const data = result?.data?.[0];
        const base64 = data?.b64_json;
        if (!base64) {
            return { succeeded: false, error: 'Image generation response missing base64 payload.' };
        }

        const buffer = Buffer.from(base64, 'base64');
        const mime = detectImageMime(buffer, targetPath);
        await fs.writeFile(targetPath, buffer);

        return {
            succeeded: true,
            message: `Image saved to ${targetPath}`,
            path: targetPath,
            base64,
            mime,
        };
    } catch (err: any) {
        return {
            succeeded: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

type BrilliantSearchOptions = { start?: number };

async function brilliantSearch(
    query: string,
    options: BrilliantSearchOptions = {},
): Promise<TaskResult & { query?: string; start?: number; results?: any; raw?: any }> {
    const trimmed = (query ?? '').trim();
    if (!trimmed) {
        return { succeeded: false, error: 'query is required.' };
    }

    const baseURL = resolveBrilliantBaseUrl();
    if (!baseURL) {
        return { succeeded: false, error: 'BRILLIANT_AI_ENDPOINT is not configured.' };
    }

    const start = Number.isFinite(options.start as number)
        ? Math.max(1, Math.floor(options.start as number))
        : 1;

    const origin = getFirstEnv('BRILLIANT_AI_ORIGIN') || 'https://brilliantai.co';

    let lastError: any = null;
    let token: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (!token || attempt > 0) {
                token = await authService.ensureValidAccessToken();
            }

            const url = `${baseURL.replace(/\/+$/, '')}/search?` +
                new URLSearchParams({ query: trimmed, start: String(start) }).toString();

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Client-App': BRILLIANT_AI_HEADER,
                    ...(origin ? { Origin: origin } : {}),
                },
            });

            if (response.status === 401 && attempt === 0) {
                await authService.refreshTokens();
                continue;
            }

            if (!response.ok) {
                const bodyText = await response.text().catch(() => '');
                const snippet = bodyText ? `: ${bodyText.slice(0, 300)}` : '';
                return {
                    succeeded: false,
                    error: `Search request failed with status ${response.status}${snippet}`,
                };
            }

            const json = await response.json().catch(() => null);
            if (!json || typeof json !== 'object') {
                return { succeeded: false, error: 'Invalid search response payload.' };
            }

            return {
                succeeded: true,
                message: 'Search completed.',
                query: trimmed,
                start,
                results: (json as any).results ?? null,
                raw: json,
            };
        } catch (err) {
            lastError = err;
            if (attempt === 0) {
                await authService.refreshTokens().catch(() => {});
                continue;
            }
        }
    }

    return {
        succeeded: false,
        error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Search failed.'),
    };
}

function shellEscape(arg: string): string {
    if (/^[A-Za-z0-9_\/:\.\-\+=@%]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, `'\''`)}'`;
}

function shlexJoin(args: string[]): string {
    return args.map(shellEscape).join(" ");
}

const DEFAULT_GREP_TIMEOUT_SECONDS = parseDurationSecondsEnv(
    ['AGENT_GREP_DEFAULT_TIMEOUT_SECONDS', 'AGENT_GREP_TIMEOUT_SECONDS', 'AGENT_GREP_TIMEOUT_SEC'],
    120,
);

/**
 * Search for and within files using ripgrep (POSIX) or findstr (Windows)
 * @param pattern 
 * @param files 
 * @param caseInsensitive 
 * @param recursive 
 * @param lineNumbers 
 * @param timeout
 * @param matchCase
 * @param literal
 * @param noMessages 
 */
async function grepSearch(
    pattern: string, 
    files: string, 
    caseInsensitive: boolean = true, 
    recursive: boolean = false, 
    lineNumbers: boolean = false, 
    timeout: number = DEFAULT_GREP_TIMEOUT_SECONDS,
    matchCase?: 'smart' | 'insensitive' | 'sensitive',
    literal: boolean = false,
    noMessages: boolean = false,
    cwd?: string,
    abortSignal?: AbortSignal,
) {
    const caseMode: 'smart' | 'insensitive' | 'sensitive' = matchCase ?? (caseInsensitive ? 'insensitive' : 'sensitive');
    const smartInsensitive = caseMode === 'insensitive' || (caseMode === 'smart' && !/[A-Z]/.test(pattern));

    // helper: detect any global characters
    function hasGlobChars(s: string): boolean {
        return /[*?\[]/.test(s);
    };

    // helper: split a pattern into a real directory root and a relative glob
    // we take the longest leading path without any global metacharacters as the root.
    function splitGlobRoot(pattern: string): { root: string; relGlob: string} {
        if (!pattern) {
            return { root: ".", relGlob: ""};
        }

        const parts = pattern.split(path.sep);
        const rootParts: string[] = [];

        for (const part of parts) {
            if (hasGlobChars(part)) break;
            rootParts.push(part);
        }

        const root = rootParts.length === 0 ? "." : rootParts.join(path.sep);

        // Compute relative glob (don't use path.relative; just strip prefix if present)
        let rel = pattern;
        if (root !== ".") {
            const prefix = root + path.sep;
            if (pattern.startsWith(prefix)) {
                rel = pattern.slice(prefix.length);
            }
        }
        return { root, relGlob: rel };
    };

    const resolveForCheck = (p: string): string => {
        const candidate = String(p ?? '');
        if (!candidate) return candidate;
        if (cwd && !path.isAbsolute(candidate)) return path.resolve(cwd, candidate);
        return candidate;
    };

    const isDir = async (p: string): Promise<boolean> => {
        try {
            return (await fs.stat(resolveForCheck(p))).isDirectory();
        } catch {
            return false;
        }
    };

    const exists = async (p: string): Promise<boolean> => {
        try {
            await fs.access(resolveForCheck(p));
            return true;
        } catch {
            return false;
        }
    };

    let searchRoot: string | null = null;
    let useGlob: boolean = false;
    let relGlob: string | null = null;

    if (await isDir(files)) {
        searchRoot = files;
    } else if (hasGlobChars(files)) {
        useGlob = true;
        const { root: candidateRoot, relGlob: candidateRel } = splitGlobRoot(files);
        if (candidateRoot !== "." && !(await isDir(candidateRoot))) {
            searchRoot = ".";
            relGlob = files;
        } else {
            searchRoot = candidateRoot;
            relGlob = candidateRel || files;
        }
    } else {
        searchRoot = null;
    }

    let allowRecursive: boolean = false;
    if (useGlob && relGlob?.includes("**")) {
        allowRecursive = true;
    } else if (await isDir(files)){
        allowRecursive = recursive;
    } else {
        allowRecursive = false;
    }

    if (isWindows()) {
        const sanitizeGlob = (glob: string): string => glob.replace(/\*\*/g, "*").replace(/[\\/]/g, path.sep);
        const findstrArgs: string[] = [];

        if (!literal) findstrArgs.push("/R");
        if (literal) findstrArgs.push("/L");
        if (smartInsensitive) findstrArgs.push("/I");
        if (lineNumbers) findstrArgs.push("/N");
        if (allowRecursive) findstrArgs.push("/S");

        const patternArg = `/C:${pattern}`;
        const targets: string[] = [];

        if (searchRoot) {
            const glob = useGlob ? sanitizeGlob(relGlob || "*") : "*";
            targets.push(path.join(searchRoot, glob || "*"));
        } else if (useGlob && relGlob) {
            targets.push(sanitizeGlob(relGlob));
        } else if (!hasGlobChars(files) && files && await exists(files)) {
            targets.push(files);
        } else {
            targets.push(path.join(".", "*"));
        }

        const command = ["findstr", ...findstrArgs, patternArg, ...targets];

        try {
            return await runCommand(command, { timeOutMs: Math.max(0, Math.floor(timeout * 1000)), cwd, abortSignal });
        } catch (err) {
            const msg = String((err as any)?.message ?? err ?? "");
            const code = (err as any)?.code;
            if (code === "ENOENT" || /findstr(\.exe)? not found/i.test(msg)) {
                return {
                    stdout: "",
                    stderr: "findstr was not found. It should be available by default on Windows.",
                    returncode: 127,
                    success: false
                };
            }
            if (err instanceof TypeError) {
                return await runCommand(shlexJoin(command), { timeOutMs: Math.max(0, Math.floor(timeout * 1000)), cwd, abortSignal });
            }
            throw err;
        }
    }

    const command = ["rg", "--with-filename", "--color=never"];

    if (caseMode === 'smart')  
        {
        command.push("-S");
        } else if (caseMode === "insensitive") {
            command.push("-i");
        }
    
    if (literal) command.push("-F");
    if (noMessages) command.push("--no-messages"); 

    command.push(lineNumbers ? "-n" : "--no-line-number");

    if (!allowRecursive) {
        command.push("--max-depth", "1");
    }

    if (useGlob && relGlob) {
        command.push("-g", relGlob);
    }

    command.push("-e", pattern);

    if (searchRoot) {
        command.push(searchRoot);
    } else {
        if (!hasGlobChars(files) && files && await exists(files)) {
            command.push(files);
        } else {
            command.push(".");
        }
    }

    function isNotFoundError(e: unknown): boolean {
    const err = e as any;
    if (!err) return false;
    if (err.code === "ENOENT") return true;
    const msg = String(err.message ?? err);
    return /command not found|ripgrep.*not found|rg.*not found|ENOENT/i.test(msg);
    }

    try {
        return await runCommand(command, { timeOutMs: Math.max(0, Math.floor(timeout * 1000)), cwd, abortSignal });
    } catch (err) {
        if (isNotFoundError(err)) {
            return {
            stdout: "",
            stderr: "ripgrep (rg) not found. Install ripgrep: https://www.linode.com/docs/guides/ripgrep-linux-installation/",
            returncode: 127,
            success: false
            };
        }
        if (err instanceof TypeError) {
            return await runCommand(shlexJoin(command), { timeOutMs: Math.max(0, Math.floor(timeout * 1000)), cwd, abortSignal });
        }
        throw err;
    }
};

export interface CommandResult {
    stdout: string;
    stderr: string;
    returncode: number;
    success: boolean;
    timedOut?: boolean;
    signal?: NodeJS.Signals | null;
    truncated?: boolean;
}

function commandErrorResult(message: string, returncode: number = 126): CommandResult {
    return {
        stdout: "",
        stderr: message,
        returncode,
        success: false,
    };
}

export interface CommandRunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeOutMs?: number;
    shell?: boolean | string;
    encoding?: BufferEncoding;
    maxBufferBytes?: number;
    killSignal?: NodeJS.Signals | number;
    abortSignal?: AbortSignal;
    deniedCommands?: string[];
    allowUnsafe?: boolean;
    inheritEnv?: boolean;
    envAllowlist?: string[];
    envBlocklist?: string[];
    auditLabel?: string;
}

const DEFAULT_ENCODING: BufferEncoding = "utf8";
const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = parseDurationMsEnv(
    ['AGENT_COMMAND_TIMEOUT_MS', 'AGENT_CMD_TIMEOUT_MS'],
    5 * 60 * 1000,
);
const DEFAULT_ENV_BASELINE_KEYS = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "USERNAME",
];

const DEFAULT_BLOCKED_COMMANDS = new Set([
    "rm",
    "rmdir",
    "chmod",
    "chown",
    "chgrp",
    "dd",
    "mkfs",
    "mkfs.ext4",
    "mkfs.ext3",
    "mkfs.ext2",
    "mkfs.btrfs",
    "mkfs.xfs",
    "mkfs.fat",
    "mkfs.ntfs",
    "fdisk",
    "sfdisk",
    "parted",
    "diskutil",
    "mount",
    "umount",
    "shutdown",
    "reboot",
    "poweroff",
    "halt",
    "init",
    "telinit",
    "systemctl",
    "service",
    "launchctl",
    "kill",
    "killall",
    "pkill",
    "useradd",
    "userdel",
    "groupadd",
    "groupdel",
    "passwd",
    "sudo",
    "doas",
    "iptables",
    "ip6tables",
    "ufw",
    "firewall-cmd",
    "truncate",
    "shred",
    "wipefs",
].map((name) => name.toLowerCase()));

const SENSITIVE_ENV_PATTERNS = [
    /key/i,
    /secret/i,
    /token/i,
    /passwd/i,
    /password/i,
    /session/i,
    /cookie/i,
    /aws/i,
    /azure/i,
    /openai/i,
    /anthropic/i,
];

const AUDIT_LOG_NAMESPACE = "[agent:runCommand]";

type CommandDescriptor = {
    argv: string[];
    raw: string | string[];
    primary: string;
    primaryName: string;
    usesShell: boolean;
    hasPath: boolean;
};

function normalizeCommandName(value?: string | null): string {
    if (!value) return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    const base = path.basename(trimmed);
    return base.toLowerCase();
}

function buildCommandDescriptor(command: string | string[]): CommandDescriptor {
    if (Array.isArray(command)) {
        const primary = command[0] ?? "";
        return {
            argv: [...command],
            raw: [...command],
            primary,
            primaryName: normalizeCommandName(primary),
            usesShell: false,
            hasPath: hasPathSeparator(primary) || path.isAbsolute(primary),
        };
    }
    const trimmed = command.trim();
    return {
        argv: [trimmed],
        raw: trimmed,
        primary: trimmed,
        primaryName: normalizeCommandName(trimmed),
        usesShell: true,
        hasPath: hasPathSeparator(trimmed) || path.isAbsolute(trimmed),
    };
}

function computeBlockedCommands(opts: CommandRunOptions): Set<string> {
    const blocked = new Set<string>(DEFAULT_BLOCKED_COMMANDS);
    if (Array.isArray(opts.deniedCommands)) {
        for (const entry of opts.deniedCommands) {
            const norm = normalizeCommandName(entry);
            if (norm) blocked.add(norm);
        }
    }
    return blocked;
}

function sanitizeEnvironment(opts: CommandRunOptions): NodeJS.ProcessEnv {
    const inherit = opts.inheritEnv ?? false;
    const allowlist = new Set<string>(
        (opts.envAllowlist ?? []).map((key) => key.toUpperCase())
    );
    const blocklist = new Set<string>(
        (opts.envBlocklist ?? []).map((key) => key.toUpperCase())
    );

    const baseEnv: NodeJS.ProcessEnv = {};

    if (inherit) {
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) baseEnv[key] = value;
        }
    } else {
        for (const key of DEFAULT_ENV_BASELINE_KEYS) {
            const value = process.env[key];
            if (value !== undefined) baseEnv[key] = value;
        }
    }

    for (const key of Object.keys(baseEnv)) {
        const upper = key.toUpperCase();
        if (allowlist.has(upper)) continue;
        if (blocklist.has(upper)) {
            delete baseEnv[key];
            continue;
        }
        if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(key))) {
            delete baseEnv[key];
        }
    }

    if (opts.env) {
        for (const [key, value] of Object.entries(opts.env)) {
            if (value === undefined || value === null) {
                delete baseEnv[key];
                continue;
            }
            const upper = key.toUpperCase();
            if (!allowlist.has(upper) && SENSITIVE_ENV_PATTERNS.some((re) => re.test(key)) && !opts.allowUnsafe) {
                continue;
            }
            baseEnv[key] = String(value);
        }
    }

    if (!baseEnv.PATH && process.env.PATH) {
        baseEnv.PATH = process.env.PATH;
    }

    return baseEnv;
}

function auditLog(message: string, details: Record<string, unknown> = {}): void {
    const parts = [AUDIT_LOG_NAMESPACE, message.trim()];
    const payload = Object.keys(details).length > 0 ? JSON.stringify(details) : "";
    const line = payload ? `${parts.join(" ")} ${payload}` : parts.join(" ");
    console.info(line);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function hasPathSeparator(p: string): boolean {
    return /[\/\\]/.test(p);
}

function errorCodeFromSpawnError(err: NodeJS.ErrnoException | Error): number {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 127;
    if (code === "EACCES") return 126;
    return 1;
}

function getPathExts(): string[] {
    if (isWindows()) {
        const raw = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
        return raw.split(";").filter(Boolean);
    }
    return [""];
}

async function isExecutable(candidate: string): Promise<boolean> {
    try {
        if (isWindows()) {
            await fsAccess(candidate);
            return true;
        } else {
            await fsAccess(candidate, fsSync.constants.X_OK);
            return true;
        }
    } catch {
        return false;
    }
}


async function whichAsync(exe: string): Promise<string | null> {
    if (!exe) return null;
    if (path.isAbsolute(exe) || hasPathSeparator(exe)) {
        const exts = getPathExts();
        const candidates = isWindows() && path.extname(exe) === ""
            ? exts.map((ext) => exe + ext)
            : [exe];
        
        for (const c of candidates) {
            if (await isExecutable(c)) return c;
        }
        return null;
    }

    const PATH = process.env.PATH || "";
    const dirs = PATH.split(path.delimiter).filter(Boolean);
    const exts = getPathExts();

    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, isWindows() ? exe + (ext || "") : exe);
            if (await isExecutable(candidate)) return candidate;
        }
    }    
    return null;
}

async function killProcessTree(child: import('child_process').ChildProcess, signal?: NodeJS.Signals | number): Promise<void> {
    const sig: NodeJS.Signals | number =
        signal ?? (isWindows() ? "SIGTERM" : "SIGKILL");
    
    if (child.pid == null) return;

    if (isWindows()) {
        try {
            const stopper = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            await new Promise<void>((resolve) => stopper.once("close", () => resolve()));
        } catch {
            try {
                child.kill(sig as NodeJS.Signals);
            } catch {
            }
        }
    } else {
        try {
            process.kill(-child.pid, sig as NodeJS.Signals);
        } catch {
            try {
                process.kill(child.pid, sig as NodeJS.Signals);
            } catch {
            }
        }
    }
}

type PreparedSpawn = 
    | { kind: "ok"; file: string; args: string[]; spawnOpts: SpawnOptions }
    | { kind: "error"; result: CommandResult };

async function prepareSpawn(
    command: string | string[],
    opts: CommandRunOptions
): Promise<PreparedSpawn> {
    const shell = opts.shell ?? false;

    if (Array.isArray(command)) {
        if (command.length === 0 || !command[0]) {
            return {
                kind: "error",
                result: {
                    stdout: "",
                    stderr: "Empty argv: no executable provided",
                    returncode: 127,
                    success: false,
                },
            };
        }
    } else {
        if (!command.trim()) {
            return {
                kind: "error",
                result: {
                    stdout: "",
                    stderr: "Empty command string",
                    returncode: 127,
                    success: false,
                },
            };
        }
        if (!shell) {
            return {
                kind: "error",
                result: {
                    stdout: "",
                    stderr: "String commands require opts.shell=true (or a shell path) to avoid implicit shell execution.",
                    returncode: 126,
                    success: false,
                },
            };
        }
    }

    if (Array.isArray(command)) {
        const exe = command[0];
        const needsWhich = !path.isAbsolute(exe) && !hasPathSeparator(exe);
        if (needsWhich) {
            const resolved = await whichAsync(exe);
            if (!resolved) {
                return {
                    kind: "error",
                    result: {
                        stdout: "",
                        stderr: `Executable not found: ${exe}`,
                        returncode: 127,
                        success: false,
                    },
                };
            }
            command = [resolved, ...command.slice(1)];
        }
    }

    const spawnOpts: SpawnOptions = {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !isWindows(),
        shell,
    };

    if (Array.isArray(command)) {
        return { kind: "ok", file: command[0], args: command.slice(1), spawnOpts };
    } else {
        return { kind: "ok", file: command, args: [], spawnOpts };
    }
}


/**
 * Cross-platform command runner that streams stdout/stderr and keeps tight
 * control over buffer sizes, timeouts, and cancellation. Agent helpers rely on
 * this when running grep or other utilities that require process execution.
 */
async function runCommand(
    command: string | string[],
    opts: CommandRunOptions = {}
): Promise<CommandResult> {
    const descriptor = buildCommandDescriptor(command);
    const allowUnsafe = !!opts.allowUnsafe;

    if (!descriptor.primary) {
        return commandErrorResult("No executable provided", 127);
    }

    if (descriptor.usesShell && !allowUnsafe) {
        return commandErrorResult(
            "String commands executed via shell are disabled by default. Provide allowUnsafe or use argv form.",
            126
        );
    }

    const baseCwd = path.resolve(process.cwd());
    const inputCwd = typeof opts.cwd === "string" ? opts.cwd.trim() : "";
    const normalizedCwd = inputCwd
        ? path.isAbsolute(inputCwd)
            ? path.resolve(inputCwd)
            : path.resolve(baseCwd, inputCwd)
        : baseCwd;

    if (descriptor.hasPath && !descriptor.usesShell) {
        try {
            const resolvedBinary = path.isAbsolute(descriptor.primary)
                ? path.resolve(descriptor.primary)
                : path.resolve(normalizedCwd, descriptor.primary);
        } catch {
            if (!allowUnsafe) {
                return commandErrorResult("Failed to resolve executable path", 126);
            }
        }
    }

    const blockedCommands = computeBlockedCommands(opts);
    const primaryName = descriptor.primaryName;

    if (!allowUnsafe && blockedCommands.has(primaryName)) {
        return commandErrorResult(
            `Command '${descriptor.primary}' is blocked. Provide allowUnsafe to override.`,
            126
        );
    }

    if (
        !allowUnsafe &&
        primaryName === "rm" &&
        descriptor.argv.slice(1).some((arg) => /(^-rf?$)|(^-fr$)|(--no-preserve-root)/i.test(arg))
    ) {
        return commandErrorResult("'rm' with recursive flags is blocked without allowUnsafe.", 126);
    }

    const encoding = opts.encoding ?? DEFAULT_ENCODING;
    const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    const timeoutMs = opts.timeOutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const env = sanitizeEnvironment(opts);

    const safeOpts: CommandRunOptions = {
        ...opts,
        shell: opts.shell ?? false,
        cwd: normalizedCwd,
        env,
        timeOutMs: timeoutMs,
    };

    const prepared = await prepareSpawn(command, safeOpts);
    if (prepared.kind === "error") return prepared.result;

    const { file, args, spawnOpts } = prepared;

    const auditDetails = {
        label: opts.auditLabel ?? descriptor.primary,
        argv: Array.isArray(descriptor.raw) ? descriptor.raw : [descriptor.raw],
        cwd: normalizedCwd,
        timeoutMs,
        allowUnsafe,
    };
    auditLog("spawn", auditDetails);

    return new Promise<CommandResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdOutBytes = 0;
        let stdErrBytes = 0;
        let truncated = false;
        let timedOut = false;
        let aborted = false;

        const child = spawn(file, args, spawnOpts);

        let resolved = false;

        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
            if (resolved) return;
            resolved = true;
            const rc = code ?? (timedOut ? 124 : errorCodeFromSpawnError(new Error("Unknown failure")));
            const result: CommandResult = {
                stdout,
                stderr,
                returncode: rc,
                success: rc === 0,
                timedOut,
                signal,
                truncated,
            };
            auditLog("exit", {
                ...auditDetails,
                rc,
                timedOut,
                signal,
                stdoutBytes: stdOutBytes,
                stderrBytes: stdErrBytes,
                truncated,
            });
            resolve(result);
        };

        const timer =
            timeoutMs > 0
                ? setTimeout(async () => {
                    timedOut = true;
                    try {
                        await killProcessTree(child, opts.killSignal);
                    } finally {
                    }
                }, timeoutMs)
                : undefined;

        if (opts.abortSignal) {
            const onAbort = async () => {
                aborted = true;
                try {
                    await killProcessTree(child, opts.killSignal);
                } catch {}
            };
            if (opts.abortSignal.aborted) onAbort();
            else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (chunk: Buffer) => {
            if (stdOutBytes < maxBuffer) {
                const str = chunk.toString(encoding);
                stdout += str;
                stdOutBytes += Buffer.byteLength(str, encoding);
                if (stdOutBytes >= maxBuffer) truncated = true;
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            if (stdErrBytes < maxBuffer) {
                const str = chunk.toString(encoding);
                stderr += str;
                stdErrBytes += Buffer.byteLength(str, encoding);
                if (stdErrBytes >= maxBuffer) truncated = true;
            }
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
            if (timer) clearTimeout(timer);
            if (resolved) return;
            const rc = errorCodeFromSpawnError(err);
            resolved = true;
            const result: CommandResult = {
                stdout: "",
                stderr: String(err?.message ?? err),
                returncode: rc,
                success: false,
                timedOut: false,
                signal: null,
            };
            auditLog("error", {
                ...auditDetails,
                rc,
                message: result.stderr,
            });
            resolve(result);
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            if (timer) clearTimeout(timer);
            if (aborted && code == null) {
                stderr = stderr || "Command canceled";
                finish(130, signal ?? null);
            } else {
                finish(code, signal);
            }
        });
    });
}


export { createFile, grepSearch, createDiff, runCommand, generateImageFile, waitForDuration, brilliantSearch };
