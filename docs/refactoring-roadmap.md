# Refactoring Roadmap

This document tracks the next maintainability and runtime-safety improvements after the CLI consolidation and ConfigWatcher policy work.

## 1. Activate ConfigWatcher in the server runtime

**Priority: high**

`ConfigWatcher` now classifies live-reloadable and restart-required configuration changes, but it is not yet started by the production server.

- [ ] Start `ConfigWatcher` from the server lifecycle.
- [ ] On allowlisted changes, construct any required clients and replace the active `RuntimeSnapshotManager` snapshot.
- [ ] Keep the last-known-good snapshot active when a change requires restart or config parsing fails.
- [ ] Stop the watcher during server shutdown.
- [ ] Expose watcher state through config status:
  - `last_successful_reload_at`
  - `last_reload_error`
  - `restart_required_keys`
- [ ] Add server-level integration coverage for live changes, restart-required changes, invalid config, and shutdown cleanup.

## 2. Split the CLI into command modules

**Priority: medium**

`src/cli.ts` still owns global argument parsing, dispatch, and several large command implementations.

- [ ] Keep global flag parsing, target resolution, error handling, and top-level dispatch in `src/cli.ts`.
- [ ] Extract project commands into `src/commands/project.ts`.
- [ ] Extract target commands into `src/commands/target.ts`.
- [ ] Extract core commands into `src/commands/core.ts`.
- [ ] Extract config commands into `src/commands/config.ts`.
- [ ] Preserve existing JSON and text output contracts with focused CLI tests for each extraction.

## 3. Centralize remaining CLI output contracts

**Priority: medium**

The shared output helpers cover several commands, but some project, target, and local-vault paths still build JSON output directly.

- [x] Route remaining success responses through a common schema-versioned output helper where their contracts permit it.
- [x] Keep command-specific plan/result envelopes explicit and covered by integration tests.
- [x] Verify text-mode output remains human-readable and stable.

## 4. Isolate calibration configuration mutation

**Priority: medium**

Calibration currently performs surgical TOML section replacement in `src/calibrate.ts`.

- [ ] Move TOML patching into a dedicated config-mutation module.
- [ ] Preserve unrelated section ordering and comments where practical.
- [ ] Add edge-case coverage for missing, repeated, and adjacent TOML sections.
- [ ] Keep the atomic temp-file-and-rename write guarantee.

## 5. Improve watcher test ergonomics

**Priority: low**

Watcher tests now use bounded condition waits for reload events; continue reducing timing assumptions as lifecycle integration is added.

- [ ] Share test polling helpers where multiple watcher suites need them.
- [ ] Prefer observable callbacks and runtime state over fixed-duration sleeps.
- [ ] Keep one bounded wait for assertions that no callback fires after shutdown.
