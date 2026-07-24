import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      { path: "/does/not/exist/on/this/machine", exists: false, isSymlink: false, skillCount: 0, alreadyMarked: false },
    ]);
  });

  test("reports a real directory's skill count and marker status", () => {
    const root = tmpDir("skillmux-init-detect-");
    const surface = join(root, "skills");
    mkdirSync(surface);
    writeSkill(surface, "writing-clearly");
    writeSkill(surface, "code-review");

    const [candidate] = detectSurfaces([surface]);

    expect(candidate).toEqual({ path: surface, exists: true, isSymlink: false, skillCount: 2, alreadyMarked: false });

    rmSync(root, { recursive: true, force: true });
  });

  test("reports a symlinked surface as a symlink (evidence: real dir vs symlink to a monolith)", () => {
    const root = tmpDir("skillmux-init-detect-");
    const vault = join(root, "vault");
    mkdirSync(vault);
    writeSkill(vault, "writing-clearly");
    const surface = join(root, "skills");
    symlinkSync(vault, surface);

    const candidate = detectSurfaces([surface])[0]!;

    expect(candidate.exists).toBe(true);
    expect(candidate.isSymlink).toBe(true);
    expect(candidate.skillCount).toBe(1);

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
          project_groups: [],
        },
      },
    });

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
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

  test("writes skr.toml with an empty core and the confirmed targets, then adopts each dir in place", () => {
    const vaultPath = tmpDir("skillmux-init-apply-vault-");
    const claudeDir = tmpDir("skillmux-init-apply-claude-");
    writeFileSync(join(claudeDir, "pre-existing-skill.md"), "not touched by init");

    const manifest = applyInit(vaultPath, [{ name: "claude", dir: claudeDir }]);

    expect(manifest).toEqual({
      core: { skills: [] },
      project: {},
      targets: { claude: { dir: claudeDir, project_groups: [] } },
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
});
