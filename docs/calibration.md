# Policy calibration

Calibration selects the three reranker-score thresholds that turn an ordered
shortlist into `matched`, `ambiguous`, or `no_match`. It is an operator action,
not background learning, and it currently runs only against a local Skillmux
target.

Read [MCP routing](mcp-routing.md#retrieval-pipeline) before calibrating a new
retrieval deployment.

## Lifecycle

The complete workflow is:

```text
install CLI → configure vault/index/embedding/reranker → obtain labelled dataset
    → calibrate run → review calibrate show RUN_ID → calibrate apply RUN_ID
    → live-reloaded policy handles subsequent requests
```

First configure and index the same vault, embedding model, and reranker that
will serve requests. Supply a reviewed dataset, or generate a starting point
and review every label:

```sh
skillmux calibrate generate-dataset --out ./eval/queries.json
skillmux calibrate run --dataset ./eval/queries.json
skillmux calibrate show RUN_ID
skillmux calibrate apply RUN_ID
```

Skillmux retrieves candidates and reranks exactly once for each evaluation
query. It runs four queries at a time by default. Set a different positive
worker limit with `--concurrency N`. The CLI writes completed-case progress to
stderr without exposing query text.

### Timing report

Add `--timing` to any `calibrate run` invocation to write an aggregate
performance report to **stderr** after the run finishes (with a completed or
failed-gates result; a thrown error produces no report). Stdout remains valid
JSON under `--json --timing`.

```sh
skillmux calibrate run --dataset ./eval/queries.json --timing
```

The report uses stable snake_case field names in milliseconds:

| Field | Description |
|---|---|
| `cases_total` | Total dataset cases |
| `cases_executed` | Cases retrieved in this invocation |
| `cases_reused` | Cases loaded from a prior interrupted run (resume) |
| `wall_ms` | Wall-clock duration of the full calibrateRun operation |
| `vault_sync_ms` | One-time vault synchronization before retrieval |
| `cumulative_embedding_ms` | Total worker time in embedding across all queries |
| `cumulative_lexical_ms` | Total worker time in lexical search across all queries |
| `cumulative_vector_ms` | Total worker time in vector search across all queries |
| `cumulative_reranker_ms` | Total worker time in reranking across all queries |
| `cumulative_checkpoint_ms` | Total worker time writing observation checkpoints |
| `policy_evaluation_ms` | Threshold selection and test-split certification |

**Cumulative vs wall time.** The cumulative fields (`cumulative_embedding_ms`,
`cumulative_lexical_ms`, `cumulative_vector_ms`, `cumulative_reranker_ms`,
`cumulative_checkpoint_ms`) are total _worker time_ summed across all concurrent
query retrievals. Because multiple queries run at the same time, the sum of these
fields typically exceeds `wall_ms`. They measure how much time each stage
consumed across all workers, not how much wall-clock time each stage accounted
for. `cases_executed + cases_reused = cases_total`.

Timing collection is fully disabled when `--timing` is absent; it does not affect
calibration results, resume behavior, checkpoint durability, or JSON schemas.
Skillmux checkpoints each observation in the calibration evidence database.
If inference fails or you interrupt the process, find the `running` run with
`calibrate list` and resume it with the same dataset and certification flags:

```sh
skillmux calibrate run --dataset ./eval/queries.json --resume RUN_ID
```

Resume rejects changes to the dataset, corpus, inference models, recall
settings, candidate limit, or certification gates. After all observations
exist, Skillmux searches thresholds on the `tune` split and certifies the
selected policy on the frozen `test` split. Calibration starts only when an
operator invokes `calibrate run`.

The operator owns the labels: supply or review the cases, start the run,
inspect its evidence, and explicitly apply an acceptable result. A successful
run never changes live thresholds by itself.

## Certification gates and preflight feasibility

Calibration certifies threshold policies against statistical confidence gates before allowing them to be applied:

| Flag | Default | Description |
|---|---|---|
| `--min-auto-match-precision` | `0.75` | Minimum 95% Wilson score lower confidence bound on auto-match precision |
| `--min-auto-match-count` | `15` | Minimum number of auto-matches required in evaluation |
| `--min-retrieval-recall-at-k` | `0.95` | Minimum top-k retrieval recall on matchable queries |
| `--min-delivered-shortlist-recall-at-k` | `0.95` | Minimum delivered shortlist recall on matchable queries |

### Wilson lower confidence bound and evidence size

`min-auto-match-precision` is evaluated not as raw sample accuracy, but as a **95% Wilson score lower confidence bound** ($z \approx 1.960$). This accounts for statistical uncertainty in small datasets.

Because the Wilson lower bound penalizes small sample sizes:
- A gate of **0.75** lower bound requires at least **15** flawless (15/15) auto-matches ($\text{Wilson}(15, 15) \approx 0.7961$).
- A 20-case tune matched split can achieve at most $\text{Wilson}(20, 20) \approx 0.8389$.
- A gate of **0.99** lower bound is statistically impossible on small datasets; it requires at least **381** flawless auto-matches ($\text{Wilson}(381, 381) \approx 0.9900$).

### Preflight feasibility check

To avoid running expensive remote embeddings and rerankings on gates that can never pass, Skillmux executes a **preflight feasibility calculation** immediately after loading the dataset and before creating a running calibration record:

$$\text{effective\_trials} = \max(N_{\text{tune\_matched}}, \text{minAutoMatchCount})$$
$$\text{max\_attainable\_precision} = \text{WilsonLowerBound}(N_{\text{tune\_matched}}, \text{effective\_trials})$$

If $\text{max\_attainable\_precision} < \text{minAutoMatchPrecision}$, calibration fails immediately with an actionable error indicating the requested precision, requested count, available tune matched cases, and maximum attainable lower bound.

## Reading a run

A `run_id` identifies one immutable calibration attempt and its evidence.
`calibrate show RUN_ID` is read-only. It reports:

- selected thresholds and tune/test metrics;
- auto-match precision confidence and sample counts;
- retrieval and delivered-shortlist recall;
- a closed failure reason when certification fails;
- reranker, embedding, corpus, and dataset fingerprints;
- dataset provenance and the number of human-labelled cases; and
- the attempt count for the dataset hash.

`calibrate apply RUN_ID` accepts only a completed, test-certified run. It
rechecks the reranker fingerprint, rejects thresholds masked by environment
variables, atomically updates the TOML file, and lets the config watcher
activate the new snapshot.

## Dataset responsibilities

Each case needs a query, expected outcome, relevant skill ids, and a fixed
`tune` or `test` split. Unknown skill ids are rejected. Keep a skill entirely
within one split so the test set measures generalization rather than memorized
skill wording.

Generated datasets are scaffolding, not ground truth. Review paraphrases,
near-miss negatives, and ambiguous cases before using them for certification.
Audit-derived cases require an explicit human label and provenance. Raw audit
queries are excluded unless the importer is deliberately configured to retain
them.

## When to recalibrate

Re-run calibration after a material change to the corpus, embedding or
retrieval behavior, reranker adapter or model, or after collecting enough new
human-labelled feedback. Do not recalibrate per user request. Every rerun gets
a new `run_id`; the active policy remains unchanged until one is applied.

## Local and remote targets

Here, `local` and `remote` name CLI administration targets, not inference
locations or MCP transports. Calibration is local-target-only in this release.
Local commands operate on the
configured local vault, index, inference endpoints, dataset path, evidence
database, and TOML file. Human output always prints `Target: local`; JSON output
uses `"target": "local"`.

Remote servers advertise `"calibration": false`. Every
`/admin/v1/calibrations` route returns HTTP `501` with
`error: "not_implemented"`, and the CLI rejects remote calibration before
uploading or claiming to execute a local dataset path. This also prevents raw
evaluation queries from being exposed through the admin API.

## Reference starting profile

Reranker scores are not portable across models, adapters, model revisions, or
corpora. The profile below is published only to make the checked-in BGE example
concrete; it is not a certified substitute for calibration.

| Model | Adapter | `match_score` | `match_margin` | `candidate_floor` |
|---|---|---:|---:|---:|
| `BAAI/bge-reranker-v2-m3` | `jina-v1` | `0.90` | `0.20` | `0.40` |

Provenance: the small synthetic corpus and labelled decision cases in
[`tests/router-core.spec.test.ts`](../tests/router-core.spec.test.ts), with the
wire contract captured by
[`tests/fixtures/reranker/jina-v1-request.json`](../tests/fixtures/reranker/jina-v1-request.json).
That fixture is below the default 15-auto-match certification minimum, so the
values are a smoke-test/reference profile, not a completed calibration run.
Run the lifecycle above against the deployment's real corpus before enabling
automatic matches in production.
