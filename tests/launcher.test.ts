import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const launcher = join(import.meta.dir, "..", "bin", "skillmux.js");
const platformPackage = `@klhapp/skillmux-${process.platform}-${process.arch}`;
const nodePath = Bun.which("node");
if (!nodePath) throw new Error("these tests need node on PATH");

const LIBRARY_PATH_VARIABLE = {
  darwin: "DYLD_FALLBACK_LIBRARY_PATH",
  linux: "LD_LIBRARY_PATH",
  win32: "PATH",
}[process.platform as "darwin" | "linux" | "win32"]!;

/**
 * Builds the node_modules layout an installed platform package produces, plus
 * a copy of the launcher to drive it with.
 *
 * The copy matters. Both resolution strategies start from the launcher's own
 * location and walk up, so a launcher run from the repository finds whatever
 * sits in the repository's node_modules. Once the platform packages existed on
 * npm, `bun install` started putting a real one there, and it shadowed the
 * stand-in these tests depend on. Copying the launcher into the temporary tree
 * keeps the tests hermetic no matter what the working copy has installed.
 *
 * The stand-in executable runs under node rather than a shell, because macOS
 * strips `DYLD_*` when it execs a SIP-protected image and `/bin/sh` is one.
 * Skillmux's own compiled binary is unsigned and unprotected, so the real
 * injection survives where a shell script would not observe it.
 */
function installFakePlatformPackage(body: string): { root: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), "skillmux-launcher-"));
  const packageDir = join(root, "node_modules", platformPackage);
  mkdirSync(packageDir, { recursive: true });

  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: platformPackage, version: "0.0.0" }),
  );
  const executable = join(packageDir, "skillmux");
  writeFileSync(executable, `#!${nodePath}\n${body}\n`);
  chmodSync(executable, 0o755);

  // One level below the root, so both the launcher's own directory and the
  // working directory reach the same stand-in, which is what these tests mean
  // to cover.
  const launcherDir = join(root, "launcher");
  mkdirSync(launcherDir, { recursive: true });
  const copied = join(launcherDir, "skillmux.js");
  writeFileSync(copied, readFileSync(launcher, "utf8"));
  chmodSync(copied, 0o755);

  return { root, launcher: copied };
}

/** A launcher copy with no platform package anywhere above it. */
function installBareLauncher(): { root: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), "skillmux-launcher-empty-"));
  const launcherDir = join(root, "launcher");
  mkdirSync(launcherDir, { recursive: true });
  const copied = join(launcherDir, "skillmux.js");
  writeFileSync(copied, readFileSync(launcher, "utf8"));
  chmodSync(copied, 0o755);
  return { root, launcher: copied };
}

