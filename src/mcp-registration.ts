import type { AgentId } from "./init-agents";

export type McpRegistrationScope = "user" | "project";

interface McpRegistrationCommand {
  command: string;
  /** Returns undefined when this agent's CLI has no way to register at the requested scope. */
  buildArgs: (scope: McpRegistrationScope) => string[] | undefined;
}

/**
 * Agents with their own official CLI for registering an MCP server — letting
 * the agent's own tool own its config schema is safer than skillmux hand-
 * writing it. Scope is deliberately narrow: only agents where the exact
 * command was verified against the installed CLI's own --help, not guessed
 * from docs. Other agents fall back to printing the registration snippet
 * (see printLastMile in init.ts) rather than a guessed command.
 *
 * "project" scope is resolved by the agent's own CLI relative to its current
 * working directory, so a project-scoped call must be spawned with cwd set
 * to the target project directory (see the `cwd` option below).
 */
const MCP_REGISTRATION_COMMANDS: Partial<Record<AgentId, McpRegistrationCommand>> = {
  "claude-code": {
    command: "claude",
    // claude mcp add --scope: local (default, unshared), project (writes a
    // committed .mcp.json), or user (global). "project" is the only shared
    // option, so that's what a project-scoped registration means here.
    buildArgs: (scope) => [
      "mcp",
      "add",
      "-s",
      scope === "project" ? "project" : "user",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ],
  },
  codex: {
    command: "codex",
    // codex mcp add has no --scope flag at all — it always writes to the
    // global ~/.codex/config.toml, so project scope is not representable.
    buildArgs: (scope) =>
      scope === "project"
        ? undefined
        : ["mcp", "add", "skillmux", "--", "skillmux", "serve"],
  },
};

export const MCP_REGISTRABLE_AGENTS = Object.keys(
  MCP_REGISTRATION_COMMANDS,
) as AgentId[];

export const MCP_PROJECT_REGISTRABLE_AGENTS = MCP_REGISTRABLE_AGENTS.filter(
  (agent) => MCP_REGISTRATION_COMMANDS[agent]!.buildArgs("project") !== undefined,
);

export function isMcpRegistrable(agent: AgentId): boolean {
  return agent in MCP_REGISTRATION_COMMANDS;
}

export interface McpRegistrationResult {
  agent: AgentId;
  ok: boolean;
  error?: string;
}

type SpawnFn = (
  cmd: string[],
  opts?: { cwd?: string },
) => {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | number;
};

/**
 * Runs the agent's own CLI to register skillmux as an MCP server. Never
 * throws — registration failure (tool not installed, command rejected,
 * etc.) is reported in the result, not fatal to the caller's larger flow.
 */
export async function registerMcpServer(
  agent: AgentId,
  options: {
    spawn?: SpawnFn;
    scope?: McpRegistrationScope;
    cwd?: string;
  } = {},
): Promise<McpRegistrationResult> {
  const entry = MCP_REGISTRATION_COMMANDS[agent];
  const scope = options.scope ?? "user";
  const args = entry?.buildArgs(scope);
  if (!entry || !args) {
    return {
      agent,
      ok: false,
      error: `no ${scope === "project" ? "project-scoped " : ""}MCP registration command known for agent "${agent}"`,
    };
  }
  const spawn: SpawnFn =
    options.spawn ??
    ((cmd, opts) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd }));
  try {
    const proc = spawn([entry.command, ...args], { cwd: options.cwd });
    const stderrText =
      typeof proc.stderr === "number"
        ? ""
        : await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return {
        agent,
        ok: false,
        error:
          stderrText.trim() || `${entry.command} exited with code ${exitCode}`,
      };
    }
    return { agent, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notFound = /ENOENT|not found|no such file/i.test(message);
    return {
      agent,
      ok: false,
      error: notFound
        ? `"${entry.command}" is not installed or not on PATH`
        : message,
    };
  }
}
