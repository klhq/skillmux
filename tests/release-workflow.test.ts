import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BINARY_TARGETS } from "../scripts/build-binaries";
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
});

describe("release version pins (AC4)", () => {
  test("Release Please rewrites every platform pin alongside the version", () => {
    const config = JSON.parse(readFileSync(join(repoRoot, "release-please-config.json"), "utf8")) as {
      packages: Record<string, { "extra-files"?: { path: string; jsonpath: string }[] }>;
    };
    const extraFiles = config.packages["."]!["extra-files"] ?? [];

    expect(extraFiles.map((entry) => entry.jsonpath).sort()).toEqual(
      BINARY_TARGETS.map(
        (target) => `$.optionalDependencies['${platformPackageName(target)}']`,
      ).sort(),
    );
    // "$.a.['b']" is a jsonpath parse error, and a broken updater silently
    // leaves the pins behind at release time.
    for (const entry of extraFiles) expect(entry.jsonpath).not.toContain(".['");
  });
});
