import { expandHome } from "../config";
import { printLastMile } from "../init";
import {
  detectInstalledAgents,
  planAgentSurfaces,
  SUPPORTED_AGENT_IDS,
  type AgentId,
} from "../init-agents";
import { applyInstructionPlan, planInstructionSetup } from "../init-instructions";
import type { McpRemote } from "../mcp-remote";
import { MCP_REGISTRABLE_AGENTS, registerMcpServer, type McpRegistrationResult } from "../mcp-registration";
import { dryRunTag, isInteractive } from "../output";
import { promptMultiSelect } from "../prompts";
import { confirmAction } from "./shared";

export interface RemoteOnlyInitOptions {
  agents: string[];
  remote: McpRemote;
  showMcpSetup: boolean;
  skipInstructions: boolean;
  yes: boolean;
  guided: boolean;
  isJson: boolean;
  dryRun: boolean;
}

/**
 * Client setup for a machine that has no vault and pins no skills: it only
 * reaches a shared HTTP server. There is no config file, vault or skill
 * directory to touch. The run writes the instruction block that teaches an
 * agent to call resolve_skill and fetch_skill, and registers the HTTP endpoint
 * with each agent whose CLI has a verified registration command. Any other
 * agent gets the snippet to paste.
 */
export async function runInitRemoteOnly(options: RemoteOnlyInitOptions): Promise<{ payload: unknown } | undefined> {
  const { remote, isJson } = options;
  const codexHome = process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined;
  planAgentSurfaces(options.agents);

  let selected = options.agents;
  if (options.guided) {
    const detected = new Map(detectInstalledAgents({ codexHome }).map((item) => [item.agent, item.evidence]));
    selected = await promptMultiSelect(
      "Which agents should use the shared server?",
      SUPPORTED_AGENT_IDS.map((agent) => ({
        value: agent,
        label: agent,
        detail: detected.has(agent) ? `detected: ${detected.get(agent)}` : undefined,
        selected: detected.has(agent) || options.agents.includes(agent),
      })),
    );
  }
  const agents = planAgentSurfaces(selected, { codexHome }).agents.map((agent) => agent.id) as AgentId[];
  const registrable = agents.filter((agent) => MCP_REGISTRABLE_AGENTS.includes(agent));
  const manual = agents.filter((agent) => !MCP_REGISTRABLE_AGENTS.includes(agent));

  // Same rule as a local setup: the instruction block mentions MCP tools, so it
  // only goes to agents that get the server this run or whose snippet was requested.
  const instructionAgents = options.showMcpSetup ? agents : registrable;
  const instructionPlan = planInstructionSetup(options.skipInstructions ? [] : instructionAgents, { codexHome });
  const pending = instructionPlan.changes.filter((change) => change.status !== "unchanged");

  const plan = {
    mode: "remote-only",
    vault_path: null,
    mcp_url: remote.url,
    mcp_token_env: remote.tokenEnv ?? null,
    agents,
    instructions: instructionPlan.changes.map(({ path, agents: changed, status }) => ({ path, agents: changed, status })),
    manual: instructionPlan.manual,
    register_mcp_for: registrable,
    snippet_for: manual,
  };

  if (!isJson) {
    console.log(`remote MCP server: ${remote.url}${remote.tokenEnv ? ` (token from $${remote.tokenEnv})` : " (no token)"}`);
    console.log("no local vault: nothing is pinned or synced on this machine");
    for (const change of instructionPlan.changes) {
      console.log(`instructions ${change.status}: ${change.path} (${change.agents.join(", ")})`);
    }
    for (const entry of instructionPlan.manual) console.log(`instructions manual: ${entry.agent} - ${entry.reason}`);
  }

  if (agents.length === 0 && !options.showMcpSetup) {
    if (isJson) return { payload: { phase: "plan", applied: false, plan } };
    console.log("\nno agents selected; nothing written. Pass --agent <name>, or --show-mcp-setup for the snippet.");
    return undefined;
  }

  if (options.dryRun) {
    if (isJson) return { payload: { phase: "plan", applied: false, dry_run: true, plan } };
    console.log(
      `\n${pending.length} instruction file(s), MCP registration: ${registrable.join(", ") || "(none)"} ${dryRunTag()}`,
    );
    return undefined;
  }

  if (!options.yes) {
    if (isJson || !isInteractive()) {
      throw new Error("skillmux init requires --yes before applying instruction changes or registering MCP non-interactively");
    }
    const prompts = [
      ...pending.map((change) => `${change.status} instruction file ${change.path}?`),
      ...registrable.map((agent) => `register ${remote.url} as an MCP server for ${agent}?`),
    ];
    for (const prompt of prompts) {
      if (!(await confirmAction(prompt))) {
        console.log("init cancelled; nothing written");
        return undefined;
      }
    }
  }

  if (pending.length > 0) applyInstructionPlan(instructionPlan);
  const registrations: McpRegistrationResult[] = [];
  for (const agent of registrable) registrations.push(await registerMcpServer(agent, { remote }));

  if (isJson) {
    return {
      payload: {
        phase: "result",
        applied: true,
        plan,
        result: {
          instructions_changed: pending.map((change) => change.path),
          mcp_registrations: registrations,
        },
      },
    };
  }
  for (const registration of registrations) {
    console.log(
      registration.ok
        ? `registered the shared server as an MCP server for ${registration.agent}`
        : `failed to register the shared server for ${registration.agent}: ${registration.error}`,
    );
  }
  if (manual.length > 0 || options.showMcpSetup || agents.length === 0) {
    if (manual.length > 0) console.log(`\n${manual.join(", ")} cannot be registered by skillmux; add this yourself:`);
    console.log(`\n${printLastMile(remote)}`);
  }
  return undefined;
}
