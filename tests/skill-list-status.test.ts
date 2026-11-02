import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-list-status-"));
const vaultDir = join(tmp, "vault");
const home = join(tmp, "home");
const configPath = join(tmp, "config.toml");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

function writeSkill(id: string, description: string) {
  mkdirSync(join(vaultDir, id), { recursive: true });
  writeFileSync(join(vaultDir, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\nBody.\n`);
}

async function run(...args: string[]) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, SKILLMUX_CONFIG: configPath };
  delete env.CODEX_HOME;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  writeSkill("alpha-skill", "Core skill.");
  writeSkill("beta-skill", "Project skill.");
  writeSkill("gamma-skill", "Reached over MCP only.");
  writeFileSync(
    join(vaultDir, "skillmux.toml"),
    `[core]\nskills = ["alpha-skill"]\nlimit = 5\n\n[project.web]\npaths = []\nskills = ["beta-skill"]\nagents = ["claude-code"]\n`,
  );
  writeFileSync(configPath, `vault_path = "${vaultDir}"\nagents = ["claude-code"]\n`);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("skill list", () => {
  test("reports each skill's placement in the JSON envelope", async () => {
    const result = await run("skill", "list", "--json");
    expect(result.exitCode).toBe(0);
    const { ok, data } = JSON.parse(result.stdout);
    expect(ok).toBe(true);
    const byId = Object.fromEntries(data.skills.map((s: any) => [s.skill_id, s]));
    expect(byId["alpha-skill"]).toMatchObject({ placement: "core", project_groups: [], description: "Core skill." });
    expect(byId["beta-skill"]).toMatchObject({ placement: "project", project_groups: ["web"] });
    expect(byId["gamma-skill"]).toMatchObject({ placement: "mcp-only", root: vaultDir });
  });

  test("filters by placement", async () => {
    const { data } = JSON.parse((await run("skill", "list", "--placement", "core", "--json")).stdout);
    expect(data.skills.map((s: any) => s.skill_id)).toEqual(["alpha-skill"]);
  });

  test("rejects an unknown placement with USAGE_ERROR", async () => {
    const result = await run("skill", "list", "--placement", "bogus", "--json");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
  });

  test("prints one line per skill in text mode", async () => {
    const result = await run("skill", "list");
    expect(result.stdout).toContain("alpha-skill [core] Core skill.");
    expect(result.stdout).toContain("beta-skill [project: web] Project skill.");
    expect(result.stdout).toContain("gamma-skill [mcp-only]");
  });
});

describe("skill which --json", () => {
  test("returns the envelope for a found skill", async () => {
    const { ok, data } = JSON.parse((await run("skill", "which", "alpha-skill", "--json")).stdout);
    expect(ok).toBe(true);
    expect(data).toEqual({ skill_id: "alpha-skill", found: true, serving_from: vaultDir, shadows: [] });
  });

  test("reports found: false and exits 1 for an unknown skill", async () => {
    const result = await run("skill", "which", "ghost-skill", "--json");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data).toMatchObject({ found: false, serving_from: null });
  });
});

describe("status", () => {
  test("summarizes core usage, groups and agents", async () => {
    const result = await run("status", "--json");
    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout);
    expect(data.vault).toEqual({ path: vaultDir, exists: true, manifest: true });
    expect(data.core).toEqual({ count: 1, limit: 5, skills: ["alpha-skill"] });
    expect(data.project_groups).toEqual([{ name: "web", skills: 1, agents: ["claude-code"] }]);
    expect(data.agents[0]).toMatchObject({ agent: "claude-code", state: "missing", mcp_registration: true });
    expect(data.ok).toBe(false);
    expect(data.checks.some((c: any) => c.name.startsWith("agent_dir:") && !c.ok)).toBe(true);
  });

  test("rejects unknown options", async () => {
    const result = await run("status", "--bogus", "--json");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
  });
});

describe("error codes and --help --json", () => {
  test("an unknown command is a USAGE_ERROR, not EXIT_2", async () => {
    const { error } = JSON.parse((await run("frobnicate", "--json")).stdout);
    expect(error.code).toBe("USAGE_ERROR");
    expect(error.details.known_commands).toContain("status");
  });

  test("an ordinary failure carries a semantic code", async () => {
    const { error } = JSON.parse((await run("core", "pin", "ghost-skill", "--yes", "--json")).stdout);
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  test("--help --json returns the command registry", async () => {
    const result = await run("--help", "--json");
    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout);
    const core = data.commands.find((c: any) => c.name === "core");
    expect(core).toMatchObject({ writes: true, subcommands: ["pin", "unpin"] });
    expect(core.flags).toContain("--yes");
    const agent = data.commands.find((c: any) => c.name === "agent");
    expect(agent).toMatchObject({ writes: false, writing_subcommands: ["add", "remove", "rehome"] });
    expect(data.commands.find((c: any) => c.name === "status").writes).toBe(false);
  });

  test("<command> --help --json describes just that command", async () => {
    const { data } = JSON.parse((await run("skill", "--help", "--json")).stdout);
    expect(data.commands.map((c: any) => c.name)).toEqual(["skill"]);
  });
});
