# Codex Authentication

BrilliantCode uses `codex app-server` for **ChatGPT sign-in and token refresh only**.

After sign-in, normal agent requests do **not** run through the app-server turn/thread protocol. They go through the existing BrilliantCode agent runtime, with model requests sent to:

`https://chatgpt.com/backend-api/codex/responses`

That means:

- Authentication is managed by Codex.
- Tool execution is still managed by BrilliantCode.
- Bash, file edits, terminals, previews, and confirmations still use the existing local runtime in `main.ts`.

## Short Version

1. User clicks **Sign in with ChatGPT**.
2. BrilliantCode starts `codex app-server`.
3. Codex opens the browser and completes OAuth.
4. BrilliantCode checks auth state through the app-server.
5. If there is no OpenAI API key but ChatGPT auth is available, the app uses the Codex backend `responses` endpoint for model requests.
6. The existing `AgentSession` loop still executes tools locally.

## Why This Design

The ChatGPT/Codex sign-in token is not treated like a normal OpenAI API key in this app.

Instead:

- `codex app-server` is used to manage login state and token refresh.
- The app reads the Codex access token and sends model requests to the Codex backend Responses endpoint.
- This keeps the current BrilliantCode tool runtime intact, so tool calls still go through the same handlers as API-key sessions.

The important consequence is:

- We do **not** use `thread/start` or `turn/start` for normal agent runs.
- We do **not** use the old direct OAuth flow.
- We do **not** use a separate Codex-native tool bridge anymore.

## Current Architecture

### Authentication path

`src/main/main.ts`

- `openai-oauth:status` starts the shared app-server client if needed and calls `account/read`.
- `openai-oauth:start` calls `account/login/start` and opens the returned browser URL.
- `openai-oauth:clear` calls `account/logout`.

`src/services/codex-app-server.ts`

- Spawns `codex app-server`.
- Speaks JSON-RPC over stdio.
- Exposes login/status/logout helpers.

### Inference path

`src/main/main.ts`

- `buildOpenAIClient()` chooses the request client:
  - OpenAI API key present: use the normal OpenAI SDK path.
  - No API key, but ChatGPT auth exists: use `createCodexChatGPTClient()`.

`src/services/codex-chatgpt-client.ts`

- Reads the Codex access token.
- Refreshes the token through `codex app-server` when needed.
- Sends `responses.create` requests to `https://chatgpt.com/backend-api/codex/responses`.
- Normalizes request payloads for backend compatibility.
- Parses the streaming response and returns a completed Responses-style object back to the app.

### Tool runtime

`src/agent/session.ts` and `src/main/main.ts`

- Tool calls still go through the normal `AgentSession` loop.
- Local tool handlers still come from `createToolHandlers(...)`.
- Integrated terminal tools still use the existing terminal/runtime infrastructure.

This is the key behavior to preserve.

## Request Flow

### Sign in

1. Renderer calls `window.openaiOAuth.start()`.
2. Main process starts or reuses `codex app-server`.
3. Main process sends `account/login/start`.
4. Browser opens the returned `authUrl`.
5. Codex handles the callback automatically on `http://127.0.0.1:1455/auth/callback`.
6. Main process later checks `account/read` to show signed-in state.

### Chat request with ChatGPT auth

1. User sends a message.
2. `buildOpenAIClient()` checks for an OpenAI API key.
3. If no API key exists but ChatGPT auth is available, the app uses `createCodexChatGPTClient()`.
4. The request is converted into a backend-compatible `responses.create` payload.
5. The backend response is parsed back into a normal Responses-style object.
6. `AgentSession` processes tool calls exactly like an API-key-backed run.

## Backend Compatibility Notes

The Codex backend Responses endpoint is close to the OpenAI Responses API, but it is not identical.

`src/services/codex-chatgpt-client.ts` currently handles these differences:

- Moves developer/system prompt content into `instructions`.
- Forces `store: false`.
- Forces `stream: true` and then aggregates the stream back into one completed response object.
- Removes fields the backend rejects, such as:
  - `max_output_tokens`
  - `prompt_cache_key`
  - `prompt_cache_retention`
- Normalizes replayed reasoning items so persisted history matches the stricter backend schema.

## Files To Read

- `src/main/main.ts`
- `src/services/codex-app-server.ts`
- `src/services/codex-token.ts`
- `src/services/codex-chatgpt-client.ts`
- `src/preload/preload.ts`
- `src/types/global.d.ts`

## What Is No Longer Used

These are stale designs and should not be reintroduced without a deliberate decision:

- Direct OpenAI OAuth token exchange in BrilliantCode.
- Manual callback URL paste/exchange flow.
- Using ChatGPT sign-in as a direct bearer token for `api.openai.com`.
- Routing normal chats through `codex app-server` `thread/start` / `turn/start`.
- Separate Codex-specific tool execution for standard agent runs.

## Current Limitations

The ChatGPT-backed client currently implements the method the runtime actually needs:

- `responses.create`: implemented

These are still placeholders in the backend wrapper:

- `responses.stream`
- `responses.retrieve`
- `responses.poll`

The current agent runtime does not rely on them for ChatGPT-authenticated runs because the wrapper returns a completed response from `create()`.

## Troubleshooting

### `Failed to start ChatGPT sign-in`

Most likely causes:

- `codex` CLI is not installed
- `codex` is not on `PATH`
- the app-server process failed to start

Check:

```bash
codex --version
```

### Sign-in completes in browser but the app still shows signed out

Check:

- `codex app-server` can start successfully
- nothing else is conflicting with the callback listener on `127.0.0.1:1455`

### Backend request schema errors

The Codex backend is stricter than the normal OpenAI API path.

If you see errors like:

- `Missing required parameter: 'input[3].summary[0].type'`

then the stored history shape usually needs to be normalized before sending it to the backend. That logic lives in `src/services/codex-chatgpt-client.ts`.

### 401 or expired-session errors

The backend wrapper asks `codex app-server` to refresh auth state before retrying once.

If refresh still fails:

1. Sign out
2. Sign back in

## Maintainer Notes

If you change auth again, keep these boundaries explicit:

- `codex app-server` owns login state.
- BrilliantCode owns the tool runtime.
- The two should stay decoupled unless there is a deliberate reason to change the agent execution model.

## References

- [OpenAI Codex app-server documentation](https://developers.openai.com/codex/app-server/)
