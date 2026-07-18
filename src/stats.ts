import type { Database } from "bun:sqlite";
import type { AuditCandidate, AuditRow } from "./types";

export const SINCE_PATTERN = /^(\d+[hdwmy]|\d{4}-\d{2}-\d{2}([T ].+)?)$/;

export interface SkillStat {
  skill_id: string;
  matched_count: number;
  candidate_count: number;
}

export interface NoMatchQuery {
  query: string;
  count: number;
}

export interface StatsResponse {
  since: string;
  until: string;
  outcome_totals: { matched: number; ambiguous: number; no_match: number };
  ambiguous_rate: number;
  skills: SkillStat[];
  top_no_match_queries: NoMatchQuery[];
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
  const outcome_totals = { matched: 0, ambiguous: 0, no_match: 0 };
  const skillStats = new Map<string, { matched_count: number; candidate_count: number }>();
  const noMatchCounts = new Map<string, number>();

  function statFor(skillId: string) {
    let stat = skillStats.get(skillId);
    if (!stat) {
      stat = { matched_count: 0, candidate_count: 0 };
      skillStats.set(skillId, stat);
    }
    return stat;
  }

  for (const row of rows) {
    outcome_totals[row.outcome]++;

    const seenInRow = new Set<string>();
    for (const candidate of row.candidates) {
      if (seenInRow.has(candidate.skill_id)) continue;
      seenInRow.add(candidate.skill_id);
      statFor(candidate.skill_id).candidate_count++;
    }

    if (row.outcome === "matched" && row.selected_skill_id) {
      statFor(row.selected_skill_id).matched_count++;
    }

    if (row.outcome === "no_match") {
      noMatchCounts.set(row.query, (noMatchCounts.get(row.query) ?? 0) + 1);
    }
  }

  const total = outcome_totals.matched + outcome_totals.ambiguous + outcome_totals.no_match;
  const ambiguous_rate = total > 0 ? outcome_totals.ambiguous / total : 0;

  const skills = [...skillStats.entries()]
    .map(([skill_id, stat]) => ({ skill_id, ...stat }))
    .sort((a, b) => b.matched_count - a.matched_count);

  const top_no_match_queries = [...noMatchCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    outcome_totals,
    ambiguous_rate,
    skills,
    top_no_match_queries,
  };
}

interface AuditTableRow {
  id: number;
  ts: string;
  query: string;
  outcome: AuditRow["outcome"];
  retrieval: AuditRow["retrieval"];
  candidates: string;
  selected_skill_id: string | null;
  latency_ms: number;
}

export function queryAuditRows(db: Database, sinceIso: string): AuditRow[] {
  const rows = db
    .query("SELECT id, ts, query, outcome, retrieval, candidates, selected_skill_id, latency_ms FROM audit WHERE ts >= ? ORDER BY ts ASC")
    .all(sinceIso) as AuditTableRow[];
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    query: row.query,
    outcome: row.outcome,
    retrieval: row.retrieval,
    candidates: JSON.parse(row.candidates) as AuditCandidate[],
    selected_skill_id: row.selected_skill_id,
    latency_ms: row.latency_ms,
  }));
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
    `outcomes: matched=${stats.outcome_totals.matched} ambiguous=${stats.outcome_totals.ambiguous} ` +
      `no_match=${stats.outcome_totals.no_match} (ambiguous_rate=${stats.ambiguous_rate.toFixed(3)})`,
  );

  lines.push("skills:");
  if (stats.skills.length === 0) {
    lines.push("  (none)");
  } else {
    for (const skill of stats.skills) {
      lines.push(`  ${skill.skill_id} matched=${skill.matched_count} candidate=${skill.candidate_count}`);
    }
  }

  lines.push("top no_match queries:");
  if (stats.top_no_match_queries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of stats.top_no_match_queries) {
      lines.push(`  "${entry.query}" (${entry.count})`);
    }
  }

  return lines.join("\n");
}
