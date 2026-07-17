# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-17

### Added
- GitHub Actions CI for tests, type checking, binary builds, schema validation, and slim container builds.
- Tag-driven GitHub releases with consistently named Linux AMD64/ARM64 binaries, checksums, multi-architecture GHCR images, SBOMs, and build provenance.
- Weekly Dependabot updates for Bun/npm dependencies and GitHub Actions.
- Separate liveness and readiness endpoints, readiness metrics, startup initialization, and graceful shutdown.
- HTTP rate limiting (token-bucket, per-token/IP, `429` + `Retry-After`/`X-RateLimit-*` headers) and request metrics.
- Model configuration overrides (`EMBED_MODEL`, `EMBED_DIMENSION`, `RERANK_MODEL`), a dynamic model downloader, and `/health` + `/metrics` (Prometheus) HTTP endpoints.
- On-demand vault index sync so a running server folds vault changes into the index without a restart.
- Exact skill-match short-circuiting in the recall path.
- Docker packaging: `slim` (model-free) and `latest` (battery-included ONNX models) image variants.
- Streamable HTTP transport alongside the original stdio transport.
- HTTP auth and CORS controls; device/dtype configuration for local ONNX inference.

### Fixed
- Consolidated tag publishing into one GHCR release workflow, replacing the legacy Docker Hub-only workflow.
- Optional server config handling made safe for partially-specified `config.toml` files.
- ONNX device/dtype typing broadened to match `@huggingface/transformers`' accepted values.

## [0.1.0] - 2026-07-14

### Added
- Initial `router-core`: hybrid recall (SQLite FTS5/BM25 ∪ embedding cosine) with cross-encoder reranking, exposed via two MCP tools — `resolve_skill` and `fetch_skill`.
- Zero-loss delivery: `sha256(body)` verified against the file on disk at delivery time.
- Graceful fallback to lexical retrieval when embedding is unavailable.
- `skill-router eval` CLI command for recall@5 threshold calibration against a vault's holdout queries.
- Read-only vault guarantee and a SQLite-backed audit log of every `resolve_skill` call.

[Unreleased]: https://github.com/klhq/skill-router/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/klhq/skill-router/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/klhq/skill-router/releases/tag/v0.1.0
