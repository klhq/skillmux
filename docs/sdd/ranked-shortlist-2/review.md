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
