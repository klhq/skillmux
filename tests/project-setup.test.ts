import { describe, expect, test } from "bun:test";
import { resolveProjectDirectory, suggestProjectName } from "../src/project-setup";

describe("resolveProjectDirectory", () => {
  test("uses the current Git root before the current directory", () => {
    expect(resolveProjectDirectory(undefined, {
      cwd: "/work/repo/packages/app",
      findGitRoot: () => "/work/repo",
    })).toBe("/work/repo");
  });
});

test("suggestProjectName produces a valid manifest group name", () => {
  expect(suggestProjectName("123 My Cool.App")).toBe("project-123-my-cool-app");
});
