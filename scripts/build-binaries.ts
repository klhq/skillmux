import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Compile targets for the published platform packages.
 *
 * `platform` and `arch` are the values `process.platform` and `process.arch`
 * report at runtime, not Bun's target spelling — the launcher builds the
 * platform package name from them, so Windows is `win32` and never `windows`.
 */
export type BinaryTarget = {
  target: Bun.Build.CompileTarget;
  platform: string;
  arch: string;
  binaryName: string;
};

export const BINARY_TARGETS: BinaryTarget[] = [
  { target: "bun-darwin-arm64", platform: "darwin", arch: "arm64", binaryName: "skillmux" },
  { target: "bun-darwin-x64", platform: "darwin", arch: "x64", binaryName: "skillmux" },
  { target: "bun-linux-x64", platform: "linux", arch: "x64", binaryName: "skillmux" },
  { target: "bun-linux-arm64", platform: "linux", arch: "arm64", binaryName: "skillmux" },
  { target: "bun-windows-x64", platform: "win32", arch: "x64", binaryName: "skillmux.exe" },
];

const ENTRYPOINT = join(import.meta.dir, "..", "src", "cli.ts");
const SHARP_STUB = join(import.meta.dir, "stubs", "sharp.ts");
const ONNXRUNTIME_STUB = join(import.meta.dir, "stubs", "onnxruntime-node.ts");

/** Where `onnxruntime-node` keeps the native binding for one target. */
export function onnxruntimeBindingDir(target: BinaryTarget): string {
  return join(
    import.meta.dir,
    "..",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    target.platform,
    target.arch,
  );
}

/**
 * The bundler resolves onnxruntime's addon path against the target platform, so
 * a target the package does not ship for fails the compile outright rather than
 * merely losing local inference.
 */
const stubOnnxruntime: import("bun").BunPlugin = {
  name: "stub-onnxruntime-node",
  setup(build) {
    build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({ path: ONNXRUNTIME_STUB }));
  },
};

/** Whether `onnxruntime-node` publishes a native binding for this target. */
export function hasNativeOnnxruntime(target: BinaryTarget): boolean {
  return existsSync(join(onnxruntimeBindingDir(target), "onnxruntime_binding.node"));
}

/**
 * `@huggingface/transformers` requires sharp eagerly, and its native bindings
 * cannot travel inside a single-file executable. Text embedding never uses it.
 */
const stubSharp: import("bun").BunPlugin = {
  name: "stub-sharp",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({ path: SHARP_STUB }));
  },
};

/**
 * Staged file name for one target. Windows keeps the `.exe` extension Bun
 * appends on its own; without it the compiler and the caller disagree on where
 * the artifact landed.
 */
export function stagedBinaryName(target: BinaryTarget): string {
  const suffix = target.binaryName.endsWith(".exe") ? ".exe" : "";
  return `skillmux-${target.platform}-${target.arch}${suffix}`;
}

/** Compiles one target into `outDir` and returns the executable path. */
export async function buildBinary(target: BinaryTarget, outDir: string): Promise<string> {
  const outfile = join(outDir, stagedBinaryName(target));

  const plugins = hasNativeOnnxruntime(target) ? [stubSharp] : [stubSharp, stubOnnxruntime];

  const result = await Bun.build({
    entrypoints: [ENTRYPOINT],
    target: "bun",
    plugins,
    compile: { target: target.target, outfile },
  });

  if (!result.success) {
    throw new AggregateError(result.logs, `failed to compile ${target.target}`);
  }

  return outfile;
}

/** Compiles every supported target into `outDir`, sequentially. */
export async function buildAll(outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });

  const outfiles: string[] = [];
  for (const target of BINARY_TARGETS) {
    outfiles.push(await buildBinary(target, outDir));
  }
  return outfiles;
}

if (import.meta.main) {
  const outDir = process.env.SKILLMUX_BINARY_OUT_DIR ?? join(import.meta.dir, "..", "dist", "bin");
  for (const outfile of await buildAll(outDir)) {
    console.log(outfile);
  }
}
