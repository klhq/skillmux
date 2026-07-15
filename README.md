# skill-router

A local, read-only [MCP](https://modelcontextprotocol.io) stdio server that gives agents **on-demand skill discovery**: route a natural-language task description to the right skill in your vault and deliver its `SKILL.md` byte-for-byte, verified by SHA-256.

Built for agents that lack native skill triggering (Goose recipe workers, opencode, and friends). Agents that already trigger skills natively (e.g. Claude Code) don't need it.

## How it works

```
resolve_skill("convert this spreadsheet to markdown")
        │
        ▼
  hybrid recall: SQLite FTS5 (BM25)  ∪  embedding cosine (brute-force)
        │
        ▼
  cross-encoder rerank  →  matched | ambiguous | no_match
```

- **matched** — one skill clearly wins: full `SKILL.md` delivered inline, `sha256(body) == content_sha256 ==` hash of the file on disk at delivery time. Stale index? It re-indexes and delivers fresh bytes — never stale ones.
- **ambiguous** — up to 5 candidates (id, title, description, score). The calling LLM picks and calls `fetch_skill`. The router advises; it never decides for you.
- **no_match** — proceed under your normal workflow; don't load an unrelated skill.

If the embedding or rerank endpoint is down or slow, the router **degrades instead of failing**: FTS5-only recall, never `matched`, `degraded: true`. Startup and resolution work with the model host fully offline.

### Tools

| Tool | Input | Returns |
|------|-------|---------|
| `resolve_skill` | `query` | outcome + metadata in `structuredContent`; on match the verbatim body as text content (exactly once on the wire) |
| `fetch_skill` | `skill_id` | verbatim body, `content_sha256`, supporting-file paths |

The full contract lives in [`docs/sdd/router-core/schema.json`](docs/sdd/router-core/schema.json) (JSON Schema 2020-12, language-neutral).

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- A skill vault: one directory per skill with a `SKILL.md` in [agentskills.io](https://agentskills.io) format (`name`, `description`, optional `aliases` frontmatter). Default location `~/.agents/skills`.
- Optional (for the hybrid lane): an OpenAI-compatible embeddings endpoint and an [Infinity](https://github.com/michaelfeil/infinity)-native `/rerank` endpoint. Without them the router still works, lexical-only.

## Quick start

```sh
bun install
cp config.example.toml ~/.config/skill-router/config.toml   # then edit
bun run src/cli.ts index    # build the index (< 5 s for ~100 skills)
bun run src/cli.ts serve    # stdio MCP server
```

Register with your MCP client directly, e.g.:

```json
{
  "mcpServers": {
    "skill-router": {
      "command": "bun",
      "args": ["run", "/path/to/skill-router/src/cli.ts", "serve"]
    }
  }
}
```

Or compile a single-file binary:

```sh
bun run build              # → dist/skill-router
dist/skill-router serve
```

## Configuration

See [`config.example.toml`](config.example.toml) — vault path, state directory, recall depths, decision thresholds, endpoints. `SKILL_ROUTER_CONFIG` overrides the config path (default `~/.config/skill-router/config.toml`). The embeddings API key is read from the environment variable named by `embedding.api_key_env`; no secret ever lives in the config file.

Calibrate thresholds against your own vault:

```sh
bun run src/cli.ts eval
# holdout queries: 212
# recall@5 lexical-only: 0.868
# recall@5 hybrid:       0.943
# suggested config.toml [thresholds]: ...
```

## Guarantees

- **Read-only vault** — no code path writes under the vault; all state is confined to `state_dir`. Covered by tests.
- **Zero-loss delivery** — delivered bytes always hash-match the file on disk at delivery time.
- **Live index** — a running server folds vault changes (create/modify/delete) into the index within seconds; an unparseable write keeps the previous good entry rather than evicting the skill.
- **Audit log** — every `resolve_skill` call is appended to a SQLite table in `state_dir` (timestamp, query, outcome, candidates with scores, latency).

## Development

```sh
bun test        # full suite (contract, hybrid recall, stdio e2e, watcher, eval)
bun run build   # single-file binary via bun build --compile
```

Design docs: [`docs/sdd/router-core/spec.md`](docs/sdd/router-core/spec.md) (approved spec) and [`docs/sdd/router-core/schema.json`](docs/sdd/router-core/schema.json) (typed contract).
