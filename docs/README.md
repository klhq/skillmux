# Skillmux documentation

Skillmux manages one `SKILL.md` vault. Choose a workflow based on where skills
need to appear and where Skillmux should run.

## Choose a use case

| Goal | Start with | Recommended installation |
| --- | --- | --- |
| Put a small skill set in native client directories | [Manage native skills](getting-started.md#manage-native-skills) | Bun package or Linux binary |
| Let one client search the full vault through MCP | [Add local MCP retrieval](getting-started.md#add-local-mcp-retrieval) | Bun package or Linux binary |
| Serve the vault to several MCP clients | [Run a shared MCP service](getting-started.md#run-a-shared-mcp-service) | Full or slim Docker image |

You can combine native management and local MCP retrieval on one machine. The
shared service uses the same MCP tools over HTTP.

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

- [Deployment](deployment.md): compare packages and Docker variants, expose
  HTTP, and operate a shared service.
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
