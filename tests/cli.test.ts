import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "skill-router-cli-"));
const vaultDir = join(tmp, "vault");
const stateDir = join(tmp, "state");
const configPath = join(tmp, "config.toml");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

async function runCli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...(process.env as Record<string, string>), SKILL_ROUTER_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(() => {
  writeSkill("first-skill", "Reads and formats CSV files.");
  writeSkill("second-skill", "Deploys containers to the homelab.");
  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${stateDir}"`,
      `[recall]`,
      `k_lexical = 15`,
      `k_vector = 15`,
      ``,
      `[thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
      `candidate_limit = 5`,
      ``,
      `[inference]`,
      `mode = "remote"`,
      `timeout_ms = 200`,
      ``,
      `[inference.embedding]`,
      `provider = "openai"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[inference.reranker]`,
      `provider = "infinity"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("skill-router index CLI (AC8)", () => {
  test("rebuilds the index from scratch, reports the count, and exits 0 with remotes offline", async () => {
    const result = await runCli("index");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("indexed 2 skills");
    expect(existsSync(join(stateDir, "index.sqlite3"))).toBe(true);
  });

  test("keeps a previously indexed skill and warns when its SKILL.md becomes unparseable", async () => {
    await runCli("index");
    writeFileSync(join(vaultDir, "second-skill", "SKILL.md"), "---\nname: [unclosed\n");

    const result = await runCli("index");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("indexed 2 skills");
    expect(result.stderr).toContain("second-skill");
  });
});
