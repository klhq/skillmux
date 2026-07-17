import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, fetchSkill, resolveSkill, startVaultWatcher } from "../src/router-core";
import type { Config } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "skill-router-watch-"));
const vaultDir = join(tmp, "vault");

// Watcher tests are wall-clock sensitive (debounce + stable-stat + polling);
// give each an explicit generous timeout so full-suite load can't flake them.
const TEST_TIMEOUT_MS = 15000;

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

const config: Config = {
  vault_path: vaultDir,
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
  inference: {
    mode: "remote",
    timeout_ms: 200,
    embedding: {
      provider: "openai",
      base_url: "http://127.0.0.1:9",
      model: "microsoft/harrier-oss-v1-0.6b",
      dimension: 3,
    },
    reranker: { provider: "infinity", base_url: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
  },
};

async function waitFor<T>(action: () => Promise<T>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError;
}

let stopWatcher: () => void;

beforeAll(async () => {
  writeSkill("existing-skill", "Present before the watcher starts.");
  configure({ config });
  stopWatcher = await startVaultWatcher();
});

afterAll(() => {
  stopWatcher?.();
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("vault watcher (AC8)", () => {
  test(
    "a skill created while running becomes fetchable within 5s without re-indexing",
    async () => {
      await expect(fetchSkill({ skill_id: "hot-added-skill" })).rejects.toThrow(/SKILL_NOT_FOUND/);
      writeSkill("hot-added-skill", "Created after the watcher started.");

      const result = await waitFor(() => fetchSkill({ skill_id: "hot-added-skill" }), TEST_TIMEOUT_MS);

      expect(result.skill_id).toBe("hot-added-skill");
      expect(result.body).toContain("Body of hot-added-skill.");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a deleted skill disappears from the index within 5s",
    async () => {
      writeSkill("doomed-skill", "Ephemeral zeppelin maintenance procedures.");
      await waitFor(() => fetchSkill({ skill_id: "doomed-skill" }), TEST_TIMEOUT_MS);

      rmSync(join(vaultDir, "doomed-skill"), { recursive: true, force: true });

      // Observe through resolveSkill (pure index read): fetchSkill would mask
      // the watcher by cleaning up the stale row itself on the disk miss.
      await waitFor(async () => {
        const result = await resolveSkill({ query: "zeppelin maintenance", forceDegraded: true });
        const ids = result.outcome === "ambiguous" ? result.candidates.map((c) => c.skill_id) : [];
        if (ids.includes("doomed-skill")) throw new Error("doomed-skill is still indexed");
      }, TEST_TIMEOUT_MS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unparseable overwrite keeps the previous index entry (AC8)",
    async () => {
      writeSkill("fragile-skill", "Curates rare orchid greenhouse rotations.");
      await waitFor(() => fetchSkill({ skill_id: "fragile-skill" }), TEST_TIMEOUT_MS);

      writeFileSync(join(vaultDir, "fragile-skill", "SKILL.md"), "---\nname: [unclosed\n");
      await Bun.sleep(1500); // debounce + stable-stat window

      const result = await resolveSkill({ query: "rare orchid greenhouse", forceDegraded: true });

      expect(result.outcome).toBe("ambiguous");
      if (result.outcome !== "ambiguous") throw new Error("unreachable");
      expect(result.candidates.map((c) => c.skill_id)).toContain("fragile-skill");
      expect(result.candidates.find((c) => c.skill_id === "fragile-skill")!.description).toContain(
        "orchid",
      );
    },
    TEST_TIMEOUT_MS,
  );
});
