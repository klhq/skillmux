# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/klhq/skillmux/compare/v0.2.1...v0.3.0) (2026-07-21)


### Added

* **adapters:** add unified local and remote target adapters (AC3, AC7, AC10) ([552b7d8](https://github.com/klhq/skillmux/commit/552b7d8f26ece4ab4a98f14326e508e35aeb57d5))
* **admin:** add authenticated /admin/v1 HTTP control plane (AC7, AC8, AC9, AC10) ([7b7958f](https://github.com/klhq/skillmux/commit/7b7958fb0e248e2c33a0ca1e566286617a8a0d84))
* **calibrate:** Automated calibration-tuning pipeline, evidence store, and live reload ([#35](https://github.com/klhq/skillmux/issues/35)) ([7ccd79f](https://github.com/klhq/skillmux/commit/7ccd79f9d25d901aa3d7aec43953b79896ebfa24))
* **cli:** add output formatting, exit code mapping, and shell completions (AC11, AC12) ([0099395](https://github.com/klhq/skillmux/commit/009939501192f81dc8fbe2e15c33bce22beb1456))
* **cli:** CLI polish, target resolution, config/calibrate parity, and admin control plane ([a4fb67d](https://github.com/klhq/skillmux/commit/a4fb67d3e8a09ae6ef8151ad4892ec3d94d261e0))
* **cli:** connect CLI dispatcher with context, config, calibrate, and completions (cli-polish) ([bd3fd14](https://github.com/klhq/skillmux/commit/bd3fd140443e4523fcaf163b2fe5e57d5c51ac9c))
* **config:** add source-aware config service and status tracking (AC4, AC5, AC6) ([325342a](https://github.com/klhq/skillmux/commit/325342a55b5bac4a7b3aee7d7740e2fc22f7aee7))
* **context:** add context management and target resolution service (AC1, AC2) ([34435c9](https://github.com/klhq/skillmux/commit/34435c934aaa5ad69af90b7b42e761c674d6ac85))


### Fixed

* **clients:** handle trailing /v1 in embedding base_url ([26d8158](https://github.com/klhq/skillmux/commit/26d8158138b390ffb3e5c3f54777273673db0a73))
* **types:** resolve TypeScript compilation errors in CLI, adapters, and server ([e4ad7d2](https://github.com/klhq/skillmux/commit/e4ad7d2c059157e52a9f584f15eeaed6a8091fec))


### Changed

* **config:** remove deprecated environment variable shims ([#34](https://github.com/klhq/skillmux/issues/34)) ([e046f45](https://github.com/klhq/skillmux/commit/e046f45c3133b2e91b4920513975107b025b19f5))

## [0.2.1](https://github.com/klhq/skillmux/compare/skillmux-v0.2.0...skillmux-v0.2.1) (2026-07-21)

## [0.2.0](https://github.com/klhq/skillmux/compare/skillmux-v0.1.1...skillmux-v0.2.0) (2026-07-21)


### Added

* **cli:** add inference setup commands ([8fda80c](https://github.com/klhq/skillmux/commit/8fda80c24e5fc3ba6ddc969621630bebaa5b1580))
* **config:** add explicit inference modes ([4e73073](https://github.com/klhq/skillmux/commit/4e73073e026e8a37b7d6cac0f24c1100c0a050b3))
* **eval:** validate local hybrid retrieval ([172b703](https://github.com/klhq/skillmux/commit/172b703af63ed3826cafb7e461fe072c9d0c4dad))
* **health:** add liveness and readiness endpoints ([a1ac4e2](https://github.com/klhq/skillmux/commit/a1ac4e2590485d581b33d0b9c2e5f28d4316598a))
* **lifecycle:** initialize routing before readiness ([4526d5d](https://github.com/klhq/skillmux/commit/4526d5d6c25ddcda30b2550b9dff28c50956ceaf))
* **lifecycle:** stop server resources gracefully ([7deb6f2](https://github.com/klhq/skillmux/commit/7deb6f2ea5ed399911e829d5f6da1b371143de35))
* **npm-publish:** publish package on tagged releases ([#22](https://github.com/klhq/skillmux/issues/22)) ([4638027](https://github.com/klhq/skillmux/commit/46380275c5ec99388e4f6b405085995df17b016c))
* **ops:** add readiness-aware lifecycle ([391d9ff](https://github.com/klhq/skillmux/commit/391d9ffc4a5afd2140ae1279671d3cd058e1d187))
* **ops:** expose readiness metrics and Docker probe ([891eab5](https://github.com/klhq/skillmux/commit/891eab5bb30d0da9e084c5a1ec4e4f35deb63305))
* rename project to skillmux and implement compatibility shims ([bec8a11](https://github.com/klhq/skillmux/commit/bec8a115acae31ab939b3e0991fba1f668f94f97))
* **router-core:** add device and dtype config for local models ([3c08b3f](https://github.com/klhq/skillmux/commit/3c08b3fbaefdadafc0d108429fd3d44e3436e243))
* **router-core:** add HTTP auth and CORS controls ([395d94b](https://github.com/klhq/skillmux/commit/395d94b5214e55b146af6b6e5a01b6486aa7ef7f))
* **router-core:** add local ONNX clients and model downloader ([b387c1e](https://github.com/klhq/skillmux/commit/b387c1e1486a985f86f6261fb5ecceedde2a1c4f))
* **router-core:** add Streamable HTTP transport server ([6f6384e](https://github.com/klhq/skillmux/commit/6f6384e2ee5bbe756b3da393ac97db3c50ea48b9))
* **router-core:** hybrid skill routing MCP server ([0d4f25b](https://github.com/klhq/skillmux/commit/0d4f25b3db61732126a8935d11d30a2111e23794))
* **router-core:** make ambiguous shortlist configurable ([b362564](https://github.com/klhq/skillmux/commit/b3625648025eb8eff67d8fa4d85063277e66eef9))
* **router-core:** robust local ONNX config, HTTP security, and testing ([ff0a6c4](https://github.com/klhq/skillmux/commit/ff0a6c417a1cf42745d0a44dfb8bfe9dfb9ad5d3))
* **router-core:** scaffold TypeScript core and fixture tests ([41ae4a1](https://github.com/klhq/skillmux/commit/41ae4a180e0fc4529f37783e69cd3985ed2505f3))
* **router:** add GTE hybrid retrieval ([3496ae6](https://github.com/klhq/skillmux/commit/3496ae6ab9832097de65ab6bbb9339dc7dd8ba1d))
* **router:** add HTTP rate limiting and metrics ([#4](https://github.com/klhq/skillmux/issues/4)) ([c7840a4](https://github.com/klhq/skillmux/commit/c7840a4de5d57672e768a48ed8e2eac6b151ebc0))
* **router:** add hybrid retrieval ranking ([d28dd1e](https://github.com/klhq/skillmux/commit/d28dd1e3ea3f2192921d47a11c2f6b13d314d3f0))
* **router:** add model overrides and HTTP observability ([#3](https://github.com/klhq/skillmux/issues/3)) ([923c99c](https://github.com/klhq/skillmux/commit/923c99c2bdb0e47beb9b99079bf51a1e9172c34f))
* **skillmux:** complete rename with compatibility shims ([6ef3f0e](https://github.com/klhq/skillmux/commit/6ef3f0efbfd13454354bb7970a386e41fbad0d82))
* **skr-cli:** add --dry-run support to syncTarget ([e42f7a6](https://github.com/klhq/skillmux/commit/e42f7a6783194fea9ea1e3002672bb40392b516e))
* **skr-cli:** add --install-hook for an idempotent post-merge sync hook ([1df48d9](https://github.com/klhq/skillmux/commit/1df48d9374fe84509b8eb03d901e364e751d873f))
* **skr-cli:** add --restore-monolith to revert a marked target to a vault symlink ([49bef90](https://github.com/klhq/skillmux/commit/49bef90f2c6d9f2344f621ba7e5ccefd9f60a55e))
* **skr-cli:** add adoptTarget for skr init's in-place ownership marking ([d3757eb](https://github.com/klhq/skillmux/commit/d3757ebfd017a7d36d820073d856ac7f11bfe3f4))
* **skr-cli:** add serializeManifest to write skr.toml ([8675ff4](https://github.com/klhq/skillmux/commit/8675ff40f7b81426a6b7a99d9ae0d874a85be7f8))
* **skr-cli:** add skr.toml manifest parser ([d7a3d11](https://github.com/klhq/skillmux/commit/d7a3d11cb7f2b796132636cb901b98bdace27b0a))
* **skr-cli:** aggregate audit rows into GET /stats StatsResponse shape ([22e556a](https://github.com/klhq/skillmux/commit/22e556a1d48ebc6a1a7f56f4070b728ac60f48a1))
* **skr-cli:** applyInit writes skr.toml and adopts confirmed targets ([f8df561](https://github.com/klhq/skillmux/commit/f8df56129fe5fb36cbfea58f337d47225c8679d1))
* **skr-cli:** default vault_path to the neutral ~/skills ([a642249](https://github.com/klhq/skillmux/commit/a642249f645701ee644240795f810d51b7bd91a4))
* **skr-cli:** derive [targets.&lt;name&gt;] key from a detected surface path ([cef13a8](https://github.com/klhq/skillmux/commit/cef13a8c9183499b0dec910e3f6d4ec391fd423c))
* **skr-cli:** detect existing skill surfaces with evidence ([a2a5bad](https://github.com/klhq/skillmux/commit/a2a5badfe47ea96e78056ca54679c4e0ff434ea0))
* **skr-cli:** enforce core cap and skip missing repo paths with a note ([6e86abc](https://github.com/klhq/skillmux/commit/6e86abc5e582d2879fdd8cf9cc848b10e6061f6a))
* **skr-cli:** materialize a fresh skr sync target with core-skill symlinks ([c38c1ae](https://github.com/klhq/skillmux/commit/c38c1aef37cae5eb6650e970f0ba6e784e578699))
* **skr-cli:** parse relative/absolute --since windows for GET /stats ([e035fa5](https://github.com/klhq/skillmux/commit/e035fa56be576e9b2bcf7b0dc8e146c8b0fc5fd8))
* **skr-cli:** print the last mile (MCP registration + §3.3 discovery paragraph) ([f532c1a](https://github.com/klhq/skillmux/commit/f532c1aea3d59aba6d92f982c61d1b21842e710c))
* **skr-cli:** propose an empty core/project manifest (conservative default) ([f7324cf](https://github.com/klhq/skillmux/commit/f7324cfb68686a6a62df1b70dc6ed6d6ce7c0eec))
* **skr-cli:** query audit db and compose getStats(db, since) ([ccbcd43](https://github.com/klhq/skillmux/commit/ccbcd43aaa00515c1f70f7b6b0144fa399e13323))
* **skr-cli:** rebuild marked sync targets with add/remove diffing ([26ff381](https://github.com/klhq/skillmux/commit/26ff381203f00ba61b84f846b95472be27f519ec))
* **skr-cli:** rename installed binary to skr ([2b7adc2](https://github.com/klhq/skillmux/commit/2b7adc2183c3b130b82466a6ccaaf8c7799c5611))
* **skr-cli:** render StatsResponse as human-readable report text ([f431e70](https://github.com/klhq/skillmux/commit/f431e7082bd602b3f67342a7cf388f3e82002e26))
* **skr-cli:** replicate project-tier pin dirs into repos for project=true targets ([2005aa1](https://github.com/klhq/skillmux/commit/2005aa1df2837d89a6ac4003a6426481342ad99e))
* **skr-cli:** validate manifest skills exist and don't overlap core/project ([c3df818](https://github.com/klhq/skillmux/commit/c3df818724684eb479256358ef61f5c7751749cd))
* **skr-cli:** wire GET /stats, gated by server.auth_enabled ([7382f32](https://github.com/klhq/skillmux/commit/7382f32cdc557977d8eb020207a0ca173e13d057))
* **skr-cli:** wire skr init into the CLI ([c6bddc9](https://github.com/klhq/skillmux/commit/c6bddc9d6b4151f3322786a563954ed9d9b00a57))
* **skr-cli:** wire skr report --server/--db/--since CLI subcommand ([7d637d7](https://github.com/klhq/skillmux/commit/7d637d7e9148d6a80402124b0d093e7ebc1de3ee))
* **skr-cli:** wire skr sync into the CLI ([56e8deb](https://github.com/klhq/skillmux/commit/56e8deb37a70a7375df6c3dd07ed7f0b234f55f0))
* **skr-install:** add git-backed skill installer ([351bd10](https://github.com/klhq/skillmux/commit/351bd108d93111f108d182230d81dbdfccf26ef9))
* **skr-install:** clone a repo into a temp dir, clean up on failure ([2db0603](https://github.com/klhq/skillmux/commit/2db0603e5d41a2e3c4ec552ae48a01d07efe8e35))
* **skr-install:** copy skill into vault_path, guard against skill_id conflicts ([230c489](https://github.com/klhq/skillmux/commit/230c48922b6518fcef03a2eb7b107d347386b9d9))
* **skr-install:** resolve repo shorthand and git URLs to a clone source ([a799345](https://github.com/klhq/skillmux/commit/a79934588317abb496e481a4695dae8a56b5e755))
* **skr-install:** resolve target skill dir, list candidates when ambiguous ([c6b7635](https://github.com/klhq/skillmux/commit/c6b7635f503a6f265984016cdce8b6de7487d692))
* **skr-install:** validate SKILL.md and run skr scan rules before install ([a8de983](https://github.com/klhq/skillmux/commit/a8de98312b03dad6f0f9589300e972f46e934237))
* **skr-install:** wire skr install into the CLI ([0de3223](https://github.com/klhq/skillmux/commit/0de3223fb926e67e06b3771df2d9ffbd8868663b))
* **skr-scan:** --fail-on severity-gated exit code ([3a6789f](https://github.com/klhq/skillmux/commit/3a6789fe74f44503ef0d1f374100728a2a290619))
* **skr-scan:** add advisory skill security scanner ([8be8e88](https://github.com/klhq/skillmux/commit/8be8e887cb1c0dc5dfeb3860e8130c9ed99e75f3))
* **skr-scan:** rule-evaluation module with 4 v1 categories ([f98121c](https://github.com/klhq/skillmux/commit/f98121cac3ea5bae7e471380e9e645af14a44344))
* **skr-scan:** text and JSON renderers ([3aed4a9](https://github.com/klhq/skillmux/commit/3aed4a9b5a8f2db2ceac5d9bb000ea979be0be2a))
* **skr-scan:** vault/path enumeration for scan targets ([1784e8e](https://github.com/klhq/skillmux/commit/1784e8ecd388fb8f3d48c9444c9cf95ff21879c5))
* **skr-scan:** wire skr scan into the CLI ([0f7a616](https://github.com/klhq/skillmux/commit/0f7a6160529e59eae2ebc07a0505590e3bd49a88))


### Fixed

* **config:** require calibrated reranker thresholds ([42f1c8d](https://github.com/klhq/skillmux/commit/42f1c8d4945a53218a69321ebf7fa39139e42bb4))
* **contract:** distinguish exact retrieval ([09cb15c](https://github.com/klhq/skillmux/commit/09cb15c167689e3278454f5b29275fd5c721374e))
* **doctor:** vault check always reported failure regardless of state ([fd434bb](https://github.com/klhq/skillmux/commit/fd434bb7d579453632a4a017c506b0c3433f23f9))
* **health:** report absent reranker accurately ([26fcd28](https://github.com/klhq/skillmux/commit/26fcd281dbcfa2de12e1cec0aee39f3fa76f8f7f))
* **index:** invalidate vectors by model fingerprint ([4b69765](https://github.com/klhq/skillmux/commit/4b6976540339a662398f279e9b98bb0c0595d4db))
* **release:** align AMD64 and ARM64 naming ([5d3d56a](https://github.com/klhq/skillmux/commit/5d3d56a5dd51e7690b59272c04cd35f7e8e3054c))
* **release:** publish after all artifacts succeed ([7e737cb](https://github.com/klhq/skillmux/commit/7e737cb2d6185c675b1d0a53429ed3d1053dadf0))
* **release:** support private repository publishing ([#11](https://github.com/klhq/skillmux/issues/11)) ([a7ee045](https://github.com/klhq/skillmux/commit/a7ee0450d3d2401313adfd4f17ca9cd8d95763c2))
* **router-core:** add on-demand vault index sync ([8316bd4](https://github.com/klhq/skillmux/commit/8316bd44f10cb78b5cc4592ee3c44cd869b9ad0d))
* **router-core:** broaden ONNX device and dtype typing ([d1ff775](https://github.com/klhq/skillmux/commit/d1ff7754f38aaa6793f46e5d415d2b9a983306e4))
* **router-core:** make optional server config safe ([f113076](https://github.com/klhq/skillmux/commit/f11307650b506f5a1c60a65ec40300bda4014c5f))
* **router-core:** short-circuit exact skill matches ([ba84004](https://github.com/klhq/skillmux/commit/ba84004169c1153af52f2717b2287bc28cedded5))
* **server:** secure HTTP defaults — loopback bind, deny CORS, no XFF trust ([#18](https://github.com/klhq/skillmux/issues/18)) ([ecc5ecf](https://github.com/klhq/skillmux/commit/ecc5ecf227c50fcdd14a3871f9d9990e24f7d9d1))
* **server:** timing-safe HTTP auth token comparison ([#17](https://github.com/klhq/skillmux/issues/17)) ([ea601c8](https://github.com/klhq/skillmux/commit/ea601c89f1b209818f4b4f7a447eaa94bdf57923))
* **skillmux-rename:** regenerate lockfile, fix stale skr-era comments ([d059abc](https://github.com/klhq/skillmux/commit/d059abc8aca87b8e9e98deb85ffb775c4de010ae))
* **skr-cli:** copy rate-limit headers onto /stats responses for consistency ([b42d0c0](https://github.com/klhq/skillmux/commit/b42d0c03d3adfbf82581c9731992509b86820de4))
* **skr-cli:** guard resolveProjectPinDir against escaping the repo ([5a78828](https://github.com/klhq/skillmux/commit/5a78828f7308ccdc11497ffee26645abf2725880))
* **skr-cli:** satisfy noUncheckedIndexedAccess in init.test.ts ([97c578a](https://github.com/klhq/skillmux/commit/97c578aa47d9de2d5b2d76c9ef1cd89a706a28ba))
* **skr-cli:** usage messages and docs name the skr binary, not skill-router ([5d6490a](https://github.com/klhq/skillmux/commit/5d6490a8e28fd5b14ced4402249f789256c8e8a7))
* **skr-install:** exclude .git from the copy into the vault ([1c5be6c](https://github.com/klhq/skillmux/commit/1c5be6c6b8922bfcb32afbde2b9ae3432a65a1a1))
* **skr-scan:** flag unparseable SKILL.md instead of silently dropping it ([b55e2a7](https://github.com/klhq/skillmux/commit/b55e2a7e28cce1e4ecc43ef680bec1ef1b9e8335))
* **test:** isolate server lifecycle configuration ([257bb41](https://github.com/klhq/skillmux/commit/257bb4109a4fbb7d5f7a99e1449a758df4111977))


### Changed

* **cli:** validate serve options ([b344453](https://github.com/klhq/skillmux/commit/b34445372d51c053282755240301d5dc4a071853))
* **config:** validate normalized settings ([124d54b](https://github.com/klhq/skillmux/commit/124d54bba59e0a171f817c001eaf527cfb7dd76e))
* **core:** harden typed boundaries ([33be42f](https://github.com/klhq/skillmux/commit/33be42f18076cbf6b1ea4aa5097e448278c701ee))
* **core:** remove stale contract comments ([66f1025](https://github.com/klhq/skillmux/commit/66f1025a114ca35ff6559c89ba3a45fd192d8308))
* **eval:** validate query fixtures ([e57ce43](https://github.com/klhq/skillmux/commit/e57ce43eab7ec36906fe8c3d3b3bb34816a3070b))
* **http:** type rate limiter server boundary ([a710f8b](https://github.com/klhq/skillmux/commit/a710f8bc262dd734b234f80a4a36721759ab33b7))
* **models:** type embedding pipeline output ([c394e08](https://github.com/klhq/skillmux/commit/c394e08c85b5bb26aa97572f08c88f2c7b654a1b))

## [Unreleased]

## [0.1.1] - 2026-07-17

### Added
- GitHub Actions CI for tests, type checking, binary builds, schema validation, and slim container builds.
- Tag-driven GitHub releases with consistently named Linux AMD64/ARM64 binaries, checksums, multi-architecture GHCR images, SBOMs, and build provenance.
- Weekly Dependabot updates for Bun/npm dependencies and GitHub Actions.
- Separate liveness and readiness endpoints, readiness metrics, startup initialization, and graceful shutdown.
- HTTP rate limiting (token-bucket, per-token/IP, `429` + `Retry-After`/`X-RateLimit-*` headers) and request metrics.
- Model configuration overrides (`EMBED_MODEL`, `EMBED_DIMENSION`, `RERANK_MODEL`), a dynamic model downloader, and `/health` + `/metrics` (Prometheus) HTTP endpoints.
- On-demand vault index sync so a running server folds vault changes into the index without a restart.
- Exact skill-match short-circuiting in the recall path.
- Docker packaging: `slim` (model-free) and `latest` (battery-included ONNX models) image variants.
- Streamable HTTP transport alongside the original stdio transport.
- HTTP auth and CORS controls; device/dtype configuration for local ONNX inference.

### Fixed
- Skip unsupported GitHub artifact attestations while the repository is private and allow full/slim image builds to finish independently.
- Consolidated tag publishing into one GHCR release workflow, replacing the legacy Docker Hub-only workflow.
- Optional server config handling made safe for partially-specified `config.toml` files.
- ONNX device/dtype typing broadened to match `@huggingface/transformers`' accepted values.

## [0.1.0] - 2026-07-14

### Added
- Initial `router-core`: hybrid recall (SQLite FTS5/BM25 ∪ embedding cosine) with cross-encoder reranking, exposed via two MCP tools — `resolve_skill` and `fetch_skill`.
- Zero-loss delivery: `sha256(body)` verified against the file on disk at delivery time.
- Graceful fallback to lexical retrieval when embedding is unavailable.
- `skillmux eval` CLI command for recall@5 threshold calibration against a vault's holdout queries.
- Read-only vault guarantee and a SQLite-backed audit log of every `resolve_skill` call.

[Unreleased]: https://github.com/klhq/skillmux/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/klhq/skillmux/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/klhq/skillmux/releases/tag/v0.1.0
