import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSkill, configure, closeRuntime, rebuildIndex } from "../src/router-core";
import type { Config } from "../src/types";

function writeSkillAt(root: string, skillId: string, description: string) {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${description}\n---\n\n# ${skillId}\n\nBody of ${skillId}.\n`,
  );
}

/** Fresh vault/local-vault/state directories per test — avoids cross-test staleness/mtime coupling. */
function freshFixture(): { tmp: string; vaultDir: string; localVaultDir: string; config: Config } {
  const tmp = mkdtempSync(join(tmpdir(), "skillmux-local-vault-test-"));
  const vaultDir = join(tmp, "vault");
  const localVaultDir = join(tmp, "local-vault");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(localVaultDir, { recursive: true });
  const config: Config = {
    vault_path: vaultDir,
    local_vault_paths: [localVaultDir],
    state_dir: join(tmp, "state"),
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: { candidate_limit: 5 },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: { provider: "openai", base_url: "http://127.0.0.1:9", model: "test-model", dimension: 3 },
    },
  };
  return { tmp, vaultDir, localVaultDir, config };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  closeRuntime();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local_vault_paths integration (AC4, AC7)", () => {
  test("fetchSkill delivers a skill that only exists in a local_vault_paths entry", async () => {
    const { tmp, localVaultDir, config } = freshFixture();
    cleanupDirs.push(tmp);
    writeSkillAt(localVaultDir, "local-only-skill", "Only exists in the local overlay vault.");
    configure({ config, clients: { embed: async (texts) => texts.map(() => new Float32Array(3)) } });

    const result = await fetchSkill({ skill_id: "local-only-skill" });

    expect(result.skill_id).toBe("local-only-skill");
    expect(result.body).toContain("Body of local-only-skill");
  });

  test("fetchSkill prefers the local_vault_paths copy over vault_path on skill_id collision", async () => {
    const { tmp, vaultDir, localVaultDir, config } = freshFixture();
    cleanupDirs.push(tmp);
    writeSkillAt(vaultDir, "shared-skill", "Upstream copy.");
    writeSkillAt(localVaultDir, "shared-skill", "Local override copy.");
    configure({ config, clients: { embed: async (texts) => texts.map(() => new Float32Array(3)) } });

    const result = await fetchSkill({ skill_id: "shared-skill" });

    expect(result.body).toContain("Local override copy");
  });

  test("rebuildIndex ingests skills from local_vault_paths alongside vault_path", async () => {
    const { tmp, localVaultDir, config } = freshFixture();
    cleanupDirs.push(tmp);
    writeSkillAt(localVaultDir, "indexed-local-skill", "Indexed from the local overlay.");
    configure({ config, clients: { embed: async (texts) => texts.map(() => new Float32Array(3)) } });

    const report = await rebuildIndex();

    expect(report.indexed).toBeGreaterThan(0);
    await expect(fetchSkill({ skill_id: "indexed-local-skill" })).resolves.toMatchObject({
      skill_id: "indexed-local-skill",
    });
  });
});
