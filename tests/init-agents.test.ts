import { describe, expect, test } from "bun:test";
import {
  assessAgentReadiness,
  detectInstalledAgents,
  getAgentDefinition,
  SUPPORTED_AGENT_IDS,
  planAgentSurfaces,
} from "../src/init-agents";

describe("init agent registry", () => {
  test("detects installed agents with concrete filesystem evidence", () => {
    const detected = detectInstalledAgents({
      home: "/home/tester",
      exists: (path) => path === "/home/tester/.claude" || path === "/home/tester/.config/goose",
    });

    expect(detected).toEqual([
      { agent: "claude-code", evidence: "/home/tester/.claude" },
      { agent: "goose", evidence: "/home/tester/.config/goose" },
    ]);
  });

  test("supports the documented agent names", () => {
    expect(SUPPORTED_AGENT_IDS).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "github-copilot",
      "windsurf",
      "antigravity",
      "goose",
      "hermes",
    ]);
  });

  test("deduplicates agents that share the global agent-skills surface", () => {
    const plan = planAgentSurfaces(
      ["opencode", "github-copilot", "windsurf"],
      { home: "/home/tester" },
    );

    expect(plan.surfaces).toEqual([
      {
        id: "agent-skills",
        path: "/home/tester/.agents/skills",
        agents: ["opencode", "github-copilot", "windsurf"],
      },
    ]);
  });

  test("deduplicates repeated agent selections", () => {
    const plan = planAgentSurfaces(
      ["claude-code", "claude-code"],
      { home: "/home/tester" },
    );

    expect(plan.agents.map((agent) => agent.id)).toEqual(["claude-code"]);
    expect(plan.surfaces[0]?.agents).toEqual(["claude-code"]);
  });

  test("goose and hermes read the shared ~/.agents/skills directory", () => {
    const plan = planAgentSurfaces(["opencode", "goose", "hermes"], { home: "/home/tester" });
    expect(plan.surfaces).toEqual([
      {
        id: "agent-skills",
        path: "/home/tester/.agents/skills",
        agents: ["opencode", "goose", "hermes"],
      },
    ]);
  });

  test("resolves each surface to its fixed directory, honoring codexHome", () => {
    const plan = planAgentSurfaces(["claude-code", "codex", "antigravity"], {
      home: "/home/tester",
      codexHome: "/srv/codex",
    });
    expect(plan.surfaces.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "claude-code", path: "/home/tester/.claude/skills" },
      { id: "codex", path: "/srv/codex/skills" },
      { id: "antigravity", path: "/home/tester/.gemini/config/skills" },
    ]);
  });

  test("rejects an agent the registry does not know", () => {
    expect(() => planAgentSurfaces(["pi"], { home: "/home/tester" }))
      .toThrow(/unsupported agent "pi"/);
  });

  test("reports skill surface, MCP registration, and instructions separately", () => {
    const plan = planAgentSurfaces(
      ["windsurf", "goose", "hermes"],
      { home: "/home/tester" },
    );

    expect(assessAgentReadiness(plan)).toEqual([
      {
        agent: "windsurf",
        skillSurface: { status: "planned", detail: "/home/tester/.agents/skills" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        agent: "goose",
        skillSurface: { status: "planned", detail: "/home/tester/.agents/skills" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        agent: "hermes",
        skillSurface: { status: "planned", detail: "/home/tester/.agents/skills" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
    ]);
  });

  test("every agent maps to a skill directory", () => {
    for (const id of SUPPORTED_AGENT_IDS) {
      expect(getAgentDefinition(id).surfaceId, `${id} declares no surfaceId`).toBeDefined();
    }
  });
});
