import type { RankedCandidate, Thresholds } from "./types";

export interface DecisionInput {
  reranked: boolean;
  candidates: RankedCandidate[];
  thresholds: Thresholds;
}

export type Decision =
  | { outcome: "matched"; skill_id: string; score: number; margin: number }
  | { outcome: "ambiguous"; candidates: RankedCandidate[] }
  | { outcome: "no_match" };

export function decideResolveOutcome({ reranked, candidates, thresholds }: DecisionInput): Decision {
  if (candidates.length === 0) return { outcome: "no_match" };

  // Degraded lane: no comparable scores exist, so never match; the (BM25-ordered)
  // Without calibrated reranker scores, the shortlist goes to the calling LLM.
  if (!reranked) return { outcome: "ambiguous", candidates: candidates.slice(0, thresholds.candidate_limit) };

  if (
    thresholds.match_score === undefined
    || thresholds.match_margin === undefined
    || thresholds.candidate_floor === undefined
  ) {
    throw new Error("Reranked decisions require calibrated thresholds.");
  }
  const { match_score, match_margin, candidate_floor } = thresholds;

  const sorted = [...candidates].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const eligible = sorted.filter((c) => (c.score ?? -Infinity) >= candidate_floor);
  if (eligible.length === 0) return { outcome: "no_match" };

  const top = eligible[0]!;
  const topScore = top.score!;
  const margin = sorted.length === 1 ? topScore : topScore - (sorted[1]!.score ?? 0);

  if (topScore >= match_score && margin >= match_margin) {
    return { outcome: "matched", skill_id: top.skill_id, score: topScore, margin };
  }
  return { outcome: "ambiguous", candidates: eligible.slice(0, thresholds.candidate_limit) };
}
