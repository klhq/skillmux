import type { AgentId } from "./init-agents";

interface McpRegistrationCommand {
  command: string;
  args: string[];
}

/**
 * Agents with their own official CLI for registering an MCP server — letting
 * the agent's own tool own its config schema is safer than skillmux hand-
 * writing it. Scope is deliberately narrow: only agents where the exact
 * command was verified against the installed CLI's own --help, not guessed
 * from docs. Other agents fall back to printing the registration snippet
 * (see printLastMile in init.ts) rather than a guessed command.
 */
const MCP_REGISTRATION_COMMANDS: Partial<Record<AgentId, McpRegistrationCommand>> = {
  "claude-code": {
    command: "claude",
    args: ["mcp", "add", "-s", "user", "skillmux", "--", "skillmux", "serve"],
  },
  codex: {
    command: "codex",
    args: ["mcp", "add", "skillmux", "--", "skillmux", "serve"],
  },
};

export const MCP_REGISTRABLE_AGENTS = Object.keys(
  MCP_REGISTRATION_COMMANDS,
) as AgentId[];

export function isMcpRegistrable(agent: AgentId): boolean {
  return agent in MCP_REGISTRATION_COMMANDS;
}

export interface McpRegistrationResult {
  agent: AgentId;
  ok: boolean;
  error?: string;
}

type SpawnFn = (cmd: string[]) => {
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
  options: { spawn?: SpawnFn } = {},
): Promise<McpRegistrationResult> {
  const entry = MCP_REGISTRATION_COMMANDS[agent];
  if (!entry) {
    return {
      agent,
      ok: false,
      error: `no MCP registration command known for agent "${agent}"`,
    };
  }
  const spawn: SpawnFn =
    options.spawn ??
    ((cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }));
  try {
    const proc = spawn([entry.command, ...entry.args]);
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
