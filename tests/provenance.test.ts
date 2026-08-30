import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillContent, readSkillOrigin, writeSkillOrigin } from "../src/provenance";

function makeSkillDir(): string {
  const vaultDir = mkdtempSync(join(tmpdir(), "skillmux-provenance-"));
  const skillDir = join(vaultDir, "my-skill");
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

describe("hashSkillContent", () => {
  test("returns a 64-char lowercase hex sha256 digest for a skill directory", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nbody");

    const hash = hashSkillContent(skillDir);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("changes when SKILL.md content changes", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nbody");
    const before = hashSkillContent(skillDir);

    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nedited body");

    expect(hashSkillContent(skillDir)).not.toBe(before);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("changes when a supporting file's content changes", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nbody");
    writeFileSync(join(skillDir, "reference.md"), "v1");
    const before = hashSkillContent(skillDir);

    writeFileSync(join(skillDir, "reference.md"), "v2");

    expect(hashSkillContent(skillDir)).not.toBe(before);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("AC2: is unaffected by the presence or content of the .skillmux-origin sidecar itself", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nbody");
    const before = hashSkillContent(skillDir);

    writeFileSync(join(skillDir, ".skillmux-origin"), JSON.stringify({ anything: "goes here" }));

    expect(hashSkillContent(skillDir)).toBe(before);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: refuses to hash a symlinked SKILL.md instead of following it", () => {
    const skillDir = makeSkillDir();
    const secretPath = join(skillDir, "..", "secret.txt");
    writeFileSync(secretPath, "TOP SECRET HOST FILE CONTENTS");
    symlinkSync(secretPath, join(skillDir, "SKILL.md"));

    expect(() => hashSkillContent(skillDir)).toThrow();

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: refuses to hash through a symlinked skill directory even when SKILL.md itself is a real file", () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "skillmux-provenance-dirsymlink-vault-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "skillmux-provenance-dirsymlink-outside-"));
    writeFileSync(join(outsideDir, "SKILL.md"), "EVIL PAYLOAD FROM OUTSIDE VAULT");
    const skillDir = join(vaultDir, "my-skill");
    symlinkSync(outsideDir, skillDir);

    expect(() => hashSkillContent(skillDir)).toThrow();

    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("writeSkillOrigin / readSkillOrigin", () => {
  test("round-trips the fields written, stamping schema_version 1", () => {
    const skillDir = makeSkillDir();

    writeSkillOrigin(skillDir, {
      source_url: "https://github.com/owner/repo.git",
      skill_path: "skills/my-skill",
      commit: "a".repeat(40),
      installed_at: "2026-08-29T00:00:00.000Z",
      content_hash: "b".repeat(64),
    });
    const origin = readSkillOrigin(skillDir);

    expect(origin).toEqual({
      schema_version: 1,
      source_url: "https://github.com/owner/repo.git",
      skill_path: "skills/my-skill",
      commit: "a".repeat(40),
      installed_at: "2026-08-29T00:00:00.000Z",
      content_hash: "b".repeat(64),
    });

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("returns null when no sidecar file exists", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: My Skill\n---\nbody");

    expect(readSkillOrigin(skillDir)).toBeNull();

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: refuses to read a symlinked .skillmux-origin instead of following it", () => {
    const skillDir = makeSkillDir();
    const secretPath = join(skillDir, "..", "secret.txt");
    writeFileSync(secretPath, "TOP SECRET HOST FILE CONTENTS");
    symlinkSync(secretPath, join(skillDir, ".skillmux-origin"));

    expect(() => readSkillOrigin(skillDir)).toThrow(/symlink/);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: refuses to read .skillmux-origin through a symlinked skill directory even when the sidecar itself is a real file", () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "skillmux-provenance-origin-dirsymlink-vault-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "skillmux-provenance-origin-dirsymlink-outside-"));
    writeFileSync(
      join(outsideDir, ".skillmux-origin"),
      JSON.stringify({
        schema_version: 1,
        source_url: "https://github.com/owner/repo.git",
        commit: "a".repeat(40),
        installed_at: "2026-08-29T00:00:00.000Z",
        content_hash: "b".repeat(64),
      }),
    );
    const skillDir = join(vaultDir, "my-skill");
    symlinkSync(outsideDir, skillDir);

    expect(() => readSkillOrigin(skillDir)).toThrow(/symlink/);

    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("throws a clear error for an unsupported schema_version", () => {
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, ".skillmux-origin"), JSON.stringify({ schema_version: 2 }));

    expect(() => readSkillOrigin(skillDir)).toThrow(/schema_version/);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: rejects a source_url that isn't a recognized git protocol (blocks ext:: / argument injection via a tampered sidecar)", () => {
    const skillDir = makeSkillDir();
    writeFileSync(
      join(skillDir, ".skillmux-origin"),
      JSON.stringify({
        schema_version: 1,
        source_url: "ext::sh -c touch /tmp/pwned",
        commit: "a".repeat(40),
        installed_at: "2026-08-29T00:00:00.000Z",
        content_hash: "b".repeat(64),
      }),
    );

    expect(() => readSkillOrigin(skillDir)).toThrow(/source_url/);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("security: rejects a scp-like source_url starting with '-' (argument injection into git ls-remote/clone via a tampered sidecar)", () => {
    // Verified against git 2.55: `outdated`/`update` pass source_url straight
    // through as the positional argument to `git ls-remote`/`git clone`. A
    // string shaped like `--upload-pack=<cmd>@host:path` is parsed by git as
    // the --upload-pack option rather than a repository, and git actually runs
    // <cmd> as a local shell command — a forged sidecar reaches real code
    // execution the moment `skillmux outdated` (read-only, no --yes) touches it.
    const skillDir = makeSkillDir();
    writeFileSync(
      join(skillDir, ".skillmux-origin"),
      JSON.stringify({
        schema_version: 1,
        source_url: "--upload-pack=touch${IFS}PWNED@host:repo.git",
        commit: "a".repeat(40),
        installed_at: "2026-08-29T00:00:00.000Z",
        content_hash: "b".repeat(64),
      }),
    );

    expect(() => readSkillOrigin(skillDir)).toThrow(/source_url/);

    rmSync(skillDir, { recursive: true, force: true });
  });

  test("--force reinstall overwrites a prior sidecar with fresh values (AC1)", () => {
    const skillDir = makeSkillDir();
    writeSkillOrigin(skillDir, {
      source_url: "https://github.com/owner/repo.git",
      commit: "a".repeat(40),
      installed_at: "2026-08-29T00:00:00.000Z",
      content_hash: "b".repeat(64),
    });

    writeSkillOrigin(skillDir, {
      source_url: "https://github.com/owner/repo.git",
      commit: "c".repeat(40),
      installed_at: "2026-08-29T01:00:00.000Z",
      content_hash: "d".repeat(64),
    });

    expect(readSkillOrigin(skillDir)).toEqual({
      schema_version: 1,
      source_url: "https://github.com/owner/repo.git",
      commit: "c".repeat(40),
      installed_at: "2026-08-29T01:00:00.000Z",
      content_hash: "d".repeat(64),
    });

    rmSync(skillDir, { recursive: true, force: true });
  });
});
