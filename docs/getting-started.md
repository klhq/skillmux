# Getting started

This guide creates a canonical skill vault, syncs one core skill into native
client directories, and verifies the setup. MCP routing is an optional second
step.

## 1. Install Skillmux

### Bun package

Install [Bun 1.3 or newer](https://bun.sh/docs/installation), then install the
published package:

```sh
bun add -g @klhapp/skillmux
skillmux --help
```

This path supports macOS, Linux, and Windows. Native target sync needs
permission to create directory symlinks on Windows.

### Linux binary

Download a compiled AMD64 or ARM64 binary from the
[latest GitHub release](https://github.com/klhq/skillmux/releases/latest):

```sh
gh release download --repo klhq/skillmux --pattern 'skillmux-linux-*'
gh attestation verify skillmux-linux-amd64 --repo klhq/skillmux
chmod +x skillmux-linux-amd64
sudo install skillmux-linux-amd64 /usr/local/bin/skillmux
```

The attestation check is optional. Replace `amd64` with `arm64` on ARM64.

Docker suits an HTTP service better than local target management. See
[Deployment](deployment.md).

## 2. Prepare a vault

Skillmux defaults to `~/skills`. A vault contains one directory per skill:

```text
~/skills/
├── code-context/
│   └── SKILL.md
└── csv-formatter/
    ├── SKILL.md
    └── references/
```

Each `SKILL.md` must contain valid Agent Skills frontmatter. Create a small
skill if you do not have a vault yet:

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

You can also install a skill from Git:

```sh
skillmux install owner/repo
skillmux install owner/repo/path/to/skill
```

Run `skillmux scan ~/skills` before adopting an existing collection.

## 3. Run guided setup

```sh
skillmux init
```

The wizard:

1. validates the vault;
2. detects clients from filesystem evidence;
3. asks which skills belong in the core tier;
4. shows the config, target, instruction, and sync plan;
5. applies the plan after confirmation.

Skillmux writes machine config under `~/.config/skillmux`, stores tier policy
in `~/skills/skillmux.toml`, and adds a `.skillmux` ownership marker to each
adopted target. It preserves unmanaged files and existing instruction text.

Use a deterministic form for automation:

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

`--dry-run` never prompts or writes. Noninteractive writes require `--yes`.
Use `--no-instructions` to leave instruction files untouched and `--no-sync`
to save the setup without creating links.

## 4. Verify native delivery

```sh
skillmux sync
skillmux doctor
```

`sync` should report no changes after the first successful run. `doctor`
checks the vault, manifest, target markers, state directory, and inference
capability.

Inspect a skill's active source:

```sh
skillmux skill which csv-formatter
```

## 5. Add project skills

Run this command from a project repository:

```sh
skillmux project init
```

The wizard creates a named project group, attaches selected clients, records
the project path, and syncs the chosen skills into project-local client
directories.

The noninteractive form accepts repeatable client and skill flags:

```sh
skillmux project init ~/code/my-project \
  --name my-project \
  --client claude-code \
  --client codex \
  --skill code-context \
  --yes
```

## 6. Enable MCP retrieval

Index the vault and start the stdio server:

```sh
skillmux index
skillmux doctor
skillmux serve
```

Continue with [MCP routing](mcp-routing.md) to register the server and choose a
retrieval mode.

## Next steps

- [Concepts](concepts.md) explains the delivery model.
- [Managing skills](skill-management.md) covers install, pin, sync, and
  recovery workflows.
- [Configuration](configuration.md) documents paths, manifests, and inference.
- [Troubleshooting](troubleshooting.md) lists common `doctor` failures.
