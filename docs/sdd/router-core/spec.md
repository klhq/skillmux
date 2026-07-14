# Spec: Skill Router — core (router-core)

<!-- status: approved 2026-07-14 -->

## Goal

Give agents without native skill triggering (Goose sub-recipe workers, opencode, agy, Hermes) on-demand discovery of the right skill in `~/.agents/skills` and zero-loss delivery of its `SKILL.md`, via one local read-only MCP server.

## Background (decisions inherited from design discussion, 2026-07-14)

- The vault is the chezmoi-managed `~/.agents/skills/` — **116 skills**, each a directory containing `SKILL.md` (agentskills.io standard) plus optional supporting files (`references/`, `scripts/`).
- Retrieval is hybrid: SQLite FTS5 (BM25) ∪ Harrier embedding cosine, reranked by a cross-encoder. Both models already run on workhorse: `microsoft/harrier-oss-v1-0.6b` (embeddings, 1024-dim) and `BAAI/bge-reranker-v2-m3` (reranker).
- The final semantic pick on ambiguous results is made by the **calling LLM**, not the router. The reranker exists to make the matched/ambiguous/no_match confidence decision, not to replace the caller's judgment.
- Explicitly rejected from the source research doc ("Zero-Loss Native Markdown Skill Router", Perplexity): receipts/Ed25519 signing, enforcement tiers, prompt sentinel, PreToolUse blocking gates, HNSW index generations / CoW snapshots, per-type rolling score normalization. The router advises; it never blocks.
- Claude Code keeps its native skill triggering. The router serves the other agents.

## Acceptance Criteria

