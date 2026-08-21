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

## Vault source of truth and checkouts

A **vault source of truth** is the logical skill collection for Skillmux. Each
direct child directory represents one skill and contains a `SKILL.md`. A
**vault checkout** is a physical copy of that collection on a machine.

The default vault checkout path is `~/skills`. Set `vault_path` in
`~/.config/skillmux/config.toml` when its checkout lives elsewhere. On one
machine, `~/skills` can be both the vault source of truth and its checkout.
In a shared topology, use a Git-backed vault source of truth, a checkout on
each client machine for the Skillmux CLI, and a checkout on the server for
Skillmux server. Skillmux does not pull, push, replicate, or determine
freshness between checkouts; Git and the deployment process own those jobs.

Skillmux commands interact with the configured vault checkout in two ways:

- management commands such as `install` and explicit config operations write
  to documented paths;
- MCP retrieval reads skill content and stores indexes and audit records under
  `state_dir`.

MCP delivery reads the current file bytes. It does not copy an indexed
`SKILL.md` body from the state database.

## Delivery tiers

Skillmux applies three policies to one vault checkout:

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
routed skills over stdio, while a shared Skillmux process can serve its server
checkout over HTTP.

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

### HTTP surfaces

An HTTP server has two separate surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` | Operators | Inspect or update server configuration | Yes, when using named CLI contexts |

MCP authentication protects `/mcp`; administrative authentication protects
`/admin/v1/*`. Their bearer tokens are distinct and do not grant access across
surfaces. A named CLI context is an operator connection to the deployed server,
not a way to manage skill directories on remote client machines. The server
and its full/slim images never manage host agent directories. See
[Deployment](deployment.md#http-surfaces).

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

`local_vault_paths` layer machine-specific skill copies over the configured
vault checkout. Skillmux checks overlay paths in order, then falls back to
`vault_path`.

Use overlays for work in progress or machine-specific variants. Keep portable
core and project pins in the configured vault checkout because another machine
may not have the overlay.

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

A reranker scores and reorders the fused candidates. Reranking does not classify
outcomes or filter by score thresholds; Skillmux delivers the top-ranked candidates
directly to the calling model.

## Ranked shortlist retrieval

`resolve_skill` always returns a ranked candidate list:

- each candidate contains a `rank`, `skill_id`, `description`, and a nullable `score`;
- `top_k` controls the maximum candidate count returned, bounded by `output.max_top_k`;
- if no candidates match the query, `resolve_skill` returns an empty list (`candidates: []`);
- the calling model reviews the candidate shortlist and calls `fetch_skill` with the chosen `skill_id` to retrieve complete instructions.

Embedding or reranker failures reduce the active capability and return
structured degradation metadata. Vault and index failures make the server
unready because Skillmux can no longer guarantee valid retrieval.
