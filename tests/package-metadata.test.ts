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
