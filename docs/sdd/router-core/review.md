# Review — router-core (2026-07-15)

<!-- historical review; response contract superseded by docs/sdd/gte-hybrid-routing/spec.md -->

Diff: full implementation of spec tasks 1–7 (~2000 lines; new: clients, hybrid recall, MCP stdio server, CLI, watcher, eval harness, guarantee tests; OSS-readiness: generic config defaults, config.example.toml, README).

Note: the goose `sdd-review` fan-out returned empty passes (all workers hit max-turns); this review was performed inline per the skill's fallback. Build/test results below were run directly, not taken from the recipe banner.

## Findings

| # | Focus | Confidence | Class | Finding | Resolution |
|---|---|---|---|---|---|
| 1 | correctness | High | AUTO-FIX | `skillsNeedingVectors` compared only `content_sha256`; changing `embedding.dimension` left stale vectors that cosine silently scores 0 forever | Fixed: backfill is dimension-aware (`v.dim = ?` in join); regression test added |
| 2 | correctness | High | AUTO-FIX | `FSWatcher` had no `error` handler — a watcher error (e.g. vault root removed) would crash the server via unhandled `'error'` event | Fixed: error handler logs and pauses live updates; server keeps serving |
| 3 | security | Low | NITPICK | `listSupportingFiles` follows file symlinks inside a skill dir; a symlink target outside the vault appears in `files` listings (paths only — contents are never delivered by the router) | Not fixed — single-user vault, contents never served; revisit if the vault ever becomes multi-writer |
| 4 | performance | Low | NITPICK | `vectorTopK` loads all vectors from SQLite per resolve (~0.5 MB at 116×1024 dims) | By design (spec: brute-force, no ANN); cache only if latency ever shows up in audit rows |
| 5 | tests | Low | NITPICK | Server e2e covers degraded resolve + fetch; the matched-outcome path over stdio is exercised only via library-level tests | Acceptable — wire shape of matched is covered by fetch (same body-as-text rule) |

Security pass notes: skill_id is regex-validated at the MCP boundary and again constrained to indexed ids before any path join (no traversal); FTS queries are sanitized and quoted; all SQL is parameterized; the embeddings API key is read from env, never logged, never in config; audit stores raw queries deliberately per AC10.

## Build / Tests

- Build check (`bunx tsc --noEmit`): PASS ✅ (run directly)
- Test execution (`bun test`): PASS ✅ 38/38, 8 files (run directly)
- Real-vault smoke: 114/116 entries indexed in 0.17 s (2 skipped entries are plain files, not skills); compiled binary (`bun build --compile`) works for serve/index/eval

## AC Status

| Criterion | Status | Notes |
|---|---|---|
| AC1 — resolve_skill outcomes ∈ {matched, ambiguous, no_match} + degraded flag | ✅ Done | Contract tests |
| AC2 — matched delivers byte-identical SKILL.md, sha-verified, never stale | ✅ Done | Zero-loss test; delivery hashes raw bytes, re-indexes on drift |
| AC3 — ambiguous: ≤5 candidates, no body, rerank_score null when degraded | ✅ Done | Contract + degraded tests |
| AC4 — no_match: no body/candidates, guidance message | ✅ Done | Contract test |
| AC5 — fetch_skill verbatim + sha + files; unknown id → tool error | ✅ Done | Library + stdio e2e (SKILL_NOT_FOUND) |
| AC6 — hybrid recall FTS5 ∪ cosine, config-driven thresholds, no hardcoding | ✅ Done | Hybrid + decision + config tests; all five params from config.toml |
| AC7 — degraded lane: FTS5-only, never matched, works fully offline | ✅ Done | Embed-fail, rerank-fail, timeout-budget, offline stdio e2e |
| AC8 — index rebuild < 5 s; live updates ≤ 5 s; invalid file retention | ✅ Done | Watcher tests + retention; rebuild timing manually verified (0.17 s real vault) |
| AC9 — read-only vault guarantee | ✅ Done | mtime+hash snapshot test across index/resolve/fetch |
| AC10 — audit row per resolve call | ✅ Done | Persistence test (query, outcome, candidates best-first, latency) |
| AC11 — eval harness: holdout recall@5, threshold suggestions | ⚠️ Manual-verify | Harness implemented + tested; calibration run against real endpoints pending (model host offline during session) — chosen thresholds not yet committed to config |

## PR review follow-ups (fixed in-branch, 2026-07-15)

The GitHub PR #1 review surfaced three further non-blocking findings; all three were fixed test-first on the branch:

1. `fetch_skill` on a deleted-on-disk skill now maps to `SKILL_NOT_FOUND` and drops the stale row (was: raw ENOENT).
2. `toFtsQuery` keeps Unicode letters/digits, so CJK queries get lexical recall (unicode61 token granularity; embedding lane still covers sub-token matching).
3. `PRAGMA busy_timeout = 2000` on the index handle — concurrent `skill-router index` + server writes back off instead of surfacing SQLITE_BUSY.

Also hardened: watcher tests carry explicit 15 s timeouts (wall-clock-sensitive; flaked under full-suite load), and the watcher delete test now observes through `resolveSkill` so the new fetch-side stale-row cleanup can't mask the watcher path.

## Open items (not defects)

- Spec task 8 (deployment slice): Gateway MCP client registration, configuration examples, and verification.
- License file — user decision pending (project is potentially OSS).
- Local `~/.config/skill-router/config.toml` must set `api_key_env` and the real base_urls (code defaults are now generic localhost placeholders).

## Security escalation

Recommended before ship: the diff introduces new network egress (embeddings/rerank clients) and a public tool surface consuming externally supplied input (`query`, `skill_id`) with filesystem reads. `/security-review` criteria are matched; the baseline pass above found no high-confidence issues.
