import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readSkrMarker, resolveProjectPinDir, restoreMonolith, syncProjectTargets, syncTarget } from "../src/sync";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("syncTarget", () => {
  test("creates a fresh target directory with one symlink per core skill and a .skr marker", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "code-review"));
    const targetDir = join(tmpDir("skill-router-sync-target-"), "claude");

    const result = syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["writing-clearly", "code-review"],
    });

    expect(result.added.sort()).toEqual(["code-review", "writing-clearly"]);
    expect(result.removed).toEqual([]);
    expect(readlinkSync(join(targetDir, "writing-clearly"))).toBe(join(vaultPath, "writing-clearly"));
    expect(readlinkSync(join(targetDir, "code-review"))).toBe(join(vaultPath, "code-review"));

    const marker = readSkrMarker(targetDir);
    expect(marker?.managed_by).toBe("skr");
    expect(marker?.target).toBe("claude");
    expect(typeof marker?.created_at).toBe("string");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("refuses to touch an existing target dir that lacks a .skr marker", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    const targetDir = tmpDir("skill-router-sync-unmarked-");

    expect(() =>
      syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] }),
    ).toThrow("not owned by skr");
    expect(existsSync(join(targetDir, ".skr"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("rebuilds an already-marked target: adds missing and removes stale symlinks", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "code-review"));
    const targetDir = join(tmpDir("skill-router-sync-marked-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });
    const markerBefore = readSkrMarker(targetDir);

    const result = syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["code-review"],
    });

    expect(result.added).toEqual(["code-review"]);
    expect(result.removed).toEqual(["writing-clearly"]);
    expect(existsSync(join(targetDir, "writing-clearly"))).toBe(false);
    expect(readlinkSync(join(targetDir, "code-review"))).toBe(join(vaultPath, "code-review"));
    // created_at is not updated by subsequent syncs
    expect(readSkrMarker(targetDir)?.created_at).toBe(markerBefore?.created_at);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("dry-run reports the add/remove diff without writing anything", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skill-router-sync-dryrun-"), "claude");

    const result = syncTarget(
      { vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] },
      { dryRun: true },
    );

    expect(result.added).toEqual(["writing-clearly"]);
    expect(result.removed).toEqual([]);
    expect(existsSync(targetDir)).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("dry-run still refuses an existing unmarked target dir", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    const targetDir = tmpDir("skill-router-sync-dryrun-unmarked-");

    expect(() =>
      syncTarget(
        { vaultPath, targetDir, targetName: "claude", coreSkillIds: [] },
        { dryRun: true },
      ),
    ).toThrow("not owned by skr");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("restoreMonolith", () => {
  test("replaces a .skr-marked target directory with a symlink to the vault root", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skill-router-sync-restore-"), "claude");
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });

    const result = restoreMonolith(targetDir, vaultPath);

    expect(result.restored).toBe(true);
    expect(readlinkSync(targetDir)).toBe(vaultPath);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { force: true });
  });

  test("leaves an unmarked directory untouched", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    const targetDir = tmpDir("skill-router-sync-restore-unmarked-");

    const result = restoreMonolith(targetDir, vaultPath);

    expect(result.restored).toBe(false);
    expect(existsSync(targetDir)).toBe(true);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("resolveProjectPinDir", () => {
  test("joins the repo path with the target dir's path relative to $HOME", () => {
    const targetDir = join(homedir(), ".claude", "skills");
    const repo = "/workspace/projects/infra";

    expect(resolveProjectPinDir(targetDir, repo)).toBe(join(repo, ".claude", "skills"));
  });
});

describe("syncProjectTargets", () => {
  test("materializes a pin dir per repo in each project group, skipping repos that don't exist locally", () => {
    const vaultPath = tmpDir("skill-router-sync-vault-");
    mkdirSync(join(vaultPath, "terraform-plans"));
    const targetDir = join(homedir(), ".claude", "skills");

    const existingRepo = tmpDir("skill-router-sync-repo-");
    const missingRepo = "/does/not/exist/on/this/machine";

    const results = syncProjectTargets({
      vaultPath,
      targetDir,
      targetName: "claude",
      projectGroups: {
        infra: { repos: [existingRepo, missingRepo], skills: ["terraform-plans"] },
      },
    });

    expect(results).toEqual([
      {
        group: "infra",
        repo: existingRepo,
        pinDir: resolveProjectPinDir(targetDir, existingRepo),
        added: ["terraform-plans"],
        removed: [],
      },
    ]);
    expect(readlinkSync(join(existingRepo, ".claude", "skills", "terraform-plans"))).toBe(
      join(vaultPath, "terraform-plans"),
    );

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(existingRepo, { recursive: true, force: true });
  });
});
