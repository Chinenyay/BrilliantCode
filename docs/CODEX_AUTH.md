# Codex Authentication Setup

BrilliantCode now supports "Sign in with ChatGPT" using the official Codex app-server protocol, similar to how OpenCode implements authentication.

## Prerequisites

1. **Install the Codex CLI**:
   ```bash
   npm install -g @anthropic/codex
   ```

2. **Verify installation**:
   ```bash
   codex --version
   ```

## How It Works

### Architecture

Instead of implementing OAuth directly (which requires managing client IDs and secrets), BrilliantCode uses the **Codex app-server** to handle authentication:

1. **Spawns `codex app-server`**: A subprocess that manages the OAuth flow
2. **JSON-RPC Communication**: Uses the official Codex app-server protocol
3. **Automatic Callback Handling**: The app-server handles the OAuth callback on `http://127.0.0.1:1455/auth/callback`
4. **Token Management**: Codex manages token storage, refresh, and expiry

### Flow Diagram

```
User clicks "Sign in with ChatGPT"
         ↓
BrilliantCode → codex app-server
         ↓
JSON-RPC: { method: "account/login/start", params: { type: "chatgpt" } }
         ↓
App-server returns authUrl
         ↓
Open browser to authUrl
         ↓
User completes OAuth in browser
         ↓
Browser redirects to http://127.0.0.1:1455/auth/callback
         ↓
App-server handles callback automatically
         ↓
App-server sends notification: { method: "account/login/completed" }
         ↓
BrilliantCode receives notification and updates UI
```

## Usage

### Sign In

1. Open BrilliantCode
2. Go to **AI → API Keys…**
3. Click **"Sign in with ChatGPT"**
4. Your browser opens to the ChatGPT OAuth page
5. Complete the sign-in in your browser
6. The dialog automatically updates when sign-in is complete

### Sign Out

1. Go to **AI → API Keys…**
2. Click **"Sign out"**
3. Your Codex session is cleared

### Check Status

The API Keys dialog shows your current authentication status:
- **Not signed in**: No active session
- **Signed in - [email]**: Successfully authenticated

## Implementation Details

### Key Files

- **`src/services/codex-app-server.ts`**: Codex app-server client implementation
- **`src/main/main.ts`**: IPC handlers for authentication
- **`src/preload/preload.ts`**: Preload bridge exposing `window.openaiOAuth`

### JSON-RPC Protocol

The Codex app-server uses JSON-RPC 2.0 over stdio:

**Initialize connection:**
```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "brilliantcode",
      "title": "BrilliantCode",
      "version": "1.0.0"
    }
  }
}
```

**Start login:**
```json
{
  "jsonrpc": "2.0",
  "method": "account/login/start",
  "id": 2,
  "params": {
    "type": "chatgpt"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "loginId": "...",
    "authUrl": "https://auth.openai.com/oauth/authorize?..."
  }
}
```

**Notifications:**
```json
{
  "jsonrpc": "2.0",
  "method": "account/login/completed",
  "params": {
    "loginId": "...",
    "success": true
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "account/updated",
  "params": {
    "authMode": "chatgpt",
    "account": {
      "type": "chatgpt",
      "email": "user@example.com"
    }
  }
}
```

### Events

The `CodexAppServerClient` emits the following events:

- **`login:completed`**: Fired when login flow completes
- **`account:updated`**: Fired when account state changes
- **`error`**: Fired on process errors
- **`exit`**: Fired when app-server process exits
- **`notification`**: Fired for unknown notifications (debugging)

## Troubleshooting

### "Failed to start ChatGPT sign-in"

**Cause**: Codex CLI not installed or not in PATH

**Solution**:
```bash
npm install -g @anthropic/codex
# or
brew install codex
```

### Port 1455 Already in Use

**Cause**: Another instance of Codex CLI or BrilliantCode is running

**Solution**:
1. Close all Codex CLI instances
2. Close all BrilliantCode windows
3. Kill any lingering processes:
   ```bash
   lsof -ti:1455 | xargs kill -9
   ```
4. Restart BrilliantCode

### "Sign-in timeout"

**Cause**: Login flow took too long (>60 seconds)

**Solution**:
1. Try again
2. Check your internet connection
3. Verify you can access `https://auth.openai.com`

### Browser Didn't Open

If the browser doesn't open automatically:

1. Copy the login URL from the dialog
2. Paste it into your browser manually
3. Complete the OAuth flow
4. The callback is handled automatically - you don't need to paste anything back

## Differences from Direct OAuth

### What We Removed

- ❌ `OPENAI_OAUTH_CLIENT_ID` environment variable
- ❌ `OPENAI_OAUTH_REDIRECT_URI` configuration
- ❌ Manual OAuth implementation
- ❌ Manual callback server
- ❌ Manual token refresh logic
- ❌ Manual paste of redirect URL

### What We Gained

- ✅ Official Codex app-server protocol
- ✅ Automatic callback handling
- ✅ Automatic token management
- ✅ Consistent with other Codex clients (OpenCode, etc.)
- ✅ No OAuth secrets to manage
- ✅ Better error handling and notifications

## API Reference

### `CodexAppServerClient`

#### Methods

**`start(): Promise<void>`**

Start the Codex app-server subprocess and initialize the connection.

**`stop(): Promise<void>`**

Stop the Codex app-server subprocess gracefully.

**`isRunning(): boolean`**

Check if the app-server process is currently running.

**`getAuthState(options?: { refreshToken?: boolean }): Promise<CodexAuthState>`**

Get the current authentication state.

**`startChatGPTLogin(): Promise<CodexLoginStartResult>`**

Start the ChatGPT OAuth login flow. Returns the `authUrl` to open in a browser.

**`logout(): Promise<void>`**

Log out from the current Codex session.

#### Events

**`login:completed`**

Emitted when a login flow completes (success or failure).

**`account:updated`**

Emitted when the account authentication state changes.

**`error`**

Emitted when the app-server process encounters an error.

**`exit`**

Emitted when the app-server process exits.

## References

- [Codex CLI Documentation](https://docs.anthropic.com/codex)
- [Codex App-Server Protocol](https://github.com/anthropics/codex-cli)
- [OpenCode Implementation](https://github.com/opencoder-llm/opencode)
