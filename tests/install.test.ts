import { describe, expect, test } from "bun:test";
import { resolveRepoSource } from "../src/install";

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
