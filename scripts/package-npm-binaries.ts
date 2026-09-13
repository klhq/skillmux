import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import rootPackage from "../package.json" with { type: "json" };
import {
  BINARY_TARGETS,
  type BinaryTarget,
  hasNativeOnnxruntime,
  onnxruntimeBindingDir,
  stagedBinaryName,
} from "./build-binaries";

/** Subdirectory the launcher adds to the platform's shared-library path. */
export const LIBRARY_DIR = "lib";

/**
 * Copies the shared libraries the embedded onnxruntime addon loads at runtime.
 *
 * The addon itself already travels inside the executable; what Bun cannot embed
 * is the library it links against, which is why an unaided binary dies on
 * `@rpath/libonnxruntime...`. Returns whether anything was copied.
 */
async function copyOnnxruntimeLibraries(target: BinaryTarget, packageDir: string): Promise<boolean> {
  if (!hasNativeOnnxruntime(target)) return false;

  const sourceDir = onnxruntimeBindingDir(target);
  const libraries = readdirSync(sourceDir).filter((entry) => !entry.endsWith(".node"));
  if (libraries.length === 0) return false;

  mkdirSync(join(packageDir, LIBRARY_DIR), { recursive: true });
  for (const library of libraries) {
    await Bun.write(join(packageDir, LIBRARY_DIR, library), Bun.file(join(sourceDir, library)));
  }
  return true;
}

/**
 * Scoped name of the platform package for one target. The launcher rebuilds
 * this string at runtime from `process.platform` and `process.arch`, so the two
 * spellings must never drift apart.
 */
export function platformPackageName(target: BinaryTarget): string {
  return `@klhapp/skillmux-${target.platform}-${target.arch}`;
}

/**
 * Writes one publishable platform package into `outRoot` and returns its
 * directory. `os` and `cpu` are what let npm and bun install exactly one of
 * these on a given machine and reject the rest.
 */
export async function packagePlatform(
  target: BinaryTarget,
  stagedBinary: string,
  outRoot: string,
): Promise<string> {
  const packageDir = join(outRoot, platformPackageName(target));
  mkdirSync(packageDir, { recursive: true });

  const hasLibraries = await copyOnnxruntimeLibraries(target, packageDir);

  const manifest = {
    name: platformPackageName(target),
    version: rootPackage.version,
    description: `Skillmux native executable for ${target.platform}-${target.arch}.`,
    license: rootPackage.license,
    repository: rootPackage.repository,
    os: [target.platform],
    cpu: [target.arch],
    bin: { skillmux: target.binaryName },
    files: hasLibraries ? [target.binaryName, LIBRARY_DIR] : [target.binaryName],
    publishConfig: { access: "public" },
  };

  await Bun.write(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const executable = join(packageDir, target.binaryName);
  await Bun.write(executable, Bun.file(stagedBinary));
  chmodSync(executable, 0o755);

  return packageDir;
}

/**
 * Packages every staged executable found in `binDir` into `outRoot`.
 *
 * A missing executable is fatal rather than skipped: publishing a partial set
 * leaves `optionalDependencies` pointing at versions that do not exist, and npm
 * reports that as a bare install failure on the affected platform only.
 */
export async function packageAll(binDir: string, outRoot: string): Promise<string[]> {
  mkdirSync(outRoot, { recursive: true });

  const packageDirs: string[] = [];
  for (const target of BINARY_TARGETS) {
    const staged = join(binDir, stagedBinaryName(target));
    if (!existsSync(staged)) {
      throw new Error(`missing staged executable for ${platformPackageName(target)}: ${staged}`);
    }
    packageDirs.push(await packagePlatform(target, staged, outRoot));
  }
  return packageDirs;
}

if (import.meta.main) {
  const distDir = join(import.meta.dir, "..", "dist");
  const binDir = process.env.SKILLMUX_BINARY_OUT_DIR ?? join(distDir, "bin");
  const outRoot = process.env.SKILLMUX_NPM_OUT_DIR ?? join(distDir, "npm");

  for (const packageDir of await packageAll(binDir, outRoot)) {
    console.log(packageDir);
  }
}
