# CLI Reference & Automation

Skillmux provides a unified local-or-remote CLI vocabulary for context resolution, configuration management, policy calibration, and shell discoverability.

## Global Options & Target Resolution

Every target-aware command resolves its execution target deterministically in this order:

1. Explicit flags: `--context <name>` or `--server <url>`
2. Environment variables: `SKILLMUX_CONTEXT` or `SKILLMUX_SERVER`
3. Default context configured in `~/.config/skillmux/contexts.toml`
4. Built-in `local` context

> [!IMPORTANT]
> Supplying both `--context` and `--server` (or both `SKILLMUX_CONTEXT` and `SKILLMUX_SERVER`) is rejected as ambiguous. Plaintext HTTP admin targets on non-loopback addresses are rejected unless `--allow-insecure` is supplied.

| Flag | Description |
|------|-------------|
| `--context <name>` | Select a target context stored in `contexts.toml` |
| `--server <url>` | Select an explicit remote server URL |
| `--json` | Emit line-stable JSON envelopes (schema version 1) to stdout |
| `--allow-insecure` | Allow plaintext HTTP admin requests to non-loopback addresses |
| `--verbose` | Output diagnostic stack traces for errors |

---

## Context Management (`skillmux context`)

Contexts store named server targets without embedding raw credentials. Token environment variable names (`token_env`) may be associated with a context.

```sh
# List all configured contexts (includes reserved 'local' context)
skillmux context list

# View the currently active context
skillmux context current

# Add a remote context
skillmux context add prod --server https://skillmux.internal:3000 --token-env PROD_ADMIN_TOKEN

# Switch default context
skillmux context use prod

# Remove a context (reserved 'local' context cannot be removed)
skillmux context remove prod
```

---

## Configuration Management (`skillmux config`)

Local and remote targets share identical `config` subcommands.

```sh
# View current configuration and source attribution (default, toml, environment)
skillmux config show

# Get a specific schema-known dotted key value
skillmux config get recall.k_lexical

# Validate effective configuration schema and runtime readiness
skillmux config validate

# View effective configuration diff against defaults
skillmux config diff

# Set a dotted key value (previews diff and validates before saving)
skillmux config set recall.k_lexical 30

# Perform dry-run validation without writing or activating changes
skillmux config set recall.k_lexical 30 --dry-run

# Inspect runtime status, revision hashes, and readiness
skillmux config status
```

### Reloadable vs. Restart-Required Keys

Config changes are categorized into live-reloadable and restart-required settings:

- **Reloadable**: `vault_path`, `recall.*`, `thresholds.*`, `inference.embedding.*`, `server.rate_limit.*`
- **Restart Required**: `server.hostname`, `server.auth_enabled`, `server.auth_token_env`, `server.admin.enabled`, `server.admin.token_env`, `inference.mode`, `state_dir`

---

## Policy Calibration (`skillmux calibrate`)

Calibrate decision thresholds (`match_score`, `match_margin`, `candidate_floor`) against synthetic or labeled query datasets.

```sh
# Run calibration on a dataset
skillmux calibrate run --dataset ./eval/queries.json

# List stored calibration runs in the evidence store
skillmux calibrate list

# Inspect detailed metrics and confusion matrix for a run
skillmux calibrate show <run_id>

# Apply calibrated thresholds to configuration (with fingerprint validation)
skillmux calibrate apply <run_id>

# Generate a synthetic decision dataset from vault skills
skillmux calibrate generate-dataset --out ./eval/queries.json
```

---

## Administrative HTTP API (`/admin/v1/*`)

Remote servers expose administrative control endpoints under `/admin/v1/*` when enabled in configuration:

```toml
[server.admin]
enabled = true
token_env = "SKILLMUX_ADMIN_TOKEN"
```

Requests require `Authorization: Bearer <token>` where `<token>` matches the environment variable named by `server.admin.token_env`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/v1/capabilities` | `GET` | Advertises server features (`config_read`, `config_write`, `calibration`, `persistence`) |
| `/admin/v1/config` | `GET` | Returns desired/effective config, sources, and `ETag` revision hash |
| `/admin/v1/config` | `PATCH` | Applies dotted-key updates; requires matching `If-Match` header |
| `/admin/v1/calibrations` | `GET`, `POST` | List or start server-side calibration runs |
| `/admin/v1/calibrations/{run_id}` | `GET` | Inspect specific calibration run details |
| `/admin/v1/calibrations/{run_id}/apply` | `POST` | Apply calibrated thresholds to remote server configuration |

---

## Automation & JSON Output (`--json`)

When `--json` or `SKILLMUX_JSON=true` is set, all output is emitted to `stdout` in a stable envelope:

```json
{
  "schema_version": 1,
  "ok": true,
  "target": "local",
  "data": { ... },
  "error": null
}
```

### Exit Codes

| Code | Meaning | Examples |
|------|---------|----------|
| `0` | Success | Command completed cleanly |
| `2` | Usage / Validation Error | Unknown key, malformed value, missing option, invalid command |
| `3` | Target Unreachable / Unauthenticated | Connection refused, HTTP 401 Unauthorized, HTTP 403 Forbidden |
| `4` | Conflict / Governance Gate | HTTP 409 `CONFIG_REVISION_CONFLICT` or `CONFIG_EXTERNALLY_MANAGED` |

---

## Shell Completions (`skillmux completions`)

Generate tab-completions for `bash`, `zsh`, or `fish`:

```sh
# Bash
skillmux completions bash > ~/.local/share/bash-completion/completions/skillmux

# Zsh
skillmux completions zsh > ~/.zsh/completion/_skillmux

# Fish
skillmux completions fish > ~/.config/fish/completions/skillmux.fish
```
