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
query. It caches those observations, searches thresholds on the `tune` split,
then certifies the selected policy on the frozen `test` split. Calibration
starts only when an operator invokes `calibrate run`.

The operator owns the labels: supply or review the cases, start the run,
inspect its evidence, and explicitly apply an acceptable result. A successful
run never changes live thresholds by itself.

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

Calibration is local-only in this release. Local commands operate on the
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
That fixture is below the default 30-auto-match certification minimum, so the
values are a smoke-test/reference profile, not a completed calibration run.
Run the lifecycle above against the deployment's real corpus before enabling
automatic matches in production.
