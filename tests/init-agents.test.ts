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
      "pi",
      "openclaw",
      "grok-build",
      "deepseek-harness",
      "cursor",
      "amp",
      "kiro",
      "factory-droid",
      "junie",
      "roo-code",
      "omp",
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
    expect(() => planAgentSurfaces(["emacs"], { home: "/home/tester" }))
      .toThrow(/unsupported agent "emacs"/);
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
      expect(getAgentDefinition(id).skillDirs.length, `${id} declares no skill directory`).toBeGreaterThan(0);
    }
  });

  test("pi and deepseek-harness read the shared directory with the other shared readers", () => {
    const plan = planAgentSurfaces(["opencode", "pi", "deepseek-harness"], { home: "/home/tester" });

    expect(plan.surfaces).toEqual([
      { id: "agent-skills", path: "/home/tester/.agents/skills", agents: ["opencode", "pi", "deepseek-harness"] },
    ]);
  });

  test("openclaw reads two directories but is planned into the shared one only", () => {
    const plan = planAgentSurfaces(["openclaw"], { home: "/home/tester" });

    expect(plan.surfaces).toEqual([
      { id: "agent-skills", path: "/home/tester/.agents/skills", agents: ["openclaw"] },
    ]);
    expect(getAgentDefinition("openclaw").skillDirs).toEqual(["openclaw", "agent-skills"]);
  });

  test("grok-build cannot read the shared directory, so it gets its own", () => {
    const plan = planAgentSurfaces(["grok-build", "opencode"], { home: "/home/tester" });

    expect(plan.surfaces).toEqual([
      { id: "grok", path: "/home/tester/.grok/skills", agents: ["grok-build"] },
      { id: "agent-skills", path: "/home/tester/.agents/skills", agents: ["opencode"] },
    ]);
  });

  test("every pinned skill is planned exactly once per agent", () => {
    const plan = planAgentSurfaces([...SUPPORTED_AGENT_IDS], { home: "/home/tester" });

    for (const id of SUPPORTED_AGENT_IDS) {
      expect(plan.surfaces.filter((surface) => surface.agents.includes(id)), id).toHaveLength(1);
    }
  });

  test("pi registers over stdio and over HTTP with the verified pi mcp add flags", () => {
    const registration = getAgentDefinition("pi").mcpRegistration!;

    expect(registration.command).toBe("pi");
    expect(registration.buildArgs("user")).toEqual(["mcp", "add", "skillmux", "--", "skillmux", "serve"]);
    expect(registration.buildArgs("project")).toBeUndefined();
    expect(registration.buildArgs("user", { url: "https://s.test/mcp", tokenEnv: "SKILLMUX_TOKEN" })).toEqual([
      "mcp", "add", "skillmux", "--url", "https://s.test/mcp", "--bearer-token-env-var", "SKILLMUX_TOKEN",
    ]);
  });

  test("cursor, amp, factory-droid, junie and roo-code share ~/.agents/skills, and kiro has its own", () => {
    const shared = planAgentSurfaces(["cursor", "amp", "factory-droid", "junie", "roo-code", "omp"], { home: "/home/tester" });
    expect(shared.surfaces).toEqual([
      {
        id: "agent-skills",
        path: "/home/tester/.agents/skills",
        agents: ["cursor", "amp", "factory-droid", "junie", "roo-code", "omp"],
      },
    ]);
    expect(planAgentSurfaces(["kiro"], { home: "/home/tester" }).surfaces).toEqual([
      { id: "kiro", path: "/home/tester/.kiro/skills", agents: ["kiro"] },
    ]);
  });

  test("amp registers over stdio only", () => {
    const registration = getAgentDefinition("amp").mcpRegistration!;

    expect(registration.command).toBe("amp");
    expect(registration.buildArgs("user")).toEqual(["mcp", "add", "skillmux", "--", "skillmux", "serve"]);
    expect(registration.buildArgs("project")).toBeUndefined();
    expect(registration.buildArgs("user", { url: "https://s.test/mcp" })).toBeUndefined();
  });

  test("agents whose registration command is unverified print a snippet instead", () => {
    for (const id of ["openclaw", "grok-build", "deepseek-harness", "cursor", "kiro", "factory-droid", "junie", "roo-code", "omp"] as const) {
      expect(getAgentDefinition(id).mcpRegistration, id).toBeUndefined();
    }
  });
});
