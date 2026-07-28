import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteInferenceError } from "../src/clients";
import { openIndex } from "../src/db";
import { backfillEmbeddings, configure, rebuildIndex } from "../src/router-core";
import type { Config } from "../src/types";

const roots: string[] = [];

function vectorCount(stateDir: string): number {
  const db = openIndex(stateDir);
  const row = db.query("SELECT COUNT(*) AS count FROM vectors").get() as { count: number };
  db.close();
  return row.count;
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "skillmux-embedding-batch-"));
  roots.push(root);
  const vaultPath = join(root, "vault");
  const stateDir = join(root, "state");
  mkdirSync(vaultPath, { recursive: true });
  for (let index = 0; index < 12; index++) {
    const skillDir = join(vaultPath, `skill-${index}`);
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: batch fixture ${index}\n---\n\nbody\n`,
    );
  }
  const config: Config = {
    vault_path: vaultPath,
    local_vault_paths: [],
    state_dir: stateDir,
    recall: { k_lexical: 20, k_vector: 20 },
    thresholds: { candidate_limit: 5 },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: {
        provider: "openai",
        endpoint: "http://127.0.0.1:9/v1/embeddings",
        model: "fixture",
        dimension: 3,
      },
    },
  };
  return { config, stateDir };
}

afterEach(() => {
  configure({});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("embedding backfill batches", () => {
  test("rolls back a failing later batch while retaining earlier committed batches", async () => {
    const { config, stateDir } = await harness();
    let calls = 0;
    configure({
      config,
      clients: {
        embed: async (texts) => {
          calls++;
          if (calls === 1) return texts.map(() => Float32Array.from([0.1, 0.2, 0.3]));
          return [Float32Array.from([0.1, 0.2, 0.3]), undefined] as unknown as Float32Array[];
        },
      },
    });
    await rebuildIndex();

    await expect(backfillEmbeddings()).resolves.toBe(10);
    expect(vectorCount(stateDir)).toBe(10);
  });

  test("does not suppress a later protocol failure", async () => {
    const { config, stateDir } = await harness();
    let calls = 0;
    configure({
      config,
      clients: {
        embed: async (texts) => {
          calls++;
          if (calls === 1) return texts.map(() => Float32Array.from([0.1, 0.2, 0.3]));
          throw new RemoteInferenceError("protocol", "embedding endpoint returned invalid indexed vectors");
        },
      },
    });
    await rebuildIndex();

    await expect(backfillEmbeddings()).rejects.toMatchObject({ kind: "protocol" });
    expect(vectorCount(stateDir)).toBe(10);
  });

  test("stops after a later availability failure while preserving earlier batches", async () => {
    const { config, stateDir } = await harness();
    let calls = 0;
    configure({
      config,
      clients: {
        embed: async (texts) => {
          calls++;
          if (calls === 1) return texts.map(() => Float32Array.from([0.1, 0.2, 0.3]));
          throw new RemoteInferenceError("availability", "embedding endpoint request failed");
        },
      },
    });
    await rebuildIndex();

    await expect(backfillEmbeddings()).resolves.toBe(10);
    expect(vectorCount(stateDir)).toBe(10);
  });
});
