# Skillmux 2.0 ranked shortlist

## Problem

Skillmux currently turns retrieval scores into `matched`, `ambiguous`, or
`no_match` decisions by applying calibrated global thresholds. The production
infra corpus demonstrated that retrieval can find the correct skill while the
threshold policy fails to generalize. The classifier adds operational cost and
complexity without improving the caller's ability to choose a skill.

## Goal

Make Skillmux a ranked retrieval service. Every successful `resolve_skill`
request returns an ordered, bounded candidate list. Skillmux does not claim
that a candidate is a confident match. The calling agent may fetch one or more
skills or ignore the entire list.

## Non-goals

- Skillmux does not estimate semantic confidence.
- Skillmux does not automatically fetch the first candidate.
- Skillmux does not tune production configuration from labelled data.
- This change does not redesign lexical, vector, RRF, or reranker scoring.

## Contract

### Resolution pipeline

1. Run lexical and vector retrieval using their existing independent budgets.
2. Fuse candidates using the existing RRF implementation.
3. Rerank up to `k_rerank` candidates when a reranker is configured and
   available.
4. Fall back to fused order when reranking is unavailable under the existing
   resilience policy.
5. Sort in descending effective score order.
6. Return at most the effective `top_k` candidates.

The pipeline returns an empty `candidates` array when no candidates exist. It
never returns a match-classification outcome.

### Response schema

`resolve_skill` returns structured content with:

- `retrieval`: the effective retrieval mode and any existing degradation
  metadata.
- `candidates`: an array in final rank order.

Every candidate contains:

- `rank`: one-based position in the returned list.
- `skill_id`: canonical skill identifier.
- `description`: compact skill description used by the caller to choose.
- `score`: final ordering score. It is not documented as a probability or a
  confidence guarantee.

No response contains `outcome`, `match`, `matched`, `ambiguous`, or
`no_match`. `fetch_skill` remains the only operation that returns a complete
skill document.

### Output configuration

Replace `output.ambiguous_candidate_limit` with:

```toml
[output]
top_k = 10
max_top_k = 50
```

- `top_k` defaults to 10.
- `max_top_k` defaults to 50.
- Both values must be positive integers.
- `top_k` must not exceed `max_top_k`.
- A request may override `top_k`, but the value must be a positive integer and
  must not exceed `max_top_k`.
- The effective output count is naturally bounded by the available candidates
  and the reranked pool. Configuration validation must reject an output budget
  that exceeds the effective `k_rerank` when reranking is enabled.

The obsolete `[thresholds]` table and
`output.ambiguous_candidate_limit` are invalid in 2.0. Validation errors must
name the replacement or explain that threshold calibration was removed.

### Evaluation

Labelled query cases contain `query`, `split`, and `relevant_skill_ids`.
`expected_outcome` is removed. Evaluation is read-only and reports ranking
quality, including Recall@5, Recall@10, MRR, and nDCG for multi-relevant cases,
plus existing latency and degradation data where available. Evaluation never
writes runtime configuration.

### Calibration removal

Remove the public `calibrate` CLI, adapter methods, server capability and
endpoint declarations, threshold optimizer, certification gates, apply/resume
flow, and calibration-only persistence code. Do not delete an operator's
existing calibration database from disk. Version 2.0 simply stops reading and
writing it.

### Versioning and migration

This is a breaking 2.0 contract. We do not preserve legacy response variants
inside the runtime because doing so would retain the classifier architecture.
The migration guide must map:

- `output.ambiguous_candidate_limit` to `output.top_k`.
- calibrated threshold configuration to deletion.
- outcome branching to candidate-list inspection.
- calibration datasets to ranking-evaluation datasets.

Unknown legacy keys and the removed `calibrate` command fail with concise,
actionable messages. They must not silently change meaning.

## Acceptance criteria

1. Every successful local, MCP, and server resolution returns zero through
   effective `top_k` ranked candidates with contiguous one-based ranks.
2. Resolution never suppresses candidates because of score, margin, or
   candidate-floor thresholds.
3. Default output is 10 candidates and request overrides are bounded by a
   default maximum of 50.
4. Reranker degradation preserves the response schema and returns fused-order
   candidates.
5. No public schema contains the legacy outcome union or threshold fields.
6. No public CLI help or capability response advertises calibration.
7. Ranking evaluation does not mutate configuration or runtime indexes.
8. Existing calibration databases are left untouched.
9. Configuration and command migration errors are explicit.
10. Unit, integration, CLI, MCP, schema, typecheck, and build verification pass.

