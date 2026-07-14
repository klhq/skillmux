import type { Candidate, Thresholds } from "./types";

export interface DecisionInput {
  degraded: boolean;
  candidates: Candidate[];
  thresholds: Thresholds;
}

export type Decision =
  | { outcome: "matched"; skill_id: string; score: number; margin: number }
  | { outcome: "ambiguous"; candidates: Candidate[] }
  | { outcome: "no_match" };

const MAX_SHORTLIST = 5;

export function decideResolveOutcome({ degraded, candidates, thresholds }: DecisionInput): Decision {
  if (candidates.length === 0) return { outcome: "no_match" };

  // Degraded lane: no comparable scores exist, so never match; the (BM25-ordered)
  // shortlist goes to the calling LLM instead (AC7).
  if (degraded) return { outcome: "ambiguous", candidates: candidates.slice(0, MAX_SHORTLIST) };

  const sorted = [...candidates].sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
  const eligible = sorted.filter((c) => (c.rerank_score ?? -Infinity) >= thresholds.candidate_floor);
  if (eligible.length === 0) return { outcome: "no_match" };

  const top = eligible[0]!;
  const topScore = top.rerank_score!;
  const margin = sorted.length === 1 ? topScore : topScore - (sorted[1]!.rerank_score ?? 0);

  if (topScore >= thresholds.match_score && margin >= thresholds.match_margin) {
    return { outcome: "matched", skill_id: top.skill_id, score: topScore, margin };
  }
  return { outcome: "ambiguous", candidates: eligible.slice(0, MAX_SHORTLIST) };
}
