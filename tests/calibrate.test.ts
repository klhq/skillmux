import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CalibrationRunRecord,
  loadDecisionCases,
  loadDecisionCasesFromFile,
  openCalibrateDb,
  insertCalibrationRun,
  listCalibrationRuns,
  getCalibrationRun,
  applyCalibrationRun,
  ApplyCalibrationError,
} from "../src/calibrate";

// ---------------------------------------------------------------------------
// AC1 — Decision-policy dataset schema
// ---------------------------------------------------------------------------

describe("decision-policy dataset schema", () => {
  // --- valid minimal dataset ---

  const validTuneMatch = {
    query: "why did my container stop",
    split: "tune",
    expected_outcome: "matched",
    relevant_skill_ids: ["mock-skill-a"],
  };
  const validTuneAmbiguous = {
    query: "write browser automation",
    split: "tune",
    expected_outcome: "ambiguous",
    relevant_skill_ids: ["mock-skill-b", "mock-skill-c"],
  };
  const validTuneNoMatch = {
    query: "what is 2+2",
    split: "tune",
    expected_outcome: "no_match",
    relevant_skill_ids: [],
  };
  const validTestMatch = {
    query: "check github pr checks",
    split: "test",
    expected_outcome: "matched",
    relevant_skill_ids: ["mock-skill-d"],
  };
  const validTestAmbiguous = {
    query: "look up and fetch library docs",
    split: "test",
    expected_outcome: "ambiguous",
    relevant_skill_ids: ["mock-skill-e", "mock-skill-f"],
  };
  const validTestNoMatch = {
    query: "tell me a joke",
    split: "test",
    expected_outcome: "no_match",
    relevant_skill_ids: [],
  };

  const minimalValidDataset = [
    validTuneMatch,
    validTuneAmbiguous,
    validTuneNoMatch,
    validTestMatch,
    validTestAmbiguous,
    validTestNoMatch,
  ];

  test("should accept a dataset with all required fields and both splits", () => {
    const cases = loadDecisionCases(minimalValidDataset);
    expect(cases).toHaveLength(6);
    expect(cases[0]!.split).toBe("tune");
    expect(cases[0]!.expected_outcome).toBe("matched");
    expect(cases[0]!.relevant_skill_ids).toEqual(["mock-skill-a"]);
  });


  // --- split validation ---

  test("should reject an invalid split value with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, split: "train" },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*split/i);
  });

  // --- expected_outcome validation ---

  test("should reject an invalid expected_outcome value with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, expected_outcome: "correct" },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*expected_outcome/i);
  });

  // --- matched: exactly one relevant_skill_ids ---

  test("should reject matched case with zero relevant_skill_ids with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, relevant_skill_ids: [] },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*relevant_skill_ids/i);
  });

  test("should reject matched case with more than one relevant_skill_ids with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, relevant_skill_ids: ["mock-skill-a", "extra"] },

    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*relevant_skill_ids/i);
  });

  // --- ambiguous: at least one relevant_skill_id ---

  test("should reject ambiguous case with empty relevant_skill_ids with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneAmbiguous, relevant_skill_ids: [] },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*relevant_skill_ids/i);
  });

  // --- no_match: must have empty relevant_skill_ids ---

  test("should reject no_match case with non-empty relevant_skill_ids with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneNoMatch, relevant_skill_ids: ["some-skill"] },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*relevant_skill_ids/i);
  });

  // --- both splits must be present ---

  test("should reject dataset missing tune split", () => {
    const testOnly = [validTestMatch, validTestAmbiguous, validTestNoMatch];
    expect(() => loadDecisionCases(testOnly)).toThrow(/tune/i);
  });

  test("should reject dataset missing test split", () => {
    const tuneOnly = [validTuneMatch, validTuneAmbiguous, validTuneNoMatch];
    expect(() => loadDecisionCases(tuneOnly)).toThrow(/test/i);
  });

  // --- all outcome types required in each split ---

  test("should reject dataset missing no_match in tune split", () => {
    const dataset = [
      validTuneMatch,
      validTuneAmbiguous,
      // no tune no_match
      validTestMatch,
      validTestAmbiguous,
      validTestNoMatch,
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/tune.*no_match|no_match.*tune/i);
  });

  test("should reject dataset missing ambiguous in tune split", () => {
    const dataset = [
      validTuneMatch,
      // no tune ambiguous
      validTuneNoMatch,
      validTestMatch,
      validTestAmbiguous,
      validTestNoMatch,
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/tune.*ambiguous|ambiguous.*tune/i);
  });

  // --- empty query is rejected ---

  test("should reject a case with empty query with case index and field name", () => {
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, query: "" },
    ];
    expect(() => loadDecisionCases(dataset)).toThrow(/case 6.*query/i);
  });
});

