import type { Database } from "bun:sqlite";
import type { AuditCandidate, AuditRow } from "./types";

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

export function computeStats(rows: AuditRow[], since: Date, until: Date): StatsResponse {
  const retrieval_totals: RetrievalTotals = { exact: 0, reranked: 0, hybrid: 0, lexical: 0 };
  const skillCounts = new Map<string, number>();
  const emptyShortlistCounts = new Map<string, number>();
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
      const seenInRow = new Set<string>();
      for (const candidate of row.candidates) {
        if (!candidate.skill_id) continue;
        if (seenInRow.has(candidate.skill_id)) continue;
        seenInRow.add(candidate.skill_id);
        skillCounts.set(candidate.skill_id, (skillCounts.get(candidate.skill_id) ?? 0) + 1);
      }
    }
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
      return a.skill_id.localeCompare(b.skill_id);
    });

  const top_empty_shortlist_queries: EmptyShortlistQuery[] = [...emptyShortlistCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.query.localeCompare(b.query);
    })
    .slice(0, 20);

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
  };
}

interface AuditTableRow {
  id: number;
  ts: string;
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
      "SELECT id, ts, query, retrieval, degraded_from, degradation_reason, candidates, latency_ms FROM audit WHERE ts >= ? ORDER BY ts ASC",
    )
    .all(sinceIso) as AuditTableRow[];

  return rows.map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidates);
    } catch {
      throw new Error(`Failed to parse candidates JSON for audit row ${row.id}: ${row.candidates}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid candidates JSON for audit row ${row.id}: expected array, got ${typeof parsed}`);
    }
    const candidates: AuditCandidate[] = parsed.map((c: any, index: number) => {
      if (!c || typeof c !== "object" || typeof c.skill_id !== "string") {
        throw new Error(`Invalid candidate at index ${index} for audit row ${row.id}: missing or invalid skill_id`);
      }
      return {
        skill_id: c.skill_id,
        score: typeof c.score === "number" ? c.score : null,
      };
    });

    const result: AuditRow = {
      id: row.id,
      ts: row.ts,
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

export function getStats(db: Database, since: string, now: Date = new Date()): StatsResponse {
  const sinceDate = parseSince(since, now);
  const rows = queryAuditRows(db, sinceDate.toISOString());
  return computeStats(rows, sinceDate, now);
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

  return lines.join("\n");
}
