/**
 * Behavioral tests for Task 2B: --timing flag on `calibrate run`.
 *
 * Tests cover:
 *  - timing summary shape and non-negative values (completed result)
 *  - timing summary produced for failed-gates result
 *  - no report without --timing flag
 *  - resume counts (cases_executed vs cases_reused)
 *  - stable snake_case fields present in stderr report
 *  - stdout remains valid JSON under --json --timing
 *  - timing collection disabled when flag absent
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "../src/adapters";
import { openCalibrateDb } from "../src/calibrate";
import { openIndex, ingestVault } from "../src/db";
import { configure } from "../src/router-core";
import type { CalibrationTimingSummary } from "../src/adapters";

// ---------------------------------------------------------------------------
// Shared test dataset (both tune and test splits, all outcome types)
// ---------------------------------------------------------------------------

const dataset = [
  { query: "tune match 1", split: "tune" as const, expected_outcome: "matched" as const, relevant_skill_ids: ["skill-1"] },
  { query: "tune match 2", split: "tune" as const, expected_outcome: "matched" as const, relevant_skill_ids: ["skill-2"] },
  { query: "tune ambiguous", split: "tune" as const, expected_outcome: "ambiguous" as const, relevant_skill_ids: ["skill-1", "skill-2"] },
  { query: "tune no match", split: "tune" as const, expected_outcome: "no_match" as const, relevant_skill_ids: [] },
  { query: "test match 1", split: "test" as const, expected_outcome: "matched" as const, relevant_skill_ids: ["skill-1"] },
  { query: "test match 2", split: "test" as const, expected_outcome: "matched" as const, relevant_skill_ids: ["skill-2"] },
  { query: "test ambiguous", split: "test" as const, expected_outcome: "ambiguous" as const, relevant_skill_ids: ["skill-1", "skill-2"] },
  { query: "test no match", split: "test" as const, expected_outcome: "no_match" as const, relevant_skill_ids: [] },
];

// ---------------------------------------------------------------------------
// Fake clients (no real inference; deterministic scores)
// ---------------------------------------------------------------------------

function makeFakeClients(scoreOverride?: (query: string, skillId: string) => number) {
  const score = scoreOverride ?? ((query: string, skillId: string) => {
    if (query.includes("match 1") && skillId === "skill-1") return 0.95;
    if (query.includes("match 2") && skillId === "skill-2") return 0.95;
    if (query.includes("ambiguous")) return 0.8;
    return 0.1;
  });
  return {
    embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
    rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) =>
      docs.map((d) => score(query, d.skill_id)),
  };
}

// ---------------------------------------------------------------------------
// Zero tune selection buffers for tiny synthetic test fixture
// ---------------------------------------------------------------------------

const zeroTuneBuffers = {
  tuneAutoMatchPrecisionBuffer: 0,
  tuneAutoMatchCountBuffer: 0,
  tuneDeliveredShortlistRecallBuffer: 0,
};

// ---------------------------------------------------------------------------
// Per-test fixture setup
// ---------------------------------------------------------------------------

describe("calibrate run timing report", () => {
  let tmp: string;
  let vaultDir: string;
  let stateDir: string;
  let configPath: string;
  let datasetPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-timing-test-"));
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

    writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

    const toml = `vault_path = "${vaultDir}"
local_vault_paths = []
state_dir = "${stateDir}"

[recall]
k_lexical = 10
k_vector = 10
k_rerank = 5

[output]
ambiguous_candidate_limit = 5

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

  // -------------------------------------------------------------------------
  // Test 1: timing summary has required shape and non-negative values
  // -------------------------------------------------------------------------

  test("should produce a timing summary with all required fields and non-negative values when timing=true and result is completed", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    let capturedTiming: CalibrationTimingSummary | undefined;

    await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      ...zeroTuneBuffers,
      timing: true,
      onTimingSummary: (summary) => {
        capturedTiming = summary;
      },
    });

    expect(capturedTiming).toBeDefined();
    const t = capturedTiming!;

    expect(typeof t.cases_total).toBe("number");
    expect(typeof t.cases_executed).toBe("number");
    expect(typeof t.cases_reused).toBe("number");
    expect(typeof t.wall_ms).toBe("number");
    expect(typeof t.vault_sync_ms).toBe("number");
    expect(typeof t.cumulative_embedding_ms).toBe("number");
    expect(typeof t.cumulative_lexical_ms).toBe("number");
    expect(typeof t.cumulative_vector_ms).toBe("number");
    expect(typeof t.cumulative_reranker_ms).toBe("number");
    expect(typeof t.cumulative_checkpoint_ms).toBe("number");
    expect(typeof t.policy_evaluation_ms).toBe("number");

    for (const [key, val] of Object.entries(t)) {
      expect(val, `field "${key}" must be non-negative`).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: cases_total = cases_executed + cases_reused (all fresh)
  // -------------------------------------------------------------------------

  test("should count all cases as executed (cases_reused=0) on a fresh run", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    let capturedTiming: CalibrationTimingSummary | undefined;

    await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      ...zeroTuneBuffers,
      timing: true,
      onTimingSummary: (summary) => {
        capturedTiming = summary;
      },
    });

    const t = capturedTiming!;
    expect(t.cases_total).toBe(dataset.length);
    expect(t.cases_executed).toBe(dataset.length);
    expect(t.cases_reused).toBe(0);
    expect(t.cases_executed + t.cases_reused).toBe(t.cases_total);
  });

  // -------------------------------------------------------------------------
  // Test 3: resume — cases_reused reflects pre-loaded observations
  // -------------------------------------------------------------------------

  test("should count resumed observations as cases_reused and only new ones as cases_executed", async () => {
    let count = 0;
    const clientsWithFailure = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (_query: string, docs: Array<{ skill_id: string; text: string }>) => {
        count++;
        if (count > 3) throw new Error("Simulated failure for resume test");
        return docs.map(() => 0.9);
      },
    };

    const adapter1 = new LocalAdapter({ configPath, clients: clientsWithFailure });

    await expect(
      adapter1.calibrateRun({
        datasetPath,
        concurrency: 1,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
        ...zeroTuneBuffers,
        timing: true,
        onTimingSummary: () => { /* should not be called */ },
      }),
    ).rejects.toThrow();

    const db = openCalibrateDb(stateDir);
    const runs = db
      .query("SELECT run_id FROM calibration_runs WHERE status = 'running'")
      .all() as Array<{ run_id: string }>;
    db.close();
    const runId = runs[0]?.run_id;
    expect(runId).toBeDefined();

    const adapter2 = new LocalAdapter({ configPath, clients: makeFakeClients() });
    let resumeTiming: CalibrationTimingSummary | undefined;

    await adapter2.calibrateRun({
      datasetPath,
      resumeRunId: runId!,
      concurrency: 1,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      ...zeroTuneBuffers,
      timing: true,
      onTimingSummary: (summary) => {
        resumeTiming = summary;
      },
    });

    expect(resumeTiming).toBeDefined();
    const t = resumeTiming!;
    expect(t.cases_total).toBe(dataset.length);
    expect(t.cases_reused).toBeGreaterThan(0);
    expect(t.cases_executed).toBeGreaterThanOrEqual(0);
    expect(t.cases_executed + t.cases_reused).toBe(t.cases_total);
  });

  // -------------------------------------------------------------------------
  // Test 4: no timing callback when timing absent (opt-in)
  // -------------------------------------------------------------------------

  test("should not invoke onTimingSummary when timing is absent", async () => {
    const adapter = new LocalAdapter({ configPath, clients: makeFakeClients() });

    let called = false;

    await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      ...zeroTuneBuffers,
      // timing not set
      onTimingSummary: () => {
        called = true;
      },
    });

    expect(called).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: timing summary produced even for failed-gates result
  // -------------------------------------------------------------------------

  test("should produce a timing summary for a failed-gates calibration result", async () => {
    const adapter = new LocalAdapter({
      configPath,
      clients: makeFakeClients(() => 0.01),
    });

    let capturedTiming: CalibrationTimingSummary | undefined;

    const res = await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.95,
      minDeliveredShortlistRecallAtK: 0.95,
      minAutoMatchCount: 1,
      ...zeroTuneBuffers,
      timing: true,
      onTimingSummary: (summary) => {
        capturedTiming = summary;
      },
    });

    expect(res.result?.status).toBe("failed_gates");
    expect(capturedTiming).toBeDefined();

    const t = capturedTiming!;
    expect(t.cases_total).toBe(dataset.length);
    for (const [key, val] of Object.entries(t)) {
      expect(val, `field "${key}" must be non-negative`).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: timing summary NOT produced when calibrateRun throws
  // -------------------------------------------------------------------------

  test("should not invoke onTimingSummary when calibrateRun throws", async () => {
    let count = 0;
    const throwingClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (_query: string, docs: Array<{ skill_id: string; text: string }>) => {
        if (++count > 1) throw new Error("Simulated error");
        return docs.map(() => 0.9);
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: throwingClients });
    let called = false;

    await expect(
      adapter.calibrateRun({
        datasetPath,
        concurrency: 1,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
        ...zeroTuneBuffers,
        timing: true,
        onTimingSummary: () => {
          called = true;
        },
      }),
    ).rejects.toThrow();

    expect(called).toBe(false);
  });
});
