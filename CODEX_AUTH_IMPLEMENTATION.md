# Codex Authentication


BrilliantCode uses the official **Codex app-server** protocol for Sign in with ChatGPT.


1. **`src/services/codex-app-server.ts`**
   - Codex app-server client using JSON-RPC over stdio
   - Handles spawn, communication, and event notifications
   - Methods: `start()`, `stop()`, `getAuthState()`, `startChatGPTLogin()`, `logout()`

2. **`src/services/codex-app-server.test.ts`**
   - Unit tests for the Codex client
   - Tests event handling and error cases

3. **`docs/CODEX_AUTH.md`**
   - Complete documentation of the Codex authentication flow
   - Architecture diagrams, troubleshooting, API reference

4. **`CODEX_AUTH_IMPLEMENTATION.md`** (this file)
   - Summary of changes and testing instructions

### Modified Files

1. **`src/main/main.ts`**
   - Added import: `getSharedCodexClient`, `stopSharedCodexClient`
   - Replaced IPC handlers for `openai-oauth:*` to use Codex app-server
   - Added cleanup on app quit (`app.on('before-quit')`)
   - Updated dialog HTML to remove manual paste fields
   - Updated dialog JavaScript to poll for login completion

2. **`.env.example`**
   - Added note about Codex CLI requirement

### Unchanged Files (Backward Compatibility)

- **`src/services/openai-oauth.ts`** - Kept for legacy token storage
- **`src/main/openai-oauth-utils.ts`** - Kept for fallback parsing
- **`src/preload/preload.ts`** - No changes (API surface same)
- **`src/types/global.d.ts`** - No changes (types match)

## How to Test

### Prerequisites

1. **Install Codex CLI:**
   ```bash
   npm install -g @anthropic/codex
   ```

2. **Verify installation:**
   ```bash
   codex --version
   ```

   Expected output: version number (e.g., `1.2.3`)

3. **Make sure no other Codex instances are running:**
   ```bash
   # Check if port 1455 is in use
   lsof -i:1455

   # If needed, kill any processes using it
   lsof -ti:1455 | xargs kill -9
   ```

### Build and Run

1. **Install dependencies (if needed):**
   ```bash
   npm install
   ```

2. **Build the app:**
   ```bash
   npm run build
   ```

3. **Run the app:**
   ```bash
   npm run dev
   # or
   npm run start
   ```

### Test the Sign-In Flow

1. **Open the API Keys dialog:**
   - Click menu: **AI → API Keys…**
   - Or use the keyboard shortcut (if configured)

2. **Start sign-in:**
   - Click **"Sign in with ChatGPT"**
   - Status should change to: "Starting sign-in..."

3. **Verify browser opens:**
   - Browser should automatically open to `https://auth.openai.com/oauth/authorize?...`
   - If browser doesn't open, the login URL will be displayed (you can copy it manually)

4. **Complete OAuth in browser:**
   - Sign in to your OpenAI/ChatGPT account
   - Grant permissions to Codex

5. **Verify callback is handled:**
   - Browser redirects to `http://127.0.0.1:1455/auth/callback?code=...`
   - Dialog automatically detects completion (polls every 1 second)
   - Status updates to: "Signed in - [your-email]"
   - Success message: "ChatGPT sign-in complete!"

6. **Verify authentication persists:**
   - Close the dialog
   - Reopen it (AI → API Keys…)
   - Status should still show "Signed in"

7. **Test sign-out:**
   - Click **"Sign out"**
   - Status should change to: "Not signed in"

### Expected Console Output

When running in dev mode, you should see:

```
[codex-app-server] Starting Codex app-server...
[codex-app-server] Initialized successfully
[codex-app-server] Login started: loginId=abc123
[codex-app-server] Notification: account/login/completed
[codex-app-server] Notification: account/updated
```

### Troubleshooting Tests

#### Test 1: Codex CLI Not Installed

**Expected behavior:**
- Error: "Failed to start ChatGPT sign-in. Make sure the Codex CLI is installed."

**How to fix:**
```bash
npm install -g @anthropic/codex
```

#### Test 2: Port Already in Use

**Expected behavior:**
- Sign-in starts but callback fails
- Browser redirects fail with connection error

