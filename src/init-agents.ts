import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAgentId, SUPPORTED_AGENT_IDS, type AgentId } from "./agent-ids";
import { remoteAuthorizationHeader, type McpRemote } from "./mcp-remote";

export { isAgentId, SUPPORTED_AGENT_IDS, type AgentId };

/**
 * The directory an agent reads skills from. Internal: users only ever name
 * agents, and several agents share one surface (opencode, github-copilot,
 * windsurf, goose and hermes all read ~/.agents/skills). The id is what a
 * directory's .skillmux marker records as its owner.
 */
export type SurfaceId = "agent-skills" | "claude-code" | "codex" | "antigravity" | "openclaw" | "grok";

export interface DetectedAgent {
  agent: AgentId;
  evidence: string;
}

export type McpRegistrationScope = "user" | "project";

export interface McpRegistrationCommand {
  command: string;
  /** Returns undefined when this agent's CLI has no way to register at the requested scope. */
  buildArgs: (scope: McpRegistrationScope, remote?: McpRemote) => string[] | undefined;
}

interface AgentPathOptions {
  home: string;
  codexHome: string;
}

interface AgentInstructionOptions extends AgentPathOptions {
  claudeConfigDir: string;
}

/**
 * The single source of truth for what each agent supports. Every other
 * module (detection, skill-surface planning, readiness reporting, MCP
 * registration, instruction files, shell completions, CLI help text) reads
 * from this record instead of keeping its own copy — see git history for
 * what it looked like before consolidation (agent support was duplicated
 * across 6+ files and could silently drift, e.g. shell completions offering
 * goose/hermes for `project init` when they can't actually be attached).
 */
interface AgentDefinition {
  id: AgentId;
  /**
   * Every directory the agent reads skills from, in the agent's own
   * precedence order. Planning writes to one of them (see chooseSurface), so
   * an agent that reads several never shows the same pin twice.
   */
  skillDirs: readonly SurfaceId[];
  /** Filesystem evidence used by guided-mode agent detection. */
  detectionPath?: (options: AgentPathOptions) => string;
  instructions?: {
    global?: (options: AgentInstructionOptions) => string;
    project?: (projectRoot: string) => string;
  };
  /**
   * Only set for agents whose own CLI's exact registration command was
   * verified against its own --help, not guessed from docs. Every other
   * agent falls back to printing the registration snippet (see
   * printLastMile in init.ts) rather than a guessed command.
   */
  mcpRegistration?: McpRegistrationCommand;
}

export interface PlannedAgentSurface {
  id: SurfaceId;
  path: string;
  agents: AgentId[];
}

export interface AgentSurfacePlan {
  agents: AgentDefinition[];
  surfaces: PlannedAgentSurface[];
}

type ReadinessStatus = "ready" | "planned" | "manual" | "not-applicable";

export interface ReadinessAxis {
  status: ReadinessStatus;
  detail: string;
}

export interface AgentReadiness {
  agent: AgentId;
  skillSurface: ReadinessAxis;
  mcpRegistration: ReadinessAxis;
  instructionSetup: ReadinessAxis;
}

const AGENTS: Record<AgentId, AgentDefinition> = {
  "claude-code": {
    id: "claude-code",
    skillDirs: ["claude-code"],
    detectionPath: ({ home }) => join(home, ".claude"),
    instructions: {
      global: ({ claudeConfigDir }) => join(claudeConfigDir, "CLAUDE.md"),
      project: (projectRoot) => join(projectRoot, "CLAUDE.md"),
    },
    mcpRegistration: {
      command: "claude",
      // claude mcp add --scope: local (default, unshared), project (writes a
      // committed .mcp.json), or user (global). "project" is the only shared
      // option, so that's what a project-scoped registration means here.
      // For a remote endpoint the header option is variadic, so it has to come
      // after the name and URL or it would take them as header values.
      buildArgs: (scope, remote) => {
        const claudeScope = scope === "project" ? "project" : "user";
        if (remote) {
          return [
            "mcp", "add", "--transport", "http", "-s", claudeScope, "skillmux", remote.url,
            ...(remote.tokenEnv ? ["-H", `Authorization: ${remoteAuthorizationHeader(remote.tokenEnv)}`] : []),
          ];
        }
        return ["mcp", "add", "-s", claudeScope, "skillmux", "--", "skillmux", "serve"];
      },
    },
  },
  codex: {
    id: "codex",
    skillDirs: ["codex"],
    detectionPath: ({ codexHome }) => codexHome,
    instructions: {
      global: ({ codexHome }) => join(codexHome, "AGENTS.md"),
    },
    mcpRegistration: {
      command: "codex",
      // codex mcp add has no --scope flag at all — it always writes to the
      // global ~/.codex/config.toml, so project scope is not representable.
      buildArgs: (scope, remote) => {
        if (scope === "project") return undefined;
        if (remote) {
          return [
            "mcp", "add", "skillmux", "--url", remote.url,
            ...(remote.tokenEnv ? ["--bearer-token-env-var", remote.tokenEnv] : []),
          ];
        }
        return ["mcp", "add", "skillmux", "--", "skillmux", "serve"];
      },
    },
  },
  opencode: {
    id: "opencode",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".config", "opencode"),
    instructions: {
      global: ({ home }) => join(home, ".config", "opencode", "AGENTS.md"),
    },
  },
  "github-copilot": {
    id: "github-copilot",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".config", "github-copilot"),
  },
  windsurf: {
    id: "windsurf",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".codeium", "windsurf"),
  },
  antigravity: {
    id: "antigravity",
    skillDirs: ["antigravity"],
    instructions: {
      global: ({ home }) => join(home, ".gemini", "GEMINI.md"),
    },
  },
  goose: {
    id: "goose",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".config", "goose"),
    instructions: {
      global: ({ home }) => join(home, ".config", "goose", ".goosehints"),
    },
  },
  hermes: {
    id: "hermes",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".hermes"),
    instructions: {
      global: ({ home }) => join(home, ".hermes.md"),
    },
  },
  pi: {
    id: "pi",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".pi", "agent"),
    instructions: {
      global: ({ home }) => join(home, ".pi", "agent", "AGENTS.md"),
    },
    mcpRegistration: {
      command: "pi",
      // pi mcp add writes ~/.pi/agent/mcp.json. Its -l flag writes .pi/mcp.json,
      // but project init's registration is the shared .mcp.json flow, so only
      // user scope is offered. Verified against `pi mcp add --help` (pi 0.99).
      buildArgs: (scope, remote) => {
        if (scope === "project") return undefined;
        if (remote) {
          return [
            "mcp", "add", "skillmux", "--url", remote.url,
            ...(remote.tokenEnv ? ["--bearer-token-env-var", remote.tokenEnv] : []),
          ];
        }
        return ["mcp", "add", "skillmux", "--", "skillmux", "serve"];
      },
    },
  },
  openclaw: {
    id: "openclaw",
    // Its own directory first, then the shared one. Both hold the same skill
    // names, so a pin in each would trigger OpenClaw's precedence rules; the
    // planner writes only the shared directory.
    skillDirs: ["openclaw", "agent-skills"],
    detectionPath: ({ home }) => join(home, ".openclaw"),
  },
  "grok-build": {
    id: "grok-build",
    skillDirs: ["grok"],
    detectionPath: ({ home }) => join(home, ".grok"),
  },
  "deepseek-harness": {
    id: "deepseek-harness",
    skillDirs: ["agent-skills"],
    detectionPath: ({ home }) => join(home, ".dsh"),
  },
};

