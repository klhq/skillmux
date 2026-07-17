# Spec: GTE hybrid routing

<!-- status: approved 2026-07-17 -->

## Goal

Provide useful zero-config local skill routing with FTS5 plus a small GTE embedding model, while automatically enabling confident matching when users connect a compatible reranker.

## Acceptance Criteria

- [ ] GHR-AC1: With no inference configuration, Skill Router uses the versioned `gte-small-v1` bundle (`Xenova/gte-small`, q8, mean pooling, normalized 384-dimensional vectors) and does not load a local reranker.
- [ ] GHR-AC2: Local retrieval unions FTS5/BM25 top `recall.k_lexical` and cosine top `recall.k_vector`, ranks the union with deterministic reciprocal-rank fusion, and returns at most `thresholds.candidate_limit` candidates.
- [ ] GHR-AC3: Without a reranker, `resolve_skill` returns `retrieval = "hybrid"` and never returns `outcome = "matched"`; if local embeddings fail, it returns `retrieval = "lexical"` and an FTS5-ordered shortlist.
- [ ] GHR-AC4: Users may configure an OpenAI-compatible remote embedding endpoint without a reranker; users may additionally configure an Infinity-compatible reranker, but a reranker without a remote embedding endpoint is rejected.
- [ ] GHR-AC5: When a configured reranker succeeds, the existing threshold policy may produce `matched`, `ambiguous`, or `no_match` with `retrieval = "reranked"`; reranker failure falls back to the hybrid shortlist rather than lexical-only retrieval.
- [ ] GHR-AC6: Public candidates contain only `skill_id`, `title`, and `description`; `ResolveResult` exposes `retrieval = "reranked" | "hybrid" | "lexical"` instead of `degraded`, while audit persistence retains internal scores and retrieval capability.
- [ ] GHR-AC7: `skill-router models download` fetches only the local GTE bundle, and `skill-router doctor` separately reports lexical, embedding, and optional reranker readiness without requiring a reranker.
- [ ] GHR-AC8: The quick start requires no inference settings; advanced top-k and candidate-limit settings remain configurable, while RRF constants and local model internals remain product defaults.
- [ ] GHR-AC9: A checked-in labeled evaluation fixture measures FTS5 recall@3/5 and GTE-hybrid recall@3/5 plus MRR using positive and ambiguous routing queries; default evaluation never calls remote inference or another machine.
- [ ] GHR-AC10: On `workhorse`, the local GTE artifact remains below 200 MB, warm embedding remains below 100 ms, and process RSS increase remains below 500 MB; automated tests, TypeScript, and binary build pass.

## Scope

- Replace the heavy local BGE-M3 plus BGE reranker bundle with GTE-small embeddings only.
- Add deterministic reciprocal-rank fusion for lexical and semantic retrieval.
- Make remote reranking optional and capability-driven.
- Clean the public resolve response of implementation-specific scores and `degraded` state.
- Update model download, doctor, evaluation, configuration schema, Docker, and documentation.
- Validate local model behavior only on the current `workhorse` host.

## Out of Scope

- Automatic `matched` decisions from cosine or RRF scores.
- Multiple user-visible product editions or inference mode names.
- Multiple vault roots, skill installation, or skill synchronization.
- Multilingual optimization beyond GTE-small's existing behavior.
- Postgres or a hosted control plane.
- Automatic threshold calibration for user-supplied rerankers.
- Running default-model benchmarks on remote machines or remote inference endpoints.

## Tasks

1. Replace the configuration and MCP response contracts. (GHR-AC1, GHR-AC4, GHR-AC6, GHR-AC8)
2. Implement GTE-small embeddings and deterministic RRF shortlist ranking. (GHR-AC1, GHR-AC2, GHR-AC3)
3. Make remote reranking optional with hybrid fallback. (GHR-AC4, GHR-AC5)
4. Align model operations, Docker, and product documentation. (GHR-AC7, GHR-AC8)
5. Add labeled local evaluation and run local performance verification. (GHR-AC9, GHR-AC10)

<!-- vikunja_project_id: 14 -->
<!-- vikunja_label: sdd:gte-hybrid-routing -->
