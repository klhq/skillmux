import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyInit, deriveTargetName, detectSurfaces, printLastMile, proposeManifest } from "../src/init";
import { parseManifest } from "../src/manifest";
import { readSkillmuxMarker } from "../src/sync";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(dir: string, skillId: string) {
  const skillDir = join(dir, skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillId}\ndescription: test\n---\nbody`);
}

describe("detectSurfaces", () => {
  test("reports a nonexistent candidate as not found", () => {
    const candidates = detectSurfaces(["/does/not/exist/on/this/machine"]);

    expect(candidates).toEqual([
      {
        path: "/does/not/exist/on/this/machine",
        exists: false,
        isSymlink: false,
        skillCount: 0,
        alreadyMarked: false,
        state: "missing",
        deliveryMode: "managed-pins",
      },
    ]);
  });

  test("reports a real directory's skill count and marker status", () => {
    const root = tmpDir("skillmux-init-detect-");
    const surface = join(root, "skills");
    mkdirSync(surface);
    writeSkill(surface, "writing-clearly");
    writeSkill(surface, "code-review");

    const [candidate] = detectSurfaces([surface]);

    expect(candidate).toEqual({
      path: surface,
      canonicalPath: surface,
      exists: true,
      isSymlink: false,
      skillCount: 2,
      alreadyMarked: false,
      state: "directory",
      deliveryMode: "managed-pins",
    });

    rmSync(root, { recursive: true, force: true });
  });

  test("classifies a symlink resolving to the vault as full-vault without reading through it", () => {
    const root = tmpDir("skillmux-init-detect-");
    const vault = join(root, "vault");
    mkdirSync(vault);
    writeSkill(vault, "writing-clearly");
    const surface = join(root, "skills");
    symlinkSync(vault, surface);

    const candidate = detectSurfaces([surface], vault)[0]!;

    expect(candidate).toEqual({
      path: surface,
      canonicalPath: vault,
      exists: true,
      isSymlink: true,
      skillCount: 0,
      alreadyMarked: false,
      state: "full-vault",
      deliveryMode: "full-vault",
    });

    rmSync(root, { recursive: true, force: true });
  });

  test("distinguishes external and broken symlinks without reading through either", () => {
    const root = tmpDir("skillmux-init-detect-links-");
    const vault = join(root, "vault");
    const external = join(root, "external");
    const externalSurface = join(root, "external-skills");
    const brokenSurface = join(root, "broken-skills");
    mkdirSync(vault);
    mkdirSync(external);
    writeSkill(external, "writing-clearly");
    symlinkSync(external, externalSurface);
    symlinkSync(join(root, "absent"), brokenSurface);

    expect(detectSurfaces([externalSurface, brokenSurface], vault)).toEqual([
      {
        path: externalSurface,
        canonicalPath: external,
        exists: true,
        isSymlink: true,
        skillCount: 0,
        alreadyMarked: false,
        state: "external-symlink",
        deliveryMode: "external",
      },
      {
        path: brokenSurface,
        exists: false,
        isSymlink: true,
        skillCount: 0,
        alreadyMarked: false,
        state: "broken-symlink",
        deliveryMode: "external",
      },
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("proposeManifest", () => {
  test("proposes an empty core list and no project groups regardless of detected surfaces (conservative default)", () => {
    const candidates = detectSurfaces(["/does/not/exist/on/this/machine"]);

    expect(proposeManifest(candidates)).toEqual({ core: { skills: [] }, project: {} });
  });
});

describe("deriveTargetName", () => {
  test("derives 'claude' from ~/.claude/skills", () => {
    expect(deriveTargetName("/Users/lance/.claude/skills")).toBe("claude");
  });

  test("derives 'agents' from ~/.agents/skills", () => {
    expect(deriveTargetName("/Users/lance/.agents/skills")).toBe("agents");
  });
});

describe("printLastMile", () => {
  test("includes the MCP registration command and the exact §3.3 discovery paragraph", () => {
    const text = printLastMile();

    expect(text).toContain(`"command": "skillmux"`);
    expect(text).toContain("resolve_skill");
    expect(text).toContain("no_match");
  });
});

describe("applyInit", () => {
  test("scopes a newly added target to the current hostname", () => {
    const vaultPath = tmpDir("skillmux-init-host-vault-");
    const targetDir = tmpDir("skillmux-init-host-target-");

    const manifest = applyInit(vaultPath, [{ name: "claude", dir: targetDir }]);

    expect(manifest.targets.claude?.host).toBe(hostname());
    expect(readFileSync(join(vaultPath, "skillmux.toml"), "utf-8")).toContain(
      `host = ${JSON.stringify(hostname())}`,
    );

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("preserves existing pins, projects, and targets when adding a target", () => {
    const vaultPath = tmpDir("skillmux-init-merge-vault-");
    const agentsDir = tmpDir("skillmux-init-merge-agents-");
    const claudeDir = tmpDir("skillmux-init-merge-claude-");
    const projectPath = tmpDir("skillmux-init-merge-project-");

    writeFileSync(
      join(vaultPath, "skillmux.toml"),
      [
        "[core]",
        'skills = ["code-review"]',
        "",
        "[project.skillmux]",
        `paths = [${JSON.stringify(projectPath)}]`,
        'skills = ["writing-clearly"]',
        "",
        "[targets.agents]",
        `dir = ${JSON.stringify(agentsDir)}`,
        'project_groups = ["skillmux"]',
        "",
      ].join("\n"),
    );

    applyInit(vaultPath, [{ name: "claude", dir: claudeDir }]);

    expect(parseManifest(readFileSync(join(vaultPath, "skillmux.toml"), "utf-8"))).toEqual({
      core: { skills: ["code-review"] },
      project: {
        skillmux: {
          paths: [projectPath],
          skills: ["writing-clearly"],
        },
      },
      targets: {
        agents: {
          dir: agentsDir,
          project_groups: ["skillmux"],
        },
        claude: {
          dir: claudeDir,
          host: hostname(),
          project_groups: [],
        },
      },
    });

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  test("preserves an existing target's host scope and project groups when reinitialized", () => {
    const vaultPath = tmpDir("skillmux-init-existing-target-vault-");
    const targetDir = tmpDir("skillmux-init-existing-target-");
    writeFileSync(
      join(vaultPath, "skillmux.toml"),
      [
        "[core]",
        "skills = []",
        "",
        "[project.shared]",
        `paths = [${JSON.stringify(vaultPath)}]`,
        "skills = []",
        "",
        "[targets.claude]",
        `dir = ${JSON.stringify(targetDir)}`,
        'host = "another-host"',
        'project_groups = ["shared"]',
      ].join("\n"),
    );

    const manifest = applyInit(vaultPath, [{ name: "claude", dir: targetDir }]);

    expect(manifest.targets.claude).toEqual({
      dir: targetDir,
      host: "another-host",
      project_groups: ["shared"],
    });

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("does not rewrite the manifest or marker when the same target is initialized again", () => {
    const vaultPath = tmpDir("skillmux-init-idempotent-vault-");
    const claudeDir = tmpDir("skillmux-init-idempotent-claude-");
    const target = { name: "claude", dir: claudeDir };
    const manifestPath = join(vaultPath, "skillmux.toml");
    const markerPath = join(claudeDir, ".skillmux");
    const sentinelTime = new Date("2000-01-01T00:00:00.000Z");

    applyInit(vaultPath, [target]);
    utimesSync(manifestPath, sentinelTime, sentinelTime);
    utimesSync(markerPath, sentinelTime, sentinelTime);

    applyInit(vaultPath, [target]);

    expect(statSync(manifestPath).mtimeMs).toBe(sentinelTime.getTime());
    expect(statSync(markerPath).mtimeMs).toBe(sentinelTime.getTime());

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  test("preflights every target and rejects symlinks before writing or adopting any target", () => {
    const root = tmpDir("skillmux-init-preflight-");
    const vaultPath = join(root, "vault");
    const freshTarget = join(root, "fresh-target");
    const external = join(root, "external");
    const linkedTarget = join(root, "linked-target");
    mkdirSync(vaultPath);
    mkdirSync(external);
    symlinkSync(external, linkedTarget);

    expect(() =>
      applyInit(vaultPath, [
        { name: "fresh", dir: freshTarget },
        { name: "linked", dir: linkedTarget },
      ]),
    ).toThrow("symbolic link");

    expect(existsSync(join(vaultPath, "skillmux.toml"))).toBe(false);
    expect(existsSync(freshTarget)).toBe(false);
    expect(existsSync(join(external, ".skillmux"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("preflights ownership conflicts across all targets before adopting the first", () => {
    const root = tmpDir("skillmux-init-ownership-preflight-");
    const vaultPath = join(root, "vault");
    const freshTarget = join(root, "fresh-target");
    const occupiedTarget = join(root, "occupied-target");
    mkdirSync(vaultPath);
    mkdirSync(occupiedTarget);
    applyInit(vaultPath, [{ name: "existing", dir: occupiedTarget }]);
    rmSync(join(vaultPath, "skillmux.toml"));

    expect(() =>
      applyInit(vaultPath, [
        { name: "fresh", dir: freshTarget },
        { name: "different-name", dir: occupiedTarget },
      ]),
    ).toThrow('target "existing"');

    expect(existsSync(join(vaultPath, "skillmux.toml"))).toBe(false);
    expect(existsSync(freshTarget)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("rejects the vault itself as a managed-pins target", () => {
    const vaultPath = tmpDir("skillmux-init-full-vault-");

    expect(() => applyInit(vaultPath, [{ name: "agents", dir: vaultPath }])).toThrow("full-vault");
    expect(existsSync(join(vaultPath, "skillmux.toml"))).toBe(false);
    expect(existsSync(join(vaultPath, ".skillmux"))).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("migrates a full-vault symlink only when explicitly requested", () => {
    const root = tmpDir("skillmux-init-full-vault-migration-");
    const vaultPath = join(root, "vault");
    const targetDir = join(root, "client-skills");
    mkdirSync(vaultPath);
    writeSkill(vaultPath, "kept-core");
    writeSkill(vaultPath, "becomes-on-demand");
    symlinkSync(vaultPath, targetDir);

    const manifest = applyInit(
      vaultPath,
      [{ name: "client", dir: targetDir, migrateFullVault: true }],
      undefined,
      ["kept-core"],
    );

    expect(lstatSync(targetDir).isDirectory()).toBe(true);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
    expect(readSkillmuxMarker(targetDir)?.target).toBe("client");
    expect(manifest.core.skills).toEqual(["kept-core"]);

    rmSync(root, { recursive: true, force: true });
  });

  test("writes skr.toml with an empty core and the confirmed targets, then adopts each dir in place", () => {
    const vaultPath = tmpDir("skillmux-init-apply-vault-");
    const claudeDir = tmpDir("skillmux-init-apply-claude-");
    writeFileSync(join(claudeDir, "pre-existing-skill.md"), "not touched by init");

    const manifest = applyInit(vaultPath, [{ name: "claude", dir: claudeDir }]);

    expect(manifest).toEqual({
      core: { skills: [] },
      project: {},
      targets: { claude: { dir: claudeDir, host: hostname(), project_groups: [] } },
    });
    expect(readFileSync(join(vaultPath, "skillmux.toml"), "utf-8")).toContain("[targets.claude]");
    expect(readSkillmuxMarker(claudeDir)?.target).toBe("claude");
    expect(readFileSync(join(claudeDir, "pre-existing-skill.md"), "utf-8")).toBe("not touched by init");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  test("creates a confirmed target dir that doesn't exist yet before adopting it", () => {
    const vaultPath = tmpDir("skillmux-init-apply-vault-");
    const targetDir = join(tmpDir("skillmux-init-apply-fresh-"), "claude");

    applyInit(vaultPath, [{ name: "claude", dir: targetDir }]);

    expect(readSkillmuxMarker(targetDir)?.target).toBe("claude");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("rolls back a transaction participant when the manifest commit fails", () => {
    const root = tmpDir("skillmux-init-participant-rollback-");
    const vaultPath = join(root, "vault");
    const targetDir = join(root, "target");
    const instructionPath = join(root, "instructions.md");
    mkdirSync(vaultPath);

    expect(() =>
      applyInit(
        vaultPath,
        [{ name: "target", dir: targetDir }],
        {
          apply: () => {
            writeFileSync(instructionPath, "managed instructions\n");
            chmodSync(vaultPath, 0o500);
          },
          rollback: () => {
            chmodSync(vaultPath, 0o700);
            rmSync(instructionPath, { force: true });
          },
        },
      ),
    ).toThrow();

    expect(existsSync(instructionPath)).toBe(false);
    expect(existsSync(join(vaultPath, "skillmux.toml"))).toBe(false);
    expect(existsSync(targetDir)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("seeds only explicitly requested validated core skills", () => {
    const vaultPath = tmpDir("skillmux-init-core-vault-");
    const targetDir = tmpDir("skillmux-init-core-target-");
    writeSkill(vaultPath, "explicit-core");
    writeSkill(vaultPath, "not-selected");

    const manifest = applyInit(
      vaultPath,
      [{ name: "target", dir: targetDir }],
      undefined,
      ["explicit-core"],
    );

    expect(manifest.core.skills).toEqual(["explicit-core"]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("rejects an invalid explicit core skill before writing", () => {
    const vaultPath = tmpDir("skillmux-init-core-invalid-vault-");
    const targetDir = join(tmpDir("skillmux-init-core-invalid-target-"), "target");
    writeSkill(vaultPath, "available");

    expect(() =>
      applyInit(vaultPath, [{ name: "target", dir: targetDir }], undefined, ["missing"]),
    ).toThrow('[core] skill "missing"');
    expect(existsSync(join(vaultPath, "skillmux.toml"))).toBe(false);
    expect(existsSync(targetDir)).toBe(false);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(dirname(targetDir), { recursive: true, force: true });
  });
});
