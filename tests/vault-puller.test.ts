import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, createRemote, tempDir } from "./git-remote-fixture";
import { startVaultPuller, type VaultPullerOptions } from "../src/vault-puller";

afterEach(() => {
  cleanupTempDirs();
});

function harness(overrides: Partial<VaultPullerOptions> & Pick<VaultPullerOptions, "vaultPath" | "vaultUrl">) {
  const events: string[] = [];
  const warnings: string[] = [];
  const puller = startVaultPuller({
    intervalMs: 3_600_000,
    pauseWatcher: () => {
      events.push("pause");
      return () => events.push("resume");
    },
    resync: async () => {
      events.push("resync");
    },
    onResult: (status) => events.push(`result:${status}`),
    warn: (message) => warnings.push(message),
    ...overrides,
  });
  return { puller, events, warnings };
}

describe("startVaultPuller", () => {
  test("clones a missing checkout and resyncs the index once", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events } = harness({ vaultPath, vaultUrl: remote.url });

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("cloned");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("one\n");
    expect(events).toEqual(["pause", "resync", "resume", "result:cloned"]);
  });

  test("holds the watcher paused for the whole update and resyncs before resuming", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events } = harness({ vaultPath, vaultUrl: remote.url });
    await puller.pullNow();
    events.length = 0;
    remote.publish("second.txt", "two\n");

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("updated");
    expect(events).toEqual(["pause", "resync", "resume", "result:updated"]);
  });

  test("an up-to-date pull does not reindex", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events } = harness({ vaultPath, vaultUrl: remote.url });
    await puller.pullNow();
    events.length = 0;

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("up-to-date");
    expect(events).toEqual(["pause", "resume", "result:up-to-date"]);
  });

  test("a dirty checkout warns, keeps the current content and never throws", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events, warnings } = harness({ vaultPath, vaultUrl: remote.url });
    await puller.pullNow();
    events.length = 0;
    writeFileSync(join(vaultPath, "first.txt"), "edited locally\n");
    remote.publish("first.txt", "changed upstream\n");

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("failed");
    expect(warnings.join("\n")).toContain("uncommitted changes");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("edited locally\n");
    expect(events).toEqual(["pause", "resume", "result:failed"]);
  });

  test("an unreachable remote is a warning, not a crash", async () => {
    const vaultPath = join(tempDir(), "vault");
    const { puller, warnings } = harness({ vaultPath, vaultUrl: `file://${tempDir()}/missing.git` });

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("failed");
    expect(warnings.length).toBe(1);
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("a host outside egress.allowed_hosts is refused and reported as failed", async () => {
    const vaultPath = join(tempDir(), "vault");
    const { puller, warnings } = harness({
      vaultPath,
      vaultUrl: "https://github.com/klhq/skills.git",
      allowedHosts: ["git.example.com"],
    });

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("failed");
    expect(warnings.join("\n")).toContain("github.com");
  });

  test("a pull requested while another runs is skipped, not queued", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { puller } = harness({
      vaultPath,
      vaultUrl: remote.url,
      resync: async () => {
        await gate;
      },
    });

    const first = puller.pullNow();
    const second = await puller.pullNow();
    release();
    const firstResult = await first;
    puller.stop();

    expect(second.status).toBe("skipped");
    expect(firstResult.status).toBe("cloned");
  });

  test("resumes the watcher even when the resync throws", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events, warnings } = harness({
      vaultPath,
      vaultUrl: remote.url,
      resync: async () => {
        throw new Error("index locked");
      },
    });

    const result = await puller.pullNow();
    puller.stop();

    expect(result.status).toBe("cloned");
    expect(events).toContain("resume");
    expect(warnings.join("\n")).toContain("index locked");
  });

  test("pulls again on the interval and stops when asked", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const { puller, events } = harness({ vaultPath, vaultUrl: remote.url, intervalMs: 50 });
    await puller.pullNow();
    remote.publish("second.txt", "two\n");

    const deadline = Date.now() + 5000;
    while (!events.includes("result:updated") && Date.now() < deadline) await Bun.sleep(25);
    puller.stop();
    // A pull already running when stop() is called still finishes and reports.
    // Let it land first, so the count below only sees pulls started after stop.
    await Bun.sleep(300);
    const seen = events.length;
    await Bun.sleep(200);

    expect(events).toContain("result:updated");
    expect(events.length).toBe(seen);
  });
});