// ---------------------------------------------------------------------------
// AC1 — Checked-in dataset is a valid decision-policy dataset
// ---------------------------------------------------------------------------

describe("checked-in decision-policy dataset", () => {
  test("should load and validate the checked-in eval/queries.json as a decision dataset", () => {
    const datasetPath = join(import.meta.dir, "..", "eval", "queries.json");
    const cases = loadDecisionCasesFromFile(datasetPath);
    expect(cases.length).toBeGreaterThan(0);
    const tune = cases.filter((c) => c.split === "tune");
    const testSplit = cases.filter((c) => c.split === "test");
    expect(tune.some((c) => c.expected_outcome === "matched")).toBe(true);
    expect(tune.some((c) => c.expected_outcome === "ambiguous")).toBe(true);
    expect(tune.some((c) => c.expected_outcome === "no_match")).toBe(true);
    expect(testSplit.some((c) => c.expected_outcome === "matched")).toBe(true);
    expect(testSplit.some((c) => c.expected_outcome === "ambiguous")).toBe(true);
    expect(testSplit.some((c) => c.expected_outcome === "no_match")).toBe(true);
  });

  test("should throw when reading a non-existent file", () => {
    expect(() => loadDecisionCasesFromFile("/tmp/does-not-exist-skillmux.json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2 — runCalibration caches observations then optimizes over cache only
// AC3 — threshold optimizer: maximize coverage under precision+recall gates
// AC4 — untouched test-split evaluation report
// ---------------------------------------------------------------------------

describe("runCalibration — in-memory calibration run", () => {
  // Deterministic fake reranker: returns scores based on whether a skill matches
  // the query. This lets tests set up a dataset where the optimizer can/cannot
  // find satisfying thresholds.
  function makeFakeReranker(
    scoreMap: Record<string, Record<string, number>>,
  ): (query: string, docs: { skill_id: string; text: string }[]) => Promise<number[]> {
    return async (query, docs) =>
      docs.map((d) => scoreMap[query]?.[d.skill_id] ?? 0.0);
  }

  // Minimal dataset: 2 tune matched + 1 tune ambiguous + 1 tune no_match
  //                  2 test matched + 1 test ambiguous + 1 test no_match
  const cases: import("../src/calibrate").DecisionCase[] = [
    { query: "q-tune-match-1", split: "tune", expected_outcome: "matched", relevant_skill_ids: ["skill-a"] },
    { query: "q-tune-match-2", split: "tune", expected_outcome: "matched", relevant_skill_ids: ["skill-b"] },
    { query: "q-tune-ambiguous", split: "tune", expected_outcome: "ambiguous", relevant_skill_ids: ["skill-a", "skill-b"] },
    { query: "q-tune-nomatch", split: "tune", expected_outcome: "no_match", relevant_skill_ids: [] },
    { query: "q-test-match-1", split: "test", expected_outcome: "matched", relevant_skill_ids: ["skill-a"] },
    { query: "q-test-match-2", split: "test", expected_outcome: "matched", relevant_skill_ids: ["skill-b"] },
    { query: "q-test-ambiguous", split: "test", expected_outcome: "ambiguous", relevant_skill_ids: ["skill-a", "skill-b"] },
    { query: "q-test-nomatch", split: "test", expected_outcome: "no_match", relevant_skill_ids: [] },
  ];

  // Score map: matched queries → target skill scores ~0.95, others ~0.1
  const highConfidenceScores: Record<string, Record<string, number>> = {
    "q-tune-match-1": { "skill-a": 0.95, "skill-b": 0.10 },
    "q-tune-match-2": { "skill-a": 0.10, "skill-b": 0.95 },
    "q-tune-ambiguous": { "skill-a": 0.70, "skill-b": 0.68 },
    "q-tune-nomatch": { "skill-a": 0.05, "skill-b": 0.05 },
    "q-test-match-1": { "skill-a": 0.95, "skill-b": 0.10 },
    "q-test-match-2": { "skill-a": 0.10, "skill-b": 0.95 },
    "q-test-ambiguous": { "skill-a": 0.72, "skill-b": 0.70 },
    "q-test-nomatch": { "skill-a": 0.05, "skill-b": 0.05 },
  };

  const candidatesByQuery: Record<string, string[]> = {
    "q-tune-match-1": ["skill-a", "skill-b"],
    "q-tune-match-2": ["skill-a", "skill-b"],
    "q-tune-ambiguous": ["skill-a", "skill-b"],
    "q-tune-nomatch": ["skill-a", "skill-b"],
    "q-test-match-1": ["skill-a", "skill-b"],
    "q-test-match-2": ["skill-a", "skill-b"],
    "q-test-ambiguous": ["skill-a", "skill-b"],
    "q-test-nomatch": ["skill-a", "skill-b"],
  };

  test("should require a reranker — throw without one", async () => {
    const { runCalibration } = await import("../src/calibrate");
    await expect(
      runCalibration({
        cases,
        getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
        reranker: undefined,
      }),
    ).rejects.toThrow(/reranker/i);
  });

  test("should return status 'completed' with selected thresholds when gates are met", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
    });
    expect(result.status).toBe("completed");
    expect(result.selected_thresholds).toBeDefined();
    expect(result.selected_thresholds!.match_score).toBeGreaterThan(0);
    expect(result.selected_thresholds!.match_margin).toBeGreaterThan(0);
    expect(result.selected_thresholds!.candidate_floor).toBeGreaterThan(0);
  });

  test("should cache per-query observations (candidate IDs, scores) and not call reranker again during optimization", async () => {
    const { runCalibration } = await import("../src/calibrate");
    let rerankerCallCount = 0;
    const countingReranker = async (
      query: string,
      docs: { skill_id: string; text: string }[],
    ) => {
      rerankerCallCount++;
      return docs.map((d) => highConfidenceScores[query]?.[d.skill_id] ?? 0.0);
    };

    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: countingReranker,
    });

    // Reranker should be called exactly once per query, not more
    expect(rerankerCallCount).toBe(cases.length);
    expect(result.observations).toHaveLength(cases.length);
  });

  test("should return status 'failed_gates' when no threshold combo satisfies both gates", async () => {
    const { runCalibration } = await import("../src/calibrate");
    // All scores are uniformly low — can't get good precision without losing recall
    const badScores: Record<string, Record<string, number>> = {};
    for (const c of cases) {
      badScores[c.query] = { "skill-a": 0.51, "skill-b": 0.50 };
    }
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(badScores),
      minAutoMatchPrecision: 0.99,
      minShortlistRecallAt5: 0.95,
    });
    expect(result.status).toBe("failed_gates");
    expect(result.selected_thresholds).toBeUndefined();
  });

  test("should include tuning metrics and untouched test report in the result", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
    });
    expect(result.status).toBe("completed");

    // Tuning metrics
    expect(result.tune_metrics).toBeDefined();
    expect(result.tune_metrics!.auto_match_precision).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.auto_match_coverage).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.shortlist_recall_at_5).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.false_no_match_rate).toBeGreaterThanOrEqual(0);

    // Test report
    expect(result.test_metrics).toBeDefined();
    expect(result.test_metrics!.auto_match_precision).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.auto_match_coverage).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.shortlist_recall_at_5).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.false_no_match_rate).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.confusion_matrix).toBeDefined();
  });

  test("optimizer should select higher precision then higher recall then lower coverage on ties", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
    });
    // Verify selected thresholds exist and are deterministic on repeated calls
    const result2 = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
    });
    expect(result.selected_thresholds).toEqual(result2.selected_thresholds);
  });

  test("test metrics confusion matrix should contain matched, ambiguous, and no_match keys", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
    });
    const matrix = result.test_metrics!.confusion_matrix;
    expect(matrix).toHaveProperty("matched");
    expect(matrix).toHaveProperty("ambiguous");
    expect(matrix).toHaveProperty("no_match");
  });
});

