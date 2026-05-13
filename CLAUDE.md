# CLAUDE.md — claude-tunnel project context

This file is auto-loaded into every Claude Code session in this repo.

---

## What this is

`claude-tunnel` is an MCP server that lets one Claude Code session delegate questions to a Claude running on a different local project. The target Claude is spawned on demand via `@anthropic-ai/claude-agent-sdk` with its `cwd` pointed at the target project, loads that project's `CLAUDE.md` and memory, answers, and the reply flows back inside the calling tool turn.

Conversations are persistent per project — session IDs are stored in `~/.claude-tunnel/sessions.json` and resumed on subsequent calls until reset.

## How it works

```
┌──────────────────────────┐
│  Caller (any MCP client) │
│         │                │
│         ▼                │
│  mcp__claude-tunnel__    │
│  ask_project(            │   stdio JSON-RPC
│    project: "<key>",     │ ───────────────► claude-tunnel-mcp (node)
│    prompt: "..."         │                  │
│  )                       │                  │  reads ~/.claude-tunnel/projects.json
│                          │                  │  reads ~/.claude-tunnel/sessions.json
│                          │                  ▼
│                          │           Agent SDK query()
│                          │           cwd = project.path
│                          │           settingSources = [user, project]
│                          │           resume = saved session_id
│                          │                  │
│                          │                  ▼
│                          │           Subagent spawns in target project,
│                          │           loads its CLAUDE.md + memory + code,
│                          │           answers, returns SDKResultMessage
│                          │                  │
│         ◄────────────────┴──────────────────┘
│  reply text + new session_id (saved for next call)
└──────────────────────────┘
```

## Tools the MCP server exposes

| Tool | Purpose |
|---|---|
| `mcp__claude-tunnel__ask_project(project, prompt, reset?)` | Delegate to another project's Claude. Sessions persist per project unless `reset: true`. |
| `mcp__claude-tunnel__list_projects()` | Show configured projects with paths and current session IDs. |
| `mcp__claude-tunnel__add_project(name, path, model?, additionalDirectories?, allowedTools?, disallowedTools?, overwrite?)` | Register a new project. Validates the path exists. |
| `mcp__claude-tunnel__remove_project(name)` | Unregister a project and clear its saved session. |
| `mcp__claude-tunnel__reset_project_session(project)` | Drop the saved session ID for one project (next call starts fresh). |

## Layout on disk

- **Repo root IS the MCP server.** TypeScript, ESM, stdio. Entry [`src/index.ts`](src/index.ts) → built to `dist/index.js`. The package.json with the `bin` entry is at the root so `npx github:<owner>/claude-tunnel` works.
- **Per-user config:** `~/.claude-tunnel/projects.json` — `{ "projects": { "<key>": { "path": "...", "model": "...", "additionalDirectories": [...], "allowedTools": [...], "disallowedTools": [...] } } }`. Re-read on every call (no MCP-server restart needed when adding/editing projects).
- **Per-user state:** `~/.claude-tunnel/sessions.json` — auto-managed, written after every `ask_project` call. Holds the resumable `session_id` per project.
- **Registration:** the MCP server is registered at user scope in `~/.claude.json` under `mcpServers.claude-tunnel`. On a dev machine that points at the local build (`command: node`, `args: ["/abs/path/to/claude-tunnel/dist/index.js"]`). On a fresh install the recipe in the README uses `command: npx, args: ["-y", "github:<owner>/claude-tunnel"]` which clones+builds on first run.

## Deliberate defaults — don't change without discussion

- `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`. The subagent runs unattended; without bypass it would hang on the first permission prompt. To lock a project down, prefer per-project `disallowedTools` in `projects.json` over flipping the global mode.
- `settingSources: ['user', 'project']`. The `'project'` element is **required** — Agent-SDK Options docs say it must be present to load CLAUDE.md. Never pass `[]` here; that disables CLAUDE.md and breaks the whole point of the tool.
- Sessions are persistent per project. Resumed via stored `session_id`. Use `reset_project_session` or pass `reset: true` to start fresh.
- `additionalDirectories` is forwarded from project config to the SDK — lets one tunnel target reach sibling repos (e.g. a docs workspace that needs the actual code from a sibling directory).

## After changing `src/index.ts`

1. `npm run build`
2. **Reload every open VSCode window** (Ctrl+Shift+P → *Developer: Reload Window*). Already-running Claude Code sessions hold an old MCP-server child process; only a reload spawns the rebuilt one. `projects.json` changes don't have this issue — they're re-read on every call.

## Don't

- Don't tell the user "claude-tunnel isn't built yet" or fall back to manual file reads / synthesized agent calls when the MCP tools exist. If they don't appear in the toolbox, the right answer is "this Claude Code window pre-dates the MCP registration; reload the window."
- Don't add a server / daemon / cloud component. This is local-only by design.
- Don't ship telemetry / analytics. Single-user developer tool, zero phone-home.
- Don't try to inject into another Claude Code session via DOM manipulation, accessibility hacks, or VSCode-extension chat-input tricks. The Agent SDK subagent approach deliberately sidesteps that whole area.
