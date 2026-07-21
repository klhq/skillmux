import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigWatcher } from "../src/config-watcher";
import {
  insertCalibrationRun,
  openCalibrateDb,
  applyCalibrationRun,
  type CalibrationRunRecord,
} from "../src/calibrate";
import { RuntimeSnapshotManager } from "../src/snapshot";
import { loadConfig } from "../src/config";
import type { Config } from "../src/types";
import type { Clients } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SETTLE_MS = 700; // debounce + stable-stat settle

function baseToml(matchScore = 0.80): string {
  return `vault_path = "~/skills"
state_dir = "~/.local/state/skillmux"

[recall]
k_lexical = 20
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

const fakeClients: Clients = {
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
};

function makeConfig(root: string): Config {
  return {
    vault_path: join(root, "vault"),
    state_dir: join(root, "state"),
    recall: { k_lexical: 20, k_vector: 20 },
    thresholds: { candidate_limit: 5 },
    inference: {
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: join(root, "models"),
      embedding: { model: "Xenova/gte-small", dimension: 3 },
    },
  };
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E2E: calibrate run → apply → watcher reloads → snapshot swaps
// ---------------------------------------------------------------------------

describe("calibration-tuning end-to-end", () => {
  test("bootstrap without thresholds — config loads without error in local mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-e2e-boot-"));
    dirs.push(root);
    mkdirSync(join(root, "state"), { recursive: true });

    const tomlPath = join(root, "config.toml");
    await Bun.write(tomlPath, baseToml());

    // Local mode config has no inference.thresholds — should parse cleanly
    const config = await loadConfig(tomlPath);
    expect(config.inference.mode).toBe("local");
    expect("thresholds" in config.inference).toBe(false);
  });

  test("applyCalibrationRun writes thresholds to TOML, then ConfigWatcher delivers new config via onReload", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-e2e-apply-watch-"));
    dirs.push(root);
    mkdirSync(join(root, "state"), { recursive: true });

    // Start with a remote-mode config (thresholds are only valid there)
    const remoteToml = `vault_path = "~/skills"

[inference]
mode = "remote"
timeout_ms = 5000

[inference.embedding]
provider = "openai"
base_url = "https://embed.example.com"
model = "embed-model"
dimension = 1024

[inference.reranker]
provider = "infinity"
base_url = "https://rerank.example.com"
model = "rerank-model"

[inference.thresholds]
match_score = 0.80
match_margin = 0.20
candidate_floor = 0.40
`;
    const tomlPath = join(root, "config.toml");
    await Bun.write(tomlPath, remoteToml);

    // Set up calibration DB
    const calDb = openCalibrateDb(join(root, "state"));
    const runRecord: CalibrationRunRecord = {
      run_id: "run-e2e-001",
      created_at: new Date().toISOString(),
      status: "completed",
      reranker_fingerprint: "reranker@sha256:aabbcc",
      embedding_fingerprint: "embed@sha256:112233",
      corpus_fingerprint: "vault@sha256:feedface",
      dataset_hash: "dataset@sha256:abcdef",
      min_auto_match_precision: 0.99,
      min_shortlist_recall_at_5: 0.95,
      selected_thresholds: { match_score: 0.92, match_margin: 0.18, candidate_floor: 0.45 },
      tune_metrics: {
        auto_match_precision: 1.0,
        auto_match_coverage: 0.85,
        shortlist_recall_at_5: 1.0,
        false_no_match_rate: 0.0,
      },
      test_metrics: {
        auto_match_precision: 0.97,
        auto_match_coverage: 0.80,
        shortlist_recall_at_5: 0.99,
        false_no_match_rate: 0.03,
        confusion_matrix: {
          matched: { matched: 8, ambiguous: 0, no_match: 0 },
          ambiguous: { matched: 0, ambiguous: 2, no_match: 0 },
          no_match: { matched: 0, ambiguous: 0, no_match: 2 },
        },
      },
      observations: [],
    };
    insertCalibrationRun(calDb, runRecord);

    // Set up watcher to capture reloads
    const reloadedConfigs: Config[] = [];
    const errors: unknown[] = [];
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (cfg) => reloadedConfigs.push(cfg),
      onError: (err) => errors.push(err),
    });

    // Apply calibration run → atomically writes thresholds to TOML
    await applyCalibrationRun(calDb, "run-e2e-001", tomlPath, {});

    // Wait for the watcher to detect the change and reload
    await Bun.sleep(SETTLE_MS);
    expect(errors).toHaveLength(0);
    expect(reloadedConfigs.length).toBeGreaterThanOrEqual(1);
    const reloaded = reloadedConfigs.at(-1)!;
    expect(reloaded.inference.mode).toBe("remote");
    if (reloaded.inference.mode === "remote" && reloaded.inference.thresholds) {
      expect(reloaded.inference.thresholds.match_score).toBeCloseTo(0.92);
      expect(reloaded.inference.thresholds.match_margin).toBeCloseTo(0.18);
      expect(reloaded.inference.thresholds.candidate_floor).toBeCloseTo(0.45);
    }
  });

  test("new config from watcher can be fed into RuntimeSnapshotManager.replace — concurrent requests see coherent state", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-e2e-snap-"));
    dirs.push(root);
    mkdirSync(join(root, "vault"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });

    const config1 = makeConfig(root);
    const config2 = { ...makeConfig(root), recall: { k_lexical: 50, k_vector: 50 } };

    const manager = RuntimeSnapshotManager.create(config1, fakeClients);

    // Simulate 10 concurrent in-flight requests that hold the snapshot for a brief duration
    const seenKLexical = new Set<number>();
    const promises = Array.from({ length: 10 }, async (_, i) => {
      const { snapshot, release } = manager.acquire();
      seenKLexical.add(snapshot.config.recall.k_lexical);
      await Bun.sleep(i * 5);
      release();
    });

    // Replace snapshot mid-flight (simulates watcher delivering new config)
    await Bun.sleep(20);
    manager.replace(config2, fakeClients);

    await Promise.all(promises);
    manager.dispose();

    // Every request saw a coherent k_lexical value — only 20 or 50
    for (const kl of seenKLexical) {
      expect(kl === 20 || kl === 50).toBe(true);
    }
  });

  test("watcher + manager full loop: watcher triggers manager.replace atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-e2e-loop-"));
    dirs.push(root);
    mkdirSync(join(root, "vault"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });

    const tomlPath = join(root, "config.toml");
    // Write initial local-mode config
    await Bun.write(tomlPath, `vault_path = "${join(root, "vault")}"
state_dir = "${join(root, "state")}"

[recall]
k_lexical = 20
k_vector = 20

[thresholds]
candidate_limit = 5

[inference]
mode = "local"
bundle = "gte-small-v1"
models_dir = "${join(root, "models")}"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 3
`);

    const initialConfig = await loadConfig(tomlPath);
    const manager = RuntimeSnapshotManager.create(initialConfig, fakeClients);

    // Wire watcher to call manager.replace on each successful reload
    const watcher = await ConfigWatcher.start(tomlPath, {
      onReload: (cfg) => manager.replace(cfg, fakeClients),
      onError: () => {},
    });

    // Verify initial snapshot
    const { snapshot: snap1, release: r1 } = manager.acquire();
    expect(snap1.config.recall.k_lexical).toBe(20);
    r1();

    // Write updated config
    await Bun.write(tomlPath, `vault_path = "${join(root, "vault")}"
state_dir = "${join(root, "state")}"

[recall]
k_lexical = 77
k_vector = 77

[thresholds]
candidate_limit = 5

[inference]
mode = "local"
bundle = "gte-small-v1"
models_dir = "${join(root, "models")}"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 3
`);
    await Bun.sleep(SETTLE_MS);

    // New snapshot should reflect the updated config
    const { snapshot: snap2, release: r2 } = manager.acquire();
    const kl = snap2.config.recall.k_lexical;
    r2();

    watcher.stop();
    manager.dispose();

    expect(kl).toBe(77);
  });
});
