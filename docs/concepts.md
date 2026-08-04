# Concepts

Skillmux separates three decisions:

| Decision | Choices |
| --- | --- |
| Skill delivery | Native core/project pins or routed MCP retrieval |
| Process location | On the client machine or as a shared HTTP service |
| Packaging | Skillmux CLI installation or Skillmux server deployment |

Retrieval capability is a fourth, independent concern: lexical, hybrid,
reranked, or exact retrieval.

These decisions are independent. A local CLI can manage native pins and serve
stdio MCP at the same time. A shared service uses HTTP MCP and can run local or
remote inference.

## Canonical vault

The vault is the source collection for Skillmux. Each direct child directory
represents one skill and contains a `SKILL.md`.

The default path is `~/skills`. Set `vault_path` in
`~/.config/skillmux/config.toml` when you keep the collection elsewhere.

Skillmux commands interact with the vault in two ways:

- management commands such as `install` and explicit config operations write
  to documented paths;
- MCP retrieval reads skill content and stores indexes and audit records under
  `state_dir`.

MCP delivery reads the current file bytes. It does not copy an indexed
`SKILL.md` body from the state database.

## Delivery tiers

Skillmux applies three policies to one vault:

| Tier | Scope | Delivery |
| --- | --- | --- |
| Core | Each configured target | Native client skill directory |
| Project | Selected project paths and targets | Project-local native skill directory |
| Routed | Full indexed vault | MCP on demand |

Core and project skills are **pinned**. `skillmux sync` creates managed
symlinks for them. Routed skills stay in the vault until an MCP client asks for
one.

One skill can serve different roles across machines or projects, but the
shared manifest prevents conflicting core and project assignments. Core stays
capped at 25 skills to protect client startup context.

Delivery tiers do not select a deployment. A local Skillmux process can serve
routed skills over stdio, while a shared Skillmux process can serve the same
vault over HTTP.

## Deployment topologies

| Topology | Process location | Transport | Typical installation |
| --- | --- | --- | --- |
| Native management | Client machine | Filesystem links | Skillmux CLI |
| Local MCP | Beside one client | stdio | Skillmux CLI |
| Shared MCP | Server or container host | Streamable HTTP | Skillmux server (full image) |

The **Skillmux CLI** is available as either the Bun package or the standalone
Linux executable; both expose the same commands. The **full image** is the
default Skillmux server deployment. The **slim image** is an
advanced variant for configured remote embeddings or intentional lexical-only
retrieval. The CLI can also serve HTTP, and Docker can serve stdio for clients
that support a container command. Those combinations use the same MCP tools;
the table lists the shortest setup for each use case.

The full image bundles GTE-small. The slim image contains no model
files, so it uses configured remote embeddings or lexical fallback. The Bun
package downloads and caches GTE-small when local inference first loads it;
`skillmux models download` prefetches it. Neither Skillmux server image
bundles a local reranker; configure one remotely when needed.

## Clients and targets

A **client** is a supported product name such as `claude-code` or `codex`.
Skillmux maps it to the product's skill directory and safe instruction-file
conventions.

A **target** is a physical directory managed by sync. Several clients can map
to one target. Gemini CLI, OpenCode, GitHub Copilot, and Windsurf share
`~/.agents/skills`, so Skillmux deduplicates that directory.

Custom targets let you manage another directory without adding a product
adapter:

```sh
skillmux target add custom-agent --dir /srv/custom-agent/skills --yes
```

## Ownership markers

Each managed target contains a `.skillmux` marker. The marker records the
target name, vault, schema version, and entries created by Skillmux.

Sync removes only recorded entries. It refuses to adopt an unmarked directory,
overwrite unmanaged collisions, or treat a local overlay marker as a target
marker.

Run `skillmux init --dry-run` before changing a target. Read
[Managing skills](skill-management.md#target-ownership-and-recovery) before
undoing an adopted target.

## Project groups

A project group connects:

- one or more local project paths;
- a set of skill IDs;
- selected targets.

Skillmux materializes each group inside the project using the target's path
relative to the user's home directory. A shared `skillmux.toml` can list
checkout paths from several machines. Sync skips paths that do not exist on
the current machine.

## Local vault overlays

`local_vault_paths` layer machine-specific skill copies over the canonical
vault. Skillmux checks overlay paths in order, then falls back to `vault_path`.

Use overlays for work in progress or machine-specific variants. Keep portable
core and project pins in the canonical vault because another machine may not
have the overlay.

## Inference and retrieval capabilities

Inference location and deployment location use separate settings. Local
inference runs GTE-small inside the Skillmux process. Remote inference calls
configured embedding and reranker endpoints. Either inference choice can back
an HTTP MCP deployment.

Skillmux reports the active retrieval capability:

| Capability | Behavior |
| --- | --- |
| `lexical` | SQLite FTS5 and BM25 produce an ordered shortlist |
| `hybrid` | Reciprocal-rank fusion combines lexical and embedding results |
| `reranked` | A configured reranker reorders the fused candidates |
| `exact` | An exact skill ID resolves directly |

A reranker does not enable automatic matches by itself. Skillmux needs
calibrated `match_score`, `match_margin`, and `candidate_floor` thresholds
before it returns a semantic result as `matched`.

## Retrieval outcomes

`resolve_skill` returns one of three outcomes:

- `matched`: one skill passed the calibrated policy, so Skillmux delivers its
  `SKILL.md` body inline;
- `ambiguous`: Skillmux returns an ordered candidate list and the calling model
  chooses one with `fetch_skill`;
- `no_match`: no candidate passed the policy and the agent continues without a
  skill.

Embedding or reranker failures reduce the active capability. Vault and index
failures make the server unready because Skillmux can no longer guarantee
valid retrieval.
