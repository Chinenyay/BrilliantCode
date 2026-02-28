# Codex Auth Implementation

This file is the maintainer-facing summary of the current ChatGPT sign-in implementation.

For the user-facing overview, read `docs/CODEX_AUTH.md`.

## Current Design

BrilliantCode now splits authentication and inference cleanly:

- **Authentication:** `codex app-server`
- **Inference for ChatGPT-authenticated sessions:** `https://chatgpt.com/backend-api/codex/responses`
- **Tool execution:** the existing BrilliantCode `AgentSession` runtime

This is intentional. The app-server is used to authenticate and refresh credentials, but it is **not** the runtime that executes normal chat turns.

## Why

The goal is to preserve the same local tool behavior as API-key sessions.

That means:

- bash commands still use the app’s terminal tools
- file edits still go through the normal tool handlers
- confirmations still use the existing BrilliantCode approval flow

The earlier app-server-turn approach was removed because it bypassed that runtime and produced the wrong tool behavior.

## What The App Does Today

### Auth

`src/main/main.ts`

- `openai-oauth:status` -> `account/read`
- `openai-oauth:start` -> `account/login/start`
- `openai-oauth:clear` -> `account/logout`

`src/services/codex-app-server.ts`

- starts `codex app-server`
- handles JSON-RPC over stdio
- exposes auth helpers for login, status, logout, and refresh

### Requests

`src/main/main.ts`

- if an OpenAI API key exists, use the normal OpenAI SDK client
- otherwise, if ChatGPT/Codex auth exists, use `createCodexChatGPTClient()`

`src/services/codex-chatgpt-client.ts`

- reads the Codex access token
- refreshes it through the app-server when needed
- sends `responses.create` to the Codex backend Responses endpoint
- converts the streamed backend response into a completed Responses-style object

### Tool execution

`src/agent/session.ts`

- still drives the run loop
- still executes tools through the existing local handler map
- still owns approvals, terminal execution, file edits, and event emission

## Important Non-Goals

These are not part of the current implementation:

- direct OAuth token exchange inside BrilliantCode
- manual callback URL paste flow
- using `api.openai.com` with the ChatGPT auth token
- `codex app-server` `thread/start` / `turn/start` for normal chat execution
- Codex-specific tool bridging for standard runs

## Backend Request Normalization

The Codex backend `responses` endpoint is strict, so `src/services/codex-chatgpt-client.ts` normalizes requests before sending them.

Current adjustments include:

- convert developer/system prompt content into `instructions`
- remove unsupported fields such as:
  - `max_output_tokens`
  - `prompt_cache_key`
  - `prompt_cache_retention`
- force:
  - `store: false`
  - `stream: true`
- normalize replayed reasoning history so summary/content items include the required type fields

## Files

Primary implementation files:

- `src/main/main.ts`
- `src/services/codex-app-server.ts`
- `src/services/codex-token.ts`
- `src/services/codex-chatgpt-client.ts`

Related surface files:

- `src/preload/preload.ts`
- `src/types/global.d.ts`

Tests:

- `src/services/codex-app-server.test.ts`
- `src/services/codex-chatgpt-client.test.ts`

## Current Runtime Assumptions

The current ChatGPT-backed wrapper fully supports:

- `responses.create`

It does not yet implement:

- `responses.stream`
- `responses.retrieve`
- `responses.poll`

That is acceptable for the current runtime because the wrapper returns a completed response object from `create()`.

## Verification

Basic local verification:

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run src/services/codex-app-server.test.ts src/services/codex-chatgpt-client.test.ts
```

Manual verification:

1. Start the app.
2. Sign in through **AI -> API Keys -> Sign in with ChatGPT**.
3. Run an agent task that uses tools.
4. Confirm that bash/file tools behave the same way as they do with API-key auth.

## Reference

- [OpenAI Codex app-server documentation](https://developers.openai.com/codex/app-server/)
