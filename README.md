
# BrilliantCode

BrilliantCode is an open-source autonomous AI engineer built for production-grade, real-world software engineering. Think of it as an open-source alternative to Cursor that gives you full transparency and control over the agent's actions.

**Use frontier models (GPT-5, Claude 4.5) or local models (via OpenAI-compatible endpoints) through a clean desktop interface.**

## Key Features

- **Multi-Model Support**: Use OpenAI (GPT-5.x reasoning models), Anthropic (Claude 4.5 with extended thinking), or any OpenAI-compatible local model
- **Autonomous Agent Loop**: The agent uses the same tools you use as a developer - reading, writing, searching, and editing code
- **Built-in Tools**: File operations, grep search, image generation, web search, and task management
- **Context Compaction**: Automatically summarizes older conversation turns to handle long-running sessions without losing context
- **Workspace Baseline & Undo**: Captures a snapshot of your workspace before the agent starts, enabling file-level undo of any changes
- **MCP Plugin System** (Experimental): Extend functionality via Model Context Protocol servers
- **Secure by Design**: API keys stored in your OS keychain, sandboxed tool execution, no arbitrary code execution
- **Full Transparency**: See exactly what the agent is thinking, planning, and doing

---

## Table of Contents

1. [Installation](#installation)
2. [Architecture Overview](#architecture-overview)
3. [Tool System](#tool-system)
4. [Context Compaction System](#context-compaction-system)
5. [Workspace Baseline System](#workspace-baseline-system)
6. [MCP Integration (Experimental)](#mcp-integration-experimental)
7. [Contributing](#contributing)
8. [Roadmap](#roadmap)
9. [License](#license)

---

## Installation

### Download Pre-built Binaries

Visit [https://brilliantai.co/download](https://brilliantai.co/download) to download builds for macOS, Windows, and Linux.

### Building from Source

**Prerequisites:**
- Node.js 20+
- Native build tooling for Node modules (Xcode CLT on macOS, Windows Build Tools on Windows)

```bash
# Clone the repository
git clone https://github.com/brilliantai/brilliantcode.git
cd brilliantcode

# Install dependencies
npm install

# Run in development mode
npm run dev
```

This starts:
- Vite renderer dev server on `http://localhost:5174`
- TypeScript watchers for `src/main` and `src/preload`
- Electron app pointed at the dev server

**Production Build:**
```bash
npm run build
```

**Packaging:**
```bash
npm run build
npx electron-forge make
```

### API Keys

BrilliantCode uses your provider keys directly (no proxy):
- `OPENAI_API_KEY` - For OpenAI/GPT models
- `ANTHROPIC_API_KEY` - For Claude models

Set keys either:
- **In-app**: `AI` -> `API Keys...` (stored securely in your OS keychain)
- **Environment variables**: Useful for local development

**Optional:**
- `OPENAI_BASE_URL` (or `OPENAI_API_BASE`) - Point to any OpenAI-compatible Responses API host (e.g., local/OpenRouter). Defaults to `https://api.openai.com/v1`.
- `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_ID` - For web search via Google Custom Search
- `BRILLIANTCODE_DEFAULT_MODEL` - Override the default model
- Add custom models from the in-app model picker (`Add custom model…`) to target any OpenAI-compatible model ID.

---

## Architecture Overview

BrilliantCode is an Electron app with a clear separation between the agent logic and the UI layer.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Electron App                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Main Process                               │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │  │
│  │  │ AgentSession    │  │ Session Manager │  │  MCP Host    │  │  │
│  │  │ Manager         │  │ (IPC Bridge)    │  │ (Plugins)    │  │  │
│  │  └────────┬────────┘  └─────────────────┘  └──────────────┘  │  │
│  │           │                                                   │  │
│  │           ▼                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │                   Agent Core (src/agent/)               │ │  │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │ │  │
│  │  │  │  Session    │  │   Tools     │  │   Compaction    │  │ │  │
│  │  │  │  (Loop)     │──│  (Sandbox)  │  │   (Summarizer)  │  │ │  │
│  │  │  └──────┬──────┘  └─────────────┘  └─────────────────┘  │ │  │
│  │  │         │                                                │ │  │
│  │  │         ▼                                                │ │  │
│  │  │  ┌─────────────────────────────────────────────────────┐│ │  │
│  │  │  │  LLM Providers (OpenAI / Anthropic / Local)         ││ │  │
│  │  │  └─────────────────────────────────────────────────────┘│ │  │
│  │  └─────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   Renderer Process (UI)                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │  │
│  │  │  Chat Interface │  │  Monaco Editor  │  │   Terminal   │  │  │
│  │  └─────────────────┘  └─────────────────┘  └──────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### The Agent Loop

The core agent operates as an autonomous loop:

```
┌──────────────────────────────────────────────────────────────────┐
│                        Agent Loop                                │
│                                                                  │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐     │
│   │  User   │───▶│   LLM   │───▶│  Tool   │───▶│ Result  │──┐  │
│   │ Message │    │ Response│    │  Call   │    │  Feed   │  │  │
│   └─────────┘    └─────────┘    └─────────┘    └─────────┘  │  │
│        ▲                                                     │  │
│        │                                                     │  │
│        └─────────────────────────────────────────────────────┘  │
│                     (Loop until LLM finishes)                   │
└──────────────────────────────────────────────────────────────────┘
```

1. User sends a message
2. LLM processes and may request tool calls
3. Tools execute in a sandboxed environment
4. Results feed back to the LLM
5. Loop continues until LLM completes (no more tool calls)

### Key Source Files

| File | Purpose |
|------|---------|
| `src/agent/session.ts` | Core agent loop, LLM interaction, tool orchestration |
| `src/agent/tools.ts` | Tool adapters with sandbox validation |
| `src/agent/functions.ts` | Low-level tool implementations |
| `src/agent/models.ts` | Model configuration and provider routing |
| `src/agent/compaction/` | Context compaction system |
| `src/main/main.ts` | Electron main process, IPC handlers |
| `src/main/agentSessionManager.ts` | Session lifecycle management |
| `src/main/workspaceBaseline.ts` | Workspace snapshot and undo system |
| `src/main/mcpHost.ts` | MCP server management |

---

## Tool System

BrilliantCode provides the agent with a set of built-in tools that operate within a secure sandbox.

### Built-in Tools

| Tool | Description |
|------|-------------|
| `create_file` | Create a file and write content to it |
| `create_diff` | Replace text in a file (search and replace) |
| `read_file` | Read file contents |
| `get_file_size` | Get line and word counts |
| `grep_search` | Search for patterns in files using regex |
| `google_search` | Web search via Google Custom Search API |
| `generate_image_tool` | Generate images using DALL-E |
| `add_todo_tool` | Add a task to the todo list |
| `update_todo_item_tool` | Update task content |
| `update_todo_status_tool` | Mark tasks as todo/in_progress/done |
| `clear_todos_tool` | Clear all tasks |
| `list_todos_tool` | List current tasks |
| `wait_tool` | Pause execution for a duration |

### Tool Sandbox

All tools operate within a sandbox that:

1. **Validates Paths**: Tools can only access files within the workspace or an optional additional directory
2. **Supports Scoped Paths**: Use `workspace:` or `additional:` prefixes for explicit path resolution
3. **Clamps Output**: Large outputs are truncated to prevent context overflow (120KB default limit)
4. **Returns Consistent Envelopes**: Every tool returns `{ ok: boolean, error?: string, ... }`

### Path Resolution

```typescript
// Explicit scope
"workspace:src/index.ts"    // Always resolves to workspace
"additional:scratch/test.js" // Always resolves to additional dir

// Auto-resolution (no prefix)
"src/index.ts"              // Checks workspace first, then additional
```

### Adding Custom Tools

To add a new tool:

1. **Add the implementation** in `src/agent/functions.ts`:
```typescript
export async function myCustomTool(arg1: string, arg2: number): Promise<{
  succeeded: boolean;
  message?: string;
  error?: string;
}> {
  // Implementation
}
```

2. **Create the adapter** in `src/agent/tools.ts`:
```typescript
type MyToolArgs = { arg1: string; arg2: number };

const makeMyToolAdapter = (ctx: ToolContext) => async (args: MyToolArgs) => {
  const { arg1, arg2 } = args || {};
  // Validate inputs
  if (!arg1?.trim()) return { ok: false, error: 'arg1 is required.' };

  // Call implementation
  const result = await myCustomTool(arg1, arg2);
  return {
    ok: !!result.succeeded,
    message: result.message,
    error: result.error,
  };
};
```

3. **Register in the handler factory**:
```typescript
function createToolHandlers(opts: CreateToolHandlersOptions = {}): Record<string, ToolHandler> {
  // ... existing code ...
  return {
    // ... existing tools ...
    my_custom_tool: makeMyToolAdapter(ctx),
  };
}
```

4. **Add the schema** to `toolsSchemaOAI`:
```typescript
{
  type: 'function',
  name: 'my_custom_tool',
  description: 'Description of what the tool does.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      arg1: { type: 'string', description: 'First argument.' },
      arg2: { type: 'number', description: 'Second argument.' },
    },
    required: ['arg1', 'arg2'],
  },
}
```

---

## Context Compaction System

Long conversations can exceed model context limits (200-272K tokens). BrilliantCode solves this with automatic context compaction.

### How It Works

```
┌───────────────────────────────────────────────────────────────────┐
│                    Context Compaction                             │
│                                                                   │
│   Original History:                                               │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│   │Turn │ │Turn │ │Turn │ │Turn │ │Turn │ │Turn │ │Turn │       │
│   │  1  │ │  2  │ │  3  │ │  4  │ │  5  │ │  6  │ │  7  │       │
│   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       │
│                                                                   │
│   After Compaction (preserveLastTurns: 3):                       │
│   ┌────────────────────────────┐ ┌─────┐ ┌─────┐ ┌─────┐        │
│   │   [SUMMARY of Turns 1-4]   │ │Turn │ │Turn │ │Turn │        │
│   │   - Key decisions made     │ │  5  │ │  6  │ │  7  │        │
│   │   - Files modified         │ └─────┘ └─────┘ └─────┘        │
│   │   - Important context      │   (preserved intact)            │
│   └────────────────────────────┘                                  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Turn Structure

A "turn" is one user message plus all assistant/tool interactions until the next user message:

```typescript
interface Turn {
  userMessage: Message;           // The user's input
  assistantAndTools: Message[];   // All responses, tool calls, tool results
  estimatedTokens: number;        // Token count for this turn
}
```

### Compaction Strategies

| Strategy | Description |
|----------|-------------|
| `per_turn` | Summarize each turn individually |
| `rolling_summary` | Build a cumulative summary that grows over time |
| `adaptive` | Dynamically choose based on token distribution |

### Configuration

```typescript
// OpenAI defaults
{
  maxContextTokens: 272_000,      // Trigger compaction above this
  targetContextTokens: 180_000,   // Target to compact down to
  preserveLastTurns: 20,          // Keep last 20 turns intact
  summaryModel: 'gpt-5-mini',     // Fast model for summarization
  strategy: 'adaptive',
  maxIterations: 2,               // Max compaction passes per invocation
}

// Anthropic defaults
{
  maxContextTokens: 200_000,
  targetContextTokens: 100_000,
  preserveLastTurns: 20,
  summaryModel: 'claude-sonnet-4.5',
  strategy: 'adaptive',
  maxIterations: 2,
}
```

### Key Design Principles

- **User messages are ALWAYS preserved** (either intact or in the summary)
- **System prompt is handled separately** (not part of compaction)
- **OpenAI and Anthropic have independent implementations**
- **Compaction is incremental** (can build on previous summaries)

---

## Workspace Baseline System

BrilliantCode captures a snapshot of your workspace before the agent makes changes, enabling you to undo any modifications.

### How It Works

```
┌────────────────────────────────────────────────────────────────────┐
│                    Workspace Baseline Flow                         │
│                                                                    │
│   1. Session Starts                                                │
│      ┌─────────────────────────────────────────────────────────┐  │
│      │  Capture Baseline                                        │  │
│      │  - Walk all files (respecting .gitignore)               │  │
│      │  - Store SHA-256 hash, size, mtime, line count          │  │
│      │  - Copy file contents (up to 15MB each, 300MB total)    │  │
│      └─────────────────────────────────────────────────────────┘  │
│                                                                    │
│   2. Agent Makes Changes                                           │
│      ┌─────────────────────────────────────────────────────────┐  │
│      │  create_file("src/new.ts", "...")                        │  │
│      │  create_diff("src/app.ts", oldText, newText)            │  │
│      └─────────────────────────────────────────────────────────┘  │
│                                                                    │
│   3. Compute Changes (anytime)                                     │
│      ┌─────────────────────────────────────────────────────────┐  │
│      │  Compare current state vs baseline                       │  │
│      │  - A (added): new files                                  │  │
│      │  - M (modified): changed files                           │  │
│      │  - D (deleted): removed files                            │  │
│      │  - Show additions/deletions count                        │  │
│      └─────────────────────────────────────────────────────────┘  │
│                                                                    │
│   4. Undo Changes                                                  │
│      ┌─────────────────────────────────────────────────────────┐  │
│      │  undoWorkspaceBaselineFile() - Restore single file       │  │
│      │  undoWorkspaceBaselineAll()  - Restore entire workspace  │  │
│      └─────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Storage Structure

```
~/.brilliantcode/baselines/
└── <workspace-hash>/           # SHA-256 hash of workspace path
    └── <session-id>/
        └── <run-id>/
            ├── baseline-manifest.json   # Metadata for all files
            └── files/                   # Stored file copies
                ├── src/
                │   ├── index.ts
                │   └── app.ts
                └── package.json
```

### Manifest Format

```typescript
interface BaselineManifest {
  version: 1;
  createdAt: number;              // Unix timestamp
  workspaceRoot: string;          // Absolute path
  entries: Record<string, {
    relPath: string;              // Relative path from workspace root
    size: number;                 // File size in bytes
    mtimeMs: number;              // Modification time
    mode: number;                 // File permissions
    sha256: string;               // Content hash
    textLike: boolean;            // Is it a text file?
    lineCount: number | null;     // Line count (text files only)
    stored: boolean;              // Was content stored?
  }>;
  totals: {
    files: number;
    bytesStored: number;
    filesStored: number;
    filesSkipped: number;         // Files too large to store
  };
}
```

### Limits

| Limit | Value |
|-------|-------|
| Max file size to store | 15 MB |
| Max total storage per baseline | 300 MB |

### Ignored Paths

The baseline system automatically ignores:

**Directories:**
- `.git`, `node_modules`, `dist`, `release`, `out`, `build`
- `.next`, `.cache`, `.turbo`, `.vite`, `.parcel-cache`

**Files:**
- `.DS_Store`
- Hidden directories (starting with `.`)
- Paths matching `.gitignore` rules

### Diff Algorithm

BrilliantCode uses the Myers diff algorithm for computing line-level changes:

1. **Fast path**: If size and mtime match baseline, skip
2. **Hash check**: Compare SHA-256; if identical, skip
3. **Myers diff**: Compute minimal edit script between old and new
4. **Unified format**: Output standard unified diff with context lines

---

## MCP Integration (Experimental)

> **Note**: MCP integration is experimental and may change in future versions.

The Model Context Protocol (MCP) allows you to extend BrilliantCode with external tools and resources.

### Configuration

MCP servers are configured in two locations:

1. **Workspace-level**: `package.json` in your project
2. **User-level**: `~/.brilliantcode/mcp.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `command` | string | Command to spawn the server |
| `args` | string[] | Command arguments |
| `env` | object | Environment variables |
| `cwd` | string | Working directory (relative to workspace) |
| `timeoutMs` | number | Connection timeout (default: 120000) |
| `maxTotalTimeoutMs` | number | Max total timeout window |

### How MCP Tools Are Exposed

MCP tools are namespaced and merged into the agent's available tools:

```
mcp__<server-name>__<tool-name>
```

For example, a GitHub MCP server with a `create_issue` tool becomes:
```
mcp__github__create_issue
```

### Available Resources

MCP servers can also expose resources. BrilliantCode creates a generic resource reader:
```
mcp__<server-name>__read_resource
```

---

## Contributing

We welcome contributions! BrilliantCode is open-source and community-driven.

### Getting Started

1. **Fork and clone** the repository
2. **Install dependencies**: `npm install`
3. **Run in dev mode**: `npm run dev`
4. **Run tests**: `npm test`

### Contribution Process

1. **Open an issue first** - Describe what you want to work on
2. **Discuss the approach** - Get feedback before investing significant time
3. **Create a branch** - Use a descriptive name like `feature/add-tool-x` or `fix/compaction-bug`
4. **Make your changes** - Follow the existing code style
5. **Test thoroughly** - Ensure existing tests pass and add new ones if needed
6. **Submit a PR** - Reference the issue and describe your changes

### Code Style

- TypeScript with strict mode
- Use existing patterns in the codebase
- Keep functions focused and well-documented
- Prefer explicit types over `any`

### Areas for Contribution

- **New tools**: Add capabilities to the agent
- **UI improvements**: Enhance the chat interface
- **Model support**: Add new LLM providers
- **MCP servers**: Create useful MCP server integrations
- **Documentation**: Improve guides and examples
- **Bug fixes**: Help squash issues

### Project Structure

```
src/
├── agent/           # Core agent logic (tools, session, compaction)
├── main/            # Electron main process
├── renderer/        # UI (chat, editor, terminal)
├── preload/         # Electron preload scripts
├── services/        # Shared services (API keys, updates)
└── types/           # TypeScript type definitions
```

---

## Roadmap

### Planned Features

- **Parallel Agent Architecture**: Spin up multiple agents working on subtasks concurrently
- **Sub-agents**: Agents can spin up and delegate work to specialized child agents
- **Anthopic Skills Support**: Use existing ClaudeCode Skills and create new Skills in BrilliantCode
- **Enhanced Sandboxing**: Improved security boundaries for tool execution

### How to Influence the Roadmap

Open an issue or discussion to propose features or vote on existing proposals.


## Troubleshooting

### Common Issues

**`keytar` fails to install**
- Ensure you have native build tooling for Node modules
- macOS: Install Xcode Command Line Tools
- Windows: Install Windows Build Tools

**Missing provider key**
- In `Menu`, open `AI`-> `API Keys...` and set your OpenAI or Anthropic key

**MCP server won't connect**
- Check the command and args in your config
- Ensure the MCP server package is installed
- Check stderr output in the app for error messages

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

❤️ Built with care by [Jennifer Umoke](https://brilliantai.co)
