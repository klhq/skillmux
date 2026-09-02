import {
  getAgentDefinition,
  SUPPORTED_AGENT_IDS,
  type AgentId,
  type McpRegistrationScope,
} from "./init-agents";

export type { McpRegistrationScope };

export const MCP_REGISTRABLE_AGENTS = SUPPORTED_AGENT_IDS.filter(
  (agent) => getAgentDefinition(agent).mcpRegistration !== undefined,
);

export const MCP_PROJECT_REGISTRABLE_AGENTS = MCP_REGISTRABLE_AGENTS.filter(
  (agent) => getAgentDefinition(agent).mcpRegistration!.buildArgs("project") !== undefined,
);

export function isMcpRegistrable(agent: AgentId): boolean {
  return getAgentDefinition(agent).mcpRegistration !== undefined;
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
  const entry = getAgentDefinition(agent).mcpRegistration;
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
