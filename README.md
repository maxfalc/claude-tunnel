# claude-tunnel

A simple MCP server for people who work with [Claude Code](https://claude.com/claude-code) in VSCode and need their Claude sessions to talk to each other.

When you have two projects open in two VSCode windows, Claude in window A doesn't know anything about project B. claude-tunnel fixes that — Claude in window A can delegate a question to a Claude running on project B, that Claude loads B's `CLAUDE.md` and codebase, answers, and the reply flows back into window A's chat in the same turn.

It's an MCP server, so technically it works with any MCP-compatible client (Cursor, Zed, claude.ai with MCP connectors, custom clients). In practice it's built for and tested against Claude Code in VSCode.

## What it gives you

A handful of tools your Claude sessions can call:

| Tool | What it does |
|---|---|
| `ask_project(project, prompt, reset?)` | Delegate a question to a Claude running on another local project. Persistent conversation per project unless `reset: true`. |
| `list_projects()` | Show all configured projects and their current session IDs. |
| `add_project(name, path, model?, additionalDirectories?, allowedTools?, disallowedTools?, overwrite?)` | Register a new project. Validates that the path exists. |
| `remove_project(name)` | Unregister a project and clear its saved session. |
| `reset_project_session(project)` | Start a fresh conversation thread for one project (keeps the project configured). |

## Install

### On a new machine

You need: Node ≥18 and Claude Code installed and authenticated.

Run this in any terminal:

**macOS / Linux:**

```sh
npx -y github:maxfalc/claude-tunnel install
```

**Windows (PowerShell, cmd, or git-bash):**

```powershell
npx.cmd -y github:maxfalc/claude-tunnel install
```

(On Windows, `npx.cmd` is the safer form — bare `npx` resolves to `npx.ps1` in PowerShell, which can be blocked by execution policy on locked-down machines. `npx.cmd` works in every Windows terminal.)

The installer detects your OS, writes the right entry into `~/.claude.json` (using `npx.cmd` on Windows, `npx` elsewhere — yes, that distinction matters for how Claude Code spawns the server), and tells you what to do next. The first call takes ~30 seconds while npx clones the repo and builds `dist/`. Subsequent invocations are fast.

After installing, reload your VSCode window (Ctrl+Shift+P → *Developer: Reload Window*). The five tools then appear as `mcp__claude-tunnel__*`.

To remove the registration later:

```sh
npx -y github:maxfalc/claude-tunnel install --uninstall
```

(Use `npx.cmd` instead of `npx` on Windows for the same reason as above.)

### Manual registration (if you prefer)

If you'd rather edit `~/.claude.json` by hand, add:

```json
"mcpServers": {
  "claude-tunnel": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "github:maxfalc/claude-tunnel"]
  }
}
```

**Windows note:** change `"command": "npx"` to `"command": "npx.cmd"`. Windows requires the file extension when Claude Code spawns the MCP server without a shell wrapper — affects users of `fnm`, `nvm-windows`, and most standard Node installs. The `install` subcommand above handles this for you automatically.

You can also use the `claude` CLI if you have it:

```sh
claude mcp add --scope user claude-tunnel npx -- -y github:maxfalc/claude-tunnel
```

### From source (local development)

```sh
git clone https://github.com/maxfalc/claude-tunnel.git
cd claude-tunnel
npm install     # builds automatically via the prepare script
```

Then point your `~/.claude.json` at the local `dist/index.js`:

```json
"mcpServers": {
  "claude-tunnel": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/claude-tunnel/dist/index.js"]
  }
}
```

After editing `src/index.ts`, run `npm run build` and reload every VSCode window — already-running Claude Code sessions hold an old MCP server child process.

## Configure projects

Project configuration lives in `~/.claude-tunnel/projects.json`. The file is re-read on every call, so adding a project doesn't require restarting anything.

You can edit it by hand:

```json
{
  "projects": {
    "frontend": {
      "path": "/absolute/path/to/frontend",
      "model": "claude-opus-4-7"
    },
    "backend": {
      "path": "/absolute/path/to/backend-workspace",
      "model": "claude-opus-4-7",
      "additionalDirectories": ["/absolute/path/to/backend-core"]
    }
  }
}
```

On Windows, paths look like `"c:\\code\\my-app"` (double backslashes inside JSON strings).

Or, easier, just tell Claude:

> *"add a tunnel project called `my-app` at `~/code/my-app` using claude-opus-4-7"*

Claude will call `add_project` for you.

Per-project fields:

| Field | Required | Description |
|---|---|---|
| `path` | yes | Absolute path to the project directory. The subagent's `cwd`. |
| `model` | no | Anthropic model id (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, etc.) Omit to use Claude Code's default. |
| `additionalDirectories` | no | Extra absolute paths the subagent can read/edit. Useful when your workspace points at a docs folder but the code lives in a sibling directory. |
| `allowedTools` | no | Whitelist of tool names (e.g. `["Read","Grep","Glob"]`). Restricts what the subagent can do. |
| `disallowedTools` | no | Blacklist (e.g. `["Write","Edit","Bash"]`). Easier than whitelisting when you want default behavior minus a few risky tools. |

## How it works

```
┌──────────────────────────┐
│  Caller (any session)    │
│       │                  │
│       ▼                  │
│  mcp__claude-tunnel__    │
│  ask_project(            │   stdio JSON-RPC
│    project: "backend",   │ ────────────►  claude-tunnel-mcp (node)
│    prompt: "..."         │                │
│  )                       │                │  reads ~/.claude-tunnel/projects.json
│                          │                │  reads ~/.claude-tunnel/sessions.json
│                          │                ▼
│                          │         Agent SDK query()
│                          │         cwd = project.path
│                          │         settingSources = [user, project]
│                          │         resume = saved session_id
│                          │                │
│                          │                ▼
│                          │         Subagent spawns in target project,
│                          │         loads its CLAUDE.md + memory + code,
│                          │         answers, returns SDKResultMessage
│                          │                │
│       ◄──────────────────┴────────────────┘
│  reply text + new session_id
│  (saved for next call)
└──────────────────────────┘
```

- The server is a stdio MCP server (TypeScript, ESM, Node ≥18) using `@modelcontextprotocol/sdk`.
- When `ask_project` is called, it uses `@anthropic-ai/claude-agent-sdk` `query()` with `cwd` set to the target project's path and `settingSources: ['user', 'project']` so the target's `CLAUDE.md` and user-scope memory both load.
- Session IDs are persisted in `~/.claude-tunnel/sessions.json` so subsequent calls resume the same thread. Use `reset_project_session` or pass `reset: true` to start fresh.
- By default the subagent runs with `permissionMode: 'bypassPermissions'` so it doesn't hang waiting for unattended approvals. Restrict specific projects via `disallowedTools` in `projects.json`.

## Examples

You don't need to memorize tool names — Claude introspects the server. Start with:

> *"what claude-tunnel tools do I have available?"*
>
> *"list my configured tunnel projects"*

Once you have two projects configured (let's call them `frontend` and `backend`), the natural uses look like:

> *"ask the backend project for a one-sentence summary from its CLAUDE.md"*
>
> *"ask the backend to show me the directory structure under src/api"*
>
> *"ask the frontend how its data model differs from the backend's and cite specific files"*
>
> *"reset the backend session, then ask it fresh: what's the latest in src/api/handlers?"*
>
> *"add a tunnel project called `my-app` at `~/code/my-app` using claude-opus-4-7"*

The persistent session per project means follow-up questions stay coherent — Claude in the target project remembers the prior turns.

## Limitations

- **Not real-time bidirectional**: this is delegation, not chat. Your local Claude calls `ask_project`, the target Claude answers in one turn, the reply comes back. There's no ambient chat thread between two interactive sessions.
- **One question per call**: the target subagent runs to completion before the result returns. For long investigations this can take 30s–2min. There's no progress streaming today.
- **State is per-machine**: `~/.claude-tunnel/projects.json` and `sessions.json` are local. Sessions don't sync across machines.
- **Auth is whatever the host machine has**: the Agent SDK uses Claude Code's local authentication. You don't pass keys to claude-tunnel directly.

## What this is not

- Not a daemon, not a network service, not a cloud component. The tunnel is entirely local. No phone-home.
- Not a way to inject prompts into another VSCode window's running Claude session — that's a separate problem with no documented public API. claude-tunnel sidesteps it by spawning a fresh Agent SDK subagent on demand instead.

## License

MIT — see [LICENSE](LICENSE).
