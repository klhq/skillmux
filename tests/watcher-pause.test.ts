import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillRow } from "../src/db-index";
import { configure, getRuntime, isVaultWatcherPaused, pauseVaultWatcher, startVaultWatcher, syncVaultIfNeeded } from "../src/router-core";
import type { Config } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-pause-"));
const vaultDir = join(tmp, "vault");
const TEST_TIMEOUT_MS = 15000;

function writeSkill(id: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n# ${id}\n`);
}

const config: Config = {
  vault_path: vaultDir,
  local_vault_paths: [],
  agents: [],
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15, k_rerank: 10 },
  output: { top_k: 10, max_top_k: 50 },
  inference: {
    mode: "remote",
    timeout_ms: 200,
    embedding: { provider: "openai", endpoint: "http://127.0.0.1:9/v1/embeddings", model: "m", dimension: 3 },
    reranker: { adapter: "jina-v1", endpoint: "http://127.0.0.1:9/rerank", model: "r" },
  },
};

let stopWatcher: () => void;

beforeAll(async () => {
  writeSkill("seed");
  configure({ config });
  stopWatcher = await startVaultWatcher();
});

afterAll(() => {
  stopWatcher?.();
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("pauseVaultWatcher", () => {
  test(
    "changes made while paused reach the index only through one explicit resync",
    async () => {
      const resume = pauseVaultWatcher();
      writeSkill("during-pull-a");
      writeSkill("during-pull-b");
      await Bun.sleep(1200);
      const { db } = await getRuntime();

      expect(getSkillRow(db, "during-pull-a")).toBeNull();
      expect(getSkillRow(db, "during-pull-b")).toBeNull();

      resume();
      await syncVaultIfNeeded();

      expect(getSkillRow(db, "during-pull-a")).not.toBeNull();
      expect(getSkillRow(db, "during-pull-b")).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "live indexing works again after resume",
    async () => {
      pauseVaultWatcher()();
      writeSkill("after-resume");
      const { db } = await getRuntime();
      const deadline = Date.now() + 10000;
      while (getSkillRow(db, "after-resume") === null && Date.now() < deadline) await Bun.sleep(100);

      expect(getSkillRow(db, "after-resume")).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test("nested pauses resume only when the last one is released", () => {
    const first = pauseVaultWatcher();
    const second = pauseVaultWatcher();
    first();
    first(); // releasing twice must not unbalance the counter
    // still paused by `second`
    expect(isVaultWatcherPaused()).toBe(true);
    second();
    expect(isVaultWatcherPaused()).toBe(false);
  });
});