- [ ] AC1 — `resolve_skill(query: string)` returns structured content with `outcome` ∈ {`matched`, `ambiguous`, `no_match`} and a boolean `degraded` flag. No other outcome values exist.
- [ ] AC2 — On `matched`, the response contains `skill_id`, `content_sha256`, `score`, `margin`, and the full `SKILL.md` body **byte-identical to the file on disk at delivery time** (sha256 of delivered bytes == `content_sha256` == hash of the file read at delivery). If the on-disk file differs from the index, the router re-indexes and delivers the fresh content — it never delivers stale bytes.
- [ ] AC3 — On `ambiguous`, the response contains `candidates`: ≤ 5 entries, each with `skill_id`, `title`, `description`, and `rerank_score` (null in degraded mode). No skill body is included.
- [ ] AC4 — On `no_match`, the response contains no body and no candidates, and states the caller should proceed under its normal workflow.
- [ ] AC5 — `fetch_skill(skill_id: string)` returns the verbatim `SKILL.md` body, `content_sha256`, and `files` (relative paths of the skill's supporting files, not their contents) for any indexed skill, independent of any prior `resolve_skill` outcome. Unknown `skill_id` → MCP tool error.
- [ ] AC6 — Decision logic (unit-testable with mocked model endpoints): candidates = FTS5 top-`k_lexical` ∪ cosine top-`k_vector` (dedup); reranker scores (query, title+description+aliases) pairs; outcome is `matched` iff top `rerank_score` ≥ `match_score` AND (top − second) ≥ `match_margin`; else `ambiguous` if ≥ 1 candidate ≥ `candidate_floor`; else `no_match`. All five parameters (`k_lexical`, `k_vector`, `match_score`, `match_margin`, `candidate_floor`) are read from `config.toml`, never hardcoded.
- [ ] AC7 — Degraded lane: if the embedding or rerank endpoint is unreachable or exceeds `remote_timeout_ms`, `resolve_skill` still answers using FTS5-only recall, never returns `matched`, and sets `degraded: true`. Router startup and `resolve_skill` must both succeed with workhorse fully offline.
- [ ] AC8 — Indexing: `skill-router index` rebuilds the lexical index for the full 116-skill vault from scratch in < 5 s (embedding backfill may complete asynchronously). A running server reflects a vault file change (create/modify/delete) in the index within 5 s of the write stabilizing. A `SKILL.md` with invalid UTF-8 or unparseable frontmatter keeps its previous indexed version and logs a warning.
- [ ] AC9 — Read-only guarantee: no code path writes under `~/.agents/skills`; all router writes are confined to its state directory. (Test: full index + resolve + fetch suite leaves vault mtimes/hashes unchanged.)
- [ ] AC10 — Audit log: every `resolve_skill` call appends a row (timestamp, raw query, outcome, degraded flag, candidate `skill_id`s with scores, selected `skill_id` if matched, `latency_ms`) to a SQLite table in the state directory. Raw queries are stored deliberately (single-user private homelab).
- [ ] AC11 — Eval harness: `skill-router eval` holds out trigger phrases parsed from skill descriptions, reports recall@5 for lexical-only vs hybrid recall, and prints suggested `match_score` / `match_margin` / `candidate_floor` values derived from the observed reranker score distribution.

## Scope

- MCP **stdio** server (official TypeScript SDK, running on Bun) exposing exactly two tools: `resolve_skill`, `fetch_skill`.
- Ingest: frontmatter parse (`name`, `description`, optional `aliases`) → SQLite + FTS5; embedding vectors in a single flat matrix (brute-force cosine — no ANN index); `skill-router index` CLI.
- File watcher with debounce + stable-stat check; invalid-file retention.
- Workhorse clients for Harrier embeddings and bge-reranker, with timeout → degraded fallback.
- Decision logic + `config.toml`; state directory `~/.local/state/skill-router/` (index SQLite incl. audit log, vector matrix).
- Eval harness + threshold calibration.
- Deployment: registration as a Bifrost MCP client (so per-VK grants apply), update to `docs/bifrost-vk-registry.md` in the chezmoi repo, example Goose recipe extension block and agent config snippets.
- TypeScript on **Bun** (decision 2026-07-14, superseding the initial Python/FastMCP choice): `bun:sqlite` for FTS5 + audit log (verified working with bm25() and unicode61 on bun 1.3.14 / SQLite 3.51.0), `@modelcontextprotocol/sdk` for the stdio server, cosine over a flat `Float32Array`. Rationale: bun is already on every machine, faster cold start matters for per-spawn stdio servers (Goose sub-recipes), and `bun build --compile` gives a single-file binary for the deployment target. `schema.json` is language-neutral and unchanged.

## Out of Scope

- Receipts, signing, enforcement tiers, sentinel classification, PreToolUse/blocking hooks of any kind.
- HNSW / index generations / CoW snapshot machinery (index is disposable and rebuilt in seconds).
- The `UserPromptSubmit` advisory hook (Phase 2 — separate spec once the router is proven).
- Any change to Claude Code's native skill triggering or its skills listing.
- The Bifrost VK split (`vk-mcp-goose` etc.) — related but separate work with its own spec.
- Serving the embedding/reranker models (already running on workhorse).
- Delivering supporting files' *contents* inline (AC5 lists their paths only; callers with filesystem access read them directly).
- Skill authoring, mutation, or promotion workflows; Hermes's private `~/.hermes/skills`.
- Multi-user auth (Bifrost VK layer owns access control).
- Moving the vault out of chezmoi management. Noted as a **future possibility** once the router owns discovery (the vault location becomes an implementation detail behind the MCP contract), but distribution/versioning across machines still needs an answer before leaving chezmoi — separate decision, separate spec.

## Resolved (2026-07-14)

- Both models are served by **Infinity** on workhorse. Embeddings are called **through Bifrost** authenticated with `vk-embed` (OpenAI-compatible `/v1/embeddings`). The reranker is called **directly at the workhorse Infinity endpoint** (Bifrost does not support rerank passthrough) — Infinity's native `/rerank` API.

## TBD — resolved in `schema.json` (2026-07-14)
- Exact structured-content JSON schema for both tools (field types, error codes) → `docs/sdd/router-core/schema.json`.
- Default `remote_timeout_ms` → **2000** (`Config.remote_timeout_ms`).

## Tasks

1. Scaffold (Bun, TypeScript, `@modelcontextprotocol/sdk`) + ingest pipeline: vault scan → frontmatter parse → `bun:sqlite`/FTS5 + `skill-router index` CLI. (AC8 rebuild, AC9)
2. `fetch_skill` end-to-end over stdio MCP: zero-loss body, sha256 verification, `files` listing. (AC5, AC2's delivery mechanics)
3. `resolve_skill` lexical-only: FTS5 recall + three-outcome decision + `degraded` flag — this *is* the degraded lane, built first as the floor. (AC1, AC3, AC4, AC7)
4. Workhorse embed + rerank clients with timeout fallback; hybrid union + config-driven threshold decision. (AC6, AC2 full path)
5. File watcher: debounce, stable-stat, invalid-file retention. (AC8 live-update)
6. Audit log. (AC10)
7. Eval harness; run calibration against the real vault; commit chosen thresholds to `config.toml`. (AC11)
8. Deployment slice: Bifrost MCP client registration + registry doc update + Goose/agent config examples; verify end-to-end from a Goose recipe. (deployment scope)

<!-- vikunja_project_id: 14 -->
<!-- vikunja_label: sdd:router-core -->
<!-- vikunja_task_ids: 315-325 (AC1-AC11) -->
