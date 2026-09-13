import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { BINARY_TARGETS, stagedBinaryName } from "../scripts/build-binaries";
import { packageAll, packagePlatform, platformPackageName } from "../scripts/package-npm-binaries";

function targetFor(platform: string, arch: string) {
  const target = BINARY_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) throw new Error(`no build target for ${platform}-${arch}`);
  return target;
}

describe("platform package metadata (AC2)", () => {
  test("declares the os and cpu npm needs to pick exactly one package", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-platform-package-"));
    try {
      const target = targetFor("linux", "arm64");
      const staged = join(tmp, "skillmux-linux-arm64");
      await Bun.write(staged, "#!/bin/sh\nexit 0\n");

      const packageDir = await packagePlatform(target, staged, tmp);

      const manifest = await Bun.file(join(packageDir, "package.json")).json();
      expect(manifest.name).toBe("@klhapp/skillmux-linux-arm64");
      expect(manifest.name).toBe(platformPackageName(target));
      expect(manifest.version).toBe(packageJson.version);
      expect(manifest.os).toEqual(["linux"]);
      expect(manifest.cpu).toEqual(["arm64"]);
      expect(manifest.bin).toEqual({ skillmux: "skillmux" });

      const executable = statSync(join(packageDir, "skillmux"));
      expect(executable.mode & 0o777).toBe(0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("platform package onnxruntime payload (AC3)", () => {
  test("ships the shared libraries the embedded addon needs, but not the addon", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-onnx-payload-"));
    try {
      const target = targetFor("linux", "arm64");
      const staged = join(tmp, "skillmux-linux-arm64");
      await Bun.write(staged, "#!/bin/sh\nexit 0\n");

      const packageDir = await packagePlatform(target, staged, tmp);

      const manifest = await Bun.file(join(packageDir, "package.json")).json();
      expect(manifest.files).toContain("lib");
      expect(existsSync(join(packageDir, "lib", "libonnxruntime.so.1"))).toBe(true);
      expect(existsSync(join(packageDir, "lib", "onnxruntime_binding.node"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("platform package onnxruntime exemption (AC3)", () => {
  test("omits the library payload where onnxruntime publishes no build", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-onnx-exempt-"));
    try {
      const target = targetFor("darwin", "x64");
      const staged = join(tmp, "skillmux-darwin-x64");
      await Bun.write(staged, "#!/bin/sh\nexit 0\n");

      const packageDir = await packagePlatform(target, staged, tmp);

      const manifest = await Bun.file(join(packageDir, "package.json")).json();
      expect(manifest.files).toEqual(["skillmux"]);
      expect(existsSync(join(packageDir, "lib"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("platform package staging (AC2)", () => {
  test("packages every staged executable and rejects a missing one", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-package-all-"));
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    try {
      for (const target of BINARY_TARGETS) {
        await Bun.write(join(binDir, stagedBinaryName(target)), "#!/bin/sh\nexit 0\n");
      }

      const packageDirs = await packageAll(binDir, join(tmp, "npm"));
      expect(packageDirs).toHaveLength(BINARY_TARGETS.length);

      rmSync(join(binDir, stagedBinaryName(BINARY_TARGETS[0]!)));
      await expect(packageAll(binDir, join(tmp, "npm-again"))).rejects.toThrow(
        /skillmux-darwin-arm64/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
