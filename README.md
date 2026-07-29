<p align="center">
  <img src="https://raw.githubusercontent.com/klhq/skillmux/main/docs/assets/logo.png" alt="skillmux" width="400">
</p>

<p align="center">
  <a href="https://github.com/klhq/skillmux/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/klhq/skillmux/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/klhq/skillmux/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/klhq/skillmux"></a>
  <a href="https://www.npmjs.com/package/@klhapp/skillmux"><img alt="npm" src="https://img.shields.io/npm/v/@klhapp/skillmux"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Skillmux manages [`SKILL.md`](https://agentskills.io) collections across AI
coding clients. Keep one canonical vault, pin a small set into native skill
directories, and retrieve the rest through MCP.

You can use Skillmux in three ways:

| Use case | What runs | How skills reach the client |
| --- | --- | --- |
| **Manage native skills** | The CLI or Linux binary on your machine | `init` and `sync` create managed links for core and project skills |
| **Add local retrieval** | Skillmux beside one client | The client calls local stdio MCP; Skillmux searches the full vault |
| **Run a shared service** | One Skillmux server for several clients | Clients call Streamable HTTP MCP |

The same installation can manage native skills and serve local MCP. A shared
service focuses on routed retrieval; manage its mounted vault on the host.

## Choose a setup

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Three ways to use Skillmux: manage native skills, add local MCP retrieval, or run a shared MCP service" width="100%">
</p>

Pick an installation based on the job:

| Installation | Native management | Local MCP | Shared HTTP MCP | Inference |
| --- | --- | --- | --- | --- |
| **Bun package** | Recommended | Recommended | Supported | Downloads and caches GTE-small |
| **Linux binary** | Recommended | Recommended | Supported | Downloads and caches GTE-small |
| **Full Docker image** | Manage on host | Supported | Recommended | GTE-small included |
| **Slim Docker image** | Manage on host | Supported | Recommended | Remote embeddings or lexical fallback |

“Local” describes where Skillmux runs. “Local inference” means the embedding
model runs in the Skillmux process. Both stdio and HTTP expose the same
`resolve_skill` and `fetch_skill` MCP tools.

## Install the CLI

The Bun package supports macOS, Linux, and Windows and requires
[Bun 1.3 or newer](https://bun.sh/docs/installation):

```sh
bun add -g @klhapp/skillmux
skillmux --help
```

Native target sync needs permission to create directory symlinks on Windows.

On Linux, you can install a compiled AMD64 or ARM64 binary instead:

```sh
gh release download --repo klhq/skillmux --pattern 'skillmux-linux-*'
gh attestation verify skillmux-linux-amd64 --repo klhq/skillmux
chmod +x skillmux-linux-amd64
sudo install skillmux-linux-amd64 /usr/local/bin/skillmux
```

Use `skillmux-linux-arm64` on ARM64. See [Deployment](docs/deployment.md) for
the full and slim Docker images.

## Quick starts

Skillmux uses `~/skills` as its default vault:

```text
~/skills/
└── csv-formatter/
    └── SKILL.md
```

### Manage native skills

Run the setup planner, then verify its managed links:

```sh
skillmux init
skillmux sync
skillmux doctor
```

The planner detects clients, asks which skills belong in the core tier, and
shows every write before confirmation. Use explicit flags for automation:

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

Core pins apply to each configured target and stay capped at 25 skills. Add
project-specific skills from a repository root:

```sh
skillmux project init
```

### Add local MCP retrieval

Prefetch the default GTE-small model, index the vault, and start stdio MCP:

```sh
skillmux models download
skillmux index
skillmux doctor
skillmux serve
```

The model cache lives at `~/.cache/skillmux/models`. If you skip the prefetch,
Skillmux downloads the model when local inference first needs it.

### Run a shared MCP service

The full image includes GTE-small and serves Streamable HTTP on `/mcp`:

```sh
docker run -d \
  --name skillmux \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest
```

Use `ghcr.io/klhq/skillmux:latest-slim` when you want remote embeddings or
lexical fallback instead of a bundled model. Docker Hub mirrors both variants
under `docker.io/klhq/skillmux`.

The [getting-started guide](docs/getting-started.md) provides complete recipes
for all three setups.

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

## MCP retrieval

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

Skillmux uses the best available capability:

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
| [Getting started](docs/getting-started.md) | Native management, local MCP, and shared-service recipes |
| [Concepts](docs/concepts.md) | Delivery tiers, deployment topologies, retrieval modes, and ownership |
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
