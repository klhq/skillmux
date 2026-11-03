import type { Database } from "bun:sqlite";
import type { ObservedFetch } from "./eval";
import {
  computeStats,
  parseAuditCandidates,
  parseSince,
  queryAuditRows,
  queryAuditRowsById,
  type StatsResponse,
} from "./stats";
import type { AuditRow, FetchAuditRow } from "./types";

/**
 * A portable copy of the audit rows, as JSON lines. It exists for deployments
 * where the audit database cannot be read from outside the process that owns
 * it, such as stdio skillmux running inside an MCP gateway container. The
 * operator runs `skillmux audit export` through the gateway's own exec, and
 * `report --from` and `eval promote --from` read the file anywhere.
 *
 * Line 1 is the header. Every other line is one row tagged with `kind`.
 */
export const AUDIT_EXPORT_FORMAT = "skillmux-audit-export";
export const AUDIT_EXPORT_VERSION = 1;

export interface AuditExportHeader {
  format: typeof AUDIT_EXPORT_FORMAT;
  version: typeof AUDIT_EXPORT_VERSION;
  exported_at: string;
  /** Lower bound of the exported window, or null when every row was exported. */
  since: string | null;
}

export interface FileFetchAuditRow {
  id: number;
  ts: string;
  skill_id: string;
  path: string;
  content_sha256: string;
  byte_length: number;
  request_id: string | null;
  parent_fetch_id: number | null;
}

export interface AuditExport {
  header: AuditExportHeader;
  resolves: AuditRow[];
  fetches: FetchAuditRow[];
  file_fetches: FileFetchAuditRow[];
}

export interface AuditExportCounts {
  resolve: number;
  fetch: number;
  file_fetch: number;
}

/**
 * Reads the rows to export. Fetches and attachment reads are filtered by their
 * own timestamp. Resolves are filtered the same way, plus any older resolve a
 * fetch in the window points at, so a fetch near the window's start keeps the
 * query `eval promote` needs.
 */
export function readAuditExport(db: Database, sinceIso: string | null, now: Date = new Date()): AuditExport {
  const lowerBound = sinceIso ?? "";
  const fetches = db
    .query(
      "SELECT id, ts, skill_id, request_id, resolve_audit_id, rank_at_resolve FROM fetch WHERE ts >= ? ORDER BY id ASC",
    )
    .all(lowerBound) as FetchAuditRow[];
  const file_fetches = db
    .query(
      "SELECT id, ts, skill_id, path, content_sha256, byte_length, request_id, parent_fetch_id FROM file_fetch WHERE ts >= ? ORDER BY id ASC",
    )
    .all(lowerBound) as FileFetchAuditRow[];

  const inWindow = queryAuditRows(db, lowerBound);
  const seen = new Set(inWindow.map((row) => row.id));
  const referenced = [
    ...new Set(
      fetches.map((f) => f.resolve_audit_id).filter((id): id is number => id !== null && !seen.has(id)),
    ),
  ];
  const resolves = [...queryAuditRowsById(db, referenced), ...inWindow].sort((a, b) => a.id - b.id);

  return {
    header: {
      format: AUDIT_EXPORT_FORMAT,
      version: AUDIT_EXPORT_VERSION,
      exported_at: now.toISOString(),
      since: sinceIso,
    },
    resolves,
    fetches,
    file_fetches,
  };
}

export function countAuditExport(data: AuditExport): AuditExportCounts {
  return { resolve: data.resolves.length, fetch: data.fetches.length, file_fetch: data.file_fetches.length };
}

/** Serializes an export as JSON lines, ending with a newline. */
export function serializeAuditExport(data: AuditExport): string {
  const lines = [JSON.stringify(data.header)];
  for (const row of data.resolves) {
    lines.push(
      JSON.stringify({
        kind: "resolve",
        id: row.id,
        ts: row.ts,
        request_id: row.request_id,
        query: row.query,
        retrieval: row.retrieval,
        degraded_from: row.degraded_from ?? null,
        degradation_reason: row.degradation_reason ?? null,
        candidates: row.candidates,
        latency_ms: row.latency_ms,
      }),
    );
  }
  for (const row of data.fetches) lines.push(JSON.stringify({ kind: "fetch", ...row }));
  for (const row of data.file_fetches) lines.push(JSON.stringify({ kind: "file_fetch", ...row }));
  return lines.join("\n") + "\n";
}

