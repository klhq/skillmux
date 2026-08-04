# Troubleshooting

Start with:

```sh
skillmux doctor
skillmux config show
skillmux config validate
```

Add `--json` when you need machine-readable diagnostics.

## Startup without configuration

`skillmux serve` and `skillmux serve --transport http` do not require a config
file or an existing `~/.config/skillmux` directory. If you need a specific
vault, remote inference, or HTTP policy, create a config with `skillmux config
init --vault ~/skills --yes`; otherwise the server uses its defaults. A missing
optional config parent disables live reload until the next server start. For a
malformed watched config, check the reported reload error—the running server
continues with its last known good configuration.

## Installation failures

### Standalone executable checksum verification fails

Do not install the downloaded file. Confirm that the command still uses the
pinned release and that the detected architecture is correct:

```sh
uname -m
sha256sum skillmux-linux-amd64
```

Download the file again with the [standalone installation procedure](getting-started.md#install-the-cli).
For GitHub build-provenance verification instead of the published SHA-256
digest, use the [GitHub CLI attestation procedure](getting-started.md#install-with-github-cli-attestation).

### `skillmux: command not found` after installation

The standalone installer defaults to `~/.local/bin`. Add it to the shell's
`PATH`, restart the shell, then run `skillmux --version`. Alternatively,
install to a user-writable directory already on `PATH` with
`SKILLMUX_BIN_DIR=/path/on/PATH`; use `sudo install` only when you explicitly
want a system-wide installation.

## Vault failures

### Checkouts are out of date

Skillmux reads the configured vault checkout; it does not pull, push,
replicate, or determine freshness between checkouts. Update the Git-backed
vault source of truth and use your Git or deployment process to update the
affected checkout, then rerun `skillmux index` or `skillmux sync` as needed.

### Vault path does not exist

Check the effective path and its source:

```sh
skillmux config show
```

Create the directory or initialize config against a populated vault:

```sh
skillmux config init --vault ~/skills --yes
```

`config init` requires at least one valid `SKILL.md`.

### A skill does not appear

Each skill must sit one directory below the vault:

```text
~/skills/<skill-id>/SKILL.md
```

Run:

```sh
skillmux scan ~/skills/<skill-id>
skillmux index
skillmux skill which <skill-id>
```

The scanner reports invalid frontmatter and unreadable content. `skill which`
also reveals local-overlay shadowing.

## Sync failures

### Target has no ownership marker

Skillmux will not change an existing unmarked directory. Adopt it first:

```sh
skillmux init --client claude-code --dry-run
skillmux init --client claude-code --yes
```

### Target points to the full vault

Review the smaller pinned set before converting:

```sh
skillmux init --client claude-code \
  --migrate-full-vault \
  --core code-context \
  --dry-run
```

Apply the same command with `--yes` after checking the plan.

### Unmanaged file collides with a pin

Skillmux preserves unmanaged target content. Rename or remove the conflicting
entry yourself, then rerun `skillmux sync`.

### Target belongs to another host

New targets include the current hostname. `sync` skips a target when its
manifest `host` differs. Run `skillmux target show <name>` and add a separate
target for the current machine instead of reusing the other machine's path.

### A local-overlay skill cannot be pinned

Core and project pins must exist in the configured `vault_path` checkout. Copy
or commit the skill there before pinning it. Routed lookup can still serve the
overlay.

## Retrieval failures

### `resolve_skill` returns `ambiguous`

Ambiguity is the expected result without calibrated reranker thresholds. The
calling model should select a candidate and call `fetch_skill`.

Improve a weak shortlist by:

- writing a concrete skill description with task vocabulary;
- enabling embeddings;
- increasing recall depth when the relevant skill falls outside the fused
  candidate set.

Use a labelled dataset and [Policy calibration](calibration.md) before enabling
automatic matches.

### Server reports lexical mode

Lexical mode means Skillmux can query FTS5 but cannot use embeddings. The next
step depends on the installation:

| Installation | Expected action |
| --- | --- |
| Skillmux CLI with local inference | Download the local model and rebuild the index |
| Skillmux server (full image) | Inspect `doctor`, `/health/ready`, or `skill_router_deployment_info` for `image_variant=full`; do not infer it from the tag |
| Skillmux server (slim image) | Configure remote embeddings or keep lexical fallback |

For a Skillmux CLI installation, run:

```sh
skillmux doctor
skillmux models download
skillmux index
```

For remote inference, verify the endpoint, model, dimension, API-key
environment variable, and network path. The slim image does not contain
GTE-small, so `models download` is not its recovery path.

### Reranker is unavailable

Skillmux keeps the hybrid shortlist when a reranker probe or request fails.
Check `inference.reranker.endpoint`, `adapter`, `model`, and the environment
variable named by `api_key_env`.

Use the complete request URL. Skillmux does not append `/rerank` or infer an
adapter from the endpoint.

### Delivered content changed after indexing

Skillmux checks the file before delivery and refreshes stale metadata. If a
skill cannot be parsed during a live edit, the index keeps the previous good
metadata but does not serve stale body bytes. Finish the write with valid
frontmatter and retry.

## HTTP failures

### Another machine cannot connect

The Skillmux CLI binds HTTP to `127.0.0.1`. Set `server.hostname` or
`HTTP_HOSTNAME` to a reachable interface, then restart the server. Docker
binds `0.0.0.0` inside the container, but the host still needs a published
port. Enable authentication before exposing either deployment.

### Browser receives `403`

Add the browser origin to `server.allowed_origins`. The value must match the
request's `Origin` header. Curl and server-to-server clients omit this header
and do not use the CORS list.

### MCP client receives `401`

Confirm `server.auth_enabled = true`, export the environment variable named by
`auth_token_env`, and send `Authorization: Bearer <token>`.

An enabled server with an empty token environment variable returns a server
configuration error rather than accepting an empty token.

### Operator receives `401` from `/admin/v1/*`

Administrative authentication is separate from MCP authentication. Confirm
`server.admin.enabled = true`, export the environment variable named by
`server.admin.token_env`, and configure the named CLI context with that same
environment-variable name:

```sh
export SKILLMUX_PROD_ADMIN_TOKEN="replace-with-admin-token"
skillmux context add prod \
  --server https://skillmux.example.com \
  --token-env SKILLMUX_PROD_ADMIN_TOKEN
skillmux --context prod config status
```

An MCP token for `/mcp` cannot authenticate this request, and the administrative
token cannot authenticate an MCP client. A named context administers the
deployed server configuration only; use Skillmux CLI on the machine that owns
client directories for `install`, pinning, or `sync`.

### Client receives `429`

The rate limiter rejected the request. Read `Retry-After` and the
`X-RateLimit-*` response headers. Increase `requests_per_minute` only after
checking for a retry loop or shared-token traffic.

## Configuration migration errors

Skillmux rejects removed fields with migration guidance:

- replace `[targets.<name>].project` with `project_groups = [...]`;
- rename `[project.<group>].repos` to `paths`;
- use `skillmux core pin|unpin` instead of removed `manifest pin|unpin`;
- replace legacy reranker base-URL variables with
  `SKILLMUX_RERANK_ENDPOINT` and `SKILLMUX_RERANK_ADAPTER`.

Run `skillmux config validate` after editing TOML.

## Collect diagnostics

For a bug report, include:

```sh
skillmux --help
skillmux config show
skillmux doctor --json
```

Remove tokens, private endpoint credentials, local usernames, and raw audit
queries before posting output. Open an issue at
<https://github.com/klhq/skillmux/issues>.
