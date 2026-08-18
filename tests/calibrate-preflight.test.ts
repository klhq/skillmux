import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "../src/adapters";
import { openCalibrateDb } from "../src/calibrate";
import { openIndex, ingestVault } from "../src/db";
import { configure } from "../src/router-core";
import type { DecisionCase } from "../src/calibrate";

describe("calibrate run preflight feasibility and defaults", () => {
  let tmp: string;
  let vaultDir: string;
  let stateDir: string;
  let configPath: string;
  let datasetPath: string;
  let rerankCallCount = 0;

  // Build a 70-case dataset: 35 tune (20 matched, 5 ambiguous, 10 no_match)
  //                          35 test (20 matched, 5 ambiguous, 10 no_match)
  const standardDataset: DecisionCase[] = [];
  for (let i = 1; i <= 20; i++) {
    standardDataset.push({
      query: `tune match ${i}`,
      split: "tune",
      expected_outcome: "matched",
      relevant_skill_ids: ["skill-1"],
    });
  }
  for (let i = 1; i <= 5; i++) {
    standardDataset.push({
      query: `tune ambiguous ${i}`,
      split: "tune",
      expected_outcome: "ambiguous",
      relevant_skill_ids: ["skill-1", "skill-2"],
    });
  }
  for (let i = 1; i <= 10; i++) {
    standardDataset.push({
      query: `tune nomatch ${i}`,
      split: "tune",
      expected_outcome: "no_match",
      relevant_skill_ids: [],
    });
  }
  for (let i = 1; i <= 20; i++) {
    standardDataset.push({
      query: `test match ${i}`,
      split: "test",
      expected_outcome: "matched",
      relevant_skill_ids: ["skill-1"],
    });
  }
  for (let i = 1; i <= 5; i++) {
    standardDataset.push({
      query: `test ambiguous ${i}`,
      split: "test",
      expected_outcome: "ambiguous",
      relevant_skill_ids: ["skill-1", "skill-2"],
    });
  }
  for (let i = 1; i <= 10; i++) {
    standardDataset.push({
      query: `test nomatch ${i}`,
      split: "test",
      expected_outcome: "no_match",
      relevant_skill_ids: [],
    });
  }

  function makeFakeClients() {
    return {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        rerankCallCount++;
        return docs.map((d) => (query.includes("match") && d.skill_id === "skill-1" ? 0.95 : 0.1));
      },
    };
  }

  beforeEach(async () => {
    rerankCallCount = 0;
    tmp = mkdtempSync(join(tmpdir(), "skillmux-preflight-test-"));
    vaultDir = join(tmp, "vault");
    stateDir = join(tmp, "state");
    configPath = join(tmp, "skillmux.toml");
    datasetPath = join(tmp, "queries.json");

    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(vaultDir, "skill-1"), { recursive: true });
    mkdirSync(join(vaultDir, "skill-2"), { recursive: true });

    writeFileSync(
      join(vaultDir, "skill-1", "SKILL.md"),
      "---\nname: skill 1\ndescription: first skill\naliases: [s1]\n---\n# skill 1\n",
    );
    writeFileSync(
      join(vaultDir, "skill-2", "SKILL.md"),
      "---\nname: skill 2\ndescription: second skill\naliases: [s2]\n---\n# skill 2\n",
    );

    writeFileSync(datasetPath, JSON.stringify(standardDataset, null, 2));

    const toml = `vault_path = "${vaultDir}"
local_vault_paths = []
state_dir = "${stateDir}"

[recall]
k_lexical = 50
k_vector = 50
k_rerank = 50

[output]
top_k = 5
max_top_k = 50

[inference]
mode = "remote"
timeout_ms = 2000

[inference.embedding]
provider = "openai"
endpoint = "http://127.0.0.1:9/v1/embeddings"
model = "mock-embed"
dimension = 3

[inference.reranker]
adapter = "jina-v1"
endpoint = "http://127.0.0.1:9"
model = "mock-rerank"
`;
    writeFileSync(configPath, toml);

    const indexDb = openIndex(stateDir);
    const { scanVault } = await import("../src/vault");
    const skills = await scanVault(vaultDir);
    ingestVault(indexDb, skills);
    indexDb.close();
  });

  afterEach(() => {
    configure({});
    rmSync(tmp, { recursive: true, force: true });
  });

  test("proves defaults are 0.75/15 and a 20-matched tune split can proceed", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    const res = await adapter.calibrateRun({ datasetPath });

    expect(res.run_id).toBeDefined();
    expect(res.result).toBeDefined();

    const db = openCalibrateDb(stateDir);
    const row = db
      .query("SELECT min_auto_match_precision, min_auto_match_count FROM calibration_runs WHERE run_id = ?")
      .get(res.run_id!) as { min_auto_match_precision: number; min_auto_match_count: number } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row!.min_auto_match_precision).toBe(0.75);
    expect(row!.min_auto_match_count).toBe(15);
  });

  test("proves explicit 0.99/20 rejects before any getRankedCandidates call or running DB record", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    let thrownError: Error | undefined;
    try {
      await adapter.calibrateRun({
        datasetPath,
        minAutoMatchPrecision: 0.99,
        minAutoMatchCount: 20,
        tuneAutoMatchPrecisionBuffer: 0,
        tuneAutoMatchCountBuffer: 0,
      });
    } catch (err: any) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    const msg = thrownError!.message;
    expect(msg).toContain("0.99");
    expect(msg).toContain("20");
    expect(msg).toMatch(/0\.838[89]/);

    // Assert that no retrieval / rerank calls took place
    expect(rerankCallCount).toBe(0);

    // Assert that no running DB record was created in the calibration database
    const db = openCalibrateDb(stateDir);
    const rows = db.query("SELECT count(*) as count FROM calibration_runs").get() as { count: number };
    db.close();

    expect(rows.count).toBe(0);
  });

  test("rejects impossible effective precision or recall buffer requirements in preflight", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    // 1. Effective precision > 1.0
    await expect(
      adapter.calibrateRun({
        datasetPath,
        minAutoMatchPrecision: 0.98,
        tuneAutoMatchPrecisionBuffer: 0.05,
      }),
    ).rejects.toThrow(/mathematically impossible.*effective.*precision.*1\.03/i);

    // 2. Effective delivered recall > 1.0
    await expect(
      adapter.calibrateRun({
        datasetPath,
        minDeliveredShortlistRecallAtK: 0.99,
        tuneDeliveredShortlistRecallBuffer: 0.03,
      }),
    ).rejects.toThrow(/mathematically impossible.*effective.*delivered.*recall.*1\.02/i);

    // 3. Negative buffers
    await expect(
      adapter.calibrateRun({
        datasetPath,
        tuneAutoMatchPrecisionBuffer: -0.01,
      }),
    ).rejects.toThrow(/non-negative number/i);

    await expect(
      adapter.calibrateRun({
        datasetPath,
        tuneAutoMatchCountBuffer: -1,
      }),
    ).rejects.toThrow(/non-negative integer/i);

    // 4. Non-integer count buffer
    await expect(
      adapter.calibrateRun({
        datasetPath,
        tuneAutoMatchCountBuffer: 1.5,
      }),
    ).rejects.toThrow(/non-negative integer/i);

    expect(rerankCallCount).toBe(0);
  });

  test("rejects when tune dataset is too small for effective buffered precision and count gates", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    // 20 matched tune cases in standardDataset
    // minAutoMatchCount: 15, buffer: 6 -> effective count = 21 > 20
    let thrown: Error | undefined;
    try {
      await adapter.calibrateRun({
        datasetPath,
        minAutoMatchPrecision: 0.75,
        minAutoMatchCount: 15,
        tuneAutoMatchCountBuffer: 6,
      });
    } catch (e: any) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("mathematically unattainable");
    expect(thrown!.message).toContain("21");
    expect(thrown!.message).toContain("20");
    expect(rerankCallCount).toBe(0);
  });

  test("explicitly rejects effective count exceeding tune matched cases even when precision gate is low", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    // 20 matched tune cases in standardDataset
    // minAutoMatchCount: 18, buffer: 3 -> effective count = 21 > 20
    // minAutoMatchPrecision: 0.1 -> Wilson(20, 21) is ~0.75 > 0.13 (effective precision)
    // Without an explicit count check, the Wilson check would falsely pass this impossible count.
    let thrown: Error | undefined;
    try {
      await adapter.calibrateRun({
        datasetPath,
        minAutoMatchPrecision: 0.1,
        minAutoMatchCount: 18,
        tuneAutoMatchCountBuffer: 3,
      });
    } catch (e: any) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("mathematically unattainable");
    expect(thrown!.message).toContain("effective min_auto_match_count");
    expect(thrown!.message).toContain("21");
    expect(thrown!.message).toContain("20");
    expect(rerankCallCount).toBe(0);
  });
});
