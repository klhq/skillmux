import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "../src/adapters";
import {
  openCalibrateDb,
  getCalibrationRun,
  getCalibrationObservations,
} from "../src/calibrate";
import { openIndex, toSkillRow, replaceSkills, getSkillRow } from "../src/db";
import { configure, retrieveAndRerank } from "../src/router-core";
import type { Config } from "../src/types";

describe("calibrate run incremental persistence and resume", () => {
  let tmp: string;
  let vaultDir: string;
  let stateDir: string;
  let configPath: string;
  let datasetPath: string;
  let config: Config;

  const dataset = [
    {
      query: "tune match 1",
      split: "tune" as const,
      expected_outcome: "matched" as const,
      relevant_skill_ids: ["skill-1"],
    },
    {
      query: "tune match 2",
      split: "tune" as const,
      expected_outcome: "matched" as const,
      relevant_skill_ids: ["skill-2"],
    },
    {
      query: "tune ambiguous",
      split: "tune" as const,
      expected_outcome: "ambiguous" as const,
      relevant_skill_ids: ["skill-1", "skill-2"],
    },
    {
      query: "tune no match",
      split: "tune" as const,
      expected_outcome: "no_match" as const,
      relevant_skill_ids: [],
    },
    {
      query: "test match 1",
      split: "test" as const,
      expected_outcome: "matched" as const,
      relevant_skill_ids: ["skill-1"],
    },
    {
      query: "test match 2",
      split: "test" as const,
      expected_outcome: "matched" as const,
      relevant_skill_ids: ["skill-2"],
    },
    {
      query: "test ambiguous",
      split: "test" as const,
      expected_outcome: "ambiguous" as const,
      relevant_skill_ids: ["skill-1", "skill-2"],
    },
    {
      query: "test no match",
      split: "test" as const,
      expected_outcome: "no_match" as const,
      relevant_skill_ids: [],
    },
  ];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-resume-test-"));
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
      `---\nname: skill 1\ndescription: first skill\naliases: [s1]\n---\n# skill 1\n`,
    );
    writeFileSync(
      join(vaultDir, "skill-2", "SKILL.md"),
      `---\nname: skill 2\ndescription: second skill\naliases: [s2]\n---\n# skill 2\n`,
    );

    writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

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

    // Populate index db with skills from the vault
    const indexDb = openIndex(stateDir);
    const skills = await (await import("../src/vault")).scanVault(vaultDir);
    const { ingestVault } = await import("../src/db");
    ingestVault(indexDb, skills);
    indexDb.close();
  });

  afterEach(() => {
    configure({});
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates running record and incrementally persists observations during run", async () => {
    let runIdCaptured = "";

    const executedQueries: string[] = [];

    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        executedQueries.push(query);
        return docs.map((d) => {
          if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
          if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
          if (query.includes("ambiguous")) return 0.8;
          return 0.1;
        });
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: fakeClients });

    const runRes = await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(runRes.run_id).toBeDefined();
    const runId = runRes.run_id!;

    const db = openCalibrateDb(stateDir);
    try {
      const record = getCalibrationRun(db, runId);
      expect(record).not.toBeNull();
      expect(record!.status).toBe("completed");
      expect(record!.observations).toHaveLength(dataset.length);

      const obsMap = getCalibrationObservations(db, runId);
      expect(obsMap.size).toBe(dataset.length);
    } finally {
      db.close();
    }
  });

  test("completed observations survive an interrupted/failed run", async () => {
    let count = 0;

    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        count++;
        if (count > 3) {
          throw new Error("Simulated mid-run network failure");
        }
        return docs.map(() => 0.9);
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: fakeClients });

    await expect(
      adapter.calibrateRun({
        datasetPath,
        concurrency: 1,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      }),
    ).rejects.toThrow(/Calibration requires successful hybrid retrieval|Simulated/);

    const db = openCalibrateDb(stateDir);
    try {
      // Find the running run
      const runs = db
        .query("SELECT run_id, status FROM calibration_runs WHERE status = 'running'")
        .all() as Array<{ run_id: string; status: string }>;
      expect(runs).toHaveLength(1);
      const runId = runs[0]!.run_id;

      const obsMap = getCalibrationObservations(db, runId);
      expect(obsMap.size).toBe(3); // 3 completed before failure
    } finally {
      db.close();
    }
  });

  test("resume skips completed cases and produces identical final result", async () => {
    let count = 0;
    const executedInFirstRun: string[] = [];
    const executedInSecondRun: string[] = [];

    const scoringFunction = (query: string, docs: Array<{ skill_id: string; text: string }>) =>
      docs.map((d) => {
        if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
        if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
        if (query.includes("ambiguous")) return 0.8;
        return 0.1;
      });

    // Run 1: Fail after 4 cases
    const clients1 = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        count++;
        executedInFirstRun.push(query);
        if (count > 4) {
          throw new Error("Simulated interruption");
        }
        return scoringFunction(query, docs);
      },
    };

    const adapter1 = new LocalAdapter({ configPath, clients: clients1 });

    await expect(
      adapter1.calibrateRun({
        datasetPath,
        concurrency: 1,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      }),
    ).rejects.toThrow(/Calibration requires successful hybrid retrieval|Simulated/);

    const db = openCalibrateDb(stateDir);
    let interruptedRunId = "";
    try {
      const runs = db
        .query("SELECT run_id FROM calibration_runs WHERE status = 'running'")
        .all() as Array<{ run_id: string }>;
      expect(runs).toHaveLength(1);
      interruptedRunId = runs[0]!.run_id;
    } finally {
      db.close();
    }

    // Run 2: Resume interrupted run
    const clients2 = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        executedInSecondRun.push(query);
        return scoringFunction(query, docs);
      },
    };
    const adapter2 = new LocalAdapter({ configPath, clients: clients2 });

    const resumedResult = await adapter2.calibrateRun({
      datasetPath,
      concurrency: 2,
      resumeRunId: interruptedRunId,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(resumedResult.run_id).toBe(interruptedRunId);
    expect(resumedResult.result?.status).toBe("completed");

    // Second run should only have executed the remaining 4 cases!
    expect(executedInSecondRun).toHaveLength(4);
    expect(new Set(executedInFirstRun).size + executedInSecondRun.length).toBe(dataset.length + 1); // 4 completed + 1 attempted/failed + 4 resumed
    expect(executedInFirstRun).toHaveLength(7); // 4 completed + 3 attempts (1 initial + 2 retries) for failed case

    // Uninterrupted clean run on fresh state to compare deterministic result
    const adapterUninterrupted = new LocalAdapter({ configPath, clients: clients2 });
    const uninterruptedRun = await adapterUninterrupted.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(resumedResult.result?.selected_thresholds).toEqual(
      uninterruptedRun.result?.selected_thresholds,
    );
    expect(resumedResult.result?.tune_metrics).toEqual(uninterruptedRun.result?.tune_metrics);
    expect(resumedResult.result?.test_metrics).toEqual(uninterruptedRun.result?.test_metrics);
  });

  test("resume refuses already completed runs", async () => {
    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (_q: string, docs: Array<{ skill_id: string; text: string }>) =>
        docs.map(() => 0.95),
    };
    const adapter = new LocalAdapter({ configPath, clients: fakeClients });

    const completed = await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    await expect(
      adapter.calibrateRun({
        datasetPath,
        resumeRunId: completed.run_id,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      }),
    ).rejects.toThrow(/completed/i);
  });

  test("resume rejects every fingerprint and certification-setting mismatch", async () => {
    const {
      computeCorpusFingerprint,
      createInitialCalibrationRun,
    } = await import("../src/calibrate");
    const {
      embeddingFingerprint,
      loadConfig,
      rerankerFingerprint,
    } = await import("../src/config");
    const loadedConfig = await loadConfig(configPath);
    const indexDb = openIndex(stateDir);
    const corpusFingerprint = computeCorpusFingerprint(indexDb);
    indexDb.close();
    const baseRunningRun = {
      run_id: "",
      created_at: new Date().toISOString(),
      status: "running" as const,
      reranker_fingerprint: rerankerFingerprint(loadedConfig)!,
      embedding_fingerprint: embeddingFingerprint(loadedConfig),
      corpus_fingerprint: corpusFingerprint,
      dataset_hash: createHash("sha256").update(readFileSync(datasetPath)).digest("hex"),
      candidate_limit: 5,
      min_auto_match_precision: 0.1,
      min_auto_match_count: 1,
      min_delivered_shortlist_recall_at_k: 0.95,
      min_shortlist_recall_at_5: 0.95,
      tune_auto_match_precision_buffer: 0.03,
      tune_auto_match_count_buffer: 0,
      tune_delivered_shortlist_recall_buffer: 0.02,
      recall_settings: {
        k_lexical: loadedConfig.recall.k_lexical,
        k_vector: loadedConfig.recall.k_vector,
        k_rerank: loadedConfig.recall.k_rerank ?? 50,
      },
    };
    const mismatches: Array<{
      name: string;
      expected: RegExp;
      mutate: (run: typeof baseRunningRun) => void;
    }> = [
      { name: "dataset", expected: /dataset/i, mutate: (run) => { run.dataset_hash = "different"; } },
      { name: "corpus", expected: /corpus/i, mutate: (run) => { run.corpus_fingerprint = "different"; } },
      { name: "embedding", expected: /embedding/i, mutate: (run) => { run.embedding_fingerprint = "different"; } },
      { name: "reranker", expected: /reranker/i, mutate: (run) => { run.reranker_fingerprint = "different"; } },
      { name: "candidate limit", expected: /candidate limit/i, mutate: (run) => { run.candidate_limit = 7; } },
      {
        name: "recall settings",
        expected: /recall settings/i,
        mutate: (run) => { run.recall_settings = { ...run.recall_settings, k_rerank: (run.recall_settings.k_rerank ?? 50) - 1 }; },
      },
      {
        name: "minimum precision",
        expected: /min_auto_match_precision/i,
        mutate: (run) => { run.min_auto_match_precision = 0.2; },
      },
      {
        name: "minimum match count",
        expected: /min_auto_match_count/i,
        mutate: (run) => { run.min_auto_match_count = 2; },
      },
      {
        name: "delivered shortlist recall",
        expected: /min_delivered_shortlist_recall_at_k/i,
        mutate: (run) => { run.min_delivered_shortlist_recall_at_k = 0.94; },
      },
      {
        name: "retrieval recall",
        expected: /min_retrieval_recall_at_k/i,
        mutate: (run) => { run.min_shortlist_recall_at_5 = 0.94; },
      },
      {
        name: "tune auto match precision buffer",
        expected: /tune_auto_match_precision_buffer/i,
        mutate: (run) => { run.tune_auto_match_precision_buffer = 0.05; },
      },
      {
        name: "tune auto match count buffer",
        expected: /tune_auto_match_count_buffer/i,
        mutate: (run) => { run.tune_auto_match_count_buffer = 1; },
      },
      {
        name: "tune delivered shortlist recall buffer",
        expected: /tune_delivered_shortlist_recall_buffer/i,
        mutate: (run) => { run.tune_delivered_shortlist_recall_buffer = 0.04; },
      },
    ];
    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (_q: string, docs: Array<{ skill_id: string; text: string }>) =>
        docs.map(() => 0.95),
    };
    const adapter = new LocalAdapter({ configPath, clients: fakeClients });

    for (const [index, mismatch] of mismatches.entries()) {
      const run = {
        ...baseRunningRun,
        run_id: `run-mismatch-${index}`,
        recall_settings: { ...baseRunningRun.recall_settings },
      };
      mismatch.mutate(run);
      const db = openCalibrateDb(stateDir);
      createInitialCalibrationRun(db, run);
      db.close();

      await expect(
        adapter.calibrateRun({
          datasetPath,
          resumeRunId: run.run_id,
          minAutoMatchPrecision: 0.1,
          minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
        }),
      ).rejects.toThrow(mismatch.expected);
    }
  });

  test("progress output reaches N/N, goes to stderr, and does not leak query/credential contents", async () => {
    const progressLines: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => {
      progressLines.push(String(chunk));
      return true;
    }) as any;

    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) =>
        docs.map((d) => {
          if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
          if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
          if (query.includes("ambiguous")) return 0.8;
          return 0.1;
        }),
    };
    const adapter = new LocalAdapter({ configPath, clients: fakeClients });

    try {
      const res = await adapter.calibrateRun({
        datasetPath,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      });

      expect(res.run_id).toBeDefined();
      expect(res.result?.status).toBe("completed");

      // Verify progress reached N/N
      const fullStderr = progressLines.join("");
      expect(fullStderr).toContain(`Calibration observations: ${dataset.length}/${dataset.length}`);

      // Verify no raw queries or skill content appeared in progress output
      for (const c of dataset) {
        expect(fullStderr).not.toContain(c.query);
      }
      expect(fullStderr).not.toContain("http://127.0.0.1:9");
      expect(fullStderr).not.toContain("secret");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  test("synchronizes the vault exactly once before the run and uses a frozen retrieval snapshot during calibration", async () => {
    let executedQueries = 0;
    const fakeClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        executedQueries++;
        if (executedQueries === 1) {
          // Mutate the vault directory on disk mid-run
          mkdirSync(join(vaultDir, "mid-run-skill"), { recursive: true });
          writeFileSync(
            join(vaultDir, "mid-run-skill", "SKILL.md"),
            `---\nname: mid run skill\ndescription: created mid calibration run\naliases: [mrs]\n---\n# mid run skill\n`,
          );
        }
        return docs.map((d) => {
          if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
          if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
          if (query.includes("ambiguous")) return 0.8;
          return 0.1;
        });
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: fakeClients });
    const runRes = await adapter.calibrateRun({
      datasetPath,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(runRes.run_id).toBeDefined();
    expect(runRes.result?.status).toBe("completed");
    expect(executedQueries).toBe(dataset.length);

    // During the entire calibration run across all queries, syncVaultIfNeeded was not re-executed,
    // so mid-run-skill was NOT indexed in the database.
    const indexDb = openIndex(stateDir);
    try {
      expect(getSkillRow(indexDb, "mid-run-skill")).toBeNull();
      expect(getSkillRow(indexDb, "skill-1")).not.toBeNull();
      expect(getSkillRow(indexDb, "skill-2")).not.toBeNull();
    } finally {
      indexDb.close();
    }

    // Calling normal retrieveAndRerank now triggers synchronization and discovers the new skill.
    const res = await retrieveAndRerank({ query: "mid-run-skill" });
    expect(res.candidates.some((c) => c.skill_id === "mid-run-skill")).toBe(true);

    const indexDbAfter = openIndex(stateDir);
    try {
      expect(getSkillRow(indexDbAfter, "mid-run-skill")).not.toBeNull();
    } finally {
      indexDbAfter.close();
    }
  });

  test("serializes reranker admission at calibration boundary so capacity-limited reranker succeeds under concurrency", async () => {
    let activeReranks = 0;
    let maxObservedActiveReranks = 0;
    let totalRerankCalls = 0;

    const capacityLimitedClients = {
      embed: async (texts: string[]) => {
        // Embeddings run in parallel
        await Bun.sleep(5);
        return texts.map(() => Float32Array.from([1, 0, 0]));
      },
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        totalRerankCalls++;
        activeReranks++;
        maxObservedActiveReranks = Math.max(maxObservedActiveReranks, activeReranks);
        if (activeReranks > 1) {
          activeReranks--;
          throw new Error("503 Service Unavailable (Capacity Exceeded)");
        }
        // Nonzero service latency to expose overlapping requests
        await Bun.sleep(20);
        activeReranks--;
        return docs.map((d) => {
          if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
          if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
          if (query.includes("ambiguous")) return 0.8;
          return 0.1;
        });
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: capacityLimitedClients });
    const runRes = await adapter.calibrateRun({
      datasetPath,
      concurrency: 4,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(runRes.run_id).toBeDefined();
    expect(runRes.result?.status).toBe("completed");
    expect(totalRerankCalls).toBe(dataset.length);
    expect(maxObservedActiveReranks).toBe(1);

    // Verify all observations are non-degraded and in deterministic order
    const db = openCalibrateDb(stateDir);
    try {
      const obsMap = getCalibrationObservations(db, runRes.run_id!);
      expect(obsMap.size).toBe(dataset.length);
      for (let i = 0; i < dataset.length; i++) {
        const obs = obsMap.get(i);
        expect(obs).toBeDefined();
        expect(obs!.query).toBe(dataset[i]!.query);
        expect(obs!.ranked.length).toBeGreaterThan(0);
        expect(obs!.ranked[0]!.score).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }

    // Live resolution behavior remains untouched (no serialization wrapper globally injected)
    let liveActiveReranks = 0;
    let liveMaxActiveReranks = 0;
    const liveClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async () => {
        liveActiveReranks++;
        liveMaxActiveReranks = Math.max(liveMaxActiveReranks, liveActiveReranks);
        await Bun.sleep(10);
        liveActiveReranks--;
        throw new Error("503 Service Unavailable");
      },
    };
    configure({ config: await adapter.getConfigShow().then((s) => s.effective as any), clients: liveClients });
    const [res1, res2] = await Promise.all([
      retrieveAndRerank({ query: "tune match 1" }),
      retrieveAndRerank({ query: "tune match 2" }),
    ]);
    expect(liveRes1Degraded(res1)).toBe(true);
    expect(liveRes1Degraded(res2)).toBe(true);
    expect(liveMaxActiveReranks).toBe(2);

    function liveRes1Degraded(res: any) {
      return res.retrieval === "hybrid" && res.degradation_reason === "reranker_unavailable";
    }
  });

  test("retries transient reranker_unavailable after admission for single-capacity reranker under concurrency", async () => {
    let activeReranks = 0;
    let maxObservedActiveReranks = 0;
    let totalRerankAttempts = 0;
    let transientBlipTriggered = false;

    const capacityLimitedTransientClients = {
      embed: async (texts: string[]) => {
        await Bun.sleep(5);
        return texts.map(() => Float32Array.from([1, 0, 0]));
      },
      rerank: async (query: string, docs: Array<{ skill_id: string; text: string }>) => {
        totalRerankAttempts++;
        activeReranks++;
        maxObservedActiveReranks = Math.max(maxObservedActiveReranks, activeReranks);
        if (activeReranks > 1) {
          activeReranks--;
          throw new Error("503 Service Unavailable (Capacity Exceeded)");
        }

        // Simulate an isolated remote endpoint transient blip on a later case (e.g. 5th overall rerank attempt)
        if (totalRerankAttempts === 5 && !transientBlipTriggered) {
          transientBlipTriggered = true;
          activeReranks--;
          throw new Error("503 Service Unavailable: upstream connection reset");
        }

        await Bun.sleep(20);
        activeReranks--;
        return docs.map((d) => {
          if (query.includes("match 1") && d.skill_id === "skill-1") return 0.95;
          if (query.includes("match 2") && d.skill_id === "skill-2") return 0.95;
          if (query.includes("ambiguous")) return 0.8;
          return 0.1;
        });
      },
    };

    const adapter = new LocalAdapter({ configPath, clients: capacityLimitedTransientClients });
    const runRes = await adapter.calibrateRun({
      datasetPath,
      concurrency: 4,
      minAutoMatchPrecision: 0.1,
      minRetrievalRecallAtK: 0.1,
      minDeliveredShortlistRecallAtK: 0.1,
      minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
    });

    expect(runRes.run_id).toBeDefined();
    expect(runRes.result?.status).toBe("completed");
    expect(transientBlipTriggered).toBe(true);
    // 8 dataset items + 1 retry = 9 attempts
    expect(totalRerankAttempts).toBe(dataset.length + 1);
    expect(maxObservedActiveReranks).toBe(1);

    const db = openCalibrateDb(stateDir);
    try {
      const obsMap = getCalibrationObservations(db, runRes.run_id!);
      expect(obsMap.size).toBe(dataset.length);
      for (let i = 0; i < dataset.length; i++) {
        const obs = obsMap.get(i);
        expect(obs).toBeDefined();
        expect(obs!.query).toBe(dataset[i]!.query);
        expect(obs!.ranked.length).toBeGreaterThan(0);
        expect(obs!.ranked[0]!.score).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  test("does not retry protocol errors or timeouts and fails closed after budget exceeded", async () => {
    // 1. Protocol error should not be retried
    let protocolAttempts = 0;
    const protocolClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async () => {
        protocolAttempts++;
        throw new Error("Invalid JSON response (malformed protocol)");
      },
    };
    const adapter1 = new LocalAdapter({ configPath, clients: protocolClients });
    expect(
      adapter1.calibrateRun({
        datasetPath,
        concurrency: 2,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      }),
    ).rejects.toThrow("Calibration requires successful hybrid retrieval and reranking for every query.");
    // Should fail without burning multiple retries per case
    expect(protocolAttempts).toBeLessThanOrEqual(2);

    // 2. Timeout should not be retried
    let timeoutAttempts = 0;
    const timeoutClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async () => {
        timeoutAttempts++;
        const err = new Error("Request timeout after 2000ms");
        err.name = "TimeoutError";
        throw err;
      },
    };
    const adapter2 = new LocalAdapter({ configPath, clients: timeoutClients });
    expect(
      adapter2.calibrateRun({
        datasetPath,
        concurrency: 2,
        minAutoMatchPrecision: 0.1,
        minRetrievalRecallAtK: 0.1,
        minDeliveredShortlistRecallAtK: 0.1,
        minAutoMatchCount: 1,
      tuneAutoMatchCountBuffer: 0,
      }),
    ).rejects.toThrow("Calibration requires successful hybrid retrieval and reranking for every query.");
    expect(timeoutAttempts).toBeLessThanOrEqual(2);

    // 3. Live resolution does not inherit calibration retries
    let liveAttempts = 0;
    const liveClients = {
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async () => {
        liveAttempts++;
        throw new Error("503 Service Unavailable");
      },
    };
    configure({ config: await adapter1.getConfigShow().then((s) => s.effective as any), clients: liveClients });
    const liveRes = await retrieveAndRerank({ query: "tune match 1" });
    expect(liveRes.retrieval).toBe("hybrid");
    expect(liveRes.degradation_reason).toBe("reranker_unavailable");
    expect(liveAttempts).toBe(1);
  });
});
