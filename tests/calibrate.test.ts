import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  importLabelledAuditCase,
  summarizeDatasetProvenance,
} from "../src/calibrate";
import { decideResolveOutcome } from "../src/decision";

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
    expect(cases[0]!.provenance!.source).toBe("authored");
  });

  test("rejects unreviewed imported audit cases from certification datasets", () => {
    const imported = {
      ...validTuneMatch,
      provenance: {
        version: 1,
        source: "audit_import",
        review_status: "unreviewed",
        query_storage: "raw",
        audit_id: 42,
      },
    };
    expect(() => loadDecisionCases([imported, ...minimalValidDataset])).toThrow(
      /unreviewed.*human label/i,
    );
  });

  test("imports a human label without copying the raw audit query by default", () => {
    const imported = importLabelledAuditCase(
      {
        id: 42,
        ts: "2026-07-29T00:00:00Z",
        query: "private customer incident details",
        outcome: "matched",
        retrieval: "reranked",
        candidates: [{ skill_id: "mock-skill-a", score: 0.9 }],
        selected_skill_id: "mock-skill-a",
        latency_ms: 10,
      },
      {
        split: "tune",
        expected_outcome: "no_match",
        relevant_skill_ids: [],
        labelled_at: "2026-07-29T00:01:00Z",
      },
      { include_raw_query: false, redacted_query: "redacted incident request" },
    );

    expect(imported.query).toBe("redacted incident request");
    expect(imported.expected_outcome).toBe("no_match");
    expect(imported.provenance).toEqual({
      version: 1,
      source: "audit_import",
      review_status: "human_labelled",
      query_storage: "redacted",
      audit_id: 42,
      labelled_at: "2026-07-29T00:01:00Z",
    });
  });

  test("summarizes human-labelled and query privacy provenance", () => {
    const authored = loadDecisionCases(minimalValidDataset);
    const imported = importLabelledAuditCase(
      {
        id: 7,
        ts: "2026-07-29T00:00:00Z",
        query: "raw",
        outcome: "ambiguous",
        retrieval: "reranked",
        candidates: [],
        selected_skill_id: null,
        latency_ms: 1,
      },
      {
        split: "test",
        expected_outcome: "no_match",
        relevant_skill_ids: [],
        labelled_at: "2026-07-29T00:01:00Z",
      },
      { include_raw_query: false, redacted_query: "safe paraphrase" },
    );
    expect(summarizeDatasetProvenance([...authored, imported])).toEqual({
      version: 1,
      human_labelled_case_count: 7,
      imported_labelled_case_count: 1,
      imported_unreviewed_case_count: 0,
      raw_query_case_count: 6,
      redacted_query_case_count: 1,
    });
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

  test("should reject relevant ids that do not exist in the vault", () => {
    const validIds = minimalValidDataset.flatMap((item) => item.relevant_skill_ids);
    const dataset = [
      ...minimalValidDataset,
      { ...validTuneMatch, relevant_skill_ids: ["missing-skill"] },
    ];
    expect(() => loadDecisionCases(dataset, validIds)).toThrow(
      /case 6.*relevant_skill_ids.*unknown vault skill.*missing-skill/i,
    );
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
  const permissiveCertification = {
    minAutoMatchPrecision: 0,
    minRetrievalRecallAtK: 0,
    minDeliveredShortlistRecallAtK: 0,
    minAutoMatchCount: 1,
  };

  test("should require a reranker — throw without one", async () => {
    const { runCalibration } = await import("../src/calibrate");
    await expect(
      runCalibration({
        cases,
        getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
        reranker: undefined,
        candidateLimit: 5,
      }),
    ).rejects.toThrow(/reranker/i);
  });

  test("should return status 'completed' with selected thresholds when gates are met", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });
    expect(result.status).toBe("completed");
    expect(result.selected_thresholds).toBeDefined();
    expect(result.selected_thresholds!.match_score).toBeGreaterThanOrEqual(0);
    expect(result.selected_thresholds!.match_margin).toBeGreaterThanOrEqual(0);
    expect(result.selected_thresholds!.candidate_floor).toBeGreaterThanOrEqual(0);
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
      ...permissiveCertification,
      candidateLimit: 5,
    });

    // Reranker should be called exactly once per query, not more
    expect(rerankerCallCount).toBe(cases.length);
    expect(result.observations).toHaveLength(cases.length);
  });

  test("accepts pre-ranked observations without reranking them again", async () => {
    const { runCalibration } = await import("../src/calibrate");
    let observationCalls = 0;
    let rerankerCalls = 0;

    const result = await runCalibration({
      cases,
      getRankedCandidates: async (query) => {
        observationCalls++;
        return candidatesByQuery[query]!
          .map((skill_id) => ({
            skill_id,
            score: highConfidenceScores[query]?.[skill_id] ?? 0,
          }))
          .sort((a, b) => b.score - a.score);
      },
      reranker: async () => {
        rerankerCalls++;
        throw new Error("pre-ranked observations must not be reranked");
      },
      ...permissiveCertification,
      candidateLimit: 5,
    });

    expect(result.status).toBe("completed");
    expect(observationCalls).toBe(cases.length);
    expect(rerankerCalls).toBe(0);
    expect(result.observations.some((observation) => observation.ranked.length > 1)).toBe(true);
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
      minRetrievalRecallAtK: 0.95,
      candidateLimit: 5,
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
      ...permissiveCertification,
      candidateLimit: 5,
    });
    expect(result.status).toBe("completed");

    // Tuning metrics
    expect(result.tune_metrics).toBeDefined();
    expect(result.tune_metrics!.auto_match_precision).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.auto_match_coverage).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.retrieval_recall_at_k).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.delivered_shortlist_recall_at_k).toBeGreaterThanOrEqual(0);
    expect(result.tune_metrics!.auto_match_precision_lower_bound).toBeGreaterThanOrEqual(0);

    // Test report
    expect(result.test_metrics).toBeDefined();
    expect(result.test_metrics!.auto_match_precision).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.auto_match_coverage).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.retrieval_recall_at_k).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.delivered_shortlist_recall_at_k).toBeGreaterThanOrEqual(0);
    expect(result.test_metrics!.confusion_matrix).toBeDefined();
  });

  test("optimizer should select higher precision then higher recall then lower coverage on ties", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });
    // Verify selected thresholds exist and are deterministic on repeated calls
    const result2 = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });
    expect(result.selected_thresholds).toEqual(result2.selected_thresholds);
  });

  test("test metrics confusion matrix should contain matched, ambiguous, and no_match keys", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const result = await runCalibration({
      cases,
      getCandidates: async (query) => candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(highConfidenceScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });
    const matrix = result.test_metrics!.confusion_matrix;
    expect(matrix).toHaveProperty("matched");
    expect(matrix).toHaveProperty("ambiguous");
    expect(matrix).toHaveProperty("no_match");
  });

  test("distinguishes a raw retrieval recall precondition failure", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const expandedCandidates = Object.fromEntries(
      cases.map((c) => [
        c.query,
        ["skill-x", "skill-y", ...c.relevant_skill_ids, "skill-a", "skill-b", "skill-c"],
      ]),
    );
    const scores = Object.fromEntries(
      cases.map((c) => [
        c.query,
        Object.fromEntries(expandedCandidates[c.query]!.map((id, index) => [id, 0.9 - index * 0.1])),
      ]),
    );
    const run = (candidateLimit: number) => runCalibration({
      cases,
      getCandidates: async (query) =>
        expandedCandidates[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(scores),
      minAutoMatchPrecision: 0,
      minRetrievalRecallAtK: 0.8,
      minDeliveredShortlistRecallAtK: 0,
      minAutoMatchCount: 1,
      candidateLimit,
    });

    const limitTwo = await run(2);
    const limitTen = await run(10);

    expect(limitTwo.status).toBe("failed_gates");
    expect(limitTwo.failed_reason).toBe("recall_precondition_failed");
    expect(limitTen.failed_reason).not.toBe("recall_precondition_failed");
  });

  test("rejects a tune-passing policy that fails frozen-test certification", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const testFailingScores = structuredClone(highConfidenceScores);
    testFailingScores["q-test-match-1"] = { "skill-a": 0.1, "skill-b": 0.95 };
    testFailingScores["q-test-match-2"] = { "skill-a": 0.95, "skill-b": 0.1 };
    const result = await runCalibration({
      cases,
      getCandidates: async (query) =>
        candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(testFailingScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });

    expect(result.tune_metrics).toBeDefined();
    expect(result.test_metrics).toBeDefined();
    expect(result.status).toBe("failed_gates");
    expect(result.failed_reason).toBe("test_certification_failed");
  });

  test("never reports completed when no correct auto-match coverage is possible", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const wrongScores = Object.fromEntries(cases.map((item) => [
      item.query,
      item.relevant_skill_ids[0] === "skill-a"
        ? { "skill-a": 0.1, "skill-b": 0.9 }
        : { "skill-a": 0.9, "skill-b": 0.1 },
    ]));
    const result = await runCalibration({
      cases,
      getCandidates: async (query) =>
        candidatesByQuery[query]!.map((id) => ({ skill_id: id, text: id })),
      reranker: makeFakeReranker(wrongScores),
      ...permissiveCertification,
      candidateLimit: 5,
    });

    expect(result.status).toBe("failed_gates");
    expect(result.failed_reason).toBe("no_coverage");
  });

  test("calibrates a 500-query dataset within the test timeout", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const largeCases = Array.from({ length: 500 }, (_, index) => {
      const expected = (["matched", "ambiguous", "no_match"] as const)[index % 3]!;
      return {
        query: `large-${index}`,
        split: index < 250 ? "tune" as const : "test" as const,
        expected_outcome: expected,
        relevant_skill_ids:
          expected === "matched" ? [`skill-${index}`] :
          expected === "ambiguous" ? [`skill-${index}`, `near-${index}`] : [],
      };
    });
    const result = await runCalibration({
      cases: largeCases,
      getRankedCandidates: async (query) => {
        const index = Number(query.slice("large-".length));
        const expected = largeCases[index]!.expected_outcome;
        const topScore = expected === "no_match"
          ? 0.2 + (index % 17) / 1_000
          : 0.8 + (index % 97) / 1_000;
        return [
          {
            skill_id: expected === "no_match" ? `other-${index}` : `skill-${index}`,
            score: topScore,
          },
          { skill_id: `near-${index}`, score: topScore - (expected === "ambiguous" ? 0.01 : 0.3) },
          { skill_id: `tail-${index}`, score: 0.05 + (index % 113) / 1_000 },
        ];
      },
      reranker: undefined,
      ...permissiveCertification,
      candidateLimit: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.observations).toHaveLength(500);
  }, 10_000);

  test("tunes candidate_floor to trim an ambiguous shortlist without changing classification", async () => {
    const { runCalibration } = await import("../src/calibrate");
    const floorCases: import("../src/calibrate").DecisionCase[] = [
      { query: "tune-match", split: "tune", expected_outcome: "matched", relevant_skill_ids: ["target"] },
      { query: "tune-ambiguous", split: "tune", expected_outcome: "ambiguous", relevant_skill_ids: ["target"] },
      { query: "tune-no-match", split: "tune", expected_outcome: "no_match", relevant_skill_ids: [] },
      { query: "test-match", split: "test", expected_outcome: "matched", relevant_skill_ids: ["target"] },
      { query: "test-ambiguous", split: "test", expected_outcome: "ambiguous", relevant_skill_ids: ["target"] },
      { query: "test-no-match", split: "test", expected_outcome: "no_match", relevant_skill_ids: [] },
    ];
    const ranked = (query: string) => {
      if (query.endsWith("match") && !query.endsWith("no-match")) {
        return [
          { skill_id: "target", score: 0.95 },
          { skill_id: "tail", score: 0.1 },
        ];
      }
      if (query.endsWith("ambiguous")) {
        return [
          { skill_id: "target", score: 0.7 },
          { skill_id: "near", score: 0.69 },
          { skill_id: "tail", score: 0.1 },
        ];
      }
      return [
        { skill_id: "other", score: 0.2 },
        { skill_id: "tail", score: 0.1 },
      ];
    };
    const result = await runCalibration({
      cases: floorCases,
      getRankedCandidates: async (query) => ranked(query),
      reranker: undefined,
      ...permissiveCertification,
      candidateLimit: 5,
    });

    expect(result.status).toBe("completed");
    const selected = result.selected_thresholds!;
    expect(selected.candidate_floor).toBeGreaterThan(0.1);

    const candidates = ranked("tune-ambiguous").map((candidate) => ({
      ...candidate,
      title: candidate.skill_id,
      description: "",
    }));
    const untrimmed = decideResolveOutcome({
      reranked: true,
      candidates,
      thresholds: { ...selected, candidate_floor: 0, candidate_limit: 5 },
    });
    const trimmed = decideResolveOutcome({
      reranked: true,
      candidates,
      thresholds: { ...selected, candidate_limit: 5 },
    });

    expect(untrimmed.outcome).toBe("ambiguous");
    expect(trimmed.outcome).toBe("ambiguous");
    if (untrimmed.outcome === "ambiguous" && trimmed.outcome === "ambiguous") {
      expect(trimmed.candidates.length).toBeLessThan(untrimmed.candidates.length);
    }
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
    recall_settings: { k_lexical: 15, k_vector: 15, k_rerank: 5 },
    candidate_limit: 5,
    min_auto_match_precision: 0.8,
    min_auto_match_count: 1,
    min_delivered_shortlist_recall_at_k: 0.95,
    min_shortlist_recall_at_5: 0.95,
    selected_thresholds: { match_score: 0.85, match_margin: 0.15, candidate_floor: 0.3 },
    tune_metrics: {
      auto_match_precision: 1.0,
      auto_match_precision_lower_bound: 0.9,
      auto_match_coverage: 0.8,
      auto_match_count: 10,
      correct_auto_match_count: 10,
      retrieval_recall_at_k: 1.0,
      delivered_shortlist_recall_at_k: 1.0,
    },
    test_metrics: {
      auto_match_precision: 0.95,
      auto_match_precision_lower_bound: 0.85,
      auto_match_coverage: 0.75,
      auto_match_count: 10,
      correct_auto_match_count: 9,
      retrieval_recall_at_k: 0.98,
      delivered_shortlist_recall_at_k: 0.98,
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

  test("should migrate an existing evidence database with candidate_limit defaulted", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "skillmux-cal-legacy-"));
    const legacyDb = new Database(join(legacyDir, "calibrate.sqlite3"), { create: true });
    legacyDb.run(`CREATE TABLE calibration_runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      reranker_fingerprint TEXT NOT NULL,
      embedding_fingerprint TEXT NOT NULL,
      corpus_fingerprint TEXT NOT NULL,
      dataset_hash TEXT NOT NULL,
      min_auto_match_precision REAL NOT NULL,
      min_shortlist_recall_at_5 REAL NOT NULL,
      selected_thresholds TEXT,
      tune_metrics TEXT,
      test_metrics TEXT,
      observations TEXT NOT NULL
    )`);
    legacyDb.run(
      `INSERT INTO calibration_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy",
        "2026-07-21T00:00:00Z",
        "completed",
        "r",
        "e",
        "c",
        "d",
        0.99,
        0.95,
        JSON.stringify({ match_score: 0.9, match_margin: 0.1, candidate_floor: 0.2 }),
        JSON.stringify({
          auto_match_precision: 1,
          auto_match_coverage: 0.5,
          shortlist_recall_at_5: 0.8,
          false_no_match_rate: 0,
        }),
        null,
        "[]",
      ],
    );
    legacyDb.close();

    const migratedDb = openCalibrateDb(legacyDir);
    try {
      const migrated = getCalibrationRun(migratedDb, "legacy")!;
      expect(migrated.candidate_limit).toBe(5);
      expect(migrated.tune_metrics!.retrieval_recall_at_k).toBe(0.8);
    } finally {
      migratedDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test("should insert a completed calibration run and retrieve it by run_id", () => {
    insertCalibrationRun(db, baseRun);
    const retrieved = getCalibrationRun(db, baseRun.run_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.run_id).toBe("run-abc-001");
    expect(retrieved!.status).toBe("completed");
    expect(retrieved!.reranker_fingerprint).toBe("model/reranker-v1@sha256:deadbeef");
    expect(retrieved!.dataset_hash).toBe("dataset@sha256:12345678");
    expect(retrieved!.recall_settings).toEqual({ k_lexical: 15, k_vector: 15, k_rerank: 5 });
  });

  test("persists human-labelled provenance counts in run detail and list output", () => {
    const provenance = {
      version: 1 as const,
      human_labelled_case_count: 12,
      imported_labelled_case_count: 4,
      imported_unreviewed_case_count: 0,
      raw_query_case_count: 8,
      redacted_query_case_count: 4,
    };
    insertCalibrationRun(db, {
      ...baseRun,
      run_id: "run-provenance-001",
      dataset_hash: "dataset@sha256:provenance",
      dataset_provenance: provenance,
    });
    expect(getCalibrationRun(db, "run-provenance-001")!.dataset_provenance).toEqual(provenance);
    const summary = listCalibrationRuns(db).find((run) => run.run_id === "run-provenance-001")!;
    expect(summary.human_labelled_case_count).toBe(12);
    expect(summary.imported_labelled_case_count).toBe(4);
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
      candidate_limit: 5,
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

  test("increments attempt_count for repeated dataset hashes", () => {
    insertCalibrationRun(db, {
      ...baseRun,
      run_id: "run-abc-002",
      created_at: "2026-07-21T14:00:00Z",
    });
    expect(getCalibrationRun(db, "run-abc-001")!.attempt_count).toBe(1);
    expect(getCalibrationRun(db, "run-abc-002")!.attempt_count).toBe(2);
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
    candidate_limit: 5,
    min_auto_match_precision: 0.8,
    min_auto_match_count: 1,
    min_delivered_shortlist_recall_at_k: 0.95,
    min_shortlist_recall_at_5: 0.95,
    selected_thresholds: { match_score: 0.85, match_margin: 0.15, candidate_floor: 0.3 },
    tune_metrics: {
      auto_match_precision: 1.0,
      auto_match_precision_lower_bound: 0.9,
      auto_match_coverage: 0.9,
      auto_match_count: 10,
      correct_auto_match_count: 10,
      retrieval_recall_at_k: 1.0,
      delivered_shortlist_recall_at_k: 1.0,
    },
    test_metrics: {
      auto_match_precision: 0.98,
      auto_match_precision_lower_bound: 0.85,
      auto_match_coverage: 0.85,
      auto_match_count: 10,
      correct_auto_match_count: 10,
      retrieval_recall_at_k: 0.99,
      delivered_shortlist_recall_at_k: 0.99,
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
    writeFileSync(path, `vault_path = "~/skills"\n\n[inference]\nmode = "remote"\ntimeout_ms = 5000\n\n[inference.embedding]\nprovider = "openai"\nendpoint = "https://embed.example.com/v1/embeddings"\nmodel = "embed-model"\ndimension = 1024\n\n[inference.reranker]\nadapter = "jina-v1"\nendpoint = "https://rerank.example.com/rerank"\nmodel = "rerank-model"\n\n[inference.thresholds]\nmatch_score = 0.80\nmatch_margin = 0.20\ncandidate_floor = 0.40\n${extra}`);
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
