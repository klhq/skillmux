import { describe, expect, test } from "bun:test";
import {
  assessClientReadiness,
  resolveBuiltInTarget,
  SUPPORTED_CLIENT_IDS,
  planClientSurfaces,
} from "../src/init-clients";

describe("init client registry", () => {
  test("supports the documented client names", () => {
    expect(SUPPORTED_CLIENT_IDS).toEqual([
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
    ]);
  });

  test("deduplicates clients that share the global agent-skills surface", () => {
    const plan = planClientSurfaces(
      ["gemini-cli", "opencode", "github-copilot", "windsurf"],
      { home: "/home/tester" },
    );

    expect(plan.surfaces).toEqual([
      {
        id: "agent-skills",
        targetName: "agent-skills",
        path: "/home/tester/.agents/skills",
        deliveryMode: "managed-pins",
        clients: ["gemini-cli", "opencode", "github-copilot", "windsurf"],
      },
    ]);
  });

  test("deduplicates repeated client selections", () => {
    const plan = planClientSurfaces(
      ["claude-code", "claude-code"],
      { home: "/home/tester" },
    );

    expect(plan.clients.map((client) => client.id)).toEqual(["claude-code"]);
    expect(plan.surfaces[0]?.clients).toEqual(["claude-code"]);
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
    const plan = planClientSurfaces(
      ["gemini-cli", "goose", "hermes", "skillmux-mcp"],
      { home: "/home/tester" },
    );

    expect(assessClientReadiness(plan)).toEqual([
      {
        client: "gemini-cli",
        skillSurface: { status: "planned", detail: "/home/tester/.agents/skills" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        client: "goose",
        skillSurface: { status: "manual", detail: "configure the full vault in Goose" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        client: "hermes",
        skillSurface: { status: "manual", detail: "configure the full vault in Hermes external_dirs" },
        mcpRegistration: { status: "not-applicable", detail: "native skill loading" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
      {
        client: "skillmux-mcp",
        skillSurface: { status: "not-applicable", detail: "skills resolve through Skillmux MCP" },
        mcpRegistration: { status: "manual", detail: "register the Skillmux MCP server" },
        instructionSetup: { status: "manual", detail: "instruction adapter not applied" },
      },
    ]);
  });
});
