# Deployment

Choose a deployment from the client count and inference source:

| Use case | Recommended package | Transport | Inference |
| --- | --- | --- | --- |
| Native skill management | Bun package or Linux binary | Filesystem | None required |
| Local MCP retrieval | Bun package or Linux binary | stdio | Downloaded GTE-small |
| Shared MCP with local inference | Full Docker image | Streamable HTTP | Bundled GTE-small |
| Shared MCP with remote or lexical retrieval | Slim Docker image | Streamable HTTP | Remote endpoint or lexical fallback |

The Bun package and Linux binary can serve HTTP. Docker can serve stdio. These
options expose the same MCP tools, but the table shows the shortest operational
path for each use case.

“Local inference” means the model runs in the Skillmux process. It does not
mean that the MCP client must run on the same machine.

## CLI and Linux binary

Run stdio MCP beside one client:

```sh
skillmux models download
skillmux index
skillmux serve
```

Run an HTTP service without Docker:

```sh
skillmux serve --transport http --port 3000
```

The native HTTP server binds `127.0.0.1` by default. Configure authentication
and a reachable hostname before serving other machines.

## Docker images

Skillmux publishes Linux AMD64 and ARM64 images to GHCR and Docker Hub:

| Variant | GHCR tag | Contents |
| --- | --- | --- |
| Full | `ghcr.io/klhq/skillmux:latest` | Runtime plus bundled GTE-small |
| Slim | `ghcr.io/klhq/skillmux:latest-slim` | Runtime without model files |

Docker Hub mirrors the same tags under `docker.io/klhq/skillmux`.

Use the full image when the service should run embeddings itself:

```sh
docker run -d \
  --name skillmux \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest
```

The container sets:

- `VAULT_PATH=/vault`;
- `STATE_DIR=/data`;
- `PORT=3000`;
- `RUNNING_IN_DOCKER=true`.

Mount the vault read-only for a retrieval-only service. Run `install`, `init`,
`sync`, and other filesystem management commands on the host. Containerized
native management requires writable host mounts for every managed client
directory and is not the recommended setup.

## Slim image

The slim image stays ready in lexical mode without an inference endpoint.
Configure remote embeddings to enable hybrid retrieval:

```sh
docker run -d \
  --name skillmux-slim \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  -e EMBED_ENDPOINT="https://embedding.example.com/v1/embeddings" \
  -e EMBED_MODEL="your-embedding-model" \
  -e EMBED_DIMENSION="1024" \
  ghcr.io/klhq/skillmux:latest-slim
```

Set `SKILLMUX_CONFIG` and mount a TOML file when you need reranking, calibrated
thresholds, server policy, or API-key environment names:

```sh
docker run -d \
  --name skillmux-slim \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -v "$PWD/config.toml:/etc/skillmux/config.toml:ro" \
  -e SKILLMUX_CONFIG=/etc/skillmux/config.toml \
  -e EMBEDDING_API_KEY \
  -e RERANKER_API_KEY \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest-slim
```

Start from [config.remote.example.toml](../config.remote.example.toml).

## Docker over stdio

Some local clients can launch a container as their stdio MCP command:

```sh
docker run -i --rm \
  -v ~/skills:/vault:ro \
  ghcr.io/klhq/skillmux:latest serve --transport stdio
```

The container must keep standard input open, so use `-i`.

## Expose HTTP safely

The native CLI and Linux binary bind `127.0.0.1`. Docker binds `0.0.0.0` so
port mapping works. Before exposing the port beyond a trusted host:

```toml
[server]
hostname = "0.0.0.0"
auth_enabled = true
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []

[server.rate_limit]
enabled = true
requests_per_minute = 60
trust_proxy = false
```

Set the token in the process environment:

```sh
export SKILLMUX_AUTH_TOKEN="replace-with-a-long-random-token"
skillmux serve --transport http
```

Clients send:

```text
Authorization: Bearer replace-with-a-long-random-token
```

`allowed_origins` controls browser CORS requests. Requests without an `Origin`
header, including MCP clients and curl, do not need a CORS entry.

Keep `trust_proxy = false` unless a trusted reverse proxy overwrites
`X-Forwarded-For`. A client can spoof that header when it reaches Skillmux
directly.

## Health and metrics

The HTTP server provides:

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | Vault, index, inference, and active capability |
| `GET /health` | Compatibility alias for liveness |
| `GET /metrics` | Prometheus text exposition |
| `GET /stats` | Aggregated routing outcomes for `skillmux report` |
| `POST /mcp` | Streamable HTTP MCP transport |

The Docker health check calls `/health/ready`.

Prometheus metrics cover request totals, resolve outcomes, latency, errors, and
rate-limit rejections. Health and metrics do not require bearer authentication,
but `/stats` does when server authentication is enabled. CORS still applies to
browser requests.

## Remote administration

Name a deployed server without storing its token:

```sh
skillmux context add prod \
  --server https://skillmux.example.com \
  --token-env SKILLMUX_PROD_ADMIN_TOKEN
skillmux context use prod
skillmux config status
```

The context stores the token environment variable name. Export its value in
the shell before running admin commands.

Enable the admin API and use a separate admin token in server configuration.
Read [CLI reference](cli.md#administrative-http-api-adminv1) for routes and
[Configuration](configuration.md#http-server) for reload behavior.

## Persistent data and backups

Persist `state_dir` to retain the index, audit log, and calibration evidence.
Skill content remains in the vault and should use its own backup or Git
workflow.

Treat the state database as sensitive because audit rows can contain raw user
queries. Stop the process or use SQLite-safe backup tooling before copying a
live database.
