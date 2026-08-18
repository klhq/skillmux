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
