import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { BINARY_TARGETS } from "../scripts/build-binaries";
import { platformPackageName } from "../scripts/package-npm-binaries";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

describe("package.json binary rename (skillmux)", () => {
  test("bin exposes the native launcher as skillmux", () => {
    expect(pkg.bin).toEqual({ skillmux: "./bin/skillmux.js" });
  });

  test("build script compiles dist/skillmux", () => {
    expect(pkg.scripts.build).toBe("bun build --compile src/cli.ts --outfile dist/skillmux");
  });
});

describe("package.json binary distribution (AC1)", () => {
  test("build:binaries stages every platform executable under dist/bin", () => {
    expect(pkg.scripts["build:binaries"]).toBe("bun run scripts/build-binaries.ts");
  });

  test("build:npm-packages turns staged executables into platform packages", () => {
    expect(pkg.scripts["build:npm-packages"]).toBe("bun run scripts/package-npm-binaries.ts");
  });

  test("every platform package is an optional dependency pinned to this version", () => {
    const expected = Object.fromEntries(
      BINARY_TARGETS.map((target) => [platformPackageName(target), pkg.version]),
    );

    expect(pkg.optionalDependencies).toEqual(expected);
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
