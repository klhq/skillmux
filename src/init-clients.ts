import { homedir } from "node:os";
import { join } from "node:path";

export const SUPPORTED_CLIENT_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "github-copilot",
  "windsurf",
  "antigravity",
  "goose",
  "hermes",
  "skillmux-mcp",
] as const;

export type ClientId = (typeof SUPPORTED_CLIENT_IDS)[number];
export type DeliveryMode = "managed-pins" | "full-vault" | "mcp";

interface ClientDefinition {
  id: ClientId;
  surfaceId?: "agent-skills" | "claude-code" | "codex" | "antigravity";
  deliveryMode: DeliveryMode;
}

export interface PlannedClientSurface {
  id: string;
  targetName: string;
  path: string;
  deliveryMode: "managed-pins";
  clients: ClientId[];
}

export interface ClientSurfacePlan {
  clients: ClientDefinition[];
  surfaces: PlannedClientSurface[];
}

type ReadinessStatus = "ready" | "planned" | "manual" | "not-applicable";

export interface ReadinessAxis {
  status: ReadinessStatus;
  detail: string;
}

export interface ClientReadiness {
  client: ClientId;
  skillSurface: ReadinessAxis;
  mcpRegistration: ReadinessAxis;
  instructionSetup: ReadinessAxis;
}

export interface ResolvedBuiltInTarget {
  targetName: string;
  path: string;
  warning?: string;
}

const CLIENTS: Record<ClientId, ClientDefinition> = {
  "claude-code": { id: "claude-code", surfaceId: "claude-code", deliveryMode: "managed-pins" },
  codex: { id: "codex", surfaceId: "codex", deliveryMode: "managed-pins" },
  "gemini-cli": { id: "gemini-cli", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  opencode: { id: "opencode", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  "github-copilot": { id: "github-copilot", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  windsurf: { id: "windsurf", surfaceId: "agent-skills", deliveryMode: "managed-pins" },
  antigravity: { id: "antigravity", surfaceId: "antigravity", deliveryMode: "managed-pins" },
  goose: { id: "goose", deliveryMode: "full-vault" },
  hermes: { id: "hermes", deliveryMode: "full-vault" },
  "skillmux-mcp": { id: "skillmux-mcp", deliveryMode: "mcp" },
};

function surfacePath(
  surfaceId: NonNullable<ClientDefinition["surfaceId"]>,
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

export function planClientSurfaces(
  requestedClients: readonly string[],
  options: { home?: string; codexHome?: string } = {},
): ClientSurfacePlan {
  const clients = [...new Set(requestedClients)].map((id) => {
    if (!SUPPORTED_CLIENT_IDS.includes(id as ClientId)) {
      throw new Error(
        `unsupported client "${id}"; supported clients: ${SUPPORTED_CLIENT_IDS.join(", ")}`,
      );
    }
    return CLIENTS[id as ClientId];
  });
  const home = options.home ?? homedir();
  const surfaces = new Map<string, PlannedClientSurface>();

  for (const client of clients) {
    if (!client.surfaceId) continue;
    const path = surfacePath(client.surfaceId, { home, codexHome: options.codexHome });
    const existing = surfaces.get(path);
    if (existing) {
      if (!existing.clients.includes(client.id)) existing.clients.push(client.id);
      continue;
    }
    surfaces.set(path, {
      id: client.surfaceId,
      targetName: client.surfaceId,
      path,
      deliveryMode: "managed-pins",
      clients: [client.id],
    });
  }

  return { clients, surfaces: [...surfaces.values()] };
}

export function assessClientReadiness(
  plan: ClientSurfacePlan,
  instructionReadiness: Partial<Record<ClientId, ReadinessAxis>> = {},
): ClientReadiness[] {
  return plan.clients.map((client) => {
    const surface = plan.surfaces.find((candidate) => candidate.clients.includes(client.id));
    let skillSurface: ReadinessAxis;
    if (surface) {
      skillSurface = { status: "planned", detail: surface.path };
    } else if (client.id === "goose") {
      skillSurface = { status: "manual", detail: "configure the full vault in Goose" };
    } else if (client.id === "hermes") {
      skillSurface = { status: "manual", detail: "configure the full vault in Hermes external_dirs" };
    } else {
      skillSurface = {
        status: "not-applicable",
        detail: "skills resolve through Skillmux MCP",
      };
    }

    const mcpRegistration: ReadinessAxis = client.deliveryMode === "mcp"
      ? { status: "manual", detail: "register the Skillmux MCP server" }
      : { status: "not-applicable", detail: "native skill loading" };

    return {
      client: client.id,
      skillSurface,
      mcpRegistration,
      instructionSetup: instructionReadiness[client.id] ?? {
        status: "manual",
        detail: "instruction adapter not applied",
      },
    };
  });
}