**How to fix:**
```bash
lsof -ti:1455 | xargs kill -9
```

#### Test 3: Timeout (>60 seconds)

**Expected behavior:**
- After 60 seconds: "Sign-in timeout. Please try again."

**How to fix:**
- Check internet connection
- Restart sign-in flow

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        BrilliantCode App                         │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Renderer Process                         │   │
│  │                                                            │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  API Keys Dialog (HTML)                          │    │   │
│  │  │  - "Sign in with ChatGPT" button                │    │   │
│  │  │  - Status display                                │    │   │
│  │  │  - Auth URL (if browser didn't open)            │    │   │
│  │  └──────────────────┬───────────────────────────────┘    │   │
│  │                     │ IPC: openai-oauth:start              │   │
│  │                     ↓                                      │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │  window.openaiOAuth.start()                      │    │   │
│  │  │  (exposed via preload.ts)                        │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  └────────────────────┬─────────────────────────────────────┘   │
│                       │                                          │
│                       ↓                                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Main Process                           │   │
│  │                                                           │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │  IPC Handler: openai-oauth:start                   │ │   │
│  │  └────────────────┬───────────────────────────────────┘ │   │
│  │                   │                                      │   │
│  │                   ↓                                      │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │  CodexAppServerClient                              │ │   │
│  │  │  - getSharedCodexClient()                         │ │   │
│  │  │  - start() → spawn('codex', ['app-server'])       │ │   │
│  │  │  - startChatGPTLogin()                            │ │   │
│  │  │  - Event listeners (login:completed, etc.)        │ │   │
│  │  └────────────────┬───────────────────────────────────┘ │   │
│  │                   │ JSON-RPC over stdio                  │   │
│  └───────────────────┼──────────────────────────────────────┘   │
│                      │                                          │
└──────────────────────┼──────────────────────────────────────────┘
                       │
                       ↓
              ┌─────────────────────┐
              │  codex app-server   │
              │  (subprocess)       │
              │                     │
              │  - Handles OAuth    │
              │  - Runs callback    │
              │    server on :1455  │
              │  - Manages tokens   │
              │  - Sends JSON-RPC   │
              │    notifications    │
              └──────────┬──────────┘
                         │
                         ↓
                  ┌──────────────────┐
                  │   Browser         │
                  │   (OAuth flow)    │
                  └──────────────────┘
```

## JSON-RPC Message Flow

```
1. BrilliantCode → codex app-server
   {
     "jsonrpc": "2.0",
     "method": "initialize",
     "id": 1,
     "params": { "clientInfo": { "name": "brilliantcode", ... } }
   }

2. codex app-server → BrilliantCode
   {
     "jsonrpc": "2.0",
     "id": 1,
     "result": {}
   }

3. BrilliantCode → codex app-server
   {
     "method": "initialized",
     "params": {}
   }

4. BrilliantCode → codex app-server
   {
     "jsonrpc": "2.0",
     "method": "account/login/start",
     "id": 2,
     "params": { "type": "chatgpt" }
   }

5. codex app-server → BrilliantCode
   {
     "jsonrpc": "2.0",
     "id": 2,
     "result": {
       "loginId": "...",
       "authUrl": "https://auth.openai.com/oauth/authorize?..."
     }
   }

6. [User completes OAuth in browser]

7. codex app-server → BrilliantCode (notification)
   {
     "jsonrpc": "2.0",
     "method": "account/login/completed",
     "params": {
       "loginId": "...",
       "success": true
     }
   }

8. codex app-server → BrilliantCode (notification)
   {
     "jsonrpc": "2.0",
     "method": "account/updated",
     "params": {
       "authMode": "chatgpt",
       "account": { "type": "chatgpt", "email": "..." }
     }
   }

9. BrilliantCode → codex app-server (status check)
   {
     "jsonrpc": "2.0",
     "method": "account/read",
     "id": 3,
     "params": { "refreshToken": false }
   }

10. codex app-server → BrilliantCode
    {
      "jsonrpc": "2.0",
      "id": 3,
      "result": {
        "account": { "type": "chatgpt", "email": "..." },
        "authMode": "chatgpt"
      }
    }
```