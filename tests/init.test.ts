import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInit, deriveTargetName, detectSurfaces, printLastMile, proposeManifest } from "../src/init";
import { readSkrMarker } from "../src/sync";

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
    const root = tmpDir("skill-router-init-detect-");
    const surface = join(root, "skills");
    mkdirSync(surface);
    writeSkill(surface, "writing-clearly");
    writeSkill(surface, "code-review");

    const [candidate] = detectSurfaces([surface]);

    expect(candidate).toEqual({ path: surface, exists: true, isSymlink: false, skillCount: 2, alreadyMarked: false });

    rmSync(root, { recursive: true, force: true });
  });

  test("reports a symlinked surface as a symlink (evidence: real dir vs symlink to a monolith)", () => {
    const root = tmpDir("skill-router-init-detect-");
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

    expect(text).toContain(`"command": "skr"`);
    expect(text).toContain("resolve_skill");
    expect(text).toContain("no_match");
  });
});

describe("applyInit", () => {
  test("writes skr.toml with an empty core and the confirmed targets, then adopts each dir in place", () => {
    const vaultPath = tmpDir("skill-router-init-apply-vault-");
    const claudeDir = tmpDir("skill-router-init-apply-claude-");
    writeFileSync(join(claudeDir, "pre-existing-skill.md"), "not touched by init");

    const manifest = applyInit(vaultPath, [{ name: "claude", dir: claudeDir }]);

    expect(manifest).toEqual({
      core: { skills: [] },
      project: {},
      targets: { claude: { dir: claudeDir, project: false } },
    });
    expect(readFileSync(join(vaultPath, "skr.toml"), "utf-8")).toContain("[targets.claude]");
    expect(readSkrMarker(claudeDir)?.target).toBe("claude");
    expect(readFileSync(join(claudeDir, "pre-existing-skill.md"), "utf-8")).toBe("not touched by init");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  test("creates a confirmed target dir that doesn't exist yet before adopting it", () => {
    const vaultPath = tmpDir("skill-router-init-apply-vault-");
    const targetDir = join(tmpDir("skill-router-init-apply-fresh-"), "claude");

    applyInit(vaultPath, [{ name: "claude", dir: targetDir }]);

    expect(readSkrMarker(targetDir)?.target).toBe("claude");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
});
