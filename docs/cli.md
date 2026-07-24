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
# Create the machine config after validating a populated vault
skillmux config init --vault ~/skills --yes

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

`config init` writes only `vault_path`. It leaves an existing config unchanged
and does not add `local_vault_paths`.

---

## Setup Planner (`skillmux init`)

Run `skillmux init` with no arguments in a terminal to start guided setup.
Skillmux preselects clients it can detect from filesystem evidence, asks for
core skills, prints one complete review, and applies after one confirmation.
The prompt stays line-oriented and does not use an alternate terminal screen.

Select clients by product name:

```sh
skillmux init --client claude-code --client codex --core csv-formatter --dry-run
skillmux init --client claude-code --client codex --core csv-formatter --yes
```

Skillmux supports these client IDs:

| Client | Skill delivery |
|--------|----------------|
| `claude-code` | `~/.claude/skills` |
| `codex` | `$CODEX_HOME/skills`, falling back to `~/.codex/skills` |
| `gemini-cli`, `opencode`, `github-copilot`, `windsurf` | Shared `~/.agents/skills` surface |
| `antigravity` | `~/.gemini/config/skills` |
| `goose`, `hermes` | Manual full-vault configuration |
| `skillmux-mcp` | Manual MCP registration |

Direct target IDs are `agent-skills`, `claude-code`, `codex`, and `custom`.
Custom targets require `--path <dir>`. The legacy `agents` and `claude` IDs
print deprecation warnings and retain their manifest names.

`--dry-run` prints the config, target, instruction, and core plan without
prompting or writing. `--json` emits one schema-versioned plan or result
object. Noninteractive writes require `--yes`. `--interactive` forces the
wizard and seeds it with supplied flags. `--no-instructions` skips managed
instruction files; `--no-sync` saves setup without materializing links.

Skillmux rejects a target that currently links to the whole vault. Convert it
only after reviewing the smaller post-sync skill set:

```sh
skillmux init --client claude-code --migrate-full-vault \
  --core csv-formatter --dry-run
skillmux init --client claude-code --migrate-full-vault \
  --core csv-formatter --yes
```

Client instruction adapters append one managed discovery block and preserve
the rest of each file. Skillmux uses `.hermes.md` for Hermes and refuses
`SOUL.md` or Hermes's installed-source `AGENTS.md`. A client without a safe
user-level convention reports manual setup.

---

## Project Setup (`skillmux project init`)

Run the guided flow from a project directory:

```sh
skillmux project init
```

Skillmux resolves the project directory from an explicit positional path, then
the current Git root, then the current directory. It suggests the directory
basename as the project-group name.

The noninteractive form accepts repeatable client and skill flags:

```sh
skillmux project init ~/code/skillmux \
  --name skillmux \
  --client claude-code \
  --client codex \
  --skill sdd-tdd \
  --skill code-context \
  --yes
```

`--client` maps product names to configured, deduplicated targets. Advanced
callers can attach a configured target with repeated `--target <name>`.
Re-running the command merges missing paths, skills, and target attachments.
It validates the complete manifest before an atomic write and runs `sync` by
default. Use `--no-sync` when another process will materialize the links.

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
