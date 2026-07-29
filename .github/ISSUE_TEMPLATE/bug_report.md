---
name: Bug report
about: Report a problem with skillmux
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear, concise description of what's wrong.

**To Reproduce**
Steps to reproduce, ideally including your `config.toml` (redact secrets) and the query you sent to `resolve_skill`/`fetch_skill`.

**Expected behavior**
What you expected to happen instead.

**Environment**
- skillmux version/commit:
- Bun version (`bun --version`):
- Product: Skillmux CLI / Skillmux server
- Installation: Bun package / standalone Linux executable / full Docker image / slim Docker image
- Topology: native management / local stdio MCP / shared HTTP MCP
- Inference: local / remote / lexical fallback
- OS:

**Logs**
Relevant output from `stderr` or the audit log in `state_dir`, if available.

**Additional context**
Anything else that might be relevant (vault size, embedding/rerank endpoint in use, degraded mode, etc.).
