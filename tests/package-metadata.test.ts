import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BINARY_TARGETS } from "../scripts/build-binaries";
import { applyPlatformPins } from "../scripts/apply-platform-pins";
import { platformPackageName } from "../scripts/package-npm-binaries";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

describe("package.json binary rename (skillmux)", () => {
  test("bin exposes the native launcher as skillmux", () => {
    expect(pkg.bin).toEqual({ skillmux: "./bin/skillmux.js" });
  });

  test("build compiles this machine's executable through the packaging path", () => {
    // A raw `bun build --compile` skips the sharp stub, and the executable it
    // produces cannot load the local embedding pipeline at all.
    expect(pkg.scripts.build).toBe("bun run scripts/build-binaries.ts host");
  });
});

describe("package.json binary distribution (AC1)", () => {
  test("build:binaries stages every platform executable under dist/bin", () => {
    expect(pkg.scripts["build:binaries"]).toBe("bun run scripts/build-binaries.ts");
  });

  test("build:npm-packages turns staged executables into platform packages", () => {
    expect(pkg.scripts["build:npm-packages"]).toBe("bun run scripts/package-npm-binaries.ts");
  });

  test("declares no runtime dependencies, since the executable bundles them", () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  test("the committed manifest declares no platform packages", () => {
    // Declaring them here would make the root package depend on artifacts this
    // repository builds, so every install would pull down the previous
    // release's binaries, and the lockfile would go stale on every version
    // bump. They are injected at publish time instead.
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  test("the publish-time injection pins every platform package to the manifest version", () => {
    const manifest = join(tmpdir(), `skillmux-pins-${Date.now()}.json`);
    writeFileSync(manifest, JSON.stringify({ name: "@klhapp/skillmux", version: "9.9.9" }));
    try {
      applyPlatformPins(manifest);
      const written = JSON.parse(readFileSync(manifest, "utf8")) as {
        optionalDependencies: Record<string, string>;
      };

      expect(written.optionalDependencies).toEqual(
        Object.fromEntries(
          BINARY_TARGETS.map((target) => [platformPackageName(target), "9.9.9"]),
        ),
      );
    } finally {
      rmSync(manifest, { force: true });
    }
  });

  test("the injection refuses a manifest with no version rather than pinning nothing", () => {
    const manifest = join(tmpdir(), `skillmux-pins-bad-${Date.now()}.json`);
    writeFileSync(manifest, JSON.stringify({ name: "@klhapp/skillmux" }));
    try {
      expect(() => applyPlatformPins(manifest)).toThrow(/no version/);
    } finally {
      rmSync(manifest, { force: true });
    }
  });
});

describe("published tarball contents (AC13)", () => {
  test("ships the launcher and none of the TypeScript sources", async () => {
    const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);

    const paths = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map(
      (file) => file.path,
    );

    expect(paths).toContain("bin/skillmux.js");
    expect(paths.filter((path) => path.startsWith("src/"))).toEqual([]);
  }, 120_000);
});