export function getAgentDefinition(agent: AgentId): AgentDefinition {
  return AGENTS[agent];
}

export function detectInstalledAgents(
  options: {
    home?: string;
    codexHome?: string;
    exists?: (path: string) => boolean;
  } = {},
): DetectedAgent[] {
  const home = options.home ?? homedir();
  const codexHome = options.codexHome ?? join(home, ".codex");
  const exists = options.exists ?? existsSync;
  return SUPPORTED_AGENT_IDS.flatMap((agent) => {
    const evidence = AGENTS[agent].detectionPath?.({ home, codexHome });
    return evidence && exists(evidence) ? [{ agent, evidence }] : [];
  });
}

function surfacePath(
  surfaceId: SurfaceId,
  options: { home: string; codexHome?: string },
): string {
  if (surfaceId === "agent-skills") return join(options.home, ".agents", "skills");
  if (surfaceId === "claude-code") return join(options.home, ".claude", "skills");
  if (surfaceId === "codex") return join(options.codexHome ?? join(options.home, ".codex"), "skills");
  if (surfaceId === "openclaw") return join(options.home, ".openclaw", "skills");
  if (surfaceId === "grok") return join(options.home, ".grok", "skills");
  return join(options.home, ".gemini", "config", "skills");
}

function defaultCodexHome(): string | undefined {
  const value = process.env.CODEX_HOME;
  if (!value) return undefined;
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
}

/**
 * The one directory a pin goes to for this agent. The shared ~/.agents/skills
 * wins whenever the agent reads it, because that covers every other reader of
 * it at once; otherwise the agent's own first directory is used.
 */
function chooseSurface(agent: AgentDefinition): SurfaceId {
  return agent.skillDirs.includes("agent-skills") ? "agent-skills" : agent.skillDirs[0]!;
}

/**
 * Resolves agent ids to the directories sync writes into, one entry per
 * distinct directory. Agents that share a directory collapse into one
 * surface, so ~/.agents/skills is synced once however many of its readers
 * are configured.
 */
export function planAgentSurfaces(
  requestedAgents: readonly string[],
  options: { home?: string; codexHome?: string } = {},
): AgentSurfacePlan {
  const agents = [...new Set(requestedAgents)].map((id) => {
    if (!isAgentId(id)) {
      throw new Error(
        `unsupported agent "${id}"; supported agents: ${SUPPORTED_AGENT_IDS.join(", ")}`,
      );
    }
    return AGENTS[id];
  });
  const home = options.home ?? homedir();
  const codexHome = options.codexHome ?? defaultCodexHome();
  const surfaces = new Map<string, PlannedAgentSurface>();

  for (const agent of agents) {
    const surfaceId = chooseSurface(agent);
    const path = surfacePath(surfaceId, { home, codexHome });
    const existing = surfaces.get(path);
    if (existing) {
      if (!existing.agents.includes(agent.id)) existing.agents.push(agent.id);
      continue;
    }
    surfaces.set(path, { id: surfaceId, path, agents: [agent.id] });
  }

  return { agents, surfaces: [...surfaces.values()] };
}

export function assessAgentReadiness(
  plan: AgentSurfacePlan,
  instructionReadiness: Partial<Record<AgentId, ReadinessAxis>> = {},
): AgentReadiness[] {
  return plan.agents.map((agent) => {
    const surface = plan.surfaces.find((candidate) => candidate.agents.includes(agent.id))!;
    return {
      agent: agent.id,
      skillSurface: { status: "planned", detail: surface.path },
      mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
      instructionSetup: instructionReadiness[agent.id] ?? {
        status: "manual",
        detail: "instruction adapter not applied",
      },
    };
  });
}
