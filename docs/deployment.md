# Deployment

Choose a deployment from the client count and inference source:

| Use case | Recommended package | Transport | Inference |
| --- | --- | --- | --- |
| Native skill management | Skillmux CLI | Filesystem | None required |
| Local MCP retrieval | Skillmux CLI | stdio | Downloaded GTE-small |
| Shared MCP with local inference | Skillmux server (full image) | Streamable HTTP | Bundled GTE-small |
| Shared MCP with remote or lexical retrieval | Skillmux server (slim image, advanced) | Streamable HTTP | Remote endpoint or lexical fallback |

Install the CLI with either the Bun package or standalone Linux executable;
they expose the same commands and can also serve HTTP. The Linux executable
has a [pinned, checksum-verified download](getting-started.md#install-the-cli)
that defaults to `~/.local/bin`, plus an
[attested GitHub CLI path](getting-started.md#install-with-github-cli-attestation).
Deploy the full image
for a shared Skillmux server by default. Docker can serve stdio when a client
requires a container command; use slim only for remote or lexical retrieval.

“Local inference” means the model runs in the Skillmux process. It does not
mean that the MCP client must run on the same machine.

## Skillmux CLI

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

Neither native command needs a config file or an existing `~/.config/skillmux`
directory. They use safe defaults until you add a config for a vault checkout,
remote inference, or server policy.

## Skillmux server images

Skillmux publishes Linux AMD64 and ARM64 images to GHCR and Docker Hub:

| Variant | GHCR tag | Contents |
| --- | --- | --- |
| Full | `ghcr.io/klhq/skillmux:latest` | Runtime plus bundled GTE-small |
| Slim | `ghcr.io/klhq/skillmux:latest-slim` | Runtime without model files; remote or lexical retrieval |

Docker Hub mirrors the same tags under `docker.io/klhq/skillmux`.

Neither image bundles a local reranker. Configure a remote reranker when your
retrieval policy needs one.

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
native management is intentionally rejected: agent directories belong to the
host CLI, where their symlinks resolve correctly.

## Container command contract

The image separates its executable from its default command. Running an image
without arguments starts Streamable HTTP MCP on port 3000:

```sh
docker run ghcr.io/klhq/skillmux:latest
```

This default works without mounting or creating a config path. The image uses
`/vault` and `/data`; mount them when you need a persistent vault checkout or
index state.

Arguments after the image replace that default, so one-shot maintenance and
stdio use the same image:

```sh
docker run --rm -v ~/skills:/vault:ro -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest doctor
docker run --rm -v ~/skills:/vault:ro -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest index
```

Docker Compose `command:` and Kubernetes `args:` likewise replace only the
default command, not the executable.

The supported container commands are `serve`, `index`, `doctor`, `report`,
`scan`, `skill which`, and read-only `config show`, `config get`,
`config validate`, `config diff`, and `config status`.

The image rejects host-management commands, including `init`, `sync`,
`install`, `project`, `target`, `core`, `local-vault`, `models download`,
context management, calibration, evaluation, and configuration initialization
or mutation. Install the Skillmux CLI on the host when a command needs to
manage a local vault or agent directory.

A rejected command exits with code 2 and tells you the exact host command to
run. In `--json` mode, the error code is
`CONTAINER_COMMAND_UNSUPPORTED`; `error.details.rejected_command`,
`recommended_host_command`, and `documentation` are stable automation fields.
For example, `docker run --rm ghcr.io/klhq/skillmux:latest models download
--json` recommends `skillmux models download` on the host.

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
docker run --no-healthcheck -i --rm \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest serve --transport stdio
```

The container must keep standard input open, so use `-i`. Disable the baked
HTTP health check for stdio because no HTTP listener is started.

## HTTP surfaces

The shared server exposes two distinct HTTP surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` | Operators | Inspect or update server configuration | Yes, when using named CLI contexts |

Configure and distribute separate bearer tokens. An MCP token authenticates an
AI client to `/mcp` only; an administrative token authenticates an operator to
`/admin/v1/*` only. Neither token grants access to the other surface.

## Expose HTTP safely

The Skillmux CLI binds `127.0.0.1`. Docker binds `0.0.0.0` so
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

[server.admin]
enabled = true
token_env = "SKILLMUX_ADMIN_TOKEN"
```

Set the token in the process environment:

```sh
export SKILLMUX_AUTH_TOKEN="replace-with-an-mcp-token"
export SKILLMUX_ADMIN_TOKEN="replace-with-a-separate-admin-token"
skillmux serve --transport http
```

Clients send:

```text
Authorization: Bearer replace-with-an-mcp-token
```

`allowed_origins` controls browser CORS requests. Requests without an `Origin`
header, including MCP clients and curl, do not need a CORS entry.

The `Authorization` example above is for an MCP client calling `/mcp`.
Administrative requests instead use the token named by `server.admin.token_env`.

Keep `trust_proxy = false` unless a trusted reverse proxy overwrites
`X-Forwarded-For`. A client can spoof that header when it reaches Skillmux
directly.

## Health and metrics

The HTTP server provides:

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | Vault, index, inference, active capability, version, runtime, and image variant |
| `GET /health` | Compatibility alias for liveness |
| `GET /metrics` | Prometheus text exposition |
| `GET /stats` | Aggregated routing outcomes for `skillmux report` |
| `POST /mcp` | Streamable HTTP MCP transport |
| `/admin/v1/*` | Administrative configuration API (when enabled) |

The Docker health check calls `/health/ready`.

Prometheus metrics cover request totals, resolve outcomes, latency, errors,
rate-limit rejections, and a `skill_router_deployment_info` gauge labelled with
`version`, `runtime`, and `image_variant`. The values match `skillmux doctor`,
`skillmux config status`, and `/health/ready`; use `image_variant="none"` for
a host runtime. These operational outputs never include credentials, API keys,
or token values. Health and metrics do not require bearer authentication, but
`/stats` does when server authentication is enabled. CORS still applies to
browser requests.

## Remote administration

Name a deployed server without storing its **administrative** token:

```sh
skillmux context add prod \
  --server https://skillmux.example.com \
  --token-env SKILLMUX_PROD_ADMIN_TOKEN
skillmux context use prod
skillmux config status
```

The context stores the token environment variable name. Export its value in
the shell before running admin commands. This token is separate from the MCP
token configured with `server.auth_token_env`; it does not authenticate MCP
clients.

Enable the admin API and use a separate admin token in server configuration.
Read [CLI reference](cli.md#administrative-http-api-adminv1) for routes and
[Configuration](configuration.md#http-server) for reload behavior.

Named contexts administer the deployed server configuration only. They do not
install, pin, synchronize, or otherwise manage skill directories on remote
client machines. Run those filesystem-management commands through Skillmux CLI
on the machine that owns the directories. The full and slim server images read
their mounted vault checkout and do not manage host agent directories.

## Persistent data and backups

Persist `state_dir` to retain the index, audit log, and calibration evidence.
Skill content remains in the server's vault checkout and should use its own
backup or Git workflow.

Treat the state database as sensitive because audit rows can contain raw user
queries. Stop the process or use SQLite-safe backup tooling before copying a
live database.

## Native pins with shared retrieval

For the combined topology, use one Git-backed vault source of truth. A vault
checkout is a physical copy: each machine that manages native skills keeps its
own checkout and runs the Skillmux CLI; the shared service mounts its own
checkout for retrieval. On one machine, `~/skills` can be both the source of
truth and its checkout. Skillmux does not pull, push, replicate, or determine
freshness between checkouts; Git and your deployment process own that
responsibility. The server image reads its mounted checkout and does not manage
host agent directories.
