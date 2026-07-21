import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAudit, openIndex } from "../src/db";
import { computeStats, getStats, parseSince, queryAuditRows, renderStatsText } from "../src/stats";
import type { AuditRow } from "../src/types";

function auditRow(overrides: Partial<AuditRow>): AuditRow {
  return {
    id: 1,
    ts: "2026-07-10T00:00:00.000Z",
    query: "test query",
    outcome: "no_match",
    retrieval: "lexical",
    candidates: [],
    selected_skill_id: null,
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

  test("tallies outcome_totals across rows", () => {
    const rows = [
      auditRow({ outcome: "matched", selected_skill_id: "writing-clearly", candidates: [{ skill_id: "writing-clearly", score: 0.9 }] }),
      auditRow({ outcome: "ambiguous", candidates: [{ skill_id: "writing-clearly", score: 0.5 }, { skill_id: "code-review", score: 0.4 }] }),
      auditRow({ outcome: "no_match" }),
    ];

    const result = computeStats(rows, since, until);

    expect(result.outcome_totals).toEqual({ matched: 1, ambiguous: 1, no_match: 1 });
    expect(result.since).toBe(since.toISOString());
    expect(result.until).toBe(until.toISOString());
  });

  test("computes ambiguous_rate as ambiguous over total, and 0 with no rows", () => {
    const rows = [
      auditRow({ outcome: "matched", selected_skill_id: "a", candidates: [{ skill_id: "a", score: 0.9 }] }),
      auditRow({ outcome: "ambiguous", candidates: [{ skill_id: "a", score: 0.5 }] }),
      auditRow({ outcome: "ambiguous", candidates: [{ skill_id: "a", score: 0.5 }] }),
      auditRow({ outcome: "no_match" }),
    ];

    expect(computeStats(rows, since, until).ambiguous_rate).toBe(0.5);
    expect(computeStats([], since, until).ambiguous_rate).toBe(0);
  });

  test("aggregates per-skill matched_count and candidate_count, deduped within a row, sorted by matched_count desc", () => {
    const rows = [
      auditRow({
        outcome: "matched",
        selected_skill_id: "writing-clearly",
        candidates: [{ skill_id: "writing-clearly", score: 0.9 }, { skill_id: "code-review", score: 0.6 }],
      }),
      auditRow({
        outcome: "ambiguous",
        candidates: [{ skill_id: "code-review", score: 0.5 }, { skill_id: "writing-clearly", score: 0.5 }],
      }),
    ];

    const result = computeStats(rows, since, until);

    expect(result.skills).toEqual([
      { skill_id: "writing-clearly", matched_count: 1, candidate_count: 2 },
      { skill_id: "code-review", matched_count: 0, candidate_count: 2 },
    ]);
  });

  test("collects top_no_match_queries sorted by count desc, capped at 20 distinct queries", () => {
    const rows = [
      auditRow({ outcome: "no_match", query: "frequent query" }),
      auditRow({ outcome: "no_match", query: "frequent query" }),
      auditRow({ outcome: "no_match", query: "rare query" }),
    ];

    const result = computeStats(rows, since, until);

    expect(result.top_no_match_queries).toEqual([
      { query: "frequent query", count: 2 },
      { query: "rare query", count: 1 },
    ]);
  });
});

describe("queryAuditRows", () => {
  test("reads rows at or after the since timestamp, parsing the JSON candidates column", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-"));
    const db = openIndex(stateDir);
    insertAudit(db, {
      ts: "2026-06-01T00:00:00.000Z",
      query: "too old",
      outcome: "no_match",
      retrieval: "lexical",
      candidates: [],
      selected_skill_id: null,
      latency_ms: 3,
    });
    insertAudit(db, {
      ts: "2026-07-10T00:00:00.000Z",
      query: "in window",
      outcome: "matched",
      retrieval: "reranked",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      selected_skill_id: "writing-clearly",
      latency_ms: 12,
    });

    const rows = queryAuditRows(db, "2026-07-01T00:00:00.000Z");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      query: "in window",
      outcome: "matched",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      selected_skill_id: "writing-clearly",
    });

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("getStats", () => {
  test("combines parseSince + queryAuditRows + computeStats against a real db", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-stats-"));
    const db = openIndex(stateDir);
    const now = new Date("2026-07-19T00:00:00.000Z");
    insertAudit(db, {
      ts: "2026-07-10T00:00:00.000Z",
      query: "in window",
      outcome: "matched",
      retrieval: "reranked",
      candidates: [{ skill_id: "writing-clearly", score: 0.9 }],
      selected_skill_id: "writing-clearly",
      latency_ms: 12,
    });
    insertAudit(db, {
      ts: "2026-01-01T00:00:00.000Z",
      query: "too old",
      outcome: "no_match",
      retrieval: "lexical",
      candidates: [],
      selected_skill_id: null,
      latency_ms: 3,
    });

    const result = getStats(db, "30d", now);

    expect(result.outcome_totals).toEqual({ matched: 1, ambiguous: 0, no_match: 0 });
    expect(result.until).toBe(now.toISOString());

    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("renderStatsText", () => {
  test("renders window, outcome totals, per-skill counts, and top no_match queries", () => {
    const stats = computeStats(
      [
        auditRow({ outcome: "matched", selected_skill_id: "writing-clearly", candidates: [{ skill_id: "writing-clearly", score: 0.9 }] }),
        auditRow({ outcome: "no_match", query: "obscure task" }),
      ],
      new Date("2026-06-19T00:00:00.000Z"),
      new Date("2026-07-19T00:00:00.000Z"),
    );

    const text = renderStatsText(stats);

    expect(text).toContain("window: 2026-06-19T00:00:00.000Z .. 2026-07-19T00:00:00.000Z");
    expect(text).toContain("matched=1 ambiguous=0 no_match=1");
    expect(text).toContain("writing-clearly matched=1 candidate=1");
    expect(text).toContain(`"obscure task" (1)`);
  });

  test("renders placeholders when there are no skills or no_match queries", () => {
    const stats = computeStats([], new Date("2026-06-19T00:00:00.000Z"), new Date("2026-07-19T00:00:00.000Z"));

    const text = renderStatsText(stats);

    expect(text).toContain("skills:\n  (none)");
    expect(text).toContain("top no_match queries:\n  (none)");
  });
});
