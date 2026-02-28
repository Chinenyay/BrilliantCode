import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCodexAccessToken, hasCodexAccessToken, getCodexAccountId, clearCodexAuth, getCodexAuthFilePath } from './codex-token.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('codex-token', () => {
  const testAuthDir = path.join(os.tmpdir(), 'test-codex-auth');
  const testAuthFile = path.join(testAuthDir, 'auth.json');

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testAuthDir, { recursive: true });

    // Set env var to use test directory
    process.env.CODEX_AUTH_FILE = testAuthFile;
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testAuthDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
    delete process.env.CODEX_AUTH_FILE;
  });

  describe('getCodexAuthFilePath', () => {
    it('should return custom path from env var', () => {
      process.env.CODEX_AUTH_FILE = '/custom/path/auth.json';
      expect(getCodexAuthFilePath()).toBe('/custom/path/auth.json');
    });

    it('should return default path when env var not set', () => {
      delete process.env.CODEX_AUTH_FILE;
      expect(getCodexAuthFilePath()).toBe(path.join(os.homedir(), '.codex', 'auth.json'));
    });
  });

  describe('getCodexAccessToken', () => {
    it('should return null when auth file does not exist', async () => {
      const token = await getCodexAccessToken();
      expect(token).toBeNull();
    });

    it('should return token from access_token field', async () => {
      const authData = {
        access_token: 'test-token-123',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBe('test-token-123');
    });

    it('should return token from tokens.access_token field', async () => {
      const authData = {
        tokens: {
          access_token: 'test-token-456',
          refresh_token: 'refresh-789',
          expires_at: Date.now() + 3600000, // 1 hour from now
        },
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBe('test-token-456');
    });

    it('should return null when token is expired', async () => {
      const authData = {
        tokens: {
          access_token: 'test-token-expired',
          expires_at: Date.now() - 1000, // 1 second ago
        },
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBeNull();
    });

    it('should prioritize access_token over tokens.access_token', async () => {
      const authData = {
        access_token: 'direct-token',
        tokens: {
          access_token: 'nested-token',
        },
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBe('direct-token');
    });

    it('should trim whitespace from token', async () => {
      const authData = {
        access_token: '  test-token-with-spaces  ',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBe('test-token-with-spaces');
    });

    it('should return null when auth file is invalid JSON', async () => {
      await fs.writeFile(testAuthFile, 'invalid json{', 'utf8');

      const token = await getCodexAccessToken();
      expect(token).toBeNull();
    });
  });

  describe('hasCodexAccessToken', () => {
    it('should return false when no token exists', async () => {
      const hasToken = await hasCodexAccessToken();
      expect(hasToken).toBe(false);
    });

    it('should return true when valid token exists', async () => {
      const authData = {
        access_token: 'test-token',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const hasToken = await hasCodexAccessToken();
      expect(hasToken).toBe(true);
    });
  });

  describe('getCodexAccountId', () => {
    it('should return null when auth file does not exist', async () => {
      const accountId = await getCodexAccountId();
      expect(accountId).toBeNull();
    });

    it('should return account ID when present', async () => {
      const authData = {
        access_token: 'test-token',
        accountId: 'user-123',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const accountId = await getCodexAccountId();
      expect(accountId).toBe('user-123');
    });

    it('should return account ID from tokens.account_id', async () => {
      const authData = {
        tokens: {
          access_token: 'test-token',
          account_id: 'workspace-456',
        },
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const accountId = await getCodexAccountId();
      expect(accountId).toBe('workspace-456');
    });

    it('should return account ID from top-level account_id', async () => {
      const authData = {
        access_token: 'test-token',
        account_id: 'workspace-top-level',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const accountId = await getCodexAccountId();
      expect(accountId).toBe('workspace-top-level');
    });

    it('should return null when account ID is not present', async () => {
      const authData = {
        access_token: 'test-token',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      const accountId = await getCodexAccountId();
      expect(accountId).toBeNull();
    });
  });

  describe('clearCodexAuth', () => {
    it('should delete auth file when it exists', async () => {
      const authData = {
        access_token: 'test-token',
      };
      await fs.writeFile(testAuthFile, JSON.stringify(authData), 'utf8');

      // Verify file exists
      expect(await fs.access(testAuthFile).then(() => true).catch(() => false)).toBe(true);

      await clearCodexAuth();

      // Verify file is deleted
      expect(await fs.access(testAuthFile).then(() => true).catch(() => false)).toBe(false);
    });

    it('should not throw when auth file does not exist', async () => {
      await expect(clearCodexAuth()).resolves.not.toThrow();
    });
  });
});
