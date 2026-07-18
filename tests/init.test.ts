import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSurfaces, proposeManifest } from "../src/init";

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

    const [candidate] = detectSurfaces([surface]);

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
