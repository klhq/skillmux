import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptTarget,
  installPostMergeHook,
  planTargetMarkerRehome,
  readSkillmuxMarker,
  resolveProjectPinDir,
  restoreMonolith,
  syncProjectTargets,
  planSyncDrift,
  syncTarget,
  writeLocalVaultMarker,
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
    expect(marker?.schema_version).toBe(1);
    expect(marker?.managed_by).toBe("skillmux");
    expect(marker?.role).toBe("target");
    expect(marker?.target).toBe("claude");
    expect(marker?.vault_path).toBe(vaultPath);
    expect(marker?.managed_entries?.sort()).toEqual(["code-review", "writing-clearly"]);
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

  test("preserves unmanaged entries and removes only stale entries recorded in the marker", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skillmux-sync-owned-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });
    writeFileSync(join(targetDir, "notes.txt"), "user-owned");

    const result = syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] });

    expect(result.removed).toEqual(["writing-clearly"]);
    expect(existsSync(join(targetDir, "writing-clearly"))).toBe(false);
    expect(readFileSync(join(targetDir, "notes.txt"), "utf-8")).toBe("user-owned");
    expect(readSkillmuxMarker(targetDir)?.managed_entries).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("rejects a desired skill that collides with an unmanaged entry before removing anything", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "old-skill"));
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = join(tmpDir("skillmux-sync-collision-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["old-skill"] });
    writeFileSync(join(targetDir, "writing-clearly"), "user-owned");

    expect(() =>
      syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] }),
    ).toThrow("unmanaged entry");

    expect(existsSync(join(targetDir, "old-skill"))).toBe(true);
    expect(readFileSync(join(targetDir, "writing-clearly"), "utf-8")).toBe("user-owned");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("does not accept a local_vault marker as target ownership", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = tmpDir("skillmux-sync-local-marker-");
    writeLocalVaultMarker(targetDir, vaultPath);

    expect(() => syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] })).toThrow(
      "local_vault",
    );

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
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

  test("adoptUnmarked takes over an existing directory and leaves its own entries unmanaged", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = tmpDir("skillmux-sync-adopt-");
    mkdirSync(join(targetDir, ".system"));
    writeFileSync(join(targetDir, ".system", "note.md"), "agent-owned\n");

    const result = syncTarget(
      { vaultPath, targetDir, targetName: "codex", coreSkillIds: ["writing-clearly"] },
      { adoptUnmarked: true },
    );

    expect(result.adopted).toBe(true);
    expect(result.added).toEqual(["writing-clearly"]);
    expect(readFileSync(join(targetDir, ".system", "note.md"), "utf8")).toBe("agent-owned\n");
    const marker = readSkillmuxMarker(targetDir);
    expect(marker?.target).toBe("codex");
    expect(marker?.managed_entries).toEqual(["writing-clearly"]);

    const again = syncTarget(
      { vaultPath, targetDir, targetName: "codex", coreSkillIds: ["writing-clearly"] },
      { adoptUnmarked: true },
    );
    expect(again.adopted).toBeUndefined();
    expect(again.added).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("adoptUnmarked in dry-run reports the plan without writing a marker", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = tmpDir("skillmux-sync-adopt-dry-");

    const result = syncTarget(
      { vaultPath, targetDir, targetName: "codex", coreSkillIds: ["writing-clearly"] },
      { dryRun: true, adoptUnmarked: true },
    );

    expect(result).toEqual({ added: ["writing-clearly"], removed: [], skipped: [], adopted: true });
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(false);
    expect(existsSync(join(targetDir, "writing-clearly"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("adoptUnmarked still refuses a same-named entry in the way and writes nothing", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    const targetDir = tmpDir("skillmux-sync-adopt-collide-");
    mkdirSync(join(targetDir, "writing-clearly"));

    expect(() =>
      syncTarget(
        { vaultPath, targetDir, targetName: "codex", coreSkillIds: ["writing-clearly"] },
        { adoptUnmarked: true },
      ),
    ).toThrow("unmanaged entry collisions");
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("adoptUnmarked refuses a directory that is a symlink", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const realDir = tmpDir("skillmux-sync-adopt-real-");
    const targetDir = join(tmpDir("skillmux-sync-adopt-link-"), "skills");
    symlinkSync(realDir, targetDir);

    expect(() =>
      syncTarget({ vaultPath, targetDir, targetName: "codex", coreSkillIds: [] }, { adoptUnmarked: true }),
    ).toThrow("is a symbolic link");
    expect(existsSync(join(realDir, ".skillmux"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
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

  test("upgrades an empty legacy adopted target to a versioned ownership marker", () => {
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
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(true);
    expect(readSkillmuxMarker(targetDir)?.schema_version).toBe(1);
    expect(readSkillmuxMarker(targetDir)?.managed_entries).toEqual(["writing-clearly"]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("security: skips a core skill whose directory contains an internal symlink, on a fresh target", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-symlink-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "evil-skill"));
    symlinkSync("/etc/passwd", join(vaultPath, "evil-skill", "escape"));
    const targetDir = join(tmpDir("skillmux-sync-target-symlink-"), "claude");

    const result = syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["writing-clearly", "evil-skill"],
    });

    expect(result.added).toEqual(["writing-clearly"]);
    expect(result.skipped).toEqual(["evil-skill"]);
    expect(existsSync(join(targetDir, "evil-skill"))).toBe(false);
    expect(readSkillmuxMarker(targetDir)?.managed_entries).toEqual(["writing-clearly"]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("security: skips a core skill whose directory contains an internal symlink, on an incremental sync", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-symlink-inc-");
    mkdirSync(join(vaultPath, "writing-clearly"));
    mkdirSync(join(vaultPath, "evil-skill"));
    symlinkSync("/etc/passwd", join(vaultPath, "evil-skill", "escape"));
    const targetDir = join(tmpDir("skillmux-sync-target-symlink-inc-"), "claude");

    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });
    const result = syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["writing-clearly", "evil-skill"],
    });

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["evil-skill"]);
    expect(existsSync(join(targetDir, "evil-skill"))).toBe(false);
    expect(readSkillmuxMarker(targetDir)?.managed_entries).toEqual(["writing-clearly"]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("syncTarget legacy owner names", () => {
  test("adopts a hand-named target marker under the surface id and reports the old name", () => {
    const vaultPath = tmpDir("skillmux-sync-rename-vault-");
    writeSkillAt(vaultPath, "writing-clearly");
    writeSkillAt(vaultPath, "code-review");
    const targetDir = join(tmpDir("skillmux-sync-rename-target-"), "skills");
    syncTarget({ vaultPath, targetDir, targetName: "agents-albatron", coreSkillIds: ["writing-clearly"] });

    const planned = syncTarget(
      { vaultPath, targetDir, targetName: "agent-skills", coreSkillIds: ["writing-clearly", "code-review"] },
      { dryRun: true },
    );
    expect(planned).toEqual({ added: ["code-review"], removed: [], skipped: [], renamedFrom: "agents-albatron" });
    expect(readSkillmuxMarker(targetDir)?.target).toBe("agents-albatron");

    const applied = syncTarget({
      vaultPath,
      targetDir,
      targetName: "agent-skills",
      coreSkillIds: ["writing-clearly", "code-review"],
    });
    expect(applied.renamedFrom).toBe("agents-albatron");
    const marker = readSkillmuxMarker(targetDir);
    expect(marker?.target).toBe("agent-skills");
    expect(marker?.managed_entries).toEqual(["writing-clearly", "code-review"]);

    expect(
      syncTarget({ vaultPath, targetDir, targetName: "agent-skills", coreSkillIds: ["writing-clearly", "code-review"] })
        .renamedFrom,
    ).toBeUndefined();

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

  test("refuses a local_vault marker without deleting the directory", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = tmpDir("skillmux-sync-restore-local-");
    writeLocalVaultMarker(targetDir, vaultPath);
    writeFileSync(join(targetDir, "keep.txt"), "keep");

    expect(() => restoreMonolith(targetDir, vaultPath)).toThrow("local_vault");
    expect(readFileSync(join(targetDir, "keep.txt"), "utf-8")).toBe("keep");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("refuses to restore over unmanaged target content", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    const targetDir = join(tmpDir("skillmux-sync-restore-unmanaged-"), "claude");
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: [] });
    writeFileSync(join(targetDir, "keep.txt"), "keep");

    expect(() => restoreMonolith(targetDir, vaultPath)).toThrow("unmanaged");
    expect(readFileSync(join(targetDir, "keep.txt"), "utf-8")).toBe("keep");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("resolveProjectPinDir", () => {
  test("joins the path with the target dir's path relative to $HOME", () => {
    const targetDir = join(homedir(), ".claude", "skills");
    const path = "/workspace/projects/infra";

    expect(resolveProjectPinDir(targetDir, path)).toBe(join(path, ".claude", "skills"));
  });

  test("throws instead of escaping the path when targetDir isn't under $HOME", () => {
    expect(() => resolveProjectPinDir("/vault", "/workspace/projects/infra")).toThrow("$HOME");
  });

  test("throws instead of pinning at the path root when targetDir equals $HOME exactly", () => {
    expect(() => resolveProjectPinDir(homedir(), "/workspace/projects/infra")).toThrow("$HOME");
  });
});

describe("syncProjectTargets", () => {
  test("materializes a pin dir per path in each project group, skipping paths that don't exist locally", () => {
    const vaultPath = tmpDir("skillmux-sync-vault-");
    mkdirSync(join(vaultPath, "terraform-plans"));
    const targetDir = join(homedir(), ".claude", "skills");

    const existingPath = tmpDir("skillmux-sync-path-");
    const missingPath = "/does/not/exist/on/this/machine";

    const results = syncProjectTargets({
      vaultPath,
      targetDir,
      targetName: "claude",
      projectGroups: {
        infra: { paths: [existingPath, missingPath], skills: ["terraform-plans"] },
      },
    });

    expect(results).toEqual([
      {
        group: "infra",
        path: existingPath,
        pinDir: resolveProjectPinDir(targetDir, existingPath),
        added: ["terraform-plans"],
        removed: [],
        skipped: [],
      },
    ]);
    expect(readlinkSync(join(existingPath, ".claude", "skills", "terraform-plans"))).toBe(
      join(vaultPath, "terraform-plans"),
    );

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(existingPath, { recursive: true, force: true });
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
    const vaultPath = tmpDir("skillmux-sync-adopt-vault-");
    writeFileSync(join(dir, "pre-existing-skill"), "a real file, not a symlink skillmux created");

    const result = adoptTarget(dir, "claude", vaultPath);

    expect(result.adopted).toBe(true);
    expect(readSkillmuxMarker(dir)?.target).toBe("claude");
    expect(readSkillmuxMarker(dir)?.vault_path).toBe(vaultPath);
    expect(readSkillmuxMarker(dir)?.managed_entries).toEqual([]);
    expect(readFileSync(join(dir, "pre-existing-skill"), "utf-8")).toBe(
      "a real file, not a symlink skillmux created",
    );

    rmSync(dir, { recursive: true, force: true });
    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("is idempotent: adopting an already-marked directory is a no-op", () => {
    const dir = tmpDir("skillmux-sync-adopt-marked-");
    const vaultPath = tmpDir("skillmux-sync-adopt-vault-");
    adoptTarget(dir, "claude", vaultPath);
    const markerBefore = readSkillmuxMarker(dir);

    const result = adoptTarget(dir, "claude", vaultPath);

    expect(result.adopted).toBe(false);
    expect(readSkillmuxMarker(dir)?.created_at).toBe(markerBefore?.created_at);

    rmSync(dir, { recursive: true, force: true });
    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("re-owns a legacy target name under the surface id, but still rejects another vault", () => {
    const dir = tmpDir("skillmux-sync-adopt-conflict-");
    const firstVault = tmpDir("skillmux-sync-adopt-vault-");
    const secondVault = tmpDir("skillmux-sync-adopt-vault-");
    adoptTarget(dir, "agents-albatron", firstVault);
    const createdAt = readSkillmuxMarker(dir)?.created_at;

    expect(adoptTarget(dir, "agent-skills", firstVault).adopted).toBe(false);
    expect(readSkillmuxMarker(dir)?.target).toBe("agent-skills");
    expect(readSkillmuxMarker(dir)?.created_at).toBe(createdAt);
    expect(() => adoptTarget(dir, "agent-skills", secondVault)).toThrow("vault_path");

    rmSync(dir, { recursive: true, force: true });
    rmSync(firstVault, { recursive: true, force: true });
    rmSync(secondVault, { recursive: true, force: true });
  });
});

describe("writeLocalVaultMarker", () => {
  test("writes a .skillmux marker with role: \"local_vault\" and the given vault_path", () => {
    const dir = tmpDir("skillmux-sync-local-vault-marker-");

    writeLocalVaultMarker(dir, "/home/user/skills");

    const marker = readSkillmuxMarker(dir);
    expect(marker).toMatchObject({ managed_by: "skillmux", role: "local_vault", vault_path: "/home/user/skills" });

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

  test("rejects a versioned target marker missing required ownership fields", () => {
    const dir = tmpDir("skillmux-sync-invalid-marker-");
    writeFileSync(
      join(dir, ".skillmux"),
      JSON.stringify({
        schema_version: 1,
        managed_by: "skillmux",
        role: "target",
        target: "claude",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(() => readSkillmuxMarker(dir)).toThrow("vault_path");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("planTargetMarkerRehome", () => {
  test("rejects a versioned legacy marker instead of writing a second marker format", () => {
    const vaultPath = tmpDir("skillmux-rehome-vault-");
    writeSkillAt(vaultPath, "writing-clearly");
    const targetDir = join(tmpDir("skillmux-rehome-target-"), "agents");
    syncTarget({
      vaultPath,
      targetDir,
      targetName: "agent-skills",
      coreSkillIds: ["writing-clearly"],
    });
    renameSync(join(targetDir, ".skillmux"), join(targetDir, ".skr"));

    expect(() => planTargetMarkerRehome(targetDir, "agent-skills", vaultPath)).toThrow(
      "legacy marker",
    );
    expect(existsSync(join(targetDir, ".skillmux"))).toBe(false);
    expect(existsSync(join(targetDir, ".skr"))).toBe(true);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});

describe("planSyncDrift", () => {
  function vaultWith(skillIds: string[]): string {
    const vaultPath = tmpDir("skillmux-drift-vault-");
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    return vaultPath;
  }

  test("reports a target this host has never synced as drifted", () => {
    const vaultPath = vaultWith(["writing-clearly", "code-review"]);
    const targetDir = join(tmpDir("skillmux-drift-target-"), "claude");

    const report = planSyncDrift({
      vaultPath,
      targets: [{ name: "claude", dir: targetDir, projectGroups: {} }],
      coreSkillIds: ["writing-clearly", "code-review"],
    });

    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]!.target).toBe("claude");
    expect(report.drifted[0]!.added).toEqual(["writing-clearly", "code-review"]);
    expect(report.drifted[0]!.removed).toEqual([]);
    expect(report.unplannable).toEqual([]);
    expect(existsSync(targetDir)).toBe(false);
  });

  test("reports nothing once the target matches the manifest", () => {
    const vaultPath = vaultWith(["writing-clearly", "code-review"]);
    const targetDir = join(tmpDir("skillmux-drift-target-"), "claude");
    const coreSkillIds = ["writing-clearly", "code-review"];
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds });

    const report = planSyncDrift({
      vaultPath,
      targets: [{ name: "claude", dir: targetDir, projectGroups: {} }],
      coreSkillIds,
    });

    expect(report.drifted).toEqual([]);
    expect(report.unplannable).toEqual([]);
  });

  test("reports a pin added to the manifest since the last sync", () => {
    const vaultPath = vaultWith(["writing-clearly", "code-review"]);
    const targetDir = join(tmpDir("skillmux-drift-target-"), "claude");
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });

    const report = planSyncDrift({
      vaultPath,
      targets: [{ name: "claude", dir: targetDir, projectGroups: {} }],
      coreSkillIds: ["writing-clearly", "code-review"],
    });

    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]!.added).toEqual(["code-review"]);
    expect(report.drifted[0]!.removed).toEqual([]);
  });

  test("reports an unpin the same way", () => {
    const vaultPath = vaultWith(["writing-clearly", "code-review"]);
    const targetDir = join(tmpDir("skillmux-drift-target-"), "claude");
    syncTarget({
      vaultPath,
      targetDir,
      targetName: "claude",
      coreSkillIds: ["writing-clearly", "code-review"],
    });

    const report = planSyncDrift({
      vaultPath,
      targets: [{ name: "claude", dir: targetDir, projectGroups: {} }],
      coreSkillIds: ["writing-clearly"],
    });

    expect(report.drifted[0]!.removed).toEqual(["code-review"]);
  });

  test("records a target it cannot plan without failing the whole report", () => {
    const vaultPath = vaultWith(["writing-clearly", "code-review"]);
    const okDir = join(tmpDir("skillmux-drift-target-"), "claude");
    // An existing directory that already holds an unmanaged entry named like a core
    // skill: syncTarget refuses it, and doctor still has to report every other target.
    const collidedDir = tmpDir("skillmux-drift-collision-");
    mkdirSync(join(collidedDir, "writing-clearly"));

    const report = planSyncDrift({
      vaultPath,
      targets: [
        { name: "claude", dir: okDir, projectGroups: {} },
        { name: "codex", dir: collidedDir, projectGroups: {} },
      ],
      coreSkillIds: ["writing-clearly", "code-review"],
    });

    expect(report.unplannable).toHaveLength(1);
    expect(report.unplannable[0]!.target).toBe("codex");
    expect(report.drifted.map((entry) => entry.target)).toEqual(["claude"]);
  });

  test("plans project pin directories alongside the core target", () => {
    const vaultPath = vaultWith(["writing-clearly", "langgraph-cli"]);
    const targetDir = join(homedir(), ".skillmux-drift-test", "claude");
    const projectPath = tmpDir("skillmux-drift-project-");
    rmSync(join(homedir(), ".skillmux-drift-test"), { recursive: true, force: true });
    syncTarget({ vaultPath, targetDir, targetName: "claude", coreSkillIds: ["writing-clearly"] });

    const report = planSyncDrift({
      vaultPath,
      targets: [
        {
          name: "claude",
          dir: targetDir,
          projectGroups: { fpbs: { paths: [projectPath], skills: ["langgraph-cli"] } },
        },
      ],
      coreSkillIds: ["writing-clearly"],
    });

    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]!.group).toBe("fpbs");
    expect(report.drifted[0]!.added).toEqual(["langgraph-cli"]);

    rmSync(join(homedir(), ".skillmux-drift-test"), { recursive: true, force: true });
  });
});
