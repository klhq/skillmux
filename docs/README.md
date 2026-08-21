# Skillmux documentation

Skillmux manages one `SKILL.md` vault source of truth: the logical skill
collection. A vault checkout is a physical copy used by a client machine or
server. On one machine, `~/skills` can be both. Choose a workflow based on
where skills need to appear and where Skillmux should run.

## Choose a setup

1. [Install the Skillmux CLI](getting-started.md#install-the-cli) for native
   skills or one local MCP client.
2. On Linux, use the [standalone executable install](getting-started.md#install-the-cli)
   when you want a pinned, checksum-verified CLI without `gh`; the
   [GitHub CLI attestation path](getting-started.md#install-with-github-cli-attestation)
   is also available for provenance verification.
3. [Deploy the full image](getting-started.md#run-a-shared-mcp-service) for
   shared HTTP through Skillmux server.
4. Choose the **slim image** when using remote embeddings or lexical retrieval.

You can combine native management and local MCP retrieval on one machine. For
native pins plus shared retrieval, run Skillmux CLI on each machine that owns
client directories and deploy Skillmux server for HTTP MCP. The Bun package is
the cross-platform CLI installation method; the standalone Linux executable is
its Linux alternative. Git and the deployment process, not Skillmux, replicate
vault checkouts and determine their freshness; see
[Deployment](deployment.md#native-pins-with-shared-retrieval).

Both `skillmux serve` (stdio) and `skillmux serve --transport http` start with
safe defaults when no config file or config directory exists. Add a config only
to customize behavior; see [Configuration](configuration.md#machine-config-bootstrap).

## HTTP surfaces

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` | Operators | Inspect or update server configuration | Yes, when using named CLI contexts |

The MCP and administrative surfaces use separate bearer tokens; possession of
one does not grant access to the other. A named CLI context administers the
deployed server only, never remote client skill directories. See
[Deployment](deployment.md#http-surfaces) for authentication and examples.

## Learn the model

- [Getting started](getting-started.md): choose an installation, prepare a
  vault, and follow one of three setup recipes.
- [Concepts](concepts.md): separate delivery tiers, deployment topology, and
  retrieval capability.
- [Managing skills](skill-management.md): install, scan, pin, sync, inspect,
  and recover skills.
- [MCP routing](mcp-routing.md): register stdio or HTTP MCP and route queries
  to ranked candidate shortlists.

## Operate Skillmux

- [Deployment](deployment.md): deploy the shared server, choose slim only when
  needed, understand its container command boundary, separate MCP from
  administrative HTTP, compare deployment identity across CLI, health, and
  metrics, and operate the service.
- [Configuration reference](configuration.md): configure inference, manifests,
  server settings, local overlays, and container read-only configuration.
- [CLI reference](cli.md): use host and container command surfaces,
  administrative contexts, JSON output, and exit codes.
- [Ranked-shortlist migration](ranked-shortlist-migration.md): upgrade to the ranked-only
  shortlist contract.
- [Troubleshooting](troubleshooting.md): diagnose vault, sync, model, and server
  problems.

## Integrate and contribute

- [MCP contract](schema.json): JSON Schema 2020-12 definitions for tool inputs
  and results.
- [Contributing](../CONTRIBUTING.md): development setup, tests, and pull request
  conventions.
- [Releasing](releasing.md): maintainer release procedure.
- [Security](../SECURITY.md): vulnerability reporting.
