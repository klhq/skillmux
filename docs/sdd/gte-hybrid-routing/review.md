# Review: GTE hybrid routing

## Findings

No unresolved correctness, security, or performance findings.

Review fixes applied:

- Marked superseded historical specs and schemas to prevent stale response contracts from appearing current.
- Removed remaining public score assumptions from tests and current schema language.
- Added `retrieval = "exact"` so exact skill ID/title/alias matches do not falsely claim reranker use.

## Verification

- `bun test`: 88 passed, 0 failed.
- `bunx tsc --noEmit`: passed.
- `bun run build`: passed.
- Local `Xenova/gte-small` test on `workhorse`: passed.
- Local labeled evaluation on `workhorse`: hybrid recall@3 1.000, recall@5 1.000, MRR 1.000 across 8 queries; no remote inference used.
- Local benchmark: 34 MB cache, 2.3 s cold load, 6 ms warm query, approximately 159 MB RSS increase.

## AC Status

| Criterion | Status | Notes |
|---|---|---|
| GHR-AC1 | Done | GTE-small local embedding-only bundle |
| GHR-AC2 | Done | Deterministic RRF with configured top-k values |
| GHR-AC3 | Done | Hybrid and lexical retrieval return shortlists only |
| GHR-AC4 | Done | Remote embedding required; reranker optional |
| GHR-AC5 | Done | Reranker failure preserves hybrid shortlist |
| GHR-AC6 | Done | Retrieval capability replaces degraded; public scores removed |
| GHR-AC7 | Done | Model download and doctor support embedding-only mode |
| GHR-AC8 | Done | Minimal quick start; advanced retrieval remains optional |
| GHR-AC9 | Done | Checked-in labeled local evaluation |
| GHR-AC10 | Done | Local budgets and full automated verification passed |
