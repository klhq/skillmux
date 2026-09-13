import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { BINARY_TARGETS, buildAll, buildBinary, selectTargets } from "../scripts/build-binaries";

describe("build-binaries target matrix (AC1)", () => {
  test("maps every compile target to its npm platform and arch names", () => {
    expect(BINARY_TARGETS).toEqual([
      { target: "bun-darwin-arm64", platform: "darwin", arch: "arm64", binaryName: "skillmux" },
      { target: "bun-darwin-x64", platform: "darwin", arch: "x64", binaryName: "skillmux" },
      { target: "bun-linux-x64", platform: "linux", arch: "x64", binaryName: "skillmux" },
      { target: "bun-linux-arm64", platform: "linux", arch: "arm64", binaryName: "skillmux" },
      { target: "bun-windows-x64", platform: "win32", arch: "x64", binaryName: "skillmux.exe" },
    ]);
  });
});

describe("build-binaries compilation (AC1)", () => {
  test("compiles the host target into a runnable executable", async () => {
    const hostTarget = BINARY_TARGETS.find(
      (candidate) => candidate.platform === process.platform && candidate.arch === process.arch,
    );
    if (!hostTarget) throw new Error(`no build target for ${process.platform}-${process.arch}`);

    const outDir = mkdtempSync(join(tmpdir(), "skillmux-build-binaries-"));
    try {
      const outfile = await buildBinary(hostTarget, outDir);

      expect(outfile).toBe(join(outDir, `skillmux-${hostTarget.platform}-${hostTarget.arch}`));
      expect(statSync(outfile).isFile()).toBe(true);

      const proc = Bun.spawn([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(packageJson.version);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});

const LIBRARY_PATH_VARIABLES: Record<string, string> = {
  darwin: "DYLD_FALLBACK_LIBRARY_PATH",
  linux: "LD_LIBRARY_PATH",
  win32: "PATH",
};

describe("build-binaries sharp stub (AC1)", () => {
  test("compiled binary embeds locally instead of failing on sharp", async () => {
    const hostTarget = BINARY_TARGETS.find(
      (candidate) => candidate.platform === process.platform && candidate.arch === process.arch,
    );
    if (!hostTarget) throw new Error(`no build target for ${process.platform}-${process.arch}`);

    const tmp = mkdtempSync(join(tmpdir(), "skillmux-sharp-stub-"));
    try {
      const outfile = await buildBinary(hostTarget, tmp);

      mkdirSync(join(tmp, "vault", "example"), { recursive: true });
      writeFileSync(
        join(tmp, "vault", "example", "SKILL.md"),
        "---\nname: example\ndescription: Sharp stub verification skill.\n---\n\n# Example\n",
      );
      const configPath = join(tmp, "config.toml");
      writeFileSync(configPath, `vault_path = "${join(tmp, "vault")}"\n`);

      const libraryDir = join(
        import.meta.dir,
        "..",
        "node_modules",
        "onnxruntime-node",
        "bin",
        "napi-v6",
        hostTarget.platform,
        hostTarget.arch,
      );
      const variable = LIBRARY_PATH_VARIABLES[hostTarget.platform]!;

      const proc = Bun.spawn([outfile, "index"], {
        env: {
          ...(process.env as Record<string, string>),
          [variable]: [libraryDir, process.env[variable]].filter(Boolean).join(":"),
          SKILLMUX_CONFIG: configPath,
          SKILLMUX_MODELS_DIR: join(import.meta.dir, "..", ".models"),
          SKILLMUX_STATE_DIR: join(tmp, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).not.toContain("sharp");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("embeddings: 1 backfilled");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("build-binaries full matrix (AC1)", () => {
  test("builds an executable for every supported target", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "skillmux-build-all-"));
    try {
      const outfiles = await buildAll(outDir);

      expect(outfiles).toHaveLength(BINARY_TARGETS.length);
      for (const outfile of outfiles) {
        expect(statSync(outfile).size).toBeGreaterThan(1_000_000);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("build-binaries target selection (AC1)", () => {
  test("narrows to one target and rejects an unknown one", () => {
    expect(selectTargets("linux-arm64")).toEqual([
      { target: "bun-linux-arm64", platform: "linux", arch: "arm64", binaryName: "skillmux" },
    ]);
    expect(selectTargets()).toEqual(BINARY_TARGETS);
    expect(() => selectTargets("linux-amd64")).toThrow(/linux-amd64/);
  });
});

describe("build-binaries host target (AC1)", () => {
  test('resolves "host" to the target matching this machine', () => {
    expect(selectTargets("host")).toEqual([
      BINARY_TARGETS.find(
        (target) => target.platform === process.platform && target.arch === process.arch,
      )!,
    ]);
  });
});
