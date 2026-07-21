import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeSnapshotManager,
  type RuntimeSnapshot,
} from "../src/snapshot";
import type { Config } from "../src/types";
import type { Clients } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const fakeClients: Clients = {
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
};

// ---------------------------------------------------------------------------
// AC11 — Immutable runtime snapshot with reference counting
// ---------------------------------------------------------------------------

describe("RuntimeSnapshotManager", () => {
  let root: string;
  let manager: RuntimeSnapshotManager;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "skillmux-snapshot-"));
    mkdirSync(join(root, "vault", "skill-a"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "vault", "skill-a", "SKILL.md"),
      "---\nname: skill-a\ndescription: Skill A description.\n---\nbody",
    );
  });

  afterEach(() => {
    manager?.dispose();
  });

  function makeManager(): RuntimeSnapshotManager {
    const config = makeConfig(root);
    manager = RuntimeSnapshotManager.create(config, fakeClients);
    return manager;
  }

  test("should acquire a snapshot that exposes config and clients", () => {
    const m = makeManager();
    const { snapshot, release } = m.acquire();
    expect(snapshot.config).toBeDefined();
    expect(snapshot.clients).toBeDefined();
    expect(snapshot.db).toBeDefined();
    release();
  });

  test("snapshot config should be immutable (frozen)", () => {
    const m = makeManager();
    const { snapshot, release } = m.acquire();
    expect(Object.isFrozen(snapshot)).toBe(true);
    release();
  });

  test("concurrent acquirers should all see the same snapshot instance", () => {
    const m = makeManager();
    const a = m.acquire();
    const b = m.acquire();
    const c = m.acquire();
    expect(a.snapshot).toBe(b.snapshot);
    expect(b.snapshot).toBe(c.snapshot);
    a.release();
    b.release();
    c.release();
  });

  test("db handle should remain open while any holder holds a reference", () => {
    const m = makeManager();
    const a = m.acquire();
    const b = m.acquire();

    // Replace the snapshot with a new one
    const newConfig = { ...makeConfig(root), recall: { k_lexical: 10, k_vector: 10 } };
    m.replace(newConfig, fakeClients);

    // Old holders still have old snapshot — db must still be open
    expect(() => a.snapshot.db.query("SELECT 1").get()).not.toThrow();

    a.release();
    // b still holds — db still open
    expect(() => b.snapshot.db.query("SELECT 1").get()).not.toThrow();

    b.release();
    // All released — db should now be closed; any further query should throw
    expect(() => a.snapshot.db.query("SELECT 1").get()).toThrow();
  });

  test("new acquirers after replace should see the new snapshot", () => {
    const m = makeManager();
    const old = m.acquire();

    const newConfig = { ...makeConfig(root), recall: { k_lexical: 10, k_vector: 10 } };
    m.replace(newConfig, fakeClients);

    const fresh = m.acquire();
    expect(fresh.snapshot).not.toBe(old.snapshot);
    expect(fresh.snapshot.config.recall.k_lexical).toBe(10);

    old.release();
    fresh.release();
  });

  test("release is idempotent — calling it twice does not throw", () => {
    const m = makeManager();
    const { release } = m.acquire();
    release();
    expect(() => release()).not.toThrow();
  });

  test("db closes after retire + all holders release — not before retire", () => {
    const m = makeManager();
    const { snapshot, release } = m.acquire();
    // Release the only holder — slot is still current (not retired), so db stays open
    release();
    expect(() => snapshot.db.query("SELECT 1").get()).not.toThrow();

    // Replace (retires the old slot with refCount=0) → db should close immediately
    m.replace(makeConfig(root), fakeClients);
    expect(() => snapshot.db.query("SELECT 1").get()).toThrow();
  });

  test("dispose closes the current snapshot db even if no holders", () => {
    const m = makeManager();
    const { snapshot, release } = m.acquire();
    release();
    m.dispose();
    expect(() => snapshot.db.query("SELECT 1").get()).toThrow();
  });

  test("concurrent requests observe either complete old or complete new snapshot — never partial", async () => {
    const m = makeManager();

    // Simulate 5 concurrent requests that hold the snapshot briefly
    const results: RuntimeSnapshot[] = [];
    const promises = Array.from({ length: 5 }, async (_, i) => {
      const { snapshot, release } = m.acquire();
      results.push(snapshot);
      await Bun.sleep(i * 2); // stagger slightly
      release();
    });

    // Replace snapshot mid-flight (after first set of acquirers but before all finish)
    await Bun.sleep(3);
    const newConfig = { ...makeConfig(root), recall: { k_lexical: 99, k_vector: 99 } };
    m.replace(newConfig, fakeClients);

    await Promise.all(promises);

    // Every snapshot in results must be either old (k_lexical=20) or new (k_lexical=99)
    // — never a mix of fields from both
    for (const s of results) {
      const kl = s.config.recall.k_lexical;
      expect(kl === 20 || kl === 99).toBe(true);
    }
  });
});
