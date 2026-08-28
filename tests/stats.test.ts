import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAudit, openAudit } from "../src/db";
import { computeStats, getStats, parseSince, queryAuditRows, renderStatsText } from "../src/stats";
import type { AuditRow } from "../src/types";

function auditRow(overrides: Partial<AuditRow>): AuditRow {
  return {
    id: 1,
    ts: "2026-07-10T00:00:00.000Z",
    query: "test query",
    retrieval: "lexical",
    candidates: [],
    latency_ms: 5,
    ...overrides,
  };
}

describe("parseSince", () => {
  test("parses a relative days window into a Date offset from now", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");

    const result = parseSince("30d", now);

    expect(result.toISOString()).toBe("2026-06-19T00:00:00.000Z");
  });

  test("parses a relative hours window", () => {
    const now = new Date("2026-07-19T12:00:00.000Z");

    expect(parseSince("6h", now).toISOString()).toBe("2026-07-19T06:00:00.000Z");
  });

  test("parses an absolute ISO date unchanged, ignoring now", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");

    expect(parseSince("2026-01-01", now).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("throws on a malformed since string", () => {
    expect(() => parseSince("not-a-window")).toThrow("invalid --since window: not-a-window");
  });
});

describe("computeStats", () => {
  const since = new Date("2026-06-19T00:00:00.000Z");
  const until = new Date("2026-07-19T00:00:00.000Z");

  test("tallies total_requests, empty_shortlist_count, and empty_shortlist_rate across rows", () => {
    const rows = [
      auditRow({ candidates: [{ skill_id: "writing-clearly", score: 0.9 }], retrieval: "reranked", latency_ms: 10 }),
      auditRow({ candidates: [{ skill_id: "writing-clearly", score: 0.5 }, { skill_id: "code-review", score: 0.4 }], retrieval: "hybrid", latency_ms: 20 }),
      auditRow({ candidates: [], retrieval: "lexical", latency_ms: 6 }),
    ];

    const result = computeStats(rows, since, until);

    expect(result.total_requests).toBe(3);
    expect(result.empty_shortlist_count).toBe(1);
    expect(result.empty_shortlist_rate).toBeCloseTo(1 / 3, 5);
    expect(result.retrieval_totals).toEqual({ exact: 0, reranked: 1, hybrid: 1, lexical: 1 });
    expect(result.degraded_count).toBe(0);
    expect(result.average_latency_ms).toBe(12);
    expect(result.since).toBe(since.toISOString());
    expect(result.until).toBe(until.toISOString());
  });

  test("computes empty_shortlist_rate and average_latency_ms as 0 when rows are empty", () => {
    const result = computeStats([], since, until);

    expect(result.total_requests).toBe(0);
    expect(result.empty_shortlist_count).toBe(0);
    expect(result.empty_shortlist_rate).toBe(0);
    expect(result.retrieval_totals).toEqual({ exact: 0, reranked: 0, hybrid: 0, lexical: 0 });
    expect(result.degraded_count).toBe(0);
    expect(result.average_latency_ms).toBe(0);
    expect(result.skills).toEqual([]);
    expect(result.top_empty_shortlist_queries).toEqual([]);
  });

  test("counts degraded requests when degraded_from or degradation_reason is present", () => {
    const rows = [
      auditRow({ degraded_from: "reranked", degradation_reason: "reranker_timeout", candidates: [{ skill_id: "a", score: 0.5 }] }),
      auditRow({ degraded_from: null, degradation_reason: "embedding_timeout", candidates: [] }),
      auditRow({ degraded_from: "hybrid", degradation_reason: null, candidates: [{ skill_id: "b", score: 0.3 }] }),
      auditRow({ candidates: [{ skill_id: "c", score: 0.8 }] }),
    ];

    const result = computeStats(rows, since, until);
    expect(result.degraded_count).toBe(3);
  });

  test("aggregates per-skill candidate_count deduplicated within a row and sorts by count desc then skill_id asc", () => {
    const rows = [
      auditRow({
        candidates: [
          { skill_id: "writing-clearly", score: 0.9 },
          { skill_id: "code-review", score: 0.6 },
          { skill_id: "writing-clearly", score: 0.8 }, // duplicate in legacy row
        ],
      }),
      auditRow({
        candidates: [
          { skill_id: "beta-skill", score: 0.5 },
          { skill_id: "alpha-skill", score: 0.5 },
          { skill_id: "writing-clearly", score: 0.5 },
        ],
      }),
    ];

    const result = computeStats(rows, since, until);

    // writing-clearly has 2 requests, alpha-skill and beta-skill each have 1 request (tie broken alphabetically), code-review has 1 request
    expect(result.skills).toEqual([
      { skill_id: "writing-clearly", candidate_count: 2 },
      { skill_id: "alpha-skill", candidate_count: 1 },
      { skill_id: "beta-skill", candidate_count: 1 },
      { skill_id: "code-review", candidate_count: 1 },
    ]);
  });

  test("collects top_empty_shortlist_queries sorted by count desc then query asc, capped at 20 distinct queries", () => {
    const rows: AuditRow[] = [
      auditRow({ candidates: [], query: "zeta query" }),
      auditRow({ candidates: [], query: "alpha query" }),
      auditRow({ candidates: [], query: "frequent query" }),
      auditRow({ candidates: [], query: "frequent query" }),
      auditRow({ candidates: [{ skill_id: "some-skill", score: 0.9 }], query: "non-empty query" }),
    ];

    const result = computeStats(rows, since, until);

    // frequent query: 2; alpha query: 1; zeta query: 1 (alpha before zeta alphabetically)
    expect(result.top_empty_shortlist_queries).toEqual([
      { query: "frequent query", count: 2 },
      { query: "alpha query", count: 1 },
      { query: "zeta query", count: 1 },
    ]);
  });

  test("breaks ties using locale-independent code-unit ordering rather than locale-dependent collation", () => {
    // In code-unit ordering: uppercase ('S'=83, 'Q'=81) precedes lowercase ('s'=115, 'q'=113).
    // In standard locale collation: "skill-a" precedes "Skill-Z" and "query-a" precedes "Query-B".
    const rows = [
      auditRow({
        candidates: [
          { skill_id: "skill-a", score: 0.9 },
          { skill_id: "Skill-Z", score: 0.8 },
        ],
      }),
      auditRow({ candidates: [], query: "query-a" }),
      auditRow({ candidates: [], query: "Query-B" }),
    ];

    const result = computeStats(rows, since, until);

    expect(result.skills).toEqual([
      { skill_id: "Skill-Z", candidate_count: 1 },
      { skill_id: "skill-a", candidate_count: 1 },
    ]);
    expect(result.top_empty_shortlist_queries).toEqual([
      { query: "Query-B", count: 1 },
      { query: "query-a", count: 1 },
    ]);
  });

  test("caps top_empty_shortlist_queries at 20 entries", () => {
    const rows: AuditRow[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(auditRow({ candidates: [], query: `empty query ${String(i).padStart(2, "0")}` }));
    }

    const result = computeStats(rows, since, until);
    expect(result.top_empty_shortlist_queries).toHaveLength(20);
  });
});

describe("queryAuditRows", () => {
  test("reads rows at or after the since timestamp, parsing canonical columns and degradation data", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-"));
    const db = openAudit(stateDir);
    insertAudit(db, {
      ts: "2026-06-01T00:00:00.000Z",
      query: "too old",
      retrieval: "lexical",
      candidates: [],
      latency_ms: 3,
    });
    insertAudit(db, {
      ts: "2026-07-10T00:00:00.000Z",
      query: "in window",
      retrieval: "reranked",
      degraded_from: "reranked",
      degradation_reason: "reranker_timeout",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      latency_ms: 12,
    });

    const rows = queryAuditRows(db, "2026-07-01T00:00:00.000Z");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      query: "in window",
      retrieval: "reranked",
      degraded_from: "reranked",
      degradation_reason: "reranker_timeout",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      latency_ms: 12,
    });
    expect((rows[0] as any).outcome).toBeUndefined();
    expect((rows[0] as any).selected_skill_id).toBeUndefined();

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("accepts score when it is null or a finite JSON number", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-valid-scores-"));
    const db = openAudit(stateDir);

    db.run(
      `INSERT INTO audit (ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?)`,
      [
        "2026-07-10T00:00:00.000Z",
        "scores query",
        "reranked",
        JSON.stringify([
          { skill_id: "with-null-score", score: null },
          { skill_id: "with-float-score", score: 0.85 },
          { skill_id: "with-zero-score", score: 0 },
          { skill_id: "with-negative-score", score: -1.5 },
        ]),
        10,
      ],
    );

    const rows = queryAuditRows(db, "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.candidates).toEqual([
      { skill_id: "with-null-score", score: null },
      { skill_id: "with-float-score", score: 0.85 },
      { skill_id: "with-zero-score", score: 0 },
      { skill_id: "with-negative-score", score: -1.5 },
    ]);

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test.each([
    { label: "missing score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1"}]' },
    { label: "string score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":"0.9"}]' },
    { label: "boolean true score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":true}]' },
    { label: "boolean false score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":false}]' },
    { label: "object score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":{"value":0.9}}]' },
    { label: "array score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":[0.9]}]' },
    { label: "non-finite positive score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":1e999}]' },
    { label: "non-finite negative score", rawJson: '[{"skill_id":"valid-first","score":0.5},{"skill_id":"skill-1","score":-1e999}]' },
  ])("throws clear error containing audit row id and candidate index when score is $label", ({ rawJson }) => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-invalid-score-"));
    const db = openAudit(stateDir);

    db.run(
      `INSERT INTO audit (id, ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      [42, "2026-07-10T00:00:00.000Z", "secret query", "lexical", rawJson, 10],
    );

    expect(() => queryAuditRows(db, "2026-07-01T00:00:00.000Z")).toThrow(
      "Invalid candidate at index 1 for audit row 42: missing or invalid score",
    );

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("does not leak raw candidates JSON or sensitive content in parse errors", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-leak-"));
    const db = openAudit(stateDir);

    const sensitiveSnippet = "SUPER_SECRET_USER_INPUT_DO_NOT_LEAK";
    db.run(
      `INSERT INTO audit (id, ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      [99, "2026-07-10T00:00:00.000Z", "sensitive query", "lexical", `{ bad_json: "${sensitiveSnippet}" }`, 10],
    );

    let caughtError: Error | undefined;
    try {
      queryAuditRows(db, "2026-07-01T00:00:00.000Z");
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("Failed to parse candidates JSON for audit row 99");
    expect(caughtError!.message).not.toContain(sensitiveSnippet);

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("throws clearly on malformed candidates JSON rather than silently inventing data", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-malformed-"));
    const db = openAudit(stateDir);

    db.run(
      `INSERT INTO audit (id, ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      [7, "2026-07-10T00:00:00.000Z", "bad json query", "lexical", "NOT_VALID_JSON", 10],
    );

    expect(() => queryAuditRows(db, "2026-07-01T00:00:00.000Z")).toThrow(
      "Failed to parse candidates JSON for audit row 7",
    );

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("throws clearly when candidates JSON is not an array", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-nonarray-"));
    const db = openAudit(stateDir);

    db.run(
      `INSERT INTO audit (id, ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      [8, "2026-07-10T00:00:00.000Z", "bad json query", "lexical", '{"not":"an_array"}', 10],
    );

    expect(() => queryAuditRows(db, "2026-07-01T00:00:00.000Z")).toThrow(
      "Invalid candidates JSON for audit row 8: expected array, got object",
    );

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("getStats", () => {
  test("combines parseSince + queryAuditRows + computeStats against a real db", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-"));
    const db = openAudit(stateDir);
    const now = new Date("2026-07-19T00:00:00.000Z");
    insertAudit(db, {
      ts: "2026-07-10T00:00:00.000Z",
      query: "in window",
      retrieval: "reranked",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      latency_ms: 12,
    });
    insertAudit(db, {
      ts: "2026-01-01T00:00:00.000Z",
      query: "too old",
      retrieval: "lexical",
      candidates: [],
      latency_ms: 3,
    });

    const result = getStats(db, "30d", now);

    expect(result.total_requests).toBe(1);
    expect(result.empty_shortlist_count).toBe(0);
    expect(result.retrieval_totals).toEqual({ exact: 0, reranked: 1, hybrid: 0, lexical: 0 });
    expect(result.skills).toEqual([{ skill_id: "writing-clearly", candidate_count: 1 }]);
    expect(result.until).toBe(now.toISOString());

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("renderStatsText", () => {
  test("renders window, requests, retrieval totals, per-skill counts, and top empty shortlist queries", () => {
    const stats = computeStats(
      [
        auditRow({ retrieval: "reranked", latency_ms: 15, candidates: [{ skill_id: "writing-clearly", score: 0.9 }] }),
        auditRow({ retrieval: "lexical", latency_ms: 5, candidates: [], query: "obscure task" }),
      ],
      new Date("2026-06-19T00:00:00.000Z"),
      new Date("2026-07-19T00:00:00.000Z"),
    );

    const text = renderStatsText(stats);

    expect(text).toContain("window: 2026-06-19T00:00:00.000Z .. 2026-07-19T00:00:00.000Z");
    expect(text).toContain("total=2 empty_shortlist=1");
    expect(text).toContain("empty_shortlist_rate=0.500");
    expect(text).toContain("exact=0 reranked=1 hybrid=0 lexical=1");
    expect(text).toContain("writing-clearly candidate=1");
    expect(text).toContain(`"obscure task" (1)`);
  });

  test("renders placeholders when there are no skills or empty shortlist queries", () => {
    const stats = computeStats([], new Date("2026-06-19T00:00:00.000Z"), new Date("2026-07-19T00:00:00.000Z"));

    const text = renderStatsText(stats);

    expect(text).toContain("skills:\n  (none)");
    expect(text).toContain("top empty shortlist queries:\n  (none)");
  });
});
