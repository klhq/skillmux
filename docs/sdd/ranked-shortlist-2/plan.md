# Implementation plan

## PR 1: Ranked-only runtime contract

- Add red tests for ranked local, MCP, and server responses.
- Add `output.top_k` and `output.max_top_k` validation and request override.
- Replace decision outcomes with one ranked candidate-list response.
- Preserve retrieval and reranker fallback behavior.
- Update public JSON schemas and focused runtime documentation.
- Add migration errors for legacy output and threshold keys.

## PR 2: Ranking evaluation

- Replace decision-labelled dataset parsing with relevant-skill ranking labels.
- Report Recall@5, Recall@10, MRR, and nDCG.
- Keep cases with an empty `relevant_skill_ids` list, but exclude them from all
  ranking-metric denominators. Report their count as `unjudged_queries` so the
  report never treats “nothing labelled relevant” as a ranking failure or a
  successful no-match decision.
- Define Recall@K as the fraction of relevant skill IDs present in the first K
  results, averaged across judged queries. Define MRR from the first relevant
  result. Define nDCG@10 with binary relevance and an ideal ranking containing
  every relevant ID. A missing relevant result contributes zero.
- Evaluate the final delivered ranking for the `hybrid` lane: reranked order
  when reranking succeeds, and fused order when it is unavailable or degraded.
- Preserve per-case latency, retrieval mode, degradation metadata, recall
  settings, and rank traces. Remove the synthesized decision `outcome`.
- Keep the legacy `expected` field only as an explicit migration error. The
  accepted dataset shape is `query`, `split`, and `relevant_skill_ids`.
- Migrate maintained evaluation fixtures without inspecting or changing labels
  based on prior certification results.
- Remove evaluation dependencies on threshold decisions.

## PR 3: Calibration removal

- Remove the calibrate CLI and adapter surface.
- Remove optimizer, certification, apply, resume, and persistence code.
- Remove server calibration capabilities and endpoint placeholders.
- Leave existing on-disk calibration databases untouched.
- Remove calibration tests and dependencies only after replacement coverage is
  green.

## PR 4: 2.0 migration and release documentation

- Rewrite concepts, routing, configuration, deployment, troubleshooting, and
  README guidance.
- Publish the explicit 1.x-to-2.0 migration mapping.
- Verify examples, generated schemas, completions, and release packaging.

Each implementation PR follows strict red-green-refactor, then `sdd-review`,
then `gh-ship`. Agy receives only bounded tasks whose behavior is fully
determined by this specification. The supervising agent owns design decisions,
reviews every diff, and resolves any ambiguity before delegation.
