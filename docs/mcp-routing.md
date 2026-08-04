# MCP routing

Skillmux exposes its configured vault checkout through two Model Context
Protocol tools. A vault source of truth is the logical collection; a checkout
is its physical copy. Choose a transport based on where the process runs:

| Topology | Transport | Typical package |
| --- | --- | --- |
| Skillmux beside one client | stdio | Skillmux CLI |
| Shared Skillmux server | Streamable HTTP | Full image by default; slim image for remote or lexical retrieval |

Both transports expose the same `resolve_skill` and `fetch_skill` contract.
Local native pinning is optional and can run beside stdio MCP.

## Register a stdio server

Start the server:

```sh
skillmux index
skillmux doctor
skillmux serve
```

Register the command in your MCP client:

```json
{
  "mcpServers": {
    "skillmux": {
      "command": "skillmux",
      "args": ["serve"]
    }
  }
}
```

The default transport is stdio. The process exits when the client closes its
input stream or sends a termination signal.

## Connect to a shared HTTP service

Start a Streamable HTTP server:

```sh
skillmux serve --transport http --port 3000
```

Clients send MCP requests to:

```text
http://127.0.0.1:3000/mcp
```

The default host accepts loopback connections only. Configure authentication
and network exposure before serving other machines. See
[Deployment](deployment.md#expose-http-safely).

## Tool contract

### `resolve_skill`

Input:

```json
{
  "query": "convert this spreadsheet to a Markdown table"
}
```

Skillmux returns one outcome:

- `matched`: `structuredContent` contains match metadata and the text content
  contains the `SKILL.md` body once;
- `ambiguous`: `structuredContent` contains up to `candidate_limit` candidates;
- `no_match`: the agent continues with its normal workflow.

### `fetch_skill`

Input:

```json
{
  "skill_id": "csv-formatter"
}
```

The response contains the current `SKILL.md` body as text content.
`structuredContent` contains the skill ID, title, content SHA-256, and
supporting-file paths. Fetch does not depend on an earlier resolve call.

The complete wire contract lives in [schema.json](schema.json).

## Recommended agent behavior

Give the calling client these rules:

1. Call `resolve_skill` when a task may benefit from a specialized workflow.
2. Follow the delivered skill on `matched`.
3. On `ambiguous`, choose the best candidate and call `fetch_skill`.
4. On `no_match`, continue without loading a skill.

Do not treat the first ambiguous candidate as an automatic match. Skillmux
uses ambiguity to keep the final choice with the calling model when it lacks
enough confidence.

## Retrieval pipeline

Skillmux builds candidates in stages:

1. SQLite FTS5 ranks lexical matches with BM25.
2. Local or remote embeddings rank semantic similarity.
3. Reciprocal-rank fusion combines both lists.
4. An optional reranker scores the fused candidates.
5. Calibrated thresholds select `matched`, `ambiguous`, or `no_match`.

The default local inference configuration uses FTS5 and quantized
`Xenova/gte-small` embeddings. Skillmux CLI installations cache the
downloaded model under `~/.cache/skillmux/models`; the full image
includes it. The slim image starts with lexical retrieval and can call an
OpenAI-compatible embedding endpoint.

Remote inference also supports `jina-v1` or `bifrost-v1` reranker adapters.

Without a reranker, Skillmux returns a shortlist and does not auto-match.
Without calibrated thresholds, a configured reranker orders the shortlist but
still does not auto-match.

Read [Configuration](configuration.md#local-inference) for local and remote
inference settings. Read [Policy calibration](calibration.md) before enabling
automatic matches.

## Fallback and readiness

Skillmux advertises the capability it can support:

- embedding failure falls back to lexical retrieval;
- reranker failure preserves the hybrid shortlist;
- vault or index failure marks the server unready.

Check the active mode:

```sh
skillmux doctor
curl http://127.0.0.1:3000/health/ready
```

A ready server reports `lexical`, `hybrid`, or `reranked` along with skill and
index status.

## Content integrity

The index stores metadata and retrieval state. Delivery reads the file from
disk, computes its SHA-256, and returns those current bytes. If indexed
metadata has gone stale, Skillmux refreshes it before delivery.

Supporting files remain in the vault. `fetch_skill` lists their relative paths
so the calling workflow can locate them through its configured filesystem
access.

## Audit data

Each resolve request records:

- timestamp and query;
- retrieval capability and outcome;
- candidates with scores;
- selected skill ID, when present;
- latency.

Skillmux stores audit rows in the SQLite database under `state_dir`. Use
`skillmux report` to summarize activity. Treat raw queries as private user
data when backing up or sharing the database.
