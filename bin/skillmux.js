#!/bin/sh
':' /* 2>/dev/null
# POSIX fast path.
#
# Everything below is shell, and Node reads it as a block comment. It exists
# because the JavaScript launcher underneath only computes a path and then
# execs the compiled binary, and booting a JavaScript runtime to do that costs
# more than the work itself: measured on darwin-arm64, node takes about 25ms to
# reach its first statement and bun about 6ms, against roughly 3ms for /bin/sh.
# Resolving the binary here removes that boot entirely, and exec replaces the
# process, so exit codes and signals reach the binary with no parent left
# forwarding them.
#
# This path deliberately handles only the layouts a real install produces.
# Anything it does not recognise falls through to the JavaScript launcher,
# which owns the full resolution order and the diagnostics. Windows never
# reaches this code: npm's generated shims run the file through node.

# Every external command costs a fork and exec, measured at roughly 1.5ms each
# here, against 3.7ms for the whole shell. An early version of this path used
# dirname, uname and a cd/pwd subshell and was no faster than booting node. So
# the only external left is readlink, and it runs solely when $0 really is a
# symlink; directory names come from parameter expansion, and the architecture
# comes from a glob rather than uname.

# The two-character sequence that closes a C block comment must never appear
# anywhere in this shell section, because Node reads the whole section as one
# such comment and would stop early. That is why the pattern below quotes its
# separator instead of being written the obvious way. A test enforces this.
sm_dirname() {
  case $1 in
    *"/"*) sm_dir=${1%"/"*} ;;
    *) sm_dir=. ;;
  esac
}

# npm links the bin entry, so $0 is usually a symlink into the install tree.
# readlink is silenced and bounded: a PATH without it, or a symlink cycle, has
# to leave the slow path intact rather than leak an error or spin.
sm_self=$0
sm_hops=0
while [ -L "$sm_self" ] && [ "$sm_hops" -lt 32 ]; do
  sm_hops=$((sm_hops + 1))
  sm_link=$(readlink "$sm_self" 2>/dev/null) || break
  [ -n "$sm_link" ] || break
  case $sm_link in
    /*) sm_self=$sm_link ;;
    *)
      sm_dirname "$sm_self"
      sm_self=$sm_dir/$sm_link
      ;;
  esac
done

# $PWD keeps this absolute without spawning pwd. The path is not normalised,
# which the filesystem and the dynamic loader both accept.
case $sm_self in
  /*) ;;
  *) sm_self=$PWD/$sm_self ;;
esac
sm_dirname "$sm_self"
sm_root=$sm_dir/..

# An override that is not executable falls through, so the JavaScript launcher
# reports it rather than this path failing silently.
if [ -n "$SKILLMUX_BINARY" ]; then
  if [ -x "$SKILLMUX_BINARY" ]; then
    exec "$SKILLMUX_BINARY" "$@"
  fi
else
  # Nested is what a plain `npm install -g` produces; the sibling path covers a
  # hoisted layout, where both packages sit side by side under @klhapp. Only
  # the matching platform package installs, thanks to its os and cpu fields, so
  # a single match is the expected case. Zero matches or an ambiguous tree both
  # fall through rather than guess at an architecture.
  sm_match=
  sm_count=0
  for sm_candidate in \
    "$sm_root"/node_modules/@klhapp/skillmux-*-* \
    "$sm_root"/../skillmux-*-*; do
    [ -x "$sm_candidate/skillmux" ] || continue
    sm_count=$((sm_count + 1))
    sm_match=$sm_candidate
  done

  if [ "$sm_count" -eq 1 ]; then
    if [ -d "$sm_match/lib" ]; then
      # The compiled binary embeds onnxruntime's addon but not the library it
      # links against. Without this the local embedding pipeline dies on a
      # dlopen of @rpath/libonnxruntime.
      case $sm_match in
        *-darwin-*)
          DYLD_FALLBACK_LIBRARY_PATH="$sm_match/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
          export DYLD_FALLBACK_LIBRARY_PATH
          ;;
        *-linux-*)
          LD_LIBRARY_PATH="$sm_match/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          export LD_LIBRARY_PATH
          ;;
      esac
    fi
    exec "$sm_match/skillmux" "$@"
  fi
fi

exec "$(command -v bun || command -v node)" "$0" "$@"
*/
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
