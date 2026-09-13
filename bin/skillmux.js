#!/bin/sh
// 2>/dev/null; exec "$(command -v bun || command -v node)" "$0" "$@"
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// `new URL(...).pathname` yields "/C:/..." on Windows; fileURLToPath does not.
const here = dirname(fileURLToPath(import.meta.url));

const platformPackage = `@klhapp/skillmux-${process.platform}-${process.arch}`;
const executableName = process.platform === "win32" ? "skillmux.exe" : "skillmux";

/**
 * Resolves the platform package directory.
 *
 * The search paths matter: a globally installed launcher resolves from its own
 * directory, while a linked or hoisted layout can leave the real path outside
 * the install tree, which is what the working directory covers.
 */
function resolvePackageDir() {
  try {
    return dirname(
      require.resolve(`${platformPackage}/package.json`, {
        paths: [here, dirname(process.argv[1] ?? "."), process.cwd()],
      }),
    );
  } catch {
    return null;
  }
}

const packageDir = resolvePackageDir();

if (!packageDir && !process.env.SKILLMUX_BINARY) {
  process.stderr.write(
    `skillmux: no native executable for ${process.platform}-${process.arch}.\n` +
      `The package ${platformPackage} is not installed.\n\n` +
      "Reinstall without skipping optional dependencies:\n" +
      "  npm install -g @klhapp/skillmux\n\n" +
      "Or install a standalone executable:\n" +
      "  https://github.com/klhq/skillmux/releases\n",
  );
  process.exit(1);
}

const executable = process.env.SKILLMUX_BINARY || join(packageDir, executableName);

// The compiled binary embeds onnxruntime's addon but not the library it links
// against, so without this the local embedding pipeline dies on a dlopen of
// @rpath/libonnxruntime. Platforms onnxruntime does not publish, such as Intel
// macOS, ship no lib directory and fall back to lexical recall.
const LIBRARY_PATH_VARIABLES = {
  darwin: "DYLD_FALLBACK_LIBRARY_PATH",
  linux: "LD_LIBRARY_PATH",
  win32: "PATH",
};

const env = { ...process.env };
const libraryDir = packageDir ? join(packageDir, "lib") : null;
const libraryVariable = LIBRARY_PATH_VARIABLES[process.platform];

if (libraryDir && libraryVariable && existsSync(libraryDir)) {
  const existing = env[libraryVariable];
  env[libraryVariable] = existing ? `${libraryDir}${delimiter}${existing}` : libraryDir;
}

const child = spawn(executable, process.argv.slice(2), { stdio: "inherit", env });

// Without this the launcher would absorb the signal and leave the executable
// running, which matters most for `serve`: a container stop sends SIGTERM and
// expects the HTTP server itself to shut down.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`skillmux: cannot run ${executable}: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
});
