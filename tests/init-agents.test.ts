import { describe, expect, test } from "bun:test";
import {
  assessAgentReadiness,
  detectInstalledAgents,
  resolveBuiltInTarget,
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
      "gemini-cli",
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
      ["gemini-cli", "opencode", "github-copilot", "windsurf"],
      { home: "/home/tester" },
    );

    expect(plan.surfaces).toEqual([
      {
        id: "agent-skills",
        targetName: "agent-skills",
        path: "/home/tester/.agents/skills",
        deliveryMode: "managed-pins",
        agents: ["gemini-cli", "opencode", "github-copilot", "windsurf"],
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

  test("resolves built-in targets and legacy aliases without vague names", () => {
    expect(resolveBuiltInTarget("agent-skills", { home: "/home/tester" })).toEqual({
      targetName: "agent-skills",
      path: "/home/tester/.agents/skills",
    });
    expect(resolveBuiltInTarget("codex", {
      home: "/home/tester",
      codexHome: "/srv/codex",
    })).toEqual({
      targetName: "codex",
      path: "/srv/codex/skills",
    });
    expect(resolveBuiltInTarget("agents", { home: "/home/tester" })).toEqual({
      targetName: "agents",
      path: "/home/tester/.agents/skills",
      warning: '--target agents is deprecated; use --target agent-skills',
    });
  });

  test("requires an explicit path for the custom target", () => {
    expect(() => resolveBuiltInTarget("custom", { home: "/home/tester" }))
      .toThrow("--target custom requires --path <dir>");
    expect(resolveBuiltInTarget("custom", {
      home: "/home/tester",
      customPath: "/srv/my-agent/skills",
    })).toEqual({
      targetName: "custom",
      path: "/srv/my-agent/skills",
    });
  });

  test("reports skill surface, MCP registration, and instructions separately", () => {
    const plan = planAgentSurfaces(
      ["gemini-cli", "goose", "hermes"],
      { home: "/home/tester" },
    );

    expect(assessAgentReadiness(plan)).toEqual([
      {
        agent: "gemini-cli",
        skillSurface: { status: "planned", detail: "/home/tester/.agents/skills" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        agent: "goose",
        skillSurface: { status: "manual", detail: "configure the full vault in Goose" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        agent: "hermes",
        skillSurface: { status: "manual", detail: "configure the full vault in Hermes external_dirs" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
    ]);
  });
});
