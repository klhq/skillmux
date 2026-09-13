import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

describe("package.json binary rename (skillmux)", () => {
  test("bin exposes the CLI entrypoint as skillmux", () => {
    expect(pkg.bin).toEqual({ skillmux: "./src/cli.ts" });
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
});
