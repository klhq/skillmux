# Skillmux documentation

Skillmux manages one `SKILL.md` vault source of truth: the logical skill
collection. A vault checkout is a physical copy used by a client machine or
server. On one machine, `~/skills` can be both. Choose a workflow based on
where skills need to appear and where Skillmux should run.

## Choose a setup

1. [Install the Skillmux CLI](getting-started.md#install-the-cli) for native
   skills or one local MCP client.
2. On Linux when Bun is undesirable, use the **standalone Linux executable**;
   it is an installation method for Skillmux CLI.
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

## Learn the model

- [Getting started](getting-started.md): choose an installation, prepare a
  vault, and follow one of three setup recipes.
- [Concepts](concepts.md): separate delivery tiers, deployment topology, and
  retrieval capability.
- [Managing skills](skill-management.md): install, scan, pin, sync, inspect,
  and recover skills.
- [MCP routing](mcp-routing.md): register stdio or HTTP MCP and understand
  retrieval outcomes.

## Operate Skillmux

- [Deployment](deployment.md): deploy the shared server, choose slim only when
  needed, expose HTTP, and operate the service.
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
