#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const CONFIG_DIR = process.env.CLAUDE_TUNNEL_DIR ?? path.join(os.homedir(), '.claude-tunnel');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

type ProjectConfig = {
    path: string;
    model?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    additionalDirectories?: string[];
};

type ProjectsFile = { projects: Record<string, ProjectConfig> };
type SessionsFile = { sessions: Record<string, string> };

async function readJson<T>(file: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
        throw e;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

const loadProjects = () => readJson<ProjectsFile>(PROJECTS_FILE, { projects: {} });
const loadSessions = () => readJson<SessionsFile>(SESSIONS_FILE, { sessions: {} });

async function saveSession(project: string, sessionId: string): Promise<void> {
    const f = await loadSessions();
    f.sessions[project] = sessionId;
    await writeJson(SESSIONS_FILE, f);
}

async function clearSession(project: string): Promise<void> {
    const f = await loadSessions();
    delete f.sessions[project];
    await writeJson(SESSIONS_FILE, f);
}

const server = new McpServer({ name: 'claude-tunnel', version: '0.0.1' });

server.registerTool(
    'ask_project',
    {
        title: "Ask another project's Claude",
        description:
            "Delegate a question to a Claude session running on another local project directory. The subagent loads that project's CLAUDE.md and codebase, answers, and returns. Conversations are persistent per project — subsequent calls resume the same thread until reset.",
        inputSchema: {
            project: z.string().describe('Project key from ~/.claude-tunnel/projects.json (e.g. "afc")'),
            prompt: z.string().describe('Question or instruction for the other Claude'),
            reset: z
                .boolean()
                .optional()
                .describe('If true, start a fresh conversation instead of resuming the saved session'),
        },
    },
    async ({ project, prompt, reset }) => {
        const projects = await loadProjects();
        const cfg = projects.projects[project];
        if (!cfg) {
            const known = Object.keys(projects.projects).join(', ') || '<none configured>';
            return {
                content: [
                    {
                        type: 'text',
                        text: `Unknown project "${project}". Configured: ${known}. Edit ${PROJECTS_FILE} to add it.`,
                    },
                ],
                isError: true,
            };
        }

        if (reset) await clearSession(project);
        const sessions = await loadSessions();
        const resumeId = sessions.sessions[project];

        let resultText: string | undefined;
        let newSessionId: string | undefined;
        let errorMessage = '';

        try {
            const q = query({
                prompt,
                options: {
                    cwd: cfg.path,
                    settingSources: ['user', 'project'],
                    model: cfg.model,
                    resume: resumeId,
                    permissionMode: 'bypassPermissions',
                    allowDangerouslySkipPermissions: true,
                    allowedTools: cfg.allowedTools,
                    disallowedTools: cfg.disallowedTools,
                    additionalDirectories: cfg.additionalDirectories,
                },
            });

            for await (const msg of q) {
                if (msg.type === 'result') {
                    newSessionId = msg.session_id;
                    if (msg.subtype === 'success') {
                        resultText = msg.result;
                    } else {
                        const errs = msg.errors?.length ? ' — ' + msg.errors.join('; ') : '';
                        errorMessage = `Subagent error (${msg.subtype})${errs}`;
                    }
                    break;
                }
            }
        } catch (err: unknown) {
            errorMessage = `Subagent threw: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (newSessionId) await saveSession(project, newSessionId);

        if (errorMessage) {
            return { content: [{ type: 'text', text: errorMessage }], isError: true };
        }

        return {
            content: [{ type: 'text', text: resultText ?? '(no reply)' }],
            structuredContent: {
                reply: resultText ?? '',
                sessionId: newSessionId ?? '',
                project,
            },
        };
    }
);

server.registerTool(
    'list_projects',
    {
        title: 'List configured tunnel projects',
        description: 'Returns the projects available for ask_project, with their paths and current session IDs.',
        inputSchema: {},
    },
    async () => {
        const projects = await loadProjects();
        const sessions = await loadSessions();
        const lines = Object.entries(projects.projects).map(([name, cfg]) => {
            const sid = sessions.sessions[name];
            const tail = sid ? `[session ${sid.slice(0, 8)}…]` : '[no session]';
            const model = cfg.model ? ` (${cfg.model})` : '';
            return `- ${name} → ${cfg.path}${model} ${tail}`;
        });
        const body = lines.length ? lines.join('\n') : `No projects configured. Edit ${PROJECTS_FILE}.`;
        return { content: [{ type: 'text', text: body }] };
    }
);

server.registerTool(
    'add_project',
    {
        title: 'Add or update a tunnel project',
        description:
            'Register a new project that can be targeted by ask_project. Persists to ~/.claude-tunnel/projects.json. Errors if the project name already exists unless overwrite is true.',
        inputSchema: {
            name: z
                .string()
                .describe('Project key, e.g. "afc" or "my-server" — what you pass as `project` to ask_project'),
            path: z.string().describe('Absolute path to the project directory'),
            model: z
                .string()
                .optional()
                .describe('Anthropic model id, e.g. "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"'),
            additionalDirectories: z
                .array(z.string())
                .optional()
                .describe('Extra absolute paths the subagent can read/edit alongside the main path'),
            allowedTools: z
                .array(z.string())
                .optional()
                .describe('Whitelist of tool names (e.g. ["Read","Grep","Glob"]). Restricts the subagent.'),
            disallowedTools: z
                .array(z.string())
                .optional()
                .describe('Blacklist of tool names (e.g. ["Write","Edit","Bash"]).'),
            overwrite: z.boolean().optional().describe('Replace an existing entry with the same name (default false)'),
        },
    },
    async ({ name, path: projPath, model, additionalDirectories, allowedTools, disallowedTools, overwrite }) => {
        try {
            const stat = await fs.stat(projPath);
            if (!stat.isDirectory()) {
                return {
                    content: [{ type: 'text', text: `Path is not a directory: ${projPath}` }],
                    isError: true,
                };
            }
        } catch {
            return {
                content: [{ type: 'text', text: `Path does not exist or is unreadable: ${projPath}` }],
                isError: true,
            };
        }

        const projects = await loadProjects();
        const existed = !!projects.projects[name];
        if (existed && !overwrite) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Project "${name}" already exists. Pass overwrite: true to replace, or remove_project("${name}") first.`,
                    },
                ],
                isError: true,
            };
        }

        const entry: ProjectConfig = { path: projPath };
        if (model) entry.model = model;
        if (additionalDirectories?.length) entry.additionalDirectories = additionalDirectories;
        if (allowedTools?.length) entry.allowedTools = allowedTools;
        if (disallowedTools?.length) entry.disallowedTools = disallowedTools;

        projects.projects[name] = entry;
        await writeJson(PROJECTS_FILE, projects);

        return {
            content: [{ type: 'text', text: `${existed ? 'Updated' : 'Added'} project "${name}" → ${projPath}` }],
        };
    }
);

