import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigWatcher, type ReloadStatus } from "../src/config-watcher";
import type { Config } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WATCHER_SETTLE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 25;

async function waitFor(
  condition: () => boolean,
  timeoutMs = WATCHER_SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function baseToml(extraKLexical = 20): string {
  return `vault_path = "~/skills"
state_dir = "~/.local/state/skillmux"

[recall]
k_lexical = ${extraKLexical}
k_vector = 20

[thresholds]
candidate_limit = 5

[inference]
mode = "local"
bundle = "gte-small-v1"
models_dir = "~/.cache/skillmux/models"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 384
device = "cpu"
dtype = "q8"
`;
}

function writeToml(path: string, content: string): void {
  // Atomic write: write to tmp then rename (simulates what calibrate apply does)
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC8 — Transactional live reload (parent-dir watching, debounce, stable read)
// AC9 — Live-reload allowlist
// AC10 — Last-known-good behavior
// ---------------------------------------------------------------------------

describe("ConfigWatcher", () => {
  test("should call onReload with new config when an allowlisted key changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const received: Config[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    writeToml(tomlPath, baseToml(10));
    await waitFor(() => received.length > 0);
    watcher.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.at(-1)!.recall.k_lexical).toBe(10);
  });

  test("should report restart-required keys without reloading for disallowed changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-restart-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const received: Config[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    writeToml(
      tomlPath,
      baseToml(20).replace("Xenova/gte-small", "Xenova/other-model"),
    );
    await waitFor(
      () => watcher.reloadStatus().restart_required_keys.length > 0,
    );
    const status = watcher.reloadStatus();
    watcher.stop();

    expect(received).toHaveLength(0);
    expect(status.restart_required_keys).toEqual(["inference.embedding.model"]);
  });

  test("should detect changes made via atomic rename (rename-based saves)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-rename-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const received: Config[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    // Simulate atomic save: write to a sibling and rename into place
    const tmpToml = join(root, "config.toml.tmp");
    writeFileSync(tmpToml, baseToml(30));
    renameSync(tmpToml, tomlPath);
    await waitFor(() => received.length > 0);
    watcher.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.at(-1)!.recall.k_lexical).toBe(30);
  });

  test("should NOT crash on invalid TOML — last-known-good remains active", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-bad-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const errors: unknown[] = [];
    let goodReloads = 0;
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: () => {
        goodReloads++;
      },
      onError: (err) => errors.push(err),
    });

    // Write invalid TOML
    writeToml(tomlPath, "this is [not valid toml = {{{");
    await waitFor(() => errors.length > 0);
    watcher.stop();

    // Should have called onError, not crashed, not called onReload
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(goodReloads).toBe(0);
  });

  test("stop() cleans up the watcher and no further callbacks fire", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-stop-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const received: Config[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    watcher.stop();
    const countAfterStop = received.length;

    // Write after stop — should not fire
    writeToml(tomlPath, baseToml(5));
    await Bun.sleep(500);

    expect(received.length).toBe(countAfterStop);
  });

  test("stop() is idempotent — calling twice does not throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-idem-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: () => {},
      onError: () => {},
    });
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });

  test("reloadStatus should reflect the current watcher state", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-status-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    let lastStatus: ReloadStatus | undefined;
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: () => {},
      onError: () => {},
    });

    // Write a valid config — should reload successfully
    writeToml(tomlPath, baseToml(15));
    await waitFor(
      () => watcher.reloadStatus().last_successful_reload_at !== null,
    );
    lastStatus = watcher.reloadStatus();
    watcher.stop();

    expect(lastStatus).toBeDefined();
    expect(lastStatus!.last_successful_reload_at).toBeDefined();
    expect(lastStatus!.last_reload_error).toBeNull();
  });

  test("reloadStatus should record last_reload_error on bad TOML without losing last_successful_reload_at", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-err-status-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, baseToml(20));

    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: () => {},
      onError: () => {},
    });

    // First: write a valid config to establish last_successful_reload_at
    writeToml(tomlPath, baseToml(15));
    await waitFor(
      () => watcher.reloadStatus().last_successful_reload_at !== null,
    );
    const statusAfterGood = watcher.reloadStatus();

    // Then: write bad TOML
    writeToml(tomlPath, "[[[[bad toml");
    await waitFor(() => watcher.reloadStatus().last_reload_error !== null);
    const statusAfterBad = watcher.reloadStatus();
    watcher.stop();

    // last_successful_reload_at preserved from the good reload
    expect(statusAfterBad.last_successful_reload_at).toBe(
      statusAfterGood.last_successful_reload_at,
    );
    expect(statusAfterBad.last_reload_error).not.toBeNull();
  });
});
