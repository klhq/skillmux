# Spec: Skill Router — OSS & Docker (oss-docker)

<!-- inference and response contract superseded by docs/sdd/gte-hybrid-routing/spec.md on 2026-07-17 -->

<!-- status: approved 2026-07-15 -->

## Goal
Package the skill-router MCP server as a standalone, battery-included Docker container with in-process ONNX inference and Streamable HTTP transport, alongside a slim model-free version for OSS distribution.

## Acceptance Criteria

- [ ] **AC1 — Local ONNX Inference (`local://` sentinel)**: When `embedding.base_url` is `"local://"` or `rerank.base_url` is `"local://"`, the router bypasses remote HTTP client calls. Instead, it loads the model in-process using `@huggingface/transformers` (`BAAI/bge-m3` for embeddings and `BAAI/bge-reranker-v2-m3` for reranking) to execute the `embed()` and `rerank()` methods.
- [ ] **AC2 — Model Downloader**: A script/command `bun run scripts/download-models.ts` downloads the required models (`BAAI/bge-m3` and `BAAI/bge-reranker-v2-m3` in quantized INT8/q8 ONNX format) and places them in a local `.models` cache directory.
- [ ] **AC3 — Streamable HTTP Transport**: The MCP server supports a `--transport http` CLI argument (with optional `--port <number>` or env var `PORT`, defaulting to `3000`). When active, it serves the MCP protocol using the official Streamable HTTP transport standard (single endpoint handling JSON-RPC over HTTP POST).
- [ ] **AC4 — Docker Configuration & Env Overrides**: The configuration loader allows overriding core settings via environment variables:
  - `VAULT_PATH` overrides `vault_path`
  - `STATE_DIR` overrides `state_dir`
  - `EMBED_BASE_URL` overrides `embedding.base_url`
  - `RERANK_BASE_URL` overrides `rerank.base_url`
  If `RUNNING_IN_DOCKER=true` is set, the default values become: `vault_path = "/vault"`, `state_dir = "/data"`, `embedding.base_url = "local://"`, and `rerank.base_url = "local://"`.
- [ ] **AC5 — Docker Image Variants**: The Docker build produces two distinct targets:
  - `klhq/skill-router:slim` (~150MB): Excludes model weights. Resolves locally using lexical-only FTS5 unless external model endpoints are configured.
  - `klhq/skill-router:latest` (or `:full`, ~1.2GB): Pre-packages the downloaded models in the `.models` directory for immediate out-of-the-box hybrid recall.
- [ ] **AC6 — Read-Only Guarantee**: In all transport modes and image variants, the skill vault directory (`vault_path` or `/vault`) remains entirely read-only.
- [ ] **AC7 — Degraded Lane in Slim Image**: If the slim image runs without any external endpoints configured, resolving a skill gracefully falls back to FTS5-only recall and returns `outcome` ∈ {`ambiguous`, `no_match`} with `degraded = true` and `rerank_score = null` for all candidates, without crashing.
- [ ] **AC8 — OSS Distribution Setup**: `package.json` contains proper `"bin"` and `"exports"` declarations for global execution via npm/bun. A `CONTRIBUTING.md` is present detailing development guidelines, tests, and contribution workflows.

## Scope

- In-process ONNX inference implementation utilizing `@huggingface/transformers` (embeddings + cross-encoder reranking).
- Streamable HTTP transport implementation in `src/server.ts` using `@modelcontextprotocol/sdk`.
- CLI arg parsing in `src/cli.ts` supporting `serve --transport <stdio|http> --port <N>`.
- Multi-stage Dockerfile containing `slim` and `full` runtime configurations.
- Model pre-downloading script (`scripts/download-models.ts`).
- Environment variable config overrides (`VAULT_PATH`, `STATE_DIR`, `EMBED_BASE_URL`, `RERANK_BASE_URL`).
- Platform support: `linux/amd64` only.
- Documentation updates: Docker guide in `README.md`, new `CONTRIBUTING.md`.

## Out of Scope

- Authentication mechanisms on the HTTP transport (tokens, OAuth, mTLS).
- Multi-architecture Docker builds (`linux/arm64` / Apple Silicon).
- Deployment orchestration configurations (Kubernetes manifests, Helm charts, Docker Compose files).
- Modifying the existing MCP tools schema or CLI tool contracts.
- Embedding model fine-tuning or custom/user-supplied model file paths.

## Tasks

1. **Task 1: Local ONNX Inference & Model Downloader**
   - Add `@huggingface/transformers` dependency.
   - Implement `LocalOnnxClients` matching the `Clients` interface (with BGE-M3 and BGE-Reranker-v2-m3).
   - Write `scripts/download-models.ts` script.
   - Add `local://` sentinel configuration routing in `src/router-core.ts`.
   - Implement unit and integration tests for local ONNX inference.
   
2. **Task 2: Streamable HTTP Transport & Env Configuration**
   - Add `--transport <stdio|http>` and `--port <number>` parsing to `src/cli.ts`.
   - Set up MCP Streamable HTTP server in `src/server.ts`.
   - Update config loader to accept `VAULT_PATH`, `STATE_DIR`, `EMBED_BASE_URL`, and `RERANK_BASE_URL` env overrides.
   - Implement tests for Streamable HTTP transport client-server requests.

3. **Task 3: Docker Images & OSS Infrastructure**
   - Build multi-stage `Dockerfile`.
   - Write `CONTRIBUTING.md` and add Docker configuration/deployment details to `README.md`.
   - Expose `"bin"` entrypoint in `package.json`.
   - Configure a GitHub Actions build and push smoke-test workflow.

<!-- vikunja_project_id: 14 -->
<!-- vikunja_label: sdd:oss-docker -->
<!-- vikunja_task_ids: 326-333 (AC1-AC8) -->
