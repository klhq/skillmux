# skill-router

A local, read-only [MCP](https://modelcontextprotocol.io) stdio server that gives agents **on-demand skill discovery**: route a natural-language task description to the right skill in your vault and deliver its `SKILL.md` byte-for-byte, verified by SHA-256.

Built for agents that lack native skill triggering (Goose recipe workers, opencode, and friends). Agents that already trigger skills natively (e.g. Claude Code) don't need it.

## How it works

```
resolve_skill("convert this spreadsheet to markdown")
        │
        ▼
  hybrid recall: SQLite FTS5 (BM25)  ∪  embedding cosine (brute-force)
        │
        ▼
  reciprocal-rank fusion → shortlist
  optional reranker      → matched | ambiguous | no_match
```

- **matched** — one skill clearly wins: full `SKILL.md` delivered inline, `sha256(body) == content_sha256 ==` hash of the file on disk at delivery time. Stale index? It re-indexes and delivers fresh bytes — never stale ones.
- **ambiguous** — up to 10 candidates (id, title, description). The calling LLM picks and calls `fetch_skill`.
- **no_match** — proceed under your normal workflow; don't load an unrelated skill.

If embeddings are unavailable, the router remains ready with FTS5 lexical retrieval. If an optional reranker is unavailable, it preserves the hybrid shortlist instead of failing.

### Tools

| Tool | Input | Returns |
|------|-------|---------|
| `resolve_skill` | `query` | outcome + metadata in `structuredContent`; on match the verbatim body as text content (exactly once on the wire) |
| `fetch_skill` | `skill_id` | verbatim body, `content_sha256`, supporting-file paths |

The full contract lives in [`docs/schema.json`](docs/schema.json) (JSON Schema 2020-12, language-neutral).

## Install

### Linux Binary

Download the latest release for your architecture:

```sh
# AMD64
gh release download --repo klhq/skill-router \
  --pattern 'skill-router-linux-*' \
  --pattern 'SHA256SUMS'

sha256sum --check SHA256SUMS
# Install the binary matching your machine (amd64 or arm64)
chmod +x skill-router-linux-amd64
sudo install skill-router-linux-amd64 /usr/local/bin/skr
skr config show
```

Release assets are also available at <https://github.com/klhq/skill-router/releases/latest>.

Requirements at runtime:

- A skill vault: one directory per skill with a `SKILL.md` in [agentskills.io](https://agentskills.io) format. Default: `~/skills`.
- Optional remote OpenAI-compatible embeddings and Infinity-native reranking. The full binary uses local GTE-small embeddings by default.

## Quick start

No config is required when the vault is at `~/skills`:

```sh
skr index
skr serve
```

Register with your MCP client directly, e.g.:

```json
{
  "mcpServers": {
    "skill-router": {
      "command": "skr",
      "args": ["serve"]
    }
  }
}
```

To run from source instead:

```sh
bun install --frozen-lockfile
bun run src/cli.ts serve
```

## Docker Usage

The `skill-router` is packaged and distributed as a Docker image in two variants:

1. **`ghcr.io/klhq/skill-router:latest`**: Bundles the small quantized GTE embedding model for local hybrid retrieval.
2. **`ghcr.io/klhq/skill-router:latest-slim`**: Excludes model weights and supports configured remote embeddings or lexical fallback.

Both tags are multi-architecture manifests for Linux AMD64 and ARM64; Docker selects the correct image automatically.

### Running HTTP Server (Docker Default)

To run as an HTTP MCP service (default in Docker):

```sh
# Battery-included (runs local in-process ONNX models)
docker run -d \
  --name skill-router \
  -v ~/skills:/vault:ro \
  -v skill-router-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skill-router:latest

# Slim (configured remote embeddings, or lexical fallback)
docker run -d \
  --name skill-router-slim \
  -v ~/skills:/vault:ro \
  -v skill-router-data:/data \
  -p 3000:3000 \
  -e EMBED_BASE_URL="http://embeddings-host:8080" \
  ghcr.io/klhq/skill-router:latest-slim
```

Connect your MCP client to the HTTP endpoint (e.g. standard Streamable HTTP transport):
- POST messages to `http://localhost:3000/mcp`

#### HTTP server: auth, CORS, rate limiting

All of the below is `[server]` config in `config.toml`, overridable by environment variable — see [Environment Variable Overrides](#environment-variable-overrides).

- **Bind address** (`hostname`, default `127.0.0.1`) — HTTP transport binds loopback-only by default, so a zero-config `skr serve --transport http` isn't reachable from the network. Inside Docker (`RUNNING_IN_DOCKER=true`) this defaults to `0.0.0.0` instead, since the container's own loopback isn't reachable through port-mapping. Set `hostname` (or `HTTP_HOSTNAME`) explicitly to expose the server beyond localhost.
- **Bearer token auth** (off by default) — set `auth_enabled = true` and the token via the env var named by `auth_token_env` (default `SKILL_ROUTER_AUTH_TOKEN`). Requests need `Authorization: Bearer <token>`; missing/mismatched tokens get `401`, and a configured-but-empty token env var gets `500`.
- **CORS** — `allowed_origins` (default `[]`, deny-by-default) is checked against the request's `Origin` header; disallowed origins get `403`. Requests with no `Origin` header (curl, MCP clients, server-to-server) are unaffected either way — only browser-issued cross-origin requests are gated. `/health` and `/metrics` are excluded from auth but still CORS-checked.
- **Rate limiting** (off by default) — per-token (when auth is enabled) or per-IP (`server.requestIP`) token-bucket limiting. Enable with `rate_limit.enabled = true` and set `rate_limit.requests_per_minute` (default `60`). The `X-Forwarded-For` header is ignored unless `rate_limit.trust_proxy = true` — it's client-supplied and spoofable, so only opt in when a trusted reverse proxy sets it. Every response carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`; over-limit requests get `429` plus `Retry-After`.
- **`GET /health/live`** — lightweight liveness check. Legacy `GET /health` remains an alias.
- **`GET /health/ready`** — readiness with active retrieval capability, skill count, index state, and inference status.
- **`GET /metrics`** — Prometheus text exposition: `skill_router_requests_total`, `skill_router_resolve_outcomes_total`, `skill_router_resolve_latency_seconds` (histogram), `skill_router_errors_total`, `skill_router_rate_limits_exceeded_total`.

### Running Stdio Server in Docker

If your agent runs locally and expects a piped stdio process:

```sh
docker run -i --rm \
  -v ~/skills:/vault:ro \
  ghcr.io/klhq/skill-router:latest serve --transport stdio
```

## Configuration

No config is required for the battery-included local ONNX mode. See [`config.example.toml`](config.example.toml) for the minimal local setup, [`config.remote.example.toml`](config.remote.example.toml) for bring-your-own endpoints, and [`docs/configuration.md`](docs/configuration.md) for advanced settings.

### Inference Modes

- The zero-config default combines SQLite FTS5 with the small `Xenova/gte-small` embedding model and returns an ordered shortlist.
- Configured OpenAI-compatible embeddings replace the local embedder. An optional Infinity-compatible reranker enables confident automatic matches.

Run `skr doctor` to verify routing capability. Run `skr config show` to inspect effective configuration; it prints credential variable names, never values.

### Security scanning

`skr scan [<path>]` inspects skill content for prompt-injection and data-exfiltration risk indicators
before it's served over MCP or HTTP. It's offline (no network call, no inference config needed),
read-only, and advisory-only — it never blocks `skr index`/`sync`/`init`, which don't call it
automatically.

```sh
skr scan                          # scan the configured vault_path
skr scan ~/skills/some-skill      # scan a single candidate skill dir before adding it
skr scan --format json            # machine-readable { scanned, findings } for CI
skr scan --fail-on high           # exit 1 if any finding is high severity (for CI gating)
```

The v1 rule set covers four categories, each attached to the finding as `rule_id` with a fixed
`severity`:

| `rule_id` | `severity` | Flags |
|---|---|---|
| `prompt-injection-phrase` | `high` | Known instruction-override phrases (e.g. "ignore previous instructions") |
| `invisible-unicode` | `high` | Zero-width/invisible Unicode code points, including hidden tag-character payloads |
| `secret-pattern` | `high` | Hardcoded-credential-shaped strings (AWS-style keys, PEM blocks, `api_key=`/`token=` assignments) |
| `suspicious-url` | `medium` | Bare-IP-address URLs, or URLs paired with exfiltration-suggesting text |

`skr scan` is unrelated to the `audit` SQLite table / `skr report` — that's query telemetry (what got
routed where); `skr scan` is content security (what's in the vault).

### Environment Variable Overrides
All core settings can be overridden via environment variables (handy for Docker):
- `VAULT_PATH` / `SKILL_ROUTER_VAULT_PATH` — overrides `vault_path` (defaults to `/vault` inside Docker)
- `STATE_DIR` / `SKILL_ROUTER_STATE_DIR` — overrides `state_dir` (defaults to `/data` inside Docker)
- `EMBED_BASE_URL` / `SKILL_ROUTER_EMBED_BASE_URL` — overrides remote `inference.embedding.base_url`
- `EMBED_MODEL` / `SKILL_ROUTER_EMBED_MODEL` — overrides `embedding.model`
- `EMBED_DIMENSION` / `SKILL_ROUTER_EMBED_DIMENSION` — overrides `embedding.dimension`
- `EMBED_DEVICE` / `EMBED_DTYPE` — overrides local `inference.embedding.device` / `inference.embedding.dtype`
- `RERANK_BASE_URL` / `SKILL_ROUTER_RERANK_BASE_URL` — overrides remote `inference.reranker.base_url`
- `RERANK_MODEL` / `SKILL_ROUTER_RERANK_MODEL` — overrides `rerank.model`
- `SKILL_ROUTER_CONFIG` — path to custom `config.toml` (default `~/.config/skill-router/config.toml`)
- `SKILL_ROUTER_MODELS_DIR` — path to directory storing downloaded local models (default `./.models`)
- `PORT` — HTTP listen port (default `3000`, HTTP transport only)
- `HTTP_HOSTNAME` — overrides `server.hostname` (default `127.0.0.1`, `0.0.0.0` inside Docker)
- `HTTP_AUTH_ENABLED` — overrides `server.auth_enabled` (`"true"` to enable)
- `HTTP_AUTH_TOKEN_ENV` — overrides `server.auth_token_env`
- `HTTP_ALLOWED_ORIGINS` — comma-separated list, overrides `server.allowed_origins`
- `HTTP_RATE_LIMIT_ENABLED` / `SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED` — overrides `server.rate_limit.enabled` (`"true"` to enable)
- `HTTP_RATE_LIMIT_RPM` / `SKILL_ROUTER_HTTP_RATE_LIMIT_RPM` — overrides `server.rate_limit.requests_per_minute`
- `HTTP_RATE_LIMIT_TRUST_PROXY` / `SKILL_ROUTER_HTTP_RATE_LIMIT_TRUST_PROXY` — overrides `server.rate_limit.trust_proxy` (`"true"` to trust `X-Forwarded-For`)

Remote API keys are read from the environment variables named by `inference.embedding.api_key_env` and `inference.reranker.api_key_env`; no secret ever lives in the config file.

Evaluate lexical and local hybrid retrieval against the checked-in labeled queries:

```sh
bun run src/cli.ts eval
# holdout queries: 8
# lexical recall@5: 1.000
# hybrid recall@5:  1.000
```

## Guarantees

- **Read-only vault** — no code path writes under the vault; all state is confined to `state_dir`. Covered by tests.
- **Zero-loss delivery** — delivered bytes always hash-match the file on disk at delivery time.
- **Live index** — a running server folds vault changes (create/modify/delete) into the index within seconds; an unparseable write keeps the previous good entry rather than evicting the skill.
- **Audit log** — every `resolve_skill` call is appended to a SQLite table in `state_dir` (timestamp, query, outcome, candidates with scores, latency).

## Development

```sh
bun test        # full suite (contract, hybrid recall, stdio e2e, watcher, eval)
bun run build   # single-file binary via bun build --compile
```

Reference: [`docs/configuration.md`](docs/configuration.md) and [`docs/schema.json`](docs/schema.json).
