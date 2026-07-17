# Security Policy

## Supported Versions

`skill-router` is pre-1.0. Only the latest release on `main` is supported with security fixes.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/klhq/skill-router/security/advisories/new) for this repository, or email lance@klh.app.

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is ideal)
- Affected version/commit

We'll acknowledge your report within 5 business days and aim to ship a fix or mitigation before any public disclosure.

## Scope Notes

`skill-router` is a **read-only** MCP server: no code path writes under the configured vault, and it deliberately serves file contents verbatim without evaluating them. Reports involving the following are especially welcome:

- Any code path that writes to, or otherwise mutates, the vault
- Path traversal or symlink escapes when resolving skill/vault paths
- Auth or CORS bypasses on the HTTP transport
- Rate limiter bypasses
