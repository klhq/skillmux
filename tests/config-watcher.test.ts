import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
import { assertRemainsFalse, waitFor } from "./test-utils";


function baseToml(extraKLexical = 20): string {
  return `vault_path = "~/skills"
state_dir = "~/.local/state/skillmux"

[recall]
k_lexical = ${extraKLexical}
k_vector = 20

[output]
top_k = 10
max_top_k = 50

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

function remoteToml(endpoint: string, timeoutMs = 2000): string {
  return `vault_path = "~/skills"
state_dir = "~/.local/state/skillmux"

[recall]
k_lexical = 50
k_vector = 50
k_rerank = 50

[output]
top_k = 10
max_top_k = 50

[inference]
mode = "remote"
timeout_ms = ${timeoutMs}

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384

[inference.reranker]
adapter = "jina-v1"
endpoint = "${endpoint}"
model = "reranker"
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
  test("should tolerate an absent optional config directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-missing-dir-"));
    dirs.push(root);
    const tomlPath = join(root, "missing", "config.toml");

    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: () => {},
      onError: () => {},
    });
    expect(existsSync(join(root, "missing"))).toBeFalse();
    watcher.stop();
  });

  test("should safely keep reload disabled when its optional parent is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-late-config-"));
    dirs.push(root);
    const tomlPath = join(root, "missing", "config.toml");
    const received: Config[] = [];

    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    mkdirSync(join(root, "missing"));
    writeToml(tomlPath, baseToml(10));
    await assertRemainsFalse(() => received.length > 0);
    watcher.stop();

    expect(received).toEqual([]);
  });

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

  test("reloads embedding and reranker endpoints plus the shared timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-cw-reranker-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeToml(tomlPath, remoteToml("https://one.example.com/v1/rerank"));

    const received: Config[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (config) => received.push(config),
      onError: () => {},
    });

    writeToml(
      tomlPath,
      remoteToml("https://two.example.com/rerank", 3000).replace(
        "https://embed.example.com/v1/embeddings",
        "https://gateway.example.com/custom/embeddings?route=direct",
      ),
    );
    await waitFor(() => received.length > 0);
    const latest = received.at(-1)!;
    watcher.stop();

    expect(latest.inference.mode).toBe("remote");
    if (latest.inference.mode === "remote") {
      expect(latest.inference.timeout_ms).toBe(3000);
      expect(latest.inference.reranker?.endpoint).toBe(
        "https://two.example.com/rerank",
      );
      expect(latest.inference.embedding.endpoint).toBe(
        "https://gateway.example.com/custom/embeddings?route=direct",
      );
    }
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
    await assertRemainsFalse(() => received.length > countAfterStop, 400);

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
