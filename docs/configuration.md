# Configuration

Skill Router defaults to local ONNX inference. Most users need no config file.

## Local mode

```toml
[inference]
mode = "local"
```

The versioned `bge-m3-v1` bundle uses `Xenova/bge-m3` embeddings (1024 dimensions) and `onnx-community/bge-reranker-v2-m3-ONNX`, both quantized to q8 on CPU. Models are cached in `~/.cache/skill-router/models`.

Advanced local overrides:

```toml
[inference]
mode = "local"
models_dir = "~/.cache/skill-router/models"

[inference.embedding]
model = "Xenova/bge-m3"
dimension = 1024
device = "cpu"
dtype = "q8"

[inference.reranker]
model = "onnx-community/bge-reranker-v2-m3-ONNX"
device = "cpu"
dtype = "q8"
```

Use `skill-router models download` to prefetch models and `skill-router doctor` to verify readiness.

## Remote mode

See [`config.remote.example.toml`](../config.remote.example.toml). Embeddings must implement the OpenAI-compatible `POST /v1/embeddings` API. Reranking must implement Infinity's `POST /rerank` API. Credentials are optional and read from the environment variables named by `api_key_env`.

Remote embedding `dimension` is required. Changing the provider, model, or dimension invalidates stored vectors and safely rebuilds them.

## Advanced retrieval

These defaults are conservative and optional:

```toml
[recall]
k_lexical = 15
k_vector = 15

[thresholds]
match_score = 0.90
match_margin = 0.30
candidate_floor = 0.50
candidate_limit = 5
```

Thresholds are model- and vault-specific. Prefer ambiguous results over lowering them without representative evaluation data.

## HTTP server

```toml
[server]
auth_enabled = false
auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"
allowed_origins = ["*"]

[server.rate_limit]
enabled = false
requests_per_minute = 60
```

Only enable HTTP on a shared interface with authentication and an appropriate origin allowlist.
