import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAppServerClient } from './codex-app-server.js';
import type { ChildProcess } from 'node:child_process';

// Mock the spawn function
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('CodexAppServerClient', () => {
  let client: CodexAppServerClient;

  beforeEach(() => {
    client = new CodexAppServerClient();
  });

  afterEach(async () => {
    await client.stop();
  });

  describe('start', () => {
    it('should throw error if codex command is not found', async () => {
      const { spawn } = await import('node:child_process');
      const mockProcess = {
        stdout: null,
        stdin: null,
        stderr: null,
        on: vi.fn(),
        kill: vi.fn(),
        killed: false,
      } as unknown as ChildProcess;

      vi.mocked(spawn).mockReturnValue(mockProcess);

      // Trigger error immediately
      setTimeout(() => {
        const errorHandler = mockProcess.on.mock.calls.find(([event]) => event === 'error')?.[1];
        if (errorHandler) {
          errorHandler(new Error('spawn codex ENOENT'));
        }
      }, 0);

      await expect(client.start()).rejects.toThrow();
    });
  });

  describe('isRunning', () => {
    it('should return false when not started', () => {
      expect(client.isRunning()).toBe(false);
    });
  });

  describe('event handling', () => {
    it('should emit login:completed event when received from server', () => {
      const handler = vi.fn();
      client.on('login:completed', handler);

      // Simulate notification from server
      const notification = {
        method: 'account/login/completed',
        params: {
          loginId: 'test-login-id',
          success: true,
        },
      };

      // Access private handleNotification method via reflection for testing
      // @ts-ignore - accessing private method for testing
      client.handleNotification(notification);

      expect(handler).toHaveBeenCalledWith({
        loginId: 'test-login-id',
        success: true,
      });
    });

    it('should emit account:updated event when received from server', () => {
      const handler = vi.fn();
      client.on('account:updated', handler);

      const notification = {
        method: 'account/updated',
        params: {
          authMode: 'chatgpt',
          account: {
            type: 'chatgpt',
            email: 'test@example.com',
          },
        },
      };

      // @ts-ignore - accessing private method for testing
      client.handleNotification(notification);

      expect(handler).toHaveBeenCalledWith({
        authMode: 'chatgpt',
        account: {
          type: 'chatgpt',
          email: 'test@example.com',
        },
      });
    });
  });
});
