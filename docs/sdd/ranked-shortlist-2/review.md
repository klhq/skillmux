# PR 1 review: ranked-only runtime contract

## Summary

PR 1 establishes the Skillmux 2.0 ranked-shortlist runtime contract. Local,
MCP, and HTTP-backed resolution now return a bounded ordered candidate list
without threshold suppression or a match-classification response. Configuration
uses `output.top_k` and `output.max_top_k`, and legacy threshold/output keys fail
with migration guidance.

The first implementation review found three contract gaps and one configuration
invariant bug. The branch was corrected to enforce `max_top_k <= k_rerank` when
remote reranking is enabled, update generated discovery instructions, make the
configured maximum authoritative on the MCP wire, and remove the legacy audit
outcome union from the public JSON schema.

The internal audit, evaluation, and calibration implementations intentionally
remain transitional in this layer. Their removal or replacement belongs to PRs
2 and 3 in `plan.md`.

## Review findings

- Security: no new credential handling, privileged action, filesystem write, or
  network egress was introduced. Request `top_k` is validated as a positive
  integer and bounded by configuration.
- Correctness: ranked results are bounded, ordered, and assigned contiguous
  one-based ranks. Reranker degradation preserves the response shape.
- Performance: the change does not add retrieval or reranker calls. `top_k`
  slices the already-ranked candidate pool.
- Compatibility: obsolete configuration is rejected explicitly instead of
  silently changing meaning. Existing calibration databases are untouched.
- Tests: supervisor verification completed with 703 passing tests, zero
  failures, clean `bun x tsc --noEmit`, and a successful compiled build.

## AC Status

| Criterion | Status | Notes |
|---|---|---|
| Every successful local, MCP, and server resolution returns zero through effective `top_k` ranked candidates with contiguous one-based ranks. | ✅ Done | Covered by router and MCP contract tests. |
| Resolution never suppresses candidates because of score, margin, or candidate-floor thresholds. | ✅ Done | Runtime decision step was removed. |
| Default output is 10 candidates and request overrides are bounded by a default maximum of 50. | ✅ Done | Config, environment, and MCP tests cover defaults and bounds. |
| Reranker degradation preserves the response schema and returns fused-order candidates. | ✅ Done | Covered by degraded-lane router and server tests. |
| No public schema contains the legacy outcome union or threshold fields. | ✅ Done | Contract test scans `docs/schema.json`; transitional internals are not exported there. |
| No public CLI help or capability response advertises calibration. | ❌ Missing | Deliberately deferred to PR 3, which removes calibration. |
| Ranking evaluation does not mutate configuration or runtime indexes. | ❌ Missing | Ranking evaluation replacement is PR 2. |
| Existing calibration databases are left untouched. | ✅ Done | PR 1 performs no calibration database deletion or migration. |
| Configuration and command migration errors are explicit. | ⚠️ Manual-verify | Configuration errors are complete; removed-command guidance is deferred to PR 3. |
| Unit, integration, CLI, MCP, schema, typecheck, and build verification pass. | ✅ Done | 703 tests passed; typecheck and compiled build passed. |

## Verdict

PR 1 is ready to ship as the first layer of the Skillmux 2.0 migration. The
three incomplete full-feature criteria are planned work, not hidden regressions
in this layer.

# PR 2 review: ranking evaluation

## Summary

PR 2 replaces decision-policy evaluation with read-only ranking evaluation.
Datasets now use `query`, optional `split`, and `relevant_skill_ids`; empty
relevance lists remain visible as unjudged queries but do not affect ranking
metric denominators. Reports expose Recall@5, Recall@10, MRR, and binary
nDCG@10 for lexical and delivered hybrid rankings.

Review found one avoidable reconstruction of the final ranking and two label
validation gaps. The final ranking now comes directly from the runtime's
delivered candidates, and evaluation rejects empty or duplicate relevant IDs
before they can distort metric denominators.

## Review findings

- Security: no privileged action, filesystem mutation beyond fixture reads, or
  new network boundary was introduced.
- Correctness: empty-relevance cases are excluded from every metric denominator;
  multi-relevant Recall and nDCG use the specified definitions; legacy decision
  fields fail with migration guidance.
- Performance: each query performs the existing retrieval operation once. The
  final hybrid ranking reuses delivered candidate order without sorting traces.
- Tests: supervisor verification completed with 712 passing tests, zero
  failures, clean `bun x tsc --noEmit`, and a successful compiled build.

## PR 2 AC Status

| Criterion | Status | Notes |
|---|---|---|
| Labelled query cases contain `query`, `split`, and `relevant_skill_ids`; `expected_outcome` is removed. | ✅ Done | Parser and fixture migration tests cover the new contract and legacy errors. |
| Evaluation reports Recall@5, Recall@10, MRR, and nDCG for multi-relevant cases. | ✅ Done | Metric unit tests cover single, multi-relevant, missing, and unjudged cases. |
| Evaluation preserves latency and degradation evidence without decision outcomes. | ✅ Done | Per-case integration tests cover reranked and degraded retrieval. |
| Ranking evaluation does not mutate configuration or runtime indexes. | ✅ Done | Evaluation only reads the configured runtime and performs retrieval; no apply or persistence path is called. |
| Maintained labels are migrated mechanically without inference from prior certification. | ✅ Done | Existing relevant IDs and empty lists are unchanged in `eval/queries.json`. |

## PR 2 verdict

PR 2 is ready to ship. Calibration remains intentionally intact until PR 3.
