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
 * Builds the node_modules layout an installed platform package produces.
 *
 * The stand-in executable runs under node rather than a shell, because macOS
 * strips `DYLD_*` when it execs a SIP-protected image and `/bin/sh` is one.
 * Skillmux's own compiled binary is unsigned and unprotected, so the real
 * injection survives where a shell script would not observe it.
 */
function installFakePlatformPackage(body: string): string {
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

  return root;
}

async function runLauncher(root: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", launcher, ...args], {
    cwd: root,
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
    const root = installFakePlatformPackage(
      'console.log("args:" + process.argv.slice(2).join(" ")); process.exit(7);',
    );
    try {
      const result = await runLauncher(root, ["doctor", "--json"]);

      expect(result.stdout).toContain("args:doctor --json");
      expect(result.exitCode).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launcher library path injection (AC7)", () => {
  test("prepends the package library directory ahead of an existing value", async () => {
    const root = installFakePlatformPackage(
      `console.log("lib:" + process.env[${JSON.stringify(LIBRARY_PATH_VARIABLE)}]);`,
    );
    try {
      mkdirSync(join(root, "node_modules", platformPackage, "lib"), { recursive: true });

      const result = await runLauncher(root, [], { [LIBRARY_PATH_VARIABLE]: "/pre-existing" });

      // require.resolve reports the real path, and macOS keeps /var as a
      // symlink to /private/var.
      const expected = join(realpathSync(root), "node_modules", platformPackage, "lib");
      expect(result.stdout.trim()).toBe(`lib:${expected}:/pre-existing`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launcher executable override (AC8)", () => {
  test("SKILLMUX_BINARY replaces the resolved platform executable", async () => {
    const root = installFakePlatformPackage('console.log("platform package");');
    try {
      const override = join(root, "override");
      writeFileSync(override, `#!${nodePath}\nconsole.log("override:" + process.argv.slice(2).join(" "));\n`);
      chmodSync(override, 0o755);

      const result = await runLauncher(root, ["doctor"], { SKILLMUX_BINARY: override });

      expect(result.stdout).toContain("override:doctor");
      expect(result.stdout).not.toContain("platform package");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launcher missing platform package (AC9)", () => {
  test("names the missing package and the standalone fallback instead of a stack trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-launcher-empty-"));
    try {
      const result = await runLauncher(root, ["doctor"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(platformPackage);
      expect(result.stderr).toContain("github.com/klhq/skillmux/releases");
      expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
      expect(result.stderr).not.toContain("at ModuleLoader");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const bunPath = Bun.which("bun");
if (!bunPath) throw new Error("these tests need bun on PATH");

/** Runs the launcher as an executable, so its own shebang line decides the runtime. */
async function runLauncherDirectly(root: string, pathEntries: string[]) {
  const proc = Bun.spawn([launcher], {
    cwd: root,
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
    const root = installFakePlatformPackage('console.log("ran");');
    try {
      const result = await runLauncherDirectly(root, [dirname(bunPath)]);

      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ran");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs on a machine that has node but no bun", async () => {
    const root = installFakePlatformPackage('console.log("ran");');
    try {
      const result = await runLauncherDirectly(root, [dirname(nodePath!)]);

      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ran");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launcher signal forwarding (AC6)", () => {
  test("delivers SIGTERM to the executable instead of dying alone", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "skillmux-signal-")), "marker");
    const root = installFakePlatformPackage(
      [
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(marker)};`,
        'process.on("SIGTERM", () => { fs.appendFileSync(marker, "sigterm\\n"); process.exit(0); });',
        'fs.appendFileSync(marker, "ready\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    try {
      const proc = Bun.spawn(["node", launcher], {
        cwd: root,
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
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
