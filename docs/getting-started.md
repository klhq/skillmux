# Getting started

Skillmux supports three setup paths. Pick the result you want before choosing
an installation.

| Goal | Skill delivery | Recommended installation |
| --- | --- | --- |
| [Manage native skills](#manage-native-skills) | Managed links in client skill directories | Bun package or Linux binary |
| [Add local MCP retrieval](#add-local-mcp-retrieval) | Local stdio MCP | Bun package or Linux binary |
| [Run a shared MCP service](#run-a-shared-mcp-service) | Streamable HTTP MCP | Full or slim Docker image |

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

Linux users can install a compiled AMD64 or ARM64 binary instead:

```sh
gh release download --repo klhq/skillmux --pattern 'skillmux-linux-*'
gh attestation verify skillmux-linux-amd64 --repo klhq/skillmux
chmod +x skillmux-linux-amd64
sudo install skillmux-linux-amd64 /usr/local/bin/skillmux
```

Replace `amd64` with `arm64` on ARM64. The Bun package and Linux binary expose
the same commands.

## Prepare a vault

Skillmux defaults to `~/skills`. Each direct child directory represents one
skill:

```text
~/skills/
├── code-context/
│   └── SKILL.md
└── csv-formatter/
    ├── SKILL.md
    └── references/
```

Each `SKILL.md` needs valid Agent Skills frontmatter. If you installed the CLI
or Linux binary, you can install a skill from Git:

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
in `~/skills/skillmux.toml`, and records its entries in each target's
`.skillmux` marker. It preserves unmanaged files and existing instruction
text.

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
with [MCP routing](mcp-routing.md) for client behavior and retrieval outcomes.

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

The full image includes GTE-small. The slim image omits model files and starts
in lexical mode:

```sh
docker run -d \
  --name skillmux-slim \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest-slim
```

Configure remote embeddings on the slim image when you need hybrid retrieval.
Docker Hub publishes the same tags under `docker.io/klhq/skillmux`.

Check the service:

```sh
curl http://127.0.0.1:3000/health/ready
```

Register `http://127.0.0.1:3000/mcp` as a Streamable HTTP MCP endpoint. Enable
authentication before exposing the service beyond a trusted host. Continue
with [Deployment](deployment.md) for remote inference, network policy,
monitoring, and backups.

Manage the mounted vault on the host. A retrieval-only container should mount
it read-only.

## Next steps

- [Concepts](concepts.md) explains delivery, deployment, and inference terms.
- [Configuration](configuration.md) documents local and remote inference.
- [Troubleshooting](troubleshooting.md) lists common `doctor`, model, and
  transport failures.