async function runLauncher(
  tree: { root: string; launcher: string },
  args: string[],
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(["node", tree.launcher, ...args], {
    cwd: tree.root,
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("launcher argument and exit-code forwarding (AC6)", () => {
  test("passes arguments through and mirrors the executable's exit code", async () => {
    const tree = installFakePlatformPackage(
      'console.log("args:" + process.argv.slice(2).join(" ")); process.exit(7);',
    );
    try {
      const result = await runLauncher(tree, ["doctor", "--json"]);

      expect(result.stdout).toContain("args:doctor --json");
      expect(result.exitCode).toBe(7);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

describe("launcher library path injection (AC7)", () => {
  test("prepends the package library directory ahead of an existing value", async () => {
    const tree = installFakePlatformPackage(
      `console.log("lib:" + process.env[${JSON.stringify(LIBRARY_PATH_VARIABLE)}]);`,
    );
    try {
      mkdirSync(join(tree.root, "node_modules", platformPackage, "lib"), { recursive: true });

      const result = await runLauncher(tree, [], { [LIBRARY_PATH_VARIABLE]: "/pre-existing" });

      // require.resolve reports the real path, and macOS keeps /var as a
      // symlink to /private/var.
      const expected = join(realpathSync(tree.root), "node_modules", platformPackage, "lib");
      expect(result.stdout.trim()).toBe(`lib:${expected}:/pre-existing`);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

describe("launcher executable override (AC8)", () => {
  test("SKILLMUX_BINARY replaces the resolved platform executable", async () => {
    const tree = installFakePlatformPackage('console.log("platform package");');
    try {
      const override = join(tree.root, "override");
      writeFileSync(override, `#!${nodePath}\nconsole.log("override:" + process.argv.slice(2).join(" "));\n`);
      chmodSync(override, 0o755);

      const result = await runLauncher(tree, ["doctor"], { SKILLMUX_BINARY: override });

      expect(result.stdout).toContain("override:doctor");
      expect(result.stdout).not.toContain("platform package");
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

describe("launcher missing platform package (AC9)", () => {
  test("names the missing package and the standalone fallback instead of a stack trace", async () => {
    const tree = installBareLauncher();
    try {
      const result = await runLauncher(tree, ["doctor"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(platformPackage);
      expect(result.stderr).toContain("github.com/klhq/skillmux/releases");
      expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
      expect(result.stderr).not.toContain("at ModuleLoader");
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

const bunPath = Bun.which("bun");
if (!bunPath) throw new Error("these tests need bun on PATH");

/** Runs the launcher as an executable, so its own shebang line decides the runtime. */
async function runLauncherDirectly(tree: { root: string; launcher: string }, pathEntries: string[]) {
  const proc = Bun.spawn([tree.launcher], {
    cwd: tree.root,
    env: { ...(process.env as Record<string, string>), PATH: [...pathEntries, "/usr/bin", "/bin"].join(":") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("launcher runtime selection (AC5)", () => {
  test("runs on a machine that has bun but no node", async () => {
    const tree = installFakePlatformPackage('console.log("ran");');
    try {
      const result = await runLauncherDirectly(tree, [dirname(bunPath)]);

      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ran");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("runs on a machine that has node but no bun", async () => {
    const tree = installFakePlatformPackage('console.log("ran");');
    try {
      const result = await runLauncherDirectly(tree, [dirname(nodePath!)]);

      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ran");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

describe("launcher signal forwarding (AC6)", () => {
  test("delivers SIGTERM to the executable instead of dying alone", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "skillmux-signal-")), "marker");
    const tree = installFakePlatformPackage(
      [
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(marker)};`,
        'process.on("SIGTERM", () => { fs.appendFileSync(marker, "sigterm\\n"); process.exit(0); });',
        'fs.appendFileSync(marker, "ready\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    try {
      const proc = Bun.spawn(["node", tree.launcher], {
        cwd: tree.root,
        env: { ...(process.env as Record<string, string>) },
        stdout: "pipe",
        stderr: "pipe",
      });

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (existsSync(marker) && readFileSync(marker, "utf8").includes("ready")) break;
        await Bun.sleep(50);
      }
      expect(readFileSync(marker, "utf8")).toContain("ready");

      proc.kill("SIGTERM");
      await proc.exited;

      expect(readFileSync(marker, "utf8")).toContain("sigterm");
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Builds an install-shaped tree with a copy of the launcher in it.
 *
 * The shell fast path resolves relative to the launcher's own location, so it
 * only engages when the launcher actually sits at <package>/bin/skillmux.js
 * with the platform package beside or beneath it. Tests that want to exercise
 * it therefore cannot run the repository's launcher in place.
 */
function installLauncherTree(
  body: string,
  layout: "nested" | "hoisted" | "orphan" | "ambiguous",
): { root: string; launcher: string; libraryDir: string } {
  const root = mkdtempSync(join(tmpdir(), "skillmux-fastpath-"));
  const packageDir = join(root, "node_modules", "@klhapp", "skillmux");
  mkdirSync(join(packageDir, "bin"), { recursive: true });

  const copied = join(packageDir, "bin", "skillmux.js");
  writeFileSync(copied, readFileSync(launcher, "utf8"));
  chmodSync(copied, 0o755);

  const platformDirs: string[] = [];
  if (layout === "nested" || layout === "ambiguous") {
    platformDirs.push(join(packageDir, "node_modules", "@klhapp", platformPackage.split("/")[1]!));
  }
  if (layout === "hoisted" || layout === "ambiguous") {
    platformDirs.push(join(root, "node_modules", "@klhapp", platformPackage.split("/")[1]!));
  }

  for (const dir of platformDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: platformPackage, version: "0.0.0" }));
    const executable = join(dir, "skillmux");
    writeFileSync(executable, `#!${nodePath}\n${body}\n`);
    chmodSync(executable, 0o755);
  }

  return {
    root,
    launcher: copied,
    libraryDir: platformDirs[0] ? join(platformDirs[0], "lib") : join(root, "absent"),
  };
}

/**
 * Runs the launcher through its shebang with a `node` on PATH that records
 * every invocation.
 *
 * The recorder is what separates the two paths: the shell fast path execs the
 * platform executable itself and never looks up a runtime, while the fallback
 * has to exec bun or node from PATH. The stand-in executable carries an
 * absolute node shebang so it does not trip the recorder itself.
 */
async function runThroughShebang(
  tree: { root: string; launcher: string },
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const shimDir = mkdtempSync(join(tmpdir(), "skillmux-runtime-shim-"));
  const witness = join(shimDir, "witness");
  for (const name of ["node", "bun"]) {
    const shim = join(shimDir, name);
    writeFileSync(shim, `#!/bin/sh\necho ${name} >> ${JSON.stringify(witness)}\nexec ${JSON.stringify(name === "node" ? nodePath! : bunPath!)} "$@"\n`);
    chmodSync(shim, 0o755);
  }

  const proc = Bun.spawn([tree.launcher, ...args], {
    cwd: tree.root,
    env: {
      ...(process.env as Record<string, string>),
      PATH: [shimDir, "/usr/bin", "/bin"].join(":"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const startedRuntime = existsSync(witness);
  rmSync(shimDir, { recursive: true, force: true });
  return { stdout, stderr, exitCode, startedRuntime };
}

describe("launcher shell fast path", () => {
  test("the shell section never contains the sequence that would close the block comment", () => {
    const source = readFileSync(launcher, "utf8");
    const shellSection = source.split("*/")[0]!;

    // If a "*/" slips into the shell, Node stops reading the comment there and
    // the rest of the shell becomes syntactically broken JavaScript.
    expect(shellSection).toContain("#!/bin/sh");
    expect(shellSection).toContain('command -v bun || command -v node');
    expect(shellSection.includes("*" + "/")).toBe(false);
  });

  test("execs the nested platform executable without starting a JavaScript runtime", async () => {
    const tree = installLauncherTree('console.log("ran", process.argv.slice(2).join(","));', "nested");
    try {
      const result = await runThroughShebang(tree, ["alpha", "beta"]);

      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ran alpha,beta");
      expect(result.exitCode).toBe(0);
      expect(result.startedRuntime).toBe(false);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("finds a hoisted platform package without starting a JavaScript runtime", async () => {
    const tree = installLauncherTree('console.log("ran");', "hoisted");
    try {
      const result = await runThroughShebang(tree);

      expect(result.stdout.trim()).toBe("ran");
      expect(result.startedRuntime).toBe(false);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("injects the library directory as the first entry", async () => {
    const tree = installLauncherTree(
      `console.log(process.env[${JSON.stringify(LIBRARY_PATH_VARIABLE)}] ?? "");`,
      "nested",
    );
    mkdirSync(tree.libraryDir, { recursive: true });
    try {
      const result = await runThroughShebang(tree, [], { [LIBRARY_PATH_VARIABLE]: "/existing" });
      const entries = result.stdout.trim().split(":");

      expect(result.startedRuntime).toBe(false);
      expect(entries[0]).toContain(`${platformPackage.split("/")[1]}/lib`);

      // macOS strips DYLD_* when it execs a SIP-protected image, and /bin/sh is
      // one, so an inherited value never reaches the launcher on darwin at all.
      // That predates this fast path: the previous launcher also entered
      // through /bin/sh. Linux hands the value through untouched.
      if (process.platform === "linux") {
        expect(entries).toContain("/existing");
      }
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("SKILLMUX_BINARY is honoured without starting a JavaScript runtime", async () => {
    const tree = installLauncherTree('console.log("platform");', "nested");
    const override = join(tree.root, "override");
    writeFileSync(override, `#!${nodePath}\nconsole.log("override");\n`);
    chmodSync(override, 0o755);
    try {
      const result = await runThroughShebang(tree, [], { SKILLMUX_BINARY: override });

      expect(result.stdout.trim()).toBe("override");
      expect(result.startedRuntime).toBe(false);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("mirrors the executable's exit code through exec", async () => {
    const tree = installLauncherTree("process.exit(23);", "nested");
    try {
      const result = await runThroughShebang(tree);

      expect(result.exitCode).toBe(23);
      expect(result.startedRuntime).toBe(false);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("falls back to the JavaScript launcher when no platform package is beside it", async () => {
    const tree = installLauncherTree('console.log("unused");', "orphan");
    try {
      const result = await runThroughShebang(tree, ["doctor"]);

      // The fallback is what produces the diagnostic, so reaching it at all is
      // the point; the message itself is covered by the missing-package test.
      expect(result.startedRuntime).toBe(true);
      expect(result.stderr).toContain(platformPackage);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("an ambiguous tree falls back instead of guessing which package to run", async () => {
    const tree = installLauncherTree('console.log("ran");', "ambiguous");
    try {
      const result = await runThroughShebang(tree);

      expect(result.startedRuntime).toBe(true);
      expect(result.stdout.trim()).toBe("ran");
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});