class ExportParseError extends Error {
  constructor(line: number, message: string) {
    super(`audit export line ${line}: ${message}`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

function requireFields(
  line: number,
  record: Record<string, unknown>,
  checks: Record<string, (value: unknown) => boolean>,
): void {
  for (const [field, check] of Object.entries(checks)) {
    if (!check(record[field])) throw new ExportParseError(line, `invalid or missing "${field}"`);
  }
}

/** Parses and validates an export file. Throws with the offending line number. */
export function parseAuditExport(text: string): AuditExport {
  const lines = text.split("\n");
  let header: AuditExportHeader | undefined;
  const resolves: AuditRow[] = [];
  const fetches: FetchAuditRow[] = [];
  const file_fetches: FileFetchAuditRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new ExportParseError(lineNo, "not valid JSON");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new ExportParseError(lineNo, "expected a JSON object");
    }
    const r = record as Record<string, unknown>;

    if (!header) {
      if (r.format !== AUDIT_EXPORT_FORMAT) {
        throw new ExportParseError(lineNo, `not a skillmux audit export (expected "format": "${AUDIT_EXPORT_FORMAT}")`);
      }
      if (r.version !== AUDIT_EXPORT_VERSION) {
        throw new ExportParseError(
          lineNo,
          `unsupported export version ${JSON.stringify(r.version)}; this skillmux reads version ${AUDIT_EXPORT_VERSION}`,
        );
      }
      requireFields(lineNo, r, { exported_at: isString, since: isNullableString });
      if (Number.isNaN(new Date(r.exported_at as string).getTime())) {
        throw new ExportParseError(lineNo, `invalid "exported_at"`);
      }
      header = {
        format: AUDIT_EXPORT_FORMAT,
        version: AUDIT_EXPORT_VERSION,
        exported_at: r.exported_at as string,
        since: r.since as string | null,
      };
      continue;
    }

    switch (r.kind) {
      case "resolve": {
        requireFields(lineNo, r, {
          id: isInteger,
          ts: isString,
          request_id: isNullableString,
          query: isString,
          retrieval: isString,
          degraded_from: isNullableString,
          degradation_reason: isNullableString,
          latency_ms: (v) => typeof v === "number" && Number.isFinite(v),
        });
        let candidates;
        try {
          candidates = parseAuditCandidates(r.candidates, r.id as number);
        } catch (error) {
          throw new ExportParseError(lineNo, (error as Error).message);
        }
        const row: AuditRow = {
          id: r.id as number,
          ts: r.ts as string,
          request_id: r.request_id as string | null,
          query: r.query as string,
          retrieval: r.retrieval as AuditRow["retrieval"],
          candidates,
          latency_ms: r.latency_ms as number,
        };
        if (r.degraded_from !== null) row.degraded_from = r.degraded_from as AuditRow["degraded_from"];
        if (r.degradation_reason !== null) row.degradation_reason = r.degradation_reason as AuditRow["degradation_reason"];
        resolves.push(row);
        break;
      }
      case "fetch":
        requireFields(lineNo, r, {
          id: isInteger,
          ts: isString,
          skill_id: isString,
          request_id: isNullableString,
          resolve_audit_id: isNullableInteger,
          rank_at_resolve: isNullableInteger,
        });
        fetches.push({
          id: r.id as number,
          ts: r.ts as string,
          skill_id: r.skill_id as string,
          request_id: r.request_id as string | null,
          resolve_audit_id: r.resolve_audit_id as number | null,
          rank_at_resolve: r.rank_at_resolve as number | null,
        });
        break;
      case "file_fetch":
        requireFields(lineNo, r, {
          id: isInteger,
          ts: isString,
          skill_id: isString,
          path: isString,
          content_sha256: isString,
          byte_length: isInteger,
          request_id: isNullableString,
          parent_fetch_id: isNullableInteger,
        });
        file_fetches.push({
          id: r.id as number,
          ts: r.ts as string,
          skill_id: r.skill_id as string,
          path: r.path as string,
          content_sha256: r.content_sha256 as string,
          byte_length: r.byte_length as number,
          request_id: r.request_id as string | null,
          parent_fetch_id: r.parent_fetch_id as number | null,
        });
        break;
      default:
        throw new ExportParseError(lineNo, `unknown row kind ${JSON.stringify(r.kind)}`);
    }
  }

  if (!header) throw new Error("audit export is empty: missing header line");
  return { header, resolves, fetches, file_fetches };
}

/**
 * Resolves a --since window against an export. A relative window counts back
 * from the export time, not from now, so a file read days later still covers
 * the window it was exported for.
 */
export function exportWindow(data: AuditExport, since: string): { since: Date; until: Date; covered: boolean } {
  const until = new Date(data.header.exported_at);
  const sinceDate = parseSince(since, until);
  const covered = data.header.since === null || new Date(data.header.since).getTime() <= sinceDate.getTime();
  return { since: sinceDate, until, covered };
}

/** `report --from`: the same statistics `report --db` computes, from an export. */
export function statsFromExport(data: AuditExport, since: string): StatsResponse {
  const window = exportWindow(data, since);
  const sinceIso = window.since.toISOString();
  const rows = data.resolves.filter((row) => row.ts >= sinceIso);
  const fetchRows = data.fetches.filter((row) => row.ts >= sinceIso);
  return computeStats(rows, window.since, window.until, fetchRows);
}

/** `eval promote --from`: mirrors queryPromotableFetches over an export. */
export function promotableFetchesFromExport(data: AuditExport, sinceIso: string): ObservedFetch[] {
  const queryById = new Map(data.resolves.map((row) => [row.id, row.query]));
  const result: ObservedFetch[] = [];
  const ordered = [...data.fetches].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
  for (const fetch of ordered) {
    if (fetch.ts < sinceIso || fetch.resolve_audit_id === null) continue;
    const query = queryById.get(fetch.resolve_audit_id);
    if (query === undefined) continue;
    result.push({ query, skill_id: fetch.skill_id });
  }
  return result;
}
