# Ranked-shortlist migration

The ranked-shortlist release replaces threshold-based classification with ranked candidate retrieval. Instead of classifying a query as `matched`, `ambiguous`, or `no_match` and returning inline skill text on match, `resolve_skill` always returns a ranked shortlist of candidate summaries. The calling client reviews the shortlist and invokes `fetch_skill` to load the full instructions for the chosen skill.

## Upgrading configuration

Legacy threshold configuration tables and candidate limits are obsolete. Threshold values do not map semantically to candidate list lengths; replace threshold tables with retrieval depth and output bounds.

In `~/.config/skillmux/config.toml`, configure `[recall]` to control candidate generation and `[output]` to set candidate shortlist limits:

```toml
vault_path = "~/skills"
state_dir = "~/.local/state/skillmux"

[recall]
k_lexical = 20
k_vector = 20
k_rerank = 10

[output]
top_k = 10
max_top_k = 50
```

`recall.k_lexical` and `recall.k_vector` set the number of candidates retrieved from FTS5 lexical search and vector similarity before reciprocal rank fusion. `recall.k_rerank` limits the candidate shortlist sent to an optional remote reranker adapter and cannot exceed `k_lexical + k_vector`.

`output.top_k` sets the default maximum number of candidates returned by `resolve_skill`. `output.max_top_k` sets the upper bound for per-request `top_k` overrides. When a remote reranker is configured, `output.max_top_k` cannot exceed `recall.k_rerank`.

Existing `calibrate.sqlite3` databases in `state_dir` remain untouched on disk. Skillmux does not delete or modify historical calibration data.

## Obsolete configuration keys

Startup fails with an explicit error when obsolete configuration keys are present:

| Obsolete configuration key | Replacement | Migration guidance |
| --- | --- | --- |
| `[thresholds]` | `[output].top_k` | The `[thresholds]` table is obsolete. Threshold calibration was removed; use `[output]` with `top_k`. |
| `output.ambiguous_candidate_limit` | `output.top_k` | `output.ambiguous_candidate_limit` is obsolete. Use `output.top_k` instead. |
| `inference.thresholds` | Removed | `inference.thresholds` is obsolete. Threshold calibration was removed. |
| `inference.calibration` | `skillmux eval` | `inference.calibration` is obsolete and should be deleted. Threshold calibration was removed; use `skillmux eval` for ranking evaluation. |
| `skillmux calibrate` | `skillmux eval` | `skillmux calibrate` was removed. Threshold calibration was removed; use `skillmux eval` for ranking evaluation. |

## Wire contract changes

In the legacy classifier contract, `resolve_skill` returned an `outcome` classification and delivered the complete `SKILL.md` body directly when a single match met threshold criteria:

```json
{
  "outcome": "matched",
  "retrieval": "reranked",
  "skill_id": "csv-formatter",
  "title": "CSV Formatter",
  "content_sha256": "8a3f...",
  "body": "# CSV Formatter\n...",
  "files": [],
  "candidates": [
    {
      "rank": 1,
      "skill_id": "csv-formatter",
      "score": 0.95
    }
  ]
}
```

In the current contract, `resolve_skill` returns ranked candidate summaries with descriptions and scores. The client reviews candidate descriptions and calls `fetch_skill` with the desired `skill_id` to retrieve instructions and supporting files:

```json
{
  "retrieval": "reranked",
  "candidates": [
    {
      "rank": 1,
      "skill_id": "csv-formatter",
      "description": "Convert CSV and spreadsheet data into clean Markdown tables.",
      "score": 0.92
    },
    {
      "rank": 2,
      "skill_id": "table-helper",
      "description": "Format ASCII and Markdown tables.",
      "score": 0.74
    }
  ]
}
```

When retrieval finds no candidates, `resolve_skill` returns an empty candidate list:

```json
{
  "retrieval": "hybrid",
  "candidates": []
}
```

When upstream embedding or reranking endpoints fail or time out, Skillmux falls back to the next available retrieval lane and reports structured degradation metadata:

```json
{
  "retrieval": "hybrid",
  "degraded_from": "reranked",
  "degradation_reason": "reranker_timeout",
  "candidates": [
    {
      "rank": 1,
      "skill_id": "csv-formatter",
      "description": "Convert CSV and spreadsheet data into clean Markdown tables.",
      "score": 0.033
    }
  ]
}
```

## Audit database migration

On startup, Skillmux inspects the `audit` table in `state_dir/index.sqlite3`. If legacy classifier columns (`outcome`, `selected_skill_id`, `degraded`) are present, it migrates the table inside an atomic SQLite transaction:

```sql
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  query TEXT NOT NULL,
  retrieval TEXT NOT NULL DEFAULT 'lexical',
  degraded_from TEXT,
  degradation_reason TEXT,
  candidates TEXT NOT NULL,
  latency_ms INTEGER NOT NULL
);
```

Historical rows retain their `id`, `ts`, `query`, `retrieval`, `candidates`, and `latency_ms` values. Classifier-only columns are removed.

## Ranking evaluation

Use `skillmux eval` to evaluate retrieval and ranking quality across lexical and hybrid pipelines:

```sh
skillmux eval
```

The `skillmux eval` command reads the default `eval/queries.json` dataset from the repository because the CLI currently has no `--dataset` flag.

Evaluation cases specify `relevant_skill_ids` as an array of skill identifiers rather than legacy outcome fields:

```json
{
  "query": "format a csv file",
  "relevant_skill_ids": ["csv-formatter"],
  "split": "test"
}
```

Legacy fields `expected` and `expected_outcome` are rejected with validation errors. Cases with empty `relevant_skill_ids: []` represent unjudged queries and are excluded from aggregate ranking metrics without penalizing the evaluation score.

The evaluation report computes four ranking metrics for lexical and hybrid retrieval:
- Recall@5 measures the fraction of relevant skills found in the top 5 candidates.
- Recall@10 measures the fraction of relevant skills found in the top 10 candidates.
- Mean Reciprocal Rank (MRR) measures the reciprocal rank of the first relevant candidate.
- Binary nDCG@10 discounts relevance logarithmically across the top 10 positions.
