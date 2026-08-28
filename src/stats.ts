import type { Database } from "bun:sqlite";
import type { AuditCandidate, AuditRow, FetchAuditRow } from "./types";

export const SINCE_PATTERN = /^(\d+[hdwmy]|\d{4}-\d{2}-\d{2}([T ].+)?)$/;

export interface SkillStat {
  skill_id: string;
  candidate_count: number;
}

export interface EmptyShortlistQuery {
  query: string;
  count: number;
}

export interface RetrievalTotals {
  exact: number;
  reranked: number;
  hybrid: number;
  lexical: number;
}

export type AcceptanceSignal =
  | { available: false; uncorrelated_fetch_count: number }
  | {
      available: true;
      resolves_with_candidates: number;
      accepted_count: number;
      acceptance_rate: number;
      observed_mrr: number;
      top1_acceptance_rate: number;
      uncorrelated_fetch_count: number;
    };

export interface StatsResponse {
  since: string;
  until: string;
  total_requests: number;
  empty_shortlist_count: number;
  empty_shortlist_rate: number;
  retrieval_totals: RetrievalTotals;
  degraded_count: number;
  average_latency_ms: number;
  skills: SkillStat[];
  top_empty_shortlist_queries: EmptyShortlistQuery[];
  acceptance: AcceptanceSignal;
  top_unused_shortlist_queries: EmptyShortlistQuery[];
}

const RELATIVE_WINDOW = /^(\d+)([hdwmy])$/;
const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  m: 2_592_000_000,
  y: 31_536_000_000,
};

