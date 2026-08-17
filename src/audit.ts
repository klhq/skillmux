import type { AuditRow } from "./types";

/** Shape an audit row to exactly the schema's AuditRow fields — nothing extra survives. */
export function buildAuditRow(row: AuditRow): AuditRow {
  const built: AuditRow = {
    id: row.id,
    ts: row.ts,
    query: row.query,
    outcome: row.outcome,
    retrieval: row.retrieval,
    candidates: row.candidates.map((c) => ({ skill_id: c.skill_id, score: c.score })),
    selected_skill_id: row.selected_skill_id,
    latency_ms: row.latency_ms,
  };
  if (row.degraded_from !== undefined && row.degraded_from !== null) {
    built.degraded_from = row.degraded_from;
  }
  if (row.degradation_reason !== undefined && row.degradation_reason !== null) {
    built.degradation_reason = row.degradation_reason;
  }
  return built;
}
