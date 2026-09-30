import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, createRemote, git, tempDir } from "./git-remote-fixture";
import { refreshVault, updateVault } from "../src/vault-update";

afterEach(() => {
  cleanupTempDirs();
});

describe("updateVault", () => {
  test("clones vault_url into vault_path when vault_path does not exist", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("cloned");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(vaultPath, ".git"))).toBe(true);
  });

  test("fast-forwards an existing checkout whose origin is vault_url", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("updated");
    expect(readFileSync(join(vaultPath, "second.txt"), "utf8")).toBe("two\n");
  });

  test("reports up-to-date and changes nothing when upstream has no new commits", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    const before = git(vaultPath, "rev-parse", "HEAD");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("up-to-date");
    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
  });

  test("refuses a checkout whose origin is not vault_url, naming both and changing nothing", async () => {
    const remote = createRemote();
    const other = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    remote.publish("second.txt", "two\n");
    const before = git(vaultPath, "rev-parse", "HEAD");

    await expect(updateVault({ vaultPath, vaultUrl: other.url })).rejects.toThrow(
      new RegExp(`${remote.url}.*${other.url}|${other.url}.*${remote.url}`),
    );

    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("warns instead of throwing when the remote is unreachable, leaving the clone as it was", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    rmSync(remote.url.replace("file://", ""), { recursive: true, force: true });

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("git pull");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("one\n");
  });

  test("leaves a checkout with uncommitted changes alone and says why", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    writeFileSync(join(vaultPath, "first.txt"), "hand edit\n");
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("uncommitted");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("hand edit\n");
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("leaves a diverged checkout alone instead of merging or rebasing", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    writeFileSync(join(vaultPath, "local.txt"), "local\n");
    git(vaultPath, "add", "local.txt");
    git(vaultPath, "commit", "-q", "-m", "local commit");
    const before = git(vaultPath, "rev-parse", "HEAD");
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("refuses a vault_url whose host is not in [egress] allowed_hosts before touching the network", async () => {
    const vaultPath = join(tempDir(), "vault");

    await expect(
      updateVault({
        vaultPath,
        vaultUrl: "https://untrusted.example.com/klhq/skills.git",
        allowedHosts: ["github.com"],
      }),
    ).rejects.toThrow("not in [egress] allowed_hosts");

    expect(existsSync(vaultPath)).toBe(false);
  });

  test("marks git's environment so a sync started by the post-merge hook can tell it is nested", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    const seen = join(tempDir(), "hook-env");
    const hook = join(vaultPath, ".git", "hooks", "post-merge");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$SKILLMUX_SYNC_ACTIVE" > "${seen}"\n`);
    chmodSync(hook, 0o755);
    remote.publish("second.txt", "two\n");

    await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(readFileSync(seen, "utf8")).toBe("1");
  });

  test("warns instead of throwing when a first clone cannot reach the remote", async () => {
    const vaultPath = join(tempDir(), "vault");

    const result = await updateVault({ vaultPath, vaultUrl: `file://${tempDir()}/missing.git` });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("git clone");
    expect(existsSync(vaultPath)).toBe(false);
  });
});

describe("refreshVault", () => {
  test("does nothing without a vault_url, so an existing sync setup is unchanged", async () => {
    const vaultPath = join(tempDir(), "vault");

    const result = await refreshVault(
      { vault_path: vaultPath, agents: ["opencode"] },
      { dryRun: false, noPull: false },
    );

    expect(result).toEqual({ status: "skipped", reason: "no-vault-url" });
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("does not clone for a host with no agents, which has nothing to deliver skills to", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await refreshVault(
      { vault_path: vaultPath, vault_url: remote.url, agents: [] },
      { dryRun: false, noPull: false },
    );

    expect(result).toEqual({ status: "skipped", reason: "no-agents" });
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("skips the clone and pull under --no-pull", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await refreshVault(
      { vault_path: vaultPath, vault_url: remote.url, agents: ["opencode"] },
      { dryRun: false, noPull: true },
    );

    expect(result).toEqual({ status: "skipped", reason: "no-pull" });
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("under --dry-run reports that it would clone, without cloning", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await refreshVault(
      { vault_path: vaultPath, vault_url: remote.url, agents: ["opencode"] },
      { dryRun: true, noPull: false },
    );

    expect(result).toEqual({ status: "skipped", reason: "dry-run", would: "clone" });
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("under --dry-run reports that it would update an existing checkout, without pulling", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    remote.publish("second.txt", "two\n");

    const result = await refreshVault(
      { vault_path: vaultPath, vault_url: remote.url, agents: ["opencode"] },
      { dryRun: true, noPull: false },
    );

    expect(result).toEqual({ status: "skipped", reason: "dry-run", would: "update" });
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("clones and updates through updateVault when vault_url and agents are set", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await refreshVault(
      { vault_path: vaultPath, vault_url: remote.url, agents: ["opencode"] },
      { dryRun: false, noPull: false },
    );

    expect(result).toEqual({ status: "cloned" });
    expect(existsSync(join(vaultPath, "first.txt"))).toBe(true);
  });

  test("does not pull again when it is itself running inside a vault pull", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    const previous = process.env.SKILLMUX_SYNC_ACTIVE;
    process.env.SKILLMUX_SYNC_ACTIVE = "1";
    try {
      const result = await refreshVault(
        { vault_path: vaultPath, vault_url: remote.url, agents: ["opencode"] },
        { dryRun: false, noPull: false },
      );

      expect(result).toEqual({ status: "skipped", reason: "nested" });
      expect(existsSync(vaultPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SKILLMUX_SYNC_ACTIVE;
      else process.env.SKILLMUX_SYNC_ACTIVE = previous;
    }
  });
});