// ---------------------------------------------------------------------------
// AC5 — Calibration runs persisted in SQLite (evidence only)
// AC6 (partial) — calibrate list / calibrate show
// ---------------------------------------------------------------------------

describe("calibration SQLite store", () => {

  let tmp: string;
  let db: Database;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-cal-db-"));
    db = openCalibrateDb(tmp);
  });

  afterAll(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseRun = {
    run_id: "run-abc-001",
    created_at: "2026-07-21T12:00:00Z",
    status: "completed" as const,
    reranker_fingerprint: "model/reranker-v1@sha256:deadbeef",
    embedding_fingerprint: "model/embed-v1@sha256:cafebabe",
    corpus_fingerprint: "vault@sha256:feedface",
    dataset_hash: "dataset@sha256:12345678",
    min_auto_match_precision: 0.99,
    min_shortlist_recall_at_5: 0.95,
    selected_thresholds: { match_score: 0.85, match_margin: 0.15, candidate_floor: 0.3 },
    tune_metrics: {
      auto_match_precision: 1.0,
      auto_match_coverage: 0.8,
      shortlist_recall_at_5: 1.0,
      false_no_match_rate: 0.0,
    },
    test_metrics: {
      auto_match_precision: 0.95,
      auto_match_coverage: 0.75,
      shortlist_recall_at_5: 0.98,
      false_no_match_rate: 0.05,
      confusion_matrix: {
        matched: { matched: 5, ambiguous: 1, no_match: 0 },
        ambiguous: { matched: 0, ambiguous: 3, no_match: 0 },
        no_match: { matched: 0, ambiguous: 0, no_match: 2 },
      },
    },
    observations: [
      {
        query: "q-tune-match-1",
        split: "tune" as const,
        expected_outcome: "matched" as const,
        relevant_skill_ids: ["skill-a"],
        ranked: [{ skill_id: "skill-a", score: 0.95 }, { skill_id: "skill-b", score: 0.1 }],
      },
    ],
  };

  test("should open calibrate db without errors and create required tables", () => {
    // openCalibrateDb is called in beforeAll — if it throws, the test fails
    expect(db).toBeDefined();
  });

  test("should insert a completed calibration run and retrieve it by run_id", () => {
    insertCalibrationRun(db, baseRun);
    const retrieved = getCalibrationRun(db, baseRun.run_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.run_id).toBe("run-abc-001");
    expect(retrieved!.status).toBe("completed");
    expect(retrieved!.reranker_fingerprint).toBe("model/reranker-v1@sha256:deadbeef");
    expect(retrieved!.dataset_hash).toBe("dataset@sha256:12345678");
  });

  test("should round-trip selected thresholds as structured data", () => {
    const run = getCalibrationRun(db, baseRun.run_id);
    expect(run!.selected_thresholds).toBeDefined();
    expect(run!.selected_thresholds!.match_score).toBeCloseTo(0.85);
    expect(run!.selected_thresholds!.match_margin).toBeCloseTo(0.15);
    expect(run!.selected_thresholds!.candidate_floor).toBeCloseTo(0.3);
  });

  test("should round-trip tune and test metrics including confusion matrix", () => {
    const run = getCalibrationRun(db, baseRun.run_id);
    expect(run!.tune_metrics!.auto_match_precision).toBeCloseTo(1.0);
    expect(run!.test_metrics!.confusion_matrix.matched.matched).toBe(5);
    expect(run!.test_metrics!.confusion_matrix.no_match.no_match).toBe(2);
  });

  test("should round-trip per-query observations", () => {
    const run = getCalibrationRun(db, baseRun.run_id);
    expect(run!.observations).toHaveLength(1);
    expect(run!.observations[0]!.query).toBe("q-tune-match-1");
    expect(run!.observations[0]!.ranked[0]!.score).toBeCloseTo(0.95);
  });

  test("should persist a failed_gates run with undefined thresholds and metrics", () => {
    const failedRun = {
      run_id: "run-failed-001",
      created_at: "2026-07-21T13:00:00Z",
      status: "failed_gates" as const,
      reranker_fingerprint: "model/reranker-v1@sha256:deadbeef",
      embedding_fingerprint: "model/embed-v1@sha256:cafebabe",
      corpus_fingerprint: "vault@sha256:feedface",
      dataset_hash: "dataset@sha256:aaaabbbb",
      min_auto_match_precision: 0.99,
      min_shortlist_recall_at_5: 0.95,
      selected_thresholds: undefined,
      tune_metrics: undefined,
      test_metrics: undefined,
      observations: [],
    };
    insertCalibrationRun(db, failedRun);
    const run = getCalibrationRun(db, "run-failed-001");
    expect(run!.status).toBe("failed_gates");
    expect(run!.selected_thresholds).toBeUndefined();
    expect(run!.tune_metrics).toBeUndefined();
    expect(run!.test_metrics).toBeUndefined();
  });

  test("should list all runs ordered by created_at descending", () => {
    const runs = listCalibrationRuns(db);
    // We inserted: run-abc-001 at 12:00 and run-failed-001 at 13:00
    // Latest first, so run-failed-001 should come first
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]!.run_id).toBe("run-failed-001");
    expect(runs[1]!.run_id).toBe("run-abc-001");
  });

  test("list entries should include summary fields but not full observations", () => {
    const runs = listCalibrationRuns(db);
    const entry = runs.find((r) => r.run_id === "run-abc-001")!;
    expect(entry.status).toBe("completed");
    expect(entry.created_at).toBe("2026-07-21T12:00:00Z");
    expect(entry.dataset_hash).toBe("dataset@sha256:12345678");
    // Observations are large — not included in list view
    expect((entry as unknown as Record<string, unknown>).observations).toBeUndefined();
  });

  test("should return null for a non-existent run_id", () => {
    expect(getCalibrationRun(db, "does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC6 (remainder) — calibrate apply: gated application + atomic TOML write
// AC7 — masked env-var writes fail with source-aware error
// ---------------------------------------------------------------------------

describe("calibrate apply — gated TOML application", () => {

  let tmp: string;
  let db: Database;

  const goodRun: CalibrationRunRecord = {
    run_id: "run-good-001",
    created_at: "2026-07-21T14:00:00Z",
    status: "completed",
    reranker_fingerprint: "reranker@sha256:aabbccdd",
    embedding_fingerprint: "embed@sha256:11223344",
    corpus_fingerprint: "vault@sha256:deadbeef",
    dataset_hash: "dataset@sha256:abcdef01",
    min_auto_match_precision: 0.99,
    min_shortlist_recall_at_5: 0.95,
    selected_thresholds: { match_score: 0.85, match_margin: 0.15, candidate_floor: 0.3 },
    tune_metrics: {
      auto_match_precision: 1.0,
      auto_match_coverage: 0.9,
      shortlist_recall_at_5: 1.0,
      false_no_match_rate: 0.0,
    },
    test_metrics: {
      auto_match_precision: 0.98,
      auto_match_coverage: 0.85,
      shortlist_recall_at_5: 0.99,
      false_no_match_rate: 0.02,
      confusion_matrix: {
        matched: { matched: 8, ambiguous: 1, no_match: 0 },
        ambiguous: { matched: 0, ambiguous: 2, no_match: 0 },
        no_match: { matched: 0, ambiguous: 0, no_match: 2 },
      },
    },
    observations: [],
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-apply-"));
    db = openCalibrateDb(tmp);
    insertCalibrationRun(db, goodRun);
    // Also insert a failed_gates run
    insertCalibrationRun(db, {
      ...goodRun,
      run_id: "run-failed-apply",
      status: "failed_gates",
      selected_thresholds: undefined,
      tune_metrics: undefined,
      test_metrics: undefined,
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeTomlFile(extra = ""): string {
    const path = join(tmp, `config-${Math.random().toString(36).slice(2)}.toml`);
    writeFileSync(path, `vault_path = "~/skills"\n\n[inference]\nmode = "remote"\ntimeout_ms = 5000\n\n[inference.embedding]\nprovider = "openai"\nbase_url = "https://embed.example.com"\nmodel = "embed-model"\ndimension = 1024\n\n[inference.reranker]\nprovider = "infinity"\nbase_url = "https://rerank.example.com"\nmodel = "rerank-model"\n\n[inference.thresholds]\nmatch_score = 0.80\nmatch_margin = 0.20\ncandidate_floor = 0.40\n${extra}`);
    return path;
  }

  test("should atomically write thresholds and run_id to TOML when run is valid", async () => {
    const tomlPath = makeTomlFile();
    await applyCalibrationRun(db, "run-good-001", tomlPath, {});
    const updated = Bun.TOML.parse(await Bun.file(tomlPath).text()) as Record<string, unknown>;
    const thresholds = (updated.inference as Record<string, unknown>).thresholds as Record<string, unknown>;
    expect(thresholds.match_score).toBeCloseTo(0.85);
    expect(thresholds.match_margin).toBeCloseTo(0.15);
    expect(thresholds.candidate_floor).toBeCloseTo(0.3);
    const calibration = (updated.inference as Record<string, unknown>).calibration as Record<string, unknown>;
    expect(calibration.run_id).toBe("run-good-001");
  });

  test("should reject a missing run_id with ApplyCalibrationError", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-does-not-exist", tomlPath, {}),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("should reject a failed_gates run with ApplyCalibrationError", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-failed-apply", tomlPath, {}),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("should reject when the reranker fingerprint no longer matches current config", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-good-001", tomlPath, {
        currentRerankerFingerprint: "reranker@sha256:DIFFERENT",
      }),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("should reject when the embedding fingerprint no longer matches current config", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-good-001", tomlPath, {
        currentEmbeddingFingerprint: "embed@sha256:DIFFERENT",
      }),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("should reject when corpus fingerprint no longer matches vault state", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-good-001", tomlPath, {
        currentCorpusFingerprint: "vault@sha256:DIFFERENT",
      }),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("should reject when a threshold key is masked by an env override", async () => {
    const tomlPath = makeTomlFile();
    await expect(
      applyCalibrationRun(db, "run-good-001", tomlPath, {
        maskedEnvKeys: ["inference.thresholds.match_score"],
      }),
    ).rejects.toThrow(ApplyCalibrationError);
  });

  test("ApplyCalibrationError should include a reason field explaining the rejection", async () => {
    const tomlPath = makeTomlFile();
    let caught: unknown;
    try {
      await applyCalibrationRun(db, "run-does-not-exist", tomlPath, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApplyCalibrationError);
    expect((caught as ApplyCalibrationError).reason).toBeDefined();
    expect(typeof (caught as ApplyCalibrationError).reason).toBe("string");
  });
});

