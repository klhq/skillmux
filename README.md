<p align="center">
  <img src="https://raw.githubusercontent.com/klhq/skillmux/main/docs/assets/logo.png" alt="skillmux" width="400">
</p>

<p align="center">
  <a href="https://github.com/klhq/skillmux/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/klhq/skillmux/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/klhq/skillmux/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/klhq/skillmux"></a>
  <a href="https://www.npmjs.com/package/@klhapp/skillmux"><img alt="npm" src="https://img.shields.io/npm/v/@klhapp/skillmux"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Skillmux manages [`SKILL.md`](https://agentskills.io) collections across AI coding clients. Keep one canonical vault, pin core and project skills into each client's native skill directory, and let agents retrieve the rest through MCP.

It works with clients that load skills themselves, clients that use MCP, and setups that combine both:

- **Manage one vault:** install, scan, inspect, and organize skills in one place.
- **Deliver native skills:** sync a small core set everywhere and add project-specific skills where they belong.
- **Retrieve the long tail:** search the full vault with SQLite FTS5, embeddings, and an optional reranker.
- **See what gets used:** inspect routing outcomes and promote frequently used skills into a pinned tier.

## How Skillmux fits together

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Skillmux skill management and retrieval architecture" width="100%">
</p>

Skillmux supports two delivery paths from the same vault:

| Path | Use it for | Delivery |
| --- | --- | --- |
| **Core and project pins** | Skills an agent should load through its native skill system | `skillmux init` and `skillmux sync` create managed symlinks |
| **Routed skills** | A larger collection that should stay out of standing context | MCP `resolve_skill` and `fetch_skill` retrieve skills on demand |

Core pins apply to every configured target and stay capped at 25 skills. Project pins appear only in the project paths and targets you select. Everything else remains available to MCP-capable clients without loading the whole vault into every session.

## Install

### Bun package

The npm package supports macOS, Linux, and Windows and requires [Bun 1.3 or newer](https://bun.sh/docs/installation):

```sh
bun add -g @klhapp/skillmux
skillmux --help
```

Native target sync needs permission to create directory symlinks on Windows.

### Linux binary

Download the binary for your architecture from the [latest GitHub release](https://github.com/klhq/skillmux/releases/latest):

```sh
gh release download --repo klhq/skillmux --pattern 'skillmux-linux-*'
gh attestation verify skillmux-linux-amd64 --repo klhq/skillmux
chmod +x skillmux-linux-amd64
sudo install skillmux-linux-amd64 /usr/local/bin/skillmux
```

Use `skillmux-linux-arm64` instead on ARM64.

### Docker

Skillmux publishes full and slim multi-architecture images to:

- `ghcr.io/klhq/skillmux`
- `docker.io/klhq/skillmux`

The full image includes local GTE-small embeddings. The slim image uses configured remote embeddings or lexical fallback. See the [deployment guide](docs/deployment.md).

## Quick start: manage skills across clients

Skillmux uses `~/skills` as its default vault. Each skill lives in its own directory:

```text
~/skills/
└── csv-formatter/
    └── SKILL.md
```

Create a small skill to try the workflow:

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

Run the guided setup:

```sh
skillmux init
```

The wizard detects installed clients, asks which skills belong in the core tier, shows one review, and writes only after confirmation. It can configure Claude Code, Codex, Gemini CLI, OpenCode, GitHub Copilot, Windsurf, Antigravity, Goose, Hermes, and Skillmux MCP.

For scripts or dotfiles, use explicit flags:

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

`init` adopts each target safely, writes `skillmux.toml`, and runs `sync`. Repeated syncs are idempotent:

```sh
skillmux sync
skillmux doctor
```

Add project-specific skills from a repository root:

```sh
skillmux project init
```

The [getting-started guide](docs/getting-started.md) covers installation, existing vaults, deterministic setup, and project groups.

## Add and inspect skills

Install a skill from a Git repository:

```sh
skillmux install owner/repo
skillmux install owner/repo/path/to/skill
```

Skillmux validates `SKILL.md` and scans candidate content before copying it into the vault. Use `--fail-on low|medium|high` to turn selected findings into an install gate.

Useful management commands:

```sh
skillmux scan ~/skills
skillmux core pin csv-formatter --yes
skillmux project pin my-project code-context --yes
skillmux skill which csv-formatter
skillmux report --since 7d
```

Read [Managing skills](docs/skill-management.md) for target ownership, project groups, local overrides, recovery, and reporting.

## Enable MCP retrieval

Index the vault and start a local stdio server:

```sh
skillmux index
skillmux doctor
skillmux serve
```

Register it with an MCP client:

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

Skillmux exposes two tools:

| Tool | Input | Result |
| --- | --- | --- |
| `resolve_skill` | Natural-language task description | A matched skill, an ordered shortlist, or no match |
| `fetch_skill` | Exact `skill_id` | The current `SKILL.md` body, SHA-256 digest, and supporting-file paths |

Routing uses the best capability available:

1. SQLite FTS5 provides lexical retrieval and offline fallback.
2. Local or remote embeddings add semantic recall.
3. An optional reranker orders candidates and can produce calibrated automatic matches.

Without calibrated reranker thresholds, Skillmux returns an ordered shortlist and lets the calling model choose. Endpoint failures degrade to a healthy lower retrieval mode instead of taking the MCP server down.

Read [MCP routing](docs/mcp-routing.md) for transports, outcomes, client instructions, retrieval modes, and the wire contract.

## Supported clients

| Client | Native skill delivery | MCP setup |
| --- | --- | --- |
| Claude Code | `~/.claude/skills` | Configure in the client |
| Codex | `$CODEX_HOME/skills` or `~/.codex/skills` | Configure in the client |
| Gemini CLI, OpenCode, GitHub Copilot, Windsurf | `~/.agents/skills` | Configure in the client |
| Antigravity | `~/.gemini/config/skills` | Configure in the client |
| Goose, Hermes | Manual full-vault setup | Manual registration |
| Custom clients | Any directory through a custom target | Stdio or Streamable HTTP |

Skillmux preserves existing instruction files and unmanaged target content. Run `skillmux init --dry-run` to inspect every planned filesystem change.

## Guarantees

- **Controlled sources:** pins come from the canonical vault, while routed delivery follows the configured overlay order.
- **Scoped writes:** management commands write only to documented config, vault, state, and adopted target paths.
- **Managed ownership:** sync removes only entries recorded in the target's `.skillmux` marker.
- **Current bytes:** MCP delivery hashes the file on disk and never serves a stale indexed body.
- **Graceful retrieval:** embedding and reranker failures fall back without hiding the active capability.
- **Auditable decisions:** each `resolve_skill` call records its outcome, candidates, scores, and latency in the state database.

## Documentation

Start with the [documentation hub](docs/README.md).

| Guide | Covers |
| --- | --- |
| [Getting started](docs/getting-started.md) | Installation, first vault, guided setup, sync, and verification |
| [Concepts](docs/concepts.md) | Vaults, delivery tiers, targets, retrieval modes, and ownership |
| [Managing skills](docs/skill-management.md) | Install, scan, pin, sync, report, overlays, and recovery |
| [MCP routing](docs/mcp-routing.md) | Tools, outcomes, transports, retrieval, fallback, and integrity |
| [Deployment](docs/deployment.md) | Docker, HTTP, auth, CORS, rate limits, health, and metrics |
| [Configuration](docs/configuration.md) | Machine config, inference, manifests, and overlays |
| [CLI reference](docs/cli.md) | Commands, contexts, automation, JSON output, and exit codes |
| [Policy calibration](docs/calibration.md) | Labelled datasets, certification, and threshold application |
| [Troubleshooting](docs/troubleshooting.md) | `doctor`, common failures, and migration notes |
| [MCP schema](docs/schema.json) | JSON Schema 2020-12 tool contract |

## Development

Skillmux uses Bun for development:

```sh
bun install --frozen-lockfile
bun test
bun run build
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
