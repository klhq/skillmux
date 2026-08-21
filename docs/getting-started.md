# Getting started

Skillmux supports three setup paths. Pick the result you want before choosing
an installation.

| Goal | Skill delivery | Recommended installation |
| --- | --- | --- |
| [Manage native skills](#manage-native-skills) | Managed links in client skill directories | Skillmux CLI |
| [Add local MCP retrieval](#add-local-mcp-retrieval) | Local stdio MCP | Skillmux CLI |
| [Run a shared MCP service](#run-a-shared-mcp-service) | Streamable HTTP MCP | Skillmux server (full image) |

Native management and local MCP retrieval can run together. Complete both
recipes if you want pinned skills plus on-demand access to the rest of the
vault.

## Install the CLI

Use the Bun package on macOS, Linux, or Windows. It requires
[Bun 1.3 or newer](https://bun.sh/docs/installation):

```sh
bun add -g @klhapp/skillmux
skillmux --help
```

Native target sync needs permission to create directory symlinks on Windows.

Linux users can install the standalone executable without the GitHub CLI or a
package manager. This example selects AMD64 or ARM64, downloads the pinned
`v1.3.4` release, verifies the SHA-256 digest published for that release, and
installs to the user-writable default `~/.local/bin`:

```sh
version=v1.3.4
case "$(uname -m)" in
  x86_64|amd64) asset=skillmux-linux-amd64; sha256=0d0155475748a937ac9b5878c57e1fa14d8fe6957317cb43bbdafd710cbc1966 ;;
  aarch64|arm64) asset=skillmux-linux-arm64; sha256=8cd186707221a8fefbb79eac46ef14d0c5fdae08a2d76e64a01af17a80af0e06 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
bin_dir="${SKILLMUX_BIN_DIR:-$HOME/.local/bin}"
curl --fail --location --output "$asset" "https://github.com/klhq/skillmux/releases/download/$version/$asset"
printf '%s  %s\n' "$sha256" "$asset" | sha256sum --check -
install -Dm755 "$asset" "$bin_dir/skillmux"
```

Ensure `~/.local/bin` is on `PATH`. To use another user-writable location, set
`SKILLMUX_BIN_DIR` before the command. A system-wide installation is an
explicit choice: `sudo install -Dm755 "$asset" /usr/local/bin/skillmux`.

### Install with GitHub CLI attestation

If you want GitHub build-provenance verification, use the GitHub CLI instead.
This keeps the same pinned release and user-writable install location:

```sh
version=v1.3.4
case "$(uname -m)" in
  x86_64|amd64) asset=skillmux-linux-amd64 ;;
  aarch64|arm64) asset=skillmux-linux-arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
bin_dir="${SKILLMUX_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
gh release download "$version" --repo klhq/skillmux --pattern "$asset" --dir "$bin_dir"
gh attestation verify "$bin_dir/$asset" --repo klhq/skillmux
install -m755 "$bin_dir/$asset" "$bin_dir/skillmux"
```

The Bun package and standalone Linux executable expose the same Skillmux CLI
commands.

## Prepare a vault checkout

Skillmux defaults to the `~/skills` vault checkout. Each direct child directory
represents one skill:

```text
~/skills/
├── code-context/
│   └── SKILL.md
└── csv-formatter/
    ├── SKILL.md
    └── references/
```

Each `SKILL.md` needs valid Agent Skills frontmatter. With the Skillmux CLI,
you can install a skill from Git:

```sh
skillmux install owner/repo
skillmux install owner/repo/path/to/skill
```

Or create a small skill:

```sh
mkdir -p ~/skills/csv-formatter
cat > ~/skills/csv-formatter/SKILL.md <<'EOF'
---
name: CSV Formatter
description: Convert CSV or spreadsheet data into clean Markdown tables.
---

# CSV Formatter

Read the first row as headers. Right-align numbers and left-align text.
EOF
```

Run `skillmux scan ~/skills` before adopting an existing collection.

## Manage native skills

Run the guided setup on the machine that owns the client skill directories:

```sh
skillmux init
```

The planner:

1. validates the vault;
2. detects clients from filesystem evidence;
3. asks which skills belong in the core tier;
4. shows the config, target, instruction, and sync plan;
5. applies the plan after confirmation.

Skillmux writes machine config under `~/.config/skillmux`, stores tier policy
in the configured vault checkout's `skillmux.toml`, and records its entries in
each target's `.skillmux` marker. It preserves unmanaged files and existing
instruction text.

Use explicit flags for automation:

```sh
skillmux init \
  --client claude-code \
  --client codex \
  --core csv-formatter \
  --dry-run

skillmux init \
  --client claude-code \
  --client codex \
  --core csv-formatter \
  --yes
```

Verify native delivery:

```sh
skillmux sync
skillmux doctor
skillmux skill which csv-formatter
```

Repeated syncs are idempotent. Add project-specific skills from a repository
root:

```sh
skillmux project init
```

The noninteractive form accepts repeatable client and skill flags:

```sh
skillmux project init ~/code/my-project \
  --name my-project \
  --client claude-code \
  --client codex \
  --skill code-context \
  --yes
```

Continue with [Managing skills](skill-management.md) for pinning, target
ownership, overlays, and recovery.

## Add local MCP retrieval

Run this recipe on the same machine as the MCP client. The default inference
configuration uses quantized GTE-small embeddings on CPU.

Prefetch the model, build the index, and check readiness:

```sh
skillmux models download
skillmux index
skillmux doctor
```

The model cache lives at `~/.cache/skillmux/models`. If you skip
`models download`, Skillmux downloads the model when local inference first
loads it.

Start the stdio server:

```sh
skillmux serve
```

Register it with your MCP client:

```json
{
  "mcpServers": {
    "skillmux": {
      "command": "skillmux",
      "args": ["serve"]
    }
  }
}
```

The client launches the process and closes it with the MCP session. Continue
with [MCP routing](mcp-routing.md) for client behavior and ranked candidate retrieval.

## Run a shared MCP service

Use the full image when you want local embeddings without configuring an
external inference endpoint:

```sh
docker run -d \
  --name skillmux \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest
```

The full image includes GTE-small and is the shared-service default. The slim
image is an advanced option for configured remote embeddings or intentional
lexical-only retrieval; it contains no model files. Neither image includes a
local reranker. Configure remote embeddings on slim when you need hybrid
retrieval. Docker Hub publishes the same tags under `docker.io/klhq/skillmux`.

Check the service:

```sh
curl http://127.0.0.1:3000/health/ready
```

Register `http://127.0.0.1:3000/mcp` as a Streamable HTTP MCP endpoint. Enable
authentication before exposing the service beyond a trusted host. Continue
with [Deployment](deployment.md) for remote inference, network policy,
monitoring, and backups.

The server keeps its two HTTP surfaces separate:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` | Operators | Inspect or update server configuration | Yes, when using named CLI contexts |

Configure separate MCP and administrative bearer tokens; one never grants
access to the other. Named CLI contexts can administer this deployed server,
but cannot install, pin, synchronize, or otherwise manage skill directories on
remote client machines. See [Deployment](deployment.md#http-surfaces).

Manage the mounted vault on the host. A retrieval-only container should mount
it read-only.

## Combine native pins with shared retrieval

Use this topology when users need native core or project pins and also one
shared MCP endpoint. Keep one Git-backed vault source of truth. A vault
checkout is its physical copy; on one machine, `~/skills` can be both:

- each machine that owns client skill directories keeps its own checkout and
  runs the Skillmux CLI for `init`, pinning, and `sync`;
- the shared server mounts its own checkout and serves routed retrieval over
  HTTP;
- MCP-only clients connect to the shared server and do not need the CLI.

Skillmux does not pull, push, replicate, or determine freshness between
checkouts. Git and your deployment process own vault replication and freshness.

## Next steps

- [Concepts](concepts.md) explains delivery, deployment, and inference terms.
- [Configuration](configuration.md) documents local and remote inference.
- [Troubleshooting](troubleshooting.md) lists common `doctor`, model, and
  transport failures.
