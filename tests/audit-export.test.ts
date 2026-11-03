import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportWindow,
  parseAuditExport,
  promotableFetchesFromExport,
  readAuditExport,
  serializeAuditExport,
  statsFromExport,
} from "../src/audit-export";
import { insertAudit, insertFetch, insertFileFetch, openAudit } from "../src/db";
import { queryPromotableFetches } from "../src/eval";
import { computeStats, queryAuditRows, queryFetchRows } from "../src/stats";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let dir: string;
let db: Database;

function seedResolve(ts: string, query: string, requestId: string, skills: string[]): number {
  insertAudit(db, {
    ts,
    request_id: requestId,
    query,
    retrieval: "hybrid",
    candidates: skills.map((skill_id, i) => ({ skill_id, score: 1 - i / 10 })),
    latency_ms: 7,
  });
  return (db.query("SELECT id FROM audit WHERE request_id = ?").get(requestId) as { id: number }).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillmux-audit-export-"));
  db = openAudit(dir);

  // A resolve 20 days old whose fetch falls inside a 7-day window.
  const old = seedResolve(daysAgo(20), "old resolve query", "req-old", ["alpha", "beta"]);
  insertFetch(db, { ts: daysAgo(3), skill_id: "beta", request_id: "req-old", resolve_audit_id: old, rank_at_resolve: 2 });

  const recent = seedResolve(daysAgo(2), "recent query", "req-new", ["alpha"]);
  const fetchId = insertFetch(db, {
    ts: daysAgo(2),
    skill_id: "alpha",
    request_id: "req-new",
    resolve_audit_id: recent,
    rank_at_resolve: 1,
  });
  insertFileFetch(db, {
    ts: daysAgo(2),
    skill_id: "alpha",
    path: "references/a.md",
    content_sha256: "ab".repeat(32),
    byte_length: 12,
    request_id: "req-new",
    parent_fetch_id: fetchId,
  });

  insertAudit(db, {
    ts: daysAgo(1),
    request_id: null,
    query: "nothing matched",
    retrieval: "lexical",
    degraded_from: "hybrid",
    degradation_reason: "embedding_unavailable",
    candidates: [],
    latency_ms: 3,
  });
  insertFetch(db, { ts: daysAgo(1), skill_id: "gamma", request_id: null, resolve_audit_id: null, rank_at_resolve: null });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit export", () => {
  test("round-trips every row through JSON lines", () => {
    const exported = readAuditExport(db, null, NOW);
    const parsed = parseAuditExport(serializeAuditExport(exported));

    expect(parsed).toEqual(exported);
    expect(parsed.header).toEqual({
      format: "skillmux-audit-export",
      version: 1,
      exported_at: NOW.toISOString(),
      since: null,
    });
    expect(parsed.resolves).toHaveLength(3);
    expect(parsed.fetches).toHaveLength(3);
    expect(parsed.file_fetches).toHaveLength(1);
  });

  test("a windowed export keeps an older resolve that a fetch in the window points at", () => {
    const exported = readAuditExport(db, daysAgo(7), NOW);

    expect(exported.resolves.map((r) => r.query)).toEqual(["old resolve query", "recent query", "nothing matched"]);
    expect(exported.fetches.map((f) => f.skill_id)).toEqual(["beta", "alpha", "gamma"]);
  });

  test("report from an export matches report from the database for the same window", () => {
    const sinceIso = daysAgo(7);
    const fromDb = computeStats(queryAuditRows(db, sinceIso), new Date(sinceIso), NOW, queryFetchRows(db, sinceIso));
    const fromExport = statsFromExport(parseAuditExport(serializeAuditExport(readAuditExport(db, sinceIso, NOW))), "7d");

    expect(fromExport).toEqual(fromDb);
    // The older resolve came along only to carry its query; it is not a request in the window.
    expect(fromExport.total_requests).toBe(2);
  });

  test("eval promote from an export matches the database join", () => {
    const sinceIso = daysAgo(7);
    const data = parseAuditExport(serializeAuditExport(readAuditExport(db, sinceIso, NOW)));

    expect(promotableFetchesFromExport(data, sinceIso)).toEqual(queryPromotableFetches(db, sinceIso));
    expect(promotableFetchesFromExport(data, sinceIso)).toEqual([
      { query: "old resolve query", skill_id: "beta" },
      { query: "recent query", skill_id: "alpha" },
    ]);
  });

  test("a relative window counts back from the export time, not from now", () => {
    const data = readAuditExport(db, null, NOW);
    const window = exportWindow(data, "7d");

    expect(window.until.toISOString()).toBe(NOW.toISOString());
    expect(window.since.toISOString()).toBe(daysAgo(7));
    expect(window.covered).toBe(true);
  });

  test("flags a window that starts before the export's own lower bound", () => {
    const data = readAuditExport(db, daysAgo(3), NOW);

    expect(exportWindow(data, "7d").covered).toBe(false);
    expect(exportWindow(data, "2d").covered).toBe(true);
  });
});

describe("parseAuditExport validation", () => {
  const header = JSON.stringify({ format: "skillmux-audit-export", version: 1, exported_at: NOW.toISOString(), since: null });

  test("rejects a file without the header", () => {
    expect(() => parseAuditExport("")).toThrow("missing header line");
    expect(() => parseAuditExport('{"kind":"fetch"}\n')).toThrow("line 1: not a skillmux audit export");
  });

  test("rejects an unknown version", () => {
    const bad = JSON.stringify({ format: "skillmux-audit-export", version: 2, exported_at: NOW.toISOString(), since: null });
    expect(() => parseAuditExport(bad)).toThrow("unsupported export version 2");
  });

  test("names the line of a malformed row", () => {
    expect(() => parseAuditExport(`${header}\nnot json\n`)).toThrow("line 2: not valid JSON");
    expect(() => parseAuditExport(`${header}\n{"kind":"bogus"}\n`)).toThrow('line 2: unknown row kind "bogus"');
    expect(() =>
      parseAuditExport(`${header}\n{"kind":"fetch","id":1,"ts":"x","skill_id":5,"request_id":null,"resolve_audit_id":null,"rank_at_resolve":null}\n`),
    ).toThrow('line 2: invalid or missing "skill_id"');
  });

  test("rejects a resolve row with invalid candidates", () => {
    const row = JSON.stringify({
      kind: "resolve",
      id: 1,
      ts: NOW.toISOString(),
      request_id: null,
      query: "q",
      retrieval: "lexical",
      degraded_from: null,
      degradation_reason: null,
      candidates: [{ score: 1 }],
      latency_ms: 1,
    });
    expect(() => parseAuditExport(`${header}\n${row}\n`)).toThrow("line 2: Invalid candidate at index 0");
  });
});
