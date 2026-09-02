import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUPPORTED_AGENT_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "github-copilot",
  "windsurf",
  "antigravity",
  "goose",
  "hermes",
] as const;

export type AgentId = (typeof SUPPORTED_AGENT_IDS)[number];
export type DeliveryMode = "managed-pins" | "full-vault";

export interface DetectedAgent {
  agent: AgentId;
  evidence: string;
}

interface AgentDefinition {
  id: AgentId;
  surfaceId?: "agent-skills" | "claude-code" | "codex" | "antigravity";
  deliveryMode: DeliveryMode;
}

export interface PlannedAgentSurface {
  id: string;
  targetName: string;
  path: string;
  deliveryMode: "managed-pins";
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

export interface ResolvedBuiltInTarget {
  targetName: string;
  path: string;
  warning?: string;
}

const AGENTS: Record<AgentId, AgentDefinition> = {
  "claude-code": { id: "claude-code", surfaceId: "claude-code", deliveryMode: "managed-pins" },
  codex: { id: "codex", surfaceId: "codex", deliveryMode: "managed-pins" },
  "gemini-cli": { id: "gemini-cli", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  opencode: { id: "opencode", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  "github-copilot": { id: "github-copilot", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  windsurf: { id: "windsurf", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  antigravity: { id: "antigravity", surfaceId: "antigravity", deliveryMode: "managed-pins" },
  goose: { id: "goose", deliveryMode: "full-vault" },
  hermes: { id: "hermes", deliveryMode: "full-vault" },
};

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
  const candidates: Array<[AgentId, string]> = [
    ["claude-code", join(home, ".claude")],
    ["codex", codexHome],
    ["gemini-cli", join(home, ".gemini")],
    ["opencode", join(home, ".config", "opencode")],
    ["github-copilot", join(home, ".config", "github-copilot")],
    ["windsurf", join(home, ".codeium", "windsurf")],
    ["goose", join(home, ".config", "goose")],
    ["hermes", join(home, ".hermes")],
  ];
  return candidates
    .filter(([, evidence]) => exists(evidence))
    .map(([agent, evidence]) => ({ agent, evidence }));
}

function surfacePath(
  surfaceId: NonNullable<AgentDefinition["surfaceId"]>,
  options: { home: string; codexHome?: string },
): string {
  if (surfaceId === "agent-skills") return join(options.home, ".agents", "skills");
  if (surfaceId === "claude-code") return join(options.home, ".claude", "skills");
  if (surfaceId === "codex") return join(options.codexHome ?? join(options.home, ".codex"), "skills");
  return join(options.home, ".gemini", "config", "skills");
}

export function resolveBuiltInTarget(
  name: string,
  options: { home?: string; codexHome?: string; customPath?: string } = {},
): ResolvedBuiltInTarget {
  const home = options.home ?? homedir();
  if (name === "custom") {
    if (!options.customPath) throw new Error("--target custom requires --path <dir>");
    return { targetName: name, path: options.customPath };
  }
  if (name === "agent-skills" || name === "agents") {
    return {
      targetName: name,
      path: surfacePath("agent-skills", { home }),
      ...(name === "agents"
        ? { warning: "--target agents is deprecated; use --target agent-skills" }
        : {}),
    };
  }
  if (name === "claude-code" || name === "claude") {
    return {
      targetName: name,
      path: surfacePath("claude-code", { home }),
      ...(name === "claude"
        ? { warning: "--target claude is deprecated; use --target claude-code" }
        : {}),
    };
  }
  if (name === "codex") {
    return {
      targetName: name,
      path: surfacePath("codex", { home, codexHome: options.codexHome }),
    };
  }
  throw new Error(
    `unknown --target "${name}"; supported targets: agent-skills, claude-code, codex, custom`,
  );
}

export function planAgentSurfaces(
  requestedAgents: readonly string[],
  options: { home?: string; codexHome?: string } = {},
): AgentSurfacePlan {
  const agents = [...new Set(requestedAgents)].map((id) => {
    if (!SUPPORTED_AGENT_IDS.includes(id as AgentId)) {
      throw new Error(
        `unsupported agent "${id}"; supported agents: ${SUPPORTED_AGENT_IDS.join(", ")}`,
      );
    }
    return AGENTS[id as AgentId];
  });
  const home = options.home ?? homedir();
  const surfaces = new Map<string, PlannedAgentSurface>();

  for (const agent of agents) {
    if (!agent.surfaceId) continue;
    const path = surfacePath(agent.surfaceId, { home, codexHome: options.codexHome });
    const existing = surfaces.get(path);
    if (existing) {
      if (!existing.agents.includes(agent.id)) existing.agents.push(agent.id);
      continue;
    }
    surfaces.set(path, {
      id: agent.surfaceId,
      targetName: agent.surfaceId,
      path,
      deliveryMode: "managed-pins",
      agents: [agent.id],
    });
  }

  return { agents, surfaces: [...surfaces.values()] };
}

export function assessAgentReadiness(
  plan: AgentSurfacePlan,
  instructionReadiness: Partial<Record<AgentId, ReadinessAxis>> = {},
): AgentReadiness[] {
  return plan.agents.map((agent) => {
    const surface = plan.surfaces.find((candidate) => candidate.agents.includes(agent.id));
    let skillSurface: ReadinessAxis;
    if (surface) {
      skillSurface = { status: "planned", detail: surface.path };
    } else if (agent.id === "goose") {
      skillSurface = { status: "manual", detail: "configure the full vault in Goose" };
    } else if (agent.id === "hermes") {
      skillSurface = { status: "manual", detail: "configure the full vault in Hermes external_dirs" };
    } else {
      skillSurface = {
        status: "not-applicable",
        detail: "skills resolve through Skillmux MCP",
      };
    }

    const mcpRegistration: ReadinessAxis = {
      status: "not-applicable",
      detail: "native skill loading",
    };

    return {
      agent: agent.id,
      skillSurface,
      mcpRegistration,
      instructionSetup: instructionReadiness[agent.id] ?? {
        status: "manual",
        detail: "instruction adapter not applied",
      },
    };
  });
}
