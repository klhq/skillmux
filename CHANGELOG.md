# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.2](https://github.com/klhq/skillmux/compare/v1.11.1...v1.11.2) (2026-09-05)


### Added

* **target:** add built-in target migration ([#189](https://github.com/klhq/skillmux/issues/189)) ([fe85951](https://github.com/klhq/skillmux/commit/fe85951f1728907ce0faa9fe5df79677ea278973))
* **target:** add safe marker rehome workflow ([#187](https://github.com/klhq/skillmux/issues/187)) ([b8601aa](https://github.com/klhq/skillmux/commit/b8601aa9dc81d2c4a882c6d810d9922ba596e701))


### Chores

* **release:** force version 1.11.2 ([1ee9cbc](https://github.com/klhq/skillmux/commit/1ee9cbcfbfcbd9650f8e7f2d2dbbd54cdb0777ac))

## [1.11.1](https://github.com/klhq/skillmux/compare/v1.11.0...v1.11.1) (2026-09-03)


### Added

* **cli:** install asks before writing to the vault ([#185](https://github.com/klhq/skillmux/issues/185)) ([7f12d02](https://github.com/klhq/skillmux/commit/7f12d02def0f306d963d37920f2407c8cffe1c04))


### Fixed

* **cli:** reject full-vault agents on project attach, clarify agent vs target ([#184](https://github.com/klhq/skillmux/issues/184)) ([118aff5](https://github.com/klhq/skillmux/commit/118aff5f46fb9e83c8c0e068890b96fe0a02311d))
* **security:** gate install/update on scan findings, plus CLI help cleanup ([#182](https://github.com/klhq/skillmux/issues/182)) ([daffd8a](https://github.com/klhq/skillmux/commit/daffd8af89ebee1fbd4c05870c328baf747bbea3))

## [1.11.0](https://github.com/klhq/skillmux/compare/v1.10.0...v1.11.0) (2026-09-02)


### ⚠ BREAKING CHANGES

* **cli:** agent-based native setup — remove --target/--client vagueness, clearer rejections ([#172](https://github.com/klhq/skillmux/issues/172))

### Added

* **cli:** add --register-mcp to auto-register skillmux ([#173](https://github.com/klhq/skillmux/issues/173)) ([55e6e33](https://github.com/klhq/skillmux/commit/55e6e33a71abdfb2b340cdf2634f47db6a0fcff6))
* **cli:** agent-based native setup — remove --target/--client vagueness, clearer rejections ([#172](https://github.com/klhq/skillmux/issues/172)) ([cf5a346](https://github.com/klhq/skillmux/commit/cf5a346a3374ea217f7ffd17aba9495439b37f87))
* **cli:** project init --register-mcp for project-scoped MCP + instructions ([#176](https://github.com/klhq/skillmux/issues/176)) ([a1e5e3b](https://github.com/klhq/skillmux/commit/a1e5e3b43cd65b64741528e9cbaed0770d1637b7))


### Fixed

* **cli:** four consistency bugs found in a CLI audit ([#177](https://github.com/klhq/skillmux/issues/177)) ([a3aa008](https://github.com/klhq/skillmux/commit/a3aa0082b8d5dd6f36a0bf527bfaddb43075bb7d))
* **cli:** guided init prompts for vault path instead of guessing ([#175](https://github.com/klhq/skillmux/issues/175)) ([2fa224c](https://github.com/klhq/skillmux/commit/2fa224ce7887a19bc4bbb59b626926c13f3d7284))
* **cli:** reject config init cleanly for remote targets, add classification registry ([#170](https://github.com/klhq/skillmux/issues/170)) ([9e6da95](https://github.com/klhq/skillmux/commit/9e6da95a386230e03dc94e0c8cbaa6d622a4d3f5))


### Changed

* **cli:** consolidate per-agent data into one registry ([#179](https://github.com/klhq/skillmux/issues/179)) ([9af61da](https://github.com/klhq/skillmux/commit/9af61da4e181fc8c1ae5259cf7179d60050bf5b9))
* **cli:** one meaning per word — finish the target/context split ([#180](https://github.com/klhq/skillmux/issues/180)) ([1714daa](https://github.com/klhq/skillmux/commit/1714daa63a3429ffe6db090fc25a3e018026d85e))


### Chores

* pin next release to 1.11.0 ([#178](https://github.com/klhq/skillmux/issues/178)) ([0193952](https://github.com/klhq/skillmux/commit/01939522b550b40ee9bfa6981ea359d17bd55897))

## [1.10.0](https://github.com/klhq/skillmux/compare/v1.9.3...v1.10.0) (2026-09-01)


### Added

* **cli:** reject remote context for local-only commands ([#165](https://github.com/klhq/skillmux/issues/165)) ([934bb18](https://github.com/klhq/skillmux/commit/934bb18bce2b86dca8ac44cd8431ebdb53d12024))
* **cli:** remote admin parity for report, audit prune, eval, doctor ([#166](https://github.com/klhq/skillmux/issues/166)) ([615a396](https://github.com/klhq/skillmux/commit/615a396212d5c0e2df07712bf588c25e91e99773))


### Changed

* **cli:** align context terminology ([#163](https://github.com/klhq/skillmux/issues/163)) ([e942075](https://github.com/klhq/skillmux/commit/e94207584d10e16c17d6d2f5ca9c23bd8aa7846f))
* **server:** consolidate redactedErrorLog into logger.ts ([#169](https://github.com/klhq/skillmux/issues/169)) ([f7f29e4](https://github.com/klhq/skillmux/commit/f7f29e4ed6ea516e243d47d677e7ede207e47937))
* split db.ts, extract cli.ts commands, consolidate flag parsing ([#168](https://github.com/klhq/skillmux/issues/168)) ([28a798a](https://github.com/klhq/skillmux/commit/28a798abacfb830aff7a6510c6e892bb28009e5c))

## [1.9.3](https://github.com/klhq/skillmux/compare/v1.9.2...v1.9.3) (2026-08-31)


### Added

* **security:** add egress allowlist for install/update ([#160](https://github.com/klhq/skillmux/issues/160)) ([08779fd](https://github.com/klhq/skillmux/commit/08779fd67aacb941aa56025aecc05cf52e93e0c9))
* **security:** centralized secret redaction + tamper-evident admin audit trail ([#162](https://github.com/klhq/skillmux/issues/162)) ([f5335ec](https://github.com/klhq/skillmux/commit/f5335ecacf877d4e75821fe9d4be615718055814))
* **server:** remote report reporting via a stats-only port + authenticated --context ([#158](https://github.com/klhq/skillmux/issues/158)) ([aa19986](https://github.com/klhq/skillmux/commit/aa19986d43d5557d1ef5c6dd4ff53fca7fc9002a))
* **server:** runtime resource hardening — body/concurrency bounds and inference egress allowlist ([#161](https://github.com/klhq/skillmux/issues/161)) ([5e98765](https://github.com/klhq/skillmux/commit/5e9876581190aead64434c62f70e8d5e4010a9ad))


### Chores

* force release version to 1.9.3 ([97887fe](https://github.com/klhq/skillmux/commit/97887fe4931b183951dec6859333fb1497f6df91))

## [1.9.2](https://github.com/klhq/skillmux/compare/v1.9.1...v1.9.2) (2026-08-30)


### Fixed

* **install:** refuse a file:// source without --allow-local-source (SMX-92) ([#156](https://github.com/klhq/skillmux/issues/156)) ([b4ffb4a](https://github.com/klhq/skillmux/commit/b4ffb4abec90f900113bcd5806274b5d5692d23c))
* **server:** bound rate-limiter bucket map with LRU eviction (SMX-93) ([#155](https://github.com/klhq/skillmux/issues/155)) ([4dd1eb5](https://github.com/klhq/skillmux/commit/4dd1eb5a6d673f11f4ccd556fb4f189cf5fa828f))
* **server:** compare fixed-length hashes in safeTokenEquals (SMX-94) ([#157](https://github.com/klhq/skillmux/issues/157)) ([ae225c0](https://github.com/klhq/skillmux/commit/ae225c0db88952fedd4e66d4f373455774635900))
* **server:** refuse to bind a non-loopback host with auth disabled (SMX-91) ([#153](https://github.com/klhq/skillmux/issues/153)) ([2520408](https://github.com/klhq/skillmux/commit/252040867ed73ef1b82c6f97010842a9b399b498))

## [1.9.1](https://github.com/klhq/skillmux/compare/v1.9.0...v1.9.1) (2026-08-30)


### Fixed

* **install:** reject '.' / '..' skill ids derived during install (path traversal) ([#151](https://github.com/klhq/skillmux/issues/151)) ([2426613](https://github.com/klhq/skillmux/commit/2426613b79c67e2afa267de946492b6b020011bb))
* **install:** reject scp-like git URLs starting with '-' (argument injection RCE) ([#148](https://github.com/klhq/skillmux/issues/148)) ([6a9db28](https://github.com/klhq/skillmux/commit/6a9db28670201237dd17455592fa30cbce43b58f))
* **sync:** require approval before creating a new target directory ([#152](https://github.com/klhq/skillmux/issues/152)) ([6fcfd1a](https://github.com/klhq/skillmux/commit/6fcfd1a8beed87e5f88e2bd24b84a94a3adb3d89))
* **update:** validate skill-id against SKILL_ID_PATTERN before path-joining it ([#150](https://github.com/klhq/skillmux/issues/150)) ([0bfa807](https://github.com/klhq/skillmux/commit/0bfa8071a80ea4f70b2e6974cb2cb439666f8357))

## [1.9.0](https://github.com/klhq/skillmux/compare/v1.8.0...v1.9.0) (2026-08-30)


### Added

* track skill provenance and add outdated/update commands ([#133](https://github.com/klhq/skillmux/issues/133)) ([4d4f8c9](https://github.com/klhq/skillmux/commit/4d4f8c94a7e34e1ad030f9904995d02fa5fa2712))


### Fixed

* **install:** guard findSymlinks against a symlinked skill_path directory itself ([#146](https://github.com/klhq/skillmux/issues/146)) ([a264afc](https://github.com/klhq/skillmux/commit/a264afc19710206c4f77c61e3a9dccafb54c2894))
* **install:** prevent symlink smuggling in skill content ([#136](https://github.com/klhq/skillmux/issues/136)) ([2df318c](https://github.com/klhq/skillmux/commit/2df318cfdc974b0f7b9042c3d68fa4fece9109d9))
* **provenance:** refuse to hash a symlinked SKILL.md instead of following it ([#141](https://github.com/klhq/skillmux/issues/141)) ([74d1b9c](https://github.com/klhq/skillmux/commit/74d1b9c2f8fb2891ce743ccf09b9632fea58aa84))
* **provenance:** refuse to read a symlinked .skillmux-origin sidecar ([#144](https://github.com/klhq/skillmux/issues/144)) ([c9c0b32](https://github.com/klhq/skillmux/commit/c9c0b327f8cf26e1a9cd9971263cfa4f35235de3))
* **scan:** guard readTextFileOrNull against symlinks at every call site ([#143](https://github.com/klhq/skillmux/issues/143)) ([6692060](https://github.com/klhq/skillmux/commit/66920601bb4969911063407afa3dbffcf09c00be))
* **scan:** refuse to scan a symlinked SKILL.md in single-skill-dir mode ([#142](https://github.com/klhq/skillmux/issues/142)) ([b20cd66](https://github.com/klhq/skillmux/commit/b20cd6621a30067643034dd155383afab3540cf2))
* **security:** validate provenance sidecar values before they reach git subprocess calls ([#135](https://github.com/klhq/skillmux/issues/135)) ([01d643a](https://github.com/klhq/skillmux/commit/01d643a789e353d0d944b7b467f3c9f0894718ce))
* **sync:** skip symlinking core skill dirs with internal links ([#137](https://github.com/klhq/skillmux/issues/137)) ([f992b39](https://github.com/klhq/skillmux/commit/f992b39720dcdd3e946c6628817bd11b54380f40))
* **update:** skip file:// source_url in outdated/update by default ([#147](https://github.com/klhq/skillmux/issues/147)) ([9b127d0](https://github.com/klhq/skillmux/commit/9b127d0a65f89cfd32e6ed8d75155ba388349fae))
* **vault:** guard against a symlinked skill directory, not just its leaf files ([#145](https://github.com/klhq/skillmux/issues/145)) ([63d34e3](https://github.com/klhq/skillmux/commit/63d34e32bc4d91221f03fbbfdf22d3a0fdc7a492))
* **vault:** refuse to read a symlinked SKILL.md ([#140](https://github.com/klhq/skillmux/issues/140)) ([3220fe3](https://github.com/klhq/skillmux/commit/3220fe393a81922f76729284d156644662f177f2))
* **vault:** secure listSupportingFiles against symlinks and traversal ([#138](https://github.com/klhq/skillmux/issues/138)) ([6343a30](https://github.com/klhq/skillmux/commit/6343a30747844c5f83b810cbfe3d19ed569ca7cd))


### Changed

* **update:** skip cloning drifted skills before fetching ([1b247b6](https://github.com/klhq/skillmux/commit/1b247b6379b021692c839a77d44a81bd736f2bea))

## [1.8.0](https://github.com/klhq/skillmux/compare/v1.7.1...v1.8.0) (2026-08-28)


### Added

* **audit:** add fetch-outcome routing quality flywheel ([#131](https://github.com/klhq/skillmux/issues/131)) ([c55e5ec](https://github.com/klhq/skillmux/commit/c55e5ec794453ccbdbf7ffe9263684356d2a71de))

## [1.7.1](https://github.com/klhq/skillmux/compare/v1.7.0...v1.7.1) (2026-08-21)


### Changed

* **config:** neutralize migration error wording ([#128](https://github.com/klhq/skillmux/issues/128)) ([1fb130e](https://github.com/klhq/skillmux/commit/1fb130e3a6c3c3c084ca183c67ab7c8f984595a7))

## [1.7.0](https://github.com/klhq/skillmux/compare/v1.6.0...v1.7.0) (2026-08-21)


### Added

* **calibration:** remove obsolete threshold calibration ([#125](https://github.com/klhq/skillmux/issues/125)) ([1432948](https://github.com/klhq/skillmux/commit/143294848c333c35186d70742ef59c230dc850bb))
* **eval:** rank Skillmux 2.0 evaluation ([#124](https://github.com/klhq/skillmux/issues/124)) ([2fab68d](https://github.com/klhq/skillmux/commit/2fab68d73702913fea5a6e4d8f892c2802a65a88))
* **ranking:** ranked-only Skillmux 2.0 runtime contract ([#122](https://github.com/klhq/skillmux/issues/122)) ([00810df](https://github.com/klhq/skillmux/commit/00810df92b7de60289dad41fe1fcb5a982686493))


### Changed

* **audit:** remove legacy classifier outcomes ([#126](https://github.com/klhq/skillmux/issues/126)) ([953edc4](https://github.com/klhq/skillmux/commit/953edc40147fb2f87eec5a57d53d6fa022566b77))

## [1.6.0](https://github.com/klhq/skillmux/compare/v1.5.2...v1.6.0) (2026-08-18)


### Added

* **calibrate:** add tune safety buffers ([#120](https://github.com/klhq/skillmux/issues/120)) ([66d501c](https://github.com/klhq/skillmux/commit/66d501c4ac16956e8e887622e5178caef743bec7))

## [1.5.2](https://github.com/klhq/skillmux/compare/v1.5.1...v1.5.2) (2026-08-17)


### Changed

* **calibration:** parallelize resumable evaluations ([#115](https://github.com/klhq/skillmux/issues/115)) ([49b3fba](https://github.com/klhq/skillmux/commit/49b3fba43961aa7a6648eda89c5c08d994c7433a))
* **calibration:** report aggregate stage timings ([#119](https://github.com/klhq/skillmux/issues/119)) ([086128f](https://github.com/klhq/skillmux/commit/086128fdba8ded82ccf6a51d2e0117a18c2eea17))
* **calibration:** reuse synchronized retrieval snapshot ([#117](https://github.com/klhq/skillmux/issues/117)) ([1fcf295](https://github.com/klhq/skillmux/commit/1fcf2959123b4f9ca6841a2978a3fa5552c23122))
* **retrieval:** expose opt-in stage timings ([#118](https://github.com/klhq/skillmux/issues/118)) ([f459c90](https://github.com/klhq/skillmux/commit/f459c90f440834cea2ee008300bad3e15771949e))

## [1.5.1](https://github.com/klhq/skillmux/compare/v1.5.0...v1.5.1) (2026-08-17)


### Fixed

* **cli:** honor configured config path ([435298d](https://github.com/klhq/skillmux/commit/435298d1ec054c28d918d128bb4e3232f8d05a1f))

## [1.5.0](https://github.com/klhq/skillmux/compare/v1.4.1...v1.5.0) (2026-08-17)


### Added

* **config:** add configuration authority, bounded reranking, and degradation resilience ([2626709](https://github.com/klhq/skillmux/commit/262670983b2a7d3674dd02fa5ef90a4a3ebe26c6))
* **config:** add degradation-aware reranking controls ([1a87ee9](https://github.com/klhq/skillmux/commit/1a87ee90601dc632c127298ebb39be5e8bd12e66))
* **config:** add output.ambiguous_candidate_limit and evaluation report case details ([7194b28](https://github.com/klhq/skillmux/commit/7194b2874faeebfd89d047063369499ace06785d))


### Fixed

* **config:** satisfy effective config type checks ([b12693c](https://github.com/klhq/skillmux/commit/b12693ca1ba30d51351d8e5439822ff2f23350df))
* **routing:** align evaluation with runtime ranking ([ca6e6ca](https://github.com/klhq/skillmux/commit/ca6e6ca847a0604be190e63ac0a177e6e593e817))

## [1.4.1](https://github.com/klhq/skillmux/compare/v1.4.0...v1.4.1) (2026-08-04)


### Fixed

* **ci:** publish npm package to GitHub Packages ([#110](https://github.com/klhq/skillmux/issues/110)) ([5de37f2](https://github.com/klhq/skillmux/commit/5de37f22a658187cd270743b24237844513c1e54))

## [1.4.0](https://github.com/klhq/skillmux/compare/v1.3.4...v1.4.0) (2026-08-04)


### Added

* **cli:** add version flag ([a5ca750](https://github.com/klhq/skillmux/commit/a5ca7508b6818764eeeaff4000115ac91769d6c0))
* **cli:** clarify Docker command guidance ([3fc61b0](https://github.com/klhq/skillmux/commit/3fc61b0d262a20237f38df0a63eca2982aec382d))
* **cli:** guide unsupported container commands ([9857098](https://github.com/klhq/skillmux/commit/9857098f5ce1ae0436afc23cfec5aba7e0069d8c))
* **cli:** improve Docker command guidance ([cb1f4b7](https://github.com/klhq/skillmux/commit/cb1f4b707feca49cb7b6a627182bbbab889b8361))
* **cli:** show Docker-specific help ([b6a7495](https://github.com/klhq/skillmux/commit/b6a74955539aef6613781949df65ffd9c01aade7))
* **config:** show deployment identity in status ([40b355f](https://github.com/klhq/skillmux/commit/40b355fdea40e78b090faee87d349c364892d956))
* **docker:** label image variants ([d2db3f5](https://github.com/klhq/skillmux/commit/d2db3f53c16506af65dd89a39b2d05de8f4d905a))
* **doctor:** report deployment identity ([2db45d6](https://github.com/klhq/skillmux/commit/2db45d62da1be0985d2e8faa7abfa65c2a45f1c9))
* **doctor:** report healthy slim lexical retrieval ([9cac7e0](https://github.com/klhq/skillmux/commit/9cac7e0f603b07075daf202db19712c0400539a8))
* **doctor:** show retrieval capability ([5a344e7](https://github.com/klhq/skillmux/commit/5a344e71ebe65ba85353d28207ba3887432d3eff))
* **ops:** expose deployment identity in metrics ([81f761e](https://github.com/klhq/skillmux/commit/81f761e9ff735c512395b68479f33eb2c3db0352))
* **status:** expose deployment identity ([d83d22a](https://github.com/klhq/skillmux/commit/d83d22ad84beb39a993b0ade48ebee7e60d87145))
* **status:** expose remote deployment identity ([e7be736](https://github.com/klhq/skillmux/commit/e7be73656a833057d55146b09f8bfd6d6c3f6a60))


### Fixed

* pass configPath to getEffectiveConfig in PATCH /admin/v1/config handler ([f46b7e2](https://github.com/klhq/skillmux/commit/f46b7e2f97167d4c8bb02a56973d6e5325dd55a8))
* **startup:** allow serving without config paths ([ee98959](https://github.com/klhq/skillmux/commit/ee989596ed569d964eb37303b52b1538f62be39a))

## [1.3.4](https://github.com/klhq/skillmux/compare/v1.3.3...v1.3.4) (2026-08-02)


### Fixed

* **schema:** align published contract with server and guard GBNF bounds ([#104](https://github.com/klhq/skillmux/issues/104)) ([eb33613](https://github.com/klhq/skillmux/commit/eb336136a77c96fe5b660532dfbe191134e55ed3))

## [1.3.3](https://github.com/klhq/skillmux/compare/v1.3.2...v1.3.3) (2026-08-02)


### Fixed

* **server:** remove maxLength from resolve_skill schema to avoid GBNF overflow ([2621e73](https://github.com/klhq/skillmux/commit/2621e73bdb671d03ba8f458b7c3ceb223e8859c4))

## [1.3.2](https://github.com/klhq/skillmux/compare/v1.3.1...v1.3.2) (2026-07-31)


### Added

* **doctor:** flag uncalibrated or stale inference thresholds ([#99](https://github.com/klhq/skillmux/issues/99)) ([c8f684b](https://github.com/klhq/skillmux/commit/c8f684b6aedf6788def4cdc0fe49fff233569844))


### Chores

* pin next release to 1.3.2 instead of 1.4.0 (take 2) ([#102](https://github.com/klhq/skillmux/issues/102)) ([bbbb7dd](https://github.com/klhq/skillmux/commit/bbbb7dd838d691735e797f39de7d4277b95f5187))

## [1.3.1](https://github.com/klhq/skillmux/compare/v1.3.0...v1.3.1) (2026-07-31)


### Fixed

* **cli:** parse calibrate run flags correctly ([#97](https://github.com/klhq/skillmux/issues/97)) ([95d6b19](https://github.com/klhq/skillmux/commit/95d6b19272c34f7c8269cb354b7751f0fdd9ad75))

## [1.3.0](https://github.com/klhq/skillmux/compare/v1.2.0...v1.3.0) (2026-07-29)


### Added

* **docs:** clarify Skillmux use cases and deployment options ([#92](https://github.com/klhq/skillmux/issues/92)) ([c7faa09](https://github.com/klhq/skillmux/commit/c7faa0931b11180de7d2851d19cc96c3b04b930d))


### Fixed

* **packaging:** validate Docker deployment runtime ([#94](https://github.com/klhq/skillmux/issues/94)) ([a757b14](https://github.com/klhq/skillmux/commit/a757b14b925f0dd1c2875d4aae38464065066be8))

## [1.2.0](https://github.com/klhq/skillmux/compare/v1.1.0...v1.2.0) (2026-07-28)


### Added

* **calibration:** finish remote contract and docs ([f696da2](https://github.com/klhq/skillmux/commit/f696da25094c19537b1291f694114f8e4052ea69))
* **calibration:** improve dataset quality ([#88](https://github.com/klhq/skillmux/issues/88)) ([e99b764](https://github.com/klhq/skillmux/commit/e99b764ce90b7432fca0b01c22560ba73b401dd2))
* **calibration:** require labelled audit feedback ([16d9ec8](https://github.com/klhq/skillmux/commit/16d9ec81acbdca0e42a401b9e28f9e3814b3e0ab))
* **calibration:** require labelled audit feedback ([#89](https://github.com/klhq/skillmux/issues/89)) ([a7a99e2](https://github.com/klhq/skillmux/commit/a7a99e2d82e619255135b1e941c69c8d6653012c))

## [1.1.0](https://github.com/klhq/skillmux/compare/v1.0.1...v1.1.0) (2026-07-28)


### Added

* **calibration:** bind runs to reranker identity ([6ad547a](https://github.com/klhq/skillmux/commit/6ad547a97a6657521fd317d946ab941761fa18b3))
* **calibration:** certify selected policies ([#86](https://github.com/klhq/skillmux/issues/86)) ([2ced660](https://github.com/klhq/skillmux/commit/2ced660504b7d86dcad94e801944c4e5f2c2d8bd))
* **calibration:** finish optimizer floor sweep ([#87](https://github.com/klhq/skillmux/issues/87)) ([eed9bc3](https://github.com/klhq/skillmux/commit/eed9bc355f354aa23e6b85d157e9147484457052))
* **calibration:** honor candidate delivery limit ([#84](https://github.com/klhq/skillmux/issues/84)) ([797d144](https://github.com/klhq/skillmux/commit/797d1443fc0d7b179716f789663220449f5c93d4))
* **calibration:** make bootstrap reachable ([#85](https://github.com/klhq/skillmux/issues/85)) ([a572d47](https://github.com/klhq/skillmux/commit/a572d47f854e7a2be46504d069d21ccdb346d88c))
* **config:** reload reranker transport settings ([e15c7af](https://github.com/klhq/skillmux/commit/e15c7afa9dd591f7f838c5747e86d33670afefbf))
* **config:** require exact embedding endpoints ([3df7584](https://github.com/klhq/skillmux/commit/3df7584749cc3646713d1cb70e6901cc5aab37cc))
* harden remote embedding clients ([11b2852](https://github.com/klhq/skillmux/commit/11b2852f8c4bf29676da168c01804460570d3061))
* **inference:** add versioned reranker adapters ([40b85a0](https://github.com/klhq/skillmux/commit/40b85a0b4b9e9877c7eae54477f8a708737a8472))
* **inference:** add versioned reranker protocol adapters ([#81](https://github.com/klhq/skillmux/issues/81)) ([4e44685](https://github.com/klhq/skillmux/commit/4e446857ed906888034943d4a23877f183596c04))
* **inference:** harden embedding responses ([f850f8a](https://github.com/klhq/skillmux/commit/f850f8acfd4ab9c78e3b254346b9c2027027a04b))

## [Unreleased]

### ⚠ BREAKING CHANGES

* **inference:** reranker configuration now requires a versioned `adapter` and
  complete `endpoint`; the removed `provider`, `base_url`, and legacy reranker
  base-URL environment variables fail with migration guidance.
* **inference:** embedding configuration now requires an exact `endpoint`; the
  removed `base_url`, `EMBED_BASE_URL`, `SKILLMUX_EMBED_BASE_URL`, and
  `SKILL_ROUTER_EMBED_BASE_URL` inputs fail with migration guidance.

### Added

* **inference:** add `jina-v1` and `bifrost-v1` reranker wire-protocol adapters
  with strict indexed-score validation and independent optional Bearer auth.
* **inference:** validate remote and local embedding vectors before storage and
  classify embedding and reranker failures as configuration, availability, or
  protocol errors.

### Changed

* **doctor:** incomplete or malformed reranker responses now report degraded or
  unavailable instead of silently filling missing scores with zero.
* **config:** embedding endpoint, credential-name, and timeout changes reload
  live; model, dimension, device, and dtype changes require restart.

## [1.0.1](https://github.com/klhq/skillmux/compare/v1.0.0...v1.0.1) (2026-07-24)


### Changed

* **cli:** centralize output envelopes ([#77](https://github.com/klhq/skillmux/issues/77)) ([d457b6b](https://github.com/klhq/skillmux/commit/d457b6b24322efe0eda896ebb76cfd8dc9985819))
* **cli:** split command modules ([#75](https://github.com/klhq/skillmux/issues/75)) ([b1c2e8b](https://github.com/klhq/skillmux/commit/b1c2e8bf69e0a12c95960729eda581468c9c0646))
* **config:** extract TOML config-mutation module and share watcher test-utils ([#80](https://github.com/klhq/skillmux/issues/80)) ([d084bd6](https://github.com/klhq/skillmux/commit/d084bd6a56a5985dc92b7362171a0e62e9875926))

## [1.0.0](https://github.com/klhq/skillmux/compare/v0.6.0...v1.0.0) (2026-07-24)


### ⚠ BREAKING CHANGES

* **cli:** init's and target add's custom-directory flag is now --dir instead of --path (matches the manifest schema's own "dir" field on [targets.*] entries) - old --path is removed, no alias.
* **cli:** bare "skillmux which <skill_id>" is removed. Every other command follows a noun-verb shape (target list, project pin); "which" was the one bare-verb holdout. It's now "skillmux skill which <skill_id>", giving it a noun to sit under (room for future skill-level introspection subcommands). Running the bare form fails with a specific error naming the replacement, echoing back the argument the user typed so the suggested command is directly copy-pasteable.
* **cli:** skillmux manifest pin/unpin no longer exists. [core] pinning is now skillmux core pin/unpin (added in the prior commit); [project.*] pinning was already fully covered by skillmux project pin/unpin. Running skillmux manifest now fails with a specific error naming both replacements instead of falling through to a generic "unknown command" message.

### Added

* **cli:** add --json to scan, report, install, eval, models download ([456ab33](https://github.com/klhq/skillmux/commit/456ab330ed8b11d08a74bddf08a1827da4b18c19))
* **cli:** add core pin/unpin command ([c8b2387](https://github.com/klhq/skillmux/commit/c8b2387e01ac99a9e349cdf4ef2b57bb6f241820))
* **cli:** bring doctor and local-vault init onto the shared options contract ([2517571](https://github.com/klhq/skillmux/commit/25175719ae175bc8aa22d667a27a462b6286b33b))
* **cli:** remove manifest command in favor of core/project ([1a38b22](https://github.com/klhq/skillmux/commit/1a38b22e51c54e764c11ad5c8400a03537f01929))
* **cli:** rename --path to --dir on init/target add; disambiguate target vs context ([0aa704b](https://github.com/klhq/skillmux/commit/0aa704b584c377dbb4c67d87690aae6af9a78320))
* **cli:** rename which to skill which for noun-verb consistency ([dc5b75e](https://github.com/klhq/skillmux/commit/dc5b75ea3dddf9623e7b1a11bc3650fcf4804162))
* **completions:** generate bash/zsh/fish from one shared command list ([1431c36](https://github.com/klhq/skillmux/commit/1431c365a3e10071405f4c7d3e072da435018cf7))
* **doctor:** validate the manifest as part of skillmux doctor ([#67](https://github.com/klhq/skillmux/issues/67)) ([8749245](https://github.com/klhq/skillmux/commit/87492450b9af595c10e0f77c21f2371189b5b09f))
* **manifest:** bulk pin/unpin for manifest --core ([#66](https://github.com/klhq/skillmux/issues/66)) ([0ded6ea](https://github.com/klhq/skillmux/commit/0ded6ea7e58dfccd236582d433a32606f8ec9d36))
* **output:** add emitSuccess helper for consistent JSON-envelope output ([7e06551](https://github.com/klhq/skillmux/commit/7e06551a154fdb41452d047f470a89e74e81c570))
* **output:** add typed CliError for exit-code classification ([a88e4f9](https://github.com/klhq/skillmux/commit/a88e4f9e67b64717ab28a82bc829a84a615459d8))
* **server:** activate config watcher runtime ([#74](https://github.com/klhq/skillmux/issues/74)) ([ba575ae](https://github.com/klhq/skillmux/commit/ba575ae855514a0a816c39dd95e00a763fd7db9d))


### Fixed

* **cli:** core pin --dry-run --json and which-removal message edge cases ([082ca53](https://github.com/klhq/skillmux/commit/082ca53a811df680287b142da97de702a8a1d764))
* **config:** enforce live reload policy ([#73](https://github.com/klhq/skillmux/issues/73)) ([4382356](https://github.com/klhq/skillmux/commit/43823564ce24c19460be5f7e9bd4bb3535594d65))
* **output:** stop misclassifying exit codes by message-substring matching ([acd958f](https://github.com/klhq/skillmux/commit/acd958f127a307c3af1bc20964fce5d906f92485))


### Changed

* **cli:** consolidate command plumbing ([#72](https://github.com/klhq/skillmux/issues/72)) ([9fb3e5d](https://github.com/klhq/skillmux/commit/9fb3e5de1aa45790fbb3e1fb3f760e82fd28b027))
* **cli:** use emitSuccess instead of hand-rolled envelope printing ([ea4c3a5](https://github.com/klhq/skillmux/commit/ea4c3a5ebcf85fa041b7a279ae8ee27d9da8a1fa))


### Docs

* rewrite manifest pin, which, and --path references for the CLI consolidation ([0a81070](https://github.com/klhq/skillmux/commit/0a810705ba04e4bfef96a8098fb0b6c8def86230))

## [0.6.0](https://github.com/klhq/skillmux/compare/v0.5.0...v0.6.0) (2026-07-24)


### Added

* **cli:** add line-oriented selection prompts ([b8579a4](https://github.com/klhq/skillmux/commit/b8579a47513a722c76d8826b80ca08155f2229f6))
* **init:** add guided client and project setup ([c426502](https://github.com/klhq/skillmux/commit/c426502693755185a7d83f3c4b8c2b6b502bbb90))
* **init:** detect installed clients for setup ([0c529f3](https://github.com/klhq/skillmux/commit/0c529f310de8bc96d18ddb6b25174d375478d9fa))
* **init:** launch guided client setup in terminals ([9bd15ac](https://github.com/klhq/skillmux/commit/9bd15acfbad088732ad6d92927f0e16a2f57f44d))
* **project:** add direct project management commands ([132e8af](https://github.com/klhq/skillmux/commit/132e8af0124ee75163161df16af83dc774b773a8))
* **project:** add direct project management commands ([f36e2b3](https://github.com/klhq/skillmux/commit/f36e2b356f5f170c887734367cebb838acacc2e4))
* **project:** add project init command ([3cf8ecc](https://github.com/klhq/skillmux/commit/3cf8ecc94fb16f0f8ed807976e36935e09918a4e))
* **project:** harden project setup planning ([faff0e1](https://github.com/klhq/skillmux/commit/faff0e14a6d0a6268da3e01a33553efd9ede7d58))
* **project:** upsert project setup state ([7a92e03](https://github.com/klhq/skillmux/commit/7a92e03e281b517dff45d11eef5714d0512fd952))
* **setup:** guide machine and project choices ([2ef1010](https://github.com/klhq/skillmux/commit/2ef1010e8cb0d42b20a6f60980e7be0e28bf1e5f))
* **target:** add advanced target management commands ([bde2069](https://github.com/klhq/skillmux/commit/bde206981bcb93c0b1be317ef7f1c8d6f6ece34c))
* **target:** add advanced target management commands ([9e6a993](https://github.com/klhq/skillmux/commit/9e6a993643865b2134be05ba7306c671023f38ff))


### Fixed

* **cli:** keep guided init interactive and legacy-safe ([f6ae405](https://github.com/klhq/skillmux/commit/f6ae40564ed26b19ac464847b455d840d78daa93))
* **project:** validate guided project inputs ([0bed954](https://github.com/klhq/skillmux/commit/0bed9543897e83860038d83620a7c3638540ca95))
* **setup:** report client target prerequisites ([62fd8b8](https://github.com/klhq/skillmux/commit/62fd8b80444a37c8bcde403be95d8224b9776b0b))

## [0.5.0](https://github.com/klhq/skillmux/compare/v0.4.5...v0.5.0) (2026-07-24)


### Added

* **init:** add named client registry ([e14dc26](https://github.com/klhq/skillmux/commit/e14dc261c51f7235cd7ee2223f49a0ec87668922))
* **init:** add safe client-aware setup planner ([4a199b7](https://github.com/klhq/skillmux/commit/4a199b76c52819601a5935a7e6ac478aeddce5ca))
* **init:** add shared setup bootstrap planner ([83ef8de](https://github.com/klhq/skillmux/commit/83ef8de67a1ff8a13de992e26ad5eedb4487509c))
* **init:** add transactional setup planning ([6fc6f5e](https://github.com/klhq/skillmux/commit/6fc6f5e8d991a6b411c78016f5d0659486daf4d0))
* **init:** classify and preflight skill surfaces ([b760e93](https://github.com/klhq/skillmux/commit/b760e939a66b49372642109daff6e753d9b99b8b))
* **init:** harden target setup and host scoping ([8941f59](https://github.com/klhq/skillmux/commit/8941f598b52f73fe204c0705efb2b857b2f3c658))
* **init:** manage client instruction blocks ([256c7a7](https://github.com/klhq/skillmux/commit/256c7a7f690e14a0e4ea5340536d762dab853bcc))
* **init:** preflight and commit setup atomically ([9307780](https://github.com/klhq/skillmux/commit/93077809fca4949b1384213a7d8d444cd0da88eb))
* **sync:** scope manifest targets by host ([1441dea](https://github.com/klhq/skillmux/commit/1441deac95e70df9d97b798cb514f6e7722e24eb))
* **sync:** track ownership with versioned markers ([ad415b1](https://github.com/klhq/skillmux/commit/ad415b1a5cd8cf5351e6497c42640b624048d001))


### Fixed

* **init:** harden no-op plans and symlink checks ([137e050](https://github.com/klhq/skillmux/commit/137e05086e4f6b2d01cfdf6d5e8843f21bc1ae54))
* **init:** preserve existing setup on reinitialization ([0c1bea9](https://github.com/klhq/skillmux/commit/0c1bea92c1d600679663c853f15bcc5a246109ff))

## [0.4.5](https://github.com/klhq/skillmux/compare/v0.4.4...v0.4.5) (2026-07-24)


### Changed

* **manifest:** rename project group repos to paths ([51263f1](https://github.com/klhq/skillmux/commit/51263f175a45b6368509bb3c25ce8dcbeb07d127))

## [0.4.4](https://github.com/klhq/skillmux/compare/v0.4.3...v0.4.4) (2026-07-23)


### Fixed

* connect stdio transport before blocking on runtime init ([#54](https://github.com/klhq/skillmux/issues/54)) ([847af1c](https://github.com/klhq/skillmux/commit/847af1c39265937701e432b631710fc0a2aa9ea0))

## [0.4.3](https://github.com/klhq/skillmux/compare/v0.4.2...v0.4.3) (2026-07-23)


### Fixed

* **release:** prevent slim from overwriting latest ([#53](https://github.com/klhq/skillmux/issues/53)) ([8b5da28](https://github.com/klhq/skillmux/commit/8b5da285b5cb2c9b3231e94ed1ec29331cf8cb9a))
* **release:** safe backfill and isolate publishing ([#51](https://github.com/klhq/skillmux/issues/51)) ([872333a](https://github.com/klhq/skillmux/commit/872333a70f32bf5be68cc3599c43bd4943a91051))

## [0.4.2](https://github.com/klhq/skillmux/compare/v0.4.1...v0.4.2) (2026-07-23)


### Fixed

* **release:** validate explicit release tag ([#46](https://github.com/klhq/skillmux/issues/46)) ([ec11057](https://github.com/klhq/skillmux/commit/ec11057d18162ace7944b1ee07bd0fb1f282efcc))

## [0.4.1](https://github.com/klhq/skillmux/compare/v0.4.0...v0.4.1) (2026-07-22)


### Fixed

* **release:** publish immediately from release please ([#44](https://github.com/klhq/skillmux/issues/44)) ([4569cf3](https://github.com/klhq/skillmux/commit/4569cf3eed7ded5d4cb032f622a6a92e3eb28b21))

## [0.4.0](https://github.com/klhq/skillmux/compare/v0.3.0...v0.4.0) (2026-07-22)


### Added

* **cli:** add 'skillmux local-vault init &lt;path&gt;' to write the local_vault marker ([7648145](https://github.com/klhq/skillmux/commit/76481452994f98d6ef01fb1302344fc76a547492))
* **cli:** add 'skillmux which &lt;skill_id&gt;' to show which root resolves a skill ([0dfd0ed](https://github.com/klhq/skillmux/commit/0dfd0ed9e067f12dfce6cd9a3bc5fe61eeedf4d8))
* **cli:** add skill visibility command ([a00d248](https://github.com/klhq/skillmux/commit/a00d24811b3b91e947a529fe87f742acf6cb4ce7))
* **cli:** filter [project.*] groups by each target's project_groups ([e039920](https://github.com/klhq/skillmux/commit/e039920349769e65d01555a5681a4b1724fddf88))
* **completions:** list 'which' in bash and zsh command completions ([fc8151f](https://github.com/klhq/skillmux/commit/fc8151fc83a0e57b2eb57decdf78d716cdf7a8fa))
* **config:** add local_vault_paths alongside the unchanged vault_path ([4d8c95e](https://github.com/klhq/skillmux/commit/4d8c95e600a6607e8e83b9fb5a6344677003d3c3))
* **doctor:** report local_vault_paths marker presence and vault_path drift ([eb8e8a3](https://github.com/klhq/skillmux/commit/eb8e8a304847c366f2ba057e1d9b9741516e75c2))
* **doctor:** report shadowed skills across vault_path and local_vault_paths ([eac168d](https://github.com/klhq/skillmux/commit/eac168d3c729d7a610632c73fa573ad4947964d9))
* **manifest:** add pin/unpin --core to skillmux manifest CLI ([59a4ceb](https://github.com/klhq/skillmux/commit/59a4ceb8a25867c4bc73932294aae6a8a1f9edd8))
* **manifest:** add pin/unpin --project &lt;group&gt; --repo to skillmux manifest CLI ([3bf98e9](https://github.com/klhq/skillmux/commit/3bf98e983bd05b35d15b25f4effd1fb33cf03b8f))
* **manifest:** add pin/unpin and local-vault markers ([f1329ae](https://github.com/klhq/skillmux/commit/f1329ae48b1c7603201f039b80ac2b8489101cf8))
* **manifest:** add the AC6 portability guard to validateManifest ([fb83299](https://github.com/klhq/skillmux/commit/fb8329969228029d7d9561884a1f0f0df3aa7a77))
* **manifest:** project_groups + local_vault_paths overlay support ([#40](https://github.com/klhq/skillmux/issues/40)) ([411ecfb](https://github.com/klhq/skillmux/commit/411ecfb243695465aea44dc4a9192190ecde6086))
* **manifest:** replace targets.*.project boolean with project_groups ([ccd246e](https://github.com/klhq/skillmux/commit/ccd246e8238c00eebac6abfde4d4250f87d770db))
* **sync:** add role field to SkillmuxMarker with read-compat for absent role ([79af610](https://github.com/klhq/skillmux/commit/79af610c4fd598e458a947eb01f7c01358f38402))
* **vault:** add findShadowedSkills to surface cross-root skill_id collisions ([7d1a328](https://github.com/klhq/skillmux/commit/7d1a3287ea47044e39371d38a360c3acc3d2f2c0))
* **vault:** resolve skills through local_vault_paths before vault_path ([0c1f603](https://github.com/klhq/skillmux/commit/0c1f60328b30681dd739224a5a53cdb178413a18))


### Fixed

* **manifest:** reject invalid [project.*] group names in pinProject before writing ([153d0ac](https://github.com/klhq/skillmux/commit/153d0ac39a548ca47aafb0ddd309cbb4da63fda8))
* **router-core:** tolerate broken content when a root wins on existence alone ([6cb4d0d](https://github.com/klhq/skillmux/commit/6cb4d0d64bd0dd98d7fd44ac382ea2e9e3f2e125))

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
