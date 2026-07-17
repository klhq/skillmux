# Configuration

Skill Router defaults to FTS5 plus local GTE-small semantic retrieval. Most users need no config file.

## Local mode

```toml
[inference]
mode = "local"
```

The versioned `gte-small-v1` bundle uses normalized, mean-pooled `Xenova/gte-small` embeddings (384 dimensions), quantized to q8 on CPU. Models are cached in `~/.cache/skill-router/models`. FTS5 and cosine result lists are combined with reciprocal-rank fusion; without a reranker the calling LLM selects from the ordered shortlist.

Advanced local overrides:

```toml
[inference]
mode = "local"
models_dir = "~/.cache/skill-router/models"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 384
device = "cpu"
dtype = "q8"

```

Use `skill-router models download` to prefetch models and `skill-router doctor` to verify readiness.

## Remote mode

See [`config.remote.example.toml`](../config.remote.example.toml). Embeddings must implement the OpenAI-compatible `POST /v1/embeddings` API. Optional reranking must implement Infinity's `POST /rerank` API. Credentials are read from the environment variables named by `api_key_env`.

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
