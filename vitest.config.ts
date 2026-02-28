import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/agent/**/*.ts', 'src/main/openai-oauth-utils.ts', 'src/services/openai-oauth.ts'],
      exclude: ['**/*.test.ts', '**/node_modules/**']
    }
  },
});
