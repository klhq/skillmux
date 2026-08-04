import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function startNativeServer(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "skillmux-zero-config-"));
  homes.push(home);
  const proc = Bun.spawn(["bun", "run", cliPath, "serve", ...args], {
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { home, proc };
}

test("native stdio starts without a config file or config directory", async () => {
  const { home, proc } = startNativeServer(["--transport", "stdio"]);
  const stderr = new Response(proc.stderr).text();

  await Bun.sleep(500);
  expect(proc.exitCode).toBeNull();
  expect(existsSync(join(home, ".config", "skillmux"))).toBeFalse();

  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  expect(await stderr).not.toContain("ENOENT");
});

test("native HTTP starts without a config file or config directory", async () => {
  const { home, proc } = startNativeServer(["--transport", "http", "--port", "0"]);
  const stderr = new Response(proc.stderr).text();

  await Bun.sleep(500);
  expect(proc.exitCode).toBeNull();
  expect(existsSync(join(home, ".config", "skillmux"))).toBeFalse();

  proc.kill("SIGTERM");
  expect([0, 143]).toContain(await proc.exited);
  expect(await stderr).not.toContain("ENOENT");
});
