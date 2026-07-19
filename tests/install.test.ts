import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneToTemp, resolveRepoSource } from "../src/install";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function initFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "skr-install-fixture-"));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env: GIT_ENV });
  run(["init", "-q"]);
  writeFileSync(join(dir, "marker.txt"), "hello from fixture repo");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

describe("resolveRepoSource", () => {
  test("resolves GitHub shorthand owner/repo into a github.com clone URL", () => {
    const source = resolveRepoSource("runkids/skillshare");

    expect(source).toEqual({ url: "https://github.com/runkids/skillshare.git" });
  });

  test("resolves a trailing path as skillPath, selecting one skill in a multi-skill repo", () => {
    const source = resolveRepoSource("runkids/skillshare/skills/csv-formatter");

    expect(source).toEqual({
      url: "https://github.com/runkids/skillshare.git",
      skillPath: "skills/csv-formatter",
    });
  });

  test("passes a full https git URL through unchanged", () => {
    const source = resolveRepoSource("https://gitlab.example.com/team/skills.git");

    expect(source).toEqual({ url: "https://gitlab.example.com/team/skills.git" });
  });

  test("passes a git@ SSH URL through unchanged", () => {
    const source = resolveRepoSource("git@github.com:runkids/skillshare.git");

    expect(source).toEqual({ url: "git@github.com:runkids/skillshare.git" });
  });

  test("rejects a bare name with no owner segment", () => {
    expect(() => resolveRepoSource("skillshare")).toThrow(/owner\/repo/);
  });
});

describe("cloneToTemp", () => {
  test("clones a local git repo into a fresh temp directory", async () => {
    const fixtureDir = initFixtureRepo();

    const cloneDir = await cloneToTemp(`file://${fixtureDir}`);

    expect(existsSync(join(cloneDir, "marker.txt"))).toBe(true);
    expect(readFileSync(join(cloneDir, "marker.txt"), "utf-8")).toBe("hello from fixture repo");

    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  test("throws a clear error and leaves no temp directory when the source is unreachable", async () => {
    const nonexistentDir = join(tmpdir(), "skr-install-does-not-exist-12345");

    await expect(cloneToTemp(`file://${nonexistentDir}`)).rejects.toThrow(/git clone failed/);
  });
});
