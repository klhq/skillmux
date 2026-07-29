# Skillmux documentation

Skillmux manages one `SKILL.md` vault and delivers skills through native client
directories, MCP retrieval, or both.

## Start here

- [Getting started](getting-started.md): install Skillmux, set up a vault, sync
  native clients, and verify the result.
- [Concepts](concepts.md): learn how vaults, tiers, targets, and retrieval fit
  together.
- [Managing skills](skill-management.md): install, scan, pin, sync, inspect, and
  recover skills.
- [MCP routing](mcp-routing.md): connect an MCP client and understand retrieval
  outcomes.

## Operate Skillmux

- [Deployment](deployment.md): run stdio or HTTP servers, deploy Docker images,
  and configure network controls.
- [Configuration reference](configuration.md): configure inference, manifests,
  server settings, and local overlays.
- [CLI reference](cli.md): use commands, contexts, JSON output, and exit codes.
- [Policy calibration](calibration.md): create labelled datasets and certify
  reranker thresholds.
- [Troubleshooting](troubleshooting.md): diagnose vault, sync, model, and server
  problems.

## Integrate and contribute

- [MCP contract](schema.json): JSON Schema 2020-12 definitions for tool inputs
  and results.
- [Contributing](../CONTRIBUTING.md): development setup, tests, and pull request
  conventions.
- [Releasing](releasing.md): maintainer release procedure.
- [Security](../SECURITY.md): vulnerability reporting.

## Common paths

### Use Skillmux as a native skill manager

Follow [Getting started](getting-started.md), then use
[Managing skills](skill-management.md) for core and project policy.

### Add on-demand retrieval

Complete the native setup if you want pinned skills, then follow
[MCP routing](mcp-routing.md). The MCP server can also run by itself against an
existing vault.

### Run a shared server

Read [Deployment](deployment.md), enable authentication before exposing HTTP,
then add named remote contexts from the [CLI reference](cli.md#context-management-skillmux-context).
