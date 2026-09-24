import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUPPORTED_AGENT_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "github-copilot",
  "windsurf",
  "antigravity",
  "goose",
  "hermes",
] as const;

export type AgentId = (typeof SUPPORTED_AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (SUPPORTED_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * The directory an agent reads skills from. Internal: users only ever name
 * agents, and several agents share one surface (opencode, github-copilot,
 * windsurf, goose and hermes all read ~/.agents/skills). The id is what a
 * directory's .skillmux marker records as its owner.
 */
export type SurfaceId = "agent-skills" | "claude-code" | "codex" | "antigravity";

export interface DetectedAgent {
  agent: AgentId;
  evidence: string;
}

export type McpRegistrationScope = "user" | "project";

export interface McpRegistrationCommand {
  command: string;
  /** Returns undefined when this agent's CLI has no way to register at the requested scope. */
  buildArgs: (scope: McpRegistrationScope) => string[] | undefined;
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
  surfaceId: SurfaceId;
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
    surfaceId: "claude-code",
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
  },
  codex: {
    id: "codex",
    surfaceId: "codex",
    detectionPath: ({ codexHome }) => codexHome,
    instructions: {
      global: ({ codexHome }) => join(codexHome, "AGENTS.md"),
    },
    mcpRegistration: {
      command: "codex",
      // codex mcp add has no --scope flag at all — it always writes to the
      // global ~/.codex/config.toml, so project scope is not representable.
      buildArgs: (scope) =>
        scope === "project"
          ? undefined
          : ["mcp", "add", "skillmux", "--", "skillmux", "serve"],
    },
  },
  opencode: {
    id: "opencode",
    surfaceId: "agent-skills",
    detectionPath: ({ home }) => join(home, ".config", "opencode"),
    instructions: {
      global: ({ home }) => join(home, ".config", "opencode", "AGENTS.md"),
    },
  },
  "github-copilot": {
    id: "github-copilot",
    surfaceId: "agent-skills",
    detectionPath: ({ home }) => join(home, ".config", "github-copilot"),
  },
  windsurf: {
    id: "windsurf",
    surfaceId: "agent-skills",
    detectionPath: ({ home }) => join(home, ".codeium", "windsurf"),
  },
  antigravity: {
    id: "antigravity",
    surfaceId: "antigravity",
    instructions: {
      global: ({ home }) => join(home, ".gemini", "GEMINI.md"),
    },
  },
  goose: {
    id: "goose",
    surfaceId: "agent-skills",
    detectionPath: ({ home }) => join(home, ".config", "goose"),
    instructions: {
      global: ({ home }) => join(home, ".config", "goose", ".goosehints"),
    },
  },
  hermes: {
    id: "hermes",
    surfaceId: "agent-skills",
    detectionPath: ({ home }) => join(home, ".hermes"),
    instructions: {
      global: ({ home }) => join(home, ".hermes.md"),
    },
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
  return join(options.home, ".gemini", "config", "skills");
}

function defaultCodexHome(): string | undefined {
  const value = process.env.CODEX_HOME;
  if (!value) return undefined;
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
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
    const path = surfacePath(agent.surfaceId, { home, codexHome });
    const existing = surfaces.get(path);
    if (existing) {
      if (!existing.agents.includes(agent.id)) existing.agents.push(agent.id);
      continue;
    }
    surfaces.set(path, { id: agent.surfaceId, path, agents: [agent.id] });
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
