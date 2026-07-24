import { describe, expect, test } from "bun:test";
import { resolveProjectDirectory } from "../src/project-setup";

describe("resolveProjectDirectory", () => {
  test("uses the current Git root before the current directory", () => {
    expect(resolveProjectDirectory(undefined, {
      cwd: "/work/repo/packages/app",
      findGitRoot: () => "/work/repo",
    })).toBe("/work/repo");
  });
});
