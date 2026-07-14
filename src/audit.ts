import type { AuditRow } from "./types";

/** Shape an audit row to exactly the schema's AuditRow fields — nothing extra survives. */
export function buildAuditRow(row: AuditRow): AuditRow {
  return {
    id: row.id,
    ts: row.ts,
    query: row.query,
    outcome: row.outcome,
    degraded: row.degraded,
    candidates: row.candidates.map((c) => ({ skill_id: c.skill_id, score: c.score })),
    selected_skill_id: row.selected_skill_id,
    latency_ms: row.latency_ms,
  };
}
