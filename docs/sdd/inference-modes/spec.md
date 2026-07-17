# Spec: Explicit inference modes

<!-- status: superseded by docs/sdd/gte-hybrid-routing/spec.md on 2026-07-17 -->

## Goal

Make Skill Router easy to install as OSS with a zero-config local ONNX mode and an explicit bring-your-own remote inference mode, while keeping advanced retrieval tuning out of the normal setup path.

## Acceptance Criteria

- [ ] IM-AC1: With no config file, `loadConfig()` selects `inference.mode = "local"` and a versioned BGE-M3 embedding plus BGE reranker ONNX bundle with internally consistent model IDs, dimension, dtype, cache path, and conservative thresholds.
- [ ] IM-AC2: `inference.mode = "remote"` requires valid `[inference.embedding]` and `[inference.reranker]` sections and rejects legacy top-level `[embedding]`, `[rerank]`, and `remote_timeout_ms` settings with an actionable migration error.
- [ ] IM-AC3: Remote embeddings use the OpenAI-compatible `POST /v1/embeddings` protocol and remote reranking uses the Infinity `POST /rerank` protocol; each client supports an optional `api_key_env` bearer credential without exposing its value.
- [ ] IM-AC4: Docker only changes filesystem defaults (`vault_path = "/vault"`, `state_dir = "/data"`); `RUNNING_IN_DOCKER` never selects the inference mode. The `full` image contains the default local model bundle and the `slim` image can use explicit local or remote configuration.
- [ ] IM-AC5: Stored vectors are keyed by an embedding fingerprint that includes inference implementation, model, and dimension, so changing any of those values safely triggers re-embedding even when the dimensions match.
- [ ] IM-AC6: `skill-router doctor` checks vault readability, state/cache writability, embedding output dimensions, and reranker response shape, then reports whether full hybrid routing or degraded lexical routing is available without printing secret values.
- [ ] IM-AC7: `skill-router config show` prints the effective configuration with paths expanded and credential environment-variable names retained, but never prints credential values.
- [ ] IM-AC8: `skill-router models download` downloads the configured local model bundle into `inference.local.models_dir` and fails with actionable guidance when used in remote mode.
- [ ] IM-AC9: The quick-start example contains only ordinary local-mode settings; a separate remote example contains BYO endpoint settings; advanced recall, thresholds, device, dtype, timeout, and HTTP settings remain documented but optional.
- [ ] IM-AC10: TypeScript types, JSON Schema, README, Docker targets, CLI usage, and automated tests describe the same local/remote configuration contract.

## Scope

- A discriminated `inference.mode` configuration with `local` and `remote` branches.
- A versioned default local model bundle using BGE-M3 embedding and BGE reranking ONNX models.
- OpenAI-compatible remote embeddings and Infinity-compatible remote reranking.
- Separate model cache and router state directories.
- Embedding fingerprint persistence and safe vector invalidation.
- `doctor`, `config show`, and `models download` CLI commands.
- Full and slim Docker targets with mode-independent runtime behavior.
- Minimal local and remote configuration examples plus advanced configuration documentation.

## Out of Scope

- Compatibility support for the unreleased legacy top-level `[embedding]` and `[rerank]` config shape beyond an actionable migration error.
- Arbitrary embedding or reranking provider protocols beyond OpenAI-compatible embeddings and Infinity-native reranking.
- Automatic embedding-dimension discovery for remote providers; remote mode requires `dimension`.
- Automatically writing calibrated thresholds to config.
- Interactive `skill-router init` onboarding.
- GPU-specific Docker images or platform-specific accelerator packaging.
- Shipping or operating hosted inference endpoints.

## Tasks

1. Add local/remote config types, defaults, validation, migration errors, and schema coverage. (IM-AC1, IM-AC2, IM-AC10)
2. Implement mode-specific clients and remote credentials. (IM-AC3)
3. Persist embedding fingerprints and re-embed stale vectors. (IM-AC5)
4. Add `doctor`, `config show`, and `models download`. (IM-AC6, IM-AC7, IM-AC8)
5. Align Docker targets and model prefetch behavior. (IM-AC4)
6. Replace the configuration examples and document the two user paths. (IM-AC9, IM-AC10)
7. Run the full tests and build; verify local and remote paths. (IM-AC10)

<!-- vikunja_project_id: 14 -->
<!-- vikunja_label: sdd:inference-modes -->
