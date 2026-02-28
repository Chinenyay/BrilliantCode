import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CodexAuthData {
  access_token?: string;
  account_id?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    account_id?: string;
  };
  accountId?: string;
}

/**
 * Get the path to the Codex auth file.
 * By default: ~/.codex/auth.json
 */
export function getCodexAuthFilePath(): string {
  const codexAuthFile = process.env.CODEX_AUTH_FILE;
  if (codexAuthFile) {
    return codexAuthFile;
  }
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Read and parse the Codex auth file.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function readCodexAuth(): Promise<CodexAuthData | null> {
  try {
    const authFilePath = getCodexAuthFilePath();
    const content = await fs.readFile(authFilePath, 'utf8');
    const data = JSON.parse(content);
    return data;
  } catch (error: any) {
    // File doesn't exist or is invalid
    return null;
  }
}

/**
 * Get the access token from the Codex auth file.
 * Checks both `auth.access_token` and `auth.tokens?.access_token`.
 * Returns null if no valid token is found.
 */
export async function getCodexAccessToken(): Promise<string | null> {
  const auth = await readCodexAuth();
  if (!auth) {
    return null;
  }

  // Try auth.access_token first
  if (typeof auth.access_token === 'string' && auth.access_token.trim()) {
    return auth.access_token.trim();
  }

  // Try auth.tokens?.access_token
  if (auth.tokens && typeof auth.tokens.access_token === 'string' && auth.tokens.access_token.trim()) {
    // Check if token is expired
    const expiresAt = auth.tokens.expires_at;
    if (typeof expiresAt === 'number' && Date.now() >= expiresAt) {
      // Token is expired
      return null;
    }
    return auth.tokens.access_token.trim();
  }

  return null;
}

/**
 * Check if a valid Codex access token exists.
 */
export async function hasCodexAccessToken(): Promise<boolean> {
  const token = await getCodexAccessToken();
  return token !== null;
}

/**
 * Get the account ID from the Codex auth file (if available).
 */
export async function getCodexAccountId(): Promise<string | null> {
  const auth = await readCodexAuth();
  if (!auth) {
    return null;
  }

  if (auth.tokens && typeof auth.tokens.account_id === 'string' && auth.tokens.account_id.trim()) {
    return auth.tokens.account_id.trim();
  }

  if (typeof auth.account_id === 'string' && auth.account_id.trim()) {
    return auth.account_id.trim();
  }

  if (typeof auth.accountId === 'string' && auth.accountId.trim()) {
    return auth.accountId.trim();
  }

  return null;
}

/**
 * Clear the Codex auth file.
 * Deletes ~/.codex/auth.json if it exists.
 */
export async function clearCodexAuth(): Promise<void> {
  try {
    const authFilePath = getCodexAuthFilePath();
    await fs.unlink(authFilePath);
  } catch (error: any) {
    // Ignore errors if file doesn't exist
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
