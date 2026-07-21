# Configuration

Skillmux defaults to FTS5 plus local GTE-small semantic retrieval. Most users need no config file.

For detailed CLI command reference, target resolution, policy calibration, and automation envelopes, see [`docs/cli.md`](cli.md).

## Local mode

```toml
[inference]
mode = "local"
```

The versioned `gte-small-v1` bundle uses normalized, mean-pooled `Xenova/gte-small` embeddings (384 dimensions), quantized to q8 on CPU. Models are cached in `~/.cache/skillmux/models`. FTS5 and cosine result lists are combined with reciprocal-rank fusion; without a reranker the calling LLM selects from the ordered shortlist.

Advanced local overrides:

```toml
[inference]
mode = "local"
models_dir = "~/.cache/skillmux/models"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 384
device = "cpu"
dtype = "q8"

```

Use `skillmux models download` to prefetch models and `skillmux doctor` to verify readiness.

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
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []

[server.rate_limit]
enabled = false
requests_per_minute = 60
trust_proxy = false
```

Defaults are loopback-only (`hostname = "127.0.0.1"`) with CORS deny-by-default (`allowed_origins = []`) — a zero-config `skillmux serve --transport http` is not reachable from the network or from a browser tab on another origin. Docker sets `hostname` to `0.0.0.0` automatically (`RUNNING_IN_DOCKER=true`) since port-mapping needs the container to accept connections on all interfaces.

Before exposing HTTP beyond localhost, set `hostname` to a reachable interface, `auth_enabled = true` with a token, and populate `allowed_origins` with the specific origins that need browser access. `rate_limit.trust_proxy` should stay `false` unless a trusted reverse proxy sets `X-Forwarded-For` — it's otherwise a client-controlled, spoofable header and trusting it defeats per-client rate limiting.

## Tiers and the manifest

`skillmux init`/`sync` manage an optional second delivery path — pinning a subset of skills as real symlinks inside an agent's own skill directory, instead of routing every request through `resolve_skill`. See the README's [Tiers](../README.md#tiers-routed-vs-pinned) section for the concept and a walkthrough; this is the manifest reference.

### `skillmux.toml`

Lives at the vault root (a legacy `skr.toml` is still read if present, never written):

```toml
[core]
skills = ["csv-formatter"]           # pinned into every [targets.*] dir; capped at 25

[project.repo1]
repos = ["/Users/you/code/repo1"]    # only synced for repos paths that exist locally
skills = ["pdf-extractor"]           # must not overlap [core]

[targets.claude]
dir = "/Users/you/.claude/skills"
project = false                      # true = also apply [project.*] groups scoped to this target
```

- `[core].skills` — symlinked into every `[targets.*]` dir on `sync`. Capped at 25 skills; `sync` fails if a listed skill id isn't actually in the vault.
- `[project.<group>].skills` — symlinked only into `<repo>/<relative path from $HOME to the target dir>`, for each `repos` entry, and only for targets with `project = true`. `repos` entries must resolve under `$HOME` (that's how the pin path is derived). A skill can't appear in both `[core]` and the same `[project.*]` group.
- `[targets.<name>]` — one entry per adopted surface. `skillmux init --target <name> --yes` writes these; hand-editing is fine as long as `sync` is still allowed to own the directory (see below).

### Ownership marker

Every directory `sync` manages gets a `.skillmux` marker file (`{"managed_by": "skillmux", "target": "<name>", "created_at": ...}`). `sync` refuses to touch a directory that exists but has no marker — run `skillmux init --target <name> --yes` first, which either creates the directory fresh or adopts an existing one in place (contents untouched). This is also why `sync --restore-monolith` (which deletes the marker and replaces the whole directory with one symlink straight to the vault) requires re-running `init` before that target can be `sync`'d again.