export function parseSince(since: string, now: Date = new Date()): Date {
  if (!SINCE_PATTERN.test(since)) throw new Error(`invalid --since window: ${since}`);

  const relative = RELATIVE_WINDOW.exec(since);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = UNIT_MS[relative[2]!]!;
    return new Date(now.getTime() - amount * unitMs);
  }

  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --since window: ${since}`);
  return parsed;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function computeStats(
  rows: AuditRow[],
  since: Date,
  until: Date,
  fetchRows: FetchAuditRow[] = [],
): StatsResponse {
  const retrieval_totals: RetrievalTotals = { exact: 0, reranked: 0, hybrid: 0, lexical: 0 };
  const skillCounts = new Map<string, number>();
  const emptyShortlistCounts = new Map<string, number>();
  const resolvesWithCandidates = new Map<number, AuditRow>();
  let empty_shortlist_count = 0;
  let degraded_count = 0;
  let total_latency_ms = 0;

  for (const row of rows) {
    if (row.retrieval in retrieval_totals) {
      retrieval_totals[row.retrieval]++;
    }

    if (row.degraded_from || row.degradation_reason) {
      degraded_count++;
    }

    total_latency_ms += row.latency_ms;

    if (row.candidates.length === 0) {
      empty_shortlist_count++;
      emptyShortlistCounts.set(row.query, (emptyShortlistCounts.get(row.query) ?? 0) + 1);
    } else {
      resolvesWithCandidates.set(row.id, row);
      const seenInRow = new Set<string>();
      for (const candidate of row.candidates) {
        if (!candidate.skill_id) continue;
        if (seenInRow.has(candidate.skill_id)) continue;
        seenInRow.add(candidate.skill_id);
        skillCounts.set(candidate.skill_id, (skillCounts.get(candidate.skill_id) ?? 0) + 1);
      }
    }
  }

  let uncorrelated_fetch_count = 0;
  const firstFetchByResolve = new Map<number, FetchAuditRow>();
  for (const fetch of fetchRows) {
    if (fetch.resolve_audit_id === null) {
      uncorrelated_fetch_count++;
      continue;
    }
    if (!resolvesWithCandidates.has(fetch.resolve_audit_id)) continue;
    const existing = firstFetchByResolve.get(fetch.resolve_audit_id);
    if (!existing || fetch.ts < existing.ts) {
      firstFetchByResolve.set(fetch.resolve_audit_id, fetch);
    }
  }

  const acceptedResolveIds = new Set(firstFetchByResolve.keys());
  const accepted_count = acceptedResolveIds.size;
  const acceptance: AcceptanceSignal =
    accepted_count > 0
      ? (() => {
          let reciprocalRankSum = 0;
          let top1Count = 0;
          for (const fetch of firstFetchByResolve.values()) {
            const rank = fetch.rank_at_resolve;
            if (rank !== null) {
              reciprocalRankSum += 1 / rank;
              if (rank === 1) top1Count++;
            }
          }
          return {
            available: true as const,
            resolves_with_candidates: resolvesWithCandidates.size,
            accepted_count,
            acceptance_rate: accepted_count / resolvesWithCandidates.size,
            observed_mrr: reciprocalRankSum / accepted_count,
            top1_acceptance_rate: top1Count / accepted_count,
            uncorrelated_fetch_count,
          };
        })()
      : { available: false as const, uncorrelated_fetch_count };

  const unusedShortlistCounts = new Map<string, number>();
  for (const [id, row] of resolvesWithCandidates) {
    if (acceptedResolveIds.has(id)) continue;
    unusedShortlistCounts.set(row.query, (unusedShortlistCounts.get(row.query) ?? 0) + 1);
  }

  const total_requests = rows.length;
  const empty_shortlist_rate = total_requests > 0 ? empty_shortlist_count / total_requests : 0;
  const average_latency_ms = total_requests > 0 ? total_latency_ms / total_requests : 0;

  const skills: SkillStat[] = [...skillCounts.entries()]
    .map(([skill_id, candidate_count]) => ({ skill_id, candidate_count }))
    .sort((a, b) => {
      if (b.candidate_count !== a.candidate_count) {
        return b.candidate_count - a.candidate_count;
      }
      return compareCodeUnits(a.skill_id, b.skill_id);
    });

  const top_empty_shortlist_queries = topQueryCounts(emptyShortlistCounts);
  const top_unused_shortlist_queries = topQueryCounts(unusedShortlistCounts);

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    total_requests,
    empty_shortlist_count,
    empty_shortlist_rate,
    retrieval_totals,
    degraded_count,
    average_latency_ms,
    skills,
    top_empty_shortlist_queries,
    acceptance,
    top_unused_shortlist_queries,
  };
}

function topQueryCounts(counts: Map<string, number>): EmptyShortlistQuery[] {
  return [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return compareCodeUnits(a.query, b.query);
    })
    .slice(0, 20);
}

interface AuditTableRow {
  id: number;
  ts: string;
  request_id: string | null;
  query: string;
  retrieval: AuditRow["retrieval"];
  degraded_from: string | null;
  degradation_reason: string | null;
  candidates: string;
  latency_ms: number;
}

export function queryAuditRows(db: Database, sinceIso: string): AuditRow[] {
  const rows = db
    .query(
      "SELECT id, ts, request_id, query, retrieval, degraded_from, degradation_reason, candidates, latency_ms FROM audit WHERE ts >= ? ORDER BY ts ASC",
    )
    .all(sinceIso) as AuditTableRow[];

  return rows.map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidates);
    } catch {
      throw new Error(`Failed to parse candidates JSON for audit row ${row.id}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid candidates JSON for audit row ${row.id}: expected array, got ${typeof parsed}`);
    }
    const candidates: AuditCandidate[] = parsed.map((c: any, index: number) => {
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.skill_id !== "string") {
        throw new Error(`Invalid candidate at index ${index} for audit row ${row.id}: missing or invalid skill_id`);
      }
      const score = c.score;
      if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
        throw new Error(`Invalid candidate at index ${index} for audit row ${row.id}: missing or invalid score`);
      }
      return {
        skill_id: c.skill_id,
        score,
      };
    });

    const result: AuditRow = {
      id: row.id,
      ts: row.ts,
      request_id: row.request_id,
      query: row.query,
      retrieval: row.retrieval,
      candidates,
      latency_ms: row.latency_ms,
    };
    if (row.degraded_from !== null && row.degraded_from !== undefined) {
      result.degraded_from = row.degraded_from as AuditRow["degraded_from"];
    }
    if (row.degradation_reason !== null && row.degradation_reason !== undefined) {
      result.degradation_reason = row.degradation_reason as AuditRow["degradation_reason"];
    }
    return result;
  });
}

export function queryFetchRows(db: Database, sinceIso: string): FetchAuditRow[] {
  return db
    .query(
      "SELECT id, ts, skill_id, request_id, resolve_audit_id, rank_at_resolve FROM fetch WHERE ts >= ? ORDER BY ts ASC",
    )
    .all(sinceIso) as FetchAuditRow[];
}

export function getStats(db: Database, since: string, now: Date = new Date()): StatsResponse {
  const sinceDate = parseSince(since, now);
  const rows = queryAuditRows(db, sinceDate.toISOString());
  const fetchRows = queryFetchRows(db, sinceDate.toISOString());
  return computeStats(rows, sinceDate, now, fetchRows);
}

export function renderStatsText(stats: StatsResponse): string {
  const lines: string[] = [];
  lines.push(`window: ${stats.since} .. ${stats.until}`);
  lines.push(
    `requests: total=${stats.total_requests} empty_shortlist=${stats.empty_shortlist_count} ` +
      `(empty_shortlist_rate=${stats.empty_shortlist_rate.toFixed(3)}) ` +
      `degraded=${stats.degraded_count} avg_latency_ms=${stats.average_latency_ms.toFixed(1)}`,
  );
  lines.push(
    `retrieval: exact=${stats.retrieval_totals.exact} reranked=${stats.retrieval_totals.reranked} ` +
      `hybrid=${stats.retrieval_totals.hybrid} lexical=${stats.retrieval_totals.lexical}`,
  );

  lines.push("skills:");
  if (stats.skills.length === 0) {
    lines.push("  (none)");
  } else {
    for (const skill of stats.skills) {
      lines.push(`  ${skill.skill_id} candidate=${skill.candidate_count}`);
    }
  }

  lines.push("top empty shortlist queries:");
  if (stats.top_empty_shortlist_queries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of stats.top_empty_shortlist_queries) {
      lines.push(`  "${entry.query}" (${entry.count})`);
    }
  }

  if (stats.acceptance.available) {
    lines.push(
      `acceptance: acceptance_rate=${stats.acceptance.acceptance_rate.toFixed(3)} ` +
        `observed_mrr=${stats.acceptance.observed_mrr.toFixed(3)} ` +
        `top1_acceptance_rate=${stats.acceptance.top1_acceptance_rate.toFixed(3)} ` +
        `(accepted=${stats.acceptance.accepted_count}/${stats.acceptance.resolves_with_candidates}, ` +
        `uncorrelated_fetch_count=${stats.acceptance.uncorrelated_fetch_count})`,
    );
  } else {
    lines.push(`acceptance: unavailable (uncorrelated_fetch_count=${stats.acceptance.uncorrelated_fetch_count})`);
  }

  lines.push("top unused shortlist queries:");
  if (stats.top_unused_shortlist_queries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of stats.top_unused_shortlist_queries) {
      lines.push(`  "${entry.query}" (${entry.count})`);
    }
  }

  return lines.join("\n");
}
