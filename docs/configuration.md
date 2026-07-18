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

Use `skr models download` to prefetch models and `skr doctor` to verify readiness.

## Remote mode

See [`config.remote.example.toml`](../config.remote.example.toml). Embeddings must implement the OpenAI-compatible `POST /v1/embeddings` API. Optional reranking must implement Infinity's `POST /rerank` API. Credentials are read from the environment variables named by `api_key_env`.

Remote embedding `dimension` is required. Changing the provider, model, or dimension invalidates stored vectors and safely rebuilds them.

## Advanced retrieval

Candidate-generation depth is configurable but normally does not need tuning:

```toml
[recall]
k_lexical = 20
k_vector = 20

[thresholds]
candidate_limit = 5
```

The router considers up to 20 candidates from each retrieval lane but returns at most 5 to the calling LLM.

Reranker thresholds have no universal default because score distributions are model-specific. When configuring a reranker, provide calibrated `inference.thresholds.match_score`, `inference.thresholds.match_margin`, and `inference.thresholds.candidate_floor`; otherwise configuration is rejected rather than silently applying unsuitable values.

## HTTP server

```toml
[server]
hostname = "127.0.0.1"
auth_enabled = false
auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"
allowed_origins = []

[server.rate_limit]
enabled = false
requests_per_minute = 60
trust_proxy = false
```

Defaults are loopback-only (`hostname = "127.0.0.1"`) with CORS deny-by-default (`allowed_origins = []`) — a zero-config `skr serve --transport http` is not reachable from the network or from a browser tab on another origin. Docker sets `hostname` to `0.0.0.0` automatically (`RUNNING_IN_DOCKER=true`) since port-mapping needs the container to accept connections on all interfaces.

Before exposing HTTP beyond localhost, set `hostname` to a reachable interface, `auth_enabled = true` with a token, and populate `allowed_origins` with the specific origins that need browser access. `rate_limit.trust_proxy` should stay `false` unless a trusted reverse proxy sets `X-Forwarded-For` — it's otherwise a client-controlled, spoofable header and trusting it defeats per-client rate limiting.
