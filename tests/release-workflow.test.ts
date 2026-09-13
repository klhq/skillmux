import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BINARY_TARGETS } from "../scripts/build-binaries";
import { platformPins } from "../scripts/apply-platform-pins";
import { platformPackageName } from "../scripts/package-npm-binaries";

const repoRoot = join(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(join(repoRoot, ".github", "workflows", "release-please.yml"), "utf8"),
) as { jobs: Record<string, { needs?: string[]; steps?: { run?: string }[] }> };

describe("release ordering (AC14)", () => {
  test("publishes the platform packages before the root package", () => {
    expect(workflow.jobs["npm-platform"]).toBeDefined();
    expect(workflow.jobs["npmjs"]!.needs).toContain("npm-platform");
  });

  test("keeps the GitHub Release asset names the install procedures cite", () => {
    const staged = workflow.jobs["binaries"]!.steps!.map((step) => step.run ?? "").join("\n");

    expect(staged).toContain("dist/release/skillmux-linux-amd64");
    expect(staged).toContain("dist/release/skillmux-linux-arm64");
  });

  test("attaches an executable for every platform the launcher points at", () => {
    const uploaded = workflow.jobs["release-assets"]!.steps!.map((step) => step.run ?? "").join("\n");

    // The missing-package message sends every platform to the releases page,
    // so a macOS or Windows reader has to find something there.
    for (const asset of [
      "skillmux-linux-amd64",
      "skillmux-linux-arm64",
      "skillmux-darwin-arm64",
      "skillmux-darwin-x64",
      "skillmux-win32-x64.exe",
    ]) {
      expect(uploaded).toContain(asset);
    }
  });
});

describe("release version pins (AC4)", () => {
  test("Release Please no longer rewrites the pins in the committed manifest", () => {
    const config = JSON.parse(readFileSync(join(repoRoot, "release-please-config.json"), "utf8")) as {
      packages: Record<string, { "extra-files"?: { path: string; jsonpath: string }[] }>;
    };
    const extraFiles = config.packages["."]!["extra-files"] ?? [];

    // The updater edits package.json without re-running the package manager,
    // which left the lockfile stale after every release. The pins moved to
    // publish time, so nothing here should touch optionalDependencies.
    for (const entry of extraFiles) {
      expect(entry.jsonpath).not.toContain("optionalDependencies");
    }
  });

  for (const job of ["npmjs", "github-npm"]) {
    test(`${job} pins the platform packages before it publishes`, () => {
      const steps = workflow.jobs[job]!.steps!.map((step) => step.run ?? "");
      const pinned = steps.findIndex((run) => run.includes("pin:platform-packages"));
      const published = steps.findIndex((run) => /^npm publish\b/m.test(run.trim()));

      // Publishing without this step ships a root package whose platform
      // packages are absent, which leaves every user a launcher and no
      // executable.
      expect(pinned).toBeGreaterThanOrEqual(0);
      expect(published).toBeGreaterThanOrEqual(0);
      expect(pinned).toBeLessThan(published);
    });
  }

  test("the pinned names come from the same target list the build uses", () => {
    const expected = BINARY_TARGETS.map((target) => platformPackageName(target)).sort();

    expect(Object.keys(platformPins("1.0.0")).sort()).toEqual(expected);
  });
});