server.registerTool(
    'remove_project',
    {
        title: 'Remove a tunnel project',
        description: 'Unregister a project from ~/.claude-tunnel/projects.json. Also clears any saved session for it.',
        inputSchema: { name: z.string().describe('Project key to remove') },
    },
    async ({ name }) => {
        const projects = await loadProjects();
        if (!projects.projects[name]) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No project named "${name}". Use list_projects to see configured projects.`,
                    },
                ],
                isError: true,
            };
        }
        delete projects.projects[name];
        await writeJson(PROJECTS_FILE, projects);
        await clearSession(name);
        return { content: [{ type: 'text', text: `Removed project "${name}" and cleared its saved session.` }] };
    }
);

server.registerTool(
    'reset_project_session',
    {
        title: 'Reset tunnel session for a project',
        description: 'Forgets the saved session ID for a project so the next ask_project call starts a fresh conversation.',
        inputSchema: { project: z.string().describe('Project key') },
    },
    async ({ project }) => {
        await clearSession(project);
        return { content: [{ type: 'text', text: `Session for "${project}" reset.` }] };
    }
);

async function runInstaller(argv: string[]): Promise<void> {
    let configPath = path.join(os.homedir(), '.claude.json');
    let remove = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--config' && argv[i + 1]) {
            configPath = argv[i + 1];
            i++;
        } else if (a === '--uninstall') {
            remove = true;
        } else if (a === '--help' || a === '-h') {
            console.log(`Usage:
  claude-tunnel-mcp install [--config <path>]    Register the MCP server in ~/.claude.json (or a custom path)
  claude-tunnel-mcp install --uninstall          Remove the mcpServers.claude-tunnel entry
  claude-tunnel-mcp                              Run the MCP server (default; spawned by Claude Code)`);
            return;
        }
    }

    const isWin = process.platform === 'win32';
    const command = isWin ? 'npx.cmd' : 'npx';
    const args = ['-y', 'github:maxfalc/claude-tunnel'];

    let config: Record<string, unknown> = {};
    try {
        const raw = await fs.readFile(configPath, 'utf8');
        config = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            console.error(`[claude-tunnel install] could not read ${configPath}: ${(e as Error).message}`);
            process.exit(1);
        }
    }

    const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    const existed = 'claude-tunnel' in mcpServers;

    if (remove) {
        if (!existed) {
            console.log(`[claude-tunnel install] no existing claude-tunnel entry in ${configPath}; nothing to remove.`);
            return;
        }
        delete mcpServers['claude-tunnel'];
        config.mcpServers = mcpServers;
        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
        console.log(`[claude-tunnel install] removed claude-tunnel from ${configPath}`);
        console.log(`Reload your VSCode window for the change to take effect.`);
        return;
    }

    mcpServers['claude-tunnel'] = { type: 'stdio', command, args };
    config.mcpServers = mcpServers;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    console.log(`[claude-tunnel install] ${existed ? 'updated' : 'added'} claude-tunnel in ${configPath}`);
    console.log(`  platform: ${process.platform}`);
    console.log(`  command:  ${command} ${args.join(' ')}`);
    console.log(``);
    console.log(`Next steps:`);
    console.log(`  1. Reload your VSCode window: Ctrl+Shift+P → "Developer: Reload Window"`);
    console.log(`  2. In any Claude Code chat, try: "list my configured tunnel projects"`);
    console.log(`  3. If empty, add one: "add a tunnel project called my-app at /abs/path/to/my-app"`);
}

async function runServer(): Promise<void> {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    try {
        await fs.access(PROJECTS_FILE);
    } catch {
        await writeJson(PROJECTS_FILE, { projects: {} } satisfies ProjectsFile);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

async function main(): Promise<void> {
    const subcommand = process.argv[2];
    if (subcommand === 'install') {
        await runInstaller(process.argv.slice(3));
        return;
    }
    if (subcommand === '--help' || subcommand === '-h') {
        console.log(`claude-tunnel MCP server

Usage:
  claude-tunnel-mcp                              Run the MCP server over stdio (default)
  claude-tunnel-mcp install [--config <path>]    Register the MCP server in ~/.claude.json
  claude-tunnel-mcp install --uninstall          Remove the registration

The server is normally not run by hand — Claude Code spawns it.
The install subcommand is the one you run interactively, once per machine.`);
        return;
    }
    await runServer();
}

main().catch((err) => {
    console.error('[claude-tunnel-mcp] fatal:', err);
    process.exit(1);
});
