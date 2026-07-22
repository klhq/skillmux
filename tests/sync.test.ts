import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptTarget,
  installPostMergeHook,
  readSkillmuxMarker,
  resolveProjectPinDir,
  restoreMonolith,
  syncProjectTargets,
  syncTarget,
} from "../src/sync";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkillAt(root: string, skillId: string) {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillId}\n---\n\nbody\n`);
}

describe("syncTarget", () => {
  test("creates a fresh target directory with one symlink per core skill and a .skillmux marker", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "code-review"));
    const targetDir = join(tmpDir("skillmux-sync-target-"), "claude");

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

    const marker = readSkillmuxMarker(targetDir);
    expect(marker?.managed_by).toBe("skillmux");
    expect(marker?.target).toBe("claude");
    expect(typeof marker?.created_at).toBe("string");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("refuses to touch an existing target dir that lacks a .skillmux marker", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = tmpDir("skillmux-sync-unmarked-");

    expect(() =>
      syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] }),
    ).toThrow("not owned by skillmux");
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("rebuilds an already-marked target: adds missing and removes stale symlinks", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "code-review"));
    const targetDir = join(tmpDir("skillmux-sync-marked-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });
    const markerBefore = readSkillmuxMarker(targetDir);

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
    expect(readSkillmuxMarker(targetDir)?.created_at).toBe(markerBefore?.created_at);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("symlinks a fresh target to the local_vault_paths override, not vault_path, on skill_id collision", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const localVault = tmpDir("skillmux-sync-local-");
    writeSkillAt(vaultPath, "shared-skill");
    writeSkillAt(localVault, "shared-skill");
    const targetDir = join(tmpDir("skillmux-sync-target-"), "claude");

    syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["shared-skill"],
      localVaultPaths: [localVault],
    });

    expect(readlinkSync(join(targetDir, "shared-skill"))).toBe(join(localVault, "shared-skill"));

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("symlinks a newly-added skill on an already-marked target to the local_vault_paths override", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const localVault = tmpDir("skillmux-sync-local-");
    writeSkillAt(vaultPath, "shared-skill");
    writeSkillAt(localVault, "shared-skill");
    const targetDir = join(tmpDir("skillmux-sync-marked-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] });
    syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["shared-skill"],
      localVaultPaths: [localVault],
    });

    expect(readlinkSync(join(targetDir, "shared-skill"))).toBe(join(localVault, "shared-skill"));

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("dry-run reports the add/remove diff without writing anything", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skillmux-sync-dryrun-"), "claude");

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
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = tmpDir("skillmux-sync-dryrun-unmarked-");

    expect(() =>
      syncTarget(
        { vaultPath, targetDir, targetName: "claude", coreSkillIds: [] },
        { dryRun: true },
      ),
    ).toThrow("not owned by skillmux");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("recognizes a legacy adopted target with .skr marker and does not overwrite it", () => {
    const vaultPath = tmpDir("skillmux-legacy-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "code-review"));
    const targetDir = tmpDir("skillmux-legacy-target-");
    // Write legacy .skr marker
    writeFileSync(join(targetDir, ".skr"), JSON.stringify({
      managed_by: "skr",
      target: "claude",
      created_at: new Date().toISOString(),
    }));

    const result = syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["writing-clearly"],
    });

    expect(result.added).toEqual(["writing-clearly"]);
    expect(existsSync(join(targetDir, "writing-clearly"))).toBe(true);
    expect(existsSync(join(targetDir, ".skr"))).toBe(true);
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("restoreMonolith", () => {
  test("replaces a .skillmux-marked target directory with a symlink to the vault root", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skillmux-sync-restore-"), "claude");
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });

    const result = restoreMonolith(targetDir, vaultPath);

    expect(result.restored).toBe(true);
    expect(readlinkSync(targetDir)).toBe(vaultPath);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { force: true });
  });

  test("leaves an unmarked directory untouched", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = tmpDir("skillmux-sync-restore-unmarked-");

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

  test("throws instead of escaping the repo when targetDir isn't under $HOME", () => {
    expect(() => resolveProjectPinDir("/vault", "/workspace/projects/infra")).toThrow("$HOME");
  });

  test("throws instead of pinning at the repo root when targetDir equals $HOME exactly", () => {
    expect(() => resolveProjectPinDir(homedir(), "/workspace/projects/infra")).toThrow("$HOME");
  });
});

describe("syncProjectTargets", () => {
  test("materializes a pin dir per repo in each project group, skipping repos that don't exist locally", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "terraform-plans"));
    const targetDir = join(homedir(), ".claude", "skills");

    const existingRepo = tmpDir("skillmux-sync-repo-");
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

describe("installPostMergeHook", () => {
  function gitVault(): string {
    const vaultPath = tmpDir("skillmux-sync-hook-vault-");
    mkdirSync(join(vaultPath, ".git", "hooks"), { recursive: true });
    return vaultPath;
  }

  test("installs an executable post-merge hook that runs skillmux sync", () => {
    const vaultPath = gitVault();

    const result = installPostMergeHook(vaultPath);

    expect(result.installed).toBe(true);
    const hookPath = join(vaultPath, ".git", "hooks", "post-merge");
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("skillmux sync");
    expect(statSync(hookPath).mode & 0o111).toBeGreaterThan(0);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("re-running is idempotent: no duplicate content, reports already installed", () => {
    const vaultPath = gitVault();
    installPostMergeHook(vaultPath);
    const firstContent = readFileSync(join(vaultPath, ".git", "hooks", "post-merge"), "utf-8");

    const result = installPostMergeHook(vaultPath);

    expect(result.installed).toBe(false);
    expect(readFileSync(join(vaultPath, ".git", "hooks", "post-merge"), "utf-8")).toBe(firstContent);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("refuses to clobber a pre-existing post-merge hook it doesn't manage", () => {
    const vaultPath = gitVault();
    const hookPath = join(vaultPath, ".git", "hooks", "post-merge");
    writeFileSync(hookPath, "#/bin/sh\necho some other tool's hook\n");

    expect(() => installPostMergeHook(vaultPath)).toThrow();

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("treats pre-existing hook with legacy comment as already installed", () => {
    const vaultPath = gitVault();
    const hookPath = join(vaultPath, ".git", "hooks", "post-merge");
    writeFileSync(hookPath, "#!/bin/sh\n# managed-by: skr sync --install-hook\nskr sync\n");

    const result = installPostMergeHook(vaultPath);

    expect(result.installed).toBe(false);
    expect(readFileSync(hookPath, "utf-8")).toContain("skr sync");

    rmSync(vaultPath, { recursive: true, force: true });
  });
});

describe("adoptTarget", () => {
  test("marks an existing directory in place without touching its content", () => {
    const dir = tmpDir("skillmux-sync-adopt-");
    writeFileSync(join(dir, "pre-existing-skill"), "a real file, not a symlink skillmux created");

    const result = adoptTarget(dir, "claude");

    expect(result.adopted).toBe(true);
    expect(readSkillmuxMarker(dir)?.target).toBe("claude");
    expect(readFileSync(join(dir, "pre-existing-skill"), "utf-8")).toBe(
      "a real file, not a symlink skillmux created",
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test("is idempotent: adopting an already-marked directory is a no-op", () => {
    const dir = tmpDir("skillmux-sync-adopt-marked-");
    adoptTarget(dir, "claude");
    const markerBefore = readSkillmuxMarker(dir);

    const result = adoptTarget(dir, "claude");

    expect(result.adopted).toBe(false);
    expect(readSkillmuxMarker(dir)?.created_at).toBe(markerBefore?.created_at);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readSkillmuxMarker role back-compat", () => {
  test("reads a marker with no role key as role: \"target\"", () => {
    const dir = tmpDir("skillmux-sync-role-backcompat-");
    writeFileSync(
      join(dir, ".skillmux"),
      JSON.stringify({ managed_by: "skillmux", target: "claude", created_at: "2026-01-01T00:00:00.000Z" }),
    );

    const marker = readSkillmuxMarker(dir);

    expect(marker?.role).toBe("target");

    rmSync(dir, { recursive: true, force: true });
  });
});
